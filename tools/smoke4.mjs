// Headless smoke test for the Sunbay M4 build (missions, economy, save). Serves game/ on a
// local port, opens it in the pinned Playwright Chromium with SwiftShader for WebGL, clicks
// PLAY, and then drives the systems through their debug hooks, because SwiftShader draws
// about a frame a second and waiting for a mission timer in real time would test the
// renderer, not the game.
//
// It checks: a fresh run has $500 and no Continue button; mission 1 starts through the hook
// and puts its objective text on the HUD and a marker in the world plus a minimap blip; the
// phone lists the job; completing the job pays its reward once, raises the mission count and
// shows the completion banner; a shop purchase takes money and adds the goods, and the
// dealer's car lands in the garage list; the autosave written on the purchase survives a page
// reload, and Continue on the title restores the money, the mission count and the garage.
// A screenshot of the mission HUD goes to /tmp/sunbay-mission.png, never into the repository.
//
//   NODE_PATH=/root/dac-game/node_modules node tools/smoke4.mjs

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/dac-game/node_modules/playwright-core/index.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME_ROOT = join(REPO, 'game');
const SHOT = '/tmp/sunbay-mission.png';
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
  await page.waitForFunction(() => Boolean(window.__sunbay && window.__sunbay.missions), null, {
    timeout: 30000,
  });

  const boot = await page.evaluate(() => ({
    state: window.__sunbay.state,
    money: window.__sunbay.money,
    missionsDone: window.__sunbay.missions.done,
    shops: window.__sunbay.economy.shops.length,
    continueVisible: window.__sunbay.screens.isContinueVisible(),
    saveEmpty: window.__sunbay.save.has() === false,
  }));

  await page.click('button:has-text("PLAY")');
  await page.waitForTimeout(1200);
  const playing = await page.evaluate(() => ({
    state: window.__sunbay.state,
    money: window.__sunbay.money,
    blips: window.__sunbay.missions.blips().length + window.__sunbay.economy.blips().length,
  }));

  // -- mission 1: start, objective, marker ---------------------------------------------------
  const started = await page.evaluate(() => {
    const result = window.__sunbay.mission.start('first-drop');
    window.__sunbay.advance(0.4);
    return {
      ok: result.ok,
      active: window.__sunbay.mission.active?.id ?? null,
      objective: document.querySelector('#hud [data-objective]')?.textContent ?? '',
      marker: window.__sunbay.mission.marker,
      markerVisible: window.__sunbay.missions.markerVisible,
      banner: window.__sunbay.hud.bannerVisible(),
      bannerText: window.__sunbay.hud.bannerText(),
      blipCount: document.querySelectorAll('#hud [data-blips] > div').length,
      phoneOpen: window.__sunbay.missions.phoneVisible,
    };
  });

  // The phone lists the running job.
  const phone = await page.evaluate(() => {
    window.__sunbay.missions.openPhone();
    return {
      visible: window.__sunbay.missions.phoneVisible,
      text: window.__sunbay.missions.phoneText,
    };
  });
  // Teleport to the mission's marker so the screenshot shows the world marker close up.
  await page.evaluate(() => {
    const marker = window.__sunbay.mission.marker;
    if (marker) window.__sunbay.teleport(marker.x - 12, marker.z + 8, Math.PI / 2);
    window.__sunbay.missions.closePhone();
    window.__sunbay.advance(0.5);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: SHOT });

  // -- complete mission 1: reward, count, banner ---------------------------------------------
  const completed = await page.evaluate(() => {
    const before = window.__sunbay.money;
    const result = window.__sunbay.mission.complete();
    window.__sunbay.advance(0.2);
    return {
      ok: result.ok,
      before,
      after: window.__sunbay.money,
      done: window.__sunbay.mission.done,
      active: window.__sunbay.mission.active,
      banner: window.__sunbay.hud.bannerVisible(),
      bannerText: window.__sunbay.hud.bannerText(),
      objective: document.querySelector('#hud [data-objective]')?.textContent ?? '',
    };
  });

  // -- a purchase: the pistol ammo pack, then a car -------------------------------------------
  const bought = await page.evaluate(() => {
    window.__sunbay.economy.addMoney(3000, 'test');
    const beforeAmmo = window.__sunbay.combat.state.reserve;
    const ammoResult = window.__sunbay.buy('ammo-9mm', 'arms');
    const afterAmmo = window.__sunbay.combat.state.reserve;
    const beforeCar = window.__sunbay.money;
    const carResult = window.__sunbay.buy('car-sedan', 'dealer');
    return {
      ammoOk: ammoResult.ok,
      beforeAmmo,
      afterAmmo,
      ammoPrice: ammoResult.price,
      carOk: carResult.ok,
      beforeCar,
      afterCar: window.__sunbay.money,
      carPrice: carResult.price,
      owned: window.__sunbay.economy.ownedCars.length,
      ownedType: window.__sunbay.economy.ownedCars[0]?.type ?? null,
      saveHas: window.__sunbay.save.has(),
      saveMoney: window.__sunbay.save.peek()?.money ?? null,
      saveDone: window.__sunbay.save.peek()?.missionsDone ?? null,
    };
  });

  // -- reload: Continue restores the save -----------------------------------------------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sunbay && window.__sunbay.missions), null, {
    timeout: 30000,
  });
  await page.waitForTimeout(600);
  const afterReload = await page.evaluate(() => ({
    state: window.__sunbay.state,
    continueVisible: window.__sunbay.screens.isContinueVisible(),
    money: window.__sunbay.money,
    missionsDone: window.__sunbay.missions.done,
    peek: window.__sunbay.save.peek(),
  }));
  await page.click('button[data-action="continue"]');
  await page.waitForTimeout(1200);
  const afterContinue = await page.evaluate(() => {
    const p = window.__sunbay.player.position;
    return {
      state: window.__sunbay.state,
      money: window.__sunbay.money,
      missionsDone: window.__sunbay.mission.done,
      owned: window.__sunbay.economy.ownedCars.length,
      objective: document.querySelector('#hud [data-objective]')?.textContent ?? '',
      hudMoney: document.querySelector('#hud [data-money]')?.textContent ?? '',
      x: p.x,
      z: p.z,
      withinMap: Math.abs(p.x) <= 200 && Math.abs(p.z) <= 200,
    };
  });

  const checks = {
    'booted with the debug hooks and no save': boot.state === 'menu'
      && boot.money === 500 && boot.missionsDone === 0 && boot.shops === 3
      && boot.continueVisible === false && boot.saveEmpty,
    'PLAY starts a fresh run with $500 and blips': playing.state === 'playing'
      && playing.money === 500 && playing.blips >= 3,
    'mission 1 starts through the hook': started.ok && started.active === 'first-drop',
    'the HUD shows the objective line': started.objective.includes('parcel'),
    'the world marker appears with a blip': started.markerVisible
      && Math.abs(started.marker.x - 0) < 1 && Math.abs(started.marker.z + 58) < 1
      && started.blipCount >= 4,
    'the start banner is shown': started.banner && started.bannerText.includes('FIRST DROP'),
    'the phone lists the job': phone.visible && phone.text.includes('FIRST DROP'),
    'completing pays the reward once': completed.ok && completed.after === completed.before + 400
      && completed.done === 1 && completed.active === null,
    'the completion banner names the pay': completed.banner
      && completed.bannerText.includes('COMPLETE') && completed.bannerText.includes('400'),
    'the objective clears when the job ends': completed.objective === '',
    'ammo purchase costs money and adds rounds': bought.ammoOk
      && bought.afterAmmo === bought.beforeAmmo + 24
      && bought.ammoPrice === 60,
    'car purchase costs money and enters the garage': bought.carOk
      && bought.afterCar === bought.beforeCar - bought.carPrice
      && bought.owned === 1 && bought.ownedType === 'sedan',
    'the purchase autosaved': bought.saveHas && bought.saveMoney === bought.afterCar
      && bought.saveDone === 1,
    'reload leaves the title with Continue': afterReload.state === 'menu'
      && afterReload.continueVisible === true,
    'Continue restores money and progress': afterContinue.state === 'playing'
      && afterContinue.money === afterReload.peek?.money
      && afterContinue.missionsDone === 1 && afterContinue.owned === 1,
    'Continue restores the player position': afterContinue.withinMap
      && afterContinue.x === afterReload.peek?.player?.x,
    'the HUD money matches the save': afterContinue.hudMoney
      === `$${afterReload.peek?.money.toLocaleString('en-US')}`,
    'page errors are zero': pageErrors.length === 0,
  };

  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }

  notes.push(
    `boot money $${boot.money}, shops ${boot.shops}; playing blips ${playing.blips}`,
    `mission 1: objective "${started.objective}" marker (${started.marker?.x.toFixed(1)}, ` +
      `${started.marker?.z.toFixed(1)}) blip nodes ${started.blipCount} banner "${started.bannerText.slice(0, 40)}"`,
    `complete: $${completed.before} -> $${completed.after}, done ${completed.done}, ` +
      `banner "${completed.bannerText.slice(0, 50)}"`,
    `purchase: ammo ${bought.beforeAmmo} -> ${bought.afterAmmo}, car $${bought.beforeCar} -> ` +
      `$${bought.afterCar}, owned ${bought.owned}`,
    `reload: continue ${afterReload.continueVisible}, money $${afterReload.peek?.money}, ` +
      `jobs ${afterReload.peek?.missionsDone}; continued money $${afterContinue.money} jobs ` +
      `${afterContinue.missionsDone}`,
    `pageErrors ${pageErrors.length}, consoleErrors ${consoleErrors.length}`,
  );
  for (const note of notes) console.log(note);
  if (consoleErrors.length) console.log(`console errors:\n  ${consoleErrors.join('\n  ')}`);
  if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join('\n  ')}`);

  const allPassed = Object.values(checks).every(Boolean);
  verdict = allPassed ? 'PASS' : 'FAIL';
  detail = `done=${completed.done} money=${afterContinue.money} owned=${afterContinue.owned} ` +
    `continue=${afterReload.continueVisible} pageErrors=${pageErrors.length} ` +
    `consoleErrors=${consoleErrors.length}`;
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
