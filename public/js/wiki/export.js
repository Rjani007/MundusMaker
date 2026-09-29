// Player wiki export (browser half). The projection decides what may appear,
// site.js writes the pages; this file produces the images the projection asked
// for and zips everything. Images are re-encoded through a canvas, which drops
// file metadata, and named by a hash of their bytes, so no uploaded file name,
// entity id or world id reaches the ZIP.

import { state } from '../state.js';
import { projectPlayerWorld } from '../projection.js';
import { buildWikiSite } from './site.js';
import { renderMap } from '../maps/mapcore.js';
import { SHEET_SYSTEMS } from '../sheets/sheetcore.js';
import { completeSkills } from '../sheets/cocskills.js';
import { prepareHandouts, drawHandoutPage, zipFilesCompressed } from '../handouts/output.js';
import { slugify } from '../util.js';

const MAX_IMAGE = 1600;
const HANDOUT_DPI = 110;
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));
const abort = (signal) => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const canvasBytes = (canvas, type, quality) => new Promise((resolve, reject) =>
  canvas.toBlob(async (blob) => {
    if (!blob) { reject(new Error('The browser could not encode an image. Try again with fewer maps.')); return; }
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, type, quality));

function hasTransparency(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/** A world asset, re-encoded: PNG when it has transparency, JPEG otherwise. */
async function loadAsset(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) return null;
    const bitmap = await createImageBitmap(blob);
    const ratio = Math.min(1, MAX_IMAGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const png = blob.type !== 'image/jpeg' && hasTransparency(ctx, canvas.width, canvas.height);
    const bytes = await canvasBytes(canvas, png ? 'image/png' : 'image/jpeg', 0.86);
    return [{ bytes, ext: png ? 'png' : 'jpg', width: canvas.width, height: canvas.height }];
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null; // a missing or unreadable image is left out, never fatal
  }
}

/** One character sheet as text lines, through the system's own printer. */
function sheetLinesWith(cocCatalog) {
  return (block, name) => {
    const sys = SHEET_SYSTEMS[block.system];
    if (!sys?.writePdf) return [];
    const data = block.system === 'coc7' && cocCatalog
      ? { ...(block.data || {}), skills: completeSkills(block.data || {}, cocCatalog.skills) }
      : block.data;
    const lines = [];
    const w = {
      line: (text, o = {}) => lines.push({ text: String(text ?? ''), bold: !!o.bold }),
      para: (text) => lines.push({ text: String(text ?? ''), bold: false }),
    };
    try { sys.writePdf(w, data, name); } catch (err) { console.error('sheet text failed', err); return []; }
    return lines;
  };
}

/**
 * Build the player wiki ZIP from the active world.
 * options: { typeKeys, include: { maps, timeline, relations }, roomNumbers }
 */
export async function buildPlayerWiki({ typeKeys, include = {}, roomNumbers = false, onProgress = () => {}, signal } = {}) {
  // Freeze the world first: edits made while the export runs must not mix
  // two versions of an entry into one site.
  const world = structuredClone(state.world);
  const worldId = state.worldId;
  const entities = [...state.entities.values()].map((e) => structuredClone(e));
  const byId = new Map(entities.map((e) => [e.id, e]));
  const usesCoc = entities.some((e) => (e.blocks || []).some((b) => b.kind === 'sheet' && b.system === 'coc7'));
  const cocCatalog = usesCoc ? await SHEET_SYSTEMS.coc7.loadData().catch(() => null) : null;

  const proj = projectPlayerWorld({ world, worldId, entities, typeKeys, include, sheetLines: sheetLinesWith(cocCatalog) });

  const images = new Map();
  const imageFiles = new Map(); // zip path -> bytes (identical images share one file)
  const needs = [...proj.needs];
  let done = 0;
  for (const [key, spec] of needs) {
    abort(signal);
    let produced = null;
    if (spec.kind === 'asset') {
      produced = await loadAsset(spec.url, signal);
    } else if (spec.kind === 'map') {
      const entity = byId.get(spec.ref);
      try {
        const canvas = document.createElement('canvas');
        renderMap(canvas, entity.map, { gm: false, numbered: spec.numbered, level: spec.level, roomNumbers, hiddenLinkIds: spec.hiddenLinkIds });
        produced = [{ bytes: await canvasBytes(canvas, 'image/png'), ext: 'png', width: canvas.width, height: canvas.height }];
        canvas.width = canvas.height = 1;
      } catch (err) { console.error('wiki map render failed', err); }
    } else if (spec.kind === 'handout') {
      try {
        const prepared = await prepareHandouts([byId.get(spec.ref)], { worldId, gm: false, entities: byId }, { signal });
        produced = [];
        for (const page of prepared.pages) {
          if (page.gm) continue; // never, for a player projection; checked anyway
          const canvas = drawHandoutPage(page, prepared.images, HANDOUT_DPI / 72);
          produced.push({ bytes: await canvasBytes(canvas, 'image/png'), ext: 'png', width: canvas.width, height: canvas.height });
          canvas.width = canvas.height = 1;
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.error('wiki handout render failed', err);
      }
    }
    if (produced?.length) {
      const list = [];
      for (const img of produced) {
        const file = `images/${(await sha256Hex(img.bytes)).slice(0, 24)}.${img.ext}`;
        imageFiles.set(file, img.bytes);
        list.push({ file, width: img.width, height: img.height });
      }
      images.set(key, list);
    }
    onProgress(++done / Math.max(1, needs.length));
    await breathe();
  }

  const [css, js] = await Promise.all(['/wiki/wiki.css', '/wiki/wiki.js'].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('The wiki template files are missing. Extract the complete MundusMaker archive.');
    return response.text();
  }));
  const pages = buildWikiSite(proj, { images, exportedAt: new Date() });
  const root = `${slugify(world.name || 'world')}-player-wiki/`;
  const encoder = new TextEncoder();
  const files = [
    ...pages.map((f) => [root + f.name, encoder.encode(f.text)]),
    [root + 'assets/wiki.css', encoder.encode(css)],
    [root + 'assets/wiki.js', encoder.encode(js)],
    ...[...imageFiles].map(([name, bytes]) => [root + name, bytes]),
  ];
  return {
    blob: await zipFilesCompressed(files),
    name: `${slugify(world.name || 'world')}-player-wiki.zip`,
    stats: { entries: proj.order.length, images: imageFiles.size },
  };
}
