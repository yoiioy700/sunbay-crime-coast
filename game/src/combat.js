// The player's own violence: a fist on F or the left mouse button, a pistol with a magazine
// and a reload on R. The punch is a short forward arc that finds the nearest pedestrian or
// dismounted officer in front of the body; the pistol is a hitscan ray down the camera's aim
// with a muzzle flash, a tracer and an impact spark. Hits on cars mark them as the player's
// crime and can set them alight; every shot scares the street.
//
// Nothing here draws its own HUD or decides a wanted level: it reports hits and the shots that
// mattered to main.js, which raises the crimes and feeds the HUD the ammo count.

import * as THREE from 'three';

const PUNCH_RANGE = 2.3;
const PUNCH_ARC = Math.PI * 0.4;
const PUNCH_DAMAGE = 34;
const PUNCH_COOLDOWN = 0.42;
const PUNCH_SCATTER = 14;

const GUN_RANGE = 46;
const GUN_DAMAGE = 52;
const GUN_COOLDOWN = 0.28;
const MAGAZINE = 12;
const RELOAD_TIME = 1.25;
const GUN_SPREAD = 0.012;

const scratchOrigin = new THREE.Vector3();
const scratchDirection = new THREE.Vector3();

/** The gun model in the player's right hand: a dark slide, a grip and a glint. */
function buildPistol() {
  const group = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: '#20262e' });
  const steel = new THREE.MeshLambertMaterial({ color: '#5a636e' });
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.34), steel);
  slide.position.set(0, 0.04, 0.1);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.11), dark);
  grip.position.set(0, -0.08, -0.02);
  grip.rotation.x = -0.28;
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), dark);
  muzzle.position.set(0, 0.04, 0.29);
  group.add(slide, grip, muzzle);
  group.visible = false;
  return { group, muzzle };
}

/**
 * Effects are handed in by main.js: `tracer(from, to, colour)`, `spark(x, y, z, colour)`,
 * `muzzle(worldMatrix)`, `shake(amount)` and `damagePlayer(amount)` live there so the visual
 * pool and the health economy have one owner.
 */
export function createCombat(scene, city, options = {}) {
  const {
    pedestrians, police, player, camera, follow, effects = {},
  } = options;

  const state = {
    ammo: MAGAZINE,
    magazine: MAGAZINE,
    reserve: 48,
    health: 100,
    gunOut: true,
    punchCooldown: 0,
    fireCooldown: 0,
    reloadTimer: 0,
    punching: 0,
    triggerHeld: false,
    lastShotAt: -10,
  };
  let elapsed = 0;
  let pistol = null;

  function attachGun() {
    if (pistol) return pistol;
    pistol = buildPistol();
    player.group.add(pistol.group);
    pistol.group.position.set(0.3, 1.34, 0.22);
    pistol.group.rotation.set(0, 0, 0.06);
    return pistol;
  }

  /** The world-space eye and aim: the camera looks where the shots go. */
  function aimRay() {
    camera.getWorldPosition(scratchOrigin);
    camera.getWorldDirection(scratchDirection);
    // Start the ray a little ahead of the camera, at shoulder height.
    scratchOrigin.addScaledVector(scratchDirection, 0.6);
    return { origin: scratchOrigin, direction: scratchDirection };
  }

  /**
   * The first thing the ray meets: a car body (a slab test against the car's footprint), a
   * standing pedestrian, a dismounted officer, or the ground plane. Returns { kind, point }.
   */
  function raycast(origin, direction) {
    let best = { kind: 'air', distance: GUN_RANGE, point: null };
    const consider = (distance, kind, target) => {
      if (distance > 0.4 && distance < best.distance) best = { kind, distance, target };
    };

    // Cars: the player's car, traffic and police cruisers.
    for (const car of allCars()) {
      const plate = intersectCar(origin, direction, car);
      if (plate) consider(plate, car.cop ? 'policeCar' : 'car', car);
    }
    for (const ped of pedestrians.peds) {
      if (ped.down > 0) continue;
      const torsoY = city.groundHeightAt(ped.x, ped.z) + 1.15;
      const hit = intersectSphere(origin, direction, ped.x, torsoY, ped.z, 0.5);
      if (hit) consider(hit, 'pedestrian', ped);
    }
    if (police) {
      for (const officer of police.officers()) {
        const hit = intersectSphere(origin, direction, officer.x, 1.15, officer.z, 0.5);
        if (hit) consider(hit, 'officer', officer);
      }
    }
    // The ground, so a shot into the asphalt throws a spark.
    if (direction.y < -0.02) {
      const distance = (0.05 - origin.y) / direction.y;
      if (distance > 0 && distance < best.distance) best = { kind: 'ground', distance };
    }
    const point = origin.clone().addScaledVector(direction, best.distance);
    best.point = point;
    return best;
  }

  // main.js passes either the ambient pool or a function that returns it, so a stolen car
  // and a respawned traffic car are both seen without a second registration.
  let carSource = options.cars ?? [];

  function setCars(cars) {
    carSource = cars;
  }

  function allCars() {
    const ambient = typeof carSource === 'function' ? carSource() : carSource;
    const list = ambient ? [...ambient] : [];
    if (police) for (const car of police.cars) list.push(car);
    return list;
  }

  /** Slab test of the ray against a car's footprint box; returns the entry distance or 0. */
  function intersectCar(origin, direction, car) {
    const halfW = car.halfWidth + 0.25;
    const halfL = car.halfLength + 0.25;
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    const relX = origin.x - car.position.x;
    const relZ = origin.z - car.position.z;
    // Into the car's local frame (forward is +Z, right is +X).
    const localX = relX * cos - relZ * sin;
    const localZ = relX * sin + relZ * cos;
    const dirX = direction.x * cos - direction.z * sin;
    const dirZ = direction.x * sin + direction.z * cos;
    const y0 = origin.y;
    let tMin = 0;
    let tMax = GUN_RANGE;
    const slab = (start, delta, min, max) => {
      if (Math.abs(delta) < 1e-6) return start >= min && start <= max;
      let near = (min - start) / delta;
      let far = (max - start) / delta;
      if (near > far) [near, far] = [far, near];
      tMin = Math.max(tMin, near);
      tMax = Math.min(tMax, far);
      return tMin <= tMax;
    };
    if (!slab(localX, dirX, -halfW, halfW)) return 0;
    if (!slab(localZ, dirZ, -halfL, halfL)) return 0;
    if (!slab(y0, direction.y, 0.25, 1.6)) return 0;
    return tMin > 0 ? tMin : (tMax > 0 ? 0.001 : 0);
  }

  /** A ray against a sphere; returns the entry distance or 0. */
  function intersectSphere(origin, direction, x, y, z, radius) {
    const ox = origin.x - x;
    const oy = origin.y - y;
    const oz = origin.z - z;
    const b = ox * direction.x + oy * direction.y + oz * direction.z;
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return 0;
    const root = Math.sqrt(discriminant);
    const near = -b - root;
    if (near > 0) return near;
    const far = -b + root;
    return far > 0 ? far : 0;
  }

  /** Fires the pistol at the camera's aim. Returns true when a round left the barrel. */
  function fire(fromPlayer = true) {
    if (state.reloadTimer > 0 || state.ammo <= 0 || state.fireCooldown > 0) {
      if (state.ammo <= 0 && state.reloadTimer <= 0) reload();
      return false;
    }
    state.ammo -= 1;
    state.fireCooldown = GUN_COOLDOWN;
    state.lastShotAt = elapsed;
    const { origin, direction } = aimRay();
    // A little spread, seeded by the shot's own time so replays are not identical.
    direction.x += (Math.random() - 0.5) * GUN_SPREAD;
    direction.y += (Math.random() - 0.5) * GUN_SPREAD;
    direction.z += (Math.random() - 0.5) * GUN_SPREAD;
    direction.normalize();

    const hit = raycast(origin, direction);
    const muzzle = attachGun();
    muzzle.group.visible = state.gunOut;
    // Muzzle flash at the barrel tip.
    muzzle.group.updateMatrixWorld();
    const flashFrom = new THREE.Vector3(0, 0.04, 0.34).applyMatrix4(muzzle.group.matrixWorld);
    effects.muzzle?.(flashFrom);
    effects.tracer?.(flashFrom, hit.point, '#ffe6a8');
    effects.shake?.(0.22);
    if (fromPlayer) effects.onShot?.(hit);

    if (hit.kind === 'pedestrian') {
      pedestrians.hit(hit.target, GUN_DAMAGE, player.position.x, player.position.z, PUNCH_SCATTER);
      effects.spark?.(hit.point.x, hit.point.y, hit.point.z, '#ff6a52');
      effects.onHit?.('pedestrian', hit.target, GUN_DAMAGE);
    } else if (hit.kind === 'officer') {
      police?.damageOfficer(hit.target, GUN_DAMAGE);
      effects.spark?.(hit.point.x, hit.point.y, hit.point.z, '#ffb36a');
      effects.onHit?.('officer', hit.target, GUN_DAMAGE);
    } else if (hit.kind === 'car' || hit.kind === 'policeCar') {
      effects.spark?.(hit.point.x, hit.point.y, hit.point.z, '#ffd27a');
      effects.onHit?.(hit.kind, hit.target, GUN_DAMAGE);
    } else {
      effects.spark?.(hit.point.x, hit.point.y, hit.point.z, '#d8d2c0');
    }
    return true;
  }

  /** F: a short arc in front of the body; the nearest person in it takes the hit. */
  function punch() {
    if (state.punchCooldown > 0 || state.reloadTimer > 0) return false;
    state.punchCooldown = PUNCH_COOLDOWN;
    state.punching = 0.3;
    effects.shake?.(0.12);
    const heading = player.heading;
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    let best = null;
    let bestDistance = PUNCH_RANGE;
    const consider = (x, z, kind, target) => {
      const dx = x - player.position.x;
      const dz = z - player.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > bestDistance) return;
      const dot = (dx * forwardX + dz * forwardZ) / Math.max(0.001, distance);
      if (distance > 0.6 && dot < Math.cos(PUNCH_ARC)) return;
      best = { kind, target, distance };
      bestDistance = distance;
    };
    for (const ped of pedestrians.peds) {
      if (ped.down <= 0) consider(ped.x, ped.z, 'pedestrian', ped);
    }
    if (police) {
      for (const officer of police.officers()) consider(officer.x, officer.z, 'officer', officer);
    }
    if (best && best.kind === 'pedestrian') {
      pedestrians.hit(best.target, PUNCH_DAMAGE, player.position.x, player.position.z, PUNCH_SCATTER);
      effects.onHit?.('pedestrian', best.target, PUNCH_DAMAGE);
      effects.shake?.(0.2);
    } else if (best && best.kind === 'officer') {
      police.damageOfficer(best.target, PUNCH_DAMAGE);
      effects.onHit?.('officer', best.target, PUNCH_DAMAGE);
      effects.shake?.(0.2);
    } else {
      // A swing at nothing still scatters whoever watched it.
      pedestrians.scatterFrom(player.position.x + forwardX * 1.5, player.position.z + forwardZ * 1.5, 6);
    }
    return true;
  }

  function reload() {
    if (state.reloadTimer > 0 || state.ammo === state.magazine || state.reserve <= 0) return false;
    state.reloadTimer = RELOAD_TIME;
    return true;
  }

  function finishReload() {
    const needed = state.magazine - state.ammo;
    const taken = Math.min(needed, state.reserve);
    state.ammo += taken;
    state.reserve -= taken;
  }

  /** Called by main.js with the frame clock; the trigger repeats while held. */
  function update(dt, { firing = false } = {}) {
    elapsed += dt;
    state.punchCooldown = Math.max(0, state.punchCooldown - dt);
    state.fireCooldown = Math.max(0, state.fireCooldown - dt);
    state.punching = Math.max(0, state.punching - dt);
    if (state.reloadTimer > 0) {
      state.reloadTimer -= dt;
      if (state.reloadTimer <= 0) {
        state.reloadTimer = 0;
        finishReload();
      }
    }
    if (firing) fire();
    // The arm and gun: a punch throws the right arm forward; the gun shows only on foot.
    const gun = attachGun();
    gun.group.visible = state.gunOut;
    if (state.punching > 0) {
      const swing = 1 - state.punching / 0.3;
      player.group.rotation.x = -Math.sin(swing * Math.PI) * 0.12;
    } else {
      player.group.rotation.x = 0;
    }
    gun.group.position.set(0.3, 1.34, 0.22 + (state.punching > 0 ? -0.12 : 0));
  }

  /** A new run or a respawn: full health, a full magazine, no wound state. */
  function reset() {
    state.health = 100;
    state.ammo = MAGAZINE;
    state.reserve = 48;
    state.reloadTimer = 0;
    state.fireCooldown = 0;
    state.punchCooldown = 0;
    state.punching = 0;
    if (pistol) pistol.group.visible = true;
  }

  function givePistol() {
    state.gunOut = true;
    attachGun().group.visible = true;
    return state.ammo;
  }

  /** Damage from any source; returns the health left. main.js watches for zero. */
  function damage(amount) {
    state.health = Math.max(0, state.health - amount);
    return state.health;
  }

  return {
    state,
    update,
    fire,
    punch,
    reload,
    reset,
    givePistol,
    damage,
    setAmmo(ammo, reserve) {
      state.ammo = Math.max(0, Math.min(MAGAZINE, Math.floor(ammo)));
      if (reserve !== undefined) state.reserve = Math.max(0, Math.floor(reserve));
      return state.ammo;
    },
    setCars,
    get health() {
      return state.health;
    },
    get ammo() {
      return state.ammo;
    },
    get reloading() {
      return state.reloadTimer > 0;
    },
    get pistol() {
      return pistol;
    },
  };
}
