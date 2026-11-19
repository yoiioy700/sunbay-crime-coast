// The player character on foot: a stylised humanoid built from boxes and a sphere, tan skin,
// a sun-bleached vest, teal shorts and a red cap. Movement is camera-relative, Shift sprints,
// Space hops, gravity clamps the feet to the sidewalk height under them, and every building
// AABB pushes the body back out. Limbs swing with the stride; the shadow underfoot is a blob.

import * as THREE from 'three';

const WALK_SPEED = 4.6;
const SPRINT_SPEED = 8.6;
const ACCELERATION = 14;
const GRAVITY = 24;
const JUMP_SPEED = 7.2;
const RADIUS = 0.44;

const COLORS = {
  skin: '#b97a52',
  skinShade: '#a06a47',
  vest: '#f2ead8',
  shorts: '#2f7f86',
  cap: '#d9503c',
  shoes: '#2c3138',
  eyes: '#22262b',
  shadow: '#0b1a1f',
};

/** The walk cycle's phase drives the limbs; speedFactor eases the swing out as the body stops. */
function buildCharacter() {
  const group = new THREE.Group();
  const materials = {
    skin: new THREE.MeshLambertMaterial({ color: COLORS.skin }),
    skinShade: new THREE.MeshLambertMaterial({ color: COLORS.skinShade }),
    vest: new THREE.MeshLambertMaterial({ color: COLORS.vest }),
    shorts: new THREE.MeshLambertMaterial({ color: COLORS.shorts }),
    cap: new THREE.MeshLambertMaterial({ color: COLORS.cap }),
    shoes: new THREE.MeshLambertMaterial({ color: COLORS.shoes }),
    eyes: new THREE.MeshLambertMaterial({ color: COLORS.eyes }),
  };

  const box = (width, height, depth, material, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  };

  // Hips and torso, a vest over the skin.
  const hips = box(0.42, 0.2, 0.26, materials.shorts, 0, 0.9, 0);
  group.add(hips);
  const torso = box(0.5, 0.6, 0.29, materials.vest, 0, 1.31, 0);
  group.add(torso);
  const chest = box(0.52, 0.12, 0.31, materials.vest, 0, 1.53, 0);
  group.add(chest);
  const neck = box(0.14, 0.12, 0.14, materials.skinShade, 0, 1.66, 0);
  group.add(neck);

  // Head, cap crown and brim, eyes.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), materials.skin);
  head.position.set(0, 1.81, 0.01);
  head.castShadow = true;
  group.add(head);
  const capCrown = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), materials.cap);
  capCrown.position.set(0, 1.85, 0.005);
  capCrown.castShadow = true;
  group.add(capCrown);
  const brim = box(0.28, 0.04, 0.2, materials.cap, 0, 1.83, 0.2);
  group.add(brim);
  for (const side of [-1, 1]) {
    const eye = box(0.035, 0.045, 0.02, materials.eyes, side * 0.062, 1.82, 0.165);
    group.add(eye);
  }

  // Arms hang from shoulder pivots so they can swing.
  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.31, 1.55, 0);
    const upper = box(0.13, 0.36, 0.15, materials.skin, 0, -0.18, 0);
    const fore = box(0.12, 0.32, 0.14, materials.skin, 0, -0.52, 0.02);
    const hand = box(0.11, 0.12, 0.13, materials.skinShade, 0, -0.72, 0.03);
    pivot.add(upper, fore, hand);
    group.add(pivot);
    arms.push(pivot);
  }

  // Legs hang from hip pivots; shoes sit at the end.
  const legs = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.12, 0.88, 0);
    const thigh = box(0.17, 0.38, 0.19, materials.skin, 0, -0.2, 0);
    const shin = box(0.15, 0.36, 0.17, materials.skinShade, 0, -0.56, 0);
    const shoe = box(0.16, 0.1, 0.28, materials.shoes, 0, -0.78, 0.05);
    pivot.add(thigh, shin, shoe);
    group.add(pivot);
    legs.push(pivot);
  }

  // A soft blob shadow: a dark disc that follows the feet, cheaper than a second shadow map.
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 20),
    new THREE.MeshBasicMaterial({ color: COLORS.shadow, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  blob.renderOrder = 1;
  group.add(blob);

  return { group, arms, legs, torso, head, blob };
}

export function createPlayer(scene, city) {
  const character = buildCharacter();
  const group = character.group;
  scene.add(group);

  const position = new THREE.Vector3(city.spawn.x, 0, city.spawn.z);
  position.y = city.groundHeightAt(position.x, position.z);
  const velocity = new THREE.Vector3();
  const input = new THREE.Vector3();
  let heading = city.spawn.heading;
  let targetHeading = heading;
  let onGround = true;
  let stride = 0;
  let vertical = 0;
  let jumpQueued = false;

  group.position.copy(position);
  group.rotation.y = heading;

  /** Pushes the body out of every building it has entered, along the shallowest axis. */
  function pushOutOfBuildings() {
    for (const collider of city.colliders) {
      if (
        position.x > collider.minX - RADIUS &&
        position.x < collider.maxX + RADIUS &&
        position.z > collider.minZ - RADIUS &&
        position.z < collider.maxZ + RADIUS
      ) {
        const left = position.x - (collider.minX - RADIUS);
        const right = (collider.maxX + RADIUS) - position.x;
        const back = position.z - (collider.minZ - RADIUS);
        const front = (collider.maxZ + RADIUS) - position.z;
        const smallest = Math.min(left, right, back, front);
        if (smallest === left) position.x = collider.minX - RADIUS;
        else if (smallest === right) position.x = collider.maxX + RADIUS;
        else if (smallest === back) position.z = collider.minZ - RADIUS;
        else position.z = collider.maxZ + RADIUS;
      }
    }
  }

  /** A jump request, taken on the next update that finds the feet planted. */
  function jump() {
    jumpQueued = true;
  }

  function update(dt, cameraYaw, controls) {
    // Camera-relative movement: forward is where the camera looks, flattened.
    const forwardX = -Math.sin(cameraYaw);
    const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw);
    const rightZ = -Math.sin(cameraYaw);
    input.set(
      forwardX * controls.forward + rightX * controls.strafe,
      0,
      forwardZ * controls.forward + rightZ * controls.strafe,
    );
    if (input.lengthSq() > 1) input.normalize();

    const speed = controls.sprint ? SPRINT_SPEED : WALK_SPEED;
    const targetX = input.x * speed;
    const targetZ = input.z * speed;
    const blend = 1 - Math.exp(-ACCELERATION * dt);
    velocity.x += (targetX - velocity.x) * blend;
    velocity.z += (targetZ - velocity.z) * blend;

    position.x += velocity.x * dt;
    position.z += velocity.z * dt;
    pushOutOfBuildings();

    // The shoreline and the map rim stop the body; the sea is scenery, not a road.
    position.x = Math.min(city.bounds.maxX, Math.max(city.bounds.minX, position.x));
    position.z = Math.min(city.bounds.maxZ, Math.max(city.bounds.minZ, position.z));

    // Gravity, then the ground under the feet.
    const ground = city.groundHeightAt(position.x, position.z);
    if (jumpQueued && onGround) {
      vertical = JUMP_SPEED;
      onGround = false;
    }
    jumpQueued = false;
    vertical -= GRAVITY * dt;
    position.y += vertical * dt;
    if (position.y <= ground) {
      position.y = ground;
      vertical = 0;
      onGround = true;
    }
    if (position.y < ground) position.y = ground;

    // Face the way the body is travelling, easing around corners.
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    if (horizontalSpeed > 0.35) targetHeading = Math.atan2(velocity.x, velocity.z);
    let difference = targetHeading - heading;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    heading += difference * (1 - Math.exp(-16 * dt));

    // Stride: limbs swing with distance covered, torso bobs and leans into a sprint.
    const speedFactor = Math.min(1, horizontalSpeed / SPRINT_SPEED + 0.08);
    stride += horizontalSpeed * dt * 2.1;
    const swing = Math.sin(stride) * 0.72 * speedFactor;
    character.legs[0].rotation.x = swing;
    character.legs[1].rotation.x = -swing;
    character.arms[0].rotation.x = -swing * 0.75;
    character.arms[1].rotation.x = swing * 0.75;
    character.arms[0].rotation.z = 0.06;
    character.arms[1].rotation.z = -0.06;
    const bob = Math.abs(Math.sin(stride)) * 0.045 * speedFactor;
    character.torso.position.y = 1.31 + bob;
    character.torso.rotation.z = Math.sin(stride) * 0.05 * speedFactor;
    character.blob.position.y = 0.02;
    character.blob.material.opacity = onGround ? 0.28 : 0.16;

    group.position.copy(position);
    group.rotation.y = heading;
  }

  return {
    group,
    position,
    velocity,
    get heading() {
      return heading;
    },
    get onGround() {
      return onGround;
    },
    update,
    jump,
    /** Places the body (used when the run starts, so it never spawns mid-air). */
    reset(x, z, headingRadians) {
      position.set(x, city.groundHeightAt(x, z), z);
      velocity.set(0, 0, 0);
      vertical = 0;
      onGround = true;
      heading = headingRadians;
      targetHeading = headingRadians;
      group.position.copy(position);
      group.rotation.y = heading;
    },
  };
}
