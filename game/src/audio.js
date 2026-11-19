// Every sound Sunbay makes, synthesised at runtime: no audio file is fetched and no sample is
// loaded. The engine is a sawtooth pair through a lowpass whose cutoff and pitch track speed;
// the skid is filtered white noise under the handbrake; the horn is two squares a fifth apart;
// the shot is a noise burst with a click; the siren is a two-tone wail whose gain falls off
// with the listener's distance; pickups chime, a finished job plays a three-note fanfare, and
// a slow original synthwave loop (bass, pad chords and a noise hi-hat) runs underneath,
// scheduled ahead on the audio clock so a stalled frame never drops its beat.
//
// The AudioContext is created on the first user gesture, as browsers require; every other
// method is safe before that and simply does nothing. The master gain carries the volume and
// mute that the pause menu and the N key drive, and a small counter set tells the smoke test
// that each sound actually fired.

const BPM = 92;
const STEP = 60 / BPM / 4; // one sixteenth note
const LOOKAHEAD = 0.12;
const SCHEDULE_MS = 25;

/** A minor, four bars: the loop's own progression, written for this game. */
const CHORDS = [
  { bass: 55.0, notes: [220.0, 261.63, 329.63, 392.0] }, // Am7
  { bass: 43.65, notes: [174.61, 220.0, 261.63, 329.63] }, // Fmaj7
  { bass: 65.41, notes: [196.0, 261.63, 329.63, 392.0] }, // Cmaj7/G
  { bass: 49.0, notes: [196.0, 246.94, 293.66, 392.0] }, // G
];

/** A sixteenth-note bass figure per bar, in semitones from the chord root. */
const BASS_PATTERN = [0, 0, 12, 0, 7, 0, 0, 10, 0, 0, 12, 0, 3, 0, 7, 0];

const NOISE_SECONDS = 2;

function buildNoise(context) {
  const buffer = context.createBuffer(1, context.sampleRate * NOISE_SECONDS, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return buffer;
}

export function createAudio() {
  let context = null;
  let noiseBuffer = null;
  let master = null;
  let volume = 0.7;
  let muted = false;
  let started = false;

  // Continuous voices, built with the context.
  let engineGain = null;
  let engineFilter = null;
  let engineOscA = null;
  let engineOscB = null;
  let skidGain = null;
  let sirenGain = null;
  let sirenOsc = null;
  let sirenLfo = null;

  // The music's scheduler state.
  let musicWanted = false;
  let musicOn = false;
  let musicTimer = null;
  let nextStepTime = 0;
  let stepIndex = 0;
  let musicGain = null;

  const counters = {
    shots: 0, hits: 0, horns: 0, chimes: 0, fanfares: 0, skids: 0, sirens: 0,
    musicStarts: 0, engines: 0,
  };
  let skidActive = false;
  let engineActive = false;
  let sirenActive = false;

  /** Builds the graph once. Called from the first gesture and from any sound if it slips by. */
  function build() {
    if (context) return;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return;
    try {
      context = new Ctor();
    } catch {
      context = null;
      return;
    }
    noiseBuffer = buildNoise(context);
    master = context.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(context.destination);

    // Engine: two detuned saws into a lowpass, silent until a car is driven.
    engineGain = context.createGain();
    engineGain.gain.value = 0;
    engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 420;
    engineFilter.Q.value = 6;
    engineOscA = context.createOscillator();
    engineOscA.type = 'sawtooth';
    engineOscA.frequency.value = 46;
    engineOscB = context.createOscillator();
    engineOscB.type = 'sawtooth';
    engineOscB.frequency.value = 46 * 1.01;
    const engineB = context.createGain();
    engineB.gain.value = 0.55;
    engineOscA.connect(engineFilter);
    engineOscB.connect(engineB).connect(engineFilter);
    engineFilter.connect(engineGain).connect(master);
    engineOscA.start();
    engineOscB.start();

    // Skid: looping noise through a bandpass, silent until the handbrake bites.
    const skidSource = context.createBufferSource();
    skidSource.buffer = noiseBuffer;
    skidSource.loop = true;
    const skidFilter = context.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1650;
    skidFilter.Q.value = 1.1;
    skidGain = context.createGain();
    skidGain.gain.value = 0;
    skidSource.connect(skidFilter).connect(skidGain).connect(master);
    skidSource.start();

    // Siren: a square whose pitch a slow LFO swings between two tones; gain by distance.
    sirenOsc = context.createOscillator();
    sirenOsc.type = 'square';
    sirenOsc.frequency.value = 780;
    sirenLfo = context.createOscillator();
    sirenLfo.type = 'square';
    sirenLfo.frequency.value = 0.7;
    const sirenDepth = context.createGain();
    sirenDepth.gain.value = 170;
    const sirenTone = context.createBiquadFilter();
    sirenTone.type = 'lowpass';
    sirenTone.frequency.value = 1500;
    sirenGain = context.createGain();
    sirenGain.gain.value = 0;
    sirenLfo.connect(sirenDepth).connect(sirenOsc.frequency);
    sirenOsc.connect(sirenTone).connect(sirenGain).connect(master);
    sirenOsc.start();
    sirenLfo.start();

    // The music bus, opened by music(true).
    musicGain = context.createGain();
    musicGain.gain.value = 0.0;
    musicGain.connect(master);

    started = true;
  }

  /** The first gesture: make the context, resume it, and start the loop if asked. */
  function unlock() {
    build();
    if (!context) return false;
    if (context.state === 'suspended') context.resume?.().catch(() => {});
    if (musicWanted && !musicOn) startMusic();
    return context.state !== 'closed';
  }

  function now() {
    return context ? context.currentTime : 0;
  }

  /** A short envelope on a gain node: attack, then an exponential fall to silence. */
  function envelope(gain, at, peak, attack, hold, release) {
    gain.gain.cancelScheduledValues(at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    gain.gain.setValueAtTime(Math.max(0.0002, peak), at + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  }

  function ping(type, frequency, at, peak, seconds) {
    if (!context) return;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    const gain = context.createGain();
    envelope(gain, at, peak, 0.008, seconds * 0.35, seconds * 0.65);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + seconds + 0.05);
  }

  function noiseBurst(at, peak, seconds, filterType, frequency, q = 1) {
    if (!context) return;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, at);
    filter.Q.value = q;
    const gain = context.createGain();
    envelope(gain, at, peak, 0.004, seconds * 0.18, seconds * 0.82);
    source.connect(filter).connect(gain).connect(master);
    source.start(at);
    source.stop(at + seconds + 0.05);
  }

  // -- one-shots -----------------------------------------------------------------------------

  /** The pistol or the SMG: a crack of noise over a low thump and a mechanical click. */
  function shot(kind = 'pistol') {
    build();
    if (!context) return;
    counters.shots += 1;
    const at = now() + 0.001;
    const smg = kind === 'smg';
    noiseBurst(at, smg ? 0.34 : 0.5, smg ? 0.1 : 0.16, 'highpass', smg ? 2100 : 1500, 0.8);
    noiseBurst(at, 0.22, 0.07, 'bandpass', 620, 1.4);
    ping('square', smg ? 180 : 132, at, 0.12, 0.05);
    ping('triangle', smg ? 88 : 64, at, 0.3, 0.12);
  }

  /** Fist on a body: a muffled low thud with a little grit. */
  function hit() {
    build();
    if (!context) return;
    counters.hits += 1;
    const at = now() + 0.001;
    ping('sine', 120, at, 0.42, 0.16);
    ping('sine', 70, at + 0.015, 0.32, 0.2);
    noiseBurst(at, 0.16, 0.08, 'lowpass', 900, 0.7);
  }

  /** Two squares a fifth apart, held for half a second. */
  function horn() {
    build();
    if (!context) return;
    counters.horns += 1;
    const at = now() + 0.001;
    for (const frequency of [415, 622]) {
      const osc = context.createOscillator();
      osc.type = 'square';
      osc.frequency.value = frequency;
      const gain = context.createGain();
      envelope(gain, at, 0.12, 0.012, 0.3, 0.12);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + 0.5);
    }
  }

  /** A pickup: three quick rising sine notes. */
  function chime() {
    build();
    if (!context) return;
    counters.chimes += 1;
    const at = now() + 0.001;
    [880, 1174.66, 1567.98].forEach((frequency, index) => {
      ping('sine', frequency, at + index * 0.07, 0.16, 0.24);
    });
  }

  /** A finished job: the fanfare, a bright major arpeggio that lands on the octave. */
  function fanfare() {
    build();
    if (!context) return;
    counters.fanfares += 1;
    const at = now() + 0.02;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, index) => {
      const start = at + index * 0.13;
      ping('triangle', frequency, start, 0.2, 0.5);
      ping('sine', frequency / 2, start, 0.12, 0.6);
    });
    noiseBurst(at + 0.39, 0.06, 0.5, 'highpass', 5200, 0.6);
  }

  // -- continuous voices ---------------------------------------------------------------------

  /**
   * The engine, called every frame: `ratio` is speed over the car's top speed in 0..1.
   * Silent on foot. Pitch and filter cutoff both rise with speed, so a fast car screams.
   */
  function engine(active, ratio = 0) {
    if (!context) {
      if (active) counters.engines += 1;
      engineActive = Boolean(active);
      return;
    }
    const clamped = Math.max(0, Math.min(1.2, ratio));
    const target = active ? 0.055 + clamped * 0.075 : 0;
    engineGain.gain.setTargetAtTime(target, now(), 0.08);
    const pitch = 44 + clamped * 76;
    engineOscA.frequency.setTargetAtTime(pitch, now(), 0.09);
    engineOscB.frequency.setTargetAtTime(pitch * 1.011, now(), 0.09);
    engineFilter.frequency.setTargetAtTime(320 + clamped * 1500, now(), 0.1);
    engineActive = Boolean(active);
  }

  /** Tyre squeal and smoke together: `strength` 0..1 while the handbrake is down at speed. */
  function skid(strength = 0) {
    if (!context) {
      if (strength > 0.1 && !skidActive) counters.skids += 1;
      skidActive = strength > 0.1;
      return;
    }
    const on = strength > 0.06;
    if (on && !skidActive) counters.skids += 1;
    skidActive = on;
    skidGain.gain.setTargetAtTime(on ? 0.035 + Math.min(1, strength) * 0.1 : 0, now(), 0.05);
  }

  /** The siren's wail, levelled by the nearest cruiser's distance in metres. */
  function siren(active, distance = 100) {
    if (!context) {
      if (active && !sirenActive) counters.sirens += 1;
      sirenActive = Boolean(active);
      return;
    }
    if (active && !sirenActive) counters.sirens += 1;
    sirenActive = Boolean(active);
    const falloff = active ? Math.max(0, 1 - distance / 90) : 0;
    sirenGain.gain.setTargetAtTime(falloff * 0.05, now(), 0.25);
    sirenLfo.frequency.setTargetAtTime(distance < 25 ? 1.15 : 0.7, now(), 0.4);
  }

  // -- the music loop ------------------------------------------------------------------------

  function scheduleStep(step, at) {
    const bar = Math.floor(step / 16) % CHORDS.length;
    const chord = CHORDS[bar];
    const local = step % 16;
    const bus = musicGain;

    // Bass: a muted-saw figure on the sixteenth grid, with a little slide on the long notes.
    const semitone = BASS_PATTERN[local];
    if (semitone !== null) {
      const frequency = chord.bass * Math.pow(2, semitone / 12);
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(frequency, at);
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(320, at);
      filter.frequency.exponentialRampToValueAtTime(150, at + STEP * 2.6);
      filter.Q.value = 4;
      const gain = context.createGain();
      envelope(gain, at, local % 4 === 0 ? 0.16 : 0.095, 0.008, STEP * 0.5, STEP * 2.4);
      osc.connect(filter).connect(gain).connect(bus);
      osc.start(at);
      osc.stop(at + STEP * 4);
    }

    // Pad: the chord's notes re-voiced each bar and held, soft and wide.
    if (local === 0) {
      for (const frequency of chord.notes) {
        for (const detune of [-4, 4]) {
          const osc = context.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = frequency;
          osc.detune.value = detune;
          const gain = context.createGain();
          const barLength = STEP * 16;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.028, at + 0.35);
          gain.gain.setValueAtTime(0.028, at + barLength - 0.5);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + barLength + 0.4);
          const filter = context.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 1200;
          osc.connect(filter).connect(gain).connect(bus);
          osc.start(at);
          osc.stop(at + barLength + 0.45);
        }
      }
      // A soft plucked arp note on the offbeats colours the bar without crowding the bass.
      const lead = chord.notes[(Math.floor(step / 4) + 2) % chord.notes.length] * 2;
      pingTo(bus, 'sine', lead, at + STEP * 6, 0.022, 0.4);
    }

    // Hi-hat: noise on every even sixteenth, a little louder on the two and four.
    if (local % 2 === 0) {
      const open = local % 8 === 4;
      const source = context.createBufferSource();
      source.buffer = noiseBuffer;
      const filter = context.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 7200;
      const gain = context.createGain();
      const peak = local % 8 === 4 ? 0.03 : (local % 4 === 0 ? 0.022 : 0.014);
      envelope(gain, at, peak, 0.002, open ? 0.03 : 0.006, open ? 0.09 : 0.045);
      source.connect(filter).connect(gain).connect(bus);
      source.start(at);
      source.stop(at + 0.16);
    }
  }

  function pingTo(destination, type, frequency, at, peak, seconds) {
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    const gain = context.createGain();
    envelope(gain, at, peak, 0.01, seconds * 0.3, seconds * 0.7);
    osc.connect(gain).connect(destination);
    osc.start(at);
    osc.stop(at + seconds + 0.1);
  }

  function pump() {
    if (!context || !musicOn) return;
    const horizon = context.currentTime + LOOKAHEAD;
    // A long stall could leave the clock behind: never schedule more than a bar of backlog.
    if (nextStepTime < context.currentTime - 1) nextStepTime = context.currentTime + 0.05;
    while (nextStepTime < horizon) {
      scheduleStep(stepIndex, nextStepTime);
      stepIndex = (stepIndex + 1) % (16 * CHORDS.length);
      nextStepTime += STEP;
    }
  }

  function startMusic() {
    if (!context) return false;
    if (musicOn) return true;
    musicOn = true;
    musicGain.gain.cancelScheduledValues(now());
    musicGain.gain.setValueAtTime(0.0001, now());
    musicGain.gain.exponentialRampToValueAtTime(0.5, now() + 2.2);
    nextStepTime = now() + 0.12;
    stepIndex = 0;
    counters.musicStarts += 1;
    if (musicTimer === null) musicTimer = setInterval(pump, SCHEDULE_MS);
    pump();
    return true;
  }

  function stopMusic() {
    musicOn = false;
    if (musicTimer !== null) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    if (context && musicGain) {
      musicGain.gain.cancelScheduledValues(now());
      musicGain.gain.setTargetAtTime(0.0001, now(), 0.35);
    }
  }

  /** The chill loop under the city: on during play and the title, off in the pause menu. */
  function music(active) {
    musicWanted = Boolean(active);
    if (!context) return;
    if (active) startMusic();
    else stopMusic();
  }

  // -- volume and mute -----------------------------------------------------------------------

  function applyMaster() {
    if (!context || !master) return;
    master.gain.setTargetAtTime(muted ? 0 : volume, now(), 0.05);
  }

  function setVolume(next) {
    volume = Math.max(0, Math.min(1, Number.isFinite(next) ? next : volume));
    applyMaster();
    return volume;
  }

  function setMuted(next) {
    muted = Boolean(next);
    applyMaster();
    return muted;
  }

  function toggleMute() {
    return setMuted(!muted);
  }

  // The first gesture anywhere opens the context. Capture, once, so no screen can swallow it.
  const onGesture = () => {
    if (unlock()) {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      window.removeEventListener('touchstart', onGesture, true);
    }
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  window.addEventListener('touchstart', onGesture, true);

  return {
    unlock,
    get ready() {
      return Boolean(context);
    },
    /** 'running', 'suspended', 'closed', or null before the first gesture. */
    state() {
      return context ? context.state : null;
    },
    get context() {
      return context;
    },
    shot,
    hit,
    horn,
    chime,
    fanfare,
    engine,
    skid,
    siren,
    music,
    setVolume,
    setMuted,
    toggleMute,
    get volume() {
      return volume;
    },
    get muted() {
      return muted;
    },
    get musicPlaying() {
      return musicOn;
    },
    get engineOn() {
      return engineActive;
    },
    get skidOn() {
      return skidActive;
    },
    counters,
    /** The smoke test's read of what fired: counters plus the live voice flags. */
    snapshot() {
      return {
        state: context ? context.state : null,
        volume,
        muted,
        musicPlaying: musicOn,
        engineOn: engineActive,
        skidOn: skidActive,
        counters: { ...counters },
      };
    },
    dispose() {
      stopMusic();
      if (context) context.close?.().catch(() => {});
    },
  };
}
