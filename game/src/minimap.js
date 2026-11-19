// The real minimap: a 2D canvas in the HUD that rotates under a fixed player arrow, so the
// city turns and the nose of the arrow is always "ahead". Roads are drawn from the city's own
// street plan (CITY.gridLines / pitch / roadWidth), the beach and the ocean from CITY's
// shoreline, and the blips come from the systems that own them: the job's marker, the shops,
// police cruisers (flashing red and blue while wanted), traffic dots and, while a car is
// driven, the body's own car. Zoom steps with + and - from 55 m to 220 m.
//
// Nothing here reads the scene: the caller hands in lists of plain { x, z } points each frame,
// so the map costs one fill and a few dozen fills per frame on a canvas the size of a postage
// stamp, and never touches WebGL.

import { CITY } from './city.js';

export const ZOOM_STEPS = [55, 80, 110, 150, 220];
const DEFAULT_ZOOM = 2;

/** The road lines as world coordinates, from the same plan city.js builds. */
function roadLines() {
  const lines = [];
  for (let line = 0; line < CITY.gridLines; line += 1) {
    lines.push(-CITY.halfSpan + line * CITY.pitch);
  }
  return lines;
}

/**
 * Builds the map into `canvas`. `getHeading` returns the player's bearing in radians (the same
 * convention as player.heading and car.heading: 0 faces +Z).
 */
export function createMinimap(canvas, { getHeading = () => 0 } = {}) {
  const context = canvas.getContext('2d');
  const size = canvas.width;
  const centre = size / 2;
  const lines = roadLines();
  const roadHalf = CITY.roadWidth / 2;
  let zoomIndex = DEFAULT_ZOOM;
  let drawn = 0;
  let lastHeading = 0;
  let flash = 0;

  /** Metres from the map's centre to its edge, at the current zoom. */
  function range() {
    return ZOOM_STEPS[zoomIndex];
  }

  function setZoom(index) {
    zoomIndex = Math.max(0, Math.min(ZOOM_STEPS.length - 1, index));
    return range();
  }

  function zoomIn() {
    return setZoom(zoomIndex + 1);
  }

  function zoomOut() {
    return setZoom(zoomIndex - 1);
  }

  /**
   * Draws one frame. `frame` is {
   *   x, z: the player's world position,
   *   blips: [{ x, z, kind }] where kind is 'objective', 'shop', 'giver', 'police' or 'car',
   *   traffic: [{ x, z }],
   *   wanted: the police level, so cruisers flash while it is above zero,
   *   time: a running clock in seconds, for the flash and the pulse,
   * }.
   */
  function draw(frame) {
    const { x, z, blips = [], traffic = [], wanted = 0, time = 0 } = frame ?? {};
    const metres = range();
    const scale = (centre - 10) / metres;
    const heading = getHeading();
    lastHeading = heading;
    flash = Math.sin(time * 9) > 0 ? 1 : 0;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, size, size);

    // The map turns so the way the player faces is up: +Z at heading 0 must land above the
    // arrow, which is a rotation by heading + pi in canvas space.
    const turn = heading + Math.PI;
    context.save();
    context.translate(centre, centre);
    context.rotate(turn);
    context.translate(-x * scale, -z * scale);

    context.fillStyle = '#0d2734';
    context.fillRect(-CITY.halfSpan - 400, -CITY.halfSpan - 400,
      (CITY.halfSpan + 400) * 2, (CITY.halfSpan + 400) * 2);
    // The sand strip before the water, then the sea itself.
    context.fillStyle = '#7d6a45';
    context.fillRect(CITY.beachStartX * scale, -CITY.halfSpan * scale,
      (CITY.waterStartX - CITY.beachStartX) * scale, CITY.span * scale);
    context.fillStyle = '#14475c';
    context.fillRect(CITY.waterStartX * scale, -CITY.halfSpan * scale - 400,
      700 * scale, (CITY.span + 800) * scale);

    // The city's asphalt: the avenues and the cross streets, both from the same line list.
    context.fillStyle = '#2f4a52';
    const half = CITY.halfSpan;
    for (const offset of lines) {
      context.fillRect(offset * scale - roadHalf * scale, -half * scale,
        roadHalf * 2 * scale, CITY.span * scale);
      context.fillRect(-half * scale, offset * scale - roadHalf * scale,
        CITY.span * scale, roadHalf * 2 * scale);
    }
    // The block interiors read as lighter ground between the roads.
    context.fillStyle = '#20343a';
    for (let line = 0; line < lines.length - 1; line += 1) {
      for (let other = 0; other < lines.length - 1; other += 1) {
        const left = lines[line] + roadHalf;
        const top = lines[other] + roadHalf;
        context.fillRect(left * scale, top * scale,
          (CITY.pitch - roadHalf * 2) * scale, (CITY.pitch - roadHalf * 2) * scale);
      }
    }

    // Traffic: small pale dots, drawn under the blips.
    context.fillStyle = 'rgba(226,232,226,0.55)';
    for (const car of traffic) {
      context.beginPath();
      context.arc(car.x * scale, car.z * scale, 1.4, 0, Math.PI * 2);
      context.fill();
    }

    // Blips. The sprite rotates with the map, so draw each upright in screen space.
    for (const blip of blips) {
      context.save();
      context.translate(blip.x * scale, blip.z * scale);
      context.rotate(-turn);
      if (blip.kind === 'police') {
        context.fillStyle = flash ? '#6fa8ff' : '#ff5a4f';
        context.beginPath();
        context.arc(0, 0, 3.4, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = 'rgba(0,0,0,0.5)';
        context.lineWidth = 1;
        context.stroke();
      } else if (blip.kind === 'shop') {
        context.rotate(Math.PI / 4);
        context.fillStyle = '#62d99a';
        context.fillRect(-2.6, -2.6, 5.2, 5.2);
      } else if (blip.kind === 'objective' || blip.kind === 'giver') {
        const pulse = 4.2 + Math.sin(time * 3.4) * 0.9;
        context.fillStyle = 'rgba(255,208,94,0.22)';
        context.beginPath();
        context.arc(0, 0, pulse + 2.6, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = '#ffd05e';
        context.beginPath();
        context.arc(0, 0, pulse, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillStyle = '#ffcf92';
        context.beginPath();
        context.arc(0, 0, 2.6, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    }
    context.restore();

    // The rim, a faint range ring, the north needle and the player's own arrow.
    context.save();
    context.translate(centre, centre);
    context.strokeStyle = 'rgba(255,244,226,0.2)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(0, 0, centre - 8, 0, Math.PI * 2);
    context.stroke();

    // North: -Z is north. Under the map's rotation that direction lands at this angle.
    const northAngle = -Math.PI / 2 + turn;
    context.save();
    context.translate(0, 0);
    context.rotate(northAngle + Math.PI / 2);
    context.translate(0, -(centre - 16));
    context.fillStyle = '#ffcf92';
    context.beginPath();
    context.moveTo(0, -5);
    context.lineTo(3.6, 4);
    context.lineTo(0, 1.6);
    context.lineTo(-3.6, 4);
    context.closePath();
    context.fill();
    context.restore();
    context.fillStyle = '#ffcf92';
    context.font = '700 9px ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const nX = Math.cos(northAngle) * (centre - 16);
    const nY = Math.sin(northAngle) * (centre - 16);
    context.fillText('N', nX, nY - 10);

    // The arrow: always up, with a warm glow under it.
    context.rotate(0);
    context.fillStyle = 'rgba(255,224,168,0.22)';
    context.beginPath();
    context.arc(0, 0, 7.5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffe0a8';
    context.beginPath();
    context.moveTo(0, -6.2);
    context.lineTo(4.6, 5);
    context.lineTo(0, 2.4);
    context.lineTo(-4.6, 5);
    context.closePath();
    context.fill();
    context.strokeStyle = 'rgba(20,32,38,0.85)';
    context.lineWidth = 1;
    context.stroke();
    context.restore();

    drawn += 1;
  }

  return {
    canvas,
    draw,
    zoomIn,
    zoomOut,
    setZoom,
    get zoom() {
      return range();
    },
    get zoomIndex() {
      return zoomIndex;
    },
    get heading() {
      return lastHeading;
    },
    get frames() {
      return drawn;
    },
    /** For the smoke test: how many pixels in the canvas are not transparent. */
    paintedPixels() {
      const data = context.getImageData(0, 0, size, size).data;
      let count = 0;
      for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count += 1;
      return count;
    },
  };
}
