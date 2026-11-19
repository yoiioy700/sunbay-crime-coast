// Boot and the one loop. The world is built once (city, player, camera rig, HUD, screens,
// police, combat), then requestAnimationFrame runs with a clamped delta so a stall never
// teleports the player through a wall. Five states: menu (the title card over a slowly orbiting
// shot of the city), playing (pointer locked, body driven by the keys), paused (the pause menu
// over a still), busted and wasted (the outcome card over the frozen world, counting down to a
// respawn at the police station or the hospital).
//
// The loop owns the crimes too: a stolen car, a pedestrian or traffic car struck, a shot fired
// at an officer all go to police.crime(), and the same events move the HUD. Camera shake is
// applied after the follow rig has placed the camera, so it never fights the easing.
//
// Nothing here fetches anything: three.js comes from the import map, every other module is a
// file beside this one.

import * as THREE from 'three';
import { createAudio } from './audio.js';
import { CITY, createCity } from './city.js';
import { createCombat } from './combat.js';
import { createEconomy } from './economy.js';
import { createEffects } from './effects.js';
import { createFollowCamera } from './camera.js';
import { createHud } from './hud.js';
import { createMissions } from './missions.js';
import { createPedestrians } from './pedestrians.js';
import { createPlayer } from './player.js';
import { createPolice } from './police.js';
import { createProgression } from './progression.js';
import { createScreens } from './screens.js';
import { createTraffic } from './traffic.js';
import { createVehicles, exitPoint } from './vehicles.js';
import {
  NEW_GAME, clearSave, createAutosave, hasSave, loadSave, loadSettings, writeSave,
  writeSettings,
} from './save.js';

export const STATE_MENU = 'menu';
export const STATE_PLAYING = 'playing';
export const STATE_PAUSED = 'paused';
export const STATE_BUSTED = 'busted';
export const STATE_WASTED = 'wasted';

const START_MONEY = NEW_GAME.money;
const BUSTED_RESPAWN = 3.4;
const WASTED_RESPAWN = 3.4;
/** Where the hospital drops a wasted player: a crossroads on the west side. */
const HOSPITAL = { x: 99, z: 33, heading: Math.PI / 2 };

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

const effects = createEffects(scene);

const city = createCity(scene, 0x51b0a7, { shadows: !SOFTWARE_RENDERER });
const audio = createAudio();
const player = createPlayer(scene, city);
const traffic = createTraffic(scene, city, { count: 20, seed: 0x7a1f1c });
const pedestrians = createPedestrians(scene, city, { count: 26, seed: 0x3ed5c0 });
const vehicles = createVehicles(scene, city, {
  onStolen: () => police.crime('theft'),
});
const follow = createFollowCamera(camera, canvas);
const hud = createHud(hudRoot);

// The cars that are not ambient traffic and not the player's current ride: the job's marked
// car and the ones bought at the dealer and left on the lot. Both lists stay enterable.
const missionCars = [];
const garageCars = [];

/** Every car a footed player may walk up to and take. */
function enterableCars() {
  return [...traffic.cars, ...vehicles.cars, ...missionCars, ...garageCars,
    ...(vehicles.active ? [vehicles.active] : [])];
}

/** Builds a car into the world and files it in the list its purpose names. */
function addCar(spec = {}) {
  const car = vehicles.createCar(spec);
  if (spec.missionTarget) {
    missionCars.push(car);
    car.health = 100;
  } else {
    garageCars.push(car);
    // A car from the player's own lot is not a theft: entering it raises no wanted level.
    car.playerOwned = true;
    car.purchased = true;
  }
  return car;
}

/** Empties the job and garage lists, for a New Game or a Continue over the current world. */
function clearExtraCars() {
  for (const car of [...missionCars, ...garageCars]) removeCar(car);
}

/** Removes a job car: the scene and the enterable list both forget it. */
function removeCar(car) {
  if (!car) return;
  const index = missionCars.indexOf(car);
  if (index >= 0) missionCars.splice(index, 1);
  const garageIndex = garageCars.indexOf(car);
  if (garageIndex >= 0) garageCars.splice(garageIndex, 1);
  scene.remove(car.group);
}

// The story's clock and unlocks.
const progression = createProgression();

// The mission chain. It owns its world marker and its target car; everything it shows outside
// the world goes through these callbacks, so the HUD and the economy stay its only outlets.
const missions = createMissions(scene, city, {
  getPlayer: () => player.position,
  getActiveCar: () => vehicles.active,
  spawnCar: (spec) => addCar({ ...spec, missionTarget: true }),
  despawnCar: removeCar,
  setWanted: (level) => police.setWanted(level),
  onObjective: (text) => hud.setObjective(text),
  onBanner: (kind, detail) => {
    hud.showBanner(kind, detail);
    if (kind === 'complete') audio.fanfare();
  },
  onReward: (amount) => {
    economy.addMoney(amount, 'mission');
  },
  getMissionsDone: () => missions.done,
  getUnlockNote: (count) => progression.unlockNote(count),
  onMissionEnd: () => autosave.saveNow('mission'),
});

// The money and the three shops. The dealer's cars and the spray booth reach the scene and the
// player's car through callbacks; the ammo and weapon state stays owned by combat.js.
const economy = createEconomy(scene, hudRoot, {
  spawnCar: (spec) => addCar(spec),
  getMissionsDone: () => missions.done,
  getActiveCar: () => vehicles.active,
  onAmmo: (rounds, kind) => addAmmo(rounds, kind),
  onWeapon: (name) => {
    if (name === 'smg') {
      combat.giveSmg();
      lastHudAmmo = -1;
    }
  },
  onRepaint: (color, car) => repaintCar(car, color),
  onMoney: (amount, delta) => hud.showMoneyChange(amount, delta),
  onPurchase: () => {
    autosave.saveNow('purchase');
    hud.setObjective('');
    audio.chime();
    effects.sparkle(player.position.x, player.position.y + 1, player.position.z, '#b9ffcd');
  },
});

const police = createPolice(scene, city, {
  onBusted: triggerBusted,
  onCrime: (level) => hud.setWanted(level, 1.6),
  // The shared hit effects, plus the one thing police fire needs that combat also owns: a
  // wound on the body.
  effects: { ...effects, damagePlayer: (amount) => hurt(amount) },
});
const combat = createCombat(scene, city, {
  pedestrians, police, player, camera, follow,
  cars: () => [...traffic.cars, ...vehicles.cars, ...missionCars, ...garageCars,
    ...(vehicles.active ? [vehicles.active] : [])],
  effects: {
    ...effects,
    damagePlayer: (amount) => hurt(amount),
    onShot: () => audio.shot(combat.state.smg ? 'smg' : 'pistol'),
    onSwing: () => audio.hit(),
    onHit: (kind, target, amount) => {
      if (kind === 'pedestrian') police.crime('pedestrian');
      else if (kind === 'officer' || kind === 'policeCar') police.crime('police');
      else if (kind === 'car') {
        police.crime('car');
        if (target) {
          missions.damageTarget(target, amount);
          // A car the player is not sitting in takes real damage: smoke, fire, then a wreck.
          if (target !== vehicles.active) effects.damageCar(target, amount);
        }
      } else if (kind === 'policeCar' && target) {
        police.damageCar(target, amount);
      }
    },
  },
});
combat.givePistol();
const screens = createScreens(screensRoot, {
  onPlay: playPressed,
  onResume: resumeRun,
  onQuit: quitToTitle,
  onContinue: continueRun,
  onNewGame: newGame,
  onRestart: restartRun,
  onVolume: (value) => {
    audio.setVolume(value);
    audio.unlock();
    writeSettingsNow();
  },
  onMute: () => {
    audio.toggleMute();
    syncAudioPanel();
    writeSettingsNow();
  },
});

// The save: written on every mission result, purchase, bust and 30 seconds of play.
const autosave = createAutosave(() => collectSaveState(), { intervalMs: 30000 });

// The settings live apart from the run's save, so New Game never mutes the city.
const settings = loadSettings();
audio.setVolume(settings.volume);
audio.setMuted(settings.muted);

/** Writes the live audio state back to settings, for the pause menu and the N key. */
function writeSettingsNow() {
  writeSettings({ volume: audio.volume, muted: audio.muted });
  screens.setAudio(audio.volume, audio.muted);
}

function syncAudioPanel() {
  screens.setAudio(audio.volume, audio.muted);
}

const keys = { forward: 0, back: 0, left: 0, right: 0, sprint: false, handbrake: false };
/** The car the player is beside, chosen each frame for the enter prompt and the E key. */
let nearbyCar = null;
let lastCarCrash = 0;
let state = STATE_MENU;
let elapsed = 0;
let last = performance.now();
let lastDrivenSpeed = 0;
let respawnTimer = 0;
let respawnDeadline = 0;
let respawnKind = null;
let lastWantedSeen = 0;
let lastHudAmmo = -1;
let lastBlipSignature = '';
let smgReserve = 0;

const SUN_OFFSET = new THREE.Vector3(150, 66, 92);

/** Puts the sun's shadow frustum on the player, so the 240 m box is spent where it is seen. */
function followSun() {
  const anchor = vehicles.active ? vehicles.active.position : player.position;
  city.sun.position.copy(anchor).add(SUN_OFFSET);
  city.sun.target.position.set(anchor.x, 0, anchor.z);
  city.sun.target.updateMatrixWorld();
}

/** Frames the body and lets the title card orbit around it; shows Continue when a save is read. */
function enterMenu() {
  state = STATE_MENU;
  hud.hide();
  screens.hideOutcome();
  const saved = loadSave();
  screens.setSaveAvailable(Boolean(saved),
    saved ? `$${saved.money.toLocaleString('en-US')} · ${saved.missionsDone} JOB${saved.missionsDone === 1 ? '' : 'S'} DONE` : '');
  screens.showTitle();
  follow.snap(player.position);
  syncAudioPanel();
  audio.music(audio.ready);
}

/** The state a save is written from: the player's situation, never the world's scenery. */
function collectSaveState() {
  // Where the player will come back: the car's seat while driving, else the body's feet.
  const position = vehicles.active ? vehicles.active.position : player.position;
  return {
    money: economy.money,
    ownedCars: economy.ownedCars.map((car) => ({ type: car.type, color: car.color })),
    smgUnlocked: combat.state.smg,
    ammo: combat.state.ammo,
    reserve: combat.state.reserve,
    smgAmmo: combat.state.smgAmmo,
    smgReserve: combat.state.smgReserve,
    missionsDone: missions.done,
    activeMission: missions.active ? missions.active.id : null,
    player: { x: position.x, z: position.z, heading: player.heading },
    stats: progression.snapshot(),
  };
}

/** Puts a loaded save back into the running systems. The world itself is not restored. */
function applySaveState(data) {
  clearExtraCars();
  economy.restore({ money: data.money, ownedCars: data.ownedCars, smgOwned: data.smgUnlocked });
  missions.restore({ done: data.missionsDone });
  progression.restore(data.stats);
  combat.setAmmo(Number.isFinite(data.ammo) ? data.ammo : NEW_GAME.ammo,
    Number.isFinite(data.reserve) ? data.reserve : NEW_GAME.reserve);
  if (Number.isFinite(data.smgAmmo)) combat.state.smgAmmo = data.smgAmmo;
  if (Number.isFinite(data.smgReserve)) combat.state.smgReserve = data.smgReserve;
  if (data.smgUnlocked) combat.giveSmg();
  else combat.givePistol();
  const spot = data.player ?? NEW_GAME.player;
  player.reset(spot.x, spot.z, spot.heading);
  follow.snap(player.position);
  economy.respawnOwnedCars();
  lastHudAmmo = -1;
  lastWantedSeen = 0;
}

/** A fresh run: the store is dropped, every system reset, and the city starts at the spawn. */
function newGame() {
  clearSave();
  leaveCar();
  clearExtraCars();
  police.reset();
  combat.reset();
  missions.reset();
  progression.reset();
  economy.reset();
  combat.spawnAll();
  lastHudAmmo = -1;
  player.reset(city.spawn.x, city.spawn.z, city.spawn.heading);
  startRun();
}

/** RESTART on the pause menu: a fresh city without touching the save on the way out. */
function restartRun() {
  screens.hidePause();
  newGame();
}

/** Continue: the last save's money, garage, guns, jobs and position. */
function continueRun() {
  const saved = loadSave();
  if (!saved) {
    startRun();
    return;
  }
  applySaveState(saved);
  startRun();
}

/** PLAY on the title: a fresh run when there is no save, a Continue when there is one. */
function playPressed() {
  if (hasSave()) continueRun();
  else startRun();
}

function startRun() {
  state = STATE_PLAYING;
  elapsed = 0;
  resetKeys();
  screens.hideAll();
  hud.show();
  hud.setObjective('');
  hud.showMoneyChange(economy.money, 0);
  hud.hideBanner();
  combat.reset();
  police.reset();
  respawnTimer = 0;
  respawnKind = null;
  missions.hidePhone();
  autosave.resetClock();
  follow.snap(player.position);
  audio.unlock();
  audio.music(true);
  requestPointerLock();
}

function resumeRun() {
  state = STATE_PLAYING;
  resetKeys();
  screens.hidePause();
  hud.show();
  audio.music(true);
  requestPointerLock();
}

function pauseRun() {
  if (state !== STATE_PLAYING) return;
  state = STATE_PAUSED;
  resetKeys();
  missions.hidePhone();
  screens.setStats(progression.statsPanel({
    missionsDone: missions.done,
    carsOwned: economy.ownedCars.length,
  }));
  syncAudioPanel();
  screens.showPause();
  audio.music(false);
  audio.engine(false, 0);
  audio.skid(0);
  audio.siren(false, 100);
}

// -- damage, the two outcomes, and the respawn ----------------------------------------------

/** Every wound: the HUD bar, the vignette, and at zero the wasted card. */
function hurt(amount) {
  if (state !== STATE_PLAYING) return combat.health;
  const health = combat.damage(amount);
  hud.setHealth(health);
  hud.damageFlash(0.9, amount / 10);
  if (health <= 0) triggerWasted();
  return health;
}

function endRun(kind) {
  state = kind === 'wasted' ? STATE_WASTED : STATE_BUSTED;
  respawnKind = kind;
  respawnTimer = kind === 'busted' ? BUSTED_RESPAWN : WASTED_RESPAWN;
  // The countdown is wall-clock, not simulation time: a slow frame must not stretch it.
  respawnDeadline = performance.now() / 1000 + respawnTimer;
  resetKeys();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  hud.setDriving(false);
  hud.setPrompt(null);
  missions.hidePhone();
  audio.engine(false, 0);
  audio.skid(0);
  audio.siren(false, 100);
  // A job the body was taken off is failed, and pays nothing.
  missions.onPlayerDown(kind === 'busted'
    ? 'Busted before the job was done'
    : 'The hospital got you before the job was done');
  if (kind === 'busted') {
    const fine = Math.min(economy.money, 250 + police.level * 60);
    economy.spend(fine);
    screens.showOutcome('busted', {
      reason: `THEY RAN YOUR PLATES · WANTED LEVEL ${police.level}`,
      cost: `FINE  -$${fine.toLocaleString('en-US')}`,
      countdown: '',
    });
  } else {
    const bill = Math.min(economy.money, 200);
    economy.spend(bill);
    screens.showOutcome('wasted', {
      reason: 'THE STREET WON THIS ONE',
      cost: `HOSPITAL  -$${bill.toLocaleString('en-US')}`,
      countdown: '',
    });
  }
  autosave.saveNow('outcome');
  screens.setOutcomeCountdown(respawnTimer);
}

function triggerBusted() {
  if (state !== STATE_PLAYING) return;
  endRun('busted');
}

function triggerWasted() {
  if (state !== STATE_PLAYING) return;
  endRun('wasted');
}

/** The respawn when the countdown ends: station or hospital, healed, police cleared. */
function respawn() {
  const kind = respawnKind;
  const spot = kind === 'wasted' ? HOSPITAL : police.station;
  leaveCar();
  police.reset();
  combat.reset();
  player.reset(spot.x, spot.z, spot.heading);
  follow.snap(player.position);
  state = STATE_PLAYING;
  respawnTimer = 0;
  respawnKind = null;
  screens.hideOutcome();
  hud.show();
  hud.setHealth(100);
  hud.setWanted(0, 0);
  lastWantedSeen = 0;
  lastHudAmmo = -1;
  requestPointerLock();
}

function quitToTitle() {
  // The title is where a session ends: write where the player stands before resetting anything.
  autosave.saveNow('quit');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  leaveCar();
  police.reset();
  combat.reset();
  respawnTimer = 0;
  respawnKind = null;
  missions.hidePhone();
  screens.hideOutcome();
  hud.setHealth(100);
  hud.setWanted(0, 0);
  audio.engine(false, 0);
  audio.skid(0);
  audio.siren(false, 100);
  player.reset(city.spawn.x, city.spawn.z, city.spawn.heading);
  enterMenu();
}

function togglePause() {
  if (state === STATE_BUSTED || state === STATE_WASTED) return;
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
  const found = vehicles.nearest(player.position, enterableCars(), 3.8);
  if (!found) return;
  traffic.release(found.car);
  if (found.car.purchased) found.car.playerOwned = true;
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
  audio.horn();
}

/** F: a swing at whoever is in front of the body. */
function punch() {
  if (state !== STATE_PLAYING) return;
  combat.punch();
}

function reloadWeapon() {
  if (state !== STATE_PLAYING) return;
  combat.reload();
}

/** Left mouse button: the pistol, held down for repeat fire. Only while playing. */
let triggerHeld = false;

canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || state !== STATE_PLAYING) return;
  triggerHeld = true;
  combat.fire();
});

window.addEventListener('mouseup', (event) => {
  if (event.button === 0) triggerHeld = false;
});

// A click on the canvas while on foot is also how a browser without pointer lock looks around;
// do not let it reach the title card.
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

function onKeyDown(event) {
  if (event.code === 'Escape') {
    event.preventDefault();
    togglePause();
    return;
  }
  // N mutes anywhere, so a player can silence the city from the pause menu too.
  if (event.code === 'KeyN') {
    event.preventDefault();
    audio.toggleMute();
    syncAudioPanel();
    writeSettingsNow();
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
    case 'KeyF':
      punch();
      break;
    case 'KeyR':
      reloadWeapon();
      break;
    case 'KeyM':
    case 'Tab':
      event.preventDefault();
      togglePhone();
      break;
    case 'Digit1':
    case 'Digit2':
    case 'Digit3': {
      const row = Number(event.code.slice(5));
      economy.buyKey(row);
      break;
    }
    case 'Equal':
    case 'NumpadAdd':
      event.preventDefault();
      hud.zoomMap(1);
      break;
    case 'Minus':
    case 'NumpadSubtract':
      event.preventDefault();
      hud.zoomMap(-1);
      break;
    default:
      break;
  }
}

/** M or Tab: Mama Rosa's phone. While it is open the world still runs behind it. */
function togglePhone() {
  if (state !== STATE_PLAYING) return;
  missions.togglePhone();
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
  } else if (state === STATE_BUSTED || state === STATE_WASTED) {
    // The outcome card holds the world still; only the wall-clock countdown runs.
    respawnTimer = Math.max(0, respawnDeadline - now / 1000);
    screens.setOutcomeCountdown(respawnTimer);
    if (respawnTimer === 0) respawn();
  } else {
    if (state === STATE_MENU) follow.orbit(dt * 0.085);
    follow.update(dt, player.position);
    traffic.update(dt, null);
    pedestrians.update(dt, traffic.drainEvents());
    hud.setDriving(false);
    hud.setPrompt(null);
    audio.engine(false, 0);
    audio.skid(0);
  }

  effects.update(dt, camera);
  followSun();
  effects.applyShake(camera);
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
        police.crime('car');
        effects.shake(0.4);
        // The car that was hit wears the impact: a few hits and it smokes, then burns.
        let closest = null;
        let closestDistance = 6.5;
        for (const other of traffic.cars) {
          if (other === vehicles.active) continue;
          const distance = Math.hypot(other.position.x - vehicles.active.position.x,
            other.position.z - vehicles.active.position.z);
          if (distance < closestDistance) {
            closest = other;
            closestDistance = distance;
          }
        }
        if (closest) effects.damageCar(closest, 34);
        lastCarCrash = elapsed;
      }
      lastDrivenSpeed = speed;

      // The engine's pitch follows the car; the skid howls when the handbrake bites at speed.
      const car = vehicles.active;
      const ratio = speed / Math.max(1, car.spec.maxSpeed);
      audio.engine(true, ratio);
      const skidStrength = keys.handbrake && speed > 4
        ? Math.min(1, speed / car.spec.maxSpeed + 0.25) : 0;
      audio.skid(skidStrength);
      if (skidStrength > 0.12) {
        effects.tireSmoke(car.position.x, car.position.z, car.heading, skidStrength);
        hud.setPlayerBearing(car.heading);
      } else {
        hud.setPlayerBearing(car.heading);
      }
      // The sea meets the sand; a fast car throws spray off its wheels along the shoreline.
      if (speed > 7 && Math.random() < dt * 7
        && car.position.x > CITY.beachStartX - 1 && car.position.x < CITY.waterStartX + 6) {
        effects.splash(car.position.x + 1.4, car.position.z, 1);
      }

      // Running down a pedestrian is its own crime; the crowd scatters from the impact.
      const struck = pedestrians.hitByCar(
        vehicles.active.position.x, vehicles.active.position.z, 2.6, speed);
      if (struck) {
        traffic.crash(struck.x, struck.z, 18);
        police.crime('pedestrian');
        effects.shake(0.5);
      }
    } else {
      player.update(dt, follow.state.yaw, controls);
      follow.update(dt, player.position);
      hud.setPlayerBearing(player.heading);
      audio.engine(false, 0);
      audio.skid(0);
      // Wading at the waterline throws a little spray.
      if (player.position.x > CITY.beachStartX + 6 && Math.random() < dt * 5) {
        effects.splash(player.position.x, player.position.z, 1);
      }
    }

    traffic.update(dt, vehicles.active);
    pedestrians.update(dt, traffic.drainEvents());

    // The response, then the player's weapons, then the HUD's per-frame flourishes.
    police.step(dt, {
      player: player.position,
      onFoot: !driving,
      activeCar: vehicles.active,
    });
    // The siren is levelled by the nearest cruiser, so it fades as the chase passes.
    let nearestCop = Infinity;
    for (const cop of police.cars) {
      nearestCop = Math.min(nearestCop,
        Math.hypot(cop.position.x - player.position.x, cop.position.z - player.position.z));
    }
    audio.siren(police.level > 0 && nearestCop < 90, nearestCop);
    // Smoke at low health, fire below a fifth, one explosion at zero.
    effects.updateCars(dt, [...traffic.cars, ...vehicles.cars, ...missionCars, ...garageCars,
      ...police.cars, ...(vehicles.active ? [vehicles.active] : [])]);
    combat.update(dt, { firing: triggerHeld });
    hud.tick(dt);

    const wanted = police.level;
    if (wanted !== lastWantedSeen) {
      lastWantedSeen = wanted;
      hud.setWanted(wanted, wanted > 0 ? 1.2 : 0);
    }
    if (combat.ammo !== lastHudAmmo || combat.reloading) {
      lastHudAmmo = combat.ammo;
      hud.setAmmo(combat.ammo, combat.reserveAmmo, combat.reloading);
    }
    hud.setHealth(combat.health);

    // The enter prompt: only on foot, only near a car that is not already being driven.
    if (!driving) {
      const found = vehicles.nearest(player.position, enterableCars(), 3.8);
      nearbyCar = found ? found.car : null;
      if (nearbyCar) hud.setPrompt('E', `Enter ${nearbyCar.spec.label.toLowerCase()}`);
      else hud.setPrompt(null);
    } else {
      nearbyCar = null;
    }

    if (combat.pistol) combat.pistol.group.visible = combat.state.gunOut && !driving;
    hud.setDriving(driving, vehicles.active ? vehicles.active.speed : 0,
      vehicles.active ? vehicles.active.spec.maxSpeed : 30,
      vehicles.active ? vehicles.active.spec.label.toUpperCase() : '');

    // The story, the shops, the clock and the save all read the same frame: the job first, so
    // its marker and objective are current, then the pads under the player, then the map.
    missions.update(dt, elapsed);
    economy.update(dt, player.position, elapsed);
    progression.tick(dt, driving ? vehicles.active.speed : 0);
    autosave.tick(dt);

    // The map: the story's blip and the shops, the police cruisers that are actually out,
    // the traffic as small dots, and the body or the car at its centre.
    const blips = [...missions.blips(), ...economy.blips(),
      ...police.cars.map((car) => ({ x: car.position.x, z: car.position.z, kind: 'police' }))];
    const anchor = vehicles.active ? vehicles.active.position : player.position;
    const trafficDots = traffic.cars.filter((car) => !car.driver)
      .map((car) => ({ x: car.position.x, z: car.position.z }));
    hud.setMap({
      x: anchor.x, z: anchor.z, blips, traffic: trafficDots, wanted, time: elapsed,
    });
    lastBlipSignature = '';
  }
}

/** A shop's ammo pack: pistol rounds, or the SMG's once it is owned. */
function addAmmo(rounds, kind = null) {
  combat.addAmmo(rounds, kind);
  lastHudAmmo = -1;
}

/** The spray booth: repaints the car the player is driving, on every mesh that shares it. */
function repaintCar(car, color) {
  if (!car) return;
  car.color = color;
  car.group.traverse((child) => {
    if (child.isMesh && child.material && child.material.color && !child.material.vertexColors) {
      child.material = child.material.clone();
      child.material.color.set(color);
    }
  });
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
    const found = vehicles.nearest(player.position, enterableCars(), 3.8);
    if (!found) return null;
    toggleVehicle();
    return vehicles.active ? vehicles.active.id : null;
  },
  leaveCar,
  honk,
  police,
  combat,
  effects,
  screens,
  hud,
  missions,
  economy,
  progression,
  autosave,
  audio,
  effects,
  get minimap() {
    return hud.minimap;
  },
  /** The audio settings as the pause menu shows them, for the smoke test. */
  settings: {
    get volume() {
      return audio.volume;
    },
    get muted() {
      return audio.muted;
    },
    setVolume: (value) => {
      const next = audio.setVolume(value);
      writeSettingsNow();
      return next;
    },
    setMuted: (value) => {
      const next = audio.setMuted(value);
      writeSettingsNow();
      return next;
    },
    toggleMute: () => {
      const next = audio.toggleMute();
      writeSettingsNow();
      return next;
    },
    pause: () => pauseRun(),
    resume: () => resumeRun(),
  },
  save: {
    load: () => {
      const data = loadSave();
      if (!data) return null;
      applySaveState(data);
      return data;
    },
    write: () => writeSave(collectSaveState()),
    clear: () => clearSave(),
    peek: () => loadSave(),
    has: () => hasSave(),
  },
  /** The story entry points the smoke test drives. */
  mission: {
    start: (id) => missions.start(id),
    complete: () => missions.forceComplete(),
    skip: () => missions.skipStage(),
    abandon: () => missions.abandon(),
    get objective() {
      return missions.objective;
    },
    get done() {
      return missions.done;
    },
    get active() {
      return missions.active;
    },
    get marker() {
      return missions.marker;
    },
  },
  /** Buys a shop row by its id, straight through the shop's own path. */
  buy: (id, shop) => economy.buy(id, shop ? { shop } : {}),
  saveNow: (reason) => autosave.saveNow(reason),
  get money() {
    return economy.money;
  },
  get respawnRemaining() {
    return respawnTimer;
  },
  /** The list combat.js tests its bullet rays against. */
  cars: () => [...traffic.cars, ...vehicles.cars, ...missionCars, ...garageCars,
    ...(vehicles.active ? [vehicles.active] : [])],
  /** Stands the body somewhere and lets the world settle, for the smoke test. */
  teleport(x, z, heading = player.heading) {
    if (vehicles.active) leaveCar();
    player.reset(x, z, heading);
    follow.snap(player.position);
    return { x, z };
  },
  /** Test hooks: the same paths the keys and the police take. */
  setWanted: (level) => police.setWanted(level),
  bust: () => police.forceBust(),
  hurt: (amount) => hurt(amount),
  respawn,
  tests: {
    punch: () => combat.punch(),
    fire: () => combat.fire(),
    reload: () => combat.reload(),
    givePistol: () => combat.givePistol(),
    setAmmo: (ammo, reserve) => combat.setAmmo(ammo, reserve),
    giveSmg: () => combat.giveSmg(),
    addAmmo: (rounds) => addAmmo(rounds),
    setHealth: (value) => {
      combat.state.health = Math.max(0, Math.min(100, value));
      hud.setHealth(combat.state.health);
      return combat.state.health;
    },
  },
};
