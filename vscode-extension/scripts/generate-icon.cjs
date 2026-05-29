'use strict';
/**
 * Generates images/icon.png (128×128) for the Prompt Proxy Optimizer extension.
 * No external dependencies — uses only Node built-ins (zlib, fs, path).
 *
 * Design:
 *  • Deep navy-indigo radial-gradient background with rounded corners
 *  • Bold capital "P" in bright lavender-white (stem + D-bowl)
 *  • Violet curved arc around the bowl (proxy / pipeline motif)
 *  • 4-pointed gold sparkle star top-right corner
 *  • Small gold accent dot bottom-right
 */

const zlib = require('node:zlib');
const fs   = require('node:fs');
const path = require('node:path');

const W = 128, H = 128;
const buf = Buffer.alloc(W * H * 4, 0); // RGBA, all transparent initially

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

// ── 1. Background — dark indigo radial gradient, rounded corners (r=22) ──────
const CR = 22;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Corner test
    const nx = x < CR ? CR - x : (x >= W - CR ? x - (W - CR - 1) : 0);
    const ny = y < CR ? CR - y : (y >= H - CR ? y - (H - CR - 1) : 0);
    if (nx > 0 && ny > 0 && nx * nx + ny * ny > CR * CR) continue; // transparent

    // Radial gradient centre→edge: lighter indigo → deep navy
    const dx = (x - 64) / 64, dy = (y - 64) / 64;
    const d = Math.min(1, Math.hypot(dx, dy));
    setpx(x, y,
      Math.round(lerp(32, 10, d)),  // R
      Math.round(lerp(16,  6, d)),  // G
      Math.round(lerp(72, 28, d)),  // B
    );
  }
}

// ── 2. Inner glow ring (subtle) ───────────────────────────────────────────────
for (let deg = 0; deg < 360; deg++) {
  const rad = deg * Math.PI / 180;
  for (let r = 50; r <= 52; r++) {
    const gx = Math.round(64 + r * Math.cos(rad));
    const gy = Math.round(64 + r * Math.sin(rad));
    setpx(gx, gy, 120, 80, 200, 30);
  }
}

// ── 2b. Conic-gradient ring (matches onboarding header logo) ────────────────
// Sweeps purple → blue → teal → purple just inside the outer corner radius.
// Three palette stops in Catppuccin Mocha:
//   accent  (203,166,247)  blue (137,180,250)  teal (148,226,213)
const stops = [
  { r: 203, g: 166, b: 247 }, // 0°   accent
  { r: 137, g: 180, b: 250 }, // 120° blue
  { r: 148, g: 226, b: 213 }, // 240° teal
];
function conicColor(deg) {
  const seg = (deg / 120) % 3;
  const i = Math.floor(seg);
  const t = seg - i;
  const a = stops[i];
  const b = stops[(i + 1) % 3];
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}
for (let deg = 0; deg < 360; deg += 1) {
  const rad = (deg - 90) * Math.PI / 180; // start at top
  const c = conicColor(deg);
  for (let r = 56; r <= 60; r++) {
    const gx = Math.round(64 + r * Math.cos(rad));
    const gy = Math.round(64 + r * Math.sin(rad));
    // alpha falls off near the corner so the rounded shape isn't broken
    const dx = gx - 64, dy = gy - 64;
    if (Math.hypot(dx, dy) > 60) continue;
    setpx(gx, gy, c.r, c.g, c.b, 220);
  }
}

// ── 3. Bold letter "P" in bright lavender-white ───────────────────────────────
const LR = 238, LG = 220, LB = 255; // near-white lavender

// Stem: 16px wide, full height
fillRect(28, 20, 16, 84, LR, LG, LB);

// D-bowl: filled right semicircle, centre (44, 48), radius 24
// (x ≥ 44 only — right half joins the stem's right edge)
const BOWL_CX = 44, BOWL_CY = 48, BOWL_R = 24;
for (let y = BOWL_CY - BOWL_R; y <= BOWL_CY + BOWL_R; y++) {
  for (let x = BOWL_CX; x <= BOWL_CX + BOWL_R + 1; x++) {
    const d2 = (x - BOWL_CX) ** 2 + (y - BOWL_CY) ** 2;
    if (d2 <= BOWL_R * BOWL_R) setpx(x, y, LR, LG, LB);
  }
}

// ── 4. Violet proxy arc (clockwise, right side) ───────────────────────────────
// Arc around the P bowl: centre (78, 48), radius 32, angles ±110°
const VR = 168, VG = 130, VB = 255; // violet
const AX = 80, AY = 48, ARCR = 34;

for (let deg = -115; deg <= 115; deg++) {
  const rad = deg * Math.PI / 180;
  const px2 = AX + ARCR * Math.cos(rad);
  const py2 = AY + ARCR * Math.sin(rad);
  // 3 px thick
  for (let ddx = -2; ddx <= 2; ddx++)
    for (let ddy = -2; ddy <= 2; ddy++)
      if (ddx * ddx + ddy * ddy <= 4)
        setpx(Math.round(px2 + ddx), Math.round(py2 + ddy), VR, VG, VB, 210);
}

// Arrowhead at bottom tip of arc (deg = 115)
{
  const aRad = 115 * Math.PI / 180;
  const tipX = Math.round(AX + ARCR * Math.cos(aRad));
  const tipY = Math.round(AY + ARCR * Math.sin(aRad));
  // tangent direction at that angle
  const tX = -Math.sin(aRad), tY = Math.cos(aRad);
  // draw filled triangle (8px long, 6px wide at base)
  for (let i = 0; i <= 9; i++) {
    const hw = Math.round((9 - i) * 0.55);
    for (let j = -hw; j <= hw; j++) {
      setpx(
        Math.round(tipX + tX * i - (-tY) * j),
        Math.round(tipY + tY * i - tX * j),
        VR, VG, VB, 220
      );
    }
  }
}

// Arrowhead at top tip of arc (deg = -115)
{
  const aRad = -115 * Math.PI / 180;
  const tipX = Math.round(AX + ARCR * Math.cos(aRad));
  const tipY = Math.round(AY + ARCR * Math.sin(aRad));
  const tX = -Math.sin(aRad), tY = Math.cos(aRad);
  for (let i = 0; i <= 9; i++) {
    const hw = Math.round((9 - i) * 0.55);
    for (let j = -hw; j <= hw; j++) {
      setpx(
        Math.round(tipX - tX * i - (-tY) * j),
        Math.round(tipY - tY * i - tX * j),
        VR, VG, VB, 220
      );
    }
  }
}

// ── 5. Gold 4-pointed sparkle (top-right) ─────────────────────────────────────
const GR = 252, GG = 188, GB = 30;
const SX = 98, SY = 22;

for (let i = 0; i <= 13; i++) {
  const a = Math.round(255 * Math.pow(1 - i / 13, 1.2));
  setpx(SX, SY - i, GR, GG, GB, a); setpx(SX, SY + i, GR, GG, GB, a);
  setpx(SX - i, SY, GR, GG, GB, a); setpx(SX + i, SY, GR, GG, GB, a);
}
// Diagonal arms (shorter, softer)
for (let i = 0; i <= 7; i++) {
  const a = Math.round(255 * Math.pow(1 - i / 7, 1.5));
  setpx(SX - i, SY - i, GR, GG, GB, a); setpx(SX + i, SY - i, GR, GG, GB, a);
  setpx(SX - i, SY + i, GR, GG, GB, a); setpx(SX + i, SY + i, GR, GG, GB, a);
}

// ── 6. Small gold accent dot (bottom-right area) ──────────────────────────────
for (let ddx = -4; ddx <= 4; ddx++)
  for (let ddy = -4; ddy <= 4; ddy++)
    if (ddx * ddx + ddy * ddy <= 16)
      setpx(98 + ddx, 102 + ddy, GR, GG, GB, 200);

// Small secondary dot
for (let ddx = -2; ddx <= 2; ddx++)
  for (let ddy = -2; ddy <= 2; ddy++)
    if (ddx * ddx + ddy * ddy <= 4)
      setpx(88 + ddx, 110 + ddy, GR, GG, GB, 160);

// ── 7. Encode to PNG ──────────────────────────────────────────────────────────
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
