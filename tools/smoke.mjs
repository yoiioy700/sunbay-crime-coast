// Headless smoke test for the Sunbay M1 build. Serves game/ on a local port, opens it in the
// pinned Playwright Chromium with SwiftShader for WebGL, clicks PLAY, runs a second, presses W,
// and checks that a WebGL canvas exists, the player actually moved, and no page error fired.
//
//   NODE_PATH=/root/dac-game/node_modules node tools/smoke.mjs
//
// The screenshot goes to /tmp/sunbay-smoke.png, never into the repository.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/dac-game/node_modules/playwright-core/index.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME_ROOT = join(REPO, 'game');
const SHOT = '/tmp/sunbay-smoke.png';
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
  // SwiftShader software GL renders ~1 fps: small viewport + a long key hold keep the
  // movement check meaningful without demanding real-GPU frame rates.
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error && error.stack ? error.stack : error)));
  page.on('requestfailed', (request) => consoleErrors.push(`requestfailed ${request.url()}`));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sunbay), null, { timeout: 20000 });

  const hasCanvas = await page.evaluate(() => {
    const canvas = document.getElementById('game');
    if (!canvas) return false;
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  });

  const stateBefore = await page.evaluate(() => window.__sunbay.state);
  await page.click('button:has-text("PLAY")');
  await page.waitForTimeout(3000);
  const stateAfterPlay = await page.evaluate(() => window.__sunbay.state);

  const before = await page.evaluate(() => {
    const p = window.__sunbay.player.position;
    return { x: p.x, z: p.z };
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(6000);
  await page.keyboard.up('w');
  const after = await page.evaluate(() => {
    const p = window.__sunbay.player.position;
    return { x: p.x, z: p.z, drawCalls: window.__sunbay.drawCalls, state: window.__sunbay.state };
  });

  await page.screenshot({ path: SHOT });

  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  const checks = {
    'webgl canvas': hasCanvas,
    'clicked play started run': stateBefore === 'menu' && stateAfterPlay === 'playing',
    'player moved with W': moved > 0.5,
    'no page errors': pageErrors.length === 0,
  };
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`moved ${moved.toFixed(2)} m, state ${after.state}, draw calls ${after.drawCalls}`);
  if (consoleErrors.length) console.log(`console errors:\n  ${consoleErrors.join('\n  ')}`);
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join('\n  ')}`);

  const allPassed = Object.values(checks).every(Boolean);
  verdict = allPassed ? 'PASS' : 'FAIL';
  detail = `moved=${moved.toFixed(2)}m drawCalls=${after.drawCalls} consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`;
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
