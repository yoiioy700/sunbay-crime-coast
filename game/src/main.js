// Boot and the one loop. The world is built once (city, player, camera rig, HUD, screens),
// then requestAnimationFrame runs with a clamped delta so a stall never teleports the player
// through a wall. Three states: menu (the title card over a slowly orbiting shot of the city),
// playing (pointer locked, body driven by the keys) and paused (the pause menu over a still).
//
// Nothing here fetches anything: three.js comes from the import map, every other module is a
// file beside this one.

import * as THREE from 'three';
import { createCity } from './city.js';
import { createFollowCamera } from './camera.js';
import { createHud } from './hud.js';
import { createPedestrians } from './pedestrians.js';
import { createPlayer } from './player.js';
import { createScreens } from './screens.js';
import { createTraffic } from './traffic.js';
import { createVehicles, exitPoint } from './vehicles.js';

export const STATE_MENU = 'menu';
export const STATE_PLAYING = 'playing';
export const STATE_PAUSED = 'paused';

/** The longest step the simulation takes; a longer stall is dropped, never replayed. */
const MAX_STEP = 0.05;

const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const screensRoot = document.getElementById('screens');
const boot = document.getElementById('boot');

/**
 * A machine without a real GPU (a software rasteriser, as in a headless test) cannot pay for
 * a shadow map and a high pixel ratio. Ask the driver who it is; on a GPU, render at full
 * quality, otherwise drop shadows and resolution until the frame fits. Nothing else changes.
 */
function detectSoftwareRenderer() {
  try {
    const probe = document.createElement('canvas').getContext('webgl2')
      ?? document.createElement('canvas').getContext('webgl');
    if (!probe) return true;
    const info = probe.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? probe.getParameter(info.UNMASKED_RENDERER_WEBGL) : probe.getParameter(probe.RENDERER));
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|swrast|basic render/i.test(name);
  } catch {
    return false;
  }
}

const SOFTWARE_RENDERER = detectSoftwareRenderer();
const PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, SOFTWARE_RENDERER ? 0.75 : 2);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !SOFTWARE_RENDERER,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = !SOFTWARE_RENDERER;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 900);

const city = createCity(scene, 0x51b0a7, { shadows: !SOFTWARE_RENDERER });
const player = createPlayer(scene, city);
const traffic = createTraffic(scene, city, { count: 20, seed: 0x7a1f1c });
const pedestrians = createPedestrians(scene, city, { count: 26, seed: 0x3ed5c0 });
const vehicles = createVehicles(scene, city);
const follow = createFollowCamera(camera, canvas);
const hud = createHud(hudRoot);
const screens = createScreens(screensRoot, { onPlay: startRun, onResume: resumeRun, onQuit: quitToTitle });

const keys = { forward: 0, back: 0, left: 0, right: 0, sprint: false, handbrake: false };
/** The car the player is beside, chosen each frame for the enter prompt and the E key. */
let nearbyCar = null;
let lastCarCrash = 0;
let state = STATE_MENU;
let elapsed = 0;
let last = performance.now();
let lastDrivenSpeed = 0;

const SUN_OFFSET = new THREE.Vector3(115, 155, 80);

/** Puts the sun's shadow frustum on the player, so the 240 m box is spent where it is seen. */
function followSun() {
  const anchor = vehicles.active ? vehicles.active.position : player.position;
  city.sun.position.copy(anchor).add(SUN_OFFSET);
  city.sun.target.position.set(anchor.x, 0, anchor.z);
  city.sun.target.updateMatrixWorld();
}

/** Frames the body and lets the title card orbit around it. */
function enterMenu() {
  state = STATE_MENU;
  hud.hide();
  screens.showTitle();
  follow.snap(player.position);
}

function startRun() {
  state = STATE_PLAYING;
  elapsed = 0;
  resetKeys();
  screens.hideAll();
  hud.show();
  hud.setObjective('');
  follow.snap(player.position);
  requestPointerLock();
}

function resumeRun() {
  state = STATE_PLAYING;
  resetKeys();
  screens.hidePause();
  hud.show();
  requestPointerLock();
}

function pauseRun() {
  if (state !== STATE_PLAYING) return;
  state = STATE_PAUSED;
  resetKeys();
  screens.showPause();
}

function quitToTitle() {
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  leaveCar();
  player.reset(city.spawn.x, city.spawn.z, city.spawn.heading);
  enterMenu();
}

function togglePause() {
  if (state === STATE_PLAYING) {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    pauseRun();
  } else if (state === STATE_PAUSED) {
    resumeRun();
  }
}

/** Pointer lock is a convenience, never a gate: if the browser refuses, the keys still drive. */
function requestPointerLock() {
  const request = canvas.requestPointerLock?.();
  if (request && typeof request.catch === 'function') request.catch(() => {});
}

function resetKeys() {
  keys.forward = 0;
  keys.back = 0;
  keys.left = 0;
  keys.right = 0;
  keys.sprint = false;
  keys.handbrake = false;
}

/**
 * E: enter the nearest car when on foot, step out of the driver's door when driving. A car
 * is claimed from the traffic list the moment it is entered, so the traffic AI stops
 * driving it and never respawns it.
 */
function toggleVehicle() {
  if (state !== STATE_PLAYING) return;
  if (vehicles.active) {
    leaveCar();
    return;
  }
  const found = vehicles.nearest(player.position, vehicles.candidatesFrom(traffic.cars), 3.8);
  if (!found) return;
  traffic.release(found.car);
  if (!vehicles.enter(found.car)) return;
  player.enterVehicle(found.car);
  follow.setMode('car');
  hud.setPrompt(null);
}

function leaveCar() {
  const car = vehicles.active;
  if (!car) return;
  const door = exitPoint(car);
  vehicles.exit();
  player.exitVehicle(car, door);
  follow.setMode('foot');
  follow.snap(player.position);
}

function honk() {
  if (state !== STATE_PLAYING) return;
  const anchor = vehicles.active ? vehicles.active.position : player.position;
  traffic.honk(anchor.x, anchor.z, 30);
}

function onKeyDown(event) {
  if (event.code === 'Escape') {
    event.preventDefault();
    togglePause();
    return;
  }
  if (state !== STATE_PLAYING) return;
  switch (event.code) {
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = 1;
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.back = 1;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = 1;
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = 1;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      keys.sprint = true;
      break;
    case 'Space':
      event.preventDefault();
      if (vehicles.active) keys.handbrake = true;
      else player.jump();
      break;
    case 'KeyE':
      toggleVehicle();
      break;
    case 'KeyH':
      honk();
      break;
    default:
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'KeyW':
    case 'ArrowUp':
      keys.forward = 0;
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.back = 0;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = 0;
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = 0;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      keys.sprint = false;
      break;
    case 'Space':
      keys.handbrake = false;
      break;
    default:
      break;
  }
}

window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => {
  resetKeys();
  if (state === STATE_PLAYING) pauseRun();
});

document.addEventListener('pointerlockchange', () => {
  // Losing the pointer while playing is the player's Esc: show the menu, not a lost cursor
  // driving the camera. A refused lock never fires a change, so the game simply plays on.
  if (state === STATE_PLAYING && document.pointerLockElement !== canvas) pauseRun();
});

// The title's PLAY button asks for pointer lock after the click; a browser that refuses it
// raises this event, and the run continues without mouse look.
document.addEventListener('pointerlockerror', () => {});

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
}

window.addEventListener('resize', onResize);

const controls = { forward: 0, strafe: 0, sprint: false };
const carControls = { throttle: 0, steer: 0, handbrake: false };

function frame(now) {
  const dt = Math.min(MAX_STEP, Math.max(0, (now - last) / 1000));
  last = now;

  if (state === STATE_PLAYING) {
    simulate(dt);
  } else {
    if (state === STATE_MENU) follow.orbit(dt * 0.085);
    follow.update(dt, player.position);
    traffic.update(dt, null);
    pedestrians.update(dt, traffic.drainEvents());
    hud.setDriving(false);
    hud.setPrompt(null);
  }

  followSun();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/**
 * One step of the playing world: the body or the car, then traffic, then the crowd, then the
 * HUD. The frame loop calls it with the frame's clamped delta; the debug hook can call it in
 * a tight loop to advance the simulation where the frame rate is not the subject.
 */
function simulate(dt) {
  elapsed += dt;
  {
    const driving = Boolean(vehicles.active);
    controls.forward = keys.forward - keys.back;
    controls.strafe = keys.right - keys.left;
    controls.sprint = keys.sprint;

    if (driving) {
      // In a car the throttle is W/S, the wheel is A/D, Space is the handbrake.
      carControls.throttle = controls.forward;
      carControls.steer = controls.strafe;
      carControls.handbrake = keys.handbrake;
      vehicles.update(dt, carControls);
      follow.updateCar(
        dt,
        vehicles.active.position,
        vehicles.active.heading,
        vehicles.active.speed,
        vehicles.active.spec.maxSpeed,
      );
      const speed = vehicles.active.speed;
      if (speed > 6 && speed < lastDrivenSpeed - 5 && elapsed - lastCarCrash > 2.2) {
        traffic.crash(vehicles.active.position.x, vehicles.active.position.z, 20);
        lastCarCrash = elapsed;
      }
      lastDrivenSpeed = speed;
      hud.setPlayerBearing(vehicles.active.heading);
    } else {
      player.update(dt, follow.state.yaw, controls);
      follow.update(dt, player.position);
      hud.setPlayerBearing(player.heading);
    }

    traffic.update(dt, vehicles.active);
    pedestrians.update(dt, traffic.drainEvents());

    // The enter prompt: only on foot, only near a car that is not already being driven.
    if (!driving) {
      const found = vehicles.nearest(player.position, vehicles.candidatesFrom(traffic.cars), 3.8);
      nearbyCar = found ? found.car : null;
      if (nearbyCar) hud.setPrompt('E', `Enter ${nearbyCar.spec.label.toLowerCase()}`);
      else hud.setPrompt(null);
    } else {
      nearbyCar = null;
    }

    hud.setDriving(driving, vehicles.active ? vehicles.active.speed : 0,
      vehicles.active ? vehicles.active.spec.maxSpeed : 30,
      vehicles.active ? vehicles.active.spec.label.toUpperCase() : '');
  }
}

// Everything is ready: drop the loading card on the first rendered frame and open the title.
enterMenu();
followSun();
renderer.render(scene, camera);
boot.classList.add('done');
setTimeout(() => boot.remove(), 500);
requestAnimationFrame((now) => {
  last = now;
  frame(now);
});

// A small handle for diagnostics and the smoke test; it holds no game logic.
window.__sunbay = {
  get state() {
    return state;
  },
  player,
  camera,
  follow,
  renderer,
  city,
  scene,
  traffic,
  pedestrians,
  vehicles,
  get drawCalls() {
    return renderer.info.render.calls;
  },
  get driving() {
    return Boolean(vehicles.active);
  },
  get nearbyCar() {
    return nearbyCar;
  },
  start: startRun,
  /**
   * Advances the playing simulation by `seconds` in fixed 1/60 steps without waiting for
   * frames. SwiftShader renders under a frame a second, so a headless test that wants to see
   * a car accelerate uses this; on a real GPU the frame loop is already far ahead of it.
   */
  advance(seconds = 1) {
    if (state !== STATE_PLAYING) return elapsed;
    const step = 1 / 60;
    const steps = Math.max(1, Math.round(seconds / step));
    for (let index = 0; index < steps; index += 1) simulate(step);
    return elapsed;
  },
  // Debug hooks for the smoke test: teleport, claim the nearest car, and drive it directly.
  enterCarAt(x, z) {
    player.reset(x, z, player.heading);
    const found = vehicles.nearest(player.position, vehicles.candidatesFrom(traffic.cars), 3.8);
    if (!found) return null;
    toggleVehicle();
    return vehicles.active ? vehicles.active.id : null;
  },
  leaveCar,
  honk,
};
