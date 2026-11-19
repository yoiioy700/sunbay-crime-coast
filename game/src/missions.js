// Mama Rosa's story chain: seven jobs across Sunbay, one at a time, each opening the next.
// A delivery run, two thefts of a marked car, a checkpoint race, a takedown of a fleeing
// courier, a second delivery and the final heist — reach the bank, hold up for the bag, then
// escape to the hideout with four stars on you.
//
// The module owns the objective and its world marker (a glowing column and a ground ring),
// the target cars a job spawns (parked like any other car, or fleeing on their own), and the
// mission phone on M or Tab that lists what is available. Everything visible elsewhere — the
// HUD line, the minimap blips, the money — goes out through callbacks, so this file never
// touches the camera, the police or the economy's state directly.
//
// A job fails on its timer, on the player being busted or wasted, or when abandoned from the
// phone; a failure pays nothing and leaves the job open. A success pays once and raises the
// completed count, which is what progression.js reads for the SMG, the dock discount and the
// final heist.

import * as THREE from 'three';
import { CITY } from './city.js';
import { stepCar } from './vehicles.js';

/** Mama Rosa's phone booth on the avenue beside the spawn. */
export const GIVER = { x: -4, z: 14, name: 'MAMA ROSA' };

/** The story. `n` is the mission's place in the chain, 1..7. */
export const MISSIONS = [
  {
    id: 'first-drop',
    n: 1,
    title: 'FIRST DROP',
    giver: 'MAMA ROSA',
    type: 'DELIVERY',
    intro: 'A wrapped parcel, a hot afternoon and a drop on Bay Avenue. Take a car and do not be late.',
    reward: 400,
    stages: [
      {
        text: 'Take the parcel to the drop on Bay Avenue',
        kind: 'reach',
        marker: { x: 0, z: -58 },
        radius: 7,
        needCar: true,
        timer: 80,
      },
    ],
  },
  {
    id: 'blue-coupe',
    n: 2,
    title: 'THE BLUE COUPE',
    giver: 'MAMA ROSA',
    type: 'THEFT',
    intro: 'A coupe on Bay Avenue belongs to a man who owes Rosa. Bring it to the dock, whole.',
    reward: 700,
    spawn: { type: 'sports', color: '#3f86c4', x: 72, z: 0, heading: 0, label: 'BLUE COUPE' },
    stages: [
      {
        text: 'Find the blue coupe parked on Bay Avenue',
        kind: 'reach',
        marker: { x: 72, z: 0 },
        radius: 6,
        targetMarker: true,
      },
      {
        text: 'Steal the blue coupe',
        kind: 'enter',
        marker: { x: 72, z: 0 },
        radius: 6,
        targetMarker: true,
      },
      {
        text: 'Drive the coupe to the dock on the coast road',
        kind: 'deliver',
        marker: { x: 165, z: 132 },
        radius: 9,
        timer: 120,
        needCar: true,
        targetMarker: true,
      },
    ],
  },
  {
    id: 'palm-circuit',
    n: 3,
    title: 'PALM CIRCUIT',
    giver: 'MAMA ROSA',
    type: 'RACE',
    intro: 'Four corners of the city, one lap, and a stopwatch that does not care about your excuses.',
    reward: 900,
    stages: [
      {
        text: 'Run the circuit before the clock runs out',
        kind: 'checkpoints',
        radius: 9,
        timer: 95,
        needCar: true,
        checkpoints: [
          { x: 33, z: 99 },
          { x: 99, z: 99 },
          { x: 99, z: -33 },
          { x: 33, z: -33 },
        ],
      },
    ],
  },
  {
    id: 'dead-radio',
    n: 4,
    title: 'DEAD RADIO',
    giver: 'MAMA ROSA',
    type: 'TAKEDOWN',
    intro: 'One of Rosa\'s couriers went quiet and kept the car. Run him down before he reaches the bridge.',
    reward: 1100,
    spawn: {
      type: 'sports', color: '#d8452f', x: 60, z: 132, heading: Math.PI, flee: true, label: 'COURIER',
    },
    stages: [
      {
        text: 'Run the courier down — ram or shoot the red sports car',
        kind: 'takedown',
        marker: { x: 60, z: 132 },
        radius: 7,
        timer: 90,
        followTarget: true,
      },
    ],
  },
  {
    id: 'night-shift',
    n: 5,
    title: 'NIGHT SHIFT',
    giver: 'MAMA ROSA',
    type: 'DELIVERY',
    intro: 'Two stops tonight: collect from the marina lock-up, then run it across town before the bars close.',
    reward: 1300,
    stages: [
      {
        text: 'Collect the crate from the marina lock-up',
        kind: 'reach',
        marker: { x: 99, z: -66 },
        radius: 7,
        needCar: true,
        timer: 70,
      },
      {
        text: 'Deliver the crate to the west-side garage',
        kind: 'reach',
        marker: { x: -33, z: 132 },
        radius: 7,
        needCar: true,
        timer: 75,
      },
    ],
  },
  {
    id: 'the-ledger',
    n: 6,
    title: 'THE LEDGER',
    giver: 'MAMA ROSA',
    type: 'THEFT',
    intro: 'A white van on the west road carries the books. Rosa wants the books, the van and the driver\'s silence.',
    reward: 1800,
    spawn: { type: 'van', color: '#f2efe6', x: -132, z: 0, heading: 0, label: 'LEDGER VAN' },
    stages: [
      {
        text: 'Find the white van on the west road',
        kind: 'reach',
        marker: { x: -132, z: 0 },
        radius: 6,
        targetMarker: true,
      },
      {
        text: 'Take the ledger van',
        kind: 'enter',
        marker: { x: -132, z: 0 },
        radius: 6,
        targetMarker: true,
        wanted: 3,
      },
      {
        text: 'Bring the van to the dock',
        kind: 'deliver',
        marker: { x: 165, z: 132 },
        radius: 9,
        timer: 130,
        needCar: true,
        targetMarker: true,
      },
    ],
  },
  {
    id: 'last-light',
    n: 7,
    title: 'LAST LIGHT',
    giver: 'MAMA ROSA',
    type: 'HEIST',
    intro: 'The Sunbank vault, a bag of Rosa\'s money and every cruiser in the city. Get in, get the bag, get to the hideout.',
    reward: 5000,
    stages: [
      {
        text: 'Get inside the Sunbank on Bay Street',
        kind: 'reach',
        marker: { x: 99, z: -33 },
        radius: 8,
      },
      {
        text: 'Hold the vault — grab the bag',
        kind: 'grab',
        marker: { x: 99, z: -33 },
        radius: 6,
        grabSeconds: 3,
        wanted: 4,
      },
      {
        text: 'Escape to the hideout on the west shore',
        kind: 'reach',
        marker: { x: -140, z: 99 },
        radius: 9,
        timer: 130,
        needCar: true,
        wanted: 4,
      },
    ],
  },
];

export const MISSION_COUNT = MISSIONS.length;

const MARKER_COLOR = {
  reach: '#ffd05e',
  enter: '#ffd05e',
  deliver: '#7dffb0',
  checkpoints: '#64d3ff',
  takedown: '#ff6a52',
  grab: '#c88bff',
};

const PHONE_STYLE = [
  'position:absolute;left:22px;top:96px;width:344px;max-height:calc(100vh - 190px);display:none;',
  'overflow:auto;pointer-events:auto;padding:16px 17px 14px;border-radius:9px;',
  'border:1px solid rgba(255,244,226,0.22);',
  'background:linear-gradient(170deg,rgba(15,38,49,0.97),rgba(6,16,22,0.98));',
  'box-shadow:0 22px 54px rgba(0,0,0,0.5);color:#fff4e2;',
  'font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;',
].join('');

/**
 * The nearest road centreline point to (x, z): the grid every lane sits on. A fleeing car is
 * steered down the street rather than into a block, so the chase stays a chase.
 */
function nearestLane(x, z) {
  const { halfSpan, pitch, gridLines } = CITY;
  const snap = (value) => {
    const index = Math.max(0, Math.min(gridLines - 1, Math.round((value + halfSpan) / pitch)));
    return -halfSpan + index * pitch;
  };
  const lineX = snap(x);
  const lineZ = snap(z);
  return Math.abs(x - lineX) < Math.abs(z - lineZ)
    ? { x: lineX, z, axis: 'z' }
    : { x, z: lineZ, axis: 'x' };
}

/** Builds one world marker: a ground ring, a soft disc and a light column. */
function buildMarker(scene) {
  const group = new THREE.Group();
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: '#ffd05e', transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.9, 40), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(2.25, 32),
    new THREE.MeshBasicMaterial({
      color: '#ffd05e', transparent: true, opacity: 0.16, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.04;
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.75, 26, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: '#ffd05e', transparent: true, opacity: 0.11, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
  );
  column.position.y = 13;
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.55, 0),
    new THREE.MeshBasicMaterial({ color: '#ffd05e', transparent: true, opacity: 0.9, depthWrite: false }),
  );
  gem.position.y = 3.1;
  group.add(ring, disc, column, gem);
  group.visible = false;
  scene.add(group);
  return { group, ring, disc, column, gem, ringMaterial };
}

/**
 * createMissions(scene, city, options). main.js supplies the world's edges through callbacks:
 * `getPlayer()`, `getActiveCar()`, `spawnCar(spec)`, `despawnCar(car)`, `setWanted(level)`,
 * `onObjective(text)`, `onBanner(kind, detail)`, `onReward(amount, mission)`,
 * `onMissionStart(mission)`, `onMissionEnd(mission, outcome)`, `onBlips()`, `getMissionsDone()`.
 */
export function createMissions(scene, city, options = {}) {
  const {
    getPlayer = () => ({ x: 0, z: 0 }),
    getActiveCar = () => null,
    spawnCar = () => null,
    despawnCar = () => {},
    setWanted = () => 0,
    onObjective = () => {},
    onBanner = () => {},
    onReward = () => {},
    onMissionStart = () => {},
    onMissionEnd = () => {},
    getMissionsDone = () => 0,
    getUnlockNote = () => '',
  } = options;

  const marker = buildMarker(scene);
  const phoneRoot = document.createElement('div');
  phoneRoot.style.cssText = PHONE_STYLE;
  const phoneTitle = document.createElement('div');
  phoneTitle.style.cssText = 'font-size:10px;letter-spacing:0.4em;color:#ffcf92';
  const phoneSub = document.createElement('div');
  phoneSub.style.cssText = 'margin-top:6px;font-size:12px;line-height:1.5;color:rgba(255,244,226,0.66);';
  const phoneRows = document.createElement('div');
  phoneRows.style.cssText = 'margin-top:12px;border-top:1px solid rgba(255,244,226,0.14);padding-top:10px;';
  const phoneHint = document.createElement('div');
  phoneHint.style.cssText = 'margin-top:10px;font-size:9px;letter-spacing:0.18em;color:rgba(255,244,226,0.4)';
  phoneHint.textContent = 'M / TAB CLOSES · ESC PAUSES';
  phoneRoot.append(phoneTitle, phoneSub, phoneRows, phoneHint);
  phoneRoot.dataset.missionPhone = '1';
  document.getElementById('screens')?.appendChild(phoneRoot) ?? document.body.appendChild(phoneRoot);

  const state = {
    done: 0,
    active: null,
    phoneOpen: false,
    lastResult: null,
  };

  // Runtime of the active job: stage index, stage clock, target car, checkpoints, hold clock.
  let stageIndex = 0;
  let stageTime = 0;
  let stageClock = 0;
  let targetCar = null;
  let checkpointIndex = 0;
  let grabClock = 0;
  let failReason = '';
  let objectiveShown = '';
  let markerSignature = '';

  function missionById(id) {
    return MISSIONS.find((mission) => mission.id === id) ?? null;
  }

  /** The job the chain offers now: the one after the last done, or null at the end. */
  function nextMission() {
    return MISSIONS.find((mission) => mission.n > state.done) ?? null;
  }

  function isAvailable(mission) {
    return Boolean(mission) && mission.n === state.done + 1;
  }

  function playerPoint() {
    const player = getPlayer();
    return { x: player.x, z: player.z };
  }

  function distanceTo(point) {
    const player = playerPoint();
    return Math.hypot(player.x - point.x, player.z - point.z);
  }

  // -- callbacks into the HUD ----------------------------------------------------------------

  function setObjective(text) {
    if (text === objectiveShown) return;
    objectiveShown = text;
    onObjective(text);
  }

  function stageObjective(stage) {
    if (!state.active) return '';
    const mission = state.active;
    let text = `MAMA ROSA · ${stage.text}`;
    if (stage.timer) text += `  ·  ${formatClock(stageTime)}`;
    if (stage.kind === 'checkpoints') {
      text += `  ·  ${checkpointIndex + 1}/${stage.checkpoints.length}`;
    }
    if (stage.kind === 'grab' && grabClock > 0) {
      text += `  ·  ${Math.max(0, stage.grabSeconds - grabClock).toFixed(1)}s`;
    }
    void mission;
    return text;
  }

  /** "1:05", "0:07": the countdown on the objective line. */
  function formatClock(seconds) {
    const whole = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  // -- target cars ----------------------------------------------------------------------------

  function clearTarget() {
    if (!targetCar) return;
    despawnCar(targetCar);
    targetCar = null;
  }

  function spawnTarget(spec) {
    clearTarget();
    targetCar = spawnCar({ ...spec, missionTarget: true });
    return targetCar;
  }

  /** Where the marker should stand: the stage's point, the target car, or a checkpoint. */
  function markerPoint(stage) {
    if (!stage) return null;
    if (stage.kind === 'checkpoints') {
      return stage.checkpoints[Math.min(checkpointIndex, stage.checkpoints.length - 1)] ?? null;
    }
    if (stage.followTarget && targetCar) {
      return { x: targetCar.position.x, z: targetCar.position.z };
    }
    return stage.marker ?? GIVER;
  }

  function showMarker(point, kind) {
    if (!point) {
      marker.group.visible = false;
      markerSignature = '';
      return;
    }
    marker.group.visible = true;
    marker.group.position.set(point.x, 0, point.z);
    const color = MARKER_COLOR[kind] ?? '#ffd05e';
    const signature = `${point.x.toFixed(1)}|${point.z.toFixed(1)}|${kind}`;
    if (signature === markerSignature) return;
    markerSignature = signature;
    marker.ringMaterial.color.set(color);
    marker.disc.material.color.set(color);
    marker.column.material.color.set(color);
    marker.gem.material.color.set(color);
  }

  // -- starting, finishing and failing --------------------------------------------------------

  function enterStage(index) {
    if (!state.active) return;
    stageIndex = index;
    const stage = state.active.stages[index];
    if (!stage) {
      finish('complete');
      return;
    }
    stageTime = stage.timer ?? 0;
    stageClock = 0;
    grabClock = 0;
    checkpointIndex = 0;
    markerSignature = '';
    if (stage.kind === 'checkpoints') {
      stageTime = stage.timer ?? 0;
    }
    if (stage.wanted) setWanted(stage.wanted);
    if (stage.kind === 'takedown' && targetCar) targetCar.health = 100;
    objectiveShown = '\u0000';
    setObjective(stageObjective(stage));
    showMarker(markerPoint(stage), stage.kind);
  }

  function start(id) {
    if (state.active) return { ok: false, reason: 'a job is already running' };
    const mission = missionById(id);
    if (!mission) return { ok: false, reason: 'no such job' };
    if (!isAvailable(mission)) {
      return {
        ok: false,
        reason: mission.n <= state.done ? 'already done' : `locked — finish job ${state.done + 1}`,
      };
    }
    state.active = mission;
    clearTarget();
    if (mission.spawn) spawnTarget(mission.spawn);
    if (mission.spawn?.flee) {
      const car = targetCar;
      car.missionFlee = true;
    }
    state.lastResult = null;
    onMissionStart(mission);
    onBanner('start', {
      kicker: `JOB ${mission.n} · ${mission.type}`,
      title: mission.title,
      subtitle: mission.intro,
      accent: '#ffd9a0',
    });
    enterStage(0);
    return { ok: true, mission };
  }

  /** Ends the running job. `outcome` is 'complete', 'fail' or 'abandon'. */
  function finish(outcome, reason = '') {
    if (!state.active) return null;
    const mission = state.active;
    state.active = null;
    failReason = reason;
    clearTarget();
    marker.group.visible = false;
    markerSignature = '';
    setObjective('');
    let paid = 0;
    if (outcome === 'complete') {
      state.done = Math.max(state.done, mission.n);
      paid = mission.reward;
      onReward(paid, mission);
      const note = getUnlockNote(mission.n) || '';
      onBanner('complete', {
        kicker: `JOB ${mission.n} COMPLETE · ${mission.type}`,
        title: mission.title,
        subtitle: `${mission.giver} pays out`,
        reward: paid,
        accent: '#9dffb0',
        note,
      });
    } else if (outcome === 'fail') {
      onBanner('fail', {
        kicker: `JOB ${mission.n} FAILED`,
        title: mission.title,
        subtitle: reason || 'The job went wrong',
        accent: '#ff7a63',
      });
    } else {
      onBanner('fail', {
        kicker: `JOB ${mission.n} ABANDONED`,
        title: mission.title,
        subtitle: 'Rosa is not impressed',
        accent: '#ffb36a',
      });
    }
    state.lastResult = { outcome, mission, paid, reason };
    onMissionEnd(mission, outcome);
    return state.lastResult;
  }

  /** main.js calls this when the body is busted or wasted mid-job. */
  function onPlayerDown(reason = 'You were picked up off the street') {
    if (!state.active) return;
    finish('fail', reason);
  }

  function abandon() {
    if (!state.active) return { ok: false, reason: 'no active job' };
    finish('abandon');
    return { ok: true };
  }

  /** The debug hook's shortcut: finish the whole running job through the normal path. */
  function forceComplete() {
    if (!state.active) return { ok: false, reason: 'no active job' };
    finish('complete');
    return { ok: true, done: state.done };
  }

  function skipStage() {
    if (!state.active) return { ok: false, reason: 'no active job' };
    const mission = state.active;
    if (stageIndex + 1 >= mission.stages.length) finish('complete');
    else enterStage(stageIndex + 1);
    return { ok: true, stage: stageIndex };
  }

  // -- the ticking --------------------------------------------------------------------------

  /**
   * A fleeing target: full throttle down whichever street runs away from the player, with a
   * waypoint ahead on the lane it is already on, so it corners at the intersections instead
   * of burying itself in a block.
   */
  function driveFleeingCar(dt) {
    const car = targetCar;
    if (!car) return;
    car.fleeTimer = (car.fleeTimer ?? 0) - dt;
    if (car.fleeTimer <= 0 || !car.fleeWaypoint) {
      car.fleeTimer = 1.3;
      const player = playerPoint();
      const lane = nearestLane(car.position.x, car.position.z);
      // The direction that points away from the player along the lane.
      if (lane.axis === 'z') {
        const away = car.position.z >= player.z ? 1 : -1;
        car.fleeWaypoint = { x: lane.x, z: car.position.z + away * 30 };
      } else {
        const away = car.position.x >= player.x ? 1 : -1;
        car.fleeWaypoint = { x: car.position.x + away * 30, z: lane.z };
      }
    }
    const waypoint = car.fleeWaypoint;
    // Stay in the right-hand lane by biasing the waypoint a couple of metres off the centre.
    const desired = Math.atan2(waypoint.x - car.position.x, waypoint.z - car.position.z);
    let difference = desired - car.heading;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    car.fleeSteer = Math.max(-1, Math.min(1, difference * 1.7));
    stepCar(car, dt, { throttle: 1, steer: car.fleeSteer, handbrake: false }, city);
    const reached = Math.hypot(waypoint.x - car.position.x, waypoint.z - car.position.z) < 8;
    if (reached) car.fleeWaypoint = null;
  }

  /**
   * One frame of the active job. `dt` is the simulation step; `elapsed` is the world's clock
   * for the marker pulse.
   */
  function update(dt, elapsed) {
    // The marker gem spins even when no job runs, so the booth reads as a meeting point.
    if (!state.active) {
      const next = nextMission();
      const point = next ? GIVER : null;
      showMarker(point, 'meet');
      if (point) {
        marker.gem.rotation.y += dt * 1.6;
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.4);
        marker.ringMaterial.opacity = 0.45 + pulse * 0.3;
      }
      setObjective('');
      return;
    }

    const mission = state.active;
    const stage = mission.stages[stageIndex];
    if (!stage) return;

    marker.gem.rotation.y += dt * 2.4;
    marker.gem.position.y = 3.1 + Math.sin(elapsed * 2.2) * 0.16;

    if (stage.followTarget && targetCar) {
      marker.group.position.set(targetCar.position.x, 0, targetCar.position.z);
    }

    if (stage.timer) {
      stageTime = Math.max(0, stageTime - dt);
      if (stageTime === 0) {
        finish('fail', 'Out of time');
        return;
      }
    }

    const player = playerPoint();
    const activeCar = getActiveCar();

    if (stage.kind === 'takedown') {
      if (targetCar) {
        driveFleeingCar(dt);
        // A hard nudge with the player's own car is a takedown too, so the job never needs a
        // gun: the courier's car is wrecked on the spot.
        if (activeCar && activeCar.speed > 6) {
          const gap = Math.hypot(activeCar.position.x - targetCar.position.x,
            activeCar.position.z - targetCar.position.z);
          if (gap < 4.6) {
            targetCar.health = 0;
            activeCar.speed *= 0.55;
          }
        }
      }
      if (!targetCar || targetCar.health <= 0) {
        enterStage(stageIndex + 1);
        return;
      }
    } else if (stage.kind === 'checkpoints') {
      if (!stage.needCar || activeCar) {
        const point = stage.checkpoints[checkpointIndex];
        if (point) {
          const distance = Math.hypot(player.x - point.x, player.z - point.z);
          if (distance <= stage.radius) {
            checkpointIndex += 1;
            markerSignature = '';
            if (checkpointIndex >= stage.checkpoints.length) {
              enterStage(stageIndex + 1);
              return;
            }
            showMarker(stage.checkpoints[checkpointIndex], stage.kind);
          }
        }
      }
    } else if (stage.kind === 'grab') {
      const inRange = distanceTo(stage.marker) <= stage.radius;
      if (inRange) grabClock += dt;
      else grabClock = Math.max(0, grabClock - dt * 1.5);
      if (grabClock >= (stage.grabSeconds ?? 3)) {
        enterStage(stageIndex + 1);
        return;
      }
    } else if (stage.kind === 'enter') {
      if (targetCar && activeCar === targetCar) {
        enterStage(stageIndex + 1);
        return;
      }
    } else if (stage.kind === 'deliver') {
      if (activeCar && distanceTo(stage.marker) <= stage.radius) {
        enterStage(stageIndex + 1);
        return;
      }
    } else {
      // 'reach': a plain waypoint, optionally only counted from inside a car.
      const inRange = distanceTo(stage.marker) <= stage.radius;
      if (inRange && (!stage.needCar || activeCar)) {
        enterStage(stageIndex + 1);
        return;
      }
    }

    setObjective(stageObjective(stage));
    showMarker(markerPoint(stage), stage.kind);
  }

  /** Combat's car hits land here; only the job's own target cares. */
  function damageTarget(car, amount) {
    if (!car || car !== targetCar) return;
    car.health = Math.max(0, (car.health ?? 100) - amount);
  }

  // -- the phone ------------------------------------------------------------------------------

  function describe(mission) {
    if (!mission) return '';
    return `${mission.type} · $${mission.reward.toLocaleString('en-US')}`;
  }

  function renderPhone() {
    phoneRows.innerHTML = '';
    const next = nextMission();
    phoneTitle.textContent = 'MAMA ROSA · JOBS';
    const active = state.active;
    if (active) {
      phoneSub.textContent = `Running: ${active.title}`;
    } else if (next) {
      phoneSub.textContent = `Next: ${next.title}`;
    } else {
      phoneSub.textContent = 'The story is done. The city is yours.';
    }

    const makeRow = (mission, options = {}) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:9px 0;border-bottom:1px solid rgba(255,244,226,0.08);';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:13px;font-weight:800;letter-spacing:0.06em;';
      title.textContent = `${mission.n}. ${mission.title}`;
      title.style.color = options.locked ? 'rgba(255,244,226,0.32)' : '#fff4e2';
      const tag = document.createElement('div');
      tag.style.cssText = 'flex:none;font-size:9px;letter-spacing:0.16em;';
      tag.style.color = options.locked ? 'rgba(255,244,226,0.3)' : '#ffcf92';
      tag.textContent = options.locked ? `AFTER JOB ${mission.n - 1}` : describe(mission);
      head.append(title, tag);
      const body = document.createElement('div');
      body.style.cssText = 'margin-top:4px;font-size:10px;line-height:1.5;color:rgba(255,244,226,0.55);';
      body.textContent = mission.intro;
      row.append(head, body);

      if (!options.locked && !state.active && mission.n === state.done + 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'START JOB';
        button.style.cssText = 'margin-top:7px;appearance:none;border:0;cursor:pointer;padding:7px 16px;' +
          'border-radius:4px;background:linear-gradient(180deg,#ffd9a0,#f2b25f);color:#20160c;' +
          'font:800 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:0.24em;';
        button.addEventListener('click', () => {
          start(mission.id);
          renderPhone();
        });
        row.appendChild(button);
      }
      return row;
    };

    // Show the story in a rolling window: done jobs stay visible as a record.
    const shown = MISSIONS.filter((mission) => mission.n >= Math.max(1, state.done) &&
      mission.n <= state.done + 3);
    for (const mission of shown) {
      if (mission.id === active?.id) {
        const row = makeRow(mission, {});
        const badge = document.createElement('div');
        badge.style.cssText = 'margin-top:6px;font-size:9px;letter-spacing:0.2em;color:#9dffb0';
        badge.textContent = 'ACTIVE · FOLLOW THE OBJECTIVE';
        row.appendChild(badge);
        phoneRows.appendChild(row);
        continue;
      }
      const locked = mission.n !== state.done + 1;
      if (locked && mission.n > state.done + 1) {
        phoneRows.appendChild(makeRow(mission, { locked: true }));
      } else {
        phoneRows.appendChild(makeRow(mission, { locked: mission.n <= state.done }));
      }
    }

    if (active) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'ABANDON JOB';
      button.style.cssText = 'margin-top:12px;appearance:none;cursor:pointer;width:100%;padding:9px;' +
        'border-radius:4px;border:1px solid rgba(255,122,99,0.5);background:transparent;' +
        'color:#ff9a85;font:700 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:0.24em;';
      button.addEventListener('click', () => {
        abandon();
        renderPhone();
      });
      phoneRows.appendChild(button);
    }
  }

  function openPhone() {
    state.phoneOpen = true;
    renderPhone();
    phoneRoot.style.display = 'block';
  }

  function closePhone() {
    state.phoneOpen = false;
    phoneRoot.style.display = 'none';
  }

  function togglePhone() {
    if (state.phoneOpen) closePhone();
    else openPhone();
    return state.phoneOpen;
  }

  function hidePhone() {
    closePhone();
  }

  /** The world markers and blips the minimap should show: the active objective, or Rosa. */
  function blips() {
    const list = [];
    if (state.active) {
      const stage = state.active.stages[stageIndex];
      const point = markerPoint(stage);
      if (point) {
        list.push({
          x: point.x, z: point.z, color: MARKER_COLOR[stage.kind] ?? '#ffd05e', kind: 'objective',
        });
      }
    } else {
      const next = nextMission();
      if (next) list.push({ x: GIVER.x, z: GIVER.z, color: '#ffcf92', kind: 'giver' });
    }
    return list;
  }

  function snapshot() {
    return {
      done: state.done,
      active: state.active ? state.active.id : null,
      stage: state.active ? stageIndex : 0,
    };
  }

  /** Restores the chain from a save. A job that was mid-run is not restored: its timer and
   *  target car are gone with the session, so it is left open to be taken again. */
  function restore(data = {}) {
    state.done = Number.isFinite(data.done) ? Math.max(0, Math.min(MISSION_COUNT, data.done)) : 0;
    state.active = null;
    stageIndex = 0;
    clearTarget();
    marker.group.visible = false;
    markerSignature = '';
    setObjective('');
    closePhone();
  }

  function reset() {
    restore({ done: 0 });
  }

  return {
    missions: MISSIONS,
    giver: GIVER,
    start,
    update,
    finish,
    abandon,
    forceComplete,
    skipStage,
    onPlayerDown,
    damageTarget,
    blips,
    snapshot,
    restore,
    reset,
    nextMission,
    togglePhone,
    openPhone,
    closePhone,
    hidePhone,
    renderPhone,
    get done() {
      return state.done;
    },
    get active() {
      return state.active;
    },
    get phoneOpen() {
      return state.phoneOpen;
    },
    get phoneVisible() {
      return phoneRoot.style.display !== 'none';
    },
    get lastResult() {
      return state.lastResult;
    },
    /** What the objective line currently shows, timer included. */
    get objective() {
      return objectiveShown;
    },
    /** The active stage's world point, for the smoke test's marker check. */
    get marker() {
      if (!marker.group.visible) return null;
      return { x: marker.group.position.x, z: marker.group.position.z };
    },
    get markerVisible() {
      return marker.group.visible;
    },
    get targetCar() {
      return targetCar;
    },
    get stageIndex() {
      return stageIndex;
    },
    get stageTime() {
      return stageTime;
    },
    /** The phone's visible text, for the smoke test. */
    get phoneText() {
      return phoneRoot.textContent;
    },
    get phoneRoot() {
      return phoneRoot;
    },
  };
}
