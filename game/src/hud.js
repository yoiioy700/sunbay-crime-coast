// The HUD, built as DOM over the canvas: a money counter and a five-slot wanted meter at the
// top right (the browser's own menu lives top left, so that corner stays clear), a health bar
// and the minimap at the bottom left, an ammo counter by the health, and a mission line
// along the bottom. Numbers are written only when they change, so a steady frame touches no
// DOM. The wanted stars pulse while a crime is fresh, the screen takes a red vignette as the
// body is hurt, and the full-screen BUSTED/WASTED cards live in screens.js. All styles are
// inline in the elements; no external font or sheet is loaded.
//
// The minimap is north-up around the player: the live player dot at its centre, and blips
// for the current mission objective, Mama Rosa's booth and the three shops, each clamped to
// the map's rim when it is out of range. The mission banner (start/complete/fail) and the
// money-change figure are also DOM here, because this is the one module that owns the HUD.

const CSS = {
  panel: 'position:absolute;color:#fff4e2;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;',
};

/** How far the minimap sees, in metres: the radius of its inner square. */
const MAP_RANGE = 88;

const HUD_STYLE_ID = 'sunbay-hud-keyframes';

/** The keyframes for the rising money figure; injected once, never an external sheet. */
function ensureKeyframes() {
  if (document.getElementById(HUD_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HUD_STYLE_ID;
  style.textContent = `
    @keyframes sunbay-money-rise {
      0% { opacity: 0; transform: translateY(6px) scale(0.92); }
      18% { opacity: 1; transform: translateY(0) scale(1); }
      100% { opacity: 0; transform: translateY(-26px) scale(1); }
    }
    @keyframes sunbay-banner-in {
      0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.97); }
      12% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
      82% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
      100% { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(1); }
    }
    @keyframes sunbay-banner-line {
      0% { width: 0%; }
      100% { width: 100%; }
    }
  `;
  document.head.appendChild(style);
}

export function createHud(root) {
  root.innerHTML = '';

  const moneyBox = document.createElement('div');
  moneyBox.style.cssText = `${CSS.panel} top:16px; right:22px; text-align:right; text-shadow:0 2px 8px rgba(0,0,0,0.55);`;
  moneyBox.innerHTML = `
    <div style="position:relative">
      <div data-money style="font-size:26px;font-weight:800;letter-spacing:0.02em;color:#d9ffc0;line-height:1.05">$0</div>
      <div data-money-delta style="position:absolute;right:0;top:100%;font-size:13px;font-weight:800;
          letter-spacing:0.04em;opacity:0;white-space:nowrap"></div>
    </div>
    <div style="font-size:10px;letter-spacing:0.3em;color:rgba(255,244,226,0.72);margin-top:2px">SUNBAY BANK</div>
  `;
  const moneyValue = moneyBox.querySelector('[data-money]');
  const moneyDelta = moneyBox.querySelector('[data-money-delta]');

  const wantedBox = document.createElement('div');
  wantedBox.style.cssText = `${CSS.panel} top:64px; right:22px; display:flex; gap:5px; align-items:center;`;
  const stars = [];
  for (let index = 0; index < 5; index += 1) {
    const star = document.createElement('div');
    star.style.cssText = [
      'width:19px;height:19px;position:relative;opacity:0.42;',
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5));',
    ].join('');
    star.innerHTML = `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path d="M12 2.6l2.9 6 6.6 0.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-0.9z"
        fill="#1b2026" stroke="#ffd9a0" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    wantedBox.appendChild(star);
    stars.push(star);
  }
  const wantedLabel = document.createElement('div');
  wantedLabel.style.cssText = 'font-size:9px;letter-spacing:0.24em;color:rgba(255,244,226,0.7);margin-left:4px';
  wantedLabel.textContent = 'WANTED';
  wantedBox.appendChild(wantedLabel);

  const healthBox = document.createElement('div');
  healthBox.style.cssText = `${CSS.panel} left:22px; bottom:102px; width:210px;`;
  healthBox.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:10px;letter-spacing:0.24em;color:rgba(255,244,226,0.8);margin-bottom:5px">
      <span>HEALTH</span><span data-hp>100</span>
    </div>
    <div style="height:8px;background:rgba(9,18,24,0.62);border:1px solid rgba(255,244,226,0.3);border-radius:4px;overflow:hidden">
      <div data-bar style="height:100%;width:100%;background:linear-gradient(90deg,#57c98a,#a9e05f);transition:width 0.2s ease"></div>
    </div>
  `;
  const healthBar = healthBox.querySelector('[data-bar]');
  const healthValue = healthBox.querySelector('[data-hp]');

  // The pistol: magazine, reserve, and a reload line that appears while the swap runs.
  const ammoBox = document.createElement('div');
  ammoBox.style.cssText = `${CSS.panel} left:22px; bottom:76px; display:flex; align-items:flex-end; gap:8px;
      text-shadow:0 2px 6px rgba(0,0,0,0.6)`;
  ammoBox.innerHTML = `
    <div data-ammo style="font-size:22px;font-weight:800;color:#ffe0a8;line-height:1">12</div>
    <div data-reserve style="font-size:11px;color:rgba(255,244,226,0.68);padding-bottom:3px">/ 48</div>
    <div data-reload style="font-size:9px;letter-spacing:0.2em;color:#ffb36a;padding-bottom:4px;display:none">RELOADING</div>
    <div style="font-size:9px;letter-spacing:0.24em;color:rgba(255,244,226,0.5);padding-bottom:4px">9MM · R</div>
  `;
  const ammoValue = ammoBox.querySelector('[data-ammo]');
  const reserveValue = ammoBox.querySelector('[data-reserve]');
  const reloadLabel = ammoBox.querySelector('[data-reload]');

  // The damage vignette: a red edge that flares when the body is hurt and fades away.
  const vignette = document.createElement('div');
  vignette.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;' +
    'background:radial-gradient(ellipse at 50% 50%, rgba(150,12,8,0) 42%, rgba(150,12,8,0.55) 100%);' +
    'transition:opacity 0.25s ease';

  const mapBox = document.createElement('div');
  mapBox.style.cssText = `${CSS.panel} left:22px; bottom:150px; width:210px; height:210px;`;
  mapBox.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:10px;border:1px solid rgba(255,244,226,0.4);
        background:linear-gradient(160deg,rgba(17,42,55,0.85),rgba(9,20,27,0.9));
        box-shadow:0 8px 22px rgba(0,0,0,0.35);overflow:hidden">
      <div style="position:absolute;inset:11px;border:1px dashed rgba(255,244,226,0.16);border-radius:6px"></div>
      <div data-blips style="position:absolute;inset:11px;border-radius:6px;overflow:hidden"></div>
      <div data-map-dot style="position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;
          border-radius:50%;background:#ffe0a8;box-shadow:0 0 0 3px rgba(255,224,168,0.22);z-index:2"></div>
      <div style="position:absolute;left:50%;top:6px;transform:translateX(-50%);font-size:9px;
          letter-spacing:0.22em;color:rgba(255,244,226,0.62)">N</div>
      <div style="position:absolute;left:8px;bottom:6px;font-size:9px;letter-spacing:0.18em;
          color:rgba(255,244,226,0.55)">SUNBAY</div>
    </div>
  `;
  const blipLayer = mapBox.querySelector('[data-blips]');
  const mapDot = mapBox.querySelector('[data-map-dot]');
  // One pooled node per blip, re-shown each time the list changes; the map keeps no model.
  const blipNodes = [];

  /** Sets the blips drawn on the minimap; each { x, z, color, kind, label? }. */
  function setBlips(blips, originX, originZ) {
    const list = blips ?? [];
    while (blipNodes.length < list.length) {
      const node = document.createElement('div');
      node.style.cssText = 'position:absolute;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;' +
        'border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,0.35)';
      blipLayer.appendChild(node);
      blipNodes.push(node);
    }
    blipNodes.forEach((node, index) => {
      const blip = list[index];
      if (!blip) {
        node.style.display = 'none';
        return;
      }
      const dx = blip.x - originX;
      const dz = blip.z - originZ;
      const distance = Math.hypot(dx, dz);
      const scale = Math.min(1, MAP_RANGE / Math.max(0.001, distance));
      const left = 50 + (dx / MAP_RANGE) * 50 * scale;
      const top = 50 + (dz / MAP_RANGE) * 50 * scale;
      node.style.display = 'block';
      node.style.left = `${Math.max(2, Math.min(98, left))}%`;
      node.style.top = `${Math.max(2, Math.min(98, top))}%`;
      node.style.background = blip.color ?? '#ffd05e';
      const objective = blip.kind === 'objective';
      node.style.width = objective ? '9px' : '6px';
      node.style.height = objective ? '9px' : '6px';
      node.style.margin = objective ? '-4.5px 0 0 -4.5px' : '-3px 0 0 -3px';
      node.style.borderRadius = blip.kind === 'shop' ? '1px' : '50%';
      node.style.transform = blip.kind === 'shop' ? 'rotate(45deg)' : 'none';
      node.style.opacity = distance > MAP_RANGE ? '0.75' : '1';
    });
  }

  const objective = document.createElement('div');
  objective.style.cssText = `${CSS.panel} left:50%; bottom:82px; transform:translateX(-50%);
      max-width:min(640px, 48vw); font-size:clamp(11px,1.05vw,13px); letter-spacing:0.06em;
      text-align:center; color:rgba(255,244,226,0.86); line-height:1.4;
      text-shadow:0 2px 8px rgba(0,0,0,0.7), 0 0 14px rgba(0,0,0,0.5);`;
  objective.textContent = '';
  objective.dataset.objective = '';

  // The mission banner: a card that slides in at the top centre for a start, a completion or
  // a failure, holds for four seconds and fades. Only one is shown at a time.
  const banner = document.createElement('div');
  banner.style.cssText = `${CSS.panel} left:50%; top:16px; transform:translateX(-50%); text-align:center;
      width:min(520px, 44vw); min-width:240px; padding:10px 18px 11px; border-radius:7px;
      border:1px solid rgba(255,244,226,0.24); background:linear-gradient(165deg,rgba(12,30,40,0.94),rgba(6,16,22,0.95));
      box-shadow:0 16px 38px rgba(0,0,0,0.45); display:none; opacity:0;`;
  banner.dataset.banner = '';
  banner.innerHTML = `
    <div data-banner-kicker style="font-size:8px;letter-spacing:0.32em;color:#ffcf92"></div>
    <div data-banner-title style="margin-top:4px;font-size:clamp(17px,2vw,24px);font-weight:900;letter-spacing:0.01em;line-height:1.08"></div>
    <div data-banner-sub style="margin-top:5px;font-size:10px;line-height:1.45;color:rgba(255,244,226,0.72)"></div>
    <div data-banner-reward style="margin-top:5px;font-size:15px;font-weight:800;color:#d9ffc0;display:none"></div>
    <div data-banner-note style="margin-top:4px;font-size:8px;letter-spacing:0.18em;color:#ffd9a0;display:none"></div>
    <div data-banner-line style="position:absolute;left:0;bottom:0;height:2px;background:#ffcf92;width:0%"></div>
  `;
  const bannerKicker = banner.querySelector('[data-banner-kicker]');
  const bannerTitle = banner.querySelector('[data-banner-title]');
  const bannerSub = banner.querySelector('[data-banner-sub]');
  const bannerReward = banner.querySelector('[data-banner-reward]');
  const bannerNote = banner.querySelector('[data-banner-note]');
  const bannerLine = banner.querySelector('[data-banner-line]');
  banner.style.overflow = 'hidden';

  const controlsHint = document.createElement('div');
  controlsHint.style.cssText = `${CSS.panel} right:22px; bottom:22px; font-size:10px; letter-spacing:0.16em;
      color:rgba(255,244,226,0.5); text-align:right; line-height:1.7`;
  controlsHint.innerHTML = 'WASD MOVE · SHIFT SPRINT · SPACE JUMP · E ENTER CAR<br>MOUSE LOOK · WHEEL ZOOM · ESC PAUSE';

  // The speedometer: a round gauge bottom right, hidden on foot. The needle sweeps a quarter
  // turn either side of straight up, so 0 is at -120° and the top speed at +120°.
  const speedBox = document.createElement('div');
  speedBox.style.cssText = `${CSS.panel} right:22px; bottom:60px; width:148px; height:148px; display:none;`;
  speedBox.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:50%;border:1px solid rgba(255,244,226,0.34);
        background:radial-gradient(circle at 50% 55%,rgba(10,26,35,0.9),rgba(7,18,25,0.96));
        box-shadow:0 10px 26px rgba(0,0,0,0.4), inset 0 0 26px rgba(120,190,215,0.14)"></div>
    <div style="position:absolute;left:50%;top:10px;transform:translateX(-50%);font-size:8px;
        letter-spacing:0.3em;color:rgba(255,244,226,0.6)">SPEED</div>
    <div data-needle style="position:absolute;left:50%;top:50%;width:3px;height:52px;margin-left:-1.5px;
        transform-origin:50% 100%;background:linear-gradient(180deg,#ffcf92,rgba(255,207,146,0.25));
        transform:translateY(-100%) rotate(-120deg);border-radius:2px"></div>
    <div style="position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px;border-radius:50%;
        background:#ffcf92;box-shadow:0 0 0 3px rgba(255,207,146,0.2)"></div>
    <div data-speed style="position:absolute;left:0;right:0;bottom:20px;text-align:center;
        font-size:30px;font-weight:800;color:#fff4e2;line-height:1">0</div>
    <div style="position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:8px;
        letter-spacing:0.28em;color:rgba(255,244,226,0.55)">KM/H</div>
    <div data-car-name style="position:absolute;left:0;right:0;top:24px;text-align:center;font-size:8px;
        letter-spacing:0.22em;color:rgba(255,207,146,0.85)">SEDAN</div>
  `;
  const needle = speedBox.querySelector('[data-needle]');
  const speedValue = speedBox.querySelector('[data-speed]');
  const carName = speedBox.querySelector('[data-car-name]');

  // The interaction prompt, centred above the objective line.
  const prompt = document.createElement('div');
  prompt.style.cssText = `${CSS.panel} left:50%; bottom:46px; transform:translateX(-50%);
      display:none; padding:7px 14px; border-radius:6px; border:1px solid rgba(255,244,226,0.26);
      background:rgba(9,20,27,0.66); font-size:12px; letter-spacing:0.12em; color:#fff4e2;
      text-shadow:0 1px 6px rgba(0,0,0,0.6); white-space:nowrap;`;
  const promptKey = document.createElement('span');
  promptKey.style.cssText = 'display:inline-block;margin-right:9px;padding:2px 7px;border-radius:4px;' +
    'background:#ffcf92;color:#20160c;font-weight:800;font-size:11px;letter-spacing:0.08em';
  const promptText = document.createElement('span');
  prompt.append(promptKey, promptText);

  root.append(vignette, mapBox, healthBox, ammoBox, moneyBox, wantedBox, objective, controlsHint,
    speedBox, prompt, banner);

  let lastMoney = null;
  let lastHealth = null;
  let lastWanted = null;
  let lastAmmo = null;
  let lastReserve = null;
  let lastReload = null;
  let flashUntil = 0;
  let wantedFlashTimer = 0;
  let damageTimer = 0;
  let lastSpeed = null;
  let lastCarName = null;
  let lastPrompt = null;
  let moneyTimer = 0;
  let bannerTimer = 0;

  /** Money as a whole-dollar, comma-grouped figure; the counter is fed by the game's economy. */
  function setMoney(amount) {
    const value = Math.round(Number(amount) || 0);
    if (value === lastMoney) return;
    lastMoney = value;
    moneyValue.textContent = `$${value.toLocaleString('en-US')}`;
  }

  /**
   * The money counter plus a rise-and-fade change figure: green for income, red for a spend,
   * and a short tint of the total in the same colour.
   */
  function showMoneyChange(amount, delta) {
    setMoney(amount);
    const change = Math.round(Number(delta) || 0);
    if (!change) return;
    ensureKeyframes();
    const income = change > 0;
    moneyDelta.textContent = `${income ? '+' : '-'}$${Math.abs(change).toLocaleString('en-US')}`;
    moneyDelta.style.color = income ? '#9dffb0' : '#ff9a85';
    moneyDelta.style.animation = 'none';
    void moneyDelta.offsetWidth;
    moneyDelta.style.animation = 'sunbay-money-rise 1.5s ease-out forwards';
    moneyValue.style.color = income ? '#e8ffd6' : '#ffb3a4';
    moneyTimer = 0.55;
  }

  /**
   * The mission card: a start, a completion with its pay, or a failure. `detail` carries
   * kicker, title, subtitle, reward and note.
   */
  function showBanner(kind, detail = {}) {
    ensureKeyframes();
    const palette = kind === 'complete'
      ? { accent: '#9dffb0', kicker: '#9dffb0' }
      : kind === 'fail'
        ? { accent: '#ff7a63', kicker: '#ffb08f' }
        : { accent: '#ffd9a0', kicker: '#ffcf92' };
    const accent = detail.accent ?? palette.accent;
    bannerKicker.textContent = detail.kicker ?? '';
    bannerKicker.style.color = palette.kicker;
    bannerTitle.textContent = detail.title ?? '';
    bannerTitle.style.color = accent;
    bannerTitle.style.textShadow = `0 0 26px ${accent}55`;
    bannerSub.textContent = detail.subtitle ?? '';
    bannerSub.style.display = detail.subtitle ? 'block' : 'none';
    if (detail.reward) {
      bannerReward.textContent = `+$${Number(detail.reward).toLocaleString('en-US')}`;
      bannerReward.style.display = 'block';
    } else {
      bannerReward.style.display = 'none';
    }
    if (detail.note) {
      bannerNote.textContent = detail.note;
      bannerNote.style.display = 'block';
    } else {
      bannerNote.style.display = 'none';
    }
    banner.style.borderColor = `${accent}55`;
    bannerLine.style.background = accent;
    banner.style.display = 'block';
    banner.style.animation = 'none';
    bannerLine.style.animation = 'none';
    void banner.offsetWidth;
    const hold = kind === 'complete' ? 5.2 : 4.2;
    banner.style.animation = `sunbay-banner-in ${hold}s ease-out forwards`;
    bannerLine.style.width = '100%';
    bannerLine.style.animation = `sunbay-banner-line ${hold}s linear forwards`;
    bannerTimer = hold;
  }

  function hideBanner() {
    banner.style.display = 'none';
    bannerTimer = 0;
  }

  /** Health 0..100; the bar turns amber, then red, as it drains. */
  function setHealth(value) {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (clamped === lastHealth) return;
    lastHealth = clamped;
    healthBar.style.width = `${clamped}%`;
    healthValue.textContent = String(clamped);
    healthBar.style.background = clamped > 55
      ? 'linear-gradient(90deg,#57c98a,#a9e05f)'
      : clamped > 25
        ? 'linear-gradient(90deg,#e2b64f,#f0d06a)'
        : 'linear-gradient(90deg,#d9553d,#ef7d5e)';
  }

  /** 0..5 filled stars; empty slots stay as faint outlines. `flashSeconds` pulses a new crime. */
  function setWanted(level, flashSeconds = 0) {
    const clamped = Math.max(0, Math.min(5, Math.round(level)));
    if (flashSeconds > 0) flashUntil = Math.max(flashUntil, flashSeconds);
    if (clamped === lastWanted && flashSeconds <= 0) return;
    lastWanted = clamped;
    stars.forEach((star, index) => {
      const lit = index < clamped;
      star.style.opacity = lit ? '1' : '0.42';
      const path = star.querySelector('path');
      path.setAttribute('fill', lit ? '#ffd9a0' : '#1b2026');
    });
    wantedLabel.style.color = clamped > 0 ? '#ffd9a0' : 'rgba(255,244,226,0.7)';
  }

  /** Per-frame flourish: pulses the wanted stars and fades the damage vignette. */
  function tick(dt) {
    if (flashUntil > 0) {
      flashUntil = Math.max(0, flashUntil - dt);
      wantedFlashTimer += dt;
      const pulse = 0.45 + 0.55 * Math.abs(Math.sin(wantedFlashTimer * 9));
      stars.forEach((star, index) => {
        if (index < lastWanted) {
          star.style.transform = `scale(${1 + pulse * 0.13})`;
          star.style.filter = `drop-shadow(0 0 ${4 + pulse * 5}px rgba(255,190,110,0.9))`;
        }
      });
      if (flashUntil === 0) {
        stars.forEach((star) => {
          star.style.transform = 'scale(1)';
          star.style.filter = 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))';
        });
      }
    }
    if (damageTimer > 0) {
      damageTimer = Math.max(0, damageTimer - dt);
      if (damageTimer === 0) vignette.style.opacity = '0';
    }
    if (moneyTimer > 0) {
      moneyTimer = Math.max(0, moneyTimer - dt);
      if (moneyTimer === 0) {
        moneyValue.style.color = '#d9ffc0';
        moneyDelta.style.animation = 'none';
      }
    }
    if (bannerTimer > 0) {
      bannerTimer = Math.max(0, bannerTimer - dt);
      if (bannerTimer === 0) hideBanner();
    }
  }

  /** Ammo: magazine, reserve, and whether a reload is under way. */
  function setAmmo(ammo, reserve = null, reloading = false) {
    if (ammo !== lastAmmo) {
      lastAmmo = ammo;
      ammoValue.textContent = String(ammo);
      ammoValue.style.color = ammo === 0 ? '#ff7a63' : ammo <= 3 ? '#ffcf92' : '#ffe0a8';
    }
    if (reserve !== null && reserve !== lastReserve) {
      lastReserve = reserve;
      reserveValue.textContent = `/ ${reserve}`;
    }
    if (reloading !== lastReload) {
      lastReload = reloading;
      reloadLabel.style.display = reloading ? 'block' : 'none';
    }
  }

  /** A red flare at the screen's edge for `seconds`; called with each wound. */
  function damageFlash(seconds = 0.9, strength = 1) {
    damageTimer = Math.max(damageTimer, seconds);
    vignette.style.opacity = String(Math.min(1, 0.45 + strength * 0.5));
  }

  /** The current mission line, empty when there is no active objective. */
  function setObjective(text) {
    objective.textContent = text ?? '';
    objective.dataset.objective = text ?? '';
    objective.style.color = text ? '#ffe3b0' : 'rgba(255,244,226,0.86)';
  }

  /** The minimap's live dot: `bearing` is the player's heading in radians, north is up. */
  function setPlayerBearing(bearing) {
    mapDot.style.transform = `rotate(${bearing}rad)`;
  }

  /**
   * The speedometer, shown only while driving. `speed` is m/s; `label` names the car; the
   * gauge is calibrated to `maxSpeed` so a fast car pins the needle further round.
   */
  function setDriving(active, speed = 0, maxSpeed = 30, label = '') {
    speedBox.style.display = active ? 'block' : 'none';
    if (!active) {
      lastSpeed = null;
      return;
    }
    const kmh = Math.round(speed * 3.6);
    if (kmh !== lastSpeed) {
      lastSpeed = kmh;
      speedValue.textContent = String(kmh);
      const ratio = Math.min(1, Math.max(0, speed / Math.max(1, maxSpeed)));
      needle.style.transform = `translateY(-100%) rotate(${-120 + ratio * 240}deg)`;
    }
    if (label !== lastCarName) {
      lastCarName = label;
      carName.textContent = label;
    }
  }

  /** The "E — enter vehicle" style prompt; pass null to hide it. */
  function setPrompt(key, text) {
    const signature = key ? `${key}\u0000${text}` : null;
    if (signature === lastPrompt) return;
    lastPrompt = signature;
    if (!signature) {
      prompt.style.display = 'none';
      return;
    }
    promptKey.textContent = key;
    promptText.textContent = text;
    prompt.style.display = 'block';
  }

  function show() {
    root.classList.remove('hidden');
  }

  function hide() {
    root.classList.add('hidden');
    hideBanner();
  }

  /** Reveals the banner's DOM (the smoke test checks it), or hides it. */
  function bannerVisible() {
    return banner.style.display !== 'none';
  }

  function bannerText() {
    return banner.textContent;
  }

  setMoney(0);
  setHealth(100);
  setWanted(0);
  setAmmo(12, 48, false);
  setObjective('');

  return {
    show,
    hide,
    setMoney,
    showMoneyChange,
    showBanner,
    hideBanner,
    bannerVisible,
    bannerText,
    setHealth,
    setWanted,
    setAmmo,
    damageFlash,
    tick,
    setObjective,
    setPlayerBearing,
    setBlips,
    setDriving,
    setPrompt,
  };
}
