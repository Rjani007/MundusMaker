// World map generator, two styles:
//   classic — the original fBm heightmap + biome raster (0.x maps); this code
//             path is FROZEN — existing maps must re-render byte-identical.
//   atlas   — 0.13's cartographic style: native-res terrain, latitude and
//             rain-shadow climate, coast ink, lakes, mountain glyphs, nations,
//             auto-named settlements. Opt-in via params.style; defaults() sets
//             it for NEW maps only, and the branch below reads map.params
//             directly so absent ALWAYS means classic.

import { makeFbm, makeRng, clamp } from '../util.js';
import { nameFor } from '../names.js';
import { siteKey, customKey } from './crossscale.js';
import { buildGeography, drainage, naturalTerritories } from './geography.js';
import { drawMapLabels } from './cartography.js';
import { renderGeographicMap } from './atlasart.js';

export const WORLD_W = 960;
export const WORLD_H = 600;
const GW = 480; // classic simulation grid (rendered at 2x)
const GH = 300;

export function defaultWorldParams() {
  // style/nations/settlements/labels only seed NEW maps — see the note above
  return { water: 0.5, scale: 3, island: true, rivers: 6, style: 'atlas', nations: 3, settlements: true, labels: true };
}

export const WORLD_STYLES = { classic: 'Classic (painted relief)', atlas: 'Atlas (inked chart)' };

const worldStyle = (map) => map.params?.style || 'classic';

/** Build the height/moisture grids from seed + params + stored brush strokes. */
export function buildWorldModel(map) {
  if (worldStyle(map) === 'atlas') return buildAtlasModel(map);
  const p = { ...defaultWorldParams(), ...(map.params || {}) };
  const hf = makeFbm(map.seed, 5);
  const mf = makeFbm(map.seed + ':moisture', 4);
  const height = new Float32Array(GW * GH);
  const moisture = new Float32Array(GW * GH);
  const aspect = GW / GH;

  for (let y = 0; y < GH; y++) {
    const v = y / GH;
    for (let x = 0; x < GW; x++) {
      const u = x / GW;
      let h = hf(u * p.scale * aspect, v * p.scale);
      if (p.island) {
        const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
        const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
        h -= d * d * 0.55;
      }
      height[y * GW + x] = h;
      moisture[y * GW + x] = mf(u * 3 * aspect + 40, v * 3 + 40);
    }
  }
  for (const s of map.strokes || []) applyStrokeToGrid(height, s);
  return { height, moisture, water: p.water, params: p, gw: GW, gh: GH };
}

/** Apply one brush stroke (normalized coords) to a height grid. */
export function applyStrokeToGrid(height, s) {
  applyStrokeDims(height, s, GW, GH);
}

function applyStrokeDims(height, s, gw, gh) {
  const cx = s.x * gw, cy = s.y * gh, r = s.r * gw;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(gw - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(gh - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const t = 1 - Math.sqrt(dx * dx + dy * dy) / r;
      if (t > 0) height[y * gw + x] += s.d * t * t;
    }
  }
}

/** Editor brush entry point — works for both styles (the model knows its own grid). */
export function applyWorldStroke(model, stroke) {
  applyStrokeDims(model.height, stroke, model.gw, model.gh);
}

const C = {
  deep: [24, 46, 82], sea: [38, 78, 122], shore: [64, 116, 152],
  beach: [206, 190, 138], grass: [110, 156, 82], dry: [165, 160, 94],
  forest: [62, 106, 60], hills: [138, 133, 96], highhills: [106, 122, 79],
  rock: [141, 133, 121], snow: [232, 232, 236],
};

function biome(h, m, wl) {
  if (h < wl - 0.13) return C.deep;
  if (h < wl - 0.04) return C.sea;
  if (h < wl) return C.shore;
  if (h < wl + 0.018) return C.beach;
  if (h > wl + 0.46) return C.snow;
  if (h > wl + 0.36) return C.rock;
  if (h > wl + 0.24) return m > 0.5 ? C.highhills : C.hills;
  if (m > 0.62) return C.forest;
  if (m > 0.32) return C.grass;
  return C.dry;
}

/** Trace rivers: descend from random highlands to the sea. Deterministic from
 *  seed — exported so town drills can read river adjacency on classic worlds
 *  (the render calls the same function; nothing is stored on the model). */
export function traceClassicRivers(model, seed, count) {
  const { height, water, gw, gh } = model;
  const rng = makeRng(seed + ':rivers');
  const rivers = [];
  let attempts = 0;
  while (rivers.length < count && attempts++ < count * 30) {
    let x = rng.int(4, gw - 5), y = rng.int(4, gh - 5);
    if (height[y * gw + x] < water + 0.16) continue;
    const path = [[x, y]];
    for (let step = 0; step < 600; step++) {
      let bx = x, by = y, bh = height[y * gw + x];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 1 || ny < 1 || nx >= gw - 1 || ny >= gh - 1) continue;
          const nh = height[ny * gw + nx];
          if (nh < bh) { bh = nh; bx = nx; by = ny; }
        }
      }
      if (bx === x && by === y) break; // local minimum (lake) — stop
      x = bx; y = by;
      path.push([x, y]);
      if (height[y * gw + x] < water) break;
    }
    if (path.length > 18 && height[path[path.length - 1][1] * gw + path[path.length - 1][0]] < water) {
      rivers.push(path);
    }
  }
  return rivers;
}

/** Render terrain (no markers/labels) into an offscreen canvas. `scale` > 1
 *  renders at higher resolution for printing — the simulation grid stays the
 *  same, but rivers, vignette and the terrain upsampling come out crisp. */
export function renderWorldBase(map, model, scale = 1) {
  if (worldStyle(map) === 'atlas') return renderAtlasBase(map, model, scale);
  model = model || buildWorldModel(map);
  const { height, moisture, water, gw, gh } = model;
  const off = document.createElement('canvas');
  off.width = gw; off.height = gh;
  const octx = off.getContext('2d');
  const img = octx.createImageData(gw, gh);
  const d = img.data;

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const h = height[i];
      const col = biome(h, moisture[i], water);
      let shade = 1;
      if (h >= water && x > 0 && y > 0 && x < gw - 1 && y < gh - 1) {
        const grad = (height[(y - 1) * gw + (x - 1)] - height[(y + 1) * gw + (x + 1)]);
        shade = clamp(1 + grad * 5, 0.72, 1.22);
      } else if (h < water) {
        shade = clamp(1 + (h - water) * 0.8, 0.82, 1); // subtle depth falloff
      }
      const o = i * 4;
      d[o] = clamp(col[0] * shade, 0, 255);
      d[o + 1] = clamp(col[1] * shade, 0, 255);
      d[o + 2] = clamp(col[2] * shade, 0, 255);
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const base = document.createElement('canvas');
  base.width = WORLD_W * scale; base.height = WORLD_H * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale); // everything below draws in native coordinates
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, WORLD_W, WORLD_H);

  // rivers
  const p = { ...defaultWorldParams(), ...(map.params || {}) };
  const sx = WORLD_W / gw, sy = WORLD_H / gh;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of traceClassicRivers(model, map.seed, p.rivers)) {
    for (let seg = 1; seg < path.length; seg++) {
      ctx.strokeStyle = 'rgba(56, 108, 150, 0.9)';
      ctx.lineWidth = 1 + (seg / path.length) * 2.6;
      ctx.beginPath();
      ctx.moveTo(path[seg - 1][0] * sx, path[seg - 1][1] * sy);
      ctx.lineTo(path[seg][0] * sx, path[seg][1] * sy);
      ctx.stroke();
    }
  }

  // vignette border for a "charted map" feel
  const grad = ctx.createRadialGradient(WORLD_W / 2, WORLD_H / 2, WORLD_H * 0.55, WORLD_W / 2, WORLD_H / 2, WORLD_W * 0.72);
  grad.addColorStop(0, 'rgba(20,16,10,0)');
  grad.addColorStop(1, 'rgba(20,16,10,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  drawClassicSites(ctx, map);
  return base;
}

// =========================================================================
// Atlas style (0.13) — everything below is atlas-only; the classic path
// above never calls into it. Streams: seed (height), ':warp', ':moisture',
// ':rivers', ':nations', ':settlements', ':names'.
// =========================================================================

const AGW = 480, AGH = 300; // atlas sim grid (same density; rendered crisp, not blurred)

function buildAtlasModel(map) {
  if (map.params?.generation === '1.8') return buildGeographicAtlas(map);
  const p = { ...defaultWorldParams(), ...(map.params || {}) };
  const hf = makeFbm(map.seed, 5);
  const wf = makeFbm(map.seed + ':warp', 3);
  const mf = makeFbm(map.seed + ':moisture', 4);
  const height = new Float32Array(AGW * AGH);
  const moisture = new Float32Array(AGW * AGH);
  const aspect = AGW / AGH;

  for (let y = 0; y < AGH; y++) {
    const v = y / AGH;
    for (let x = 0; x < AGW; x++) {
      const u = x / AGW;
      // domain warp bends the fbm so continents get fjords and peninsulas
      const wx = wf(u * 2.1 * aspect, v * 2.1) - 0.5;
      const wy = wf(u * 2.1 * aspect + 17, v * 2.1 + 17) - 0.5;
      let h = hf((u + wx * 0.22) * p.scale * aspect, (v + wy * 0.22) * p.scale);
      if (p.island) {
        const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
        const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
        h -= d * d * 0.55;
      }
      height[y * AGW + x] = h;
      moisture[y * AGW + x] = mf(u * 3 * aspect + 40, v * 3 + 40);
    }
  }
  for (const s of map.strokes || []) applyStrokeDims(height, s, AGW, AGH);

  // rain shadow: prevailing westerlies dry out land east of high ridges
  const wl = p.water;
  for (let y = 0; y < AGH; y++) {
    let shadow = 0;
    for (let x = 0; x < AGW; x++) {
      const i = y * AGW + x;
      const h = height[i];
      if (h > wl + 0.26) shadow = Math.min(1, shadow + (h - wl - 0.26) * 2.2);
      else shadow = Math.max(0, shadow - 0.012);
      if (h < wl) shadow = Math.max(0, shadow - 0.05); // sea recharges the air
      moisture[i] = clamp(moisture[i] - shadow * 0.34, 0, 1);
    }
  }

  const model = { atlas: true, height, moisture, water: wl, params: p, gw: AGW, gh: AGH };
  model.rivers = traceAtlasRivers(model, map.seed, p.rivers ?? 6);
  if ((p.nations ?? 0) > 0) buildNations(model, map.seed, p.nations);
  if (p.settlements ?? true) placeSettlements(model, map.seed);
  // user edits are applied strictly AFTER every stream above has been consumed,
  // so an edited map still generates the same base world as its seed always did
  attachAtlasKeys(model);
  applyAtlasEdits(model, map);
  return model;
}

function buildGeographicAtlas(map) {
  const p = { ...defaultWorldParams(), ...(map.params || {}) };
  const model = { ...buildGeography(map.seed, p), atlas:true, params:p };
  for (const s of map.strokes || []) applyStrokeDims(model.height, s, model.gw, model.gh);
  Object.assign(model, drainage(model, (p.rivers ?? 6) * 2));
  const seed = map.seed + ':v18';
  if ((p.nations ?? 0) > 0) buildNations(model, seed, p.nations);
  if (p.settlements ?? true) placeSettlements(model, seed);
  for (const town of model.towns || []) if (town.nationIndex != null) model.nations[town.nationIndex].capital = [town.x,town.y];
  if (model.nations?.length) growNationTerritories(model);
  // Existing names, site keys, link provenance and edit behavior stay shared.
  attachAtlasKeys(model); applyAtlasEdits(model, map);
  return model;
}

/** Stable identity for links/edits: keys embed the GENERATED name, so they
 *  survive renames and never depend on what the user later calls a site. */
function attachAtlasKeys(model) {
  (model.towns || []).forEach((t, i) => { t.key = siteKey('world', i, t.name); });
  (model.nations || []).forEach((nat, i) => { nat.key = siteKey('nation', i, nat.name); });
}

/** Replay map.siteEdits and map.sites onto the finished model. Moving or
 *  hiding a capital (or adding a region) regrows territories from the same
 *  preserved jitter, so frontiers keep their wander without new stream use. */
function applyAtlasEdits(model, map) {
  const edits = map.siteEdits || {};
  const custom = map.sites || [];
  if (!Object.keys(edits).length && !custom.length) return;
  const { gw, gh } = model;
  let regrow = false;

  const nations = model.nations || (model.nations = []);
  for (const s of custom) {
    if (s.kind !== 'region') continue;
    nations.push({
      capital: [s.x * gw, s.y * gh],
      cx: s.x * gw, cy: s.y * gh, cells: 0,
      name: String(s.name || 'New region'),
      custom: true, key: customKey(s),
    });
    regrow = true;
  }
  for (const nat of nations) {
    const e = edits[nat.key];
    if (!e) continue;
    if (e.name) nat.name = String(e.name);
    if (e.hidden) { nat.hidden = true; regrow = true; }
  }

  const towns = model.towns || (model.towns = []);
  for (const s of custom) {
    if (s.kind === 'region') continue;
    towns.push({
      x: s.x * gw, y: s.y * gh,
      size: Math.max(1, Math.min(3, Number(s.size) || 1)),
      townSize: Number(s.townSize) || null,
      name: String(s.name || 'New town'),
      custom: true, key: customKey(s),
    });
  }
  for (const t of towns) {
    const e = edits[t.key];
    if (!e) continue;
    if (e.name) t.name = String(e.name);
    if (e.x != null && e.y != null) {
      t.x = e.x * gw;
      t.y = e.y * gh;
      if (t.nationIndex != null && nations[t.nationIndex]) {
        // the capital city is its nation's drag handle — the seat follows it
        nations[t.nationIndex].capital = [t.x, t.y];
        regrow = true;
      }
    }
  }
  model.towns = towns.filter((t) => !edits[t.key]?.hidden);

  if (regrow) {
    if (!model.natJitter) {
      // regions added to a map generated with nations off: frontier jitter
      // comes from its own stream, consumed only when such edits exist
      const rng = makeRng(map.seed + ':natedit');
      const j = new Float32Array(gw * gh);
      for (let i = 0; i < j.length; i++) j[i] = rng.range(0, 1.4);
      model.natJitter = j;
    }
    growNationTerritories(model);
  }
}

/** Rivers that pool into lakes instead of vanishing at a local minimum. */
function traceAtlasRivers(model, seed, count) {
  const { height, water, gw, gh } = model;
  const rng = makeRng(seed + ':rivers');
  const rivers = [], lakes = [];
  let attempts = 0;
  while (rivers.length < count && attempts++ < count * 30) {
    let x = rng.int(4, gw - 5), y = rng.int(4, gh - 5);
    if (height[y * gw + x] < water + 0.16) continue;
    const path = [[x, y]];
    let ended = null; // 'sea' | 'lake'
    for (let step = 0; step < 700; step++) {
      let bx = x, by = y, bh = height[y * gw + x];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 1 || ny < 1 || nx >= gw - 1 || ny >= gh - 1) continue;
          const nh = height[ny * gw + nx];
          if (nh < bh) { bh = nh; bx = nx; by = ny; }
        }
      }
      if (bx === x && by === y) { ended = 'lake'; break; }
      x = bx; y = by;
      path.push([x, y]);
      if (height[y * gw + x] < water) { ended = 'sea'; break; }
    }
    if (path.length < 14) continue;
    if (ended === 'lake') {
      // flood the basin just above the minimum — a mountain tarn or inland sea
      const minH = height[y * gw + x];
      const cells = [y * gw + x];
      const seen = new Set(cells);
      for (let k = 0; k < cells.length && cells.length < 420; k++) {
        const c = cells[k], cx2 = c % gw, cy2 = (c / gw) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx2 + dx, ny = cy2 + dy;
          if (nx < 1 || ny < 1 || nx >= gw - 1 || ny >= gh - 1) continue;
          const ni = ny * gw + nx;
          if (!seen.has(ni) && height[ni] < minH + 0.012) { seen.add(ni); cells.push(ni); }
        }
      }
      if (cells.length > 5) lakes.push(cells);
    }
    if (ended) rivers.push(path);
  }
  model.lakes = lakes;
  return rivers;
}

/** Grow N nations from capital sites across the land, with jittered frontiers. */
function buildNations(model, seed, n) {
  const { height, water, gw, gh } = model;
  const rng = makeRng(seed + ':nations');
  const land = [];
  for (let i = 0; i < height.length; i++) if (height[i] >= water && !model.lakeMask?.[i]) land.push(i);
  if (land.length < n * 50) return;
  const capitals = [];
  let guard = 0;
  while (capitals.length < n && guard++ < 400) {
    const c = land[rng.int(0, land.length - 1)];
    const cx = c % gw, cy = (c / gw) | 0;
    if (capitals.some(([x, y]) => Math.hypot(x - cx, y - cy) < gw / (n + 1.5))) continue;
    capitals.push([cx, cy]);
  }
  // Jitter draws stay exactly where they were in the stream; the array remains
  // on the model so seat edits can regrow the SAME frontiers later
  const jitter = new Float32Array(gw * gh);
  for (let i = 0; i < jitter.length; i++) jitter[i] = rng.range(0, 1.4);
  model.natJitter = jitter;
  const nameRng = makeRng(seed + ':names');
  model.nations = capitals.map(([x, y]) => ({ capital: [x, y], name: nameFor(nameRng, 'nation') }));
  growNationTerritories(model);
}

/** Multi-source BFS from each visible nation's capital over the preserved
 *  jitter — pure computation, no RNG. Recomputes owner, centroids and cells;
 *  called once during generation and again after seat edits. */
function growNationTerritories(model) {
  if (model.generation === '1.8') return naturalTerritories(model);
  const { height, water, gw, gh } = model;
  const owner = new Int8Array(gw * gh).fill(-1);
  const jitter = model.natJitter;
  const queue = [];
  model.nations.forEach((nat, ci) => {
    if (nat.hidden) return;
    const x = clamp(Math.round(nat.capital[0]), 0, gw - 1);
    const y = clamp(Math.round(nat.capital[1]), 0, gh - 1);
    owner[y * gw + x] = ci;
    queue.push([x, y, ci]);
  });
  let head = 0;
  while (head < queue.length) {
    const [x, y, ci] = queue[head++];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const ni = ny * gw + nx;
      if (owner[ni] >= 0 || height[ni] < water || model.lakeMask?.[ni]) continue;
      // mountains slow a nation's spread — ranges become natural borders
      if (height[ni] > water + 0.34 && jitter[ni] > 0.5) continue;
      owner[ni] = ci;
      queue.push([nx, ny, ci]);
    }
  }
  model.owner = owner;
  model.nations.forEach((nat, ci) => {
    // centroid of the owned cells, for the big faint name
    let sx = 0, sy = 0, count = 0;
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== ci) continue;
      sx += i % gw; sy += (i / gw) | 0; count++;
    }
    nat.cx = count ? sx / count : nat.capital[0];
    nat.cy = count ? sy / count : nat.capital[1];
    nat.cells = count;
  });
}

/** Score-and-place towns: coasts and rivers attract, spacing keeps them apart. */
function placeSettlements(model, seed) {
  const { height, water, gw, gh } = model;
  const rng = makeRng(seed + ':settlements');
  const nameRng = makeRng(seed + ':names:towns');
  const riverCells = new Set();
  for (const path of model.rivers || []) for (const [x, y] of path) riverCells.add(y * gw + x);
  const nearSea = (x, y) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && height[ny * gw + nx] < water) return true;
    }
    return false;
  };
  const nearRiver = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (riverCells.has((y + dy) * gw + (x + dx))) return true;
    }
    return false;
  };
  const candidates = [];
  for (let t = 0; t < 900; t++) {
    const x = rng.int(8, gw - 9), y = rng.int(8, gh - 9);
    const h = height[y * gw + x];
    if (h < water || h > water + 0.3 || model.lakeMask?.[y * gw + x]) continue;
    let score = rng.range(0, 0.4);
    if (nearSea(x, y)) score += 1.1;
    if (nearRiver(x, y)) score += 0.8;
    candidates.push({ x, y, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const towns = [];
  const want = 8;
  for (const c of candidates) {
    if (towns.length >= want) break;
    if (towns.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 52)) continue;
    towns.push({ x: c.x, y: c.y, size: towns.length < 3 ? 2 : 1, name: nameFor(nameRng, 'settlement') });
  }
  // nation capitals become cities (the glyph and label upgrade); nationIndex
  // marks the capital as its nation's drag handle for the site-edit layer
  (model.nations || []).forEach((nat, ni) => {
    const [x, y] = nat.capital;
    const existing = towns.find((t) => Math.hypot(t.x - x, t.y - y) < 30);
    if (existing) { existing.size = 3; existing.capital = true; existing.nationIndex = ni; }
    else {
      const t = { x, y, size: 3, capital: true, nationIndex: ni, name: nameFor(nameRng, 'settlement') };
      towns.push(t);
    }
  });
  model.towns = towns;
}

// atlas palette: parchment-tinged inks, warmer than the classic raster
const AC = {
  deep: [42, 66, 96], sea: [66, 100, 130], shore: [96, 132, 152],
  beach: [214, 198, 152], marsh: [116, 142, 104],
  tundra: [196, 196, 182], taiga: [96, 122, 92], snow: [238, 238, 240],
  forest: [84, 118, 72], jungle: [58, 104, 58], grass: [138, 162, 96],
  savanna: [178, 168, 100], desert: [206, 184, 132],
  hills: [152, 144, 106], rock: [148, 140, 128],
};

function atlasBiome(h, m, temp, wl) {
  if (h < wl - 0.13) return AC.deep;
  if (h < wl - 0.035) return AC.sea;
  if (h < wl) return AC.shore;
  if (h < wl + 0.014) return AC.beach;
  if (h > wl + 0.44) return AC.snow;
  if (h > wl + 0.34) return AC.rock;
  if (h > wl + 0.24) return AC.hills;
  if (temp < 0.24) return m > 0.45 ? AC.taiga : AC.tundra;
  if (temp > 0.75) {
    if (m > 0.6) return AC.jungle;
    if (m > 0.34) return AC.savanna;
    return AC.desert;
  }
  if (m > 0.66) return h < wl + 0.05 ? AC.marsh : AC.forest;
  if (m > 0.3) return AC.grass;
  return AC.savanna;
}

const NATION_TINTS = [[224, 114, 74], [74, 134, 224], [155, 89, 208], [212, 167, 44], [90, 158, 111], [201, 93, 143], [94, 178, 178]];

// glyph + label for one settlement, shared by the atlas draw loop and the
// classic style's custom-site pass — the exact op sequence the atlas loop
// always used, so extraction changes no pixels
function drawTownGlyph(ctx, t, px, py) {
  ctx.fillStyle = '#2e2318';
  ctx.strokeStyle = '#f0e8d0';
  ctx.lineWidth = 1.2;
  if (t.size >= 3) {
    ctx.fillRect(px - 5, py - 5, 10, 10);
    ctx.strokeRect(px - 5, py - 5, 10, 10);
    ctx.beginPath(); // capital star
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#f0e8d0';
    ctx.fill();
  } else if (t.size === 2) {
    ctx.fillRect(px - 3.5, py - 3.5, 7, 7);
    ctx.strokeRect(px - 3.5, py - 3.5, 7, 7);
  } else {
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawTownLabel(ctx, t, px, py) {
  ctx.font = `${t.size >= 3 ? 'bold 13px' : t.size === 2 ? 'bold 11px' : '10px'} Georgia, serif`;
  ctx.strokeStyle = 'rgba(240, 232, 208, 0.85)';
  ctx.lineWidth = 3;
  ctx.strokeText(t.name, px, py - 8);
  ctx.fillStyle = '#241a10';
  ctx.fillText(t.name, px, py - 8);
}

/** A block flying a pennant — the seat of a user-planted region. */
function drawRegionSeat(ctx, x, y) {
  ctx.fillStyle = '#2e2318';
  ctx.strokeStyle = '#f0e8d0';
  ctx.lineWidth = 1.2;
  ctx.fillRect(x - 4, y - 4, 8, 8);
  ctx.strokeRect(x - 4, y - 4, 8, 8);
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y - 16);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 16);
  ctx.lineTo(x + 9, y - 12.5);
  ctx.lineTo(x, y - 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** Classic worlds generate no sites of their own; anything the user planted
 *  still draws (and drills down) — gated on data presence so the frozen
 *  classic path stays byte-identical for every map without sites. */
function drawClassicSites(ctx, map) {
  const sites = map.sites || [];
  if (!sites.length) return;
  ctx.save();
  ctx.textAlign = 'center';
  for (const s of sites) {
    const px = s.x * WORLD_W, py = s.y * WORLD_H;
    if (s.kind === 'region') {
      drawRegionSeat(ctx, px, py);
      ctx.font = 'bold 15px Georgia, serif';
      ctx.strokeStyle = 'rgba(240, 232, 208, 0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(String(s.name || 'Region'), px, py - 20);
      ctx.fillStyle = '#241a10';
      ctx.fillText(String(s.name || 'Region'), px, py - 20);
    } else {
      const t = { size: Math.max(1, Math.min(3, Number(s.size) || 1)), name: String(s.name || 'Settlement') };
      drawTownGlyph(ctx, t, px, py);
      drawTownLabel(ctx, t, px, py);
    }
  }
  ctx.restore();
}

function renderAtlasBase(map, model, scale = 1) {
  const m = model && model.atlas ? model : buildAtlasModel(map);
  if (m.generation === '1.8') return renderGeographicMap(map, m, scale);
  const { height, moisture, water: wl, gw, gh } = m;
  const p = m.params;

  const off = document.createElement('canvas');
  off.width = gw; off.height = gh;
  const octx = off.getContext('2d');
  const img = octx.createImageData(gw, gh);
  const d = img.data;

  const lakeSet = new Set();
  for (const cells of m.lakes || []) for (const c of cells) lakeSet.add(c);

  for (let y = 0; y < gh; y++) {
    const lat = 1 - Math.abs(y / gh - 0.5) * 2; // 1 at the equator line
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const h = height[i];
      const temp = clamp(lat * 1.12 - Math.max(0, h - wl) * 1.15, 0, 1);
      let col = lakeSet.has(i) ? AC.sea : atlasBiome(h, moisture[i], temp, wl);
      let shade = 1;
      if (h >= wl && !lakeSet.has(i) && x > 0 && y > 0 && x < gw - 1 && y < gh - 1) {
        const grad = height[(y - 1) * gw + (x - 1)] - height[(y + 1) * gw + (x + 1)];
        shade = clamp(1 + grad * 4.2, 0.76, 1.2);
      } else if (h < wl) {
        shade = clamp(1 + (h - wl) * 0.8, 0.84, 1);
      }
      // nation tint over land
      let tint = null;
      if (m.owner && h >= wl && !lakeSet.has(i) && m.owner[i] >= 0) tint = NATION_TINTS[m.owner[i] % NATION_TINTS.length];
      const o = i * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = col[ch] * shade;
        if (tint) v = v * 0.9 + tint[ch] * 0.1;
        d[o + ch] = clamp(v, 0, 255);
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const base = document.createElement('canvas');
  base.width = WORLD_W * scale; base.height = WORLD_H * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale);
  // crisp 2× draw — the classic style's soft bilinear blur is exactly what atlas avoids
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, WORLD_W, WORLD_H);
  ctx.imageSmoothingEnabled = true;

  const sx = WORLD_W / gw, sy = WORLD_H / gh;
  const at = (x, y) => height[clamp(y, 0, gh - 1) * gw + clamp(x, 0, gw - 1)];

  // coast ink: a firm line where land meets sea, plus one offshore contour
  ctx.strokeStyle = 'rgba(40, 30, 18, 0.55)';
  ctx.fillStyle = 'rgba(40, 30, 18, 0.5)';
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const h = at(x, y);
      if (h < wl) continue;
      if (at(x + 1, y) < wl || at(x - 1, y) < wl || at(x, y + 1) < wl || at(x, y - 1) < wl) {
        ctx.fillRect(x * sx, y * sy, sx, sy);
      }
    }
  }
  ctx.fillStyle = 'rgba(70, 96, 120, 0.4)';
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const h = at(x, y);
      if (h >= wl - 0.045 || h < wl - 0.055) continue;
      ctx.fillRect(x * sx, y * sy, sx, sy / 2);
    }
  }

  // nation borders: dark stitching where ownership changes on land
  if (m.owner) {
    ctx.fillStyle = 'rgba(52, 32, 40, 0.6)';
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const i = y * gw + x;
        const a = m.owner[i], b = m.owner[i + 1], c = y < gh - 1 ? m.owner[i + gw] : a;
        if (a >= 0 && ((b >= 0 && b !== a) || (c >= 0 && c !== a))) {
          if ((x + y) % 3 !== 0) ctx.fillRect(x * sx, y * sy, sx * 0.9, sy * 0.9);
        }
      }
    }
  }

  // rivers, tapered, with their lakes already colored in the raster
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of m.rivers || []) {
    for (let seg = 1; seg < path.length; seg++) {
      ctx.strokeStyle = 'rgba(58, 96, 128, 0.9)';
      ctx.lineWidth = 0.8 + (seg / path.length) * 2.4;
      ctx.beginPath();
      ctx.moveTo(path[seg - 1][0] * sx, path[seg - 1][1] * sy);
      ctx.lineTo(path[seg][0] * sx, path[seg][1] * sy);
      ctx.stroke();
    }
  }

  // mountain ridge glyphs + forest stipple, on sparse deterministic lattices
  ctx.strokeStyle = 'rgba(60, 44, 28, 0.75)';
  ctx.lineWidth = 1.2;
  for (let y = 2; y < gh - 2; y += 4) {
    for (let x = 2; x < gw - 2; x += 4) {
      const h = at(x, y);
      if (h < wl + 0.3) continue;
      const px = x * sx + ((x * 7 + y * 13) % 5) - 2, py = y * sy;
      const s = 3.2 + Math.min(3.4, (h - wl - 0.3) * 26);
      ctx.beginPath();
      ctx.moveTo(px - s, py + s * 0.7);
      ctx.lineTo(px, py - s * 0.8);
      ctx.lineTo(px + s, py + s * 0.7);
      ctx.stroke();
      if (h > wl + 0.42) { // snowcap tick
        ctx.beginPath();
        ctx.moveTo(px - s * 0.3, py - s * 0.28);
        ctx.lineTo(px, py - s * 0.8);
        ctx.lineTo(px + s * 0.3, py - s * 0.28);
        ctx.stroke();
      }
    }
  }
  ctx.fillStyle = 'rgba(38, 66, 34, 0.55)';
  for (let y = 2; y < gh - 2; y += 3) {
    for (let x = 2; x < gw - 2; x += 3) {
      const i = y * gw + x;
      const h = height[i];
      if (h < wl + 0.014 || h > wl + 0.24 || lakeSet.has(i)) continue;
      const lat = 1 - Math.abs(y / gh - 0.5) * 2;
      const temp = clamp(lat * 1.12 - Math.max(0, h - wl) * 1.15, 0, 1);
      const col = atlasBiome(h, moisture[i], temp, wl);
      if (col !== AC.forest && col !== AC.jungle && col !== AC.taiga) continue;
      if ((x * 31 + y * 17) % 7 > 2) continue;
      const px = x * sx + ((x * 5 + y * 3) % 4), py = y * sy + ((x * 3 + y * 5) % 4);
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // settlements + names
  if (m.towns && (p.labels ?? true)) ctx.textAlign = 'center';
  for (const t of m.towns || []) {
    const px = t.x * sx, py = t.y * sy;
    drawTownGlyph(ctx, t, px, py);
    if ((p.labels ?? true) && m.generation!=='1.8') drawTownLabel(ctx, t, px, py);
  }

  // user-planted region seats fly a banner so there is something to grab
  for (const nat of m.nations || []) {
    if (!nat.custom || nat.hidden) continue;
    drawRegionSeat(ctx, nat.capital[0] * sx, nat.capital[1] * sy);
  }

  // nation names, big and faint across their heartlands (user-added ones
  // always print — the owner planted them on purpose, however small)
  if ((p.labels ?? true) && m.generation!=='1.8') {
    for (const nat of m.nations || []) {
      if (nat.hidden) continue;
      if (nat.cells < 600 && !nat.custom) continue;
      ctx.font = 'bold 26px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(46, 30, 20, 0.32)';
      ctx.fillText(nat.name.toUpperCase(), nat.cx * sx, nat.cy * sy);
    }
  }

  if ((p.labels??true) && m.generation==='1.8') drawMapLabels(ctx,[
    ...(m.towns||[]).map(t=>({text:t.name,x:t.x*sx,y:t.y*sy,size:t.capital?15:12,bold:true,priority:t.capital?10:8})),
    ...(m.nations||[]).filter(n=>!n.hidden&&(n.cells>600||n.custom)).map(n=>({text:n.name.toUpperCase(),x:n.cx*sx,y:n.cy*sy,size:24,bold:true,center:true,priority:3})),
  ],WORLD_W,WORLD_H);

  // vignette, same charted-map feel as classic
  const grad2 = ctx.createRadialGradient(WORLD_W / 2, WORLD_H / 2, WORLD_H * 0.55, WORLD_W / 2, WORLD_H / 2, WORLD_W * 0.72);
  grad2.addColorStop(0, 'rgba(20,16,10,0)');
  grad2.addColorStop(1, 'rgba(20,16,10,0.35)');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  return base;
}
