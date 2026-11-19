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
import { createPlayer } from './player.js';
import { createScreens } from './screens.js';

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
const follow = createFollowCamera(camera, canvas);
const hud = createHud(hudRoot);
const screens = createScreens(screensRoot, { onPlay: startRun, onResume: resumeRun, onQuit: quitToTitle });

const keys = { forward: 0, back: 0, left: 0, right: 0, sprint: false };
let state = STATE_MENU;
let elapsed = 0;
let last = performance.now();

const SUN_OFFSET = new THREE.Vector3(115, 155, 80);

/** Puts the sun's shadow frustum on the player, so the 240 m box is spent where it is seen. */
function followSun() {
  city.sun.position.copy(player.position).add(SUN_OFFSET);
  city.sun.target.position.set(player.position.x, 0, player.position.z);
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
      player.jump();
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

function frame(now) {
  const dt = Math.min(MAX_STEP, Math.max(0, (now - last) / 1000));
  last = now;
  elapsed += dt;

  if (state === STATE_PLAYING) {
    controls.forward = keys.forward - keys.back;
    controls.strafe = keys.right - keys.left;
    controls.sprint = keys.sprint;
    player.update(dt, follow.state.yaw, controls);
    follow.update(dt, player.position);
    hud.setPlayerBearing(player.heading);
  } else {
    if (state === STATE_MENU) follow.orbit(dt * 0.085);
    follow.update(dt, player.position);
  }

  followSun();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
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
  get drawCalls() {
    return renderer.info.render.calls;
  },
  start: startRun,
};
