// Sidewalk life: two dozen stylised pedestrians, each a handful of boxes hanging off two hip
// and two shoulder pivots. Every pedestrian loops a circuit of the four corners of one city
// block, which keeps it on the pavement and off the road by construction. A honk or a crash
// within earshot makes the nearby ones break their circuit and run from the noise for a
// couple of seconds, arms up, before they settle back onto the block.
//
// Geometry is shared across every pedestrian and the colours come from four small palettes,
// so the whole crowd is about six draw calls each and one shadow caster per body.

import * as THREE from 'three';
import { CITY } from './city.js';
import { createRng } from './rng.js';

const WALK_SPEED = 1.45;
const RUN_SPEED = 4.6;
const TURN_RATE = 7;
const CORNER_RADIUS = 1.1;
const RING = CITY.blockInterior / 2 - 1.7; // 9.3 m from a block centre
const SCATTER_TIME = 2.6;

const SHIRTS = ['#e8694f', '#f0c455', '#4b9fd1', '#f4f1e7', '#5c6a73', '#3f8f77',
  '#d97ba6', '#e8792e', '#8a6bb5', '#b7c9a4', '#d9d2c4', '#2f8c8f'];
const SKIN = ['#b97a52', '#8d5a3b', '#e0b48f', '#6f4a31', '#c98d63'];
const PANTS = ['#2c3138', '#3d5a73', '#6b5b4a', '#4a4f57', '#7d8a94', '#37566b'];

/** Shared geometries, built once at module load (no per-pedestrian allocation). */
const GEO = {
  torso: new THREE.BoxGeometry(0.44, 0.56, 0.25),
  head: new THREE.BoxGeometry(0.25, 0.27, 0.25),
  arm: new THREE.BoxGeometry(0.12, 0.58, 0.13),
  leg: new THREE.BoxGeometry(0.16, 0.76, 0.18),
};
// The arm and leg boxes hang below their pivot.
GEO.arm.translate(0, -0.3, 0);
GEO.leg.translate(0, -0.4, 0);

const MATERIALS = new Map();
function material(hex) {
  let found = MATERIALS.get(hex);
  if (!found) {
    found = new THREE.MeshLambertMaterial({ color: hex });
    MATERIALS.set(hex, found);
  }
  return found;
}

export function createPedestrians(scene, city, options = {}) {
  const { count = 26, seed = 0x3ed5c0 } = options;
  const rng = createRng(seed);
  const peds = [];

  /** The four corners of the block whose centre is (cx, cz), clockwise from the west corner. */
  function circuit(cx, cz) {
    return [
      { x: cx - RING, z: cz - RING },
      { x: cx - RING, z: cz + RING },
      { x: cx + RING, z: cz + RING },
      { x: cx + RING, z: cz - RING },
    ];
  }

  function buildPed(index) {
    const group = new THREE.Group();
    group.name = `ped-${index}`;
    const shirt = SHIRTS[rng.int(0, SHIRTS.length - 1)];
    const skin = SKIN[rng.int(0, SKIN.length - 1)];
    const pants = PANTS[rng.int(0, PANTS.length - 1)];

    const torso = new THREE.Mesh(GEO.torso, material(shirt));
    torso.position.y = 1.24;
    torso.castShadow = true;
    const head = new THREE.Mesh(GEO.head, material(skin));
    head.position.y = 1.7;
    const armLeft = new THREE.Mesh(GEO.arm, material(skin));
    armLeft.position.set(-0.29, 1.48, 0);
    const armRight = new THREE.Mesh(GEO.arm, material(skin));
    armRight.position.set(0.29, 1.48, 0);
    const legLeft = new THREE.Mesh(GEO.leg, material(pants));
    legLeft.position.set(-0.12, 0.9, 0);
    const legRight = new THREE.Mesh(GEO.leg, material(pants));
    legRight.position.set(0.12, 0.9, 0);
    group.add(torso, head, armLeft, armRight, legLeft, legRight);
    scene.add(group);

    // The first few share the blocks around the spawn, so the opening street is alive; the
    // rest scatter across the city, keeping a wide berth from the spawn crossroads.
    let block = null;
    if (index < 8) {
      // The four blocks that ring the spawn crossroads, two or three people each.
      const near = city.blocks
        .filter(([x, z]) => Math.abs(x - city.spawn.x) < CITY.pitch * 1.1
          && Math.abs(z - city.spawn.z) < CITY.pitch * 1.1)
        .sort((a, b) => Math.hypot(a[0] - city.spawn.x, a[1] - city.spawn.z)
          - Math.hypot(b[0] - city.spawn.x, b[1] - city.spawn.z));
      block = near[index % Math.max(1, near.length)] ?? null;
    }
    for (let attempt = 0; !block && attempt < 40; attempt += 1) {
      const candidate = city.blocks[rng.int(0, city.blocks.length - 1)];
      if (Math.hypot(candidate[0] - city.spawn.x, candidate[1] - city.spawn.z) < 22) continue;
      block = candidate;
    }
    if (!block) block = city.blocks[rng.int(0, city.blocks.length - 1)];
    const corners = circuit(block[0], block[1]);
    const corner = rng.int(0, 3);
    const start = corners[corner];
    const along = rng.range(-RING + 2, RING - 2);

    return {
      group,
      parts: { torso, head, armLeft, armRight, legLeft, legRight },
      corners,
      target: corner,
      x: start.x,
      z: start.z + (corner % 2 === 0 ? along : -along) * 0.3,
      heading: rng.range(-Math.PI, Math.PI),
      phase: rng.range(0, Math.PI * 2),
      speed: WALK_SPEED * rng.range(0.82, 1.18),
      stride: rng.range(0, Math.PI * 2),
      scatter: 0,
      scatterX: 0,
      scatterZ: 0,
      blockX: block[0],
      blockZ: block[1],
      alive: true,
    };
  }

  for (let index = 0; index < count; index += 1) {
    const ped = buildPed(index);
    ped.group.position.set(ped.x, city.groundHeightAt(ped.x, ped.z), ped.z);
    ped.group.rotation.y = ped.heading;
    peds.push(ped);
  }

  /** Starts a run away from (x, z) for the pedestrians inside the radius. */
  function scatterFrom(x, z, radius) {
    for (const ped of peds) {
      const distance = Math.hypot(ped.x - x, ped.z - z);
      if (distance > radius) continue;
      let awayX = ped.x - x;
      let awayZ = ped.z - z;
      const length = Math.hypot(awayX, awayZ);
      if (length < 0.01) {
        awayX = 1;
        awayZ = 0;
      } else {
        awayX /= length;
        awayZ /= length;
      }
      // A little sideways jitter so the crowd does not move as one wall.
      const angle = rng.range(-0.7, 0.7);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ped.scatterX = awayX * cos - awayZ * sin;
      ped.scatterZ = awayX * sin + awayZ * cos;
      ped.scatter = SCATTER_TIME * rng.range(0.75, 1.2);
    }
  }

  /** Applies the traffic's honk/crash events; returns the number of people who scattered. */
  function reactTo(events) {
    let scattered = 0;
    for (const event of events) {
      if (event.type !== 'honk' && event.type !== 'crash') continue;
      // A car horn carries across the street; a crash carries further still.
      const radius = event.type === 'crash' ? event.radius ?? 24 : 26;
      scatterFrom(event.x, event.z, radius);
      scattered += 1;
    }
    return scattered;
  }

  function updatePed(ped, dt) {
    const scattering = ped.scatter > 0;
    let moveX = 0;
    let moveZ = 0;
    let speed;

    if (scattering) {
      ped.scatter = Math.max(0, ped.scatter - dt);
      moveX = ped.scatterX;
      moveZ = ped.scatterZ;
      speed = RUN_SPEED;
    } else {
      const target = ped.corners[ped.target];
      moveX = target.x - ped.x;
      moveZ = target.z - ped.z;
      const distance = Math.hypot(moveX, moveZ);
      if (distance < CORNER_RADIUS) {
        ped.target = (ped.target + 1) % 4;
        const next = ped.corners[ped.target];
        moveX = next.x - ped.x;
        moveZ = next.z - ped.z;
      }
      const length = Math.max(0.001, Math.hypot(moveX, moveZ));
      moveX /= length;
      moveZ /= length;
      speed = ped.speed;
    }

    ped.x += moveX * speed * dt;
    ped.z += moveZ * speed * dt;

    // Never leave the block's pavement: clamp to the ring square.
    const clampX = Math.min(ped.blockX + RING + 1.4, Math.max(ped.blockX - RING - 1.4, ped.x));
    const clampZ = Math.min(ped.blockZ + RING + 1.4, Math.max(ped.blockZ - RING - 1.4, ped.z));
    ped.x = clampX;
    ped.z = clampZ;

    // Face the way they move; a runner faces where they flee.
    const desiredHeading = Math.atan2(moveX, moveZ);
    let difference = desiredHeading - ped.heading;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    ped.heading += difference * (1 - Math.exp(-TURN_RATE * dt));

    // Limb swing, quicker when running.
    ped.stride += speed * dt * (scattering ? 2.6 : 3.4);
    const swing = Math.sin(ped.stride) * (scattering ? 0.95 : 0.55);
    ped.parts.legLeft.rotation.x = swing;
    ped.parts.legRight.rotation.x = -swing;
    ped.parts.armLeft.rotation.x = -swing * 0.8;
    ped.parts.armRight.rotation.x = swing * 0.8;
    if (scattering) {
      ped.parts.armLeft.rotation.z = 0.5;
      ped.parts.armRight.rotation.z = -0.5;
    } else {
      ped.parts.armLeft.rotation.z = 0.05;
      ped.parts.armRight.rotation.z = -0.05;
    }
    ped.parts.torso.rotation.z = Math.sin(ped.stride) * 0.035;

    const ground = city.groundHeightAt(ped.x, ped.z);
    ped.group.position.set(ped.x, ground, ped.z);
    ped.group.rotation.y = ped.heading;
  }

  function update(dt, events = []) {
    reactTo(events);
    for (const ped of peds) updatePed(ped, dt);
  }

  return {
    peds,
    update,
    scatterFrom,
    reactTo,
    get count() {
      return peds.length;
    },
    /** Positions at this instant, for tests and diagnostics. */
    snapshot() {
      return peds.map((ped) => ({ x: ped.x, z: ped.z, scatter: ped.scatter }));
    },
  };
}
