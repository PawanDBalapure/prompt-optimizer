'use strict';
/**
 * Generates images/icon.png (128x128) matching onboarding.html's header logo.
 * No external dependencies; uses only Node built-ins.
 *
 * Design parity with media/onboarding.html .logo:
 *  - Rounded square tile
 *  - Conic-like accent -> blue -> teal sweep
 *  - Bold centered "P" in dark foreground
 */

const zlib = require('node:zlib');
const fs   = require('node:fs');
const path = require('node:path');

const W = 128, H = 128;
const buf = Buffer.alloc(W * H * 4, 0); // RGBA, all transparent initially
const STOPS = [
  { r: 77,  g: 170, b: 252 },
  { r: 86,  g: 156, b: 214 },
  { r: 78,  g: 201, b: 176 },
];

// ── helpers ──────────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }

function setpx(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  if (a >= 255) {
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  } else if (a > 0) {
    const fa = a / 255, ba = buf[i+3] / 255;
    const na = fa + ba * (1 - fa);
    if (na > 0) {
      buf[i]   = Math.round((r * fa + buf[i]   * ba * (1-fa)) / na);
      buf[i+1] = Math.round((g * fa + buf[i+1] * ba * (1-fa)) / na);
      buf[i+2] = Math.round((b * fa + buf[i+2] * ba * (1-fa)) / na);
      buf[i+3] = Math.round(na * 255);
    }
  }
}

function fillRect(x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++)
      setpx(x, y, r, g, b, a);
}

function isInsideRoundedTile(x, y) {
  const nx = x < CR ? CR - x : (x >= W - CR ? x - (W - CR - 1) : 0);
  const ny = y < CR ? CR - y : (y >= H - CR ? y - (H - CR - 1) : 0);
  return !(nx > 0 && ny > 0 && nx * nx + ny * ny > CR * CR);
}

// Background tile with rounded corners, matching onboarding logo geometry.
const CR = 22;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isInsideRoundedTile(x, y)) continue;

    // Approximate CSS conic-gradient(from 0deg, accent, blue, teal, accent)
    // used in onboarding .logo.
    const dx = x - (W / 2);
    const dy = y - (H / 2);
    let deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    deg = (deg + 90) % 360; // align start near top similar to CSS rendering

    const seg = (deg / 120) % 3;
    const i = Math.floor(seg);
    const t = seg - i;
    const a = STOPS[i];
    const b = STOPS[(i + 1) % 3];

    const r = Math.round(lerp(a.r, b.r, t));
    const g = Math.round(lerp(a.g, b.g, t));
    const bch = Math.round(lerp(a.b, b.b, t));
    setpx(x, y, r, g, bch, 255);
  }
}

// Subtle vignette so the "P" remains legible at 128x128 and 64x64 scales.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isInsideRoundedTile(x, y)) continue;
    const dx = (x - 64) / 64;
    const dy = (y - 64) / 64;
    const d = Math.min(1, Math.hypot(dx, dy));
    const alpha = Math.round(lerp(0, 40, d));
    setpx(x, y, 20, 32, 42, alpha);
  }
}

// Draw a bold geometric "P" similar to the onboarding glyph.
const PR = 30, PG = 30, PB = 30;

// Stem
fillRect(42, 27, 14, 74, PR, PG, PB);

// Upper bowl (filled circle with inner knock-out)
const cx = 58;
const cy = 48;
const outer = 20;
const inner = 10;
for (let y = cy - outer; y <= cy + outer; y++) {
  for (let x = cx - 2; x <= cx + outer; x++) {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    if (d2 <= outer * outer) {
      setpx(x, y, PR, PG, PB, 255);
    }
    const in2 = (x - (cx + 2)) ** 2 + (y - cy) ** 2;
    if (in2 <= inner * inner && x >= cx + 2) {
      const rx = x - 64;
      const ry = y - 64;
      let ideg = (Math.atan2(ry, rx) * 180 / Math.PI + 360) % 360;
      ideg = (ideg + 90) % 360;
      const iseg = (ideg / 120) % 3;
        const i = Math.floor(iseg);
      const it = iseg - i;
        const a = STOPS[i];
        const b = STOPS[(i + 1) % 3];
      setpx(
        x,
        y,
        Math.round(lerp(a.r, b.r, it)),
        Math.round(lerp(a.g, b.g, it)),
        Math.round(lerp(a.b, b.b, it)),
        255,
      );
    }
  }
}

// Encode to PNG.
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

// Raw scanlines: filter-byte(0) + RGBA row
const rows = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  rows[y * (1 + W * 4)] = 0; // filter = None
  buf.copy(rows, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}

const compressed = zlib.deflateSync(rows, { level: 9 });
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const pngBuf = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, pngBuf);
console.log('Icon written:', outPath, `(${pngBuf.length} bytes)`);
