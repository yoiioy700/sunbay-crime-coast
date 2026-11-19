// The money and the three shops on the crossroads around the spawn: a car dealer, a gun shop
// and a spray booth. Each shop is a glowing pad in the world with a blip on the minimap; stand
// on one and its price panel opens along the right of the screen, where 1..3 buy the row.
//
// Nothing here is a menu state: the pads are read from the player's position every frame, and
// a purchase is a key press or a debug-hook call, so the game keeps playing while you shop.
// Money, the cars bought and the SMG's ownership are the only state; the magazine and reserve
// stay in combat.js and are nudged through callbacks, and the cars are made by the spawn
// callback main.js hands in, which keeps this file free of the vehicle and scene plumbing.

import * as THREE from 'three';

/** Where the three shops stand. All are on the avenue/cross-street asphalt, so no building
 *  can ever sit on a pad. */
export const SHOPS = [
  {
    id: 'dealer',
    name: 'CORAL MOTORS',
    tagline: 'BUY · DRIVE · KEEP',
    x: -22,
    z: 0,
    color: '#ffcf92',
    blip: '#ffcf92',
  },
  {
    id: 'arms',
    name: 'PIER 4 ARMS',
    tagline: 'CASH ONLY · NO NAMES',
    x: 0,
    z: -22,
    color: '#ff8a63',
    blip: '#ff8a63',
  },
  {
    id: 'spray',
    name: 'SUNBAY SPRAY',
    tagline: 'NEW COAT · NEW PLATES',
    x: 0,
    z: 22,
    color: '#64d3ff',
    blip: '#64d3ff',
  },
];

/** The cars on the dealer's lot. Kept cheap enough that the first two jobs pay for one. */
export const DEALER_CARS = [
  { id: 'car-sedan', type: 'sedan', label: 'SUNSET SEDAN', price: 1200, color: '#3f86c4' },
  { id: 'car-sports', type: 'sports', label: 'COASTLINE GT', price: 6500, color: '#d8452f', discounted: true },
  { id: 'car-van', type: 'van', label: 'HARBOR VAN', price: 1600, color: '#f2efe6' },
];

/** The spray booth's palette, cycled one repaint at a time. */
export const SPRAY_COLORS = [
  '#d8452f', '#e8b13f', '#3f86c4', '#f2efe6', '#3f8f77',
  '#c46f9b', '#e06f2c', '#2f4a63', '#b9c2c9', '#6d8a4c',
];

export const AMMO_PACK = 24;
export const AMMO_PRICE = 60;
export const SMG_PRICE = 1200;
export const SMG_ROUNDS = 60;
export const REPAINT_PRICE = 150;
export const SHOP_RADIUS = 9;

const STYLE = {
  panel: 'position:absolute;right:22px;top:104px;width:314px;display:none;pointer-events:none;' +
    'padding:14px 16px 12px;border-radius:8px;border:1px solid rgba(255,244,226,0.24);' +
    'background:linear-gradient(165deg,rgba(14,34,45,0.94),rgba(7,18,25,0.95));' +
    'box-shadow:0 16px 40px rgba(0,0,0,0.45);font-family:ui-sans-serif,system-ui,sans-serif;color:#fff4e2;',
};

/** A pad on the ground: a thin ring, a translucent disc and a low column of light. */
function buildShopPad(scene, shop) {
  const group = new THREE.Group();
  group.position.set(shop.x, 0.02, shop.z);
  const color = new THREE.Color(shop.color);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.25, 2.75, 32),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 28),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.9, 5, 18, 1, true),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.1, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
  );
  column.position.y = 2.5;
  group.add(ring, disc, column);
  scene.add(group);
  return { group, ring, disc, column };
}

/**
 * The economy: money, the garage, the SMG flag and the shop pads and price panels.
 * Callbacks main.js supplies: `spawnCar({type,color,x,z,heading})`, `onAmmo(rounds)`,
 * `onWeapon(name)`, `onRepaint(color)`, `onMoney(amount, delta)`, `onPurchase(result)`.
 */
export function createEconomy(scene, root, options = {}) {
  const {
    spawnCar = () => null,
    getMissionsDone = () => 0,
    getActiveCar = () => null,
    onAmmo = null,
    onWeapon = null,
    onRepaint = null,
    onMoney = null,
    onPurchase = null,
  } = options;

  const state = {
    money: 500,
    ownedCars: [],
    smgOwned: false,
    sprayIndex: 0,
    purchases: 0,
  };

  const pads = SHOPS.map((shop) => ({ shop, ...buildShopPad(scene, shop) }));
  let nearShop = null;
  let panelSignature = '';
  let panelShopId = null;

  // -- the price panel ----------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText = STYLE.panel;
  const panelTitle = document.createElement('div');
  panelTitle.style.cssText = 'font-size:11px;letter-spacing:0.34em;color:#ffcf92';
  const panelTag = document.createElement('div');
  panelTag.style.cssText = 'font-size:9px;letter-spacing:0.18em;color:rgba(255,244,226,0.5);margin-top:4px';
  const panelRule = document.createElement('div');
  panelRule.style.cssText = 'height:1px;background:rgba(255,244,226,0.14);margin:10px 0 8px';
  const rowsBox = document.createElement('div');
  panel.append(panelTitle, panelTag, panelRule, rowsBox);
  panel.dataset.shop = '';
  root.appendChild(panel);

  const rowNodes = [];

  function ensureRows(count) {
    while (rowNodes.length < count) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:9px;padding:5px 0;font-size:11px;';
      const key = document.createElement('span');
      key.style.cssText = 'flex:none;width:20px;height:20px;border-radius:4px;background:#ffcf92;' +
        'color:#20160c;display:grid;place-items:center;font-weight:800;font-size:10px';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1;letter-spacing:0.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const price = document.createElement('span');
      price.style.cssText = 'flex:none;color:#d9ffc0;font-weight:700;font-variant-numeric:tabular-nums';
      row.append(key, label, price);
      rowsBox.appendChild(row);
      rowNodes.push({ row, key, label, price });
    }
  }

  /** The stock of one shop as buyable rows. */
  function stockFor(shopId) {
    if (shopId === 'dealer') {
      const missionsDone = getMissionsDone();
      return DEALER_CARS.map((car) => ({
        id: car.id,
        label: car.label,
        price: car.discounted && missionsDone >= 5 ? Math.round(car.price * 0.8) : car.price,
        kind: 'car',
        car,
        note: car.discounted && missionsDone >= 5 ? 'DOCK PRICE' : '',
      }));
    }
    if (shopId === 'arms') {
      const rows = [
        { id: 'ammo-9mm', label: `9MM ROUNDS ×${AMMO_PACK}`, price: AMMO_PRICE, kind: 'ammo' },
      ];
      if (state.smgOwned) {
        rows.push({ id: 'ammo-smg', label: `SMG ROUNDS ×${SMG_ROUNDS}`, price: 120, kind: 'smgAmmo' });
      } else if (getMissionsDone() >= 3) {
        rows.push({ id: 'smg', label: 'SMG + 60 ROUNDS', price: SMG_PRICE, kind: 'smg' });
      } else {
        rows.push({
          id: 'smg', label: 'SMG · AFTER 3 JOBS', price: SMG_PRICE, kind: 'smg-locked', locked: true,
        });
      }
      return rows;
    }
    return [{
      id: 'repaint',
      label: getActiveCar() ? 'FULL REPAINT' : 'REPAINT · BRING A CAR',
      price: REPAINT_PRICE,
      kind: 'repaint',
      locked: !getActiveCar(),
    }];
  }

  function renderPanel() {
    if (!nearShop) {
      panel.style.display = 'none';
      panelShopId = null;
      panelSignature = '';
      return;
    }
    const shop = nearShop;
    const rows = stockFor(shop.id);
    const car = getActiveCar();
    const signature = `${shop.id}|${state.money}|${state.smgOwned}|${getMissionsDone()}|${car ? car.color : '-'}`;
    if (signature === panelSignature) return;
    panelSignature = signature;
    panelShopId = shop.id;
    panel.style.display = 'block';
    panel.dataset.shop = shop.id;
    panelTitle.textContent = shop.name;
    panelTitle.style.color = shop.color;
    panelTag.textContent = shop.tagline;
    ensureRows(rows.length);
    rows.forEach((item, index) => {
      const node = rowNodes[index];
      node.row.style.display = 'flex';
      node.key.textContent = String(index + 1);
      const affordable = state.money >= item.price && !item.locked;
      const extra = item.note ? ` · ${item.note}` : '';
      node.label.textContent = item.label + extra;
      node.label.style.color = item.locked ? 'rgba(255,244,226,0.34)'
        : affordable ? 'rgba(255,244,226,0.9)' : 'rgba(255,120,100,0.85)';
      node.price.textContent = item.locked ? 'LOCKED' : `$${item.price.toLocaleString('en-US')}`;
      node.price.style.color = item.locked ? 'rgba(255,244,226,0.3)'
        : affordable ? '#d9ffc0' : '#ff7a63';
      node.key.style.opacity = item.locked ? '0.3' : '1';
      node.row.dataset.item = item.id;
      node.row.dataset.locked = item.locked ? '1' : '0';
    });
  }

  // -- money --------------------------------------------------------------------------------
  function changeMoney(amount) {
    const before = state.money;
    state.money = Math.max(0, Math.round(state.money + amount));
    const delta = state.money - before;
    if (delta !== 0) onMoney?.(state.money, delta);
    return state.money;
  }

  function addMoney(amount, reason = 'income') {
    void reason;
    return changeMoney(Math.max(0, Math.round(amount)));
  }

  /** Takes `amount` if it is there. Returns true when paid. */
  function spend(amount) {
    const price = Math.max(0, Math.round(amount));
    if (state.money < price) return false;
    changeMoney(-price);
    return true;
  }

  function setMoney(amount) {
    state.money = Math.max(0, Math.round(amount));
    onMoney?.(state.money, 0);
    panelSignature = '';
    return state.money;
  }

  /** The dealer's lot, clear of the pad and the driving lane. */
  const LOT = [
    { x: -27, z: 4.2, heading: Math.PI / 2 },
    { x: -21, z: 4.2, heading: Math.PI / 2 },
    { x: -15, z: 4.2, heading: Math.PI / 2 },
    { x: -27, z: -4.2, heading: -Math.PI / 2 },
    { x: -21, z: -4.2, heading: -Math.PI / 2 },
    { x: -15, z: -4.2, heading: -Math.PI / 2 },
  ];

  function parkOwnedCar(car, index) {
    const spot = LOT[index % LOT.length];
    return spawnCar({
      type: car.type, color: car.color, x: spot.x, z: spot.z, heading: spot.heading,
    });
  }

  /** Re-creates the saved garage on a Continue, one car per lot spot. */
  function respawnOwnedCars() {
    state.ownedCars.forEach((car, index) => parkOwnedCar(car, index));
  }

  /**
   * Buys one row of the shop currently under the player, or the row with `id` when the debug
   * hook calls it directly. Returns { ok, item, price, reason }.
   */
  function buy(id, context = {}) {
    const shopId = context.shop ?? panelShopId ?? (nearShop ? nearShop.id : null);
    const missionsDone = getMissionsDone();
    let shop = SHOPS.find((entry) => entry.id === shopId);
    if (!shop) {
      // A direct hook call names no shop: find the one that stocks the item.
      shop = SHOPS.find((entry) => stockFor(entry.id).some((row) => row.id === id));
      shopId = shop ? shop.id : null;
    }
    if (!shop) return { ok: false, reason: 'no such shop' };
    const rows = stockFor(shop.id);
    const item = rows.find((row) => row.id === id);
    if (!item) return { ok: false, reason: 'not stocked here' };
    if (item.locked || item.kind === 'smg-locked') {
      return { ok: false, reason: item.kind === 'smg-locked' ? 'the SMG opens after three jobs' : 'locked' };
    }
    if (state.money < item.price) {
      const result = { ok: false, reason: 'not enough money', item, price: item.price };
      onPurchase?.(result);
      return result;
    }
    // The sale itself: money out, then the goods.
    changeMoney(-item.price);
    state.purchases += 1;
    let result = { ok: true, item, price: item.price, shop: shop.id };

    if (item.kind === 'car') {
      const owned = { type: item.car.type, color: item.car.color };
      state.ownedCars.push(owned);
      const car = parkOwnedCar(owned, state.ownedCars.length - 1);
      result = { ...result, car, owned };
    } else if (item.kind === 'ammo') {
      onAmmo?.(AMMO_PACK, 'pistol');
    } else if (item.kind === 'smg') {
      state.smgOwned = true;
      onWeapon?.('smg');
      onAmmo?.(SMG_ROUNDS, 'smg');
    } else if (item.kind === 'smgAmmo') {
      onAmmo?.(SMG_ROUNDS, 'smg');
    } else if (item.kind === 'repaint') {
      const active = getActiveCar();
      if (active) {
        state.sprayIndex = (state.sprayIndex + 1) % SPRAY_COLORS.length;
        onRepaint?.(SPRAY_COLORS[state.sprayIndex], active);
        result = { ...result, color: SPRAY_COLORS[state.sprayIndex] };
      }
    }
    panelSignature = '';
    onPurchase?.(result);
    return result;
  }

  /** Key 1..9 at a shop. */
  function buyKey(key, context = {}) {
    const shop = nearShop;
    if (!shop) return { ok: false, reason: 'no shop nearby' };
    const rows = stockFor(shop.id);
    const item = rows[key - 1];
    if (!item) return { ok: false, reason: 'no such row' };
    return buy(item.id, { shop: shop.id, ...context });
  }

  /** Per-frame: pick the pad under the player, open its panel, pulse the pads. */
  function update(dt, playerPosition, elapsed) {
    nearShop = null;
    let best = SHOP_RADIUS;
    for (const pad of pads) {
      const distance = Math.hypot(playerPosition.x - pad.shop.x, playerPosition.z - pad.shop.z);
      if (distance < best) {
        best = distance;
        nearShop = pad.shop;
      }
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.2 + pad.shop.x * 0.1);
      pad.ring.material.opacity = 0.42 + pulse * 0.3;
      pad.column.material.opacity = 0.06 + pulse * 0.07;
    }
    renderPanel();
  }

  function blips() {
    return SHOPS.map((shop) => ({ x: shop.x, z: shop.z, color: shop.blip, kind: 'shop' }));
  }

  function snapshot() {
    return {
      money: state.money,
      ownedCars: state.ownedCars.map((car) => ({ ...car })),
      smgOwned: state.smgOwned,
    };
  }

  function restore(data = {}) {
    state.money = Number.isFinite(data.money) ? Math.max(0, Math.round(data.money)) : 500;
    state.ownedCars = Array.isArray(data.ownedCars)
      ? data.ownedCars.filter((car) => car && typeof car.type === 'string').map((car) => ({
        type: car.type, color: typeof car.color === 'string' ? car.color : '#b9c2c9',
      }))
      : [];
    state.smgOwned = Boolean(data.smgOwned);
    state.sprayIndex = 0;
    panelSignature = '';
    onMoney?.(state.money, 0);
    return snapshot();
  }

  function reset() {
    state.money = 500;
    state.ownedCars = [];
    state.smgOwned = false;
    state.sprayIndex = 0;
    state.purchases = 0;
    panelSignature = '';
    onMoney?.(state.money, 0);
  }

  return {
    shops: SHOPS,
    dealerCars: DEALER_CARS,
    addMoney,
    spend,
    setMoney,
    buy,
    buyKey,
    update,
    blips,
    snapshot,
    restore,
    reset,
    respawnOwnedCars,
    stockFor,
    get money() {
      return state.money;
    },
    get ownedCars() {
      return state.ownedCars;
    },
    get smgOwned() {
      return state.smgOwned;
    },
    get nearShop() {
      return nearShop;
    },
    /** The panel's rows as text, for the smoke test. */
    panelRows() {
      return stockFor(nearShop ? nearShop.id : 'dealer');
    },
    get panelVisible() {
      return panel.style.display !== 'none';
    },
    get panelText() {
      return panel.textContent;
    },
    state,
  };
}
