// The Files Direct icon (a white arrow dropping into a tray, on the accent colour) as a PNG, drawn with no dependencies. One drawing for the web app's icons
// (scripts/make-icons.mjs) and for the desktop app's (export/scripts/app-build.mjs, which the export copies to the public repository next to this file).
// Pure: it writes no file. `scale` shrinks the drawing into a safe zone (a maskable icon); `samples` is the sampling grid per pixel side (edge smoothing).
import { deflateSync } from 'node:zlib';

const BG = [10, 108, 92];
const FG = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function inside(x, y, scale) {
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;
  const shaft = u > 0.44 && u < 0.56 && v > 0.2 && v < 0.55;
  const head = v >= 0.5 && v < 0.7 && Math.abs(u - 0.5) < (0.7 - v) * 1.1;
  const tray = v > 0.74 && v < 0.82 && u > 0.22 && u < 0.78;
  const wallL = u > 0.22 && u < 0.3 && v > 0.62 && v < 0.82;
  const wallR = u > 0.7 && u < 0.78 && v > 0.62 && v < 0.82;
  return shaft || head || tray || wallL || wallR;
}

export function iconPng(size, { scale = 1, samples = 3 } = {}) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) if (inside((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size, scale)) hit++;
      const a = hit / (samples * samples);
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
