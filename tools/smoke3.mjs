// Headless smoke test for the Sunbay M3 build (wanted level, police pursuit, combat, the two
// outcome screens). Serves game/ on a local port, opens it in the pinned Playwright Chromium
// with SwiftShader for WebGL, clicks PLAY, and then drives the systems through their debug
// hooks, because SwiftShader draws about a frame a second and waiting for a rare street crime
// would test the renderer, not the game.
//
// It checks: a forced three-star level brings patrol cars that close on the player over eight
// seconds; a punch beside a pedestrian makes the crowd scatter; the pistol's magazine goes down
// a round per shot and R refills it; a forced bust shows the BUSTED card and the respawn lands
// at the police station with the wanted level cleared and the fine taken; health zero shows
// WASTED and the respawn lands at the hospital; the draw calls stay under the cap. A screenshot
// of the chase goes to /tmp/sunbay-chase.png, never into the repository.
//
//   NODE_PATH=/root/dac-game/node_modules node tools/smoke3.mjs

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/dac-game/node_modules/playwright-core/index.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME_ROOT = join(REPO, 'game');
const SHOT = '/tmp/sunbay-chase.png';
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
    ],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error && error.stack ? error.stack : error)));
  page.on('requestfailed', (request) => consoleErrors.push(`requestfailed ${request.url()}`));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sunbay && window.__sunbay.police), null, { timeout: 30000 });

  const boot = await page.evaluate(() => ({
    state: window.__sunbay.state,
    traffic: window.__sunbay.traffic.cars.length,
    peds: window.__sunbay.pedestrians.peds.length,
    drawCalls: window.__sunbay.drawCalls,
    hooks: ['police', 'combat', 'setWanted', 'bust', 'teleport', 'tests']
      .every((key) => window.__sunbay[key] !== undefined),
    ammo: window.__sunbay.combat.ammo,
    health: window.__sunbay.combat.health,
  }));

  await page.click('button:has-text("PLAY")');
  await page.waitForTimeout(1200);
  const statePlaying = await page.evaluate(() => window.__sunbay.state);
  await page.evaluate(() => window.__sunbay.advance(0.5));
  await page.waitForTimeout(500);

  // -- three stars: patrol cars arrive and close in -----------------------------------------
  const chaseStart = await page.evaluate(() => {
    window.__sunbay.setWanted(3);
    window.__sunbay.advance(0.5);
    const p = window.__sunbay.player.position;
    return {
      level: window.__sunbay.police.level,
      cars: window.__sunbay.police.cars.length,
      x: p.x,
      z: p.z,
      pedsBefore: window.__sunbay.pedestrians.snapshot().filter((ped) => ped.scatter > 0).length,
    };
  });
  await page.evaluate(() => window.__sunbay.advance(8));
  await page.waitForTimeout(2500);
  const chase = await page.evaluate(() => {
    const player = window.__sunbay.player.position;
    const cars = window.__sunbay.police.cars;
    const distances = cars.map((car) =>
      Math.hypot(car.position.x - player.x, car.position.z - player.z));
    const spawns = cars.map((car) => car.spawnDistance ?? Infinity);
    return {
      level: window.__sunbay.police.level,
      cars: cars.length,
      nearest: distances.length ? Math.min(...distances) : Infinity,
      closestStart: spawns.length ? Math.min(...spawns) : Infinity,
      // How far the nearest car has closed since it spawned.
      closed: distances.length && spawns.length
        ? Math.min(...spawns) - Math.min(...distances)
        : 0,
      distances,
      roadblocks: window.__sunbay.police.roadblocks.length,
      hudStars: [...document.querySelectorAll('#hud [data-hud-star]')].length,
      wantedStarFills: [...document.querySelectorAll('#hud svg path')]
        .filter((path) => path.getAttribute('fill') === '#ffd9a0').length,
      drawCalls: window.__sunbay.drawCalls,
      chaseError: window.__sunbay.police.cars.every((car) => Number.isFinite(car.position.x)),
    };
  });
  await page.screenshot({ path: SHOT });

  // -- the street responds: the pistol and the punch ----------------------------------------
  // Stand in the open beside a pedestrian and punch toward it.
  const punchSetup = await page.evaluate(() => {
    const peds = window.__sunbay.pedestrians.peds.filter((ped) => ped.down <= 0);
    let best = peds[0];
    let bestDistance = Infinity;
    for (const ped of peds) {
      const distance = Math.hypot(ped.x - window.__sunbay.player.position.x,
        ped.z - window.__sunbay.player.position.z);
      if (distance < bestDistance) { best = ped; bestDistance = distance; }
    }
    // Stand 1.1 m south of the pedestrian and face it, so the arc test passes. The heading
    // convention is the one player.js faces the body with: atan2(dx, dz).
    const heading = Math.atan2(0, 1.1);
    window.__sunbay.teleport(best.x, best.z - 1.1, heading);
    window.__sunbay.advance(0.2);
    return { x: best.x, z: best.z, heading };
  });
  await page.evaluate(() => window.__sunbay.tests.punch());
  await page.evaluate(() => window.__sunbay.advance(0.4));
  const afterPunch = await page.evaluate(() => ({
    scattering: window.__sunbay.pedestrians.snapshot().filter((ped) => ped.scatter > 0).length,
    down: window.__sunbay.pedestrians.peds.filter((ped) => ped.down > 0).length,
  }));

  // -- the pistol: ammo down per shot, R refills -------------------------------------------
  const ammoBefore = await page.evaluate(() => window.__sunbay.combat.ammo);
  await page.evaluate(() => {
    const hud = window.__sunbay.hud;
    hud.setAmmo(window.__sunbay.combat.ammo, window.__sunbay.combat.state.reserve, false);
    window.__sunbay.tests.fire();
  });
  await page.evaluate(() => window.__sunbay.advance(0.4));
  const ammoAfterShot = await page.evaluate(() => window.__sunbay.combat.ammo);
  await page.evaluate(() => {
    window.__sunbay.tests.setAmmo(2, 30);
    window.__sunbay.tests.reload();
  });
  await page.evaluate(() => window.__sunbay.advance(1.6));
  const ammoAfterReload = await page.evaluate(() => window.__sunbay.combat.ammo);
  const hudAmmo = await page.evaluate(() =>
    document.querySelector('#hud [data-ammo]')?.textContent ?? null);

  // -- busted: hook the arrest, see the card and the respawn --------------------------------
  const bustSetup = await page.evaluate(() => {
    window.__sunbay.setWanted(3);
    return { money: window.__sunbay.money, level: window.__sunbay.police.level };
  });
  await page.evaluate(() => window.__sunbay.bust());
  await page.waitForTimeout(500);
  const bustedCard = await page.evaluate(() => ({
    state: window.__sunbay.state,
    visible: window.__sunbay.screens.isOutcomeVisible(),
    title: window.__sunbay.screens.outcomeTitle.textContent,
    money: window.__sunbay.money,
  }));
  // Wait out the wall-clock respawn countdown.
  await page.waitForTimeout(4200);
  const afterBust = await page.evaluate(() => {
    const p = window.__sunbay.player.position;
    const station = window.__sunbay.police.station;
    return {
      state: window.__sunbay.state,
      level: window.__sunbay.police.level,
      cars: window.__sunbay.police.cars.length,
      distanceToStation: Math.hypot(p.x - station.x, p.z - station.z),
      outcomeVisible: window.__sunbay.screens.isOutcomeVisible(),
      health: window.__sunbay.combat.health,
    };
  });

  // -- wasted: the health path, the hospital respawn ----------------------------------------
  await page.evaluate(() => {
    window.__sunbay.setWanted(2);
    window.__sunbay.tests.setHealth(1);
    window.__sunbay.hurt(10);
  });
  await page.waitForTimeout(500);
  const wastedCard = await page.evaluate(() => ({
    state: window.__sunbay.state,
    title: window.__sunbay.screens.outcomeTitle.textContent,
    visible: window.__sunbay.screens.isOutcomeVisible(),
  }));
  await page.waitForTimeout(4200);
  const afterWasted = await page.evaluate(() => {
    const p = window.__sunbay.player.position;
    return {
      state: window.__sunbay.state,
      health: window.__sunbay.combat.health,
      level: window.__sunbay.police.level,
      hospitalDistance: Math.hypot(p.x - 99, p.z - 33),
    };
  });
  await page.waitForTimeout(800);
  const final = await page.evaluate(() => ({
    drawCalls: window.__sunbay.drawCalls,
    money: window.__sunbay.money,
  }));

  const checks = {
    'booted with the debug hooks': boot.hooks && boot.traffic >= 15 && boot.peds >= 20,
    'PLAY started the run': boot.state === 'menu' && statePlaying === 'playing',
    'pistol starts with ammo, body at full health': boot.ammo === 12 && boot.health === 100,
    'three stars set': chaseStart.level === 3,
    'police cars spawned': chase.cars >= 2 && chase.level === 3,
    'police approach over 8 s': chase.closed > 20 && chase.nearest < 40,
    'wanted stars fill the HUD': chase.wantedStarFills === 3 && chaseStart.pedsBefore >= 0,
    'punch scattered pedestrians': afterPunch.scattering > 0 || afterPunch.down > 0,
    'pistol shot spent a round': ammoAfterShot === ammoBefore - 1,
    'R reloaded the magazine': ammoAfterReload === 12,
    'HUD shows the magazine': Number(hudAmmo) === ammoAfterReload,
    'bust shows the BUSTED card': bustedCard.state === 'busted' && bustedCard.visible
      && bustedCard.title === 'BUSTED',
    'bust took a fine': bustedCard.money < bustSetup.money,
    'respawn cleared the wanted level': afterBust.state === 'playing' && afterBust.level === 0,
    'respawn is at the police station': afterBust.distanceToStation < 6,
    'outcome card hidden after respawn': afterBust.outcomeVisible === false,
    'zero health shows WASTED': wastedCard.state === 'wasted' && wastedCard.visible
      && wastedCard.title === 'WASTED',
    'wasted respawn heals and clears police': afterWasted.state === 'playing'
      && afterWasted.health === 100 && afterWasted.level === 0,
    'wasted respawn is at the hospital': afterWasted.hospitalDistance < 6,
    'page errors are zero': pageErrors.length === 0,
  };

  const drawCallsOk = chase.drawCalls <= 500 && final.drawCalls <= 500;
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`${drawCallsOk ? 'ok  ' : 'FAIL'} draw calls within 500`);

  notes.push(
    `boot traffic ${boot.traffic} peds ${boot.peds}`,
    `stars ${chaseStart.level} cars ${chase.cars} nearest ${chase.nearest.toFixed(1)} m ` +
      `closed ${chase.closed.toFixed(1)} m (distances ${chase.distances.map((d) => d.toFixed(0)).join(',')}), ` +
      `roadblocks ${chase.roadblocks}`,
    `ammo ${ammoBefore} -> ${ammoAfterShot} -> reload ${ammoAfterReload} (HUD ${hudAmmo})`,
    `busted fine $${bustSetup.money - bustedCard.money}, station ${afterBust.distanceToStation.toFixed(1)} m; ` +
      `wasted hospital ${afterWasted.hospitalDistance.toFixed(1)} m`,
    `draw calls ${chase.drawCalls}/${final.drawCalls} (max 500), pageErrors ${pageErrors.length}`,
  );
  for (const note of notes) console.log(note);
  if (consoleErrors.length) console.log(`console errors:\n  ${consoleErrors.join('\n  ')}`);
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join('\n  ')}`);

  const allPassed = Object.values(checks).every(Boolean) && drawCallsOk;
  verdict = allPassed ? 'PASS' : 'FAIL';
  detail = `cars=${chase.cars} nearest=${chase.nearest.toFixed(1)} ammo=${ammoAfterShot} ` +
    `drawCalls=${chase.drawCalls} pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length}`;
} catch (error) {
  detail = `exception: ${error && error.stack ? error.stack : error}`;
  if (consoleErrors.length) detail += `\nconsole errors:\n  ${consoleErrors.join('\n  ')}`;
  if (pageErrors.length) detail += `\npage errors:\n  ${pageErrors.join('\n  ')}`;
} finally {
  if (browser) await browser.close();
  await new Promise((ok) => server.close(ok));
}

console.log(`${verdict} ${detail}`);
if (verdict !== 'PASS') process.exitCode = 1;
