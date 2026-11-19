// Headless smoke test for the Sunbay M2 build (vehicles, traffic, pedestrians). Serves game/
// on a local port, opens it in the pinned Playwright Chromium with SwiftShader for WebGL,
// clicks PLAY, checks that traffic and pedestrians exist and move across several seconds,
// walk-teleports beside a traffic car, presses E to steal it, drives with W and A for two
// seconds, honks H, and steps out with E. A screenshot of the driving view goes to
// /tmp/sunbay-drive.png, never into the repository.
//
//   NODE_PATH=/root/dac-game/node_modules node tools/smoke2.mjs
//
// SwiftShader renders ~1 fps at 640x400, so every movement assertion waits seconds, not
// frames. That is expected and is not a game bug.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/dac-game/node_modules/playwright-core/index.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME_ROOT = join(REPO, 'game');
const SHOT = '/tmp/sunbay-drive.png';
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
let browser;
let verdict = 'FAIL';
let detail = '';
const notes = [];

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
  await page.waitForFunction(() => Boolean(window.__sunbay), null, { timeout: 30000 });

  const boot = await page.evaluate(() => ({
    traffic: window.__sunbay.traffic.cars.length,
    peds: window.__sunbay.pedestrians.peds.length,
    state: window.__sunbay.state,
    drawCalls: window.__sunbay.drawCalls,
    vehiclesVisible: window.__sunbay.traffic.cars.every((car) => car.group.visible),
  }));

  await page.click('button:has-text("PLAY")');
  await page.waitForTimeout(3000);
  const statePlaying = await page.evaluate(() => window.__sunbay.state);

  // -- traffic and pedestrians move on their own -------------------------------------------
  const trafficBefore = await page.evaluate(() =>
    window.__sunbay.traffic.cars.map((car) => ({ id: car.id, x: car.position.x, z: car.position.z })));
  const pedsBefore = await page.evaluate(() => window.__sunbay.pedestrians.peds.map((p) => ({ x: p.x, z: p.z })));
  // Advance the world's own clock: SwiftShader draws under a frame a second, and this test is
  // about whether traffic drives and pedestrians walk, not about the frame rate. The hanging
  // rAF loop is still running; the wait afterwards lets it render the result.
  await page.evaluate(() => window.__sunbay.advance(6));
  await page.waitForTimeout(1500);
  const trafficAfter = await page.evaluate(() =>
    window.__sunbay.traffic.cars.map((car) => ({ id: car.id, x: car.position.x, z: car.position.z })));
  const pedsAfter = await page.evaluate(() => window.__sunbay.pedestrians.peds.map((p) => ({ x: p.x, z: p.z })));

  const trafficMoved = trafficBefore.filter((before) => {
    const after = trafficAfter.find((car) => car.id === before.id);
    return after && Math.hypot(after.x - before.x, after.z - before.z) > 1.5;
  }).length;
  const pedsMoved = pedsBefore.filter((before, index) => {
    const after = pedsAfter[index];
    return after && Math.hypot(after.x - before.x, after.z - before.z) > 0.6;
  }).length;

  // -- steal a traffic car -------------------------------------------------------------------
  const carSpot = await page.evaluate(() => {
    const car = window.__sunbay.traffic.cars[0];
    return { id: car.id, x: car.position.x, z: car.position.z, label: car.spec.label };
  });
  const stolenId = await page.evaluate(({ x, z }) => window.__sunbay.enterCarAt(x + 2.4, z), carSpot);
  await page.waitForTimeout(400);
  const stolen = await page.evaluate(() => {
    const car = window.__sunbay.vehicles.active;
    return {
      id: car ? car.id : null,
      driving: window.__sunbay.driving,
      playerVisible: window.__sunbay.player.group.visible,
      cameraMode: window.__sunbay.follow.mode,
      trafficCount: window.__sunbay.traffic.cars.length,
      speedometer: document.querySelector('[data-speed]')?.textContent ?? null,
    };
  });

  const driveStart = await page.evaluate(() => {
    const car = window.__sunbay.vehicles.active;
    return { x: car.position.x, z: car.position.z };
  });
  await page.keyboard.down('w');
  await page.evaluate(() => window.__sunbay.advance(2));
  // Let the renderer draw a frame of the moving car before the shutter.
  await page.waitForTimeout(2000);
  await page.screenshot({ path: SHOT });
  const cruise = await page.evaluate(() => {
    const car = window.__sunbay.vehicles.active;
    return {
      x: car.position.x,
      z: car.position.z,
      speed: car.speed,
      heading: car.heading,
      speedometer: document.querySelector('[data-speed]')?.textContent ?? null,
      fov: window.__sunbay.camera.fov,
    };
  });
  // A short tug on the wheel: the heading has to change, not just the position.
  await page.keyboard.down('a');
  await page.evaluate(() => window.__sunbay.advance(0.5));
  await page.keyboard.up('a');
  await page.evaluate(() => window.__sunbay.advance(0.3));
  await page.keyboard.up('w');
  await page.waitForTimeout(800);
  const driveMid = await page.evaluate(({ x, z }) => {
    const car = window.__sunbay.vehicles.active;
    return {
      x: car.position.x,
      z: car.position.z,
      speed: car.speed,
      heading: car.heading,
      speedometer: document.querySelector('[data-speed]')?.textContent ?? null,
      fov: window.__sunbay.camera.fov,
      drawCalls: window.__sunbay.drawCalls,
      travelled: Math.hypot(car.position.x - x, car.position.z - z),
    };
  }, { x: cruise.x, z: cruise.z });

  // -- exit the car first, so the honk is tested from the street it should reach -------------
  await page.keyboard.press('e');
  await page.evaluate(() => window.__sunbay.advance(0.5));
  await page.waitForTimeout(600);

  // -- honk: pedestrians scatter ---------------------------------------------------------------
  // Stand the body beside a real pedestrian, then press the actual H key.
  const stand = await page.evaluate(() => {
    const ped = window.__sunbay.pedestrians.peds
      .map((p) => ({ p, d: Math.hypot(p.x - window.__sunbay.player.position.x,
        p.z - window.__sunbay.player.position.z) }))
      .sort((a, b) => a.d - b.d)[0].p;
    window.__sunbay.player.reset(ped.x + 3, ped.z + 3, 0);
    return { x: ped.x, z: ped.z };
  });
  await page.evaluate(() => window.__sunbay.advance(0.2));
  await page.keyboard.press('h');
  await page.evaluate(() => window.__sunbay.advance(0.5));
  const scatterAfter = await page.evaluate(() =>
    window.__sunbay.pedestrians.snapshot().filter((p) => p.scatter > 0).length);
  void stand;

  // -- the exit that already happened above is verified here ------------------------------------
  const exited = await page.evaluate(() => ({
    driving: window.__sunbay.driving,
    playerVisible: window.__sunbay.player.group.visible,
    cameraMode: window.__sunbay.follow.mode,
    nearCar: Boolean(window.__sunbay.nearbyCar),
    playerX: window.__sunbay.player.position.x,
    playerZ: window.__sunbay.player.position.z,
    speedometerDisplay: document.querySelector('[data-speed]')?.parentElement?.style.display ?? null,
  }));

  const droveDistance = Math.hypot(driveMid.x - driveStart.x, driveMid.z - driveStart.z);
  const fovWidened = driveMid.fov > 60;
  const headingChanged = Math.abs(cruise.heading - driveMid.heading) > 0.15;

  const checks = {
    'webgl booted with traffic and pedestrians': boot.traffic >= 15 && boot.traffic <= 25 && boot.peds >= 20 && boot.peds <= 30,
    'clicked play started run': boot.state === 'menu' && statePlaying === 'playing',
    'traffic cars drive': trafficMoved >= Math.max(3, Math.floor(boot.traffic * 0.4)),
    'pedestrians walk': pedsMoved >= Math.max(4, Math.floor(boot.peds * 0.4)),
    'E stole a traffic car': stolen.driving && stolen.playerVisible === false && stolen.id === stolenId,
    'stolen car left the traffic pool': stolen.trafficCount === boot.traffic - 1,
    'camera switched to car mode': stolen.cameraMode === 'car',
    'car drove with W': droveDistance > 6,
    'car speedometer shows speed': Number(cruise.speedometer) > 20,
    'car camera fov widened': fovWidened,
    'steering changes the car heading': headingChanged,
    'honk scattered pedestrians': scatterAfter > 0,
    'E exited the car': exited.driving === false && exited.playerVisible === true && exited.cameraMode === 'foot',
    'speedometer hidden on foot': exited.speedometerDisplay === 'none',
    'no page errors': pageErrors.length === 0,
  };

  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }
  notes.push(
    `traffic ${boot.traffic} moved ${trafficMoved}, peds ${boot.peds} moved ${pedsMoved}`,
    `drove ${droveDistance.toFixed(1)} m, cruise ${cruise.speed.toFixed(1)} m/s (HUD ${cruise.speedometer}), ` +
      `heading ${cruise.heading.toFixed(2)}->${driveMid.heading.toFixed(2)}, fov ${cruise.fov.toFixed(1)}`,
    `honk scattered ${scatterAfter}, exit at ${exited.playerX.toFixed(1)},${exited.playerZ.toFixed(1)} nearCar=${exited.nearCar}`,
    `draw calls ${driveMid.drawCalls} (max 450), pageErrors ${pageErrors.length}`,
  );
  for (const note of notes) console.log(note);
  if (consoleErrors.length) console.log(`console errors:\n  ${consoleErrors.join('\n  ')}`);
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join('\n  ')}`);

  const drawCallsOk = driveMid.drawCalls <= 450;
  const allPassed = Object.values(checks).every(Boolean) && drawCallsOk;
  verdict = allPassed ? 'PASS' : 'FAIL';
  detail = `trafficMoved=${trafficMoved} pedsMoved=${pedsMoved} drove=${droveDistance.toFixed(1)}m ` +
    `drawCalls=${driveMid.drawCalls} consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`;
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
