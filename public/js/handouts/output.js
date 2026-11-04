import { projectHandout } from './handoutcore.js';
import { layoutHandout, cardSheets, pageImageNames } from './layout.js';
import { MAP_KINDS, renderMap, hiddenOverlayLinkIds } from '../maps/mapcore.js';
import { makeRng } from '../util.js';

const FONTS = { serif: ['DejaVuSerif', 'DejaVuSerif-Bold', 'DejaVuSerif-Italic'], sans: ['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSans-Oblique'] };
const STYLES = ['normal', 'bold', 'italic'];
let fontData;
const abort = signal => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
const breathe = () => new Promise(resolve => setTimeout(resolve, 0));
export async function loadHandoutFonts() {
  if (!fontData) fontData = Promise.all(Object.entries(FONTS).flatMap(([family, names]) => names.map(async (name, i) => {
    const response = await fetch(`vendor/fonts/${name}.ttf`); if (!response.ok) throw Error('The bundled handout fonts are missing. Extract the complete MundusMaker archive.');
    const bytes = await response.arrayBuffer(); let binary = '';
    const view = new Uint8Array(bytes); for (let j = 0; j < view.length; j += 8192) binary += String.fromCharCode(...view.subarray(j, j + 8192));
    const face = new FontFace(`Handout-${family}`, bytes, { weight: i === 1 ? '700' : '400', style: i === 2 ? 'italic' : 'normal' });
    document.fonts.add(await face.load());
    return { family, name, style: STYLES[i], base64: btoa(binary) };
  }))).catch(err => { fontData = null; throw err; });
  return fontData;
}
function makePdf(fonts, format = [595.28, 841.89]) {
  if (!window.jspdf?.jsPDF) throw Error('The local PDF library is unavailable.');
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format, orientation: format[0] > format[1] ? 'landscape' : 'portrait', compress: true, putOnlyUsedFonts: true });
  for (const f of fonts) { doc.addFileToVFS(f.name + '.ttf', f.base64); doc.addFont(f.name + '.ttf', f.family, f.style); }
  return doc;
}
async function loadImage(url, signal) {
  abort(signal);
  try {
    const response = await fetch(url, { signal }); if (!response.ok) return null;
    const blob = await response.blob();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) return null;
    const bitmap = await createImageBitmap(blob); abort(signal);
    const ratio = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    return { width: canvas.width, height: canvas.height, canvas, dataUrl: canvas.toDataURL('image/png') };
  } catch (err) { if (err.name === 'AbortError') throw err; return null; }
}

// A map fragment (1.9): the PLAYER render of a map, whatever the edition
// (secret overlays, links to hidden entries and generator guidance are left
// out), cropped, aged and torn along a jagged edge seeded by the URL. Only the
// map ID and crop are stored; the pixels are made here, at export time.
function mapFragment(url, context) {
  const [, id, cropText, levelText] = url.split(':');
  const entry = context.entities instanceof Map ? context.entities.get(id) : null;
  if (!entry?.map || !MAP_KINDS[entry.map.kind]) return null;
  const [cx, cy, cw, ch] = cropText.split(',').map(Number);
  const full = document.createElement('canvas');
  renderMap(full, entry.map, { gm: false, scale: 2, level: Number(levelText) || 0, hiddenLinkIds: hiddenOverlayLinkIds(entry.map, context.entities.values()) });
  const sx = Math.round(cx * full.width), sy = Math.round(cy * full.height);
  const sw = Math.max(40, Math.round(Math.min(1 - cx, cw) * full.width)), sh = Math.max(40, Math.round(Math.min(1 - cy, ch) * full.height));
  const canvas = document.createElement('canvas'); canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d'), rng = makeRng(url), edge = [];
  const jag = (a, b, n, fn) => { for (let i = 0; i <= n; i++) edge.push(fn(a + (b - a) * i / n, rng.range(0, 1))); };
  const d = Math.min(sw, sh) * .045;
  jag(0, sw, 18, (x, r) => [x, r * d]); jag(0, sh, 14, (y, r) => [sw - r * d, y]); jag(sw, 0, 18, (x, r) => [x, sh - r * d]); jag(sh, 0, 14, (y, r) => [r * d, y]);
  ctx.beginPath(); edge.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
  ctx.filter = 'sepia(.55) contrast(.92) brightness(1.02)';
  ctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(120, 86, 40, .10)'; ctx.fillRect(0, 0, sw, sh);
  ctx.strokeStyle = 'rgba(92, 64, 30, .55)'; ctx.lineWidth = 3; ctx.stroke();
  full.width = full.height = 1;
  return { width: sw, height: sh, canvas, dataUrl: canvas.toDataURL('image/png') };
}

const measureWith = doc => (text, font, style, size) => { doc.setFont(font, style); doc.setFontSize(size); return doc.getTextWidth(text); };
/** The text measure layout uses, for sizing a handout before it is saved. */
export async function handoutMeasure() { return measureWith(makePdf(await loadHandoutFonts())); }

export async function prepareHandouts(entities, context, { signal, onProgress = () => {}, sheets = false, sheetSize = 'a4', inkSaving = false } = {}) {
  const fonts = await loadHandoutFonts(); abort(signal);
  const doc = makePdf(fonts), images = new Map(), pages = [], warnings = new Set();
  let unsupported = false;
  const measure = measureWith(doc);
  function normalize(text, font) {
    doc.setFont(font, 'normal');
    const cmap = doc.getFont().metadata?.cmap?.unicode?.codeMap || {};
    return [...text].map(c => { if (c === '\n' || c === '\t' || cmap[c.codePointAt(0)]) return c; unsupported = true; return '□'; }).join('');
  }
  for (let i = 0; i < entities.length; i++) {
    abort(signal);
    const model = projectHandout(entities[i], context); if (!model) continue;
    if (inkSaving) { model.p.paper = 'white'; model.p.ink = '#222222'; }
    model.title = normalize(model.title, model.p.font);
    model.blocks.forEach(b => { if (b.text) b.text = normalize(b.text, model.p.font); });
    const urls = new Set([model.image, ...model.blocks.filter(b => b.kind === 'image').map(b => b.url)].filter(Boolean));
    for (const url of urls) { abort(signal); if (!images.has(url)) images.set(url, url.startsWith('mapfrag:') ? mapFragment(url, context) : await loadImage(url, signal)); }
    const layout = layoutHandout(model, measure, images); pages.push(...layout.pages); layout.warnings.forEach(w => warnings.add(w));
    onProgress((i + 1) / entities.length); await breathe();
  }
  if (unsupported) warnings.add('The bundled fonts cannot display some characters. They appear as □ in preview and export. Latin, Greek and Cyrillic text are supported; complex-script shaping is limited.');
  return { pages: sheets ? cardSheets(pages, sheetSize) : pages, images, fonts, warnings: [...warnings] };
}

export function drawHandoutPage(page, images, scale = 1) {
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(page.width * scale); canvas.height = Math.ceil(page.height * scale);
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  for (const op of page.ops) {
    if (op.kind === 'text') {
      ctx.font = `${op.style === 'italic' ? 'italic ' : ''}${op.style === 'bold' ? '700 ' : ''}${op.size}px Handout-${op.font}`; ctx.fillStyle = op.color; ctx.textAlign = op.align; ctx.textBaseline = 'alphabetic'; ctx.fillText(op.text, op.x, op.y);
    } else if (op.kind === 'rect') {
      if (op.fill) { ctx.fillStyle = op.fill; ctx.fillRect(op.x, op.y, op.w, op.h); }
      if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.line || .5; ctx.strokeRect(op.x, op.y, op.w, op.h); }
    } else if (op.kind === 'line') { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.line || .5; ctx.beginPath(); ctx.moveTo(op.x, op.y); ctx.lineTo(op.x2, op.y2); ctx.stroke(); }
    else if (op.kind === 'image' && images.get(op.url)) ctx.drawImage(images.get(op.url).canvas, op.x, op.y, op.w, op.h);
  }
  return canvas;
}

export async function handoutPdf(prepared, { signal, onProgress = () => {} } = {}) {
  if (!prepared.pages.length) throw Error('There are no visible handout pages to export.');
  const first = prepared.pages[0], doc = makePdf(prepared.fonts, [first.width, first.height]);
  doc.setProperties({ title: first.gm ? 'MundusMaker handouts — GM edition' : 'MundusMaker handouts — player edition', creator: 'MundusMaker' });
  for (const [i, page] of prepared.pages.entries()) {
    abort(signal); if (i) doc.addPage([page.width, page.height], page.width > page.height ? 'landscape' : 'portrait');
    for (const op of page.ops) {
      if (op.kind === 'text') { doc.setFont(op.font, op.style); doc.setFontSize(op.size); doc.setTextColor(op.color); doc.text(op.text, op.x, op.y, { align: op.align }); }
      else if (op.kind === 'rect') {
        if (op.fill) doc.setFillColor(op.fill); if (op.stroke) doc.setDrawColor(op.stroke); doc.setLineWidth(op.line || .5);
        doc.rect(op.x, op.y, op.w, op.h, op.fill && op.stroke ? 'FD' : op.fill ? 'F' : 'S');
      } else if (op.kind === 'line') { doc.setDrawColor(op.stroke); doc.setLineWidth(op.line || .5); doc.line(op.x, op.y, op.x2, op.y2); }
      else if (op.kind === 'image' && prepared.images.get(op.url)) doc.addImage(prepared.images.get(op.url).dataUrl, 'PNG', op.x, op.y, op.w, op.h, op.url);
    }
    onProgress((i + 1) / prepared.pages.length); await breathe();
  }
  abort(signal); return doc.output('arraybuffer');
}

// ZIP32, stored entries. PNGs are already compressed; no runtime zip dependency.
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
export function zipFiles(files) {
  const parts = [], central = []; let offset = 0;
  const record = size => { const bytes = new Uint8Array(size); return [bytes, new DataView(bytes.buffer)]; };
  for (const [name, bytes] of files) {
    const filename = new TextEncoder().encode(name); let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; crc = (crc ^ 0xffffffff) >>> 0;
    const [header, h] = record(30); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, filename.length, true);
    const [entry, c] = record(46); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
    parts.push(header, filename, bytes); central.push(entry, filename); offset += header.length + filename.length + bytes.length;
  }
  const centralSize = central.reduce((n, a) => n + a.length, 0), [end, e] = record(22); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// ZIP32 with deflate for text, through the browser's own CompressionStream
// (no dependency). Images stay stored; browsers without deflate-raw store all.
export async function zipFilesCompressed(files) {
  const canDeflate = typeof CompressionStream === 'function' && (() => { try { new CompressionStream('deflate-raw'); return true; } catch { return false; } })();
  const parts = [], central = []; let offset = 0;
  const record = size => { const bytes = new Uint8Array(size); return [bytes, new DataView(bytes.buffer)]; };
  const now = new Date(), dosTime = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1, dosDate = Math.max(0, now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
  for (const [name, bytes] of files) {
    const filename = new TextEncoder().encode(name); let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; crc = (crc ^ 0xffffffff) >>> 0;
    let data = bytes, method = 0;
    if (canDeflate && !/\.(png|jpe?g|webp|gif|zip)$/i.test(name) && bytes.length > 256) {
      const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      if (packed.length < bytes.length) { data = packed; method = 8; }
    }
    const [header, h] = record(30); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(8, method, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, filename.length, true);
    const [entry, c] = record(46); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, method, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
    parts.push(header, filename, data); central.push(entry, filename); offset += header.length + filename.length + data.length;
  }
  const centralSize = central.reduce((n, a) => n + a.length, 0), [end, e] = record(22); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// One PNG per page, each the size of its own page: prepare without card sheets
// and an item card comes out as just the card. The caller downloads the files
// one by one or bundles them with zipImages.
export async function handoutImages(prepared, { dpi = 150, signal, onProgress = () => {} } = {}) {
  const files = [], names = pageImageNames(prepared.pages);
  for (const [i, page] of prepared.pages.entries()) {
    abort(signal); const canvas = drawHandoutPage(page, prepared.images, Math.max(72, Math.min(300, dpi)) / 72);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw Error('The browser could not render this page. Try a lower resolution.');
    files.push({ name: names[i], blob }); canvas.width = canvas.height = 1;
    onProgress((i + 1) / prepared.pages.length); await breathe();
  }
  abort(signal); return files;
}

export async function zipImages(files) {
  return zipFiles(await Promise.all(files.map(async f => [f.name, new Uint8Array(await f.blob.arrayBuffer())])));
}
