// The HUD, built as DOM over the canvas: a money counter and a five-slot wanted meter at the
// top right (the browser's own menu lives top left, so that corner stays clear), a health bar
// and the minimap frame at the bottom left, and a mission line along the bottom. Numbers are
// written only when they change, so a steady frame touches no DOM. All styles are inline in
// the elements; no external font or sheet is loaded.
//
// The minimap is a placeholder frame in this milestone: the north marker, a live player dot
// and two district pins show where the real map will be drawn.

const CSS = {
  panel: 'position:absolute;color:#fff4e2;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;',
};

export function createHud(root) {
  root.innerHTML = '';

  const moneyBox = document.createElement('div');
  moneyBox.style.cssText = `${CSS.panel} top:16px; right:22px; text-align:right; text-shadow:0 2px 8px rgba(0,0,0,0.55);`;
  moneyBox.innerHTML = `
    <div style="font-size:26px;font-weight:800;letter-spacing:0.02em;color:#d9ffc0;line-height:1.05">$0</div>
    <div style="font-size:10px;letter-spacing:0.3em;color:rgba(255,244,226,0.72);margin-top:2px">SUNBAY BANK</div>
  `;
  const moneyValue = moneyBox.firstElementChild;

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

  const mapBox = document.createElement('div');
  mapBox.style.cssText = `${CSS.panel} left:22px; bottom:150px; width:210px; height:210px;`;
  mapBox.innerHTML = `
    <div style="position:absolute;inset:0;border-radius:10px;border:1px solid rgba(255,244,226,0.4);
        background:linear-gradient(160deg,rgba(17,42,55,0.85),rgba(9,20,27,0.9));
        box-shadow:0 8px 22px rgba(0,0,0,0.35);overflow:hidden">
      <div style="position:absolute;inset:11px;border:1px dashed rgba(255,244,226,0.16);border-radius:6px"></div>
      <div data-map-dot style="position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;
          border-radius:50%;background:#ffe0a8;box-shadow:0 0 0 3px rgba(255,224,168,0.22)"></div>
      <div data-pin-a style="position:absolute;left:66%;top:38%;width:6px;height:6px;margin:-3px;
          background:#ff8a63;transform:rotate(45deg)"></div>
      <div data-pin-b style="position:absolute;left:38%;top:62%;width:6px;height:6px;margin:-3px;
          background:#64d3ff;transform:rotate(45deg)"></div>
      <div style="position:absolute;left:50%;top:6px;transform:translateX(-50%);font-size:9px;
          letter-spacing:0.22em;color:rgba(255,244,226,0.62)">N</div>
      <div style="position:absolute;left:8px;bottom:6px;font-size:9px;letter-spacing:0.18em;
          color:rgba(255,244,226,0.55)">SUNBAY</div>
    </div>
  `;

  const objective = document.createElement('div');
  objective.style.cssText = `${CSS.panel} left:50%; bottom:26px; transform:translateX(-50%); max-width:min(720px, 68vw);
      font-size:13px; letter-spacing:0.06em; text-align:center; color:rgba(255,244,226,0.86);
      text-shadow:0 2px 8px rgba(0,0,0,0.7);`;
  objective.textContent = '';

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
  prompt.style.cssText = `${CSS.panel} left:50%; bottom:64px; transform:translateX(-50%);
      display:none; padding:8px 16px; border-radius:6px; border:1px solid rgba(255,244,226,0.26);
      background:rgba(9,20,27,0.66); font-size:12px; letter-spacing:0.12em; color:#fff4e2;
      text-shadow:0 1px 6px rgba(0,0,0,0.6); white-space:nowrap;`;
  const promptKey = document.createElement('span');
  promptKey.style.cssText = 'display:inline-block;margin-right:9px;padding:2px 7px;border-radius:4px;' +
    'background:#ffcf92;color:#20160c;font-weight:800;font-size:11px;letter-spacing:0.08em';
  const promptText = document.createElement('span');
  prompt.append(promptKey, promptText);

  root.append(mapBox, healthBox, moneyBox, wantedBox, objective, controlsHint, speedBox, prompt);

  let lastMoney = null;
  let lastHealth = null;
  let lastWanted = null;
  let lastSpeed = null;
  let lastCarName = null;
  let lastPrompt = null;

  /** Money as a whole-dollar, comma-grouped figure; the counter is fed by the game's economy. */
  function setMoney(amount) {
    if (amount === lastMoney) return;
    lastMoney = amount;
    moneyValue.textContent = `$${amount.toLocaleString('en-US')}`;
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

  /** 0..5 filled stars; empty slots stay as faint outlines. */
  function setWanted(level) {
    const clamped = Math.max(0, Math.min(5, Math.round(level)));
    if (clamped === lastWanted) return;
    lastWanted = clamped;
    stars.forEach((star, index) => {
      const lit = index < clamped;
      star.style.opacity = lit ? '1' : '0.42';
      const path = star.querySelector('path');
      path.setAttribute('fill', lit ? '#ffd9a0' : '#1b2026');
    });
    wantedLabel.style.color = clamped > 0 ? '#ffd9a0' : 'rgba(255,244,226,0.7)';
  }

  /** The current mission line, empty when there is no active objective. */
  function setObjective(text) {
    objective.textContent = text ?? '';
  }

  /** The minimap's live dot: `bearing` is the player's heading in radians, north is up. */
  function setPlayerBearing(bearing) {
    const dot = mapBox.querySelector('[data-map-dot]');
    dot.style.transform = `rotate(${bearing}rad)`;
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
  }

  setMoney(0);
  setHealth(100);
  setWanted(0);
  setObjective('');

  return {
    show,
    hide,
    setMoney,
    setHealth,
    setWanted,
    setObjective,
    setPlayerBearing,
    setDriving,
    setPrompt,
  };
}
