// The wanted system and the police who answer it. Crimes raise a 1-5 star level; the level
// decides how many patrol cars come, whether roadblocks and spike strips are set ahead of the
// player, and at five stars whether a helicopter follows with a searchlight. The cars are
// ordinary vehicles.js cars driven by a pursuit controller (steer at the player, follow the
// road grid when a building blocks the straight line, ram what it is chasing); the helicopter
// is a small box model over a cone of light.
//
// Heat decays only when no officer has a line of sight for a cooldown, and then one star at a
// time. Two routes end a pursuit: an officer within two metres of the player on foot for two
// seconds, or two police cars around the player's slow car. Both call onBusted, which main.js
// turns into the busted screen and a respawn at the station.

import * as THREE from 'three';
import { createCar, onRoad, stepCar } from './vehicles.js';
import { createRng } from './rng.js';
import { CITY } from './city.js';

const MAX_STARS = 5;
/** Patrol cars wanted at each star level (index is the level). */
const CARS_FOR_LEVEL = [0, 2, 2, 3, 4, 5];
const SPAWN_MIN = 42;
const SPAWN_MAX = 88;
const DESPAWN_RADIUS = 250;
const MAX_COPS = 6;
const CHASE_RANGE = 36;
const LINE_OF_SIGHT_RANGE = 95;
const DECAY_COOLDOWN = 6;
const DECAY_STEP = 7;
const BUST_DISTANCE = 2;
const BUST_HOLD = 2;
const BUST_CAR_SPEED = 3;
const BUST_CAR_RADIUS = 8;
const OFFICER_WALK = 3.6;
const OFFICER_SIGHT = 24;
const ROADBLOCK_AT = 3;
const SPIKE_AT = 4;
const ROADBLOCK_INTERVAL = 14;
const ROADBLOCK_AHEAD = 58;

/** Sunny Bay's police headquarters: the crossroads the busted player is taken back to. */
export const POLICE_STATION = { x: -99, z: -66, heading: Math.PI / 2 };

const CRIME_STARS = { theft: 1, pedestrian: 1, car: 1, police: 2 };

const LINES = Array.from({ length: CITY.gridLines }, (_, index) => -CITY.halfSpan + index * CITY.pitch);
const HALF_ROAD = CITY.roadWidth / 2;

function snapToLine(value) {
  let best = LINES[0];
  let bestDistance = Math.abs(value - best);
  for (const line of LINES) {
    const distance = Math.abs(value - line);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

function wrapAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

/** Does the 2D segment touch the collider's footprint? Slab test, no allocation. */
function segmentHitsBox(x1, z1, x2, z2, box) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  let tMin = 0;
  let tMax = 1;
  if (Math.abs(dx) < 1e-6) {
    if (x1 < box.minX || x1 > box.maxX) return false;
  } else {
    let t1 = (box.minX - x1) / dx;
    let t2 = (box.maxX - x1) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  if (Math.abs(dz) < 1e-6) {
    if (z1 < box.minZ || z1 > box.maxZ) return false;
  } else {
    let t1 = (box.minZ - z1) / dz;
    let t2 = (box.maxZ - z1) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

/** Shared police visual resources: one light bar, one officer figure, a handful of materials. */
const COP_GEO = {
  legs: new THREE.BoxGeometry(0.34, 0.8, 0.22),
  torso: new THREE.BoxGeometry(0.46, 0.6, 0.26),
  head: new THREE.BoxGeometry(0.24, 0.26, 0.24),
  arm: new THREE.BoxGeometry(0.12, 0.5, 0.14),
  bar: new THREE.BoxGeometry(1.14, 0.12, 0.24),
  lamp: new THREE.BoxGeometry(0.4, 0.15, 0.22),
};
COP_GEO.legs.translate(0, 0.4, 0);
COP_GEO.arm.translate(0, -0.22, 0);

const COP_MATERIALS = {
  navy: new THREE.MeshLambertMaterial({ color: '#243447' }),
  shirt: new THREE.MeshLambertMaterial({ color: '#d9e4ee' }),
  skin: new THREE.MeshLambertMaterial({ color: '#b97a52' }),
  dark: new THREE.MeshLambertMaterial({ color: '#14181e' }),
  red: new THREE.MeshLambertMaterial({ color: '#ff4a3a', emissive: '#5a0d06' }),
  blue: new THREE.MeshLambertMaterial({ color: '#3d7bff', emissive: '#0a1f6b' }),
  cone: new THREE.MeshBasicMaterial({
    color: '#eaf6ff', transparent: true, opacity: 0.075, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }),
};

function buildOfficer() {
  const group = new THREE.Group();
  const legs = new THREE.Mesh(COP_GEO.legs, COP_MATERIALS.navy);
  const torso = new THREE.Mesh(COP_GEO.torso, COP_MATERIALS.shirt);
  torso.position.y = 1.1;
  const head = new THREE.Mesh(COP_GEO.head, COP_MATERIALS.skin);
  head.position.y = 1.56;
  const cap = new THREE.Mesh(COP_GEO.lamp, COP_MATERIALS.navy);
  cap.scale.set(0.9, 0.55, 1.1);
  cap.position.y = 1.72;
  const armLeft = new THREE.Mesh(COP_GEO.arm, COP_MATERIALS.navy);
  armLeft.position.set(-0.3, 1.35, 0);
  const armRight = new THREE.Mesh(COP_GEO.arm, COP_MATERIALS.navy);
  armRight.position.set(0.3, 1.35, 0);
  group.add(legs, torso, head, cap, armLeft, armRight);
  group.castShadow = true;
  group.visible = false;
  return { group, parts: { legs, armLeft, armRight }, x: 0, z: 0, stride: 0 };
}

export function createPolice(scene, city, options = {}) {
  const { onBusted = null, onCrime = null, effects = null, seed = 0x9c0ffee } = options;
  const rng = createRng(seed);
  const cars = [];
  const roadblocks = [];
  const spikes = [];
  const wanted = { level: 0, flash: 0, lastCrime: null, exposed: false };
  let seenTimer = 0;
  let decayCountdown = 0;
  let bustTimer = 0;
  let busted = false;
  let spawnTimer = 0;
  let blockTimer = 0;
  let sightTimer = 0;
  let elapsed = 0;
  let helicopter = null;

  // -- helicopter --------------------------------------------------------------------------
  let heliModel = null;
  let heliBeam = null;
  let heliLamp = null;

  function buildHelicopter() {
    const group = new THREE.Group();
    group.name = 'police-helicopter';
    const dark = COP_MATERIALS.dark;
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.05, 3.6), dark);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.75, 1.2), dark);
    nose.position.set(0, -0.05, 2.1);
    const skidA = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.12), dark);
    skidA.position.set(0, -0.7, 0.5);
    const skidB = skidA.clone();
    skidB.position.z = -0.8;
    const rotor = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.08, 0.24), dark);
    rotor.position.set(0, 0.65, 0);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 2.2), dark);
    tail.position.set(0, 0.3, -2.6);
    const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.15, 0.14), dark);
    tailRotor.position.set(0.12, 0.3, -3.35);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#fff7dc' }),
    );
    lamp.position.set(0, -0.58, 1.9);
    group.add(body, nose, skidA, skidB, rotor, tail, tailRotor, lamp);
    group.visible = false;
    scene.add(group);

    const beam = new THREE.Mesh(new THREE.ConeGeometry(9.5, 26, 18, 1, true), COP_MATERIALS.cone);
    beam.visible = false;
    scene.add(beam);
    const spotlight = new THREE.SpotLight('#eaf6ff', 0, 70, 0.36, 0.6, 1.4);
    spotlight.castShadow = false;
    scene.add(spotlight, spotlight.target);
    heliModel = { group, rotor, tailRotor, lamp };
    heliBeam = beam;
    heliLamp = spotlight;
    return heliModel;
  }

  const heliFrom = new THREE.Vector3();
  const heliTo = new THREE.Vector3();
  const heliDown = new THREE.Vector3(0, -1, 0);
  const heliDirection = new THREE.Vector3();

  function updateHelicopter(dt, anchor) {
    if (wanted.level >= 5) {
      if (!helicopter) helicopter = buildHelicopter();
      helicopter.group.visible = true;
      heliBeam.visible = true;
      const orbit = elapsed * 0.5;
      const goalX = anchor.x + Math.sin(orbit) * 26;
      const goalZ = anchor.z + Math.cos(orbit) * 26;
      const group = helicopter.group;
      group.position.x += (goalX - group.position.x) * (1 - Math.exp(-0.8 * dt));
      group.position.z += (goalZ - group.position.z) * (1 - Math.exp(-0.8 * dt));
      group.position.y += (40 - group.position.y) * (1 - Math.exp(-1.4 * dt));
      group.rotation.y = Math.atan2(anchor.x - group.position.x, anchor.z - group.position.z);
      helicopter.rotor.rotation.y += dt * 28;
      helicopter.tailRotor.rotation.x += dt * 34;

      group.updateMatrixWorld();
      heliFrom.set(0, -0.58, 1.9).applyMatrix4(group.matrixWorld);
      heliTo.set(anchor.x, city.groundHeightAt(anchor.x, anchor.z) + 0.2, anchor.z);
      heliDirection.copy(heliTo).sub(heliFrom);
      const span = heliDirection.length();
      heliDirection.normalize();
      heliBeam.position.copy(heliFrom);
      heliBeam.quaternion.setFromUnitVectors(heliDown, heliDirection);
      const scale = Math.max(2, span) / 26;
      heliBeam.scale.set(scale, scale, scale);
      heliLamp.position.copy(heliFrom);
      heliLamp.target.position.copy(heliTo);
      heliLamp.target.updateMatrixWorld();
      heliLamp.intensity = 55;
    } else if (helicopter) {
      helicopter.group.visible = false;
      heliBeam.visible = false;
      heliLamp.intensity = 0;
    }
  }

  // -- wanted -----------------------------------------------------------------------------
  function setWanted(level) {
    wanted.level = Math.max(0, Math.min(MAX_STARS, Math.floor(level)));
    wanted.flash = wanted.level > 0 ? 1.2 : 0;
    seenTimer = 0;
    decayCountdown = 0;
    if (wanted.level === 0) clearResponse();
    else {
      // Prime the response at once so a forced level is visible without waiting.
      spawnTimer = 0;
      if (wanted.level >= ROADBLOCK_AT) blockTimer = ROADBLOCK_INTERVAL;
      const immediate = Math.min(2, CARS_FOR_LEVEL[wanted.level] - cars.length);
      for (let index = 0; index < immediate; index += 1) spawnChaseCar();
    }
    return wanted.level;
  }

  function raise(amount, reason = null) {
    const before = wanted.level;
    wanted.level = Math.min(MAX_STARS, wanted.level + amount);
    if (wanted.level > before) {
      wanted.flash = 1.6;
      wanted.lastCrime = reason ?? wanted.lastCrime;
      seenTimer = 0;
      decayCountdown = 0;
      spawnTimer = 0;
      // The first roadblock is set as soon as the level that wants one is reached.
      if (wanted.level >= ROADBLOCK_AT && blockTimer < ROADBLOCK_INTERVAL) blockTimer = ROADBLOCK_INTERVAL;
      onCrime?.(wanted.level, reason);
    }
    return wanted.level;
  }

  /** The one entry point main.js uses for thefts, hits, crashes and attacks on officers. */
  function crime(type, detail = {}) {
    const before = wanted.level;
    raise(CRIME_STARS[type] ?? 1, type);
    void detail;
    return { before, after: wanted.level, stars: CRIME_STARS[type] ?? 1 };
  }

  function clearWanted() {
    wanted.level = 0;
    wanted.flash = 0;
    wanted.exposed = false;
    seenTimer = 0;
    decayCountdown = 0;
    bustTimer = 0;
    busted = false;
    clearResponse();
  }

  function clearResponse() {
    for (const cop of cars) {
      scene.remove(cop.group);
      scene.remove(cop.officer.group);
    }
    cars.length = 0;
    for (const block of roadblocks) scene.remove(block.group);
    roadblocks.length = 0;
    spikes.length = 0;
  }

  // -- officers and cars ---------------------------------------------------------------------
  function buildCopCar(spot, heading) {
    const car = createCar(scene, city, {
      type: 'sedan', color: '#f2efe6', x: spot.x, z: spot.z, heading,
    });
    car.cop = true;
    car.playerOwned = true;
    car.stolen = false;
    car.velocity.set(0, 0, 0);
    car.health = 100;
    car.ramCooldown = 0;
    car.aimTimer = 0;
    car.fireCooldown = rng.range(0.8, 2.2);

    const bar = new THREE.Mesh(COP_GEO.bar, COP_MATERIALS.dark);
    bar.position.set(0, 1.42, -0.15);
    const lampRed = new THREE.Mesh(COP_GEO.lamp, COP_MATERIALS.red);
    lampRed.position.set(-0.33, 1.55, -0.15);
    lampRed.scale.set(0.86, 1, 1);
    const lampBlue = new THREE.Mesh(COP_GEO.lamp, COP_MATERIALS.blue);
    lampBlue.position.set(0.33, 1.55, -0.15);
    lampBlue.scale.set(0.86, 1, 1);
    car.group.add(bar, lampRed, lampBlue);
    car.lightBar = { red: lampRed, blue: lampBlue };

    const officer = buildOfficer();
    officer.x = spot.x;
    officer.z = spot.z;
    officer.car = car;
    officer.health = 100;
    officer.carHealth = car.health;
    officer.group.position.set(spot.x, city.groundHeightAt(spot.x, spot.z), spot.z);
    scene.add(officer.group);
    car.officer = officer;
    return car;
  }

  /** A road point near the player, on the same street where possible, out of his sight line. */
  function findSpawn(anchor) {
    const roadX = snapToLine(anchor.x);
    const roadZ = snapToLine(anchor.z);
    const candidates = [];
    for (const distance of [SPAWN_MIN, (SPAWN_MIN + SPAWN_MAX) / 2, SPAWN_MAX]) {
      for (const sign of [1, -1]) {
        candidates.push({ x: roadX, z: roadZ + sign * distance });
        candidates.push({ x: roadZ, z: roadX + sign * distance });
        candidates.push({ x: roadX + sign * distance, z: roadZ });
        candidates.push({ x: roadZ + sign * distance, z: roadX });
      }
    }
    // Shuffle with the seeded stream so the response never arrives from one direction only.
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swap = rng.int(0, index);
      [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
    }
    const { bounds } = city;
    for (const spot of candidates) {
      if (spot.x < bounds.minX + 5 || spot.x > bounds.maxX - 5) continue;
      if (spot.z < bounds.minZ + 5 || spot.z > bounds.maxZ - 5) continue;
      if (!onRoad(spot.x, spot.z)) continue;
      if (Math.hypot(spot.x - anchor.x, spot.z - anchor.z) < 28) continue;
      let crowded = false;
      for (const cop of cars) {
        if (Math.hypot(cop.position.x - spot.x, cop.position.z - spot.z) < 12) crowded = true;
      }
      if (!crowded) return spot;
    }
    return null;
  }

  function spawnChaseCar(anchor = lastAnchor) {
    if (cars.length >= MAX_COPS) return null;
    const spot = findSpawn(anchor);
    if (!spot) return null;
    const heading = Math.atan2(anchor.x - spot.x, anchor.z - spot.z);
    const car = buildCopCar(spot, heading);
    car.spawnDistance = Math.hypot(spot.x - anchor.x, spot.z - anchor.z);
    cars.push(car);
    return car;
  }

  let lastAnchor = { x: 0, z: 0 };

  /** The straight-line path is clear? If so chase direct; if not, keep to the road grid. */
  function pathClear(x1, z1, x2, z2) {
    for (const collider of city.colliders) {
      if (segmentHitsBox(x1, z1, x2, z2, collider)) return false;
    }
    return true;
  }

  /** A point on the current road that moves toward the target, for when a block is in the way. */
  function roadGoal(car, target) {
    const roadX = snapToLine(car.position.x);
    const roadZ = snapToLine(car.position.z);
    const onNs = Math.abs(car.position.x - roadX) < HALF_ROAD + 2.5;
    const onEw = Math.abs(car.position.z - roadZ) < HALF_ROAD + 2.5;
    let axis;
    if (onNs && !onEw) axis = 'z';
    else if (onEw && !onNs) axis = 'x';
    else axis = Math.abs(target.x - car.position.x) > Math.abs(target.z - car.position.z) ? 'x' : 'z';
    if (axis === 'x') {
      const direction = Math.sign(target.x - car.position.x) || 1;
      return { x: car.position.x + direction * 24, z: roadZ };
    }
    const direction = Math.sign(target.z - car.position.z) || 1;
    return { x: roadX, z: car.position.z + direction * 24 };
  }

  function driveCop(car, dt, target, anchor) {
    const distance = Math.hypot(target.x - car.position.x, target.z - car.position.z);
    let goal = target;
    if (distance > CHASE_RANGE && !pathClear(car.position.x, car.position.z, target.x, target.z)) {
      goal = roadGoal(car, target);
    }
    const dx = goal.x - car.position.x;
    const dz = goal.z - car.position.z;
    const desired = Math.atan2(dx, dz);
    const difference = wrapAngle(desired - car.heading);
    const toGoal = Math.hypot(dx, dz);
    let throttle = toGoal > 3 ? 1 : 0;
    const cap = Math.abs(difference) > 0.85 ? 11 : 33;
    if (car.speed > cap) throttle = -0.55;
    else if (Math.abs(difference) > 1.25 && car.speed > 8) throttle = -0.2;
    else if (Math.abs(difference) > 0.6) throttle = Math.min(throttle, 0.45);
    // A fleeing body on foot is an arrest, not a chase: the cruiser pulls up alongside and
    // stops, and the officers get out. Ramming only happens if it cannot stop in time.
    if (anchor.onFoot && distance < 15) throttle = car.speed > 1.6 ? -1 : 0;
    // Stuck against a block or a corner: put the cruiser back on the nearest lane and let it
    // come round again. A pursuit that can be pinned forever by a fence is not a pursuit.
    if (throttle > 0.5 && car.speed < 0.7) car.stuckTime = (car.stuckTime ?? 0) + dt;
    else car.stuckTime = 0;
    if (car.stuckTime > 1.3) {
      car.stuckTime = 0;
      const lineX = snapToLine(car.position.x);
      const lineZ = snapToLine(car.position.z);
      if (Math.abs(car.position.x - lineX) < Math.abs(car.position.z - lineZ)) car.position.x = lineX;
      else car.position.z = lineZ;
      car.heading = Math.atan2(target.x - car.position.x, target.z - car.position.z);
      car.speed = 0;
      car.velocity.set(0, 0, 0);
      car.group.position.copy(car.position);
    }
    stepCar(car, dt, {
      throttle,
      steer: Math.max(-1, Math.min(1, difference * 1.9)),
      handbrake: Math.abs(difference) > 1.55 && car.speed > 12,
    }, city);
    // Judder the light bar: alternate the two lamps, faster as the level rises.
    const phase = Math.floor(elapsed * (6 + wanted.level * 2)) % 2 === 0;
    car.lightBar.red.material = phase ? COP_MATERIALS.red : COP_MATERIALS.dark;
    car.lightBar.blue.material = phase ? COP_MATERIALS.dark : COP_MATERIALS.blue;
    void anchor;
  }

  function updateOfficer(car, dt, player, onFoot) {
    const officer = car.officer;
    const distanceToPlayer = Math.hypot(player.x - officer.x, player.z - officer.z);
    const active = onFoot && car.speed < 2.4 && distanceToPlayer < OFFICER_SIGHT;
    if (!active) {
      officer.group.visible = false;
      return 0;
    }
    officer.group.visible = true;
    const dx = player.x - officer.x;
    const dz = player.z - officer.z;
    const length = Math.hypot(dx, dz) || 1;
    const walk = distanceToPlayer > 1.5 ? OFFICER_WALK : 0;
    officer.x += (dx / length) * walk * dt;
    officer.z += (dz / length) * walk * dt;
    officer.x = Math.min(city.bounds.maxX, Math.max(city.bounds.minX, officer.x));
    officer.z = Math.min(city.bounds.maxZ, Math.max(city.bounds.minZ, officer.z));
    officer.stride += walk * dt * 3.2;
    const swing = Math.sin(officer.stride) * 0.6;
    officer.parts.legs.rotation.x = swing * 0.5;
    officer.parts.armLeft.rotation.x = -swing;
    officer.parts.armRight.rotation.x = swing;
    const heading = Math.atan2(dx, dz);
    officer.group.position.set(officer.x, city.groundHeightAt(officer.x, officer.z), officer.z);
    officer.group.rotation.y = heading;
    return distanceToPlayer;
  }

  // -- line of sight, decay, bust ------------------------------------------------------------
  function hasSight(fromX, fromZ, player) {
    if (Math.hypot(player.x - fromX, player.z - fromZ) > LINE_OF_SIGHT_RANGE) return false;
    return pathClear(fromX, fromZ, player.x, player.z);
  }

  function anySight(player) {
    for (const cop of cars) {
      if (hasSight(cop.position.x, cop.position.z, player)) return true;
      if (cop.officer.group.visible && hasSight(cop.officer.x, cop.officer.z, player)) return true;
    }
    return false;
  }

  function updateDecay(dt, player) {
    sightTimer += dt;
    if (sightTimer < 0.3) return;
    sightTimer = 0;
    const seen = anySight(player);
    wanted.exposed = seen;
    if (seen) {
      seenTimer = 0;
      decayCountdown = 0;
      return;
    }
    seenTimer += 0.3;
    if (seenTimer >= DECAY_COOLDOWN) {
      decayCountdown += 0.3;
      if (decayCountdown >= DECAY_STEP && wanted.level > 0) {
        decayCountdown = 0;
        wanted.level -= 1;
        seenTimer = DECAY_COOLDOWN - 3;
        if (wanted.level === 0) clearResponse();
      }
    }
  }

  function tryBust(dt, player, onFoot, activeCar) {
    if (busted) return;
    let close = false;
    let surrounded = 0;
    for (const cop of cars) {
      const distance = Math.hypot(cop.position.x - player.x, cop.position.z - player.z);
      if (onFoot) {
        if (cop.officer.group.visible) {
          if (Math.hypot(cop.officer.x - player.x, cop.officer.z - player.z) <= BUST_DISTANCE) close = true;
        }
        // A cruiser itself counts when it has pulled up on the player on foot.
        if (cop.speed < 3 && distance <= BUST_DISTANCE + 1.1) close = true;
      } else if (distance <= BUST_CAR_RADIUS && cop.speed < 12) {
        surrounded += 1;
      }
    }
    const pinning = onFoot ? close : surrounded >= 2 && (activeCar?.speed ?? 0) < BUST_CAR_SPEED;
    if (pinning) bustTimer += dt;
    else bustTimer = Math.max(0, bustTimer - dt * 1.5);
    if (bustTimer >= BUST_HOLD) {
      busted = true;
      bustTimer = 0;
      onBusted?.({ reason: onFoot ? 'foot' : 'car' });
    }
  }

  function forceBust() {
    if (busted) return false;
    busted = true;
    onBusted?.({ reason: 'forced' });
    return true;
  }

  // -- roadblocks and spike strips -----------------------------------------------------------
  function spawnRoadblock(player, heading) {
    const aheadX = player.x + Math.sin(heading) * ROADBLOCK_AHEAD;
    const aheadZ = player.z + Math.cos(heading) * ROADBLOCK_AHEAD;
    const lineX = snapToLine(aheadX);
    const lineZ = snapToLine(aheadZ);
    // The road the block sits on: the line it is nearest, and the other coordinate snapped.
    const alongZ = Math.abs(aheadX - lineX) < Math.abs(aheadZ - lineZ);
    const spot = alongZ ? { x: lineX, z: snapToLine(aheadZ) } : { x: snapToLine(aheadX), z: lineZ };
    if (!onRoad(spot.x, spot.z)) return null;
    if (Math.hypot(spot.x - player.x, spot.z - player.z) > ROADBLOCK_AHEAD + 32) return null;

    const group = new THREE.Group();
    group.name = 'roadblock';
    // A road along z is blocked across x: two cruisers nose to nose, the strip between them.
    const carHeading = alongZ ? Math.PI / 2 : 0;
    const block = { group, x: spot.x, z: spot.z, age: 0, cars: [], spike: null };
    for (const side of [-1, 1]) {
      const x = alongZ ? spot.x + side * 3.9 : spot.x;
      const z = alongZ ? spot.z : spot.z + side * 3.9;
      const car = buildCopCar({ x, z }, carHeading);
      car.velocity.set(0, 0, 0);
      car.static = true;
      car.officer.group.visible = false;
      scene.remove(car.officer.group);
      scene.remove(car.group);
      car.group.position.set(x, 0, z);
      car.group.rotation.y = carHeading;
      group.add(car.group);
      block.cars.push(car);
    }
    // A spike strip laid across the gap between the two cruisers.
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(alongZ ? 7.4 : 0.5, 0.08, alongZ ? 0.5 : 7.4),
      COP_MATERIALS.dark,
    );
    strip.position.set(spot.x, 0.06, spot.z);
    group.add(strip);
    for (let index = 0; index < 6; index += 1) {
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 4), COP_MATERIALS.dark);
      tooth.position.set(
        alongZ ? spot.x + (index - 2.5) * 0.55 : spot.x,
        0.2,
        alongZ ? spot.z : spot.z + (index - 2.5) * 0.55,
      );
      group.add(tooth);
    }
    scene.add(group);
    roadblocks.push(block);
    if (wanted.level >= SPIKE_AT) {
      block.spike = { x: spot.x, z: spot.z };
      spikes.push(block);
    }
    return block;
  }

  function updateRoadblocks(dt, player, activeCar, onFoot, playerHeading) {
    blockTimer += dt;
    if (wanted.level >= ROADBLOCK_AT && blockTimer > ROADBLOCK_INTERVAL) {
      let nearest = Infinity;
      for (const block of roadblocks) {
        nearest = Math.min(nearest, Math.hypot(block.x - player.x, block.z - player.z));
      }
      if (nearest > 70) {
        spawnRoadblock(player, playerHeading ?? (activeCar?.heading ?? 0));
        blockTimer = 0;
      } else {
        blockTimer = ROADBLOCK_INTERVAL - 3;
      }
    }
    for (let index = roadblocks.length - 1; index >= 0; index -= 1) {
      const block = roadblocks[index];
      block.age += dt;
      if (block.age > 70) {
        scene.remove(block.group);
        roadblocks.splice(index, 1);
        const spikeIndex = spikes.indexOf(block);
        if (spikeIndex >= 0) spikes.splice(spikeIndex, 1);
        continue;
      }
      // Blocking cruisers are solid: a player's car that drives into one is stopped.
      if (activeCar) {
        for (const car of block.cars) {
          const dx = activeCar.position.x - car.position.x;
          const dz = activeCar.position.z - car.position.z;
          const distance = Math.hypot(dx, dz);
          const reach = car.halfWidth + activeCar.halfWidth + 0.7;
          if (distance < reach && distance > 0.001) {
            activeCar.position.x += (dx / distance) * (reach - distance);
            activeCar.position.z += (dz / distance) * (reach - distance);
            activeCar.velocity.multiplyScalar(0.4);
            activeCar.speed *= 0.4;
          }
        }
      }
      // Spikes: a fast car over the strip loses most of its speed.
      if (block.spike && activeCar && Math.hypot(activeCar.position.x - block.spike.x,
        activeCar.position.z - block.spike.z) < 2.2 && activeCar.speed > 13) {
        activeCar.speed *= 0.32;
        activeCar.velocity.multiplyScalar(0.32);
        block.spike = null;
        effects?.shake?.(0.5);
      }
    }
  }

  // -- police fire ---------------------------------------------------------------------------
  const officerChest = new THREE.Vector3();

  function updateFire(dt, player, onFoot) {
    if (wanted.level < 2) return;
    const anchorY = city.groundHeightAt(player.x, player.z) + 1.25;
    for (const cop of cars) {
      const officer = cop.officer;
      const useOfficer = officer.group.visible;
      const fromX = useOfficer ? officer.x : cop.position.x;
      const fromZ = useOfficer ? officer.z : cop.position.z;
      const distance = Math.hypot(player.x - fromX, player.z - fromZ);
      if (distance > 34) continue;
      if (!hasSight(fromX, fromZ, player)) continue;
      if (cop.aimTimer > 0) {
        cop.aimTimer -= dt;
        if (cop.aimTimer <= 0) {
          cop.aimTimer = 0;
          cop.fireCooldown = rng.range(1.5, 2.8) / (1 + (wanted.level - 2) * 0.2);
          // Telegraph is over: a hitscan round, accurate unless the player is sprinting away.
          const hit = rng.chance(onFoot ? 0.55 : 0.4);
          const spread = hit ? 0 : rng.range(1.2, 3.2);
          const angle = rng.range(0, Math.PI * 2);
          const targetX = player.x + Math.cos(angle) * spread;
          const targetZ = player.z + Math.sin(angle) * spread;
          const targetY = anchorY + rng.range(-0.4, 0.5);
          officerChest.set(fromX, 1.1, fromZ);
          effects?.tracer?.(officerChest, new THREE.Vector3(targetX, targetY, targetZ), '#ffe1a3');
          effects?.spark?.(targetX, targetY, targetZ, '#ffd27a');
          if (hit) effects?.damagePlayer?.(rng.range(6, 10), 'police');
          effects?.shake?.(0.35);
        }
        continue;
      }
      cop.fireCooldown -= dt;
      if (cop.fireCooldown <= 0) {
        cop.aimTimer = 0.45;
        // A visible telegraph: the officer's muzzle glints as they take aim.
        if (useOfficer) effects?.spark?.(fromX, 1.45, fromZ, '#ffb36a');
      }
    }
  }

  // -- one step ------------------------------------------------------------------------------
  /**
   * Advances the response. `context` is { player, onFoot, activeCar }: player is the body's
   * position, activeCar the car being driven (or null).
   */
  function step(dt, context) {
    elapsed += dt;
    const { player, onFoot = true, activeCar = null, heading = 0 } = context;
    lastAnchor = { x: player.x, z: player.z };
    wanted.flash = Math.max(0, wanted.flash - dt);

    if (wanted.level > 0) {
      const targetCount = CARS_FOR_LEVEL[wanted.level];
      spawnTimer += dt;
      if (cars.length < targetCount && spawnTimer > 1.2) {
        spawnChaseCar({ x: player.x, z: player.z });
        spawnTimer = 0;
      }
    }

    const chaseTarget = {
      x: player.x,
      z: player.z,
      vx: activeCar ? activeCar.velocity.x : 0,
      vz: activeCar ? activeCar.velocity.z : 0,
    };
    for (let index = cars.length - 1; index >= 0; index -= 1) {
      const cop = cars[index];
      if (cop.health <= 0) {
        cop.officer.group.visible = false;
        scene.remove(cop.group);
        scene.remove(cop.officer.group);
        cars.splice(index, 1);
        continue;
      }
      if (wanted.level === 0 || Math.hypot(cop.position.x - player.x, cop.position.z - player.z) > DESPAWN_RADIUS) {
        cop.officer.group.visible = false;
        scene.remove(cop.group);
        scene.remove(cop.officer.group);
        cars.splice(index, 1);
        continue;
      }
      driveCop(cop, dt, chaseTarget, { onFoot });
      if (cop.officer.health <= 0) {
        cop.officer.group.visible = false;
      }
      const officerDistance = updateOfficer(cop, dt, player, onFoot);
      cop.officerDistance = officerDistance;

      // A cruiser that runs into the player on foot hurts them.
      cop.ramCooldown = Math.max(0, cop.ramCooldown - dt);
      const distance = Math.hypot(cop.position.x - player.x, cop.position.z - player.z);
      if (onFoot && distance < 2.2 && cop.speed > 4 && cop.ramCooldown === 0) {
        cop.ramCooldown = 1.6;
        effects?.damagePlayer?.(7, 'car');
        effects?.shake?.(0.6);
      }
    }

    updateDecay(dt, player);
    updateFire(dt, player, onFoot);
    updateRoadblocks(dt, player, activeCar, onFoot, heading);
    updateHelicopter(dt, player);
    tryBust(dt, player, onFoot, activeCar);
  }

  /** A new run: nothing wanted, no response on the street, no officers. */
  function reset() {
    clearWanted();
    bustTimer = 0;
    spawnTimer = 0;
    blockTimer = 0;
    sightTimer = 0;
    elapsed = 0;
    wanted.lastCrime = null;
    if (helicopter) {
      helicopter.group.visible = false;
      heliBeam.visible = false;
      heliLamp.intensity = 0;
    }
  }

  return {
    step,
    crime,
    raise,
    setWanted,
    clearWanted,
    reset,
    forceBust,
    /** Anything a ray from the player can hit on the police side. */
    officers() {
      const list = [];
      for (const cop of cars) {
        if (cop.officer.group.visible) list.push(cop.officer);
      }
      return list;
    },
    damageCar(car, amount) {
      car.health = Math.max(0, (car.health ?? 100) - amount);
      return car.health;
    },
    /** A round or a fist on a dismounted officer. At zero the officer is out of the fight. */
    damageOfficer(officer, amount) {
      if (!officer || officer.health <= 0) return 0;
      officer.health = Math.max(0, officer.health - amount);
      if (officer.health === 0) officer.group.visible = false;
      return officer.health;
    },
    get wanted() {
      return wanted;
    },
    get level() {
      return wanted.level;
    },
    get cars() {
      return cars;
    },
    get roadblocks() {
      return roadblocks;
    },
    get busted() {
      return busted;
    },
    get helicopter() {
      return helicopter;
    },
    station: POLICE_STATION,
  };
}
