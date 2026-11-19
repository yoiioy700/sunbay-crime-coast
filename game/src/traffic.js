// Ambient traffic on the street grid. Every car has a lane, a direction and a waypoint at the
// far side of the next intersection; on arrival it rolls straight on or turns, with turns
// chosen from a seeded stream so a reload replays the same flow. Right-hand traffic, lane
// offsets of 2.75 m, and a yield rule at intersections (cross traffic already inside has the
// right of way) keep the grid moving without a solver.
//
// Traffic cars are ordinary cars from vehicles.js: the player can walk up to any of them and
// drive it away. The AI is switched off the moment a car is adopted, and the stolen car's
// slot is left empty rather than respawned, so a theft is permanent.
//
// The module also raises events (a honk, a collision) that pedestrians.js listens to.

import * as THREE from 'three';
import { CITY } from './city.js';
import { CAR_COLORS, CAR_TYPE_NAMES, createCar } from './vehicles.js';
import { createRng } from './rng.js';

const LANE = 2.75;
const CRUISE_MIN = 6.5;
const CRUISE_MAX = 11.5;
const WAYPOINT_RADIUS = 4.2;
const LOOK_AHEAD = 15;
const SIDE_REACH = 2.4;

/** The road grid as numbers: line offset for index 0..10. */
const LINES = Array.from({ length: CITY.gridLines }, (_, index) => -CITY.halfSpan + index * CITY.pitch);
const HALF_ROAD = CITY.roadWidth / 2;

/** The lane point at `along` metres on a road described by (axis, offset, dir). */
function lanePoint(axis, offset, dir, along) {
  if (axis === 'z') return { x: offset + dir * LANE, z: along };
  return { x: along, z: offset - dir * LANE };
}

/** The unit forward and right of a (axis, dir) lane. Right is +90° clockwise from forward. */
function laneVectors(axis, dir) {
  if (axis === 'z') return { fx: 0, fz: dir, rx: dir, rz: 0 };
  return { fx: dir, fz: 0, rx: 0, rz: -dir };
}

/** A fresh route at a random point on the grid, pointed at the next intersection. */
function randomRoute(rng) {
  const axis = rng.chance(0.5) ? 'z' : 'x';
  const roadIndex = rng.int(0, CITY.gridLines - 1);
  const dir = rng.chance(0.5) ? 1 : -1;
  const offset = LINES[roadIndex];
  const alongIndex = rng.int(1, CITY.gridLines - 2);
  const along = LINES[alongIndex] + rng.range(-9, 9);
  return { axis, offset, dir, along, nextCross: LINES[alongIndex + dir] };
}

export function createTraffic(scene, city, options = {}) {
  const { count = 20, seed = 0x7a1f1c } = options;
  const rng = createRng(seed);
  const cars = [];
  const events = [];

  /** Puts a car on a lane, facing its direction, with a random body and colour. */
  function spawn(index) {
    let route = randomRoute(rng);
    let attempts = 0;
    // Keep the spawn clear of the player's crossroads and of each other.
    while (attempts < 24) {
      const type = CAR_TYPE_NAMES[rng.int(0, CAR_TYPE_NAMES.length - 1)];
      const probe = lanePoint(route.axis, route.offset, route.dir, route.along);
      const nearPlayer = Math.hypot(probe.x - city.spawn.x, probe.z - city.spawn.z) < 26;
      let nearCar = false;
      for (const other of cars) {
        if (Math.hypot(other.position.x - probe.x, other.position.z - probe.z) < 16) {
          nearCar = true;
          break;
        }
      }
      if (!nearPlayer && !nearCar) {
        const color = CAR_COLORS[rng.int(0, CAR_COLORS.length - 1)];
        const vectors = laneVectors(route.axis, route.dir);
        const heading = Math.atan2(vectors.fx, vectors.fz);
        const car = createCar(scene, city, { type, color, x: probe.x, z: probe.z, heading });
        const cruise = rng.range(CRUISE_MIN, CRUISE_MAX);
        car.ai = {
          axis: route.axis,
          offset: route.offset,
          dir: route.dir,
          nextCross: route.nextCross,
          speed: 0,
          cruise,
          waiting: 0,
          // The path is a short queue of waypoints: the stop line before an intersection, an
          // optional corner point, and the exit lane on the far side. A queued path is turned
          // one waypoint at a time, which keeps a turning car on the asphalt.
          path: [],
          turn: null,
          exitAlong: 0,
        };
        planPath(car.ai);
        cars.push(car);
        return car;
      }
      attempts += 1;
      route = randomRoute(rng);
    }
    void index;
    return null;
  }

  /** The lane point on a road `axis`/`offset` at distance `along`, offset by `dir`'s lane. */
  function pointAt(axis, offset, dir, along) {
    return lanePoint(axis, offset, dir, along);
  }

  /** The lane point on the road `axis`/`offset` at distance `along`, offset into the lane. */
  function laneAt(axis, offset, dir, along) {
    if (axis === 'z') return { x: offset + dir * LANE, z: along };
    return { x: along, z: offset - dir * LANE };
  }

  /**
   * Fills `ai.path` with the waypoints through the next intersection: the stop line at the
   * near edge, then either straight out the far side, or a corner where the two lane
   * centrelines meet plus an exit point on the new road. Routing this way keeps every
   * turning car on the asphalt instead of cutting the block corner.
   */
  function planPath(ai) {
    ai.path.length = 0;
    ai.turn = null;
    const crossing = ai.nextCross;
    const stopAlong = crossing - ai.dir * (HALF_ROAD + 2.2);
    ai.path.push(laneAt(ai.axis, ai.offset, ai.dir, stopAlong));

    const straightContinues = LINES.includes(crossing + ai.dir * CITY.pitch);
    let turn = null;
    if (!straightContinues || rng.random() >= 0.62) {
      const candidates = [];
      for (const sign of [1, -1]) {
        const next = crossing + sign * CITY.pitch;
        if (LINES.includes(next)) candidates.push({ sign, next });
      }
      if (candidates.length) turn = candidates[rng.int(0, candidates.length - 1)];
    }

    if (!turn) {
      ai.exitAlong = crossing + ai.dir * (HALF_ROAD + 2.6);
      ai.path.push(laneAt(ai.axis, ai.offset, ai.dir, ai.exitAlong));
      return;
    }

    const newAxis = ai.axis === 'z' ? 'x' : 'z';
    const newDir = turn.sign;
    // Where the two lane centrelines cross: the corner of the turn.
    const corner = ai.axis === 'z'
      ? { x: ai.offset + ai.dir * LANE, z: crossing - newDir * LANE }
      : { x: crossing + newDir * LANE, z: ai.offset - ai.dir * LANE };
    const exitAlong = crossing + newDir * (HALF_ROAD + 2.6);
    ai.path.push(corner);
    ai.path.push(laneAt(newAxis, crossing, newDir, exitAlong));
    ai.turn = { axis: newAxis, dir: newDir, crossing, nextCross: turn.next };
    ai.exitAlong = exitAlong;
  }

  /**
   * Advances past the intersection when the last waypoint is reached. A turn switches the
   * car onto the new road and aims at the next grid line beyond it.
   */
  function reroute(car, ai) {
    if (ai.turn) {
      const turn = ai.turn;
      ai.axis = turn.axis;
      ai.offset = turn.crossing;
      ai.dir = turn.dir;
      ai.nextCross = turn.nextCross;
    } else {
      const next = ai.nextCross + ai.dir * CITY.pitch;
      ai.nextCross = LINES.includes(next) ? next : ai.nextCross;
    }
    void car;
    planPath(ai);
  }

  /** True when the car is close to or has passed a waypoint. */
  function waypointReached(car, ai, target) {
    const distance = Math.hypot(target.x - car.position.x, target.z - car.position.z);
    if (distance < 2.6) return true;
    const next = ai.path[1];
    if (!next) return false;
    // Passed it: it is behind the car and the next waypoint is not.
    const headingX = Math.sin(car.heading);
    const headingZ = Math.cos(car.heading);
    const behind = (target.x - car.position.x) * headingX + (target.z - car.position.z) * headingZ;
    return behind < -1.5;
  }

  /** True when a car on the other axis is inside the junction this car is approaching. */
  function intersectionBusy(car, ai, others) {
    if (ai.path.length < 2 || ai.turn) return false;
    const centreX = ai.axis === 'z' ? ai.offset : ai.nextCross;
    const centreZ = ai.axis === 'z' ? ai.nextCross : ai.offset;
    if (Math.hypot(car.position.x - centreX, car.position.z - centreZ) > 20) return false;
    for (const other of others) {
      if (other === car) continue;
      const distance = Math.hypot(other.position.x - centreX, other.position.z - centreZ);
      if (distance < 9) {
        // A car already inside has the right of way; ties break by id so nobody deadlocks.
        const otherAxis = other.ai ? other.ai.axis : null;
        if (otherAxis === null || otherAxis !== ai.axis) return true;
        if (other.id < car.id) return true;
      }
    }
    return false;
  }

  /** The car (traffic or the player's) directly ahead in this lane, if any. */
  function carAhead(car, ai, others) {
    // Lane direction of the road the car is currently travelling on.
    const vectors = laneVectors(ai.axis, ai.dir);
    let closest = null;
    let closestAhead = LOOK_AHEAD;
    for (const other of others) {
      if (other === car) continue;
      const dx = other.position.x - car.position.x;
      const dz = other.position.z - car.position.z;
      const ahead = dx * vectors.fx + dz * vectors.fz;
      const side = Math.abs(dx * vectors.rx + dz * vectors.rz);
      if (ahead > 0.4 && ahead < closestAhead && side < SIDE_REACH) {
        closest = other;
        closestAhead = ahead;
      }
    }
    return closest ? { car: closest, ahead: closestAhead } : null;
  }

  function updateCar(car, dt, others) {
    const ai = car.ai;
    if (!ai) return;
    if (ai.path.length === 0) planPath(ai);

    // Waypoints are consumed as they are reached; the last one ends at the far side of the
    // junction, where the path is planned again for the next intersection.
    while (ai.path.length && waypointReached(car, ai, ai.path[0])) {
      ai.path.shift();
      if (ai.path.length === 0) reroute(car, ai);
    }

    const target = ai.path[0];
    if (!target) return;
    const stopDistance = Math.hypot(target.x - car.position.x, target.z - car.position.z);

    let targetSpeed = ai.cruise;
    // Slow into a turn, and slow for the stop line before the junction.
    if (ai.turn) targetSpeed = Math.min(targetSpeed, 5.6);
    if (ai.path.length >= 2 && !ai.turn) {
      targetSpeed = Math.min(targetSpeed, 4.2 + Math.max(0, stopDistance - 8) * 0.9);
    }

    const ahead = carAhead(car, ai, others);
    if (ahead) {
      const gap = ahead.ahead;
      const otherSpeed = ahead.car.speed ?? 0;
      if (gap < 8) targetSpeed = Math.min(targetSpeed, 0);
      else targetSpeed = Math.min(targetSpeed, Math.max(0, otherSpeed - 0.5) + (gap - 8) * 0.6);
    }

    // Yield at the junction: a car approaching the stop line waits for cross traffic.
    if (ai.path.length >= 2 && intersectionBusy(car, ai, others)) {
      targetSpeed = Math.min(targetSpeed, Math.max(0, (stopDistance - 1.2) * 1.4));
    }

    const accel = 6.5;
    const brake = 14;
    if (targetSpeed > ai.speed) ai.speed = Math.min(targetSpeed, ai.speed + accel * dt);
    else ai.speed = Math.max(targetSpeed, ai.speed - brake * dt);
    if (ai.speed < 0.02) ai.speed = 0;
    ai.waiting = ai.speed < 0.15 ? ai.waiting + dt : 0;

    // Steering: ease the heading toward the waypoint, limited by speed.
    const desiredHeading = Math.atan2(target.x - car.position.x, target.z - car.position.z);
    let difference = desiredHeading - car.heading;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    const maxTurn = Math.min(2.8, 1.0 + ai.speed * 0.24) * dt;
    car.heading += Math.max(-maxTurn, Math.min(maxTurn, difference));

    car.position.x += Math.sin(car.heading) * ai.speed * dt;
    car.position.z += Math.cos(car.heading) * ai.speed * dt;
    car.speed = ai.speed;
    car.group.position.copy(car.position);
    car.group.rotation.y = car.heading;

    // Keep traffic on the asphalt and inside the map, however a turn went.
    const { bounds } = city;
    car.position.x = Math.min(bounds.maxX - 1, Math.max(bounds.minX + 1, car.position.x));
    car.position.z = Math.min(bounds.maxZ - 1, Math.max(bounds.minZ + 1, car.position.z));
  }

  /** A honk near (x, z) makes the traffic below slow for a moment; the event is for the peds. */
  function honk(x, z, radius = 26) {
    events.push({ type: 'honk', x, z, radius });
    for (const car of cars) {
      if (car.driver) continue;
      if (Math.hypot(car.position.x - x, car.position.z - z) < radius && car.ai) {
        car.ai.cruise = Math.max(3.5, car.ai.cruise * 0.85);
      }
    }
  }

  /** A crash at (x, z): the event scatters pedestrians; nearby traffic stops for a spell. */
  function crash(x, z, radius = 20) {
    events.push({ type: 'crash', x, z, radius });
    for (const car of cars) {
      if (car.driver) continue;
      if (Math.hypot(car.position.x - x, car.position.z - z) < radius && car.ai) {
        car.ai.turnTimer = Math.max(car.ai.turnTimer ?? 0, 1.4);
        car.ai.speed = Math.min(car.ai.speed, 2);
      }
    }
  }

  /** Nudges the player's car off a traffic car it has driven into, and raises a crash. */
  function collideWithDriven(driven) {
    if (!driven || driven.speed < 2.5) return;
    for (const other of cars) {
      if (other === driven || other.driver) continue;
      const dx = other.position.x - driven.position.x;
      const dz = other.position.z - driven.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 4.1) continue;
      const nx = distance > 0.001 ? dx / distance : 1;
      const nz = distance > 0.001 ? dz / distance : 0;
      other.position.x += nx * (4.1 - distance) * 0.9;
      other.position.z += nz * (4.1 - distance) * 0.9;
      other.group.position.copy(other.position);
      if (other.ai) {
        other.ai.speed = Math.min(other.ai.speed, 2);
        other.ai.turnTimer = 1.2;
      }
      driven.velocity.multiplyScalar(0.55);
      driven.speed *= 0.55;
      crash(other.position.x, other.position.z, 22);
      return;
    }
  }

  /** Drops a traffic car from the AI list; called when the player steals it. */
  function release(car) {
    const index = cars.indexOf(car);
    if (index >= 0) cars.splice(index, 1);
  }

  function drainEvents() {
    return events.splice(0, events.length);
  }

  // Fill the street with cars at boot.
  for (let index = 0; index < count; index += 1) spawn(index);
  // A car the spawner rejected for crowding still gets a slot, so the count holds.
  while (cars.length < count) {
    const before = cars.length;
    spawn(cars.length);
    if (cars.length === before) break;
  }

  function update(dt, driven) {
    const others = driven ? [...cars, driven] : cars;
    for (const car of cars) {
      if (car.driver || !car.ai) continue;
      updateCar(car, dt, others);
    }
    if (driven) collideWithDriven(driven);
  }

  return {
    cars,
    update,
    release,
    honk,
    crash,
    drainEvents,
    get count() {
      return cars.length;
    },
    /** The nearest traffic car to a point, for the enter prompt. */
    nearest(point, radius = 3.6) {
      let best = null;
      let bestDistance = radius;
      for (const car of cars) {
        if (car.driver) continue;
        const distance = Math.hypot(car.position.x - point.x, car.position.z - point.z);
        if (distance < bestDistance) {
          best = car;
          bestDistance = distance;
        }
      }
      return best ? { car: best, distance: bestDistance } : null;
    },
  };
}
