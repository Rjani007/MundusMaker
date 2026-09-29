// Town map generator with five layout archetypes so settlements feel distinct:
//   organic     — old-school radial market town, but with blob-shaped bounds
//   crossroads  — a settlement stretched along two or three crossing highways
//   grid        — a planned city: rectangular street grid around a forum
//   coastal     — harbor town on a shoreline: sea, piers, boats, landward wall
//   riverside   — town on both banks of a river, joined by bridges
// Everything is deterministic from seed + params; labels/markers live elsewhere.

import { makeRng, makeNoise2D } from '../util.js';
import { nameFor } from '../names.js';
import { planTown, coastalTownLayout } from './townplan.js';
import { renderPlannedTown } from './townart.js';
import { buildModernTown } from './moderntown.js';
import { renderModernTown } from './modernart.js';

export const TOWN_W = 900;
export const TOWN_H = 640;
const W = TOWN_W, H = TOWN_H;

export const TOWN_LAYOUTS = {
  auto: 'Surprise me',
  organic: 'Organic (market town)',
  crossroads: 'Crossroads',
  grid: 'Planned grid city',
  coastal: 'Coastal harbor',
  riverside: 'Riverside',
};

export const TOWN_SEA_SIDES = {
  south: 'South', north: 'North', east: 'East', west: 'West',
};

export function defaultTownParams() {
  // terrain/paving 'auto' applies to NEW maps only — resolveTownTheme falls
  // back to parchment/dirt when the params are absent, so maps made before
  // themes existed keep rendering exactly as they always have. wards likewise:
  // absent means off, so pre-0.13 towns stay pixel-identical.
  return { size: 2, density: 1, walls: true, river: false, layout: 'auto', terrain: 'auto', paving: 'auto', wards: true };
}

// ---------- wards (0.13) ----------
// A pure post-filter over the FINISHED model: cluster the buildings, hull each
// cluster, name it from its own stream. Nothing here draws from the main
// generator rng and nothing writes to the model — existing towns cannot move.

function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function computeWards(model, seed) {
  if (model.generation==='1.8') return (model.districts||[]).map(d=>{
    const mine=model.buildings.filter(b=>b.use===d.use),poly=convexHull(mine.map(b=>[b.x,b.y]));
    return {...d,poly,cx:d.cx,cy:d.cy};
  }).filter(d=>d.poly.length>2);
  const blds = model.buildings || [];
  if (blds.length < 14) return []; // hamlets don't have quarters
  const k = Math.max(2, Math.min(6, 1 + (model.size || 2)));
  const rng = makeRng(seed + ':wards');
  let centroids = [];
  for (let i = 0; i < k; i++) {
    const b = blds[Math.floor((i * blds.length) / k)];
    centroids.push([b.x, b.y]);
  }
  const assign = new Array(blds.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < blds.length; i++) {
      let best = 0, bd = Infinity;
      centroids.forEach((c, ci) => {
        const d = (blds[i].x - c[0]) ** 2 + (blds[i].y - c[1]) ** 2;
        if (d < bd) { bd = d; best = ci; }
      });
      assign[i] = best;
    }
    centroids = centroids.map((c, ci) => {
      const mine = blds.filter((_, i) => assign[i] === ci);
      if (!mine.length) return c;
      return [
        mine.reduce((s, b) => s + b.x, 0) / mine.length,
        mine.reduce((s, b) => s + b.y, 0) / mine.length,
      ];
    });
  }
  const wards = [];
  for (let ci = 0; ci < k; ci++) {
    const mine = blds.filter((_, i) => assign[i] === ci);
    // names draw in centroid order for determinism, even when a ward is skipped
    const name = nameFor(rng, 'ward');
    if (mine.length < 5) continue;
    const hull = convexHull(mine.map((b) => [b.x, b.y]));
    if (hull.length < 3) continue;
    const cx = centroids[ci][0], cy = centroids[ci][1];
    const poly = hull.map(([x, y]) => [cx + (x - cx) * 1.2, cy + (y - cy) * 1.2]);
    wards.push({ poly, cx, cy, name });
  }
  return wards;
}

const WARD_TINTS = ['224,114,74', '74,134,224', '90,158,111', '155,89,208', '212,167,44', '201,93,143'];

function pickAutoLayout(seed) {
  const r = makeRng(seed + ':layout')();
  if (r < 0.25) return 'organic';
  if (r < 0.45) return 'crossroads';
  if (r < 0.62) return 'grid';
  if (r < 0.82) return 'coastal';
  return 'riverside';
}

// ---------- terrain themes & street paving (render-level only) ----------
// Themes never touch the generator RNG streams: switching terrain re-colors a
// town without moving a single building. All values are draw-time constants.

export const TOWN_TERRAINS = {
  auto: 'Surprise me',
  parchment: 'Parchment',
  grassland: 'Grassland',
  desert: 'Desert',
  snow: 'Snowbound',
  marsh: 'Marshland',
};

export const TOWN_PAVINGS = {
  auto: 'Auto (by size)',
  dirt: 'Dirt & gravel',
  cobbled: 'Cobblestone',
  flagstone: 'Grand flagstone',
};

const TERRAIN_THEMES = {
  parchment: { // the original look — byte-for-byte the pre-theme palette
    ground: '#e6d9bc', blotch: [120, 100, 60], beach: '#dcc697',
    sea: '#6f9cb8', wave: 'rgba(230, 240, 245, 0.35)', shoreline: '#4a3a28',
    river: ['#7fa8c0', '#5c88a8'],
    road: { outline: '#b09a72', fill: '#d8c8a2' },
    tree: { fill: '#8fa25f', stroke: 'rgba(70, 85, 40, 0.7)', style: 'round', density: 1 },
    field: { fill: 'rgba(196, 168, 110, 0.55)', furrow: 'rgba(120, 95, 55, 0.5)', border: 'rgba(74, 58, 40, 0.45)' },
    orchard: { fill: 'rgba(143, 162, 95, 0.30)', dot: '#7e9354' },
    building: { fill: '#7d5138', landmark: '#9c3f2e', stroke: '#4a2e1d', ridge: 'rgba(30, 18, 10, 0.4)' },
    wall: '#4a3a28', label: '#3a2a18', border: '#4a3a28',
  },
  grassland: {
    ground: '#b3c68b', blotch: [70, 105, 50], beach: '#d9cf9e',
    sea: '#5f93b5', wave: 'rgba(225, 240, 245, 0.35)', shoreline: '#415030',
    river: ['#78a7bd', '#5586a3'],
    road: { outline: '#a8916a', fill: '#d3c096' },
    tree: { fill: '#5f7f42', stroke: 'rgba(40, 60, 25, 0.75)', style: 'round', density: 1 },
    field: { fill: 'rgba(212, 185, 110, 0.75)', furrow: 'rgba(150, 120, 60, 0.6)', border: 'rgba(80, 65, 35, 0.5)' },
    orchard: { fill: 'rgba(90, 120, 60, 0.35)', dot: '#4c6b34' },
    building: { fill: '#7a5236', landmark: '#9c3f2e', stroke: '#41291a', ridge: 'rgba(30, 18, 10, 0.4)' },
    wall: '#4a3a28', label: '#26301a', border: '#3c3a28',
  },
  desert: {
    ground: '#e4cf9e', blotch: [150, 110, 55], beach: '#e8d8ac',
    sea: '#4fa3a8', wave: 'rgba(240, 250, 250, 0.4)', shoreline: '#6b5330',
    river: ['#6fb3b8', '#4b9297'],
    road: { outline: '#c1a678', fill: '#e0cda1' },
    tree: { fill: '#8a9455', stroke: 'rgba(80, 85, 35, 0.8)', style: 'scrub', density: 0.45 },
    field: { fill: 'rgba(120, 160, 80, 0.5)', furrow: 'rgba(70, 110, 50, 0.55)', border: 'rgba(60, 80, 40, 0.5)' },
    orchard: { fill: 'rgba(110, 150, 75, 0.35)', dot: '#5f8547' },
    building: { fill: '#b3906a', landmark: '#a05633', stroke: '#5f452c', ridge: 'rgba(60, 40, 20, 0.35)' },
    wall: '#6b5330', label: '#4a3620', border: '#4a3a28',
  },
  snow: {
    ground: '#e8edf2', blotch: [140, 155, 175], beach: '#d8dee6',
    sea: '#5b7f9e', wave: 'rgba(235, 245, 250, 0.4)', shoreline: '#3f4a5c',
    river: ['#8fb0c8', '#6b93b0'],
    road: { outline: '#8f8270', fill: '#b8a98e' },
    tree: { fill: '#3f6448', stroke: 'rgba(20, 40, 25, 0.8)', style: 'pine', density: 1 },
    field: { fill: 'rgba(190, 180, 160, 0.4)', furrow: 'rgba(120, 115, 100, 0.4)', border: 'rgba(90, 90, 85, 0.45)' },
    orchard: { fill: 'rgba(110, 130, 105, 0.3)', dot: '#51705a' },
    building: { fill: '#5c4634', landmark: '#8e3b2c', stroke: '#2e2318', ridge: 'rgba(240, 244, 248, 0.55)' },
    wall: '#4a4550', label: '#2c3442', border: '#3a4050',
  },
  marsh: {
    ground: '#95a186', blotch: [60, 75, 55], beach: '#a8a88a',
    sea: '#54756e', wave: 'rgba(200, 225, 215, 0.3)', shoreline: '#2e3a30',
    river: ['#6a8f85', '#4d7168'],
    road: { outline: '#6f6a52', fill: '#94906f' },
    tree: { fill: '#57744c', stroke: 'rgba(30, 45, 28, 0.8)', style: 'round', density: 1 },
    field: { fill: 'rgba(140, 150, 90, 0.5)', furrow: 'rgba(85, 95, 55, 0.55)', border: 'rgba(50, 60, 40, 0.5)' },
    orchard: { fill: 'rgba(100, 120, 70, 0.35)', dot: '#4d6b3e' },
    building: { fill: '#6b543c', landmark: '#94402f', stroke: '#38291a', ridge: 'rgba(25, 18, 10, 0.4)' },
    wall: '#3e4a38', label: '#222e22', border: '#333e30',
  },
};

// widths + seam dashes; 'dirt' takes its colors from the terrain theme
const PAVING_STYLES = {
  dirt: { mainW: 13, sideW: 9, fillMainW: 9, fillSideW: 6, seams: null },
  cobbled: {
    outline: '#6f695f', fill: '#a8a196', mainW: 13, sideW: 9, fillMainW: 9, fillSideW: 6,
    seams: 'rgba(58, 54, 47, 0.45)', seamDash: [2, 5], seamW: 1.6,
  },
  flagstone: {
    outline: '#8a8478', fill: '#c6bfb2', mainW: 16, sideW: 10, fillMainW: 12, fillSideW: 7,
    seams: 'rgba(96, 90, 80, 0.4)', seamDash: [6, 7], seamW: 1.4,
  },
};

/**
 * Resolve the terrain + paving for a map. Maps that predate themes have no
 * terrain/paving params and MUST resolve to parchment/dirt (their original
 * look). 'auto' picks terrain from its own seed stream and paving from how
 * grand the settlement is.
 */
export function resolveTownTheme(map) {
  const params = map.params || {};
  let terrain = params.terrain ?? 'parchment';
  let paving = params.paving ?? 'dirt';
  if (!TERRAIN_THEMES[terrain] && terrain !== 'auto') terrain = 'parchment';
  if (terrain === 'auto') {
    const r = makeRng(map.seed + ':biome')();
    terrain = r < 0.3 ? 'grassland' : r < 0.55 ? 'parchment' : r < 0.75 ? 'desert' : r < 0.9 ? 'snow' : 'marsh';
  }
  if (paving === 'auto') {
    const layoutName = LAYOUT_FNS[params.layout] ? params.layout : pickAutoLayout(map.seed);
    const size = Math.max(1, Math.min(5, params.size ?? 2));
    paving = layoutName === 'grid' || size >= 5 ? 'flagstone' : size >= 3 ? 'cobbled' : 'dirt';
  }
  if (!PAVING_STYLES[paving]) paving = 'dirt';
  const t = TERRAIN_THEMES[terrain];
  const p = { ...PAVING_STYLES[paving] };
  if (paving === 'dirt') { p.outline = t.road.outline; p.fill = t.road.fill; }
  return { terrain, paving, t, p };
}

// ---------- boundary helpers (blob shapes instead of circles) ----------

const TAU = Math.PI * 2;

/** Distorted-circle boundary: radial blob with elongation and rotation. */
function blobBoundary(rng, cx, cy, baseR, elong = 1, rot = 0) {
  const N = 64;
  const radii = new Float32Array(N);
  const noise = makeNoise2D(Math.floor(rng() * 1e9));
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    radii[i] = baseR * (0.78 + 0.44 * noise(Math.cos(a) * 1.3 + 5, Math.sin(a) * 1.3 + 5));
  }
  const cos = Math.cos(-rot), sin = Math.sin(-rot);
  const radiusAt = (a) => {
    const f = ((a % TAU) + TAU) % TAU / TAU * N;
    const i0 = Math.floor(f) % N, i1 = (i0 + 1) % N;
    return radii[i0] + (radii[i1] - radii[i0]) * (f - Math.floor(f));
  };
  return {
    cx, cy,
    contains(x, y) {
      let dx = x - cx, dy = y - cy;
      const rx = (dx * cos - dy * sin) / elong, ry = dx * sin + dy * cos;
      return Math.hypot(rx, ry) <= radiusAt(Math.atan2(ry, rx));
    },
    polygon(scale = 1) {
      const pts = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        const r = radiusAt(a) * scale;
        const px = Math.cos(a) * r * elong, py = Math.sin(a) * r;
        pts.push([cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)]);
      }
      return pts;
    },
  };
}

/** Rotated-rectangle boundary for planned cities. */
function rectBoundary(cx, cy, halfW, halfH, rot) {
  const cos = Math.cos(-rot), sin = Math.sin(-rot);
  return {
    cx, cy,
    contains(x, y) {
      const dx = x - cx, dy = y - cy;
      return Math.abs(dx * cos - dy * sin) <= halfW && Math.abs(dx * sin + dy * cos) <= halfH;
    },
    polygon(scale = 1) {
      const pts = [];
      const w = halfW * scale, h = halfH * scale;
      const corners = [[-w, -h], [w, -h], [w, h], [-w, h]];
      for (let c = 0; c < 4; c++) {
        const [ax, ay] = corners[c], [bx, by] = corners[(c + 1) % 4];
        const steps = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 26));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
          pts.push([cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)]);
        }
      }
      return pts;
    },
  };
}

function unionBoundary(a, b) {
  return {
    cx: a.cx, cy: a.cy,
    contains: (x, y) => a.contains(x, y) || b.contains(x, y),
    polygon: (scale) => a.polygon(scale), // walls only ever enclose the primary blob
  };
}

/**
 * Radial envelope around the actual buildings — walls hug the built-up area
 * instead of the (much larger) planning boundary, whatever shape the town took.
 */
function buildingEnvelope(buildings, pad = 24) {
  const cx = buildings.reduce((s, b) => s + b.x, 0) / buildings.length;
  const cy = buildings.reduce((s, b) => s + b.y, 0) / buildings.length;
  const S = 48;
  const maxD = new Float32Array(S);
  for (const b of buildings) {
    const a = Math.atan2(b.y - cy, b.x - cx);
    const i = Math.floor((((a % TAU) + TAU) % TAU) / TAU * S);
    const d = Math.hypot(b.x - cx, b.y - cy) + Math.max(b.w, b.h) / 2;
    for (const off of [-1, 0, 1]) {
      const j = (i + off + S) % S;
      if (d > maxD[j]) maxD[j] = d;
    }
  }
  // fill unbuilt sectors by shrinking from neighbours
  for (let pass = 0; pass < S; pass++) {
    let changed = false;
    for (let i = 0; i < S; i++) {
      if (!maxD[i]) {
        const a = maxD[(i - 1 + S) % S], b = maxD[(i + 1) % S];
        if (a || b) { maxD[i] = Math.max(a, b) * 0.85; changed = true; }
      }
    }
    if (!changed) break;
  }
  // floor concave dips, then smooth hard — walls wobble, they don't zigzag
  const avg = maxD.reduce((s, v) => s + v, 0) / S;
  let smooth = [...maxD].map((v) => Math.max(v, avg * 0.6));
  for (let pass = 0; pass < 3; pass++) {
    smooth = smooth.map((v, i) => (smooth[(i - 1 + S) % S] + v * 2 + smooth[(i + 1) % S]) / 4);
  }
  return smooth.map((r, i) => {
    const a = (i / S) * TAU;
    return [cx + Math.cos(a) * (r + pad), cy + Math.sin(a) * (r + pad)];
  });
}

// ---------- road helpers ----------

function wanderingRoad(rng, x, y, angle, jitter = 0.09, step = 34) {
  const pts = [[x, y]];
  let a = angle;
  while (x > -40 && x < W + 40 && y > -40 && y < H + 40) {
    a += rng.range(-jitter, jitter);
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    pts.push([x, y]);
  }
  return pts;
}

/** A near-straight road that crosses the whole canvas through (px, py). */
function throughRoad(rng, px, py, angle, jitter = 0.035) {
  const back = wanderingRoad(rng, px, py, angle + Math.PI, jitter);
  const fwd = wanderingRoad(rng, px, py, angle, jitter);
  return back.reverse().concat(fwd.slice(1));
}

function sideStreets(rng, roads, boundary, count) {
  const out = [];
  const mains = roads.filter((r) => r.pts.length > 2); // branch off anything that isn't a stub
  for (let i = 0; i < count && mains.length; i++) {
    const road = rng.pick(mains);
    const idx = rng.int(1, road.pts.length - 2);
    const [sx, sy] = road.pts[idx];
    if (!boundary.contains(sx, sy)) continue;
    const [ax, ay] = road.pts[idx - 1], [bx, by] = road.pts[idx + 1];
    const roadAngle = Math.atan2(by - ay, bx - ax);
    const perp = roadAngle + (rng.chance(0.5) ? 1 : -1) * Math.PI / 2 + rng.range(-0.2, 0.2);
    const len = rng.range(46, 110);
    const pts = [[sx, sy]];
    let a = perp, x = sx, y = sy;
    for (let d = 0; d < len; d += 24) {
      a += rng.range(-0.12, 0.12);
      x += Math.cos(a) * 24;
      y += Math.sin(a) * 24;
      if (!boundary.contains(x, y)) break;
      pts.push([x, y]);
    }
    if (pts.length > 1) out.push({ pts, main: false });
  }
  return out;
}

// ---------- layout generators ----------
// Each returns { roads, plaza, boundary, water, wallScale, landmarkNames, plazaLabel }

function layoutOrganic(rng, p) {
  const size = p.size;
  const cx = W / 2 + rng.range(-70, 70), cy = H / 2 + rng.range(-50, 50);
  const baseR = 95 + size * 46;
  const boundary = blobBoundary(rng, cx, cy, baseR, rng.range(1, 1.5), rng.range(0, TAU));

  const roads = [];
  const nSpokes = 3 + Math.min(size, 4);
  const baseAngle = rng.range(0, TAU);
  for (let i = 0; i < nSpokes; i++) {
    const angle = baseAngle + (i * TAU) / nSpokes + rng.range(-0.22, 0.22);
    roads.push({ pts: wanderingRoad(rng, cx, cy, angle), main: true });
  }
  // ring-lane arcs that follow the town's shape fill in the wedges between spokes
  if (size >= 2) {
    const nArcs = rng.int(1, 2);
    for (let k = 0; k < nArcs; k++) {
      const ring = boundary.polygon(rng.range(0.3, 0.6));
      const start = rng.int(0, ring.length - 1);
      const len = rng.int(Math.floor(ring.length * 0.4), k === 0 && rng.chance(0.5) ? ring.length : Math.floor(ring.length * 0.75));
      const pts = [];
      for (let i = 0; i <= len; i++) pts.push(ring[(start + i) % ring.length]);
      roads.push({ pts, main: false });
    }
  }
  roads.push(...sideStreets(rng, roads, boundary, size * 6 + 2));

  // plaza is not always dead-center
  let plaza = { x: cx, y: cy, r: 24 + size * 6 };
  if (rng.chance(0.4)) {
    const a = rng.range(0, TAU);
    const d = baseR * 0.3;
    plaza = { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 22 + size * 5 };
  }

  let water = null;
  if (p.river) water = makeRiver(rng, rng.range(H * 0.6, H * 0.82));
  return { roads, plaza, boundary, water, wallScale: 0.98, landmarkNames: ['Tavern', 'Temple', 'Smithy', 'Guildhall', 'Keep', 'Granary'], plazaLabel: size >= 2 ? 'Market' : null };
}

function layoutCrossroads(rng, p) {
  const size = p.size;
  const px = W / 2 + rng.range(-90, 90), py = H / 2 + rng.range(-60, 60);
  const angleA = rng.range(0, Math.PI);
  const roads = [{ pts: throughRoad(rng, px, py, angleA), main: true }];
  const angleB = angleA + Math.PI / 2 + rng.range(-0.4, 0.4);
  roads.push({ pts: throughRoad(rng, px, py, angleB), main: true });
  if (size >= 2 && rng.chance(0.6)) {
    roads.push({ pts: throughRoad(rng, px + rng.range(-70, 70), py + rng.range(-50, 50), rng.range(0, Math.PI)), main: true });
  }
  // town stretches along the first road
  const boundary = blobBoundary(rng, px, py, 75 + size * 38, rng.range(1.5, 2), angleA);
  roads.push(...sideStreets(rng, roads, boundary, size * 5 + 3));

  let water = null;
  if (p.river) water = makeRiver(rng, rng.range(H * 0.62, H * 0.82));
  return {
    roads, plaza: { x: px, y: py, r: 16 + size * 5 }, boundary, water,
    wallScale: size >= 4 ? 0.96 : 0, // crossroads towns are travel stops — rarely walled
    landmarkNames: ['Coaching Inn', 'Tollhouse', 'Smithy', 'Stables', 'Chapel', 'Grange'],
    plazaLabel: null,
  };
}

function layoutGrid(rng, p) {
  const size = p.size;
  const cx = W / 2 + rng.range(-40, 40), cy = H / 2 + rng.range(-30, 30);
  const rot = rng.range(-0.22, 0.22);
  const halfW = Math.min(120 + size * 52, W / 2 - 50);
  const halfH = Math.min(85 + size * 42, H / 2 - 45);
  const boundary = rectBoundary(cx, cy, halfW, halfH, rot);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const toWorld = (gx, gy) => [cx + gx * cos - gy * sin, cy + gx * sin + gy * cos];

  const roads = [];
  const sx = rng.range(58, 76), sy = rng.range(52, 68);
  // avenues through the center run off the map (they're the gates' roads);
  // planned cities keep them almost perfectly straight
  roads.push({ pts: throughRoad(rng, cx, cy, rot, 0.01), main: true });
  roads.push({ pts: throughRoad(rng, cx, cy, rot + Math.PI / 2, 0.01), main: true });
  for (let gx = -Math.floor(halfW / sx) * sx; gx <= halfW; gx += sx) {
    if (Math.abs(gx) < sx * 0.5) continue; // central avenue already placed
    const jitter = rng.range(-4, 4);
    roads.push({ pts: [toWorld(gx + jitter, -halfH), toWorld(gx + jitter, halfH)], main: false });
  }
  for (let gy = -Math.floor(halfH / sy) * sy; gy <= halfH; gy += sy) {
    if (Math.abs(gy) < sy * 0.5) continue;
    const jitter = rng.range(-4, 4);
    roads.push({ pts: [toWorld(-halfW, gy + jitter), toWorld(halfW, gy + jitter)], main: false });
  }

  let water = null;
  if (p.river) water = makeRiver(rng, rng.range(H * 0.68, H * 0.85));
  return {
    roads, plaza: { x: cx, y: cy, r: 26 + size * 5 }, boundary, water,
    wallScale: 1.04,
    landmarkNames: ['Basilica', 'Bathhouse', 'Arena', 'Granary', 'Barracks', 'Temple'],
    plazaLabel: 'Forum',
  };
}

function layoutCoastal(rng, p) {
  const size = p.size;
  // shoreline across the map, sea at the bottom (mirrored half the time at render)
  const noise = makeNoise2D(Math.floor(rng() * 1e9));
  const baseY = H * rng.range(0.6, 0.74);
  const tilt = rng.range(-0.12, 0.12);
  const shore = [];
  for (let x = -20; x <= W + 20; x += 30) {
    shore.push([x, baseY + (x - W / 2) * tilt + (noise(x * 0.006, 3) - 0.5) * 70]);
  }
  const shoreAt = (x) => {
    const i = Math.max(0, Math.min(shore.length - 2, Math.floor((x + 20) / 30)));
    const t = (x + 20) / 30 - i;
    return shore[i][1] + (shore[i + 1][1] - shore[i][1]) * t;
  };

  const cx = W * rng.range(0.35, 0.65);
  const baseR = 85 + size * 44;
  const cy = shoreAt(cx) - baseR * 0.62;
  const blob = blobBoundary(rng, cx, cy, baseR, rng.range(1.2, 1.6), tilt);
  const boundary = {
    cx, cy,
    contains: (x, y) => blob.contains(x, y) && y < shoreAt(x) - 8,
    polygon: (s) => blob.polygon(s),
  };

  const roads = [];
  // harbor road hugs the shore
  const hw = baseR * 1.15;
  const harbor = [];
  for (let x = cx - hw; x <= cx + hw; x += 26) {
    harbor.push([x, shoreAt(x) - rng.range(16, 24)]);
  }
  roads.push({ pts: harbor, main: true });
  // main streets run inland; one becomes the land route off the map
  const nInland = 2 + Math.min(size, 3);
  for (let i = 0; i < nInland; i++) {
    const x = cx + rng.range(-hw * 0.7, hw * 0.7);
    const pts = wanderingRoad(rng, x, shoreAt(x) - 20, -Math.PI / 2 + tilt + rng.range(-0.25, 0.25), 0.07);
    roads.push({ pts, main: i === 0 });
  }
  // back streets run parallel to the harbor, deeper and deeper inland
  const nBack = 1 + Math.min(size, 3);
  for (let i = 1; i <= nBack; i++) {
    const depth = baseR * (0.18 + i * 0.17);
    const spread = hw * (1 - i * 0.16);
    const back = [];
    for (let x = cx - spread; x <= cx + spread; x += 26) {
      back.push([x, shoreAt(x) - depth + rng.range(-6, 6)]);
    }
    roads.push({ pts: back, main: false });
  }
  roads.push(...sideStreets(rng, roads, boundary, size * 5 + 3));

  // piers and boats
  const piers = [];
  for (let i = 0, n = 2 + size; i < n; i++) {
    const x = cx + rng.range(-hw * 0.8, hw * 0.8);
    const y0 = shoreAt(x) - 4;
    piers.push({ x0: x, y0, x1: x + rng.range(-10, 10), y1: y0 + rng.range(28, 30 + size * 8) });
  }
  const boats = [];
  for (let i = 0, n = size + 2; i < n; i++) {
    const x = cx + rng.range(-hw, hw);
    boats.push({ x, y: shoreAt(x) + rng.range(30, 100), rot: rng.range(0, TAU) });
  }

  const plazaX = cx + rng.range(-30, 30);
  return {
    roads, plaza: { x: plazaX, y: shoreAt(plazaX) - 34, r: 20 + size * 5 }, boundary,
    water: { kind: 'sea', shore, shoreAt }, piers, boats,
    wallScale: size >= 3 ? 0.98 : 0,
    landmarkNames: ['Harbormaster', 'Shipwright', 'Sailmaker', 'Salt House', 'Temple of Tides', 'Customs House'],
    plazaLabel: 'Fish Market',
  };
}

function layoutRiverside(rng, p) {
  const size = p.size;
  const water = makeRiver(rng, H * rng.range(0.4, 0.58), 34 + size * 5);
  const riverAt = (x) => {
    const pts = water.pts;
    const i = Math.max(0, Math.min(pts.length - 2, Math.floor((x + 20) / 60)));
    const t = (x + 20) / 60 - i;
    return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
  };

  const mainSide = rng.chance(0.5) ? -1 : 1; // -1 = above the river
  const cx = W / 2 + rng.range(-80, 80);
  const baseR = 80 + size * 40;
  const cy = riverAt(cx) + mainSide * (baseR * 0.7 + water.width);
  const blobA = blobBoundary(rng, cx, cy, baseR, rng.range(1.4, 1.8), rng.range(-0.1, 0.1));
  let boundary = blobA;
  if (size >= 2) {
    const cx2 = cx + rng.range(-60, 60);
    const cy2 = riverAt(cx2) - mainSide * (baseR * 0.4 + water.width);
    boundary = unionBoundary(blobA, blobBoundary(rng, cx2, cy2, baseR * 0.5, 1.3, 0));
  }
  const notInRiver = (x, y) => Math.abs(y - riverAt(x)) > water.width / 2 + 6;
  const finalBoundary = {
    cx, cy,
    contains: (x, y) => boundary.contains(x, y) && notInRiver(x, y),
    polygon: (s) => blobA.polygon(s),
  };

  const roads = [];
  // bridge roads cross the river and leave the map both ways
  const nBridges = 1 + (size >= 2 ? 1 : 0) + (size >= 4 ? 1 : 0);
  for (let i = 0; i < nBridges; i++) {
    const bx = cx + (i - (nBridges - 1) / 2) * rng.range(70, 110) + rng.range(-15, 15);
    roads.push({ pts: throughRoad(rng, bx, riverAt(bx), -Math.PI / 2 + rng.range(-0.15, 0.15)), main: true });
  }
  // bank roads parallel to the river
  for (const side of size >= 2 ? [mainSide, -mainSide] : [mainSide]) {
    const bank = [];
    for (let x = cx - baseR * 1.3; x <= cx + baseR * 1.3; x += 30) {
      bank.push([x, riverAt(x) + side * (water.width / 2 + rng.range(14, 20))]);
    }
    roads.push({ pts: bank, main: side === mainSide });
  }
  roads.push(...sideStreets(rng, roads, finalBoundary, size * 5 + 2));

  const piers = [];
  for (let i = 0, n = Math.min(size + 1, 4); i < n; i++) {
    const x = cx + rng.range(-baseR, baseR);
    const y0 = riverAt(x) + mainSide * (water.width / 2 + 2);
    piers.push({ x0: x, y0, x1: x + rng.range(-6, 6), y1: y0 - mainSide * rng.range(14, 22) });
  }

  const px = cx + rng.range(-40, 40);
  return {
    roads,
    plaza: { x: px, y: riverAt(px) + mainSide * (water.width / 2 + 34), r: 18 + size * 5 },
    boundary: finalBoundary, water, piers,
    // only the main bank is walled — a two-lobed envelope would cut through town —
    // and only the biggest river towns bother with walls at all
    wallFilter: (b) => (b.y - riverAt(b.x)) * mainSide > 0,
    wallScale: size >= 4 ? 0.97 : 0,
    landmarkNames: ['Mill', 'Ferry House', 'Tannery', 'Bridge Tower', 'Fish Market', 'Temple'],
    plazaLabel: size >= 2 ? 'Market' : null,
  };
}

function makeRiver(rng, baseY, width = 42) {
  const pts = [];
  for (let x = -20; x <= W + 20; x += 60) {
    pts.push([x, baseY + Math.sin(x * 0.008 + rng.range(0, 1)) * 30 + rng.range(-8, 8)]);
  }
  return { kind: 'river', pts, width };
}

const LAYOUT_FNS = { organic: layoutOrganic, crossroads: layoutCrossroads, grid: layoutGrid, coastal: layoutCoastal, riverside: layoutRiverside };

// ---------- shared model assembly ----------

/** Re-orient a completed coastal model without touching the generator stream.
 * South is never passed here, so absent seaSide stays on the original path. */
function orientCoastalModel(model, side) {
  if (!['north', 'east', 'west'].includes(side)) return model;
  // East/west use normalized coordinates so the 900×640 model stays inside
  // its canvas after the quarter turn. North is a simple vertical reflection.
  const matrix = side === 'north'
    ? { a: 1, b: 0, c: 0, d: -1, tx: 0, ty: H }
    : side === 'east'
      ? { a: 0, b: -H / W, c: W / H, d: 0, tx: 0, ty: H }
      : { a: 0, b: H / W, c: -W / H, d: 0, tx: W, ty: 0 };
  const point = ([x, y]) => {
    return [matrix.a * x + matrix.c * y + matrix.tx, matrix.b * x + matrix.d * y + matrix.ty];
  };
  const vector = (x, y) => [matrix.a * x + matrix.c * y, matrix.b * x + matrix.d * y];
  const move = (obj) => { [obj.x, obj.y] = point([obj.x, obj.y]); };
  const turn = (obj, resize = false) => {
    const oldAngle = Number(obj.rot) || 0;
    const wx = Math.cos(oldAngle), wy = Math.sin(oldAngle);
    const [tx, ty] = vector(wx, wy);
    if (resize) {
      const [hx, hy] = vector(-wy, wx);
      obj.w *= Math.hypot(tx, ty);
      obj.h *= Math.hypot(hx, hy);
    }
    move(obj);
    obj.rot = Math.atan2(ty, tx);
  };

  for (const road of model.roads || []) road.pts = road.pts.map(point);
  for (const building of model.buildings || []) turn(building, true);
  for (const parcel of model.parcels || []) turn(parcel,true);
  for (const district of model.districts || []) [district.cx,district.cy]=point([district.cx,district.cy]);
  if (model.plaza) move(model.plaza);
  if (model.wall?.poly) model.wall.poly = model.wall.poly.map(point);
  if (model.water?.kind === 'sea') {
    model.water.shore = model.water.shore.map(point);
    model.water.seaSide = side;
  }
  for (const pier of model.piers || []) {
    [pier.x0, pier.y0] = point([pier.x0, pier.y0]);
    [pier.x1, pier.y1] = point([pier.x1, pier.y1]);
  }
  for (const boat of model.boats || []) turn(boat);
  for (const detail of model.details || []) turn(detail);
  for (const bridge of model.bridges || []) turn(bridge);
  model.trees = (model.trees || []).map(([x, y, r]) => [...point([x, y]), r]);
  for (const field of model.fields || []) turn(field, true);
  return model;
}

export function buildTownModel(map) {
  // modern towns (1.9) are a separate era with their own streams; the era is
  // read from the stored params, never from defaults, so no old town changes
  if (map.params?.era === 'modern') return buildModernTown(map);
  const p = { ...defaultTownParams(), ...(map.params || {}) };
  const size = Math.max(1, Math.min(5, p.size));
  p.size = size;
  if (map.params?.generation === '1.8') {
    const layout = LAYOUT_FNS[p.layout] ? p.layout : pickAutoLayout(map.seed + ':v18');
    const L = layout === 'coastal' ? coastalTownLayout(map,p) : LAYOUT_FNS[layout](makeRng(map.seed + ':v18:streets'), p);
    const model = planTown(map,L,p,layout);
    if (p.walls && size>=2 && model.buildings.length>8) {
      const suitable=L.wallFilter?model.buildings.filter(L.wallFilter):model.buildings;
      const poly=buildingEnvelope(suitable,28);
      const wet=(x,y)=>L.water?.kind==='sea'?y>L.water.shoreAt(x)-14:L.water?.kind==='river'?Math.abs(y-riverYAt(L.water,x))<L.water.width/2+14:false;
      model.wall={poly,gate:poly.map(([x,y])=>wet(x,y)||model.roads.some(r=>r.main&&r.pts.some(([rx,ry])=>Math.hypot(rx-x,ry-y)<24)))};
    }
    return layout === 'coastal' ? orientCoastalModel(model,p.seaSide) : model;
  }
  const rng = makeRng(map.seed);
  const layoutName = LAYOUT_FNS[p.layout] ? p.layout : pickAutoLayout(map.seed);
  const L = LAYOUT_FNS[layoutName](rng, p);

  // occupancy grid: roads, water and existing buildings block new buildings
  const CELL = 6;
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const occ = new Uint8Array(gw * gh);
  const mark = (x, y, rad, val) => {
    const c0x = Math.max(0, Math.floor((x - rad) / CELL)), c1x = Math.min(gw - 1, Math.floor((x + rad) / CELL));
    const c0y = Math.max(0, Math.floor((y - rad) / CELL)), c1y = Math.min(gh - 1, Math.floor((y + rad) / CELL));
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) occ[cy * gw + cx] |= val;
  };
  const test = (x, y, rad, maskBits) => {
    const c0x = Math.max(0, Math.floor((x - rad) / CELL)), c1x = Math.min(gw - 1, Math.floor((x + rad) / CELL));
    const c0y = Math.max(0, Math.floor((y - rad) / CELL)), c1y = Math.min(gh - 1, Math.floor((y + rad) / CELL));
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) if (occ[cy * gw + cx] & maskBits) return true;
    return false;
  };

  for (const road of L.roads) {
    for (let i = 1; i < road.pts.length; i++) {
      const [ax, ay] = road.pts[i - 1], [bx, by] = road.pts[i];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / CELL) || 1;
      for (let s = 0; s <= steps; s++) {
        // keep this radius tight: corner lots sit near two streets and a fat
        // road footprint rejects nearly every candidate in a dense network
        mark(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, road.main ? 3 : 2, 1);
      }
    }
  }
  if (L.water?.kind === 'river') {
    for (const [x, y] of L.water.pts) mark(x, y, L.water.width / 2 + 6, 1);
  }
  if (L.water?.kind === 'sea') {
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        if (cy * CELL > L.water.shoreAt(cx * CELL) - 10) occ[cy * gw + cx] |= 1;
      }
    }
  }
  mark(L.plaza.x, L.plaza.y, L.plaza.r + 4, 1);

  // buildings along every road, kept inside the town boundary
  const buildings = [];
  const sampleStep = size >= 4 ? 10 : 12;
  const buildChance = Math.min(0.92, (0.66 + size * 0.05) * p.density);
  for (const road of L.roads) {
    for (let i = 1; i < road.pts.length; i++) {
      const [ax, ay] = road.pts[i - 1], [bx, by] = road.pts[i];
      const segLen = Math.hypot(bx - ax, by - ay);
      if (!segLen) continue;
      const dirX = (bx - ax) / segLen, dirY = (by - ay) / segLen;
      const roadAngle = Math.atan2(dirY, dirX);
      for (let d = 0; d < segLen; d += sampleStep) {
        if (!rng.chance(buildChance)) continue;
        const px = ax + dirX * d, py = ay + dirY * d;
        const side = rng.chance(0.5) ? 1 : -1;
        const w = rng.range(12, 24), h = rng.range(10, 18);
        const off = (road.main ? 12 : 10) + h / 2;
        const bx2 = px + Math.cos(roadAngle + (Math.PI / 2) * side) * off;
        const by2 = py + Math.sin(roadAngle + (Math.PI / 2) * side) * off;
        if (!L.boundary.contains(bx2, by2)) continue;
        if (bx2 < 14 || bx2 > W - 14 || by2 < 14 || by2 > H - 14) continue;
        const rad = Math.min(w, h) / 2;
        if (test(bx2, by2, rad, 1 | 2)) continue;
        mark(bx2, by2, rad + 1, 2);
        buildings.push({ x: bx2, y: by2, w, h, rot: roadAngle, landmark: null });
      }
    }
  }

  // landmarks: promote a few buildings near the plaza
  const names = L.landmarkNames;
  const nLandmarks = Math.min(2 + size, names.length, buildings.length);
  const byDist = buildings
    .map((b, idx) => ({ idx, d: Math.hypot(b.x - L.plaza.x, b.y - L.plaza.y) }))
    .sort((a, b) => a.d - b.d);
  const chosen = [];
  for (const { idx } of byDist) {
    if (chosen.length >= nLandmarks) break;
    if (chosen.some((c) => Math.hypot(buildings[c].x - buildings[idx].x, buildings[c].y - buildings[idx].y) < 70)) continue;
    chosen.push(idx);
  }
  chosen.forEach((idx, i) => {
    buildings[idx].landmark = names[i];
    buildings[idx].w *= 1.5;
    buildings[idx].h *= 1.4;
  });

  // wall hugs what was actually built, with gaps where main roads pass;
  // planned cities keep their surveyed rectangle
  let wall = null;
  const wallBuildings = L.wallFilter ? buildings.filter(L.wallFilter) : buildings;
  if (p.walls && size >= 2 && L.wallScale && wallBuildings.length > 6) {
    const poly = layoutName === 'grid' ? L.boundary.polygon(L.wallScale) : buildingEnvelope(wallBuildings);
    const mains = L.roads.filter((r) => r.main);
    const nearRoad = (x, y) => mains.some((road) => road.pts.some(([rx, ry]) => Math.hypot(rx - x, ry - y) < 22));
    const inWater = (x, y) => (L.water?.kind === 'sea' && y > L.water.shoreAt(x) - 14)
      || (L.water?.kind === 'river' && Math.abs(y - riverYAt(L.water, x)) < L.water.width / 2 + 10);
    wall = { poly, gate: poly.map(([x, y]) => nearRoad(x, y) || inWater(x, y) || x < 8 || x > W - 8 || y < 8 || y > H - 8) };
  }

  // bridges wherever a main road crosses the river
  const bridges = [];
  if (L.water?.kind === 'river') {
    for (const road of L.roads) {
      if (!road.main) continue;
      for (let i = 1; i < road.pts.length; i++) {
        const [x, y] = road.pts[i];
        const ry = riverYAt(L.water, x);
        const [px2, py2] = road.pts[i - 1];
        const crossed = (py2 - riverYAt(L.water, px2)) * (y - ry) <= 0;
        if (crossed && x > 0 && x < W) {
          bridges.push({ x, y: ry, rot: Math.atan2(y - py2, x - px2) });
          break;
        }
      }
    }
  }

  // trees sprinkle the countryside
  const trees = [];
  for (let i = 0; i < 150; i++) {
    const x = rng.range(10, W - 10), y = rng.range(10, H - 10);
    if (L.boundary.contains(x, y)) continue;
    if (L.water?.kind === 'sea' && y > L.water.shoreAt(x) - 12) continue;
    if (L.water?.kind === 'river' && Math.abs(y - riverYAt(L.water, x)) < L.water.width / 2 + 12) continue;
    if (test(x, y, 5, 1 | 2)) continue;
    trees.push([x, y, rng.range(3, 6)]);
  }

  // farmland along the roads out of town. Deliberately a SEPARATE rng stream:
  // the main stream must consume exactly what it always has, or every existing
  // town map would silently reshuffle.
  const decorRng = makeRng(map.seed + ':decor');
  const fields = [];
  const inWater = (x, y) => (L.water?.kind === 'sea' && y > L.water.shoreAt(x) - 14)
    || (L.water?.kind === 'river' && Math.abs(y - riverYAt(L.water, x)) < L.water.width / 2 + 14);
  const maxFields = 5 + size * 2;
  for (const road of L.roads) {
    if (!road.main) continue;
    for (let i = 1; i < road.pts.length - 1 && fields.length < maxFields; i++) {
      const [px, py] = road.pts[i];
      if (L.boundary.contains(px, py) || px < 30 || px > W - 30 || py < 30 || py > H - 30) continue;
      if (!decorRng.chance(0.4)) continue;
      const [qx, qy] = road.pts[i - 1];
      const roadAngle = Math.atan2(py - qy, px - qx);
      const side = decorRng.chance(0.5) ? 1 : -1;
      const fw = decorRng.range(30, 60), fh = decorRng.range(22, 44);
      const off = 12 + fh / 2 + decorRng.range(0, 10);
      const fx = px + Math.cos(roadAngle + side * Math.PI / 2) * off;
      const fy = py + Math.sin(roadAngle + side * Math.PI / 2) * off;
      if (L.boundary.contains(fx, fy) || inWater(fx, fy)) continue;
      if (fx < 36 || fx > W - 36 || fy < 36 || fy > H - 36) continue;
      // buildings only: roads render on top of fields, so brushing a road is fine
      if (test(fx, fy, Math.min(fw, fh) / 2 - 4, 2)) continue;
      if (fields.some((f) => Math.hypot(f.x - fx, f.y - fy) < (Math.max(f.w, f.h) + Math.max(fw, fh)) / 2 + 8)) continue;
      fields.push({ x: fx, y: fy, w: fw, h: fh, rot: roadAngle, kind: decorRng.chance(0.3) ? 'orchard' : 'field' });
    }
  }
  // fields displace the loose trees that landed on them (filter, not re-roll)
  const keptTrees = trees.filter(([x, y]) =>
    !fields.some((f) => Math.abs(x - f.x) < f.w / 2 + 4 && Math.abs(y - f.y) < f.h / 2 + 4));

  const model = {
    p, size, layout: layoutName,
    roads: L.roads, buildings, plaza: L.plaza, plazaLabel: L.plazaLabel,
    wall, water: L.water || null, piers: L.piers || [], boats: L.boats || [], bridges,
    trees: keptTrees, fields,
  };
  // The coastal layout consumes the exact same main-stream draws regardless
  // of orientation. Only the finished geometry moves.
  return layoutName === 'coastal' ? orientCoastalModel(model, p.seaSide) : model;
}

function riverYAt(water, x) {
  const pts = water.pts;
  const i = Math.max(0, Math.min(pts.length - 2, Math.floor((x + 20) / 60)));
  const t = Math.max(0, Math.min(1, (x + 20) / 60 - i));
  return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
}

/** Draw a post-oriented shoreline. The original south-facing draw stays in
 * renderTownBase so maps without seaSide retain its exact canvas operations. */
function drawOrientedSea(ctx, water, th) {
  const shore = water.shore;
  const side = water.seaSide;
  const seaVector = side === 'north' ? [0, -1] : side === 'east' ? [1, 0] : [-1, 0];
  const shifted = ([x, y], distance) => [x + seaVector[0] * distance, y + seaVector[1] * distance];

  // beach strip, ten pixels inland and four pixels into the water
  ctx.beginPath();
  let pt = shifted(shore[0], -10);
  ctx.moveTo(pt[0], pt[1]);
  for (const raw of shore) { pt = shifted(raw, -10); ctx.lineTo(pt[0], pt[1]); }
  for (let i = shore.length - 1; i >= 0; i--) { pt = shifted(shore[i], 4); ctx.lineTo(pt[0], pt[1]); }
  ctx.closePath();
  ctx.fillStyle = th.beach;
  ctx.fill();

  // sea polygon closes against the canvas edge that matches the parent coast
  const corners = side === 'north'
    ? [[W + 20, -20], [-20, -20]]
    : side === 'east'
      ? [[W + 20, -20], [W + 20, H + 20]]
      : [[-20, H + 20], [-20, -20]];
  ctx.beginPath();
  ctx.moveTo(shore[0][0], shore[0][1]);
  for (const [x, y] of shore) ctx.lineTo(x, y);
  for (const [x, y] of corners) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = th.sea;
  ctx.fill();

  ctx.strokeStyle = th.wave;
  ctx.lineWidth = 1.2;
  for (let row = 1; row <= 4; row++) {
    ctx.beginPath();
    for (let i = 0; i < shore.length; i++) {
      const [x, y] = shore[i];
      const distance = row * 22 + Math.sin((side === 'north' ? x : y) * 0.03 + row) * 4;
      const [wx, wy] = shifted([x, y], distance);
      i === 0 ? ctx.moveTo(wx, wy) : ctx.lineTo(wx, wy);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = th.shoreline;
  ctx.lineWidth = 1.6;
  strokePoly(ctx, shore);
}

// ---------- rendering ----------

export function renderTownBase(map, model, scale = 1) {
  const m = model || buildTownModel(map);
  if (m.era === 'modern') return renderModernTown(map, m, scale);
  if (m.generation === '1.8') return renderPlannedTown(map,m,scale,computeWards(m,map.seed),resolveTownTheme(map));
  const { t: th, p: pav } = resolveTownTheme(map);
  const base = document.createElement('canvas');
  base.width = W * scale;
  base.height = H * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale); // all drawing below stays in native coordinates

  // ground wash + texture blotches (same rng consumption for every theme)
  ctx.fillStyle = th.ground;
  ctx.fillRect(0, 0, W, H);
  const rng = makeRng(map.seed + ':texture');
  const [br, bg, bb] = th.blotch;
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${rng.range(0.02, 0.05)})`;
    ctx.beginPath();
    ctx.arc(rng.range(0, W), rng.range(0, H), rng.range(8, 40), 0, TAU);
    ctx.fill();
  }

  // water
  if (m.water?.kind === 'sea') {
    if (m.water.seaSide && m.water.seaSide !== 'south') {
      drawOrientedSea(ctx, m.water, th);
    } else {
      const shore = m.water.shore;
      // beach strip
      ctx.beginPath();
      ctx.moveTo(shore[0][0], shore[0][1] - 10);
      for (const [x, y] of shore) ctx.lineTo(x, y - 10);
      for (let i = shore.length - 1; i >= 0; i--) ctx.lineTo(shore[i][0], shore[i][1] + 4);
      ctx.closePath();
      ctx.fillStyle = th.beach;
      ctx.fill();
      // sea
      ctx.beginPath();
      ctx.moveTo(shore[0][0], shore[0][1]);
      for (const [x, y] of shore) ctx.lineTo(x, y);
      ctx.lineTo(W + 20, H + 20);
      ctx.lineTo(-20, H + 20);
      ctx.closePath();
      ctx.fillStyle = th.sea;
      ctx.fill();
      // wave lines
      ctx.strokeStyle = th.wave;
      ctx.lineWidth = 1.2;
      for (let row = 1; row <= 4; row++) {
        ctx.beginPath();
        for (let i = 0; i < shore.length; i++) {
          const [x, y] = shore[i];
          const yy = y + row * 22 + Math.sin(x * 0.03 + row) * 4;
          i === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      // shoreline
      ctx.strokeStyle = th.shoreline;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < shore.length; i++) {
        const [x, y] = shore[i];
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  if (m.water?.kind === 'river') {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = th.river[0];
    ctx.lineWidth = m.water.width + 8;
    strokePoly(ctx, m.water.pts);
    ctx.strokeStyle = th.river[1];
    ctx.lineWidth = m.water.width;
    strokePoly(ctx, m.water.pts);
  }

  // farm fields & orchards (under roads and trees)
  for (const f of m.fields || []) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    if (f.kind === 'orchard') {
      ctx.fillStyle = th.orchard.fill;
      ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.strokeStyle = th.field.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.fillStyle = th.orchard.dot;
      for (let gx = -f.w / 2 + 6; gx < f.w / 2 - 2; gx += 9) {
        for (let gy = -f.h / 2 + 6; gy < f.h / 2 - 2; gy += 9) {
          ctx.beginPath();
          ctx.arc(gx, gy, 2.4, 0, TAU);
          ctx.fill();
        }
      }
    } else {
      ctx.fillStyle = th.field.fill;
      ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.strokeStyle = th.field.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.strokeStyle = th.field.furrow;
      for (let gy = -f.h / 2 + 4; gy < f.h / 2 - 2; gy += 5) {
        ctx.beginPath();
        ctx.moveTo(-f.w / 2 + 3, gy);
        ctx.lineTo(f.w / 2 - 3, gy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // trees — style + density vary by terrain, via index hash (no rng stream)
  m.trees.forEach(([x, y, r], i) => {
    if (th.tree.density < 1 && ((Math.imul(i + 1, 2654435761) >>> 0) % 100) >= th.tree.density * 100) return;
    ctx.fillStyle = th.tree.fill;
    ctx.strokeStyle = th.tree.stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (th.tree.style === 'pine') {
      ctx.moveTo(x, y - r * 1.7);
      ctx.lineTo(x + r, y + r * 0.9);
      ctx.lineTo(x - r, y + r * 0.9);
      ctx.closePath();
    } else if (th.tree.style === 'scrub') {
      ctx.arc(x, y, r * 0.7, 0, TAU);
    } else {
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();
  });

  // roads: outline pass, fill pass, then stone seams for paved styles
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const road of m.roads) {
    ctx.strokeStyle = pav.outline;
    ctx.lineWidth = road.main ? pav.mainW : pav.sideW;
    strokePoly(ctx, road.pts);
  }
  for (const road of m.roads) {
    ctx.strokeStyle = pav.fill;
    ctx.lineWidth = road.main ? pav.fillMainW : pav.fillSideW;
    strokePoly(ctx, road.pts);
  }
  if (pav.seams) {
    ctx.save();
    ctx.strokeStyle = pav.seams;
    ctx.lineWidth = pav.seamW;
    ctx.setLineDash(pav.seamDash);
    for (const road of m.roads) strokePoly(ctx, road.pts);
    ctx.restore();
  }

  // piers (over water, under buildings)
  for (const pier of m.piers) {
    ctx.strokeStyle = '#6d4c2f';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(pier.x0, pier.y0);
    ctx.lineTo(pier.x1, pier.y1);
    ctx.stroke();
    ctx.strokeStyle = '#8a6a4a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(pier.x0, pier.y0);
    ctx.lineTo(pier.x1, pier.y1);
    ctx.stroke();
  }

  // bridges
  for (const b of m.bridges) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.fillStyle = '#8a6a4a';
    ctx.fillRect(-16, -8, 32, 16);
    ctx.strokeStyle = '#5d452e';
    ctx.lineWidth = 2;
    ctx.strokeRect(-16, -8, 32, 16);
    ctx.restore();
  }

  // boats
  for (const boat of m.boats) {
    ctx.save();
    ctx.translate(boat.x, boat.y);
    ctx.rotate(boat.rot);
    ctx.fillStyle = '#5d452e';
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 3.6, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#3a2a18';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -7);
    ctx.stroke();
    ctx.restore();
  }

  // plaza — paved with the same stone as the streets
  ctx.fillStyle = pav.fill;
  ctx.beginPath();
  ctx.arc(m.plaza.x, m.plaza.y, m.plaza.r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = pav.outline;
  ctx.lineWidth = 2;
  ctx.stroke();

  // buildings
  if (m.generation === '1.8') {
    const inks={market:'#b59a68',craft:'#b59483',residential:'#c8bea4',garden:'#9caf92',harbor:'#9caeb4',citadel:'#ada4ba'};
    for(const lot of m.parcels||[]){ctx.save();ctx.translate(lot.x,lot.y);ctx.rotate(lot.rot);ctx.fillStyle=inks[lot.use];ctx.globalAlpha=.5;ctx.fillRect(-lot.w/2,-lot.h/2,lot.w,lot.h);ctx.restore();}
  }
  for (const b of m.buildings) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.fillStyle = b.landmark ? th.building.landmark : (m.generation==='1.8' ? ({craft:'#a77964',garden:'#a6ad81',harbor:'#9c9690',citadel:'#8b8199',market:'#b29864',residential:'#b6a07e'}[b.use] || th.building.fill) : th.building.fill);
    ctx.strokeStyle = th.building.stroke;
    ctx.lineWidth = 1.4;
    ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.beginPath();
    ctx.moveTo(-b.w / 2 + 2, 0);
    ctx.lineTo(b.w / 2 - 2, 0);
    ctx.strokeStyle = th.building.ridge;
    ctx.stroke();
    ctx.restore();
  }

  // wall with gates and towers, following the town's shape
  if (m.wall) {
    const { poly, gate } = m.wall;
    ctx.strokeStyle = th.wall;
    ctx.lineWidth = 6;
    ctx.lineCap = 'butt';
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      if (gate[i] || gate[j]) continue;
      ctx.beginPath();
      ctx.moveTo(poly[i][0], poly[i][1]);
      ctx.lineTo(poly[j][0], poly[j][1]);
      ctx.stroke();
    }
    for (let i = 0; i < poly.length; i += 6) {
      if (gate[i] || gate[(i + 1) % poly.length] || gate[(i + poly.length - 1) % poly.length]) continue;
      ctx.fillStyle = th.wall;
      ctx.fillRect(poly[i][0] - 5, poly[i][1] - 5, 10, 10);
    }
  }

  // landmark labels
  ctx.font = 'bold 12px Georgia, serif';
  ctx.textAlign = 'center';
  for (const b of m.buildings) {
    if (!b.landmark) continue;
    ctx.fillStyle = th.label;
    ctx.fillText(b.landmark, b.x, b.y - Math.max(b.w, b.h) / 2 - 5);
  }
  if (m.plazaLabel) {
    ctx.fillStyle = th.label;
    ctx.fillText(m.plazaLabel, m.plaza.x, m.plaza.y + 4);
  }

  // wards — opt-in (absent = off), a pure overlay derived from the model
  if (map.params?.wards) {
    const wards = computeWards(m, map.seed);
    wards.forEach((w, i) => {
      const tint = WARD_TINTS[i % WARD_TINTS.length];
      ctx.beginPath();
      ctx.moveTo(w.poly[0][0], w.poly[0][1]);
      for (let j = 1; j < w.poly.length; j++) ctx.lineTo(w.poly[j][0], w.poly[j][1]);
      ctx.closePath();
      ctx.fillStyle = `rgba(${tint}, 0.07)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${tint}, 0.55)`;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = 'italic bold 13px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = th.label;
      ctx.globalAlpha = 0.85;
      // the GM can rename any ward; overrides are data on the map itself
      ctx.fillText((map.wardNames?.[i] || w.name).toUpperCase(), w.cx, w.cy - 2);
      ctx.globalAlpha = 1;
    });
  }

  // border
  ctx.strokeStyle = th.border;
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  return base;
}

function strokePoly(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}
