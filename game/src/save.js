// The save: one JSON document in localStorage, written after every mission, every purchase,
// every bust and every 30 seconds of play. A version number sits at the top so a save from an
// older build is discarded rather than half-read; a save this build cannot parse is dropped
// the same way, and the title screen simply has no Continue button.
//
// The save stores the player's whole situation, not the world: money, the cars they have
// bought, their guns and ammo, how many missions they finished and which mission is open,
// where their body stands, and the two lifetime stats. Traffic and pedestrians are rebuilt
// fresh on every load.
//
// localStorage is the only thing here that can fail (private mode, a full quota); every
// access is wrapped, so the game runs without a save able to be kept.

export const SAVE_KEY = 'sunbay.crimecoast.save';
export const SAVE_VERSION = 1;

/** The numbers a fresh run starts with. */
export const NEW_GAME = {
  money: 500,
  ownedCars: [],
  pistolUnlocked: true,
  smgUnlocked: false,
  ammo: 12,
  reserve: 48,
  smgAmmo: 0,
  missionsDone: 0,
  activeMission: null,
  player: { x: -2.5, z: 2.5, heading: Math.PI / 2 },
  stats: { playSeconds: 0, topSpeed: 0 },
};

/** A clean copy of NEW_GAME, so a run can never mutate the constant. */
export function newGameState() {
  return JSON.parse(JSON.stringify(NEW_GAME));
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads and validates the stored document. Returns the state, or null when there is none,
 * it was written by another version, or its shape is wrong. The validation is shallow on
 * purpose: a field missing takes its default, so adding one later never kills a save.
 */
export function loadSave() {
  const store = storage();
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.version !== SAVE_VERSION) return null;
  const state = data.state;
  if (!state || typeof state !== 'object') return null;
  if (!Number.isFinite(state.money) || !Number.isFinite(state.missionsDone)) return null;
  const base = newGameState();
  const merged = {
    ...base,
    ...state,
    money: Math.max(0, Math.round(state.money)),
    missionsDone: Math.max(0, Math.min(99, Math.floor(state.missionsDone))),
    ownedCars: Array.isArray(state.ownedCars)
      ? state.ownedCars
        .filter((car) => car && typeof car.type === 'string')
        .map((car) => ({
          type: car.type,
          color: typeof car.color === 'string' ? car.color : '#b9c2c9',
        }))
      : [],
    activeMission: typeof state.activeMission === 'string' ? state.activeMission : null,
    player: {
      x: Number.isFinite(state.player?.x) ? state.player.x : base.player.x,
      z: Number.isFinite(state.player?.z) ? state.player.z : base.player.z,
      heading: Number.isFinite(state.player?.heading) ? state.player.heading : base.player.heading,
    },
    stats: {
      playSeconds: Number.isFinite(state.stats?.playSeconds) ? state.stats.playSeconds : 0,
      topSpeed: Number.isFinite(state.stats?.topSpeed) ? state.stats.topSpeed : 0,
    },
  };
  return merged;
}

/** Writes the state; returns true when the write was accepted. */
export function writeSave(state) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(SAVE_KEY, JSON.stringify({
      version: SAVE_VERSION,
      savedAt: Date.now(),
      state,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Removes the save, for New Game and for the debug hook. */
export function clearSave() {
  const store = storage();
  if (!store) return false;
  try {
    store.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasSave() {
  return loadSave() !== null;
}

/**
 * The autosave: writes `getState()` every `intervalMs` of play and on demand. The timer is
 * driven by the game's own clock (a `tick(dt)` from the frame loop), so a paused game does
 * not count down to a write and a stalled tab does not bunch them.
 */
export function createAutosave(getState, { intervalMs = 30000, onChange = null } = {}) {
  let sinceLast = 0;
  let lastResult = null;

  function saveNow(reason = 'manual') {
    const ok = writeSave(getState());
    sinceLast = 0;
    lastResult = { ok, reason, at: Date.now() };
    onChange?.(lastResult);
    return ok;
  }

  function tick(dt) {
    sinceLast += dt * 1000;
    if (sinceLast >= intervalMs) saveNow('auto');
  }

  return {
    saveNow,
    tick,
    get lastResult() {
      return lastResult;
    },
    resetClock() {
      sinceLast = 0;
    },
  };
}
