// Sunbay's coast: a seeded procedural city on a 10x10 block grid, with asphalt streets and
// dashed lane paint, concrete sidewalks, 80-odd flat-shaded buildings wearing a generated
// window texture, palms and street lamps on every corner, parked cars, and a sand beach with
// an ocean along the east edge. Everything static is merged into a dozen meshes sharing two
// materials, so the whole city costs about twenty draw calls.
//
// createCity() returns the colliders the player walks into, the ground-height function that
// puts feet on the sidewalk, and a spawn point on the central crossroads.

import * as THREE from 'three';
import { createRng } from './rng.js';

/** The street plan. Ten blocks across, one road on every line, the map 330 m each way. */
export const CITY = {
  span: 330,
  gridLines: 11,
  pitch: 33,
  roadWidth: 11,
  halfSpan: 165,
  blockInterior: 22,
  sidewalkHeight: 0.18,
  /** East of the perimeter road the pavement gives way to sand, then water. */
  beachStartX: 170.5,
  waterStartX: 188,
};

const COLORS = {
  asphalt: '#3d4147',
  line: '#efe9d8',
  concrete: '#cdc5b6',
  curb: '#b7ae9e',
  sand: '#e8d3a4',
  grass: '#6f8f5c',
  trunk: '#8a6a48',
  frond: '#4f7d4a',
  frondDark: '#3d653c',
  lampMetal: '#3a3f45',
  roof: '#8f8a80',
  roofDark: '#6f6a62',
  water: '#1d7e99',
};

const BUILDING_COLORS = [
  '#f0e4cb', '#e9d3b4', '#f3efe4', '#e6b9a5', '#dc9a86', '#a9cfc2',
  '#8fbdb3', '#c9d6c0', '#e8c78f', '#d8a96f', '#f1d9c6', '#b9c8d4',
];

/** one merged-geometry bucket: positions, normals, uvs and a vertex colour per vertex */
function createBuilder() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const normalMatrix = new THREE.Matrix3();
  const vector = new THREE.Vector3();

  return {
    get empty() {
      return positions.length === 0;
    },
    /** Applies `matrix` to a copy of `geometry` shaped by `color` and keeps the result. */
    add(geometry, matrix, color) {
      const source = geometry.index ? geometry.toNonIndexed() : geometry;
      const position = source.attributes.position;
      const normal = source.attributes.normal;
      const uv = source.attributes.uv;
      normalMatrix.getNormalMatrix(matrix);
      for (let index = 0; index < position.count; index += 1) {
        vector.fromBufferAttribute(position, index).applyMatrix4(matrix);
        positions.push(vector.x, vector.y, vector.z);
        vector.fromBufferAttribute(normal, index).applyMatrix3(normalMatrix).normalize();
        normals.push(vector.x, vector.y, vector.z);
        uvs.push(uv ? uv.getX(index) : 0, uv ? uv.getY(index) : 0);
        colors.push(color.r, color.g, color.b);
      }
      if (source !== geometry) source.dispose();
    },
    /** A box of `size` [w,h,d] at [x,y,z], optionally rotated about Y, tinted `color`. */
    box(size, at, color, rotationY = 0) {
      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      if (rotationY) geometry.rotateY(rotationY);
      this.add(geometry, new THREE.Matrix4().makeTranslation(at[0], at[1], at[2]), color);
      geometry.dispose();
    },
    /** A box placed in a local frame: `at` is local, `base` maps the frame to the world. */
    boxAt(base, size, at, color) {
      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      geometry.translate(at[0], at[1], at[2]);
      this.add(geometry, base, color);
      geometry.dispose();
    },
    build(material, { castShadow = false, receiveShadow = false } = {}) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      return mesh;
    },
  };
}

/** The shared window sheet: pale facade, dark glazing, a floor line. Tinted per building. */
function createWindowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.fillStyle = '#f2eee6';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#d9d2c4';
  context.fillRect(0, size - 7, size, 7);
  context.fillStyle = '#33454f';
  for (let column = 0; column < 2; column += 1) {
    for (let row = 0; row < 2; row += 1) {
      const x = 12 + column * 60;
      const y = 11 + row * 60;
      context.fillRect(x, y, 44, 40);
      context.fillStyle = 'rgba(180, 220, 232, 0.35)';
      context.fillRect(x + 4, y + 4, 12, 32);
      context.fillStyle = '#33454f';
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Asphalt grain for the streets: a tile of speckled grey, repeated every six metres. */
function createAsphaltTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const rng = createRng(0xa5fa17);
  context.fillStyle = '#3d4147';
  context.fillRect(0, 0, size, size);
  for (let index = 0; index < 1600; index += 1) {
    const tone = rng.int(48, 84);
    context.fillStyle = `rgba(${tone},${tone + 3},${tone + 8},0.5)`;
    context.fillRect(rng.range(0, size), rng.range(0, size), 1.6, 1.6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Street surface with UVs repeated per metre, so the grain never stretches along a road. */
function roadPlane(width, length, tileMetres = 6) {
  const geometry = new THREE.PlaneGeometry(width, length);
  const uv = geometry.attributes.uv;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setXY(index, (uv.getX(index) * width) / tileMetres, (uv.getY(index) * length) / tileMetres);
  }
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** The ads on Sunbay's boards: each its own palette and copy, all written for this game. */
const BILLBOARDS = [
  {
    title: 'TACO CANNON',
    copy: '2 FOR 1 · ALL NIGHT',
    tag: 'BEACH & 9TH',
    sky: ['#3a1d2c', '#7c2d34'],
    ink: '#ffe2a8',
    accent: '#ff7a4d',
  },
  {
    title: 'BRAINROT BEANS',
    copy: 'NOW WITH 30% MORE BEANS',
    tag: 'THE BEAN WITH AN AGENDA',
    sky: ['#20321f', '#4d6a2e'],
    ink: '#e9ff9c',
    accent: '#b6e04b',
  },
  {
    title: 'SUNBAY TANNING',
    copy: 'FRY RESPONSIBLY',
    tag: 'SPF WHATEVER · OPEN LATE',
    sky: ['#3d2430', '#c9632f'],
    ink: '#fff2cf',
    accent: '#ffbe5c',
  },
  {
    title: 'SHELLSHOCK TOWING',
    copy: "WE'LL DRAG ANYTHING",
    tag: 'NO QUESTIONS · CASH UP FRONT',
    sky: ['#101f2e', '#1f4a63'],
    ink: '#cdf2ff',
    accent: '#62c8ff',
  },
  {
    title: "MAMA ROSA'S",
    copy: 'THE PASTEL IS NOT A CRIME',
    tag: 'PAWN · JOBS · PASTRIES',
    sky: ['#2b1430', '#6b2b5c'],
    ink: '#ffd9f2',
    accent: '#ff8ad0',
  },
  {
    title: 'COASTLINE GT',
    copy: '0 TO REGRET IN 4.2',
    tag: 'CORAL MOTORS · SEE LOT',
    sky: ['#231b12', '#6a4a22'],
    ink: '#fff0c4',
    accent: '#ffcf92',
  },
];

/** Draws one ad onto a fresh canvas texture: a band, a display line, a small tag. */
function createBillboardTexture(ad) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const sky = context.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, ad.sky[0]);
  sky.addColorStop(1, ad.sky[1]);
  context.fillStyle = sky;
  context.fillRect(0, 0, 512, 256);

  // A sun-striped corner, the same motif on every board, in the ad's own accent.
  context.fillStyle = ad.accent;
  context.globalAlpha = 0.18;
  for (let stripe = 0; stripe < 6; stripe += 1) {
    context.fillRect(392 + stripe * 16, 0, 7, 256);
  }
  context.globalAlpha = 1;
  context.strokeStyle = ad.accent;
  context.lineWidth = 6;
  context.strokeRect(8, 8, 496, 240);

  context.fillStyle = ad.ink;
  context.textBaseline = 'alphabetic';
  context.font = '900 60px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  context.letterSpacing = '1px';
  fitText(context, ad.title, 470, 60, 28);
  context.fillText(ad.title, 30, 108);
  context.fillStyle = ad.accent;
  context.font = '800 34px ui-sans-serif, system-ui, sans-serif';
  fitText(context, ad.copy, 456, 34, 17);
  context.fillText(ad.copy, 30, 162);
  context.fillStyle = 'rgba(255,255,255,0.62)';
  context.font = '700 17px ui-sans-serif, system-ui, sans-serif';
  context.letterSpacing = '3px';
  context.fillText(ad.tag, 30, 208);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Shrinks the font until `text` fits `maxWidth`, never below `floor`. */
function fitText(context, text, maxWidth, size, floor) {
  let current = size;
  while (context.measureText(text).width > maxWidth && current > floor) {
    current -= 2;
    context.font = context.font.replace(/\d+px/, `${current}px`);
  }
}

/**
 * The boards' places: a rooftop sign on a few tall buildings near the middle, and two
 * hoardings at street level by the beach promenade and the south perimeter. Returns plain
 * data so the mesh building stays in one place.
 */
function billboardSpots(buildings, halfSpan) {
  const tall = buildings
    .filter((building) => building.height > 26 && Math.abs(building.x) < halfSpan - 30
      && Math.abs(building.z) < halfSpan - 30)
    .sort((a, b) => b.height - a.height);
  const spots = [];
  for (let index = 0; index < 4 && index < tall.length; index += 2) {
    const building = tall[index];
    if (!building) continue;
    spots.push({
      x: building.x,
      y: building.height + 0.5 + 3.6,
      z: building.z,
      width: 15,
      height: 7.5,
      heading: (index % 2) * Math.PI + Math.PI / 2,
      roof: true,
    });
  }
  spots.push({ x: 166.5, y: 5.2, z: -34, width: 13, height: 5.5, heading: -Math.PI / 2, roof: false });
  spots.push({ x: 18, y: 5.2, z: halfSpan - 3, width: 13, height: 5.5, heading: Math.PI, roof: false });
  return spots;
}

/** Builds the boards into the scene: one textured plane each and one merged frame mesh. */
function addBillboards(group, spots) {
  const frames = createBuilder();
  const steel = new THREE.Color('#5a6169');
  const planeGeometry = new THREE.PlaneGeometry(1, 1);
  spots.forEach((spot, index) => {
    const ad = BILLBOARDS[index % BILLBOARDS.length];
    const texture = createBillboardTexture(ad);
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    const board = new THREE.Mesh(planeGeometry, material);
    board.scale.set(spot.width, spot.height, 1);
    board.position.set(spot.x, spot.y, spot.z);
    board.rotation.y = spot.heading;
    group.add(board);

    // The frame: two posts for a hoarding, a low cradle for a rooftop sign.
    const base = new THREE.Matrix4().makeTranslation(spot.x, 0, spot.z)
      .multiply(new THREE.Matrix4().makeRotationY(spot.heading));
    const legHeight = spot.roof ? 1.2 : spot.y - spot.height / 2;
    for (const side of [-1, 1]) {
      frames.boxAt(base, [0.28, legHeight, 0.28],
        [side * (spot.width / 2 - 0.6), spot.y - spot.height / 2 - legHeight / 2 + (spot.roof ? 0.6 : 0), 0], steel);
    }
    frames.boxAt(base, [spot.width + 0.5, 0.22, 0.22], [0, spot.y + spot.height / 2 + 0.08, 0], steel);
    frames.boxAt(base, [spot.width + 0.5, 0.22, 0.22], [0, spot.y - spot.height / 2 - 0.08, 0], steel);
  });
  if (!frames.empty) {
    const mesh = frames.build(new THREE.MeshLambertMaterial({ vertexColors: true }), { castShadow: true });
    group.add(mesh);
  }
}

export function createCity(scene, seed = 0x51b0a7, options = {}) {
  const { shadows = true } = options;
  const rng = createRng(seed);
  const group = new THREE.Group();
  group.name = 'sunbay';
  scene.add(group);

  const { halfSpan, pitch, roadWidth, sidewalkHeight, waterStartX } = CITY;
  const roadHalf = roadWidth / 2;
  const blockStart = roadHalf;
  const blockEnd = pitch - roadHalf;
  const blockSpan = blockEnd - blockStart;
  const colliders = [];
  const bounds = { minX: -halfSpan - 4, maxX: waterStartX - 3, minZ: -halfSpan - 4, maxZ: halfSpan + 4 };

  const materials = {
    windows: new THREE.MeshLambertMaterial({ map: createWindowTexture(), vertexColors: true }),
    solid: new THREE.MeshLambertMaterial({ vertexColors: true }),
    road: new THREE.MeshLambertMaterial({ map: createAsphaltTexture() }),
    paint: new THREE.MeshLambertMaterial({ color: COLORS.line }),
    water: new THREE.MeshLambertMaterial({ color: COLORS.water }),
  };

  const tint = (hex) => new THREE.Color(hex);
  const buildingTints = BUILDING_COLORS.map(tint);
  const concrete = tint(COLORS.concrete);
  const curb = tint(COLORS.curb);
  const roofTint = tint(COLORS.roof);
  const roofDark = tint(COLORS.roofDark);
  const sand = tint(COLORS.sand);
  const grass = tint(COLORS.grass);
  const trunkTint = tint(COLORS.trunk);
  const frondTint = tint(COLORS.frond);
  const frondDark = tint(COLORS.frondDark);
  const lampMetal = tint(COLORS.lampMetal);
  const white = tint('#ffffff');
  const asphalt = tint('#33373d');

  const facades = createBuilder();
  const solids = createBuilder();
  const paint = createBuilder();
  const parks = [];

  // -- street surface, lane paint and crosswalks -------------------------------------------
  const streets = createBuilder();
  // Cross streets run the full width; avenues stop at the perimeter road so no two
  // road quads share a surface (and z-fight) inside an intersection.
  const crossLength = roadWidth + 2 * (CITY.span - roadHalf);
  for (let line = 0; line < CITY.gridLines; line += 1) {
    const offset = -halfSpan + line * pitch;
    const alongX = roadPlane(roadWidth, crossLength);
    streets.add(alongX, new THREE.Matrix4().makeTranslation(offset, 0, 0), asphalt);
    alongX.dispose();
    const alongZ = roadPlane(roadWidth, CITY.span);
    streets.add(alongZ, new THREE.Matrix4().makeTranslation(0, 0, offset), asphalt);
    alongZ.dispose();
  }
  const streetMesh = streets.build(materials.road, { receiveShadow: true });
  streetMesh.matrixAutoUpdate = false;
  group.add(streetMesh);

  // Dashed centre line down every street, interrupted at each intersection.
  for (let line = 0; line < CITY.gridLines; line += 1) {
    const offset = -halfSpan + line * pitch;
    for (let dash = 0; dash < 66; dash += 1) {
      const along = -halfSpan + 2.5 + dash * 5;
      const nearIntersection = Math.abs(((along + halfSpan) % pitch) - 16.5) > 11;
      if (!nearIntersection) continue;
      paint.box([0.22, 0.02, 2.4], [offset, 0.012, along], white);
      paint.box([2.4, 0.02, 0.22], [along, 0.012, offset], white);
    }
  }

  // Zebra crossings on the four arms of each intersection.
  for (let gx = 1; gx < CITY.gridLines - 1; gx += 1) {
    for (let gz = 1; gz < CITY.gridLines - 1; gz += 1) {
      const x = -halfSpan + gx * pitch;
      const z = -halfSpan + gz * pitch;
      for (let stripe = -2; stripe <= 2; stripe += 1) {
        const shift = stripe * 1.9;
        paint.box([0.7, 0.02, 3.4], [x + shift, 0.014, z - roadHalf - 2.6], white);
        paint.box([0.7, 0.02, 3.4], [x + shift, 0.014, z + roadHalf + 2.6], white);
        paint.box([3.4, 0.02, 0.7], [x - roadHalf - 2.6, 0.014, z + shift], white);
        paint.box([3.4, 0.02, 0.7], [x + roadHalf + 2.6, 0.014, z + shift], white);
      }
    }
  }

  // -- sidewalk slabs, one per block, with a curb lip --------------------------------------
  const blockCentres = [];
  for (let bx = 0; bx < CITY.gridLines - 1; bx += 1) {
    for (let bz = 0; bz < CITY.gridLines - 1; bz += 1) {
      const centreX = -halfSpan + bx * pitch + pitch / 2;
      const centreZ = -halfSpan + bz * pitch + pitch / 2;
      blockCentres.push([centreX, centreZ, bx, bz]);
    }
  }
  const reserved = new Set();
  const parkBlocks = new Set();
  const parkCount = 5;
  while (parkBlocks.size < parkCount) {
    const bx = rng.int(1, CITY.gridLines - 3);
    const bz = rng.int(1, CITY.gridLines - 2);
    if (bx === 5 && bz === 5) continue;
    parkBlocks.add(`${bx},${bz}`);
  }

  for (const [centreX, centreZ, bx, bz] of blockCentres) {
    solids.box([blockSpan + 1.4, sidewalkHeight, blockSpan + 1.4], [centreX, sidewalkHeight / 2, centreZ], concrete);
    solids.box([blockSpan + 1.7, 0.09, blockSpan + 1.7], [centreX, sidewalkHeight + 0.045, centreZ], curb);
    if (parkBlocks.has(`${bx},${bz}`)) {
      solids.box([blockSpan - 2.2, 0.12, blockSpan - 2.2], [centreX, sidewalkHeight + 0.1, centreZ], grass);
      parks.push([centreX, centreZ]);
    }
  }

  // -- buildings ----------------------------------------------------------------------------
  const acTint = tint('#a8a49a');
  const buildings = [];
  for (const [centreX, centreZ, bx, bz] of blockCentres) {
    if (parkBlocks.has(`${bx},${bz}`)) continue;
    if (rng.chance(0.04)) continue; // the odd empty lot
    const width = rng.range(8.5, 18.5);
    const depth = rng.range(8.5, 18.5);
    const slackX = Math.max(0.4, (blockSpan - width) / 2 - 1.3);
    const slackZ = Math.max(0.4, (blockSpan - depth) / 2 - 1.3);
    const x = centreX + rng.range(-slackX, slackX);
    const z = centreZ + rng.range(-slackZ, slackZ);

    const fromCentre = Math.hypot(centreX, centreZ) / (halfSpan * 0.9);
    const beachfront = bx === CITY.gridLines - 2;
    let height = 8 + rng.range(0, 9) + Math.pow(Math.max(0, 1 - fromCentre), 2.1) * rng.range(12, 52);
    if (beachfront) height = Math.min(height, rng.range(7, 16));
    if (rng.chance(0.07)) height += rng.range(10, 28);
    height = Math.min(92, height);

    const colour = buildingTints[rng.int(0, buildingTints.length - 1)];
    const body = new THREE.BoxGeometry(width, height, depth);
    // Window tiles every 3.4 m across and every 3.4 m up, per face.
    const uv = body.attributes.uv;
    for (let index = 0; index < uv.count; index += 1) {
      const face = Math.floor(index / 4);
      const horizontal = face === 0 || face === 1 ? depth : width;
      if (face <= 1 || face >= 4) {
        uv.setXY(index, (uv.getX(index) * horizontal) / 3.4, (uv.getY(index) * height) / 3.4);
      }
    }
    facades.add(body, new THREE.Matrix4().makeTranslation(x, height / 2 + sidewalkHeight, z), colour);
    body.dispose();

    // Ground-floor trim, roof slab and a parapet wall.
    solids.box([width + 0.5, 2.1, depth + 0.5], [x, sidewalkHeight + 1.05, z], roofDark);
    solids.box([width + 0.4, 0.5, depth + 0.4], [x, sidewalkHeight + height + 0.25, z], roofTint);
    const railHeight = 0.7;
    const railY = sidewalkHeight + height + 0.5 + railHeight / 2;
    solids.box([width + 0.4, railHeight, 0.35], [x, railY, z - depth / 2 - 0.025], roofTint);
    solids.box([width + 0.4, railHeight, 0.35], [x, railY, z + depth / 2 + 0.025], roofTint);
    solids.box([0.35, railHeight, depth + 0.4], [x - width / 2 - 0.025, railY, z], roofTint);
    solids.box([0.35, railHeight, depth + 0.4], [x + width / 2 + 0.025, railY, z], roofTint);

    // Rooftop plant: a few AC boxes and, on the tall ones, a mast.
    const units = rng.int(0, 3);
    for (let unit = 0; unit < units; unit += 1) {
      const unitX = x + rng.range(-width / 2 + 1.5, width / 2 - 1.5);
      const unitZ = z + rng.range(-depth / 2 + 1.5, depth / 2 - 1.5);
      const unitSize = [1.5 + rng.range(0, 1.2), 0.7 + rng.range(0, 0.8), 1.2 + rng.range(0, 1)];
      solids.box(unitSize, [unitX, sidewalkHeight + height + 0.5 + unitSize[1] / 2, unitZ], acTint);
    }
    if (height > 45 && rng.chance(0.6)) {
      const mast = new THREE.CylinderGeometry(0.09, 0.13, 6, 5);
      solids.add(mast, new THREE.Matrix4().makeTranslation(x, sidewalkHeight + height + 3.5, z), lampMetal);
      mast.dispose();
    }

    colliders.push({
      minX: x - width / 2 - 0.2,
      maxX: x + width / 2 + 0.2,
      minZ: z - depth / 2 - 0.2,
      maxZ: z + depth / 2 + 0.2,
    });
    buildings.push({ x, z, width, depth, height });
  }

  // -- palms ---------------------------------------------------------------------------------
  const palmSpots = [];
  for (const [centreX, centreZ] of parks) {
    for (let index = 0; index < 7; index += 1) {
      palmSpots.push([
        centreX + rng.range(-blockSpan / 2 + 3, blockSpan / 2 - 3),
        centreZ + rng.range(-blockSpan / 2 + 3, blockSpan / 2 - 3),
      ]);
    }
  }
  for (const [centreX, centreZ, bx, bz] of blockCentres) {
    if (parkBlocks.has(`${bx},${bz}`)) continue;
    if (rng.chance(0.34)) {
      const sideX = rng.chance(0.5) ? -1 : 1;
      const sideZ = rng.chance(0.5) ? -1 : 1;
      palmSpots.push([centreX + sideX * (blockSpan / 2 - 1.6), centreZ + sideZ * (blockSpan / 2 - 1.6)]);
    }
  }
  for (let index = 0; index < 46; index += 1) {
    // Seaward palms: a line along the sand and a scatter behind it.
    const onLine = index < 26;
    const x = onLine ? 172.2 + (index % 3) * 2.4 : rng.range(173, 184);
    const z = onLine ? -halfSpan + 9 + index * 12.4 : rng.range(-halfSpan + 4, halfSpan - 4);
    palmSpots.push([x, z]);
  }

  const trunks = createBuilder();
  const fronds = createBuilder();
  for (const [x, z] of palmSpots) {
    if (Math.hypot(x - 2, z - 2) < 7) continue;
    const height = 6.4 + rng.range(0, 3.2);
    const lean = rng.range(-0.09, 0.09);
    const segments = 5;
    for (let segment = 0; segment < segments; segment += 1) {
      const t = (segment + 0.5) / segments;
      const radius = 0.3 - t * 0.1;
      const pieceHeight = height / segments;
      const offsetX = Math.sin(t * Math.PI) * lean * height;
      const geometry = new THREE.CylinderGeometry(radius * 0.82, radius, pieceHeight, 6);
      const matrix = new THREE.Matrix4().makeTranslation(x + offsetX, sidewalkHeight + pieceHeight * (segment + 0.5), z);
      trunks.add(geometry, matrix, trunkTint);
      geometry.dispose();
    }
    const topX = x;
    const topY = sidewalkHeight + height;
    const crown = new THREE.IcosahedronGeometry(0.45, 0);
    trunks.add(crown, new THREE.Matrix4().makeTranslation(topX, topY, z), trunkTint);
    crown.dispose();
    const frondCount = 7;
    for (let frond = 0; frond < frondCount; frond += 1) {
      const angle = (frond / frondCount) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const droop = rng.range(0.24, 0.62);
      const length = 2.6 + rng.range(0, 1.3);
      const geometry = new THREE.BoxGeometry(length, 0.055, 0.5);
      geometry.translate(length / 2, 0, 0);
      const rotation = new THREE.Euler(0, angle, -droop, 'YXZ');
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(topX, topY + 0.15, z),
        new THREE.Quaternion().setFromEuler(rotation),
        new THREE.Vector3(1, 1, 1),
      );
      fronds.add(geometry, matrix, frond === 0 ? frondDark : frondTint);
      geometry.dispose();
    }
  }

  // -- street lamps: a pole and a warm head on each block corner -----------------------------
  const lamps = createBuilder();
  const lampHeads = createBuilder();
  const warm = tint('#ffbd73');
  for (const [centreX, centreZ] of blockCentres.map(([x, z]) => [x, z])) {
    for (let corner = 0; corner < 3; corner += 1) {
      const sideX = corner % 2 === 0 ? -1 : 1;
      const sideZ = corner < 2 ? -1 : 1;
      const x = centreX + sideX * (blockSpan / 2 - 0.9);
      const z = centreZ + sideZ * (blockSpan / 2 - 0.9);
      const poleHeight = 6.4;
      const pole = new THREE.CylinderGeometry(0.08, 0.12, poleHeight, 5);
      lamps.add(pole, new THREE.Matrix4().makeTranslation(x, sidewalkHeight + poleHeight / 2, z), lampMetal);
      pole.dispose();
      const armX = -sideX * 0.9;
      lamps.box([1.8, 0.09, 0.09], [x + armX / 2, sidewalkHeight + poleHeight, z], lampMetal);
      lampHeads.box([0.62, 0.16, 0.3], [x + armX, sidewalkHeight + poleHeight - 0.1, z], warm);
    }
  }

  // -- parked cars along the curbs -----------------------------------------------------------
  const carBodies = createBuilder();
  const carGlass = createBuilder();
  const carWheels = createBuilder();
  const carTints = ['#e5533d', '#f0c455', '#4b9fd1', '#f4f1e7', '#5c6a73', '#3f8f77', '#d97ba6', '#e8792e'].map(tint);
  const wheelTint = tint('#20242a');
  const glassTint = tint('#4a626e');
  const up = new THREE.Vector3(0, 1, 0);
  for (let index = 0; index < 18; index += 1) {
    const bx = rng.int(0, CITY.gridLines - 2);
    const bz = rng.int(0, CITY.gridLines - 2);
    const centreX = -halfSpan + bx * pitch + pitch / 2;
    const centreZ = -halfSpan + bz * pitch + pitch / 2;
    const alongX = rng.chance(0.5);
    const side = rng.chance(0.5) ? 1 : -1;
    // The car sits in the parking lane, 2.2 m off the curb into the street.
    const parkedX = alongX ? centreX + rng.range(-blockSpan / 2 + 3, blockSpan / 2 - 3) : centreX + side * (blockSpan / 2 + 2.3);
    const parkedZ = alongX ? centreZ + side * (blockSpan / 2 + 2.3) : centreZ + rng.range(-blockSpan / 2 + 3, blockSpan / 2 - 3);
    const rotation = alongX ? Math.PI / 2 : 0;
    const colour = carTints[rng.int(0, carTints.length - 1)];
    const base = new THREE.Matrix4().makeTranslation(parkedX, 0, parkedZ).multiply(new THREE.Matrix4().makeRotationY(rotation));
    carBodies.boxAt(base, [1.92, 0.62, 4.3], [0, 0.6, 0], colour);
    carBodies.boxAt(base, [1.74, 0.5, 2.2], [0, 1.12, -0.12], colour);
    carGlass.boxAt(base, [1.7, 0.32, 2.14], [0, 1.2, -0.12], glassTint);
    for (const [dx, dz] of [[-0.86, 1.42], [0.86, 1.42], [-0.86, -1.38], [0.86, -1.38]]) {
      const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 8);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(dx, 0.36, dz);
      carWheels.add(wheel, base, wheelTint);
      wheel.dispose();
    }
    void up;
  }

  // -- beach, sun shades and the ocean ------------------------------------------------------
  // Sand runs from the far pavement, out under the water line, so the water sits on it.
  const sandStart = CITY.beachStartX - 0.2;
  const sandWidth = waterStartX + 40 - sandStart;
  solids.box([sandWidth, 0.3, CITY.span + 40], [sandStart + sandWidth / 2, -0.15, 0], sand);
  solids.box([sandWidth, 0.24, CITY.span + 40], [sandStart + sandWidth / 2, -0.32, 0], tint('#d9c08b'));
  // A warm promenade kerb separates the pavement from the sand.
  solids.box([0.6, 0.6, CITY.span + 8], [CITY.beachStartX, 0.12, 0], curb);
  // Beach umbrellas and their towels.
  const towels = ['#ef7d5e', '#4b9fd1', '#f0c455', '#5c6a73'].map(tint);

  const shades = createBuilder();
  for (let index = 0; index < 14; index += 1) {
    const x = 173.5 + rng.range(0, 10);
    const z = -halfSpan + 16 + index * 11.5 + rng.range(-2, 2);
    const pole = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5);
    shades.add(pole, new THREE.Matrix4().makeTranslation(x, 1.25, z), white);
    pole.dispose();
    const canopy = new THREE.ConeGeometry(1.9, 0.7, 8);
    shades.add(canopy, new THREE.Matrix4().makeTranslation(x, 2.65, z),
      tint(['#ef7d5e', '#f2dfae', '#4b9fd1', '#f0c455'][index % 4]));
    canopy.dispose();
    // A second, lower shade beside some of them, so the beach reads as a crowd not a row.
    if (index % 3 === 0) {
      const x2 = x + rng.range(3.5, 6.5);
      const z2 = z + rng.range(-2.5, 2.5);
      const pole2 = new THREE.CylinderGeometry(0.05, 0.05, 2.1, 5);
      shades.add(pole2, new THREE.Matrix4().makeTranslation(x2, 1.05, z2), white);
      pole2.dispose();
      const canopy2 = new THREE.ConeGeometry(1.5, 0.6, 8);
      shades.add(canopy2, new THREE.Matrix4().makeTranslation(x2, 2.25, z2),
        tint(index % 2 ? '#64a6b8' : '#e8792e'));
      canopy2.dispose();
      solids.box([1.1, 0.03, 2.1], [x2 + 1.5, 0.02, z2 - 0.4], towels[index % towels.length]);
    }
    solids.box([1.1, 0.03, 2.1], [x + 1.9, 0.02, z + 0.4], towels[index % towels.length]);
  }

  // -- the pier: piles under a plank deck, a rail and a small chum shack at the end ------------
  const pierZ = 18;
  const pierStart = waterStartX - 4;
  const pierLength = 58;
  const pierDeck = createBuilder();
  const pierWood = tint('#a5845c');
  const pierDark = tint('#7b6040');
  const pierEnd = pierStart + pierLength;
  for (let plank = 0; plank < pierLength / 1.4; plank += 1) {
    const z = pierStart + plank * 1.4 + 0.7;
    pierDeck.box([4.2, 0.16, 1.32], [pierStart + 0.4, 1.2, z], plank % 2 ? pierWood : tint('#b08d62'));
  }
  for (const offsetX of [-2, -0.7, 0.7, 2]) {
    for (let pile = 0; pile < 12; pile += 1) {
      const z = pierStart + 1.5 + pile * 5;
      const post = new THREE.CylinderGeometry(0.16, 0.19, 4.6, 6);
      pierDeck.add(post, new THREE.Matrix4().makeTranslation(pierStart + 0.4 + offsetX, -0.9, z), pierDark);
      post.dispose();
    }
  }
  for (const offsetX of [-2.05, 2.05]) {
    for (const [y, railing] of [[1.95, 0.1], [2.62, 0.09]]) {
      void railing;
      pierDeck.box([0.09, 0.09, pierLength - 1], [pierStart + 0.4 + offsetX, y, pierStart + pierLength / 2], pierDark);
    }
    for (let post = 0; post < 10; post += 1) {
      pierDeck.box([0.1, 0.9, 0.1],
        [pierStart + 0.4 + offsetX, 2.2, pierStart + 2 + post * (pierLength / 10)], pierDark);
    }
  }
  // The shack: a box with a roof and a warm window, at the far end.
  pierDeck.box([3.4, 2.5, 3.2], [pierStart + 0.4, 2.5, pierEnd - 3.2], tint('#c9d6c0'));
  pierDeck.box([3.9, 0.24, 3.7], [pierStart + 0.4, 3.86, pierEnd - 3.2], tint('#8f4b3a'));
  pierDeck.box([0.06, 1.1, 1.6], [pierStart + 0.4 - 1.72, 2.6, pierEnd - 3.2], tint('#ffcf92'));
  // An out-of-place deck chair or two, for scale.
  pierDeck.box([0.7, 0.08, 1.8], [pierStart + 2.3, 1.55, pierEnd - 9], tint('#ef7d5e'));
  pierDeck.box([0.7, 0.5, 0.08], [pierStart + 2.3, 1.8, pierEnd - 9.9], tint('#ef7d5e'));
  pierDeck.box([0.7, 0.08, 1.8], [pierStart - 1.5, 1.55, pierEnd - 12], tint('#4b9fd1'));

  const water = new THREE.Mesh(new THREE.PlaneGeometry(900, 900, 1, 1), materials.water);
  water.rotation.x = -Math.PI / 2;
  water.position.set(waterStartX + 450, -0.55, 0);
  water.receiveShadow = false;
  group.add(water);

  // A pale foam line where the water meets the sand.
  const foam = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, CITY.span + 40),
    new THREE.MeshBasicMaterial({ color: '#dff6f7', transparent: true, opacity: 0.55 }),
  );
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(waterStartX - 1.4, -0.12, 0);
  group.add(foam);

  // -- billboards: original ads on hoardings and rooftops, drawn to canvas ---------------------
  addBillboards(group, billboardSpots(buildings, halfSpan));

  // -- assemble the merged meshes ------------------------------------------------------------
  if (!facades.empty) group.add(facades.build(materials.windows, { castShadow: true, receiveShadow: true }));
  if (!solids.empty) group.add(solids.build(materials.solid, { castShadow: true, receiveShadow: true }));
  if (!paint.empty) group.add(paint.build(materials.paint));
  if (!trunks.empty) group.add(trunks.build(materials.solid, { castShadow: true }));
  if (!fronds.empty) group.add(fronds.build(materials.solid, { castShadow: true }));
  if (!lamps.empty) group.add(lamps.build(materials.solid, { castShadow: true }));
  if (!lampHeads.empty) {
    const headMaterial = new THREE.MeshLambertMaterial({ color: '#3a2c1e', emissive: '#ffb257', emissiveIntensity: 1.1 });
    const heads = lampHeads.build(headMaterial);
    heads.matrixAutoUpdate = false;
    group.add(heads);
  }
  if (!carBodies.empty) group.add(carBodies.build(materials.solid, { castShadow: true }));
  if (!carGlass.empty) group.add(carGlass.build(materials.solid));
  if (!carWheels.empty) group.add(carWheels.build(materials.solid));
  if (!shades.empty) group.add(shades.build(materials.solid, { castShadow: true }));
  if (!pierDeck.empty) group.add(pierDeck.build(materials.solid, { castShadow: true, receiveShadow: true }));

  // -- light and air: late afternoon, the sun low in the west, the sea catching it ------------
  scene.background = new THREE.Color('#f2c295');
  scene.fog = new THREE.Fog('#f0bd93', 150, 520);

  const hemisphere = new THREE.HemisphereLight('#ffd7a8', '#6b5a46', 1.05);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight('#ffd9a0', 2.15);
  sun.position.set(-140, 78, 120);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 420;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  /** 0.18 m on a sidewalk slab, 0 in the street or on the sand; O(1) so it runs every frame. */
  function groundHeightAt(x, z) {
    if (x > CITY.beachStartX - 0.6) return 0;
    const localX = (((x + halfSpan) % pitch) + pitch) % pitch;
    const localZ = (((z + halfSpan) % pitch) + pitch) % pitch;
    const onBlockX = localX > blockStart && localX < blockEnd;
    const onBlockZ = localZ > blockStart && localZ < blockEnd;
    return onBlockX && onBlockZ ? sidewalkHeight : 0;
  }

  /** The nearest point on a street centreline, for placing ambient traffic. */
  function streetPointAt(t) {
    const lines = CITY.gridLines;
    const loop = t * lines * 2;
    const line = Math.floor(loop) % lines;
    const offset = -halfSpan + line * pitch;
    const along = (((t * CITY.span * 4) % CITY.span) + CITY.span) % CITY.span - halfSpan;
    return loop % 2 < 1
      ? { x: along, z: offset, heading: Math.PI / 2 }
      : { x: offset, z: along, heading: 0 };
  }

  return {
    group,
    colliders,
    buildings,
    blocks: blockCentres,
    parks,
    bounds,
    groundHeightAt,
    spawn: { x: -2.5, z: 2.5, heading: Math.PI / 2 },
    streetMesh,
    sun,
  };
}
