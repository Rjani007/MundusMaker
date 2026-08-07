// Renders the MundusMaker mark (two worlds joined by a route, on a dark disc)
// into public/icons/*.png and public/favicon.ico. Pure Node: RGBA buffers,
// hand-rolled PNG and ICO containers, zlib for compression — no dependencies.
// Deterministic: the same Node major produces byte-identical output, so the
// generated files are committed and this script only runs when the mark changes.
//
// Usage: node scripts/build-icons.js   (or: npm run icons)

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'public', 'icons');
const FAVICON = path.join(ROOT, 'public', 'favicon.ico');

// The mark, in the 32-unit space of the original inline SVG favicon.
const DISC = { x: 16, y: 16, r: 14, color: [0x2c, 0x24, 0x38, 255] };
const ORANGE = { x: 11, y: 13, r: 4, color: [0xe0, 0x72, 0x4a, 255] };
const GREEN = { x: 21, y: 19, r: 4, color: [0x4a, 0x9e, 0x6f, 255] };
const LINE = { x1: 13, y1: 16, x2: 19, y2: 17, w: 2, color: [0xcb, 0xbf, 0xe0, 255] };
const MASK_BG = [0x17, 0x14, 0x1f, 255]; // --bg; maskable icons must fill the square

const SS = 4; // supersample factor (box-downsampled for antialiasing)

// ---------- rasterizer ----------

function blendPixel(buf, i, color, cov) {
  const a = (color[3] / 255) * cov;
  if (a <= 0) return;
  const inv = 1 - a;
  const oldA = buf[i + 3] / 255;
  const outA = a + oldA * inv;
  if (outA <= 0) return;
  // src-over on straight-alpha storage
  buf[i] = Math.round((color[0] * a + buf[i] * oldA * inv) / outA);
  buf[i + 1] = Math.round((color[1] * a + buf[i + 1] * oldA * inv) / outA);
  buf[i + 2] = Math.round((color[2] * a + buf[i + 2] * oldA * inv) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

function drawCircle(buf, W, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(W - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, r - d + 0.5)); // half-pixel soft edge
      if (cov > 0) blendPixel(buf, (y * W + x) * 4, color, cov);
    }
  }
}

function drawSegment(buf, W, x1, y1, x2, y2, w, color) {
  const half = w / 2;
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1));
  const xe = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + half + 1));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1));
  const ye = Math.min(W - 1, Math.ceil(Math.max(y1, y2) + half + 1));
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = y0; y <= ye; y++) {
    for (let x = x0; x <= xe; x++) {
      const px = x + 0.5, py = y + 0.5;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
      const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      const cov = Math.max(0, Math.min(1, half - d + 0.5));
      if (cov > 0) blendPixel(buf, (y * W + x) * 4, color, cov);
    }
  }
}

function renderMark(size, { maskable = false } = {}) {
  const W = size * SS;
  const buf = new Uint8ClampedArray(W * W * 4);
  if (maskable) {
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = MASK_BG[0]; buf[i + 1] = MASK_BG[1]; buf[i + 2] = MASK_BG[2]; buf[i + 3] = 255;
    }
  }
  // maskable marks must sit inside the 80% safe zone of the full-bleed square
  const scale = (maskable ? 0.8 : 1) * (W / 32);
  const cx = W / 2, cy = W / 2;
  const tx = (v) => cx + (v - 16) * scale;
  const ty = (v) => cy + (v - 16) * scale;
  drawCircle(buf, W, tx(DISC.x), ty(DISC.y), DISC.r * scale, DISC.color);
  drawCircle(buf, W, tx(ORANGE.x), ty(ORANGE.y), ORANGE.r * scale, ORANGE.color);
  drawCircle(buf, W, tx(GREEN.x), ty(GREEN.y), GREEN.r * scale, GREEN.color);
  drawSegment(buf, W, tx(LINE.x1), ty(LINE.y1), tx(LINE.x2), ty(LINE.y2), LINE.w * scale, LINE.color);
  return downsample(buf, W, size);
}

function downsample(buf, W, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const pa = buf[i + 3] / 255;
          r += buf[i] * pa; g += buf[i + 1] * pa; b += buf[i + 2] * pa; a += pa;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { // average premultiplied, then unpremultiply
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(rgba, size) {
  const stride = size * 4 + 1; // one filter byte per scanline
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO (PNG-in-ICO, valid on Windows Vista+) ----------

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;     // width (0 means 256)
    dir[o + 1] = size >= 256 ? 0 : size; // height
    dir.writeUInt16LE(1, o + 4);         // color planes
    dir.writeUInt16LE(32, o + 6);        // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ---------- main ----------

const SIZES = [16, 32, 48, 180, 192, 256, 512];

fs.mkdirSync(ICON_DIR, { recursive: true });
const pngs = new Map();
for (const size of SIZES) {
  const png = encodePng(renderMark(size), size);
  pngs.set(size, png);
  const file = path.join(ICON_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} (${png.length} bytes)`);
}
const maskable = encodePng(renderMark(512, { maskable: true }), 512);
fs.writeFileSync(path.join(ICON_DIR, 'maskable-512.png'), maskable);
console.log(`wrote public/icons/maskable-512.png (${maskable.length} bytes)`);

const ico = buildIco([16, 32, 48, 256].map((size) => ({ size, png: pngs.get(size) })));
fs.writeFileSync(FAVICON, ico);
console.log(`wrote public/favicon.ico (${ico.length} bytes)`);
