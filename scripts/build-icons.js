// Renders the MundusMaker mark (a compass rose over a small world, on the
// app's dark disc) everywhere it appears: public/icons/*.png and
// public/favicon.ico (also the Windows tray, the installer's shortcuts, the
// Mac .icns that scripts/package.js builds and the Linux menu entry), the
// inline SVG favicon in public/index.html, the website's site/icon.svg and the
// Android launcher's vector drawables. Pure Node: RGBA buffers, hand-rolled
// PNG and ICO containers, zlib for compression — no dependencies.
// Deterministic: the same Node major produces byte-identical output, so the
// generated files are committed and this script only runs when the mark
// changes. tests/icons.test.js checks the vector copies against MARK.
//
// Usage: node scripts/build-icons.js   (or: npm run icons)

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'public', 'icons');
const FAVICON = path.join(ROOT, 'public', 'favicon.ico');
const INDEX = path.join(ROOT, 'public', 'index.html');
const SITE_ICON = path.join(ROOT, 'site', 'icon.svg');
const ANDROID_DRAWABLES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res', 'drawable');

// The mark, in a 64-unit square, drawn in order: circles, closed outlines of
// quadratic curves (a start point, then [cx, cy, x, y] for each curve) and
// polygons.
const MARK = [
  { kind: 'circle', x: 32, y: 32, r: 30, fill: '#2c2438', disc: true },
  { kind: 'circle', x: 32, y: 32, r: 18, fill: '#3d6b8f', sea: true },
  { kind: 'outline', start: [19, 27], curves: [[25, 18, 33, 23], [38, 27, 33, 32], [27, 36, 22, 33], [18, 31, 19, 27]], fill: '#5db87e' },
  { kind: 'outline', start: [35, 40], curves: [[40, 36, 44, 40], [46, 44, 41, 46], [36, 47, 35, 40]], fill: '#5db87e' },
  { kind: 'polygon', points: [[32, 5], [34.6, 29.4], [59, 32], [34.6, 34.6], [32, 59], [29.4, 34.6], [5, 32], [29.4, 29.4]], fill: '#cbbfe0', rose: true },
  { kind: 'polygon', points: [[32, 5], [34.6, 29.4], [29.4, 29.4]], fill: '#e0724a' },
  { kind: 'circle', x: 32, y: 32, r: 2.4, fill: '#2c2438', hub: true },
];
const MASK_BG = [0x17, 0x14, 0x1f, 255]; // --bg; maskable icons must fill the square

const SS = 4; // supersample factor (box-downsampled for antialiasing)
const toRgba = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];

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

/** A filled polygon with drawCircle's half-pixel soft edge (even-odd inside test). */
function drawPolygon(buf, W, pts, color) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - 1)), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs) + 1));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 1)), y1 = Math.min(W - 1, Math.ceil(Math.max(...ys) + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = false;
      let d = Infinity;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[j], [bx, by] = pts[i];
        if ((by > py) !== (ay > py) && px < ((ax - bx) * (py - by)) / (ay - by) + bx) inside = !inside;
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
      }
      const cov = inside ? Math.min(1, 0.5 + d) : Math.max(0, 0.5 - d);
      if (cov > 0) blendPixel(buf, (y * W + x) * 4, color, cov);
    }
  }
}

/** An outline of quadratic curves as a polygon, fine enough for a 512 px icon. */
function flatten(shape, steps = 24) {
  const pts = [shape.start];
  let [x0, y0] = shape.start;
  for (const [cx, cy, x, y] of shape.curves) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y]);
    }
    x0 = x; y0 = y;
  }
  return pts;
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
  const scale = (maskable ? 0.8 : 1) * (W / 64);
  const t = (v) => W / 2 + (v - 32) * scale;
  const at = (p) => [t(p[0]), t(p[1])];
  for (const shape of MARK) {
    const color = toRgba(shape.fill);
    if (shape.kind === 'circle') drawCircle(buf, W, t(shape.x), t(shape.y), shape.r * scale, color);
    else drawPolygon(buf, W, (shape.kind === 'outline' ? flatten(shape) : shape.points).map(at), color);
  }
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

// ---------- the vector copies ----------

const num = (v) => String(Math.round(v * 1000) / 1000);
const outlineD = (s, f) => `M${f(s.start[0])} ${f(s.start[1])}${s.curves.map(([cx, cy, x, y]) => `Q${f(cx)} ${f(cy)} ${f(x)} ${f(y)}`).join('')}Z`;
const polygonD = (pts, f) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
const circleD = (x, y, r) => `M${num(x - r)},${num(y)} a${num(r)},${num(r)} 0 1,0 ${num(2 * r)},0 a${num(r)},${num(r)} 0 1,0 ${num(-2 * r)},0 Z`;

/** The mark as SVG: site/icon.svg, and the inline favicon in public/index.html. */
function markSvg() {
  const parts = MARK.map((s) => {
    if (s.kind === 'circle') return `<circle cx="${num(s.x)}" cy="${num(s.y)}" r="${num(s.r)}" fill="${s.fill}"/>`;
    if (s.kind === 'outline') return `<path d="${outlineD(s, num)}" fill="${s.fill}"/>`;
    return `<polygon points="${s.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ')}" fill="${s.fill}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${parts.join('')}</svg>`;
}

/** An SVG as a data: URL for a <link rel="icon">. */
const svgDataUrl = (svg) => `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/[<>#%]/g, (c) => encodeURIComponent(c))}`;

/**
 * Android's adaptive icon: the launcher paints the disc colour itself
 * (@color/icon_background) and masks it to its own shape, so the foreground
 * carries the rest, the 60-unit disc scaled to the 72 dp the launcher shows.
 * The launcher tints the monochrome copy, so its sea is a ring and the hub a
 * hole in the rose.
 */
function androidDrawables() {
  const k = 72 / 60;
  const dp = (v) => num(54 + (v - 32) * k);
  const scaled = (s) => (s.kind === 'circle' ? circleD(54 + (s.x - 32) * k, 54 + (s.y - 32) * k, s.r * k)
    : s.kind === 'outline' ? outlineD(s, dp) : polygonD(s.points, dp));
  const head = (what) => '<?xml version="1.0" encoding="utf-8"?>\n'
    + `<!-- ${what} (scripts/build-icons.js writes it from MARK: npm run icons). -->\n`
    + '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
    + '    android:width="108dp"\n    android:height="108dp"\n    android:viewportWidth="108"\n    android:viewportHeight="108">\n';
  const path = (attrs) => `    <path ${attrs} />\n`;
  const sea = MARK.find((s) => s.sea), rose = MARK.find((s) => s.rose), hub = MARK.find((s) => s.hub);
  const foreground = MARK.filter((s) => !s.disc).map((s) => path(`android:fillColor="${s.fill.toUpperCase()}" android:pathData="${scaled(s)}"`)).join('');
  const monochrome = [
    path(`android:strokeColor="#FFFFFFFF" android:strokeWidth="${num(2.4 * k)}" android:pathData="${circleD(54, 54, (sea.r - 1.2) * k)}"`),
    ...MARK.filter((s) => s.kind === 'outline').map((s) => path(`android:fillColor="#FFFFFFFF" android:pathData="${scaled(s)}"`)),
    path(`android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="${scaled(rose)} ${scaled(hub)}"`),
  ].join('');
  return {
    'ic_launcher_foreground.xml': `${head('The MundusMaker mark for the adaptive launcher icon')}${foreground}</vector>\n`,
    'ic_launcher_monochrome.xml': `${head('Themed-icon version of ic_launcher_foreground: the launcher tints it')}${monochrome}</vector>\n`,
  };
}

/** public/index.html with its inline SVG favicon set to the mark. */
function withInlineFavicon(html) {
  const re = /<link rel="icon" href="data:image\/svg\+xml,[^"]*" type="image\/svg\+xml">/;
  if (!re.test(html)) throw new Error('public/index.html lost its inline SVG favicon link');
  return html.replace(re, () => `<link rel="icon" href="${svgDataUrl(markSvg())}" type="image/svg+xml">`);
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

function main() {
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

  fs.writeFileSync(SITE_ICON, `${markSvg()}\n`);
  console.log('wrote site/icon.svg');
  fs.writeFileSync(INDEX, withInlineFavicon(fs.readFileSync(INDEX, 'utf8')));
  console.log('updated the inline favicon in public/index.html');
  for (const [name, xml] of Object.entries(androidDrawables())) {
    fs.writeFileSync(path.join(ANDROID_DRAWABLES, name), xml);
    console.log(`wrote mobile/android/app/src/main/res/drawable/${name}`);
  }
}

if (require.main === module) main();

module.exports = { MARK, markSvg, svgDataUrl, androidDrawables, withInlineFavicon, renderMark, SIZES };
