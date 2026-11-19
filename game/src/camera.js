// A third-person follow camera with two poses. On foot the body's shoulders are the pivot,
// the mouse orbits around them under pointer lock, the wheel pulls in and out, and both the
// focus point and the rig ease toward their targets so a sprint never shakes the frame. In a
// car the rig swings behind the bonnet, widens the field of view and pulls back with speed,
// and the mouse only looks around: let go of the wheel and it settles back behind the car.
//
// Yaw 0 looks down -Z, which is also the convention player.js reads for camera-relative
// movement, and the convention vehicles.js uses for the car's forward.

import * as THREE from 'three';

const DEFAULTS = {
  yaw: -Math.PI / 2,
  pitch: 0.2,
  distance: 6.4,
  minDistance: 2.8,
  maxDistance: 11,
  minPitch: -0.32,
  maxPitch: 1.02,
  sensitivity: 0.0023,
  /** Camera sits a little to the right of the body, over its shoulder. */
  shoulder: 0.55,
  /** Eye height above the feet that the rig orbits. */
  focusHeight: 1.42,
  /** Car pose: focus above the road, base distance, FOV range. */
  carFocusHeight: 1.05,
  carDistance: 8.4,
  carMaxDistance: 13,
  carFov: 68,
  carFovTop: 78,
  fov: 58,
};

export function createFollowCamera(camera, canvas, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const state = { yaw: settings.yaw, pitch: settings.pitch, distance: settings.distance };
  const focus = new THREE.Vector3();
  const smoothFocus = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();
  let first = true;
  let autoOrbit = 0;
  let mode = 'foot';
  let carYawOffset = 0;
  let carZoom = 0;
  let speedRatio = 0;
  let currentFov = settings.fov;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function onMouseMove(event) {
    if (document.pointerLockElement !== canvas) return;
    if (mode === 'car') {
      // In a car the mouse nudges a temporary look, it does not own the yaw.
      carYawOffset -= event.movementX * settings.sensitivity;
      state.pitch = clamp(state.pitch + event.movementY * settings.sensitivity, settings.minPitch, settings.maxPitch);
      carYawOffset = clamp(carYawOffset, -2.6, 2.6);
      return;
    }
    state.yaw -= event.movementX * settings.sensitivity;
    state.pitch = clamp(state.pitch + event.movementY * settings.sensitivity, settings.minPitch, settings.maxPitch);
  }

  function onWheel(event) {
    if (mode === 'car') {
      carZoom = clamp(carZoom + event.deltaY * 0.0035, -2, 4);
    } else {
      state.distance = clamp(state.distance + event.deltaY * 0.0035, settings.minDistance, settings.maxDistance);
    }
    event.preventDefault();
  }

  document.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  /** Brings the rig to an exact pose, skipping the easing (used when a run starts). */
  function snap(target) {
    focus.copy(target).setY(target.y + settings.focusHeight);
    smoothFocus.copy(focus);
    place(target, 1);
    first = false;
  }

  function place(target, blend) {
    const cosPitch = Math.cos(state.pitch);
    offset.set(Math.sin(state.yaw) * cosPitch, Math.sin(state.pitch), Math.cos(state.yaw) * cosPitch)
      .multiplyScalar(state.distance);
    right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
    const shoulder = mode === 'car' ? 0 : settings.shoulder;
    desired.copy(smoothFocus).add(offset).addScaledVector(right, shoulder);
    // Never dip under the pavement (the car rig sits a bit higher).
    desired.y = Math.max(desired.y, mode === 'car' ? 1.2 : 0.55);
    if (first) {
      camera.position.copy(desired);
      first = false;
    } else {
      camera.position.lerp(desired, blend);
    }
    camera.lookAt(smoothFocus);
  }

  /**
   * A slow orbit for the title screen, so the menu sits over a living shot of the city.
   * `amount` in radians per second.
   */
  function orbit(amount) {
    autoOrbit += amount;
    state.yaw += amount;
  }

  /** Switches pose. Entering or leaving a car resets the temporary car look. */
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    carYawOffset = 0;
    carZoom = 0;
    // The car rig owns both yaw and distance; keep the on-foot preferences for later.
    if (mode === 'car') {
      state.pitch = 0.24;
      state.distance = settings.carDistance;
    } else {
      state.distance = settings.distance;
    }
    first = false;
  }

  /** Follows the player's feet each frame. */
  function update(dt, target) {
    const desiredFocus = focus.set(target.x, target.y + settings.focusHeight, target.z);
    const focusBlend = 1 - Math.exp(-15 * Math.min(dt, 0.05));
    if (first) smoothFocus.copy(desiredFocus);
    else smoothFocus.lerp(desiredFocus, focusBlend);
    const positionBlend = 1 - Math.exp(-18 * Math.min(dt, 0.05));
    place(target, positionBlend);
    applyFov(dt, settings.fov);
    return state;
  }

  /**
   * Follows a car: the rig settles behind the heading (the mouse adds a temporary look), the
   * distance grows with speed and the FOV widens with it.
   */
  function updateCar(dt, target, heading, speed, maxSpeed) {
    const ratio = clamp(speed / Math.max(1, maxSpeed), 0, 1);
    speedRatio += (ratio - speedRatio) * (1 - Math.exp(-4 * dt));

    // Ease the temporary look back to centre when it is not being moved.
    carYawOffset *= Math.exp(-1.1 * dt);

    // The chase yaw trails the car's own heading: yaw we look toward, minus pi, is the car's
    // forward. That keeps the rig behind the bonnet however far the mouse was dragged.
    const behind = heading + Math.PI + carYawOffset;
    let difference = behind - state.yaw;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    state.yaw += difference * (1 - Math.exp(-4.6 * Math.min(dt, 0.05)));

    const carDistance = settings.carDistance + speedRatio * 3.4 + carZoom;
    const distanceBlend = 1 - Math.exp(-6 * Math.min(dt, 0.05));
    state.distance += (carDistance - state.distance) * distanceBlend;

    const focusTarget = focus.set(target.x, target.y + settings.carFocusHeight, target.z);
    const focusBlend = 1 - Math.exp(-12 * Math.min(dt, 0.05));
    smoothFocus.lerp(focusTarget, focusBlend);
    const positionBlend = 1 - Math.exp(-10 * Math.min(dt, 0.05));
    place(target, positionBlend);

    const targetFov = settings.carFov + speedRatio * (settings.carFovTop - settings.carFov);
    applyFov(dt, targetFov);
    return state;
  }

  function applyFov(dt, targetFov) {
    currentFov += (targetFov - currentFov) * (1 - Math.exp(-6 * dt));
    if (Math.abs(camera.fov - currentFov) > 0.01) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }
  }

  return {
    state,
    snap,
    update,
    updateCar,
    setMode,
    orbit,
    get mode() {
      return mode;
    },
    get autoOrbit() {
      return autoOrbit;
    },
    get speedRatio() {
      return speedRatio;
    },
    dispose() {
      document.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
