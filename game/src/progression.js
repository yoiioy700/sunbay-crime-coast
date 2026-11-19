// Progression: the story's unlocks and the numbers the pause menu shows. Nothing here spends
// money or starts a mission; it only reads how many missions are done and says what that
// count opens — the SMG after mission 3, the sports-car discount after mission 5, and Mama
// Rosa's final heist after mission 6. It also keeps the two lifetime stats that no other
// module owns: how long the player has been on the street and the fastest they have driven.
//
// The unlocks are derived from the mission count on every call, never stored as flags, so a
// save that says six missions done opens the same doors after a reload as one that just
// finished them.

/** Mission counts at which each unlock opens. */
export const UNLOCK_AT = {
  smg: 3,
  sportsDiscount: 5,
  heist: 6,
};

/** The sports car costs this share of its list price once the dock discount opens. */
export const SPORTS_DISCOUNT = 0.8;

/** What `missionsDone` unlocks: { smg, sportsDiscount, heist, } each a boolean. */
export function unlocksFor(missionsDone) {
  return {
    smg: missionsDone >= UNLOCK_AT.smg,
    sportsDiscount: missionsDone >= UNLOCK_AT.sportsDiscount,
    heist: missionsDone >= UNLOCK_AT.heist,
  };
}

/** "4m 07s", "0s", "1h 02m": the pause menu's time-played phrase. */
export function formatPlayTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (total >= 60) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${total}s`;
}

export function createProgression() {
  const stats = { playSeconds: 0, topSpeed: 0 };

  /**
   * One step of the clock. `speed` is the driven speed in m/s and only counts while the player
   * is in a car; the top-speed record is stored in km/h for the stat panel.
   */
  function tick(dt, speed = 0) {
    stats.playSeconds += dt;
    const kmh = Number(speed) * 3.6;
    if (Number.isFinite(kmh) && kmh > stats.topSpeed) stats.topSpeed = kmh;
  }

  /** The list price of a sports car after the dock discount, when it is open. */
  function sportsPrice(basePrice, missionsDone) {
    return unlocksFor(missionsDone).sportsDiscount
      ? Math.round(basePrice * SPORTS_DISCOUNT)
      : basePrice;
  }

  /** The rows of the pause menu's stats card. */
  function statsPanel({ missionsDone = 0, carsOwned = 0 } = {}) {
    return [
      ['MISSIONS DONE', `${missionsDone} / 7`],
      ['CARS OWNED', String(carsOwned)],
      ['TOP SPEED', `${Math.round(stats.topSpeed)} KM/H`],
      ['TIME PLAYED', formatPlayTime(stats.playSeconds)],
    ];
  }

  /** A one-line note on what the last mission opened, for the completion banner. */
  function unlockNote(missionsDone) {
    if (missionsDone === UNLOCK_AT.smg) return 'SMG UNLOCKED AT PIER 4 ARMS';
    if (missionsDone === UNLOCK_AT.sportsDiscount) return 'DOCK DISCOUNT · 20% OFF SPORTS CARS';
    if (missionsDone === UNLOCK_AT.heist) return 'MAMA ROSA HAS ONE LAST JOB';
    return '';
  }

  function snapshot() {
    return { playSeconds: stats.playSeconds, topSpeed: stats.topSpeed };
  }

  function restore(data) {
    if (!data || typeof data !== 'object') return;
    if (Number.isFinite(data.playSeconds)) stats.playSeconds = Math.max(0, data.playSeconds);
    if (Number.isFinite(data.topSpeed)) stats.topSpeed = Math.max(0, data.topSpeed);
  }

  function reset() {
    stats.playSeconds = 0;
    stats.topSpeed = 0;
  }

  return {
    stats,
    unlocksFor,
    sportsPrice,
    unlockNote,
    tick,
    statsPanel,
    snapshot,
    restore,
    reset,
  };
}
