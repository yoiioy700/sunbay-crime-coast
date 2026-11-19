// The world's effects, all pooled and all local: muzzle flashes and tracers, impact sparks,
// tyre smoke, an explosion when a car's health runs out, money sparkles, water splashes at the
// shoreline, and skid marks that fade on the asphalt. Every particle system is one THREE.Points
// with a fixed capacity and a per-particle size/colour/alpha shader, so a firefight or a drift
// costs a draw call, not an allocation. The skid marks are one ring buffer of quads.
//
// Cars carry `health` (100 by default once something has hit them); smoke starts at 40 and fire
// at 18, and at zero `explode` fires once and sets car.exploded so main.js can retire the wreck.
// Camera shake lives here too, applied by the frame loop after the follow rig has placed the
// camera.

import * as THREE from 'three';

const ADDITIVE = THREE.AdditiveBlending;
const NORMAL = THREE.NormalBlending;

/** A soft round dot drawn once into a canvas; no external image is ever fetched. */
function createSpriteTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.75, 'rgba(255,255,255,0.25)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const VERTEX = `
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = pcolor;
  vAlpha = palpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = psize * (330.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = `
uniform sampler2D map;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float alpha = texture2D(map, gl_PointCoord).a * vAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(vColor, alpha);
}
`;

/**
 * One pooled particle system: `capacity` points, a ring cursor, per-particle velocity,
 * life and drag. `update(dt)` advances every live particle and fades its alpha.
 */
function createParticleSystem(scene, texture, {
  capacity = 120, blending = ADDITIVE, gravity = 0, drag = 1, fade = 1,
} = {}) {
  const positions = new Float32Array(capacity * 3);
  const velocities = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const maxLife = new Float32Array(capacity);
  const baseSize = new Float32Array(capacity);
  const grow = new Float32Array(capacity);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('pcolor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('psize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('palpha', new THREE.BufferAttribute(alphas, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  let cursor = 0;
  let live = 0;
  const color = new THREE.Color();

  function emit(x, y, z, vx, vy, vz, seconds, size, hex, growth = 0) {
    const index = cursor;
    cursor = (cursor + 1) % capacity;
    if (life[index] <= 0) live += 1;
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
    velocities[index * 3] = vx;
    velocities[index * 3 + 1] = vy;
    velocities[index * 3 + 2] = vz;
    color.set(hex);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
    baseSize[index] = size;
    sizes[index] = size;
    alphas[index] = 1;
    life[index] = seconds;
    maxLife[index] = seconds;
    grow[index] = growth;
  }

  function update(dt) {
    live = 0;
    for (let index = 0; index < capacity; index += 1) {
      if (life[index] <= 0) {
        alphas[index] = 0;
        continue;
      }
      live += 1;
      life[index] -= dt;
      if (life[index] <= 0) {
        alphas[index] = 0;
        sizes[index] = 0;
        continue;
      }
      const offset = index * 3;
      velocities[offset + 1] += gravity * dt;
      const damp = Math.exp(-drag * dt);
      velocities[offset] *= damp;
      velocities[offset + 1] *= damp;
      velocities[offset + 2] *= damp;
      positions[offset] += velocities[offset] * dt;
      positions[offset + 1] += velocities[offset + 1] * dt;
      positions[offset + 2] += velocities[offset + 2] * dt;
      const ratio = life[index] / maxLife[index];
      alphas[index] = Math.pow(Math.max(0, ratio), fade);
      sizes[index] = baseSize[index] * (1 + (1 - ratio) * grow[index]);
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.psize.needsUpdate = true;
    geometry.attributes.palpha.needsUpdate = true;
    geometry.attributes.pcolor.needsUpdate = true;
  }

  return {
    emit,
    update,
    get live() {
      return live;
    },
    clear() {
      life.fill(0);
      alphas.fill(0);
      sizes.fill(0);
      live = 0;
      geometry.attributes.palpha.needsUpdate = true;
      geometry.attributes.psize.needsUpdate = true;
    },
  };
}

const SKID_CAPACITY = 220;

/** A ring buffer of fading skid quads: one geometry, one draw call, no per-mark material. */
function createSkids(scene) {
  const positions = new Float32Array(SKID_CAPACITY * 4 * 3);
  const alphas = new Float32Array(SKID_CAPACITY * 4);
  const births = new Float32Array(SKID_CAPACITY);
  const strengths = new Float32Array(SKID_CAPACITY);
  const indices = new Uint16Array(SKID_CAPACITY * 6);
  for (let quad = 0; quad < SKID_CAPACITY; quad += 1) {
    const base = quad * 4;
    indices.set([base, base + 1, base + 2, base + 2, base + 1, base + 3], quad * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const material = new THREE.ShaderMaterial({
    vertexShader: 'attribute float aAlpha; varying float vA; void main() { vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float vA; void main() { if (vA < 0.004) discard; gl_FragColor = vec4(0.055, 0.055, 0.065, vA); }',
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  let cursor = 0;
  let clock = 0;

  /** Writes one quad centred at (x, z), `width` across the tangent and `length` along it. */
  function addQuad(x, z, heading, width, length, strength) {
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    // The quad's long axis runs along the car's travel, its short axis across it.
    const ax = sin * length * 0.5;
    const az = cos * length * 0.5;
    const bx = cos * width * 0.5;
    const bz = -sin * width * 0.5;
    const base = cursor * 4;
    const y = 0.022;
    const corners = [
      [x - bx - ax, z - bz - az], [x + bx - ax, z + bz - az],
      [x - bx + ax, z - bz + az], [x + bx + ax, z + bz + az],
    ];
    for (let corner = 0; corner < 4; corner += 1) {
      const offset = (base + corner) * 3;
      positions[offset] = corners[corner][0];
      positions[offset + 1] = y;
      positions[offset + 2] = corners[corner][1];
      alphas[base + corner] = 0.34 * strength;
    }
    births[cursor] = clock;
    strengths[cursor] = strength;
    cursor = (cursor + 1) % SKID_CAPACITY;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  function update(dt) {
    clock += dt;
    let changed = false;
    for (let quad = 0; quad < SKID_CAPACITY; quad += 1) {
      const age = clock - births[quad];
      if (age < 0 || age > 7) continue;
      const alpha = Math.max(0, 0.34 * strengths[quad] * (1 - age / 7));
      const base = quad * 4;
      if (Math.abs(alphas[base] - alpha) < 0.002) continue;
      for (let corner = 0; corner < 4; corner += 1) alphas[base + corner] = alpha;
      changed = true;
    }
    if (changed) geometry.attributes.aAlpha.needsUpdate = true;
  }

  function clear() {
    births.fill(-1000);
    alphas.fill(0);
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { addQuad, update, clear };
}

/** Builds every effect system and the small API main.js, combat.js and police.js share. */
export function createEffects(scene) {
  const texture = createSpriteTexture();
  const sparks = createParticleSystem(scene, texture, {
    capacity: 220, blending: ADDITIVE, gravity: -26, drag: 1.4, fade: 1.4,
  });
  const smoke = createParticleSystem(scene, texture, {
    capacity: 260, blending: NORMAL, gravity: 1.1, drag: 0.9, fade: 1.6,
  });
  const fire = createParticleSystem(scene, texture, {
    capacity: 160, blending: ADDITIVE, gravity: 5.5, drag: 1.1, fade: 1.5,
  });
  const sparkle = createParticleSystem(scene, texture, {
    capacity: 120, blending: ADDITIVE, gravity: -8, drag: 0.8, fade: 1.2,
  });
  const water = createParticleSystem(scene, texture, {
    capacity: 100, blending: NORMAL, gravity: -14, drag: 1.2, fade: 1.5,
  });
  const skids = createSkids(scene);

  // Muzzle flash planes and tracer lines: the two effects that are not clouds of points.
  const muzzleGeometry = new THREE.PlaneGeometry(0.55, 0.55);
  const flashes = [];
  for (let index = 0; index < 3; index += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: '#ffe7a8', transparent: true, opacity: 0, depthWrite: false,
      blending: ADDITIVE, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(muzzleGeometry, material);
    mesh.visible = false;
    scene.add(mesh);
    flashes.push({ mesh, life: 0, max: 0.07 });
  }
  const tracers = [];
  for (let index = 0; index < 8; index += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
      color: '#ffe6a8', transparent: true, opacity: 0, depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0, max: 0.1 });
  }

  const counters = {
    muzzle: 0, sparks: 0, smoke: 0, explosions: 0, sparkle: 0, splash: 0, skids: 0, shake: 0,
  };
  let shakeAmount = 0;
  let flashCursor = 0;
  let tracerCursor = 0;
  const carClock = new WeakMap();

  function nextFlash() {
    for (const flash of flashes) if (flash.life <= 0) return flash;
    const flash = flashes[flashCursor % flashes.length];
    flashCursor += 1;
    return flash;
  }

  function nextTracer() {
    for (const tracer of tracers) if (tracer.life <= 0) return tracer;
    const tracer = tracers[tracerCursor % tracers.length];
    tracerCursor += 1;
    return tracer;
  }

  function spark(x, y, z, color = '#ffd27a', count = 5) {
    counters.sparks += 1;
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const up = 1.2 + Math.random() * 4.2;
      const speed = 1.8 + Math.random() * 5.5;
      sparks.emit(x, y + 0.05, z, Math.cos(angle) * speed, up, Math.sin(angle) * speed,
        0.16 + Math.random() * 0.3, 0.14 + Math.random() * 0.16, color);
    }
  }

  function muzzle(position) {
    counters.muzzle += 1;
    const flash = nextFlash();
    flash.mesh.position.copy(position);
    flash.mesh.visible = true;
    flash.mesh.material.opacity = 0.95;
    flash.mesh.scale.setScalar(0.8 + Math.random() * 0.5);
    flash.life = flash.max;
    for (let index = 0; index < 3; index += 1) {
      sparks.emit(position.x, position.y, position.z,
        (Math.random() - 0.5) * 2, Math.random() * 1.4, (Math.random() - 0.5) * 2,
        0.07, 0.16 + Math.random() * 0.1, '#ffe9b0');
    }
  }

  function tracer(from, to, color = '#ffe6a8') {
    const tracer = nextTracer();
    const positions = tracer.line.geometry.attributes.position;
    positions.setXYZ(0, from.x, from.y, from.z);
    positions.setXYZ(1, to.x, to.y, to.z);
    positions.needsUpdate = true;
    tracer.line.geometry.computeBoundingSphere();
    tracer.line.material.color.set(color);
    tracer.line.material.opacity = 0.9;
    tracer.line.visible = true;
    tracer.life = tracer.max;
  }

  function shake(amount) {
    counters.shake += 1;
    shakeAmount = Math.min(1.2, shakeAmount + amount);
  }

  /** Tyre smoke at the rear axle, called while the handbrake is down at speed. */
  function tireSmoke(x, z, heading, strength = 1) {
    counters.smoke += 1;
    const backX = x - Math.sin(heading) * 1.35;
    const backZ = z - Math.cos(heading) * 1.35;
    const sideX = Math.cos(heading);
    const sideZ = -Math.sin(heading);
    for (const side of [-1, 1]) {
      const px = backX + sideX * side * 0.78;
      const pz = backZ + sideZ * side * 0.78;
      smoke.emit(px, 0.18, pz,
        (Math.random() - 0.5) * 1.4 - sideX * side * 0.4,
        0.6 + Math.random() * 1.1,
        (Math.random() - 0.5) * 1.4 - sideZ * side * 0.4,
        1.1 + Math.random() * 1.2, 0.7 + Math.random() * 0.7, '#d8d4cc', 1.8);
    }
    skids.addQuad(x, z, heading, 0.34, 0.42, strength);
  }

  /** A car's death: a fireball, black smoke and a jolt on the camera. */
  function explode(x, y, z, scale = 1) {
    counters.explosions += 1;
    shake(1.0);
    for (let index = 0; index < 34 * scale; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 9;
      fire.emit(x, y + 0.5, z,
        Math.cos(angle) * speed, 1.5 + Math.random() * 8, Math.sin(angle) * speed,
        0.35 + Math.random() * 0.55, 0.9 + Math.random() * 1.4,
        index % 4 === 0 ? '#fff0b0' : (index % 3 === 0 ? '#ff9c3c' : '#ff5b26'), 1.5);
    }
    for (let index = 0; index < 22 * scale; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 3.4;
      smoke.emit(x, y + 0.9, z,
        Math.cos(angle) * speed, 1.2 + Math.random() * 4.5, Math.sin(angle) * speed,
        1.4 + Math.random() * 1.6, 1.2 + Math.random() * 1.6, index % 5 === 0 ? '#6b625a' : '#3d3a36', 2.2);
    }
    for (let index = 0; index < 16 * scale; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 10;
      sparks.emit(x, y + 0.6, z,
        Math.cos(angle) * speed, 2 + Math.random() * 7, Math.sin(angle) * speed,
        0.3 + Math.random() * 0.5, 0.16 + Math.random() * 0.2, '#ffd27a');
    }
  }

  /** Pickup glitter: coins, the job's marker and a shop purchase each use it. */
  function sparkleBurst(x, y, z, color = '#ffe08a') {
    counters.sparkle += 1;
    for (let index = 0; index < 14; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2.2;
      sparkle.emit(x, y, z,
        Math.cos(angle) * speed, 1.2 + Math.random() * 3.2, Math.sin(angle) * speed,
        0.5 + Math.random() * 0.6, 0.12 + Math.random() * 0.2, color);
    }
  }

  /** A wall of white water where the bay meets the sand. */
  function splash(x, z, strength = 1) {
    counters.splash += 1;
    for (let index = 0; index < 10 * strength; index += 1) {
      splashSystemEmit(x + (Math.random() - 0.5) * 2, 0.1, z + (Math.random() - 0.5) * 3);
    }
  }

  function splashSystemEmit(x, y, z) {
    water.emit(x, y, z,
      (Math.random() - 0.5) * 3, 1.4 + Math.random() * 3.4, (Math.random() - 0.5) * 3,
      0.45 + Math.random() * 0.5, 0.28 + Math.random() * 0.4, '#e8fbff', 1.6);
  }

  /**
   * Reduces a car's health and leaves the effect to the car: smoke below 40, fire below 18,
   * one explosion at zero. A player's own car only ever reaches 12, so it never dies mid-drive.
   */
  function damageCar(car, amount, { playerCar = false } = {}) {
    if (!car) return 0;
    const health = Math.max(0, (car.health ?? 100) - Math.max(0, amount));
    car.health = playerCar ? Math.max(12, health) : health;
    return car.health;
  }

  /** Per-frame car wear: smoke, fire, then the explosion the frame health reaches zero. */
  function updateCars(dt, cars) {
    for (const car of cars) {
      if (!car || !Number.isFinite(car.health)) continue;
      const clock = (carClock.get(car) ?? 0) + dt;
      carClock.set(car, clock);
      const { position } = car;
      if (car.health <= 0) {
        if (!car.exploded) {
          car.exploded = true;
          explode(position.x, 0.7, position.z);
          car.group?.traverse?.((child) => {
            if (child.isMesh && child.material && child.material.color) {
              child.material = child.material.clone();
              child.material.color.set('#2b2824');
            }
          });
        }
        continue;
      }
      if (car.health < 40 && clock > 0.16 + car.health * 0.004) {
        carClock.set(car, 0);
        smoke.emit(position.x + (Math.random() - 0.5) * 0.8, 1.2, position.z + (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6,
          0.9 + Math.random() * 0.8, 0.5 + Math.random() * 0.6,
          car.health < 18 ? '#4a443d' : '#b9b4aa', 1.6);
      }
      if (car.health < 18 && Math.random() < dt * 9) {
        fire.emit(position.x + (Math.random() - 0.5) * 0.7, 1.0, position.z + (Math.random() - 0.5) * 0.7,
          (Math.random() - 0.5) * 0.5, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 0.5,
          0.18 + Math.random() * 0.18, 0.38 + Math.random() * 0.3, '#ff8a3c');
      }
    }
  }

  function update(dt, camera) {
    for (const flash of flashes) {
      if (flash.life <= 0) continue;
      flash.life = Math.max(0, flash.life - dt);
      flash.mesh.quaternion.copy(camera.quaternion);
      flash.mesh.material.opacity = 0.95 * (flash.life / flash.max);
      if (flash.life === 0) flash.mesh.visible = false;
    }
    for (const tracer of tracers) {
      if (tracer.life <= 0) continue;
      tracer.life = Math.max(0, tracer.life - dt);
      tracer.line.material.opacity = 0.9 * (tracer.life / tracer.max);
      if (tracer.life === 0) tracer.line.visible = false;
    }
    sparks.update(dt);
    smoke.update(dt);
    fire.update(dt);
    sparkle.update(dt);
    water.update(dt);
    skids.update(dt);
    shakeAmount *= Math.exp(-7 * dt);
    if (shakeAmount < 0.002) shakeAmount = 0;
  }

  return {
    muzzle,
    tracer,
    spark,
    shake,
    tireSmoke,
    explode,
    sparkle: sparkleBurst,
    splash,
    damageCar,
    updateCars,
    update,
    counters,
    get shakeAmount() {
      return shakeAmount;
    },
    applyShake(camera) {
      if (shakeAmount <= 0) return;
      camera.position.x += (Math.random() - 0.5) * shakeAmount * 0.5;
      camera.position.y += (Math.random() - 0.5) * shakeAmount * 0.4;
      camera.position.z += (Math.random() - 0.5) * shakeAmount * 0.5;
    },
    /** The smoke test's window into the pool: live counts and lifetime totals. */
    stats() {
      return {
        live: {
          sparks: sparks.live, smoke: smoke.live, fire: fire.live,
          sparkle: sparkle.live, splash: water.live,
        },
        totals: { ...counters },
      };
    },
    reset() {
      for (const flash of flashes) {
        flash.life = 0;
        flash.mesh.visible = false;
      }
      for (const tracer of tracers) {
        tracer.life = 0;
        tracer.line.visible = false;
      }
      sparks.clear();
      smoke.clear();
      fire.clear();
      sparkle.clear();
      water.clear();
      skids.clear();
      shakeAmount = 0;
    },
  };
}
