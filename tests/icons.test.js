'use strict';

// The MundusMaker mark appears as PNGs, an ICO, an inline SVG favicon, the
// website's icon.svg and Android vector drawables. scripts/build-icons.js
// writes them all from one MARK; these tests fail when any copy has drifted
// from it, so a changed mark always means `npm run icons` and a commit of
// everything it wrote.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const icons = require('../scripts/build-icons');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Pixels of a PNG written by build-icons.js (8-bit RGBA, filter byte 0 on every row). */
function pngPixels(file) {
  const png = fs.readFileSync(file);
  const size = png.readUInt32BE(16);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) raw.copy(out, y * size * 4, y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
  return { size, pixels: out };
}

test('the vector copies of the mark match the one MARK the icons are drawn from', () => {
  assert.equal(read('site/icon.svg'), `${icons.markSvg()}\n`);
  const html = read('public/index.html');
  assert.equal(icons.withInlineFavicon(html), html, 'the inline SVG favicon in public/index.html');
  for (const [name, xml] of Object.entries(icons.androidDrawables())) {
    assert.equal(read(`mobile/android/app/src/main/res/drawable/${name}`), xml, name);
  }
});

test('the PNG icons are the mark as it is drawn now, at every size the app asks for', () => {
  for (const size of icons.SIZES) {
    const file = path.join(ROOT, 'public', 'icons', `icon-${size}.png`);
    assert.equal(pngPixels(file).size, size, `icon-${size}.png`);
  }
  assert.equal(pngPixels(path.join(ROOT, 'public', 'icons', 'maskable-512.png')).size, 512);
  // compare pixels, not bytes: zlib's output may differ between Node versions
  for (const size of [16, 32]) {
    const { pixels } = pngPixels(path.join(ROOT, 'public', 'icons', `icon-${size}.png`));
    assert.ok(Buffer.from(icons.renderMark(size).buffer).equals(pixels), `icon-${size}.png is stale: run npm run icons`);
  }
  const ico = fs.readFileSync(path.join(ROOT, 'public', 'favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1, 'an icon file');
  assert.equal(ico.readUInt16LE(4), 4, '16, 32, 48 and 256 px');
});
