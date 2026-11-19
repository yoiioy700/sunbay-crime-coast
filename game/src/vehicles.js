// Cars: four body styles built from a dozen boxes each, merged into two meshes (a tinted body
// and a shared trim mesh with baked glass, tyres, bumpers and lamps), so a whole street of
// traffic costs two draw calls a car. The driving model is arcade, not a simulator: throttle,
// brake and reverse on W/S, speed-sensitive steering on A/D, a handbrake on Space that drops
// lateral grip so the tail slides, and drag plus a surface multiplier that slows the car on
// grass and sand. Buildings push the chassis back out.
//
// The same car object is used by traffic.js: it holds a group, a position, a heading and a
// velocity, so a traffic car can become the player's car without being rebuilt.

import * as THREE from 'three';
import { CITY } from './city.js';

/** Body styles. `maxSpeed` is m/s, dimensions are metres, nose points along local +Z. */
export const CAR_TYPES = {
  sedan: {
    label: 'Sedan',
    width: 1.9,
    length: 4.35,
    wheelbase: 2.7,
    maxSpeed: 33,
    maxReverse: 9,
    acceleration: 11.5,
    brake: 24,
    steer: 0.62,
    grip: 13,
    mass: 1,
  },
  sports: {
    label: 'Sports',
    width: 1.96,
    length: 4.2,
    wheelbase: 2.55,
    maxSpeed: 43,
    maxReverse: 8,
    acceleration: 18,
    brake: 28,
    steer: 0.58,
    grip: 15,
    mass: 0.92,
  },
  van: {
    label: 'Van',
    width: 2.02,
    length: 5.1,
    wheelbase: 3.15,
    maxSpeed: 25,
    maxReverse: 8,
    acceleration: 8.5,
    brake: 20,
    steer: 0.54,
    grip: 11,
    mass: 1.3,
  },
  pickup: {
    label: 'Pickup',
    width: 1.98,
    length: 5.05,
    wheelbase: 3.05,
    maxSpeed: 29,
    maxReverse: 9,
    acceleration: 10.5,
    brake: 22,
    steer: 0.56,
    grip: 12,
    mass: 1.15,
  },
};

export const CAR_TYPE_NAMES = Object.keys(CAR_TYPES);

export const CAR_COLORS = [
  '#d8452f', '#e8b13f', '#3f86c4', '#f2efe6', '#5c6a73', '#3f8f77',
  '#c46f9b', '#e06f2c', '#8f4b3a', '#2f4a63', '#b9c2c9', '#6d8a4c',
];

const TRIM = {
  glass: '#415d69',
  glassDark: '#2c3f48',
  tyre: '#191d22',
  rim: '#aeb5bd',
  bumper: '#4a5058',
  grille: '#252a30',
  headlight: '#fff0bf',
  taillight: '#d63a2e',
  plate: '#ded7c4',
};

/** A merge builder like city.js's: boxes in, one BufferGeometry out. */
function createBuilder() {
  const positions = [];
  const normals = [];
  const colors = [];
  const normalMatrix = new THREE.Matrix3();
  const vector = new THREE.Vector3();

  return {
    add(geometry, matrix, color) {
      const source = geometry.index ? geometry.toNonIndexed() : geometry;
      const position = source.attributes.position;
      const normal = source.attributes.normal;
      normalMatrix.getNormalMatrix(matrix);
      for (let index = 0; index < position.count; index += 1) {
        vector.fromBufferAttribute(position, index).applyMatrix4(matrix);
        positions.push(vector.x, vector.y, vector.z);
        vector.fromBufferAttribute(normal, index).applyMatrix3(normalMatrix).normalize();
        normals.push(vector.x, vector.y, vector.z);
        colors.push(color.r, color.g, color.b);
      }
      if (source !== geometry) source.dispose();
    },
    /** A box of `size`, centred at `at`, optionally spun about Z (wheels) or X. */
    box(size, at, color, rotation) {
      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      if (rotation && rotation[0]) geometry.rotateX(rotation[0]);
      if (rotation && rotation[1]) geometry.rotateY(rotation[1]);
      if (rotation && rotation[2]) geometry.rotateZ(rotation[2]);
      geometry.translate(at[0], at[1], at[2]);
      this.add(geometry, new THREE.Matrix4(), color);
      geometry.dispose();
    },
    wheel(radius, width, at, color) {
      const geometry = new THREE.CylinderGeometry(radius, radius, width, 9);
      geometry.rotateZ(Math.PI / 2);
      geometry.translate(at[0], at[1], at[2]);
      this.add(geometry, new THREE.Matrix4(), color);
      geometry.dispose();
    },
    build(withColor) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      if (withColor) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();
      return geometry;
    },
  };
}

/** The body shell only: chassis, cabin, hood or cargo box. Vertex-coloured white, tinted by
 *  the per-car material. */
function buildBody(type) {
  const body = createBuilder();
  const white = new THREE.Color('#ffffff');
  const { width: w, length: l } = CAR_TYPES[type];
  const halfW = w / 2;
  const halfL = l / 2;

  if (type === 'sedan') {
    body.box([w, 0.52, l], [0, 0.58, 0], white);
    body.box([w * 0.95, 0.24, l * 0.3], [0, 0.86, halfL * 0.63], white);
    body.box([w * 0.95, 0.22, l * 0.22], [0, 0.84, -halfL * 0.78], white);
    body.box([w * 0.86, 0.52, l * 0.46], [0, 1.06, -l * 0.06], white);
    body.box([w * 0.7, 0.1, l * 0.34], [0, 1.33, -l * 0.08], white);
  } else if (type === 'sports') {
    body.box([w, 0.4, l], [0, 0.5, 0], white);
    body.box([w * 0.94, 0.2, l * 0.38], [0, 0.72, halfL * 0.58], white);
    body.box([w * 0.84, 0.38, l * 0.36], [0, 0.9, -l * 0.04], white);
    body.box([w * 0.88, 0.08, l * 0.5], [0, 1.11, -l * 0.06], white);
    body.box([w * 0.98, 0.1, 0.36], [0, 0.72, -halfL + 0.16], white);
  } else if (type === 'van') {
    body.box([w, 0.6, l], [0, 0.68, 0], white);
    body.box([w * 0.98, 1.05, l * 0.72], [0, 1.26, -l * 0.12], white);
    body.box([w * 0.9, 0.3, l * 0.2], [0, 0.98, halfL * 0.72], white);
    body.box([w * 0.94, 0.44, l * 0.18], [0, 1.1, halfL * 0.4], white);
    body.box([w * 0.98, 0.12, l * 0.74], [0, 1.82, -l * 0.12], white);
  } else {
    const bedLength = l * 0.42;
    body.box([w, 0.5, l * 0.98], [0, 0.6, 0], white);
    body.box([w * 0.96, 0.34, l * 0.27], [0, 0.9, halfL * 0.68], white);
    body.box([w * 0.9, 0.66, l * 0.34], [0, 1.16, halfL * 0.1], white);
    body.box([w * 0.9, 0.08, l * 0.3], [0, 1.5, halfL * 0.1], white);
    // Bed walls.
    body.box([0.12, 0.42, bedLength], [-halfW + 0.08, 0.96, -l * 0.22], white);
    body.box([0.12, 0.42, bedLength], [halfW - 0.08, 0.96, -l * 0.22], white);
    body.box([w, 0.42, 0.12], [0, 0.96, -halfL + 0.08], white);
  }
  return body.build(false);
}

/** Glass, lamps, bumpers, grille, tyres and rims: one mesh, colours baked in. */
function buildTrim(type) {
  const trim = createBuilder();
  const colors = {};
  for (const [name, hex] of Object.entries(TRIM)) colors[name] = new THREE.Color(hex);
  const { width: w, length: l, wheelbase } = CAR_TYPES[type];
  const halfW = w / 2;
  const halfL = l / 2;
  const wheelY = 0.36;
  const wheelRadius = type === 'van' ? 0.4 : 0.35;
  const wheelZ = wheelbase / 2;
  const wheelX = halfW - 0.03;

  // Glass band. The body's cabin sits a little inside the shell.
  if (type === 'van') {
    trim.box([w * 0.96, 0.42, l * 0.5], [0, 1.42, -l * 0.04], colors.glass);
    trim.box([w * 0.92, 0.34, 0.08], [0, 1.4, -halfL * 0.74], colors.glassDark);
  } else if (type === 'sports') {
    trim.box([w * 0.8, 0.3, l * 0.33], [0, 0.98, -l * 0.03], colors.glass);
  } else if (type === 'pickup') {
    trim.box([w * 0.86, 0.32, l * 0.28], [0, 1.3, halfL * 0.08], colors.glass);
  } else {
    trim.box([w * 0.82, 0.32, l * 0.42], [0, 1.17, -l * 0.06], colors.glassDark);
  }

  // Bumpers and grille.
  trim.box([w * 1.01, 0.18, 0.2], [0, 0.44, halfL - 0.05], colors.bumper);
  trim.box([w * 1.01, 0.18, 0.2], [0, 0.44, -halfL + 0.05], colors.bumper);
  trim.box([w * 0.44, 0.18, 0.08], [0, 0.72, halfL + 0.015], colors.grille);
  trim.box([0.52, 0.13, 0.04], [0, 0.5, -halfL - 0.01], colors.plate);

  // Lights.
  trim.box([0.4, 0.14, 0.07], [-halfW + 0.32, 0.79, halfL - 0.01], colors.headlight);
  trim.box([0.4, 0.14, 0.07], [halfW - 0.32, 0.79, halfL - 0.01], colors.headlight);
  trim.box([0.36, 0.13, 0.07], [-halfW + 0.3, 0.8, -halfL + 0.01], colors.taillight);
  trim.box([0.36, 0.13, 0.07], [halfW - 0.3, 0.8, -halfL + 0.01], colors.taillight);

  // Mirrors.
  trim.box([0.1, 0.1, 0.16], [-halfW - 0.06, 1.03, l * 0.22], colors.glassDark);
  trim.box([0.1, 0.1, 0.16], [halfW + 0.06, 1.03, l * 0.22], colors.glassDark);

  // Wheels: dark tyre with a lighter rim face on each side.
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const x = side * wheelX;
      const z = end * wheelZ;
      trim.wheel(wheelRadius, 0.26, [x, wheelY, z], colors.tyre);
      trim.wheel(wheelRadius * 0.52, 0.27, [x, wheelY, z], colors.rim);
    }
  }

  return trim.build(true);
}

const BODY_GEOMETRY = new Map();
const TRIM_GEOMETRY = new Map();
const BODY_MATERIALS = new Map();
let trimMaterial = null;

function bodyMaterial(hex) {
  let material = BODY_MATERIALS.get(hex);
  if (!material) {
    material = new THREE.MeshLambertMaterial({ color: hex });
    BODY_MATERIALS.set(hex, material);
  }
  return material;
}

function geometryFor(type) {
  if (!BODY_GEOMETRY.has(type)) {
    BODY_GEOMETRY.set(type, buildBody(type));
    TRIM_GEOMETRY.set(type, buildTrim(type));
  }
  if (!trimMaterial) trimMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  return { body: BODY_GEOMETRY.get(type), trim: TRIM_GEOMETRY.get(type) };
}

/** True when (x, z) is on the asphalt of the road grid (within the perimeter). */
export function onRoad(x, z) {
  const { halfSpan, pitch, roadWidth, gridLines } = CITY;
  const roadHalf = roadWidth / 2;
  const lineOf = (value) => {
    const index = Math.max(0, Math.min(gridLines - 1, Math.round((value + halfSpan) / pitch)));
    return -halfSpan + index * pitch;
  };
  const xOnAvenue = Math.abs(x - lineOf(x)) <= roadHalf && Math.abs(z) <= halfSpan + 0.5;
  const zOnCross = Math.abs(z - lineOf(z)) <= roadHalf && Math.abs(x) <= halfSpan + 0.5;
  return xOnAvenue || zOnCross;
}

/** 1 on asphalt, lower on park grass and beach sand, slightly lower still on pavement. */
export function surfaceGrip(city, x, z) {
  if (onRoad(x, z)) return 1;
  if (x > CITY.beachStartX - 0.6) return 0.46;
  for (const [parkX, parkZ] of city.parks) {
    if (Math.abs(x - parkX) < 11.4 && Math.abs(z - parkZ) < 11.4) return 0.5;
  }
  return 0.62;
}

let nextCarId = 1;

/**
 * One car: its meshes, its pose and the scratch it needs to drive. `position` is the group's
 * position, so anything holding the car sees it move.
 */
export function createCar(scene, city, { type = 'sedan', color = CAR_COLORS[0], x = 0, z = 0, heading = 0 } = {}) {
  const spec = CAR_TYPES[type] ?? CAR_TYPES.sedan;
  const { body, trim } = geometryFor(type);
  const group = new THREE.Group();
  group.name = `car-${nextCarId}`;
  const bodyMesh = new THREE.Mesh(body, bodyMaterial(color));
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  const trimMesh = new THREE.Mesh(trim, trimMaterial);
  trimMesh.castShadow = true;
  group.add(bodyMesh, trimMesh);
  group.position.set(x, 0, z);
  group.rotation.y = heading;
  scene.add(group);

  return {
    id: nextCarId++,
    type,
    spec,
    color,
    group,
    position: group.position,
    velocity: new THREE.Vector3(),
    heading,
    speed: 0,
    steer: 0,
    driver: false,
    stolen: false,
    /** Traffic fills these in; a driven car ignores them. */
    ai: null,
    halfWidth: spec.width / 2,
    halfLength: spec.length / 2,
  };
}

/** Circle-vs-AABB push-out against every building, then a speed penalty for the scrape. */
function pushOutOfBuildings(car, city) {
  const radius = car.halfWidth + 0.28;
  let hit = false;
  for (const collider of city.colliders) {
    const { position } = car;
    if (
      position.x > collider.minX - radius &&
      position.x < collider.maxX + radius &&
      position.z > collider.minZ - radius &&
      position.z < collider.maxZ + radius
    ) {
      const left = position.x - (collider.minX - radius);
      const right = (collider.maxX + radius) - position.x;
      const back = position.z - (collider.minZ - radius);
      const front = (collider.maxZ + radius) - position.z;
      const smallest = Math.min(left, right, back, front);
      if (smallest === left) position.x = collider.minX - radius;
      else if (smallest === right) position.x = collider.maxX + radius;
      else if (smallest === back) position.z = collider.minZ - radius;
      else position.z = collider.maxZ + radius;
      hit = true;
    }
  }
  if (hit) {
    car.velocity.multiplyScalar(0.35);
    car.speed *= 0.35;
  }
  return hit;
}

const scratchForward = new THREE.Vector3();
const scratchRight = new THREE.Vector3();

/**
 * Arcade car physics for one step. `controls` is { throttle, steer, handbrake } with throttle
 * and steer in [-1, 1]. Steering turns right for positive input; reverse flips it.
 */
export function stepCar(car, dt, controls, city) {
  const spec = car.spec;
  const heading = car.heading;
  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightZ = -Math.sin(heading);

  let forwardSpeed = car.velocity.x * forwardX + car.velocity.z * forwardZ;
  let lateralSpeed = car.velocity.x * rightX + car.velocity.z * rightZ;

  const grip = surfaceGrip(city, car.position.x, car.position.z);
  const throttle = controls.throttle ?? 0;
  const handbrake = Boolean(controls.handbrake);

  if (throttle > 0) {
    if (forwardSpeed < -0.4) {
      forwardSpeed += spec.brake * dt;
    } else {
      forwardSpeed += spec.acceleration * throttle * grip * dt;
    }
  } else if (throttle < 0) {
    if (forwardSpeed > 0.4) {
      forwardSpeed += spec.brake * throttle * dt;
    } else {
      forwardSpeed += spec.acceleration * 0.62 * throttle * grip * dt;
    }
  }

  // Drag and rolling resistance, and the handbrake's own bite on forward motion.
  forwardSpeed *= Math.exp(-(0.12 + (handbrake ? 1.9 : 0)) * dt);
  const rolling = (0.85 + (1 - grip) * 1.6) * dt;
  if (Math.abs(forwardSpeed) < rolling) forwardSpeed = 0;
  else forwardSpeed -= Math.sign(forwardSpeed) * rolling;

  const topSpeed = spec.maxSpeed * grip;
  const reverseTop = spec.maxReverse * grip;
  forwardSpeed = Math.min(topSpeed, Math.max(-reverseTop, forwardSpeed));

  // Steering: less lock at speed, none at a standstill, mirrored in reverse.
  const steerInput = Math.max(-1, Math.min(1, controls.steer ?? 0));
  const speedRatio = Math.min(1, Math.abs(forwardSpeed) / spec.maxSpeed);
  const lock = spec.steer * (1 - 0.45 * speedRatio);
  // At a crawl the wheel turns tighter; on the spot it does not turn the car at all.
  const lowSpeedBoost = 1 + 0.9 * Math.max(0, 1 - speedRatio * 3.2);
  const targetSteer = steerInput * lock * lowSpeedBoost;
  car.steer += (targetSteer - car.steer) * (1 - Math.exp(-10 * dt));
  if (Math.abs(forwardSpeed) > 0.15) {
    // A bicycle model would spin the car at speed; clamp the yaw rate to what a tyre could
    // actually hold, so a fast car carves a wide arc and a slow one turns in a tight circle.
    let yawRate = (forwardSpeed / spec.wheelbase) * Math.tan(car.steer);
    const limit = 2.2 - 1.15 * speedRatio;
    yawRate = Math.max(-limit, Math.min(limit, yawRate));
    car.heading += yawRate * dt;
  }

  // Lateral grip: strong normally, loose under the handbrake, so the car slides.
  const lateralDamping = handbrake ? 1.6 : spec.grip;
  lateralSpeed *= Math.exp(-lateralDamping * dt);

  car.velocity.set(
    forwardX * forwardSpeed + rightX * lateralSpeed,
    0,
    forwardZ * forwardSpeed + rightZ * lateralSpeed,
  );

  car.position.x += car.velocity.x * dt;
  car.position.z += car.velocity.z * dt;
  const wallContact = pushOutOfBuildings(car, city);

  const { bounds } = city;
  car.position.x = Math.min(bounds.maxX, Math.max(bounds.minX, car.position.x));
  car.position.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, car.position.z));
  if (car.position.x === bounds.maxX || car.position.x === bounds.minX) car.velocity.x *= -0.2;
  if (car.position.z === bounds.maxZ || car.position.z === bounds.minZ) car.velocity.z *= -0.2;

  car.speed = Math.abs(forwardSpeed);
  car.group.position.copy(car.position);
  car.group.rotation.y = car.heading;

  // A wall stops the car rather than letting it grind: a push-out that leaves the chassis
  // mostly still in the collider's face means the nose is buried, so cut the forward speed.
  if (wallContact) {
    const into = car.velocity.x * Math.sin(car.heading) + car.velocity.z * Math.cos(car.heading);
    void into;
    forwardSpeed *= 0.2;
  }
  return car.speed;
}

/** Opens the driver's door: a point on the left flank, clear of the car's own body. */
export function exitPoint(car) {
  const offset = new THREE.Vector3(-car.halfWidth - 0.75, 0, 0.35);
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), car.heading);
  return { x: car.position.x + offset.x, z: car.position.z + offset.z };
}

/**
 * The player's car ownership: at most one active car, plus any cars previously stolen and
 * left parked. Traffic cars are not rebuilt when stolen; their object is adopted here.
 */
export function createVehicles(scene, city, options = {}) {
  const { onStolen = null } = options;
  const owned = [];
  let active = null;

  /** Adopts a car (traffic or new) as the player's and starts driving it. The first time a
   *  car is taken it is a theft, and `onStolen` raises the crime with the police. */
  function enter(car) {
    if (!car || active) return false;
    const firstTheft = !car.playerOwned;
    active = car;
    car.driver = true;
    car.stolen = true;
    car.playerOwned = true;
    car.ai = null;
    car.speed = 0;
    if (firstTheft) onStolen?.(car);
    return true;
  }

  /** Steps out; the car stays where it stopped and remains enterable. */
  function exit() {
    if (!active) return null;
    const car = active;
    car.driver = false;
    car.velocity.set(0, 0, 0);
    car.speed = 0;
    car.steer = 0;
    if (!owned.includes(car)) owned.push(car);
    active = null;
    return car;
  }

  function update(dt, controls) {
    if (!active) return;
    stepCar(active, dt, controls, city);
  }

  /** Every car the player could walk up to: parked-owned plus the traffic pool. */
  function candidatesFrom(trafficCars) {
    return [...trafficCars, ...owned, ...(active ? [active] : [])];
  }

  /** The nearest enterable car to `point` (traffic list included), within `radius`. */
  function nearest(point, candidates, radius = 3.6) {
    let best = null;
    let bestDistance = radius;
    for (const car of candidates) {
      if (car.driver) continue;
      const distance = Math.hypot(car.position.x - point.x, car.position.z - point.z);
      if (distance < bestDistance) {
        best = car;
        bestDistance = distance;
      }
    }
    return best ? { car: best, distance: bestDistance } : null;
  }

  return {
    cars: owned,
    get active() {
      return active;
    },
    enter,
    exit,
    update,
    nearest,
    candidatesFrom,
    createCar: (options) => createCar(scene, city, options),
    allCars: () => [...owned, ...(active ? [active] : [])],
  };
}
