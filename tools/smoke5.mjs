// Headless smoke test for the Sunbay M5 polish build: audio, effects, minimap, menus.
//
//   NODE_PATH=/root/dac-game/node_modules node tools/smoke5.mjs
//
// Serves game/, opens it in the pinned Playwright Chromium with SwiftShader WebGL, clicks PLAY,
// and checks: an AudioContext exists after the gesture; firing the pistol and the punch fire
// their sounds; the handbrake while driving makes tyre smoke and skid marks; the minimap
// canvas paints real pixels; the pause menu opens with a working volume slider; N mutes; the
// zoom keys change the map's range; the city still has a golden-hour sky and a low sun.
// The screenshot goes to /tmp/sunbay-polish.png, never into the repository.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/dac-game/node_modules/playwright-core/index.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME_ROOT = join(REPO, 'game');
const SHOT = '/tmp/sunbay-polish.png';
const CHROME = '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const server = createServer((request, response) => {
  const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const relative = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  const path = resolve(GAME_ROOT, relative);
  if (!path.startsWith(GAME_ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    statSync(path);
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(response);
});

const port = await new Promise((ok, fail) => {
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => ok(server.address().port));
});

const consoleErrors = [];
const pageErrors = [];
const notes = [];
let browser;
let verdict = 'FAIL';
let detail = '';

try {
  browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  // SwiftShader renders at about a frame a second: small viewport, long waits, and the
  // simulation advanced through the debug hook where the frames cannot keep up.
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error && error.stack ? error.stack : error)));
  page.on('requestfailed', (request) => consoleErrors.push(`requestfailed ${request.url()}`));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sunbay && window.__sunbay.audio), null,
    { timeout: 30000 });
  await page.waitForTimeout(800);

  // -- boot: the title over the golden hour, the logotype, no audio yet ---------------------
  const boot = await page.evaluate(() => ({
    state: window.__sunbay.state,
    audioState: window.__sunbay.audio.state(),
    logotype: Boolean(document.querySelector('#screens canvas[data-logotype]')),
    titleVisible: window.__sunbay.screens.isTitleVisible(),
    sky: `#${window.__sunbay.scene.background.getHexString()}`,
    sunY: window.__sunbay.city.sun.position.y,
    sunLow: window.__sunbay.city.sun.position.y < 120,
    minimapFrames: window.__sunbay.minimap.frames,
    drawCalls: window.__sunbay.drawCalls,
  }));

  // -- the gesture: PLAY creates the context and starts the loop ----------------------------
  await page.click('button:has-text("PLAY")');
  await page.waitForTimeout(2200);
  await page.evaluate(() => window.__sunbay.advance(1.2));
  await page.waitForTimeout(1200);

  const afterPlay = await page.evaluate(() => {
    const audio = window.__sunbay.audio.snapshot();
    return {
      state: window.__sunbay.state,
      audioState: window.__sunbay.audio.state(),
      ready: window.__sunbay.audio.ready,
      musicOn: audio.musicPlaying,
      musicStarts: audio.counters.musicStarts,
      volume: audio.volume,
      muted: audio.muted,
      mapFrames: window.__sunbay.minimap.frames,
      mapPainted: window.__sunbay.minimap.paintedPixels(),
      mapSize: window.__sunbay.minimap.canvas.width,
      drawCalls: window.__sunbay.drawCalls,
    };
  });

  // -- fire the pistol: a shot sound and a muzzle flash ------------------------------------
  const shot = await page.evaluate(() => {
    const before = window.__sunbay.audio.counters.shots;
    window.__sunbay.tests.setAmmo(12, 48);
    const fired = window.__sunbay.tests.fire();
    window.__sunbay.advance(0.1);
    return {
      fired,
      before,
      after: window.__sunbay.audio.counters.shots,
      muzzle: window.__sunbay.effects.stats().totals.muzzle,
      sparks: window.__sunbay.effects.stats().totals.sparks,
      state: window.__sunbay.audio.state(),
    };
  });

  // -- punch a pedestrian at close range: the thud and the scatter -------------------------
  const punch = await page.evaluate(() => {
    const before = window.__sunbay.audio.counters.hits;
    window.__sunbay.tests.punch();
    window.__sunbay.advance(0.2);
    return { before, after: window.__sunbay.audio.counters.hits };
  });

  // -- drive: engine voice, handbrake smoke and skid marks ---------------------------------
  const driving = await page.evaluate(() => {
    // Stand beside a real traffic car, take it, and let the engine settle.
    const car = window.__sunbay.traffic.cars[0];
    if (!car) return { entered: false };
    window.__sunbay.teleport(car.position.x + 2.5, car.position.z + 0.5, car.heading);
    const id = window.__sunbay.enterCarAt(car.position.x + 2.5, car.position.z + 0.5);
    if (!id) return { entered: false, at: { x: car.position.x, z: car.position.z } };
    window.__sunbay.advance(0.4);
    return {
      entered: true,
      driving: window.__sunbay.driving,
      engineOn: window.__sunbay.audio.engineOn,
    };
  });

  await page.keyboard.down('w');
  await page.evaluate(() => window.__sunbay.advance(2.6));
  const rolling = await page.evaluate(() => ({
    speed: window.__sunbay.vehicles.active?.speed ?? 0,
    engineOn: window.__sunbay.audio.engineOn,
    counters: { ...window.__sunbay.audio.counters },
  }));
  await page.keyboard.down(' ');
  await page.evaluate(() => window.__sunbay.advance(1.3));
  const drifted = await page.evaluate(() => {
    const stats = window.__sunbay.effects.stats();
    return {
      smokeLive: stats.live.smoke,
      smokeTotal: stats.live.smoke + stats.totals.smoke,
      skidCounters: stats.totals.skids,
      skidSounds: window.__sunbay.audio.counters.skids,
      skidOn: window.__sunbay.audio.skidOn,
      speed: window.__sunbay.vehicles.active?.speed ?? 0,
    };
  });
  await page.keyboard.up(' ');
  await page.keyboard.up('w');
  await page.evaluate(() => window.__sunbay.advance(0.5));

  // Screen shake, then an explosion on a civilian car: a fire burst and a jolt.
  const exploded = await page.evaluate(() => {
    const car = window.__sunbay.traffic.cars[0];
    if (!car) return { ok: false };
    car.health = 100;
    window.__sunbay.effects.damageCar(car, 90);
    const smoking = car.health;
    let guard = 0;
    while (car.health > 0 && guard < 20) {
      window.__sunbay.effects.damageCar(car, 40);
      guard += 1;
    }
    window.__sunbay.advance(0.25);
    const stats = window.__sunbay.effects.stats();
    return {
      ok: true,
      smoking,
      health: car.health,
      exploded: Boolean(car.exploded),
      explosions: stats.totals.explosions,
      shake: window.__sunbay.effects.shakeAmount,
      fireLive: stats.live.fire,
    };
  });

  // -- the minimap: painted pixels, zoom keys, the rotating arrow --------------------------
  const mapBefore = await page.evaluate(() => ({
    range: window.__sunbay.minimap.zoom,
    index: window.__sunbay.minimap.zoomIndex,
    painted: window.__sunbay.minimap.paintedPixels(),
  }));
  await page.keyboard.press('=');
  await page.waitForTimeout(120);
  const mapZoomed = await page.evaluate(() => ({
    range: window.__sunbay.minimap.zoom,
    index: window.__sunbay.minimap.zoomIndex,
  }));
  await page.keyboard.press('-');
  await page.waitForTimeout(120);
  const mapBack = await page.evaluate(() => window.__sunbay.minimap.zoomIndex);

  // -- a chase: cruisers flash on the map, the siren sounds --------------------------------
  const chase = await page.evaluate(() => {
    window.__sunbay.leaveCar();
    window.__sunbay.setWanted(3);
    window.__sunbay.advance(2.2);
    const painted = window.__sunbay.minimap.paintedPixels();
    return {
      level: window.__sunbay.police.level,
      cars: window.__sunbay.police.cars.length,
      sirenCounter: window.__sunbay.audio.counters.sirens,
      painted,
    };
  });

  // -- the pause menu: volume slider, mute toggle, stats -----------------------------------
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const paused = await page.evaluate(() => {
    const slider = document.querySelector('#screens input[data-action="volume"]');
    return {
      state: window.__sunbay.state,
      pauseVisible: window.__sunbay.screens.isPauseVisible(),
      slider: Boolean(slider),
      sliderValue: slider ? Number(slider.value) : null,
      muteLabel: document.querySelector('#screens button[data-action="mute"]')?.textContent ?? '',
      restart: Boolean(document.querySelector('#screens button[data-action="restart"]')),
      musicOff: !window.__sunbay.audio.musicPlaying,
      statsRows: document.querySelectorAll('#screens button[data-action="restart"]').length,
    };
  });

  // Drag the slider through the app's own setting path and read the master gain back.
  const volume = await page.evaluate(() => {
    const before = window.__sunbay.settings.volume;
    const applied = window.__sunbay.settings.setVolume(0.25);
    window.__sunbay.screens.setAudio(applied, window.__sunbay.settings.muted);
    const slider = document.querySelector('#screens input[data-action="volume"]');
    return { before, applied, sliderValue: slider ? Number(slider.value) : null };
  });

  const muted = await page.evaluate(() => {
    const before = window.__sunbay.settings.muted;
    window.__sunbay.settings.toggleMute();
    return {
      before,
      after: window.__sunbay.settings.muted,
      gain: window.__sunbay.audio.context
        ? window.__sunbay.audio.context.destination.numberOfInputs : -1,
    };
  });
  // The N key toggles it back, from the keyboard path.
  await page.keyboard.press('n');
  await page.waitForTimeout(200);
  const unmuted = await page.evaluate(() => ({
    muted: window.__sunbay.settings.muted,
    label: document.querySelector('#screens button[data-action="mute"]')?.textContent ?? '',
  }));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);

  // -- the money chime and the mission fanfare ----------------------------------------------
  const chimes = await page.evaluate(() => {
    const before = window.__sunbay.audio.counters.chimes;
    window.__sunbay.economy.addMoney(100, 'test');
    window.__sunbay.audio.chime();
    const fanfareBefore = window.__sunbay.audio.counters.fanfares;
    window.__sunbay.audio.fanfare();
    return {
      before,
      after: window.__sunbay.audio.counters.chimes,
      fanfareBefore,
      fanfareAfter: window.__sunbay.audio.counters.fanfares,
    };
  });

  // -- the shot: golden-hour city with the HUD and the minimap ------------------------------
  await page.evaluate(() => {
    window.__sunbay.teleport(-6, 10, Math.PI / 2);
    window.__sunbay.setWanted(2);
    window.__sunbay.mission.start('first-drop').ok;
    window.__sunbay.advance(0.8);
  });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: SHOT });

  const finalState = await page.evaluate(() => ({
    state: window.__sunbay.state,
    drawCalls: window.__sunbay.drawCalls,
    mapFrames: window.__sunbay.minimap.frames,
    mapPainted: window.__sunbay.minimap.paintedPixels(),
    audioState: window.__sunbay.audio.state(),
  }));

  const checks = {
    'the title boots with the logotype and no audio yet': boot.state === 'menu'
      && boot.logotype && boot.titleVisible && boot.audioState === null,
    'the city is golden hour with a low sun': boot.sunY > 0 && boot.sunY < 120 && boot.sunLow
      && boot.sky === '#f2c295',
    'PLAY creates a running AudioContext': afterPlay.state === 'playing'
      && afterPlay.ready && ['running', 'suspended'].includes(afterPlay.audioState)
      && afterPlay.audioState === 'running',
    'the menu starts the synthwave loop': afterPlay.musicOn && afterPlay.musicStarts >= 1,
    'the pistol fires a shot and a muzzle flash': shot.fired
      && shot.after === shot.before + 1 && shot.muzzle >= 1 && shot.sparks >= 1,
    'a punch plays the impact thud': punch.after === punch.before + 1,
    'taking a car starts the engine voice': driving.entered && driving.driving,
    'the handbrake makes tyre smoke and skid marks': drifted.smokeLive > 0
      && drifted.skidCounters + drifted.skidSounds > 0,
    'the engine and skid voices follow the car': rolling.engineOn && drifted.skidOn,
    'a wrecked car explodes with fire and a shake': exploded.ok && exploded.exploded
      && exploded.health === 0 && exploded.explosions >= 1 && exploded.fireLive > 0,
    'the minimap canvas paints real pixels': mapBefore.painted > 800
      && afterPlay.mapPainted > 800 && finalState.mapPainted > 800,
    'the minimap rotates with the player': boot.minimapFrames >= 0
      && afterPlay.mapFrames > boot.minimapFrames,
    '+ and - zoom the map': mapZoomed.index === mapBefore.index + 1
      && mapZoomed.range > mapBefore.range && mapBack === mapBefore.index,
    'a chase puts blips on the map and sirens in the air': chase.level >= 2
      && chase.cars >= 1 && chase.sirenCounter >= 1 && chase.painted > 800,
    'Esc opens the pause menu with a volume slider': paused.state === 'paused'
      && paused.pauseVisible && paused.slider && paused.restart,
    'the pause menu silences the music': paused.musicOff,
    'the volume slider sets the master volume': volume.applied === 0.25
      && volume.sliderValue === 25,
    'the mute toggle works from the panel and from N': muted.after === !muted.before
      && unmuted.muted === false,
    'pickups chime and jobs fanfare': chimes.after === chimes.before + 1
      && chimes.fanfareAfter === chimes.fanfareBefore + 1,
    'the game still runs after the polish': finalState.state === 'playing'
      && finalState.audioState === 'running',
    'draw calls stay under the budget': finalState.drawCalls <= 550,
    'no page errors': pageErrors.length === 0,
  };

  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }
  notes.push(`audio=${finalState.audioState} drawCalls=${finalState.drawCalls} `
    + `mapPainted=${finalState.mapPainted} sky=${boot.sky} sunY=${boot.sunY.toFixed(1)}`);
  if (consoleErrors.length) console.log(`console errors:\n  ${consoleErrors.join('\n  ')}`);
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join('\n  ')}`);

  const allPassed = Object.values(checks).every(Boolean);
  verdict = allPassed ? 'PASS' : 'FAIL';
  detail = notes.join(' | ');
} catch (error) {
  detail = `exception: ${error && error.stack ? error.stack : error}`;
  if (consoleErrors.length) detail += `\nconsole errors:\n  ${consoleErrors.join('\n  ')}`;
  if (pageErrors.length) detail += `\npage errors:\n  ${pageErrors.join('\n  ')}`;
} finally {
  if (browser) await browser.close();
  await new Promise((ok) => server.close(ok));
}

console.log(`${verdict} ${detail}`);
if (verdict !== 'PASS') {
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join('\n  ')}`);
  process.exitCode = 1;
}
