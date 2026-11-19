// A third-person follow camera: the body's shoulders are the pivot, the mouse orbits around
// them under pointer lock, the wheel pulls in and out, and both the focus point and the rig
// itself ease toward their targets so a sprint never shakes the frame. Yaw 0 looks down -Z,
// which is also the convention player.js reads for camera-relative movement.

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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function onMouseMove(event) {
    if (document.pointerLockElement !== canvas) return;
    state.yaw -= event.movementX * settings.sensitivity;
    state.pitch = clamp(state.pitch + event.movementY * settings.sensitivity, settings.minPitch, settings.maxPitch);
  }

  function onWheel(event) {
    state.distance = clamp(state.distance + event.deltaY * 0.0035, settings.minDistance, settings.maxDistance);
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
    desired.copy(smoothFocus).add(offset).addScaledVector(right, settings.shoulder);
    // Never dip under the pavement.
    desired.y = Math.max(desired.y, 0.55);
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

  /**
   * Follows `target` (the player's feet) each frame. `dt` seconds; yaw/pitch are already
   * current because the mouse events wrote them directly.
   */
  function update(dt, target) {
    const desiredFocus = focus.set(target.x, target.y + settings.focusHeight, target.z);
    const focusBlend = 1 - Math.exp(-15 * Math.min(dt, 0.05));
    if (first) smoothFocus.copy(desiredFocus);
    else smoothFocus.lerp(desiredFocus, focusBlend);
    const positionBlend = 1 - Math.exp(-18 * Math.min(dt, 0.05));
    place(target, positionBlend);
    return state;
  }

  return {
    state,
    snap,
    update,
    orbit,
    get autoOrbit() {
      return autoOrbit;
    },
    dispose() {
      document.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
