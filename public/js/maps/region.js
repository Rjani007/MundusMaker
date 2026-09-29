// Region map generator: the travel-scale layer between world and town.
// Seeded fBm heightfield + moisture, settlements sited near water, roads over a
// nearest-neighbour spanning tree, named landmarks — names come from names.js
// on a dedicated stream. Terrain is a render-level palette pick only (like town
// themes): switching it recolors the province without moving anything.
// Hand edits arrive as brush strokes and are replayed here, world.js-style.

import { makeFbm, makeRng, clamp } from '../util.js';
import { nameFor } from '../names.js';
import { siteKey, customKey } from './crossscale.js';
import { buildGeography, drainage, terrainRoads } from './geography.js';
import { drawMapLabels } from './cartography.js';
import { renderGeographicMap } from './atlasart.js';

export const REGION_W = 960, REGION_H = 600;
const GW = 240; // simulation grid (rendered at 4x)
const GH = 150;
const SX = REGION_W / GW, SY = REGION_H / GH;
const TAU = Math.PI * 2;

export const REGION_TERRAINS = ['auto', 'green', 'harsh', 'cold', 'arid'];

export function defaultRegionParams() {
  return { relief: 0.5, water: 0.35, settlements: 4, roads: true, landmarks: 3, hexes: false, terrain: 'auto', labels: true };
}

/** Build heights, moisture and every named site from seed + params + strokes. */
export function buildRegionModel(map) {
  const p = { ...defaultRegionParams(), ...(map.params || {}) };
  const relief = clamp(p.relief ?? 0.5, 0, 1);
  const wl = clamp(p.water ?? 0.35, 0.05, 0.8);
  const height = new Float32Array(GW * GH);
  const moisture = new Float32Array(GW * GH);
  const aspect = GW / GH;
  const freq = 2.2 + relief * 2.2;
  const carved = decodeCarve(map.carve);
  const inheritedHydrology = decodeCarveHydrology(map.carve);
  const detailedCarve = carved && map.params?.generation === '1.8' && map.carve?.snapshotVersion === 2;

  if (carved) {
    // world-linked regions: the world-crop snapshot is the base relief and the
    // fbm only adds local detail, so coastlines still read as the parent map's.
    // Relief turns into detail amplitude here — the crop owns the big shapes.
    const hf = makeFbm(map.seed, 5);
    const amp = 0.05 + relief * 0.15;
    for (let y = 0; y < GH; y++) {
      const v = y / (detailedCarve ? GH - 1 : GH);
      for (let x = 0; x < GW; x++) {
        const u = x / (detailedCarve ? GW - 1 : GW);
        const i = y * GW + x;
        const parentHeight = sampleCarve(carved.hgrid, carved.w, carved.h, u, v);
        const detail = map.params?.generation === '1.8' ? Math.min(amp, Math.abs(parentHeight-wl) * .8) : amp;
        height[i] = parentHeight + (hf(u * freq * aspect, v * freq) - 0.5) * detail;
        if (detailedCarve && carved.land && Math.abs(wl-map.carve.water)<.0002) {
          const land = carved.land[Math.round(v*(carved.h-1))*carved.w+Math.round(u*(carved.w-1))];
          height[i] = land ? Math.max(wl+.00001,height[i]) : Math.min(wl-.00001,height[i]);
        }
        moisture[i] = sampleCarve(carved.mgrid, carved.w, carved.h, u, v);
      }
    }
  } else {
    const hf = makeFbm(map.seed, 5);
    const mf = makeFbm(map.seed + ':moisture', 4);
    for (let y = 0; y < GH; y++) {
      const v = y / GH;
      for (let x = 0; x < GW; x++) {
        const u = x / GW;
        let h = hf(u * freq * aspect, v * freq);
        h = 0.5 + (h - 0.5) * (0.75 + relief * 0.85); // relief stretches the contrast
        height[y * GW + x] = h;
        moisture[y * GW + x] = mf(u * 3 * aspect + 40, v * 3 + 40);
      }
    }
  }
  if (!carved && map.params?.generation === '1.8') {
    const geo = buildGeography(map.seed, { ...p, regional:true, landform:p.landform || 'highlands' }, GW, GH);
    height.set(geo.height); moisture.set(geo.moisture);
  }
  // World lakes are independent of the heightfield on atlas maps. Stamp their
  // clipped cells into the region terrain before local brushwork, so the lake
  // is water for rendering, settlement placement and roads. A later region
  // brush stroke can still reshape it.
  for (const i of inheritedHydrology.lakeCells) height[i] = Math.min(height[i], wl - 0.025);
  for (const s of map.strokes || []) applyStroke(height, s);

  const model = {
    height, moisture, water: wl, params: p, gw: GW, gh: GH,
    carveRivers: inheritedHydrology.rivers,
    carveLakeCells: inheritedHydrology.lakeCells,
    hasCarveHydrology: inheritedHydrology.present,
  };
  if (map.params?.generation === '1.8') {
    model.generation = '1.8';
    if (detailedCarve && carved.territory) {
      model.territory = new Uint8Array(GW*GH);
      for(let y=0;y<GH;y++)for(let x=0;x<GW;x++) model.territory[y*GW+x] = carved.territory[Math.round(y/(GH-1)*(carved.h-1))*carved.w+Math.round(x/(GW-1)*(carved.w-1))];
    }
    if (!inheritedHydrology.present) Object.assign(model, drainage(model, 10));
    else {
      model.rivers = inheritedHydrology.rivers;
      model.riverCells = new Set(model.rivers.flatMap(line=>line.map(([x,y])=>Math.round(y)*GW+Math.round(x))));
    }
  }
  const sites = makeRng(map.seed + ':sites');
  const names = makeRng(map.seed + ':names');
  model.title = nameFor(names, 'region');
  model.settlements = placeSettlements(model, sites, clamp(Math.round(p.settlements ?? 4), 0, 9));
  for (const s of model.settlements) s.name = nameFor(names, 'settlement');
  // roads are always planned (render skips them when p.roads is off) so that
  // toggling the param can never shift the landmark draws that follow
  model.roads = model.settlements.length > 1 ? planRoads(model, sites) : [];
  model.landmarks = placeLandmarks(model, sites, clamp(Math.round(p.landmarks ?? 3), 0, 8));
  for (const l of model.landmarks) l.name = nameFor(names, 'landmark');
  // user edits apply strictly AFTER every stream above has been consumed
  attachRegionKeys(model);
  applyRegionEdits(model, map);
  if (model.generation === '1.8') Object.assign(model, terrainRoads(model, model.settlements));
  return model;
}

/** Decode the quantized world-crop snapshot (see crossscale extractCarve). */
function decodeCarve(cv) {
  if (!cv || !cv.hb64 || !cv.mb64 || !(cv.w > 1) || !(cv.h > 1)) return null;
  try {
    const bytes = (b64) => {
      const s = atob(b64);
      const a = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    };
    const hq = bytes(cv.hb64), mq = bytes(cv.mb64);
    if (hq.length < cv.w * cv.h || mq.length < cv.w * cv.h) return null;
    const hmin = Number(cv.hmin) || 0;
    const span = (Number(cv.hmax) - hmin) || 1;
    const fine = cv.snapshotVersion === 2 && cv.h16b64 ? bytes(cv.h16b64) : null;
    const view = fine?.length === cv.w*cv.h*2 ? new DataView(fine.buffer) : null;
    const mask = name => { const b=cv[name]?bytes(cv[name]):null; return b?.length===cv.w*cv.h?b:null; };
    return {
      w: cv.w, h: cv.h,
      hgrid: Float32Array.from(hq, (v,i) => hmin + (view ? view.getUint16(i*2,true)/65535 : v/255) * span),
      mgrid: Float32Array.from(mq, (v) => v / 255),
      land: mask('landb64'), territory: mask('territoryb64'),
    };
  } catch {
    return null; // a mangled carve degrades to a plain generated region
  }
}

/** Convert optional parent hydrology from carve-grid coordinates to the
 * region simulation grid. Old carves have neither field and return empties. */
function decodeCarveHydrology(cv) {
  const out = {
    rivers: [], lakeCells: new Set(),
    present: !!cv && Object.prototype.hasOwnProperty.call(cv, 'rivers'),
  };
  if (!cv || !(cv.w > 1) || !(cv.h > 1)) return out;
  const point = (pt) => {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const x = Number(pt[0]), y = Number(pt[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [
      clamp(x, 0, cv.w - 1) * ((GW - 1) / (cv.w - 1)),
      clamp(y, 0, cv.h - 1) * ((GH - 1) / (cv.h - 1)),
    ];
  };
  if (Array.isArray(cv.rivers)) {
    for (const path of cv.rivers) {
      if (!Array.isArray(path)) continue;
      const pts = path.map(point).filter(Boolean);
      if (pts.length > 1) out.rivers.push(pts);
    }
  }
  if (Array.isArray(cv.lakes)) {
    // Each stored point represents one parent-world cell. Recreate that
    // footprint at region resolution instead of leaving a dotted lake.
    const sourceW = Number(cv.wx1) - Number(cv.wx0);
    const sourceH = Number(cv.wy1) - Number(cv.wy0);
    const halfW = sourceW > 0 ? Math.max(0.5, (GW - 1) / sourceW / 2) : 1;
    const halfH = sourceH > 0 ? Math.max(0.5, (GH - 1) / sourceH / 2) : 1;
    for (const lake of cv.lakes) {
      if (!Array.isArray(lake)) continue;
      for (const raw of lake) {
        const pt = point(raw);
        if (!pt) continue;
        const x0 = clamp(Math.floor(pt[0] - halfW), 0, GW - 1);
        const x1 = clamp(Math.ceil(pt[0] + halfW), 0, GW - 1);
        const y0 = clamp(Math.floor(pt[1] - halfH), 0, GH - 1);
        const y1 = clamp(Math.ceil(pt[1] + halfH), 0, GH - 1);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.lakeCells.add(y * GW + x);
      }
    }
  }
  return out;
}

function sampleCarve(grid, w, h, u, v) {
  const fx = u * (w - 1), fy = v * (h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const top = grid[y0 * w + x0] + (grid[y0 * w + x1] - grid[y0 * w + x0]) * tx;
  const bot = grid[y1 * w + x0] + (grid[y1 * w + x1] - grid[y1 * w + x0]) * tx;
  return top + (bot - top) * ty;
}

/** Stable identity for links/edits — keys embed the GENERATED name. */
function attachRegionKeys(model) {
  model.settlements.forEach((s, i) => { s.key = siteKey('region', i, s.name); });
  model.landmarks.forEach((l, i) => { l.key = siteKey('landmark', i, l.name); });
}

/** Replay map.siteEdits and map.sites onto the finished model. Moving, hiding
 *  or adding a settlement replans the roads on a dedicated stream (':roads2')
 *  so an edited map's roads follow its towns — an unedited map never consumes
 *  that stream and keeps its original roads byte-identical. */
function applyRegionEdits(model, map) {
  const edits = map.siteEdits || {};
  const custom = map.sites || [];
  if (!Object.keys(edits).length && !custom.length) return;
  let structural = false;
  // generated names BEFORE renames apply — the collision filter compares
  // these, so a rename can never change which settlements exist
  const genName = new Map(model.settlements.map((s) => [s, s.name]));

  for (const s of custom) {
    if (s.kind === 'region') continue; // regions never nest inside a region map
    model.settlements.push({
      x: s.x * REGION_W,
      y: s.y * REGION_H,
      size: Math.max(1, Math.min(3, Number(s.size) || 1)),
      townSize: Number(s.townSize) || null,
      seat: !!s.seat, // inherited world capitals stay the seat one scale down
      capital: !!s.capital,
      name: String(s.name || 'New town'),
      origName: String(s.origName || s.name || ''),
      custom: true,
      inherited: !!s.inherited,
      origin: s.origin || null,
      townSeed: s.townSeed || null,
      townGeography: s.inherited && s.townGeography && Math.abs(s.x-s.townGeography.x)<.00001 && Math.abs(s.y-s.townGeography.y)<.00001 ? s.townGeography : null,
      key: customKey(s),
    });
    structural = true;
  }
  for (const s of model.settlements) {
    const e = edits[s.key];
    if (!e) continue;
    if (e.name) s.name = String(e.name);
    if (e.x != null && e.y != null) {
      s.x = e.x * REGION_W;
      s.y = e.y * REGION_H;
      s.townGeography = null;
      structural = true;
    }
    if (e.hidden) structural = true;
  }
  model.settlements = model.settlements.filter((s) => !edits[s.key]?.hidden);
  // Inherited world towns are canon: the carve's quantization + local fbm can
  // strand one a cell into the sea, so nudge it to the nearest FREE land cell
  // (occupancy-aware — two towns in one bay must not stack); generated places
  // that duplicate an inherited DRILL-TIME name (origName, never the display
  // name — renames must stay non-structural) or crowd an inherited site are
  // dropped, and generated seats yield to a real inherited capital. All gated
  // on inherited sites existing, so every pre-1.4 region map (edited or not)
  // renders byte-identically.
  if (model.settlements.some((s) => s.inherited)) {
    const cells = new Set();
    for (const s of model.settlements) {
      if (s.inherited) snapToLand(model, s, cells);
    }
    const taken = new Set(model.settlements.filter((s) => s.inherited)
      .map((s) => (s.origName || s.name).trim().toLowerCase()));
    const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 44; // ~11 cells
    const inherited = model.settlements.filter((s) => s.inherited);
    // proximity spares anything the user touched — dragging a settlement
    // next to a canon town must never make it vanish
    model.settlements = model.settlements.filter((s) => s.custom
      || (!taken.has(String(genName.get(s) ?? s.name).trim().toLowerCase())
        && (edits[s.key] || !inherited.some((i) => near(i, s)))));
    // only a real inherited capital displaces the generated seat — a custom
    // region has no canonical capital, so its generated seat stays
    if (model.settlements.some((s) => s.inherited && s.seat)) {
      for (const s of model.settlements) {
        if (s.custom) continue;
        s.seat = false;
        if (s.size > 2) s.size = 2;
      }
    }
  }
  for (const l of model.landmarks) {
    const e = edits[l.key];
    if (!e) continue;
    if (e.name) l.name = String(e.name);
    if (e.x != null && e.y != null) {
      l.x = e.x * REGION_W;
      l.y = e.y * REGION_H;
    }
  }
  model.landmarks = model.landmarks.filter((l) => !edits[l.key]?.hidden);

  if (structural) {
    model.roads = model.settlements.length > 1 ? planRoads(model, makeRng(map.seed + ':roads2')) : [];
  }
}

/** Nearest FREE land cell within 8 rings, deterministic scan order. `cells`
 *  tracks occupancy so neighbouring submerged towns fan out instead of
 *  stacking on one shore cell. Model-space only — the persisted site keeps
 *  the exact world-derived position. */
function snapToLand(model, s, cells) {
  const { height, water, gw, gh } = model;
  const gx = clamp(Math.round(s.x / SX), 0, gw - 1);
  const gy = clamp(Math.round(s.y / SY), 0, gh - 1);
  if (height[gy * gw + gx] >= water) {
    cells.add(gy * gw + gx);
    return;
  }
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        if (height[ny * gw + nx] >= water && !cells.has(ny * gw + nx)) {
          cells.add(ny * gw + nx);
          s.x = nx * SX;
          s.y = ny * SY;
          return;
        }
      }
    }
  }
}

/** world.js's applyStrokeToGrid, on this kind's own grid dimensions. */
function applyStroke(height, s) {
  const cx = s.x * GW, cy = s.y * GH, r = s.r * GW;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(GW - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(GH - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const t = 1 - Math.sqrt(dx * dx + dy * dy) / r;
      if (t > 0) height[y * GW + x] += s.d * t * t;
    }
  }
}

function placeSettlements(model, rng, count) {
  const { height, water, gw, gh } = model;
  const out = [];
  const nearWater = (cx, cy) => {
    for (let dy = -6; dy <= 6; dy += 2) {
      for (let dx = -6; dx <= 6; dx += 2) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < gw && y < gh && height[y * gw + x] < water) return true;
      }
    }
    return false;
  };
  let tries = 0;
  while (out.length < count && tries++ < 400 + count * 120) {
    const x = rng.int(8, gw - 9), y = rng.int(8, gh - 9);
    const h = height[y * gw + x];
    if (h < water + 0.012 || h > water + 0.28 || model.lakeMask?.[y * gw + x]) continue; // dry land, below the peaks
    const px = x * SX, py = y * SY;
    if (out.some((s) => Math.hypot(s.x - px, s.y - py) < 90)) continue;
    if (!nearWater(x, y) && !rng.chance(0.25)) continue; // waterside preferred, not required
    out.push({ x: px, y: py, size: out.length === 0 ? 3 : rng.int(1, 2), seat: out.length === 0 });
  }
  return out;
}

/** Nearest-neighbour spanning tree rooted at the seat, one polyline per edge. */
function planRoads(model, rng) {
  const s = model.settlements;
  const roads = [];
  const linked = [0];
  const rest = s.map((_, i) => i).slice(1);
  while (rest.length) {
    let bi = 0, bj = 0, bd = Infinity;
    for (let ri = 0; ri < rest.length; ri++) {
      for (const li of linked) {
        const d = Math.hypot(s[rest[ri]].x - s[li].x, s[rest[ri]].y - s[li].y);
        if (d < bd) { bd = d; bi = ri; bj = li; }
      }
    }
    roads.push(tracePath(model, rng, s[bj], s[rest[bi]]));
    linked.push(rest[bi]);
    rest.splice(bi, 1);
  }
  return roads;
}

function tracePath(model, rng, a, b) {
  const { height, water, gw, gh } = model;
  const landAt = (x, y) => {
    const gx = clamp(Math.round(x / SX), 0, gw - 1), gy = clamp(Math.round(y / SY), 0, gh - 1);
    return height[gy * gw + gx] >= water;
  };
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n = Math.max(2, Math.round(len / 26));
  const px = -(b.y - a.y) / len, py = (b.x - a.x) / len; // unit perpendicular
  const pts = [[a.x, a.y]];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const wob = rng.range(-7, 7) * Math.sin(t * Math.PI); // pinned at both ends
    let x = a.x + (b.x - a.x) * t + px * wob;
    let y = a.y + (b.y - a.y) * t + py * wob;
    if (!landAt(x, y)) {
      for (const off of [12, -12, 24, -24, 38, -38]) { // sidestep lakes
        if (landAt(x + px * off, y + py * off)) { x += px * off; y += py * off; break; }
      }
    }
    pts.push([x, y]);
  }
  pts.push([b.x, b.y]);
  return pts;
}

const LANDMARK_KINDS = ['ruin', 'tower', 'shrine', 'cave'];

function placeLandmarks(model, rng, count) {
  const { height, water, gw, gh } = model;
  const out = [];
  let tries = 0;
  while (out.length < count && tries++ < 300 + count * 100) {
    const x = rng.int(6, gw - 7), y = rng.int(6, gh - 7);
    if (height[y * gw + x] < water + 0.01) continue;
    const px = x * SX, py = y * SY;
    if (model.settlements.some((s) => Math.hypot(s.x - px, s.y - py) < 70)) continue;
    if (out.some((l) => Math.hypot(l.x - px, l.y - py) < 55)) continue;
    out.push({ x: px, y: py, kind: rng.pick(LANDMARK_KINDS) });
  }
  return out;
}

/** Trace rivers: descend from highlands to open water. Own stream, like world.
 *  Exported for the town drill — a pure function, safe to re-invoke. */
export function traceRivers(model, seed) {
  if (model.generation === '1.8' && model.rivers) return model.rivers;
  // New carved regions use the parent world's clipped river paths. Old carves
  // have no such field and continue through the original local generator.
  if (model.hasCarveHydrology) return model.carveRivers;
  const { height, water, gw, gh } = model;
  const rng = makeRng(seed + ':rivers');
  const count = rng.int(2, 3);
  const rivers = [];
  let attempts = 0;
  while (rivers.length < count && attempts++ < 90) {
    let x = rng.int(4, gw - 5), y = rng.int(4, gh - 5);
    if (height[y * gw + x] < water + 0.14) continue;
    const path = [[x, y]];
    for (let step = 0; step < 500; step++) {
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
    if (path.length > 14 && height[path[path.length - 1][1] * gw + path[path.length - 1][0]] < water) {
      rivers.push(path);
    }
  }
  return rivers;
}

// ---------- palettes (render-level only) ----------

const PALETTES = {
  green: {
    deep: [40, 70, 108], shallow: [80, 120, 150],
    lowWet: [86, 122, 72], low: [124, 150, 88], lowDry: [156, 152, 100],
    upWet: [98, 118, 74], upDry: [140, 132, 94], high: [148, 140, 124], peak: [232, 232, 235],
    river: 'rgba(52, 96, 134, 0.9)', coast: 'rgba(44, 36, 24, 0.8)', coastOut: 'rgba(70, 100, 130, 0.55)',
    roadCase: 'rgba(70, 50, 30, 0.9)', roadFill: '#c9a86a',
    town: '#7d5138', glyph: '#d9cdb2', ink: '#2e2318',
  },
  harsh: {
    deep: [46, 56, 70], shallow: [88, 98, 108],
    lowWet: [108, 108, 70], low: [152, 128, 86], lowDry: [172, 142, 96],
    upWet: [124, 100, 70], upDry: [138, 106, 78], high: [116, 96, 84], peak: [206, 196, 186],
    river: 'rgba(70, 96, 110, 0.9)', coast: 'rgba(40, 30, 22, 0.8)', coastOut: 'rgba(90, 100, 110, 0.5)',
    roadCase: 'rgba(58, 40, 24, 0.9)', roadFill: '#cfa878',
    town: '#6b4a30', glyph: '#d6c5a8', ink: '#2a2014',
  },
  cold: {
    deep: [34, 54, 82], shallow: [94, 124, 150],
    lowWet: [72, 98, 82], low: [148, 156, 140], lowDry: [172, 174, 160],
    upWet: [110, 124, 110], upDry: [150, 152, 142], high: [162, 166, 174], peak: [238, 240, 244],
    river: 'rgba(90, 130, 160, 0.9)', coast: 'rgba(36, 42, 56, 0.85)', coastOut: 'rgba(120, 150, 175, 0.5)',
    roadCase: 'rgba(52, 44, 38, 0.9)', roadFill: '#b8a98e',
    town: '#5c4634', glyph: '#dde2e8', ink: '#2c3442',
  },
  arid: {
    deep: [50, 104, 112], shallow: [96, 148, 148],
    lowWet: [128, 148, 82], low: [208, 184, 128], lowDry: [220, 196, 138],
    upWet: [168, 148, 96], upDry: [188, 158, 104], high: [164, 138, 102], peak: [224, 204, 168],
    river: 'rgba(72, 140, 140, 0.9)', coast: 'rgba(64, 50, 30, 0.8)', coastOut: 'rgba(90, 150, 150, 0.55)',
    roadCase: 'rgba(96, 64, 34, 0.9)', roadFill: '#e0c391',
    town: '#8a6a48', glyph: '#efe0bd', ink: '#4a3620',
  },
};

/** Render-level only, mirroring town themes: 'auto' picks from its own seed
 *  stream and never touches the model, so re-terraining recolors in place.
 *  The key resolver is exported so town drills can climate-match themselves. */
export function resolveRegionTerrainKey(map) {
  let t = (map.params || {}).terrain ?? 'auto';
  if (!PALETTES[t] && t !== 'auto') t = 'green';
  if (t === 'auto') {
    const r = makeRng(map.seed + ':biome')();
    t = r < 0.45 ? 'green' : r < 0.65 ? 'harsh' : r < 0.85 ? 'cold' : 'arid';
  }
  return t;
}

function resolveRegionPalette(map) {
  return PALETTES[resolveRegionTerrainKey(map)];
}

function bandColor(pal, h, m, wl) {
  if (h < wl - 0.09) return pal.deep;
  if (h < wl) return pal.shallow;
  const a = h - wl;
  if (a > 0.32) return pal.peak;
  if (a > 0.22) return pal.high;
  if (a > 0.12) return m > 0.5 ? pal.upWet : pal.upDry;
  return m > 0.58 ? pal.lowWet : m > 0.3 ? pal.low : pal.lowDry;
}

// ---------- marching squares (the double coast ink) ----------

// corner bits: a=TL(8) b=TR(4) c=BR(2) d=BL(1); edges t/r/b/l
const ISO_CASES = [null, [['l', 'b']], [['b', 'r']], [['l', 'r']], [['t', 'r']], [['t', 'l'], ['b', 'r']], [['t', 'b']], [['t', 'l']],
  [['t', 'l']], [['t', 'b']], [['t', 'r'], ['l', 'b']], [['t', 'r']], [['l', 'r']], [['b', 'r']], [['l', 'b']], null];

function isoSegments(field, gw, gh, level) {
  const segs = [];
  const lerp = (a, b) => (level - a) / ((b - a) || 1e-9);
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const a = field[y * gw + x], b = field[y * gw + x + 1];
      const c = field[(y + 1) * gw + x + 1], d = field[(y + 1) * gw + x];
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      const pairs = ISO_CASES[idx];
      if (!pairs) continue;
      const pt = {
        t: [x + lerp(a, b), y], r: [x + 1, y + lerp(b, c)],
        b: [x + lerp(d, c), y + 1], l: [x, y + lerp(a, d)],
      };
      for (const [e1, e2] of pairs) {
        segs.push([
          [(pt[e1][0] + 0.5) * SX, (pt[e1][1] + 0.5) * SY],
          [(pt[e2][0] + 0.5) * SX, (pt[e2][1] + 0.5) * SY],
        ]);
      }
    }
  }
  return segs;
}

function strokeSegs(ctx, segs) {
  ctx.beginPath();
  for (const [[x1, y1], [x2, y2]] of segs) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}

function strokePoly(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

// ---------- glyphs ----------

const CLUSTER = [[0, 0], [7, -4], [-7, 3], [4, 6], [-6, -6], [9, 3], [-10, -1], [1, -9]];

function drawSettlement(ctx, s, pal) {
  const n = Math.min(CLUSTER.length, 2 + s.size * 2);
  ctx.fillStyle = pal.town;
  ctx.strokeStyle = pal.ink;
  ctx.lineWidth = 1.1;
  for (let i = 0; i < n; i++) {
    const u = i === 0 ? 3.4 + s.size * 0.6 : 2.6 + s.size * 0.4;
    const [dx, dy] = CLUSTER[i];
    ctx.fillRect(s.x + dx - u / 2, s.y + dy - u / 2, u, u);
    ctx.strokeRect(s.x + dx - u / 2, s.y + dy - u / 2, u, u);
  }
  if (s.seat) {
    // the seat flies its keep above the huddle
    ctx.fillRect(s.x - 3, s.y - 15, 6, 8);
    ctx.strokeRect(s.x - 3, s.y - 15, 6, 8);
    ctx.beginPath();
    ctx.moveTo(s.x - 4, s.y - 15);
    ctx.lineTo(s.x, s.y - 20);
    ctx.lineTo(s.x + 4, s.y - 15);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function drawLandmark(ctx, lm, pal) {
  ctx.save();
  ctx.translate(lm.x, lm.y);
  ctx.strokeStyle = pal.ink;
  ctx.fillStyle = pal.glyph;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  switch (lm.kind) {
    case 'tower':
      ctx.fillRect(-2.5, -7, 5, 12);
      ctx.strokeRect(-2.5, -7, 5, 12);
      ctx.beginPath();
      ctx.moveTo(-4, -7); ctx.lineTo(0, -12); ctx.lineTo(4, -7);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      break;
    case 'ruin':
      ctx.fillRect(-6, -2, 3, 8); ctx.strokeRect(-6, -2, 3, 8);
      ctx.fillRect(2, -5, 3, 11); ctx.strokeRect(2, -5, 3, 11);
      line(-7, 6, 7, 6);
      line(-2, 3, 1, 5); // fallen block
      break;
    case 'shrine':
      line(-4, 6, -4, -2);
      line(4, 6, 4, -2);
      ctx.beginPath();
      ctx.moveTo(-6, -2); ctx.lineTo(0, -8); ctx.lineTo(6, -2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 2, 1.6, 0, TAU);
      ctx.fillStyle = pal.ink;
      ctx.fill();
      break;
    case 'cave':
      ctx.beginPath();
      ctx.arc(0, 3, 6, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = '#241d14';
      ctx.fill(); ctx.stroke();
      line(-8, 3, 8, 3);
      break;
  }
  ctx.restore();
}

function drawHexes(ctx, pal) {
  const R = 24, rowH = Math.sqrt(3) * R; // flat-top, 48px corner to corner
  ctx.save();
  ctx.strokeStyle = 'rgba(46, 35, 24, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let col = 0; col * R * 1.5 < REGION_W + R; col++) {
    const cx = col * R * 1.5;
    const yOff = (col % 2) * rowH / 2;
    for (let cy = yOff; cy < REGION_H + rowH; cy += rowH) {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = cx + Math.cos(a) * R, py = cy + Math.sin(a) * R;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }
  ctx.stroke();
  ctx.restore();
}

// ---------- rendering ----------

export function renderRegionBase(map, model, scale = 1) {
  model = model || buildRegionModel(map);
  if (model.generation === '1.8') return renderGeographicMap({ ...map, params: { ...map.params, terrain: resolveRegionTerrainKey(map) } }, model, scale, true);
  const { height, moisture, water, gw, gh } = model;
  const p = { ...defaultRegionParams(), ...(map.params || {}) };
  const pal = resolveRegionPalette(map);

  const off = document.createElement('canvas');
  off.width = gw; off.height = gh;
  const octx = off.getContext('2d');
  const img = octx.createImageData(gw, gh);
  const d = img.data;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const h = height[i];
      const col = bandColor(pal, model.lakeMask?.[i] ? water-.025 : h, moisture[i], water);
      let shade = 1;
      if (h >= water && x > 0 && y > 0 && x < gw - 1 && y < gh - 1) {
        const grad = height[(y - 1) * gw + (x - 1)] - height[(y + 1) * gw + (x + 1)];
        shade = clamp(1 + grad * 6, 0.78, 1.2); // soft hillshade
      } else if (h < water) {
        shade = clamp(1 + (h - water) * 1.2, 0.78, 1); // depth falloff
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
  base.width = REGION_W * scale;
  base.height = REGION_H * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale); // all drawing below stays in native coordinates
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, REGION_W, REGION_H);

  // parchment grain over the wash
  const tex = makeRng(map.seed + ':texture');
  for (let i = 0; i < 170; i++) {
    ctx.fillStyle = `rgba(120, 100, 60, ${tex.range(0.015, 0.04)})`;
    ctx.beginPath();
    ctx.arc(tex.range(0, REGION_W), tex.range(0, REGION_H), tex.range(10, 46), 0, TAU);
    ctx.fill();
  }

  // double coast ink: outer wash line in the shallows, crisp line at the shore
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = pal.coastOut;
  ctx.lineWidth = 1;
  strokeSegs(ctx, isoSegments(height, gw, gh, water - 0.03));
  ctx.strokeStyle = pal.coast;
  ctx.lineWidth = 1.5;
  strokeSegs(ctx, isoSegments(height, gw, gh, water));

  // rivers taper up as they gather
  ctx.strokeStyle = pal.river;
  for (const path of traceRivers(model, map.seed)) {
    for (let seg = 1; seg < path.length; seg++) {
      ctx.lineWidth = 0.8 + (seg / path.length) * 2.4;
      ctx.beginPath();
      ctx.moveTo((path[seg - 1][0] + 0.5) * SX, (path[seg - 1][1] + 0.5) * SY);
      ctx.lineTo((path[seg][0] + 0.5) * SX, (path[seg][1] + 0.5) * SY);
      ctx.stroke();
    }
  }

  // roads: dashed, cased
  if (p.roads !== false) {
    ctx.save();
    ctx.setLineDash([7, 5]);
    for (const road of model.roads) {
      ctx.strokeStyle = pal.roadCase;
      ctx.lineWidth = 3.4;
      strokePoly(ctx, road);
      ctx.strokeStyle = pal.roadFill;
      ctx.lineWidth = 1.7;
      strokePoly(ctx, road);
    }
    ctx.restore();
    if (model.generation === '1.8') {
      ctx.save(); ctx.strokeStyle = '#416b83'; ctx.setLineDash([2,6]); ctx.lineWidth = 1.4;
      for (const route of model.ferries || []) {
        strokePoly(ctx, route); const [a,b]=route;
        ctx.font='10px Georgia';ctx.textAlign='center';ctx.fillStyle='#254b66';ctx.fillText('Ferry',(a[0]+b[0])/2,(a[1]+b[1])/2-5);
      }
      ctx.setLineDash([]);ctx.strokeStyle=pal.ink;ctx.lineWidth=2;
      for(const b of model.bridges || []) { ctx.strokeRect(b.x-3,b.y-3,6,6); }
      ctx.restore();
    }
  }

  if (p.hexes) drawHexes(ctx, pal);

  for (const lm of model.landmarks) drawLandmark(ctx, lm, pal);
  for (const s of model.settlements) drawSettlement(ctx, s, pal);

  if (p.labels !== false && model.generation!=='1.8') {
    const halo = 'rgba(242, 235, 214, 0.78)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const s of model.settlements) {
      ctx.font = s.seat ? 'bold 15px Georgia, serif' : '13px Georgia, serif';
      const ly = s.y + (s.seat ? 12 : 10);
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3;
      ctx.strokeText(s.name, s.x, ly);
      ctx.fillStyle = pal.ink;
      ctx.fillText(s.name, s.x, ly);
    }
    ctx.font = 'italic 10px Georgia, serif';
    for (const lm of model.landmarks) {
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3;
      ctx.strokeText(lm.name, lm.x, lm.y + 9);
      ctx.fillStyle = pal.ink;
      ctx.fillText(lm.name, lm.x, lm.y + 9);
    }
    ctx.font = 'italic bold 46px Georgia, serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(46, 35, 24, 0.16)';
    // render-level title override (params.title): the generated name is still
    // drawn from its stream above, so renaming reshuffles nothing
    ctx.fillText(String(map.params?.title || '').trim() || model.title, REGION_W / 2, 64);
  }

  if(p.labels!==false&&model.generation==='1.8')drawMapLabels(ctx,[
    ...model.settlements.map(s=>({text:s.name,x:s.x,y:s.y,size:s.seat?15:13,bold:!!s.seat,priority:s.seat?10:8})),
    ...model.landmarks.map(l=>({text:l.name,x:l.x,y:l.y,size:11,italic:true,priority:3})),
    {text:p.title||model.title,x:REGION_W/2,y:40,size:30,bold:true,center:true,priority:6},
  ],REGION_W,REGION_H);

  // vignette + frame for the charted-province feel
  const grad = ctx.createRadialGradient(REGION_W / 2, REGION_H / 2, REGION_H * 0.55, REGION_W / 2, REGION_H / 2, REGION_W * 0.72);
  grad.addColorStop(0, 'rgba(20, 16, 10, 0)');
  grad.addColorStop(1, 'rgba(20, 16, 10, 0.32)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, REGION_W, REGION_H);
  ctx.strokeStyle = pal.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, REGION_W - 8, REGION_H - 8);
  return base;
}
