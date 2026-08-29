import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUTPUT = resolve(ROOT, 'public/icons');
const IDENTITY = JSON.parse(
  readFileSync(resolve(ROOT, 'brand/v3/geometry.json'), 'utf8'),
);
export const ICON_SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 8;
const UNKNOWN_DASH_FRACTION = 0.1;
const DIM = [0x8a, 0x85, 0x7d];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function layout(size) {
  const variant = size < 18 ? 'small' : 'regular';
  const source = IDENTITY[variant];
  const scale = size / source.viewBox.height;
  const centreX = size / 2;
  const base = variant === 'small'
    ? IDENTITY.small.emberTransform
    : { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };
  const body = source.body;
  const bodyWidth = Math.round(body.width * scale);
  const bodyHeight = Math.round(body.height * scale);
  const emberScaleX = base.scaleX * scale;
  const canonicalEmberCentre =
    IDENTITY.regular.emberBounds.x + IDENTITY.regular.emberBounds.width / 2;
  return {
    variant,
    body: {
      x: centreX - bodyWidth / 2,
      y: size - bodyHeight,
      width: bodyWidth,
      height: bodyHeight,
      radius: Math.min(body.radius * scale, bodyWidth / 2),
    },
    emberTransform: {
      scaleX: emberScaleX,
      scaleY: base.scaleY * scale,
      translateX: centreX - canonicalEmberCentre * emberScaleX,
      translateY: base.translateY * scale,
    },
  };
}

function arcPoints() {
  const x1 = 8.45405845398161;
  const y1 = 9.55;
  const x2 = 27.54594154601839;
  const y2 = 9.55;
  const radius = 13.5;
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const factor = Math.sqrt(
    Math.max(0, (radius ** 4 - radius ** 2 * dy ** 2 - radius ** 2 * dx ** 2)
      / (radius ** 2 * dy ** 2 + radius ** 2 * dx ** 2)),
  );
  const centreX = (x1 + x2) / 2 + factor * dy;
  const centreY = (y1 + y2) / 2 - factor * dx;
  const start = Math.atan2((y1 - centreY) / radius, (x1 - centreX) / radius);
  const end = Math.atan2((y2 - centreY) / radius, (x2 - centreX) / radius);
  let delta = end - start;
  if (delta >= 0) delta -= Math.PI * 2;

  const points = [];
  for (let index = 0; index <= 256; index += 1) {
    const angle = start + delta * (index / 256);
    points.push({
      x: centreX + radius * Math.cos(angle),
      y: centreY + radius * Math.sin(angle),
    });
  }
  return points;
}

const CANONICAL_EMBER = [
  { x: 18, y: 0 },
  { x: 8.45405845398161, y: 9.55 },
  ...arcPoints().slice(1),
];

function emberPolygon(transform) {
  return CANONICAL_EMBER.map(({ x, y }) => ({
    x: x * transform.scaleX + transform.translateX,
    y: y * transform.scaleY + transform.translateY,
  }));
}

function inPolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if (((a.y > y) !== (b.y > y)) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function inRoundedRect(x, y, rect) {
  if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) return false;
  const radius = Math.min(rect.radius, rect.width / 2, rect.height / 2);
  const nearestX = Math.max(rect.x + radius, Math.min(x, rect.x + rect.width - radius));
  const nearestY = Math.max(rect.y + radius, Math.min(y, rect.y + rect.height - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

/** Rasterise the honest pre-reading state: unlit ember plus a centred dash. */
export function rasterUnknown(size) {
  const { variant, body, emberTransform } = layout(size);
  const polygon = emberPolygon(emberTransform);
  const tile = rgb(IDENTITY.colours.tile);
  const track = rgb(
    variant === 'small' ? IDENTITY.colours.trackSmall : IDENTITY.colours.trackRegular,
  );
  const dashHeight = Math.max(1, Math.round(body.height * UNKNOWN_DASH_FRACTION));
  const dashTop = Math.round(body.y + (body.height - dashHeight) / 2);
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const channels = [0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;
          const insideBody = inRoundedRect(px, py, body);
          const colour = insideBody && py >= dashTop && py < dashTop + dashHeight
            ? DIM
            : insideBody || inPolygon(px, py, polygon)
              ? track
              : tile;
          channels[0] += colour[0];
          channels[1] += colour[1];
          channels[2] += colour[2];
        }
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(channels[0] / samples);
      pixels[offset + 1] = Math.round(channels[1] / samples);
      pixels[offset + 2] = Math.round(channels[2] / samples);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    rows[row] = 0;
    pixels.copy(rows, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function generateIcons(output = OUTPUT) {
  mkdirSync(output, { recursive: true });
  return ICON_SIZES.map((size) => {
    const bytes = encodePng(size, rasterUnknown(size));
    const path = resolve(output, `${size}.png`);
    writeFileSync(path, bytes);
    return { size, path, bytes };
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIcons();
}
