// Draws the toolbar icons (a lightning bolt on a rounded square) into assets/. Run once after
// changing the design: node scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BOLT = [
  [0.58, 0.1],
  [0.24, 0.56],
  [0.47, 0.56],
  [0.4, 0.9],
  [0.76, 0.42],
  [0.53, 0.42],
];

function inside(x, y, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function inRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function pixels(size) {
  const data = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let bolt = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (inRoundedSquare(x, y, 0.22)) bg++;
          if (inside(x, y, BOLT)) bolt++;
        }
      const total = samples * samples;
      const a = bg / total;
      const b = bolt / total;
      const offset = (py * size + px) * 4;
      // Background #6d5dfc, bolt white.
      data[offset] = Math.round(0x6d * (1 - b) + 255 * b);
      data[offset + 1] = Math.round(0x5d * (1 - b) + 255 * b);
      data[offset + 2] = Math.round(0xfc * (1 - b) + 255 * b);
      data[offset + 3] = Math.round(255 * a);
    }
  return data;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const raw = pixels(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128])
  writeFileSync(new URL(`../assets/icon-${size}.png`, import.meta.url), png(size));
