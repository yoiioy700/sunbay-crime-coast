// Seeded randomness for the whole world: one mulberry32 stream per system, so Sunbay is the
// same city on every load and on every machine. Nothing in the world layout uses Math.random.

/** mulberry32: 32-bit state, one fast multiply-heavy round per call, in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small helper around mulberry32 with the ranges the city generator asks for. */
export function createRng(seed) {
  const random = mulberry32(seed);
  return {
    random,
    /** A float in [min, max). */
    range(min, max) {
      return min + random() * (max - min);
    },
    /** An integer in [min, max]. */
    int(min, max) {
      return Math.floor(min + random() * (max - min + 1));
    },
    /** True with probability p. */
    chance(p) {
      return random() < p;
    },
    /** One element of a non-empty array. */
    pick(items) {
      return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
    },
  };
}
