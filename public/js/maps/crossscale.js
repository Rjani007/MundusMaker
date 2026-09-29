// Pure helpers for linking generated atlas/region sites across map scales.
// Generated models are ephemeral; the persisted bridges on the map are:
//   scaleLinks — site key → linked entity id (1.1)
//   siteEdits  — site key → { name?, x?, y?, hidden? } (1.3); x/y normalized
//                0..1. Applied by the generators AFTER every RNG stream has
//                been consumed, so editing a map never reshuffles what its
//                seed generates.
//   sites      — user-added sites [{ id, kind:'region'|'settlement', name,
//                x, y, size? }] (1.3), same normalized coordinates. 1.4 adds
//                optional { seat, inherited, origin, townSeed } for sites a
//                region map inherits from its parent world at drill time.
// Site keys embed the GENERATED name, never the display name, so links and
// edits survive renames; user-added sites key as `custom:<id>`.

import { clamp, makeRng } from '../util.js';

export function siteKey(kind, index, name) {
  return `${kind}:${index}:${encodeURIComponent(String(name || '').trim().toLowerCase())}`;
}

export const customKey = (site) => `custom:${site?.id}`;

/** Return generated + user-added settlements in native canvas coordinates. */
export function settlementSites(map, model, size) {
  const [width, height] = size;
  if (map?.kind === 'world' && model?.atlas && Array.isArray(model.towns)) {
    const sx = width / model.gw, sy = height / model.gh;
    return model.towns.map((town, index) => ({
      key: town.key || siteKey('world', index, town.name),
      name: String(town.name || `Settlement ${index + 1}`),
      x: town.x * sx,
      y: town.y * sy,
      gx: town.x,
      gy: town.y,
      size: Number(town.size) || 1,
      townSize: Number(town.townSize) || null,
      capital: !!town.capital,
      custom: !!town.custom,
      kind: 'settlement',
    }));
  }
  if (map?.kind === 'world' && model && !model.atlas) {
    // classic worlds generate no settlements; user-added ones still drill down
    return (map.sites || []).filter((s) => s.kind !== 'region').map((s) => ({
      key: customKey(s),
      name: String(s.name || 'Settlement'),
      x: s.x * width,
      y: s.y * height,
      gx: s.x * model.gw,
      gy: s.y * model.gh,
      size: Number(s.size) || 1,
      townSize: Number(s.townSize) || null,
      capital: false,
      custom: true,
      kind: 'settlement',
    }));
  }
  if (map?.kind === 'region' && Array.isArray(model?.settlements)) {
    return model.settlements.map((town, index) => ({
      key: town.key || siteKey('region', index, town.name),
      name: String(town.name || `Settlement ${index + 1}`),
      x: town.x,
      y: town.y,
      gx: town.x * (model.gw / width),
      gy: town.y * (model.gh / height),
      size: Number(town.size) || 1,
      townSize: Number(town.townSize) || null,
      capital: !!(town.seat || town.capital),
      custom: !!town.custom,
      inherited: !!town.inherited,
      origin: town.origin || null,
      townSeed: town.townSeed || null,
      townGeography: town.townGeography || null,
      kind: 'settlement',
    }));
  }
  return [];
}

/** Regions on a world map (atlas nations + user-added seats), canvas coords.
 *  `x/y` is the draggable seat; `labelX/labelY` is where the big name draws. */
export function regionSites(map, model, size) {
  const [width, height] = size;
  if (map?.kind !== 'world' || !model) return [];
  if (model.atlas) {
    const sx = width / model.gw, sy = height / model.gh;
    return (model.nations || []).map((nat, index) => (nat.hidden ? null : {
      key: nat.key || siteKey('nation', index, nat.name),
      name: String(nat.name || `Region ${index + 1}`),
      x: nat.capital[0] * sx,
      y: nat.capital[1] * sy,
      gx: nat.capital[0],
      gy: nat.capital[1],
      labelX: (nat.cx ?? nat.capital[0]) * sx,
      labelY: (nat.cy ?? nat.capital[1]) * sy,
      nationIndex: index,
      custom: !!nat.custom,
      cells: nat.cells || 0,
      kind: 'region',
    })).filter(Boolean);
  }
  return (map.sites || []).filter((s) => s.kind === 'region').map((s) => ({
    key: customKey(s),
    name: String(s.name || 'Region'),
    x: s.x * width,
    y: s.y * height,
    gx: s.x * model.gw,
    gy: s.y * model.gh,
    labelX: s.x * width,
    labelY: s.y * height,
    custom: true,
    cells: 0,
    kind: 'region',
  }));
}

export function settlementLinkId(map, site) {
  const id = map?.scaleLinks?.[site?.key];
  return typeof id === 'string' && id ? id : null;
}

function writeSiteName(map, key, newName) {
  if (key.startsWith('custom:')) {
    const s = (map.sites || []).find((o) => customKey(o) === key);
    if (s && s.name !== newName) { s.name = newName; return true; }
    return false;
  }
  if ((map.siteEdits?.[key]?.name || '') === newName) return false;
  (map.siteEdits ??= {})[key] = { ...(map.siteEdits?.[key] || {}), name: newName };
  return true;
}

/**
 * Write `newName` onto every map label that tracks `entityId`. Inherited sites
 * also carry their parent-map site key (`origin`), so the rename can reach the
 * world map they came from. Marker and stamp labels follow only while they
 * still match `oldName`; a label edited by the user stays unchanged. The
 * caller saves the returned entities.
 */
export function syncLinkedSiteNames(entities, entityId, newName, getEntity, oldName = null) {
  const touched = new Set();
  for (const src of entities) {
    const links = src.map?.scaleLinks;
    if (links) {
      for (const [key, id] of Object.entries(links)) {
        if (id !== entityId) continue;
        if (writeSiteName(src.map, key, newName)) touched.add(src);
        const site = key.startsWith('custom:')
          ? (src.map.sites || []).find((o) => customKey(o) === key) : null;
        if (site?.origin && src.map.parentId) {
          const parent = getEntity(src.map.parentId);
          if (parent?.map && writeSiteName(parent.map, site.origin, newName)) touched.add(parent);
        }
      }
    }
    if (oldName == null || !src.map) continue;
    for (const item of [...(src.map.markers || []), ...(src.map.stamps || [])]) {
      if (item.to === entityId
          && (item.label === oldName || String(item.label || '').trim() === String(oldName).trim())) {
        item.label = newName;
        touched.add(src);
      }
    }
  }
  return [...touched];
}

export function linkSettlement(map, site, entityId) {
  if (!map || !site?.key || !entityId) return;
  (map.scaleLinks ??= {})[site.key] = entityId;
}

/** Generated glyph sizes become useful town-map sizes; capitals get the full
 * metropolis treatment. This only runs when a town is first drilled. */
export function townSizeForSettlement(site) {
  if (site?.capital) return 5;
  const explicit = Math.round(Number(site?.townSize));
  if (explicit >= 1 && explicit <= 5) return explicit;
  const size = Math.max(1, Math.min(3, Math.round(Number(site?.size) || 1)));
  return [1, 2, 4][size - 1];
}

export function townSeedForSettlement(map, site) {
  // Inherited region sites carry the seed their world-map original would get,
  // so drilling world→town and world→region→town reaches the SAME town map.
  if (site?.townSeed) return String(site.townSeed);
  return `${String(map?.seed || 'map')}:town:${site?.key || 'settlement'}`;
}

/**
 * Starter params for a town map spawned from a settlement site — the town
 * equivalent of regionParamsForSite. Pure reads of the finished parent model:
 * a site on the parent's coast gets a coastal harbor, one on a river gets a
 * riverside layout, and the terrain theme follows the parent's climate instead
 * of an unrelated seed roll. Inland sites pick deterministically from the
 * inland archetypes so a landlocked capital can never roll a harbor.
 * `ctx.rivers` is the parent's traced river paths in grid coords;
 * `ctx.regionTerrain` is the resolved region palette key (region parents only).
 */
/**
 * The era of a town opened from this map (1.9): the map's own "Towns opened
 * here" choice when it has one, otherwise the world's default from the Maps
 * page. Historical when neither says modern.
 */
export function drilledTownEra(parentMap, world) {
  const own = parentMap?.params?.townEra;
  if (own === 'modern' || own === 'historical') return own;
  return world?.townEra === 'modern' ? 'modern' : 'historical';
}

export function townParamsForSettlement(map, model, site, ctx = {}) {
  const out = { size: townSizeForSettlement(site) };
  // A regional crop's broad palette is not the climate at each world town.
  // New inherited sites retain that drill-time geography until moved locally.
  const saved = site?.townGeography;
  if (saved && ['coastal','riverside','organic','crossroads','grid'].includes(saved.layout)
      && ['parchment','grassland','desert','snow','marsh'].includes(saved.terrain)) {
    out.layout = saved.layout; out.terrain = saved.terrain;
    if (saved.layout === 'coastal' && ['north','east','west'].includes(saved.seaSide)) out.seaSide = saved.seaSide;
    return out;
  }
  const { height, moisture, gw, gh } = model || {};
  if (!height || !gw || site?.gx == null || site?.gy == null) return out;
  const gx = clamp(Math.round(site.gx), 0, gw - 1);
  const gy = clamp(Math.round(site.gy), 0, gh - 1);
  const wl = model.water ?? 0.5;
  // "near the sea" must mean the same WORLD distance on both drill paths:
  // world parents use their own nearSea radius (3 world cells); a carved
  // region's cell density depends on its window, so scale 3 world cells into
  // region cells via the carve window; standalone regions keep nearWater's 6
  let seaR = 3;
  if (map?.kind !== 'world') {
    const win = map?.carve?.wx1 - map?.carve?.wx0;
    seaR = win > 0 ? clamp(Math.round(3 * gw / win), 3, 14) : 6;
  }
  let nearestSea = null;
  for (let dy = -seaR; dy <= seaR; dy++) {
    for (let dx = -seaR; dx <= seaR; dx++) {
      const nx = gx + dx, ny = gy + dy;
      const ni = ny * gw + nx;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || height[ni] >= wl
          || model.carveLakeCells?.has(ni)) continue;
      const d2 = dx * dx + dy * dy;
      if (!nearestSea || d2 < nearestSea.d2) nearestSea = { dx, dy, d2 };
    }
  }
  const sea = !!nearestSea;
  let riverRx = 2, riverRy = 2;
  if (map?.kind !== 'world') {
    const win = map?.carve?.wx1 - map?.carve?.wx0;
    const hin = map?.carve?.wy1 - map?.carve?.wy0;
    if (win > 0) riverRx = clamp(Math.round(2 * gw / win), 2, 12);
    if (hin > 0) riverRy = clamp(Math.round(2 * gh / hin), 2, 12);
  }
  const river = !sea && (ctx.rivers || []).some((path) =>
    path.some(([rx, ry]) => Math.abs(rx - gx) <= riverRx && Math.abs(ry - gy) <= riverRy));
  if (sea) {
    out.layout = 'coastal';
    // Coastal generation always puts the sea at the bottom. New drilled maps
    // opt into a post-generation orientation when the parent coast faces a
    // different way; south stays absent and therefore uses the frozen path.
    const { dx, dy } = nearestSea;
    const side = Math.abs(dx) > Math.abs(dy)
      ? (dx < 0 ? 'west' : 'east')
      : (dy < 0 ? 'north' : 'south');
    if (side !== 'south') out.seaSide = side;
  }
  else if (river) out.layout = 'riverside';
  else {
    // deterministic pick from the inland archetypes on the town's own
    // ':layout' suffix — same stream the map would have hashed for 'auto'
    const r = makeRng(`${townSeedForSettlement(map, site)}:layout`)();
    out.layout = r < 0.35 ? 'organic' : r < 0.62 ? 'crossroads' : 'grid';
  }
  const h = height[gy * gw + gx];
  const m = moisture ? moisture[gy * gw + gx] : 0.5;
  if (map?.kind === 'world' && model.atlas) {
    // mirror the atlas climate bands (see atlasBiome) into town theme names
    const lat = 1 - Math.abs(gy / gh - 0.5) * 2;
    const temp = clamp(lat * 1.12 - Math.max(0, h - wl) * 1.15, 0, 1);
    out.terrain = temp < 0.26 ? 'snow'
      : (temp > 0.72 && m < 0.42) ? 'desert'
      : (m > 0.66 && h < wl + 0.05) ? 'marsh'
      : m < 0.3 ? 'parchment' : 'grassland';
  } else if (map?.kind === 'world') {
    // classic worlds have no latitude in their biome() — mirror its bands
    out.terrain = h > wl + 0.46 ? 'snow' : m > 0.32 ? 'grassland' : 'parchment';
  } else if (ctx.regionTerrain) {
    out.terrain = { green: 'grassland', harsh: 'parchment', cold: 'snow', arid: 'desert' }[ctx.regionTerrain] || 'grassland';
    if (out.terrain === 'grassland' && m > 0.7 && h < wl + 0.04) out.terrain = 'marsh';
  }
  return out;
}

export function regionSeedForSite(map, site) {
  return `${String(map?.seed || 'map')}:region:${site?.key || 'site'}`;
}

// ---------- carving a region's terrain out of the world map ----------

const CARVE_W = 120, CARVE_H = 75; // quantized crop grid; region sim is 240×150
const REGION_ASPECT = 1.6;         // REGION_W / REGION_H

function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Clip one line segment to a rectangular carve window (Liang-Barsky). */
function clipSegment(a, b, x0, y0, x1, y1) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [
    [a[0] + dx * lo, a[1] + dy * lo],
    [a[0] + dx * hi, a[1] + dy * hi],
  ];
}

/** Store parent hydrology in carve-grid coordinates. The source model remains
 * untouched, and empty arrays distinguish new carves from old carve formats. */
function clipHydrology(model, hydrology, x0, y0, x1, y1, cw = CARVE_W, ch = CARVE_H) {
  const rivers = hydrology?.rivers ?? model.rivers ?? [];
  const lakes = hydrology?.lakes ?? model.lakes ?? [];
  const toCarve = ([x, y]) => [
    round2(((x - x0) / (x1 - x0)) * (cw - 1)),
    round2(((y - y0) / (y1 - y0)) * (ch - 1)),
  ];
  const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
  const clippedRivers = [];
  for (const path of rivers) {
    if (!Array.isArray(path) || path.length < 2) continue;
    let part = [];
    const flush = () => {
      if (part.length > 1) clippedRivers.push(part);
      part = [];
    };
    for (let i = 1; i < path.length; i++) {
      const seg = clipSegment(path[i - 1], path[i], x0, y0, x1, y1);
      if (!seg) { flush(); continue; }
      const a = toCarve(seg[0]), b = toCarve(seg[1]);
      if (!part.length) part.push(a);
      else if (!same(part[part.length - 1], a)) { flush(); part.push(a); }
      if (!same(part[part.length - 1], b)) part.push(b);
    }
    flush();
  }

  const clippedLakes = [];
  for (const lake of lakes) {
    if (!Array.isArray(lake)) continue;
    const cells = [];
    const seen = new Set();
    for (const cell of lake) {
      const wx = Array.isArray(cell) ? Number(cell[0]) : Number(cell) % model.gw;
      const wy = Array.isArray(cell) ? Number(cell[1]) : Math.floor(Number(cell) / model.gw);
      // Include cells whose footprint touches the crop, not just centres that
      // fall inside it, so a lake does not lose its rim at the carve boundary.
      if (!Number.isFinite(wx) || !Number.isFinite(wy)
        || wx < x0 - 0.5 || wx > x1 + 0.5 || wy < y0 - 0.5 || wy > y1 + 0.5) continue;
      const pt = toCarve([wx, wy]);
      const key = `${pt[0]},${pt[1]}`;
      if (!seen.has(key)) { seen.add(key); cells.push(pt); }
    }
    if (cells.length) clippedLakes.push(cells);
  }
  return { rivers: clippedRivers, lakes: clippedLakes };
}

/**
 * Snapshot the world terrain around a region site as a compact quantized crop
 * (`map.carve` on the new region map). A nation site crops its own territory's
 * bounding box; anything else takes a window around the seat. The snapshot is
 * frozen at creation on purpose: the region map stays self-contained and
 * renders identically everywhere with no cross-entity lookups.
 */
export function extractCarve(model, site, hydrology = {}) {
  if (!model?.height || !model.gw || !model.gh) return null;
  const { height, moisture, gw, gh } = model;
  let x0 = null, y0 = null, x1 = null, y1 = null;
  const ni = site?.nationIndex;
  if (model.owner && ni != null && !site?.custom) {
    let bx0 = gw, by0 = gh, bx1 = -1, by1 = -1;
    for (let i = 0; i < model.owner.length; i++) {
      if (model.owner[i] !== ni) continue;
      const x = i % gw, y = (i / gw) | 0;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    if (bx1 > bx0 + 4 && by1 > by0 + 4) {
      x0 = bx0 - 8; x1 = bx1 + 8; y0 = by0 - 8; y1 = by1 + 8;
    }
  }
  if (x0 == null) {
    // window around the seat — used by custom regions and classic worlds
    const hw = Math.max(24, Math.round(gw * 0.17));
    const hh = Math.max(15, Math.round(hw / REGION_ASPECT));
    const cx = Math.round(site?.gx ?? gw / 2), cy = Math.round(site?.gy ?? gh / 2);
    x0 = cx - hw; x1 = cx + hw; y0 = cy - hh; y1 = cy + hh;
  }
  // expand the short side to the region canvas aspect, then shift into bounds
  let w = x1 - x0, h = y1 - y0;
  if (w / h < REGION_ASPECT) {
    const grow = h * REGION_ASPECT - w;
    x0 -= grow / 2; x1 += grow / 2; w = x1 - x0;
  } else {
    const grow = w / REGION_ASPECT - h;
    y0 -= grow / 2; y1 += grow / 2; h = y1 - y0;
  }
  if (w > gw - 1) { x0 = 0; x1 = gw - 1; } else {
    if (x0 < 0) { x1 -= x0; x0 = 0; }
    if (x1 > gw - 1) { x0 -= x1 - (gw - 1); x1 = gw - 1; }
  }
  if (h > gh - 1) { y0 = 0; y1 = gh - 1; } else {
    if (y0 < 0) { y1 -= y0; y0 = 0; }
    if (y1 > gh - 1) { y0 -= y1 - (gh - 1); y1 = gh - 1; }
  }

  return snapshotCarve(model, x0, y0, x1, y1, hydrology, ni);
}

/** Re-snapshot a carve using its saved window. This is the explicit refresh
 * path; it deliberately does not recompute a nation's bounds. */
export function refreshCarve(model, previous, hydrology = {}) {
  if (!model?.height || !model.gw || !model.gh || previous?.wx0 == null) return null;
  let x0 = Number(previous.wx0), y0 = Number(previous.wy0);
  let x1 = Number(previous.wx1), y1 = Number(previous.wy1);
  if (![x0, y0, x1, y1].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0)) return null;
  x0 = clamp(x0, 0, model.gw - 1); x1 = clamp(x1, 0, model.gw - 1);
  y0 = clamp(y0, 0, model.gh - 1); y1 = clamp(y1, 0, model.gh - 1);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const ni = previous.territoryKey ? model.nations?.findIndex(n => n.key === previous.territoryKey && !n.hidden) : null;
  return snapshotCarve(model, x0, y0, x1, y1, hydrology, ni >= 0 ? ni : null);
}

function snapshotCarve(model, x0, y0, x1, y1, hydrology, ni = null) {
  const { height, moisture, gw, gh } = model;
  const detailed = model.generation === '1.8', cw = detailed ? 240 : CARVE_W, ch = detailed ? 150 : CARVE_H;
  const sample = (grid) => {
    const out = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      const fy = y0 + (y / (ch - 1)) * (y1 - y0);
      const gy0 = clamp(Math.floor(fy), 0, gh - 1), gy1 = clamp(gy0 + 1, 0, gh - 1);
      const ty = fy - gy0;
      for (let x = 0; x < cw; x++) {
        const fx = x0 + (x / (cw - 1)) * (x1 - x0);
        const gx0 = clamp(Math.floor(fx), 0, gw - 1), gx1 = clamp(gx0 + 1, 0, gw - 1);
        const tx = fx - gx0;
        const a = grid[gy0 * gw + gx0], b = grid[gy0 * gw + gx1];
        const c = grid[gy1 * gw + gx0], d = grid[gy1 * gw + gx1];
        const top = a + (b - a) * tx, bot = c + (d - c) * tx;
        out[y * cw + x] = top + (bot - top) * ty;
      }
    }
    return out;
  };

  const hs = sample(height);
  const ms = moisture ? sample(moisture) : new Float32Array(cw * ch).fill(0.5);
  let hmin = Infinity, hmax = -Infinity;
  for (const v of hs) {
    if (v < hmin) hmin = v;
    if (v > hmax) hmax = v;
  }
  if (!(hmax > hmin)) hmax = hmin + 1e-4;
  const hq = Uint8Array.from(hs, (v) => clamp(Math.round(((v - hmin) / (hmax - hmin)) * 255), 0, 255));
  const mq = Uint8Array.from(ms, (v) => clamp(Math.round(v * 255), 0, 255));
  const clipped = clipHydrology(model, hydrology, x0, y0, x1, y1, cw, ch);
  const extra = {};
  if (detailed) {
    const fine = new Uint8Array(hs.length * 2), view = new DataView(fine.buffer);
    hs.forEach((v,i) => view.setUint16(i*2, clamp(Math.round((v-hmin)/(hmax-hmin)*65535),0,65535),true));
    extra.snapshotVersion = 2; extra.h16b64 = b64FromBytes(fine);
    extra.landb64 = b64FromBytes(Uint8Array.from(hs,v=>v>=model.water?1:0));
    if (ni != null && model.nations?.[ni] && model.owner) {
      extra.territoryKey = model.nations[ni].key;
      const mask = new Uint8Array(cw*ch);
      for(let y=0;y<ch;y++)for(let x=0;x<cw;x++) {
        const wx=clamp(Math.round(x0+x/(cw-1)*(x1-x0)),0,gw-1),wy=clamp(Math.round(y0+y/(ch-1)*(y1-y0)),0,gh-1);
        mask[y*cw+x]=model.owner[wy*gw+wx]===ni?1:0;
      }
      extra.territoryb64=b64FromBytes(mask);
    }
  }
  return {
    ...extra, w: cw, h: ch,
    hmin: Math.round(hmin * 1e4) / 1e4,
    hmax: Math.round(hmax * 1e4) / 1e4,
    water: Math.round((model.water ?? 0.5) * 1e4) / 1e4,
    // the crop window in world-grid coords: what lets world positions map into
    // the region (inherited sites, future re-carve). Absent on pre-1.4 carves.
    wx0: Math.round(x0 * 100) / 100, wy0: Math.round(y0 * 100) / 100,
    wx1: Math.round(x1 * 100) / 100, wy1: Math.round(y1 * 100) / 100,
    hb64: b64FromBytes(hq),
    mb64: b64FromBytes(mq),
    rivers: clipped.rivers,
    lakes: clipped.lakes,
  };
}

/** World-grid coords → normalized 0..1 position inside the carve window, or
 *  null when the carve predates window tracking or the point falls outside. */
export function carveUv(carve, gx, gy) {
  if (!carve || carve.wx0 == null) return null;
  const w = carve.wx1 - carve.wx0, h = carve.wy1 - carve.wy0;
  if (!(w > 0) || !(h > 0)) return null;
  const u = (gx - carve.wx0) / w, v = (gy - carve.wy0) / h;
  if (u < 0.015 || u > 0.985 || v < 0.015 || v > 0.985) return null; // off the frame
  return { u, v };
}

/**
 * The world's own towns that fall inside a freshly carved region window, as
 * ready-to-persist map.sites entries for the new region map. This is what puts
 * the nation's actual capital (same name, same relative position) on its
 * region map instead of an unrelated generated seat. Pure reads — positions
 * come from the post-edit model, so display names and user moves carry over.
 */
export function inheritedRegionSites(map, model, site, carve) {
  if (!model || !carve) return [];
  const out = [];
  const push = (t, key) => {
    let uv = carveUv(carve, t.x, t.y);
    const seat = !!(t.capital && site?.nationIndex != null && t.nationIndex === site.nationIndex);
    if (!uv && seat) {
      // a window clamped at the world border can pinch the capital against
      // the frame — the seat must survive the drill, so pull it just inside
      const w = carve.wx1 - carve.wx0, h = carve.wy1 - carve.wy0;
      if (carve.wx0 != null && w > 0 && h > 0) {
        uv = { u: clamp((t.x - carve.wx0) / w, 0.02, 0.98), v: clamp((t.y - carve.wy0) / h, 0.02, 0.98) };
      }
    }
    if (!uv) return;
    const name = String(t.name || 'Settlement');
    const position = { x: Math.round(uv.u * 1e4) / 1e4, y: Math.round(uv.v * 1e4) / 1e4 };
    const geography = model.generation === '1.8' ? townParamsForSettlement(map, model,
      { ...t, key, gx:t.x, gy:t.y }, { rivers:model.rivers || [] }) : null;
    out.push({
      id: `inh-${key}`,
      kind: 'settlement',
      name,
      origName: name, // drill-time name; the collision filter keys on THIS, never the display name
      ...position,
      ...(geography ? { townGeography: { ...position, layout:geography.layout, terrain:geography.terrain, seaSide:geography.seaSide || 'south' } } : {}),
      size: Math.max(1, Math.min(3, Number(t.size) || 1)),
      townSize: Number(t.townSize) || undefined,
      seat,
      capital: !!t.capital, // a neighbour nation's capital keeps its rank without taking the seat
      inherited: true,
      origin: key, // the parent map's site key; provenance + link carry-over
      townSeed: `${String(map?.seed || 'map')}:town:${key}`,
    });
  };
  if (model.atlas) {
    for (const t of model.towns || []) push(t, t.key);
  } else {
    // classic worlds: only hand-planted settlements exist
    for (const s of map?.sites || []) {
      if (s.kind === 'region') continue;
      push({ x: s.x * model.gw, y: s.y * model.gh, name: s.name, size: s.size, townSize: s.townSize }, customKey(s));
    }
  }
  return out;
}

/** Starter params for a region map spawned from a world site: the parent's
 *  name as the title, a climate-matched palette, and a water level + count
 *  scaled from the world model. Pure reads — nothing here draws from an RNG. */
export function regionParamsForSite(model, site, carve) {
  const out = { title: String(site?.name || '').trim() };
  // matches the world sea-level slider's full range — a high-sea world must
  // not drill into a region whose water sits lower than the carve encodes
  if (carve) out.water = clamp(carve.water, 0.2, 0.64);
  const { height, moisture, gw, gh } = model || {};
  if (height && gw) {
    const wl = model.water ?? 0.5;
    const counts = { green: 0, harsh: 0, cold: 0, arid: 0 };
    const classify = (x, y) => {
      const h = height[y * gw + x];
      if (h < wl) return;
      const m = moisture ? moisture[y * gw + x] : 0.5;
      const lat = 1 - Math.abs(y / gh - 0.5) * 2;
      // These are the atlas climate bands expressed as region palettes.
      const temp = clamp(lat * 1.12 - Math.max(0, h - wl) * 1.15, 0, 1);
      const band = temp < 0.26 ? 'cold'
        : (temp > 0.72 && m < 0.42) ? 'arid'
          : m < 0.3 ? 'harsh' : 'green';
      counts[band]++;
    };
    if (carve?.wx0 != null) {
      // Use every parent cell covered by the crop. A capital on the edge of a
      // broad nation no longer decides the climate for the entire region.
      const x0 = clamp(Math.floor(carve.wx0), 0, gw - 1);
      const x1 = clamp(Math.ceil(carve.wx1), 0, gw - 1);
      const y0 = clamp(Math.floor(carve.wy0), 0, gh - 1);
      const y1 = clamp(Math.ceil(carve.wy1), 0, gh - 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) classify(x, y);
    } else {
      classify(
        clamp(Math.round(site?.gx ?? gw / 2), 0, gw - 1),
        clamp(Math.round(site?.gy ?? gh / 2), 0, gh - 1),
      );
    }
    out.terrain = Object.entries(counts).reduce(
      (best, entry) => (entry[1] > best[1] ? entry : best), ['green', -1],
    )[0];
  }
  if (site?.cells) out.settlements = clamp(2 + Math.round(site.cells / 900), 2, 8);
  return out;
}
