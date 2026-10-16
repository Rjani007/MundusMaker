// Terrain world style (1.9.1): world maps built the way mapgen4 builds its
// maps (Amit Patel, Red Blob Games, https://www.redblobgames.com/maps/mapgen4/,
// Apache-2.0). This file is an original implementation of the published
// approach; no mapgen4 code is copied.
//
//   1. Blue-noise points (Bridson's Poisson-disc sampling) and their Delaunay
//      triangulation (incremental insertion with Lawson edge flips).
//   2. A coarse "painted" constraint (landform noise, sea level, brush strokes)
//      that decides where land, hills and mountains go. Brush strokes paint
//      this constraint, as mapgen4's brush does, rather than raw height.
//   3. Mountains from jagged distance fields grown outward from peaks: ranges
//      (chains of peaks with spurs, which also lift the land they cross) and
//      massifs (scattered peaks that show only where the Mountains brush made
//      the land rugged); ridged noise sharpens the crests; hills from noise;
//      the constraint decides how much of each. The sea floor shelves off
//      every coast and then drops to open ocean.
//   4. Rainfall carried by the wind across the mesh in upwind-first order,
//      with orographic rain where the land rises and a shadow behind it, plus
//      onshore breezes that wet every coast.
//   5. Rivers on triangles: each triangle drains to the neighbour it was
//      reached from in a priority flood from the sea, and flow accumulates
//      downstream from the rainfall of each triangle's corners. Deep,
//      well-fed basins the flood had to fill become lakes.
//   6. Optional erosion (params.erosion), the two procedural methods of
//      Daniel Andrino's "Terrain Erosion 3 Ways" (MIT): rain-and-sediment
//      droplets plus a talus (thermal) pass on the grid, or river networks
//      grown upstream on the mesh.
//
// The finished terrain is also rasterized onto the 480 x 300 grid every other
// world map uses, so nations, settlements, drill-downs and carves work
// unchanged. Streams: ':m4:points', ':m4:shape', ':m4:peaks', ':m4:hills',
// ':m4:ridges', ':m4:wind', ':m4:erosion'; nothing here reads a legacy, atlas
// or 1.8 stream. Pure: no DOM, so it runs in the generation worker and in
// Node tests.

import { makeRng, makeFbm, clamp } from '../util.js';

export const MESH_W = 960, MESH_H = 600;
export const GRID_W = 480, GRID_H = 300;
const SPACING = 6;            // mean point spacing in map pixels (~11k regions)
export const HEIGHT_SPAN = 0.45; // mesh elevation 1 = this far above sea level on the grid
// a filled basin holds a lake when it is this deep (mesh elevation) and this
// much water (accumulated rainfall, as for rivers) leaves it; at most MAX_LAKES
const LAKE_DEPTH = 0.05, LAKE_FLOW = 24, MAX_LAKES = 6;

// ---------- points ----------

/** Bridson's Poisson-disc sampling in [0,w]x[0,h], deterministic per rng. */
export function poissonPoints(rng, w, h, r, k = 24) {
  const cell = r / Math.SQRT2, cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const grid = new Int32Array(cols * rows).fill(-1);
  const pts = [], active = [];
  const add = (x, y) => {
    const i = pts.length / 2; pts.push(x, y); active.push(i);
    grid[Math.floor(y / cell) * cols + Math.floor(x / cell)] = i;
  };
  add(rng.range(w * 0.4, w * 0.6), rng.range(h * 0.4, h * 0.6));
  while (active.length) {
    const ai = Math.floor(rng() * active.length), i = active[ai];
    const px = pts[i * 2], py = pts[i * 2 + 1];
    let placed = false;
    for (let t = 0; t < k; t++) {
      const a = rng() * Math.PI * 2, d = r * (1 + rng());
      const x = px + Math.cos(a) * d, y = py + Math.sin(a) * d;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      let ok = true;
      for (let yy = Math.max(0, gy - 2); ok && yy <= Math.min(rows - 1, gy + 2); yy++) {
        for (let xx = Math.max(0, gx - 2); xx <= Math.min(cols - 1, gx + 2); xx++) {
          const j = grid[yy * cols + xx];
          if (j >= 0 && (pts[j * 2] - x) ** 2 + (pts[j * 2 + 1] - y) ** 2 < r * r) { ok = false; break; }
        }
      }
      if (ok) { add(x, y); placed = true; break; }
    }
    if (!placed) { active[ai] = active[active.length - 1]; active.pop(); }
  }
  return pts;
}

// ---------- Delaunay triangulation ----------
// Half-edge arrays: triangle t owns half-edges 3t, 3t+1, 3t+2; half-edge e runs
// from vertex tri[e] to tri[next(e)], and opp[e] is its twin (-1 on the hull).
// Every triangle is kept with a positive orient().

const next = (e) => (e % 3 === 2 ? e - 2 : e + 1);
const prev = (e) => (e % 3 === 0 ? e + 2 : e - 1);

export function delaunay(coords) {
  const n = coords.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, coords[i * 2]); maxX = Math.max(maxX, coords[i * 2]);
    minY = Math.min(minY, coords[i * 2 + 1]); maxY = Math.max(maxY, coords[i * 2 + 1]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, span = Math.max(maxX - minX, maxY - minY, 1) * 40;
  const X = new Float64Array(n + 3), Y = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) { X[i] = coords[i * 2]; Y[i] = coords[i * 2 + 1]; }
  // a super-triangle far outside everything; removed at the end
  X[n] = cx - span; Y[n] = cy - span; X[n + 1] = cx + span; Y[n + 1] = cy - span; X[n + 2] = cx; Y[n + 2] = cy + span;
  const orient = (a, b, c) => (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
  const inCircle = (a, b, c, p) => {
    const dx = X[a] - X[p], dy = Y[a] - Y[p], ex = X[b] - X[p], ey = Y[b] - Y[p], fx = X[c] - X[p], fy = Y[c] - Y[p];
    const ap = dx * dx + dy * dy, bp = ex * ex + ey * ey, cp = fx * fx + fy * fy;
    return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) > 0;
  };
  const cap = 3 * (2 * (n + 3));
  const tri = new Int32Array(cap), opp = new Int32Array(cap).fill(-1);
  let count = 0; // triangles
  const link = (a, b) => { opp[a] = b; if (b >= 0) opp[b] = a; };
  const addTri = (a, b, c) => { const t = count++; tri[t * 3] = a; tri[t * 3 + 1] = b; tri[t * 3 + 2] = c; return t; };
  if (orient(n, n + 1, n + 2) > 0) addTri(n, n + 1, n + 2); else addTri(n, n + 2, n + 1);

  const stack = [];
  const legalize = (start) => {
    stack.push(start);
    while (stack.length) {
      const e = stack.pop(), b = opp[e];
      if (b < 0) continue;
      const en = next(e), ep = prev(e), bn = next(b), bp = prev(b);
      const u = tri[e], v = tri[en], p = tri[ep], q = tri[bp];
      if (!inCircle(u, v, p, q)) continue;
      // flip edge u-v to p-q: (u,v,p)+(v,u,q) -> (q,v,p)+(p,u,q)
      const hbp = opp[bp], hep = opp[ep];
      tri[e] = q; tri[b] = p;
      link(e, hbp); link(b, hep); link(ep, bp);
      stack.push(e, bn);
    }
  };

  let last = 0;
  for (let i = 0; i < n; i++) {
    // visibility walk from the last triangle; a rotating start edge keeps it
    // from cycling, and a scan is the fallback
    let t = last, steps = 0, found = -1;
    walk: while (steps++ < count + 10) {
      for (let k = 0; k < 3; k++) {
        const e = t * 3 + ((k + steps) % 3);
        if (orient(tri[e], tri[next(e)], i) < 0) {
          if (opp[e] < 0) break walk;
          t = Math.floor(opp[e] / 3);
          continue walk;
        }
      }
      found = t; break;
    }
    if (found < 0) {
      for (let s = 0; s < count; s++) {
        const a = tri[s * 3], b = tri[s * 3 + 1], c = tri[s * 3 + 2];
        if (orient(a, b, i) >= 0 && orient(b, c, i) >= 0 && orient(c, a, i) >= 0) { found = s; break; }
      }
      if (found < 0) continue; // a duplicate point; skip it
    }
    t = found;
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    const oAB = opp[t * 3], oBC = opp[t * 3 + 1], oCA = opp[t * 3 + 2];
    // (a,b,i) reuses t; (b,c,i) and (c,a,i) are new
    tri[t * 3 + 2] = i; tri[t * 3 + 1] = b; tri[t * 3] = a;
    const t1 = addTri(b, c, i), t2 = addTri(c, a, i);
    const e0 = t * 3, f0 = t1 * 3, g0 = t2 * 3;
    // t: a->b, b->i, i->a   t1: b->c, c->i, i->b   t2: c->a, a->i, i->c
    tri[e0 + 1] = b; tri[e0 + 2] = i;
    link(e0, oAB); link(f0, oBC); link(g0, oCA);
    link(e0 + 1, f0 + 2); link(f0 + 1, g0 + 2); link(g0 + 1, e0 + 2);
    legalize(e0); legalize(f0); legalize(g0);
    last = t;
  }

  // drop the super-triangle's triangles and remap twins
  const keep = new Int32Array(count).fill(-1);
  let kept = 0;
  for (let t = 0; t < count; t++) if (tri[t * 3] < n && tri[t * 3 + 1] < n && tri[t * 3 + 2] < n) keep[t] = kept++;
  const triangles = new Int32Array(kept * 3), halfedges = new Int32Array(kept * 3).fill(-1);
  for (let t = 0; t < count; t++) {
    const nt = keep[t]; if (nt < 0) continue;
    for (let k = 0; k < 3; k++) {
      const e = t * 3 + k, o = opp[e];
      triangles[nt * 3 + k] = tri[e];
      if (o >= 0 && keep[Math.floor(o / 3)] >= 0) halfedges[nt * 3 + k] = keep[Math.floor(o / 3)] * 3 + (o % 3);
    }
  }
  return { triangles, halfedges };
}

// ---------- mesh ----------

/** Points (interior blue noise, the map border and a ring outside it) and
 *  their dual mesh: regions are points, triangles carry centroids. */
function makeMesh(seed, w, h, spacing) {
  const rng = makeRng(`${seed}:m4:points`);
  const inner = poissonPoints(rng, w, h, spacing);
  const coords = [];
  // border and exterior rings keep the hull triangles off the visible map
  for (const off of [0, -spacing * 1.5]) {
    const step = spacing * (off ? 1.5 : 1);
    for (let x = off; x <= w - off + 0.01; x += step) coords.push(x + rng.range(-0.3, 0.3), off + rng.range(-0.3, 0.3), x + rng.range(-0.3, 0.3), h - off + rng.range(-0.3, 0.3));
    for (let y = off + step; y < h - off - step / 2; y += step) coords.push(off + rng.range(-0.3, 0.3), y + rng.range(-0.3, 0.3), w - off + rng.range(-0.3, 0.3), y + rng.range(-0.3, 0.3));
  }
  // the interior samples keep clear of the border ring
  for (let i = 0; i < inner.length; i += 2) {
    const x = inner[i], y = inner[i + 1];
    if (x > spacing * 0.6 && y > spacing * 0.6 && x < w - spacing * 0.6 && y < h - spacing * 0.6) coords.push(x, y);
  }
  const points = Float64Array.from(coords);
  const { triangles, halfedges } = delaunay(points);
  const numRegions = points.length / 2, numTriangles = triangles.length / 3;
  const centroids = new Float32Array(numTriangles * 2);
  for (let t = 0; t < numTriangles; t++) {
    const a = triangles[t * 3], b = triangles[t * 3 + 1], c = triangles[t * 3 + 2];
    centroids[t * 2] = (points[a * 2] + points[b * 2] + points[c * 2]) / 3;
    centroids[t * 2 + 1] = (points[a * 2 + 1] + points[b * 2 + 1] + points[c * 2 + 1]) / 3;
  }
  // region adjacency (CSR); hull edges add both directions themselves
  const deg = new Int32Array(numRegions + 1);
  for (let e = 0; e < triangles.length; e++) {
    deg[triangles[e]]++;
    if (halfedges[e] < 0) deg[triangles[next(e)]]++;
  }
  const start = new Int32Array(numRegions + 1);
  for (let r = 0; r < numRegions; r++) start[r + 1] = start[r] + deg[r];
  const fill = start.slice(0, numRegions), adj = new Int32Array(start[numRegions]), adjFrom = new Int32Array(start[numRegions]);
  for (let e = 0; e < triangles.length; e++) {
    const a = triangles[e], b = triangles[next(e)];
    adjFrom[fill[a]] = a; adj[fill[a]++] = b;
    if (halfedges[e] < 0) { adjFrom[fill[b]] = b; adj[fill[b]++] = a; }
  }
  return { points, triangles, halfedges, centroids, numRegions, numTriangles, adjStart: start, adj, adjFrom, w, h };
}

// The mesh depends only on the seed and the parts below only on seed and
// shape settings, so the rebuild after each brush stroke reuses them. Nothing
// writes into a cached object; the constraint, which strokes paint, is handed
// out as a copy.
const cache = new Map();
function cached(key, make) {
  if (cache.has(key)) return cache.get(key);
  const value = make();
  cache.set(key, value);
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return value;
}

export function buildMesh(seed, w = MESH_W, h = MESH_H, spacing = SPACING) {
  return cached(`mesh|${seed}|${w}|${h}|${spacing}`, () => makeMesh(seed, w, h, spacing));
}

// ---------- elevation ----------

const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** The painted constraint for one point, in [-1, 1]: > 0 is land, and the
 *  higher it is the more the mountains take over from the hills. */
function constraintField(seed, p) {
  const shape = makeFbm(`${seed}:m4:shape`, 6), warp = makeFbm(`${seed}:m4:shape:warp`, 3);
  const zoom = clamp(Number(p.scale) || 3, 1.5, 6) / 3;
  const landform = p.landform || 'continents';
  const water = clamp(Number(p.water ?? 0.5), 0.2, 0.8);
  const island = p.island !== false;
  return (x, y) => {
    const u = x / MESH_W, v = y / MESH_H, aspect = MESH_W / MESH_H;
    const wu = u + (warp(u * 3 * aspect, v * 3) - 0.5) * 0.25, wv = v + (warp(u * 3 * aspect + 31, v * 3 + 31) - 0.5) * 0.25;
    const broad = shape(wu * 2.2 * zoom * aspect, wv * 2.2 * zoom) - 0.5;
    const fine = shape(wu * 7 * zoom * aspect + 50, wv * 7 * zoom + 50) - 0.5;
    // the falloff toward the frame wanders, so edge coasts never run straight
    const edge = Math.max(0, 0.16 + (warp(u * 9 + 3, v * 9 + 3) - 0.5) * 0.16 - Math.min(u, v, 1 - u, 1 - v)) / 0.16;
    const d = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2) / Math.SQRT2;
    let c;
    if (landform === 'archipelago') {
      const isles = shape(wu * 5.5 * zoom * aspect + 9, wv * 5.5 * zoom + 9) - 0.5;
      c = isles * 3.4 + broad * 1.2 + fine * 0.5 - 0.18;
    } else if (landform === 'inlandsea') {
      const sea = Math.exp(-((wu - 0.5) ** 2 / 0.05 + (wv - 0.52) ** 2 / 0.035));
      c = 0.45 + broad * 2 + fine * 0.6 - sea * 1.3;
    } else if (landform === 'highlands') {
      c = 0.6 + broad * 2.2 + fine * 0.7;
    } else {
      c = 0.3 + broad * 3 + fine * 0.7 - (island ? d * d * 1.1 : 0);
    }
    // the sea level moves the coast in full, but high ground only partly, so
    // a low sea gives more land rather than turning the uplands to peaks
    c -= (water - 0.5) * 2.6 * (1 - 0.7 * smoothstep(0.1, 0.9, c));
    if (island || landform !== 'highlands') c -= edge * edge * 1.6;
    return clamp(c, -1, 1);
  };
}

/** The triangle whose centroid is nearest (x, y), from a bucket grid. */
function triangleLocator(mesh) {
  const { numTriangles, centroids } = mesh, cell = 12;
  const cols = Math.ceil(mesh.w / cell) + 1, rows = Math.ceil(mesh.h / cell) + 1;
  const start = new Int32Array(cols * rows + 1), at = new Int32Array(numTriangles);
  const bucket = (t) => clamp(Math.floor(centroids[t * 2 + 1] / cell), 0, rows - 1) * cols + clamp(Math.floor(centroids[t * 2] / cell), 0, cols - 1);
  for (let t = 0; t < numTriangles; t++) start[bucket(t) + 1]++;
  for (let i = 0; i < cols * rows; i++) start[i + 1] += start[i];
  const fill = start.slice(0, cols * rows);
  for (let t = 0; t < numTriangles; t++) at[fill[bucket(t)]++] = t;
  return (x, y) => {
    const gx = clamp(Math.floor(x / cell), 0, cols - 1), gy = clamp(Math.floor(y / cell), 0, rows - 1);
    let best = -1, bd = Infinity;
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(rows - 1, gy + 1); yy++) for (let xx = Math.max(0, gx - 1); xx <= Math.min(cols - 1, gx + 1); xx++) {
      const b = yy * cols + xx;
      for (let k = start[b]; k < start[b + 1]; k++) {
        const t = at[k], d = (centroids[t * 2] - x) ** 2 + (centroids[t * 2 + 1] - y) ** 2;
        if (d < bd) { bd = d; best = t; }
      }
    }
    return best;
  };
}

/** Mountains, in two fields. Ranges: chains of peaks that wander across the
 *  map and throw off spurs. Massifs: peaks scattered everywhere, which only
 *  show where the land is painted (or happens to be) very high, so the
 *  Mountains brush finds peaks wherever it goes. In each field the distance
 *  from the nearest peak is walked across the triangle graph with a random
 *  step length, so slopes come out jagged (mapgen4's FIFO walk), and every
 *  triangle inherits the height of the peak that reached it. */
function mountainFields(mesh, seed, ruggedness) {
  const rng = makeRng(`${seed}:m4:peaks`);
  const { numTriangles, halfedges } = mesh;
  const locate = triangleLocator(mesh);
  const jag = 0.3 + ruggedness * 0.6;
  const field = () => ({ dist: new Float32Array(numTriangles).fill(999), peakH: new Float32Array(numTriangles), seen: new Uint8Array(numTriangles), queue: new Int32Array(numTriangles), tail: 0 });
  const peak = (f, x, y, h) => {
    if (x < 0 || y < 0 || x > mesh.w || y > mesh.h) return;
    const t = locate(x, y);
    if (t < 0 || f.seen[t]) return;
    f.seen[t] = 1; f.dist[t] = 0; f.peakH[t] = h; f.queue[f.tail++] = t;
  };
  const spread = (f) => {
    for (let head = 0; head < f.tail; head++) {
      const t = f.queue[head];
      for (let k = 0; k < 3; k++) {
        const o = halfedges[t * 3 + k]; if (o < 0) continue;
        const u = Math.floor(o / 3);
        if (f.seen[u]) continue;
        f.seen[u] = 1;
        f.dist[u] = f.dist[t] + SPACING * Math.max(0.05, 1 + jag * (rng() - rng()));
        f.peakH[u] = f.peakH[t];
        f.queue[f.tail++] = u;
      }
    }
    return { dist: f.dist, peakH: f.peakH };
  };
  const ranges = field(), massifs = field();
  // a chain is highest along its middle and falls away toward both ends
  const walk = (x, y, heading, length, top, spurs) => {
    const steps = Math.max(2, Math.round(length / (SPACING * 2.2)));
    for (let s = 0; s <= steps; s++) {
      const along = s / steps, h = top * (0.55 + 0.45 * Math.sin(Math.PI * along)) * rng.range(0.82, 1);
      peak(ranges, x + rng.range(-3, 3), y + rng.range(-3, 3), h);
      if (spurs && s > 0 && s < steps && rng.chance(0.16 + 0.12 * ruggedness)) {
        walk(x, y, heading + (rng.chance(0.5) ? 1 : -1) * rng.range(0.7, 1.3), rng.range(30, 90), h * 0.8, false);
      }
      heading += rng.range(-0.3, 0.3);
      x += Math.cos(heading) * SPACING * 2.2; y += Math.sin(heading) * SPACING * 2.2;
    }
  };
  const chains = Math.round(4 + 9 * ruggedness);
  for (let k = 0; k < chains; k++) {
    walk(rng.range(0, mesh.w), rng.range(0, mesh.h), rng.range(0, Math.PI * 2), rng.range(140, 260 + 220 * ruggedness), rng.range(0.8, 1), true);
  }
  const scattered = Math.round(numTriangles / 90);
  for (let k = 0; k < scattered; k++) peak(massifs, rng.range(0, mesh.w), rng.range(0, mesh.h), rng.range(0.55, 0.95));
  return { ranges: spread(ranges), massifs: spread(massifs) };
}

/** Per-triangle building blocks that never change after generation. */
function terrainParts(mesh, seed, p) {
  const ruggedness = clamp(Number(p.ruggedness ?? 0.7), 0.1, 1);
  const key = ['parts', seed, ruggedness, p.scale, p.landform, p.water, p.island].join('|');
  const parts = cached(key, () => {
    const { numTriangles, centroids } = mesh;
    const { ranges, massifs } = mountainFields(mesh, seed, ruggedness);
    const hills = makeFbm(`${seed}:m4:hills`, 5), ridges = makeFbm(`${seed}:m4:ridges`, 4);
    const field = constraintField(seed, p);
    const constraint = new Float32Array(numTriangles), hill = new Float32Array(numTriangles), mount = new Float32Array(numTriangles), massif = new Float32Array(numTriangles), sea = new Float32Array(numTriangles);
    const reach = 46 + (1 - ruggedness) * 34;
    for (let t = 0; t < numTriangles; t++) {
      const x = centroids[t * 2], y = centroids[t * 2 + 1];
      const n1 = hills(x / 90, y / 90), n2 = hills(x / 28 + 70, y / 28 + 70);
      hill[t] = Math.max(0.01, (0.55 + (n1 - 0.5) * 1.1 + (n2 - 0.5) * 0.5) * 0.24);
      // crests: ridged noise sharpens the slopes into spines and gullies
      const r = 1 - Math.abs(ridges(x / 34, y / 34) * 2 - 1), crest = 0.74 + 0.26 * r * r;
      const slope = Math.max(0, 1 - ranges.dist[t] / reach);
      mount[t] = Math.max(0.01, ranges.peakH[t] * slope * crest);
      massif[t] = Math.max(0.01, massifs.peakH[t] * Math.max(0, 1 - massifs.dist[t] / (reach * 1.6)) * crest);
      sea[t] = 0.5 + n1 * 0.7;
      // ranges lift the land they cross, so they stand out as mountains (and
      // may run out to sea as capes) instead of fading into the hills
      const c = field(x, y), lift = 0.55 * ranges.peakH[t] * smoothstep(0, 1, 1 - ranges.dist[t] / (reach * 1.15));
      constraint[t] = c > -0.2 ? clamp(c + lift, -1, 1) : c;
    }
    return { constraint, hill, mount, massif, sea };
  });
  // strokes paint copies: the constraint, and how rugged (peaked) the land is
  return { ...parts, constraint: parts.constraint.slice(), rugged: new Float32Array(parts.constraint.length) };
}

/** The terrain style's own brushes, as in mapgen4: each paints the constraint
 *  toward a kind of ground (mountains take over above about 0.65, land is
 *  above 0), so going over the same place again settles instead of piling up.
 *  `sign` is the direction a raise/lower brush would take there. */
export const TERRAIN_BRUSHES = [
  { t: 'mountain', target: 0.95, sign: 1, label: '🏔 Mountains', title: 'Brush: paint a mountain range' },
  { t: 'hills', target: 0.38, sign: 1, label: '🌄 Hills', title: 'Brush: paint hill country' },
  { t: 'lowland', target: 0.07, sign: -1, label: '🌾 Lowland', title: 'Brush: paint low plains and valleys' },
  { t: 'sea', target: -0.45, sign: -1, label: '🌊 Sea', title: 'Brush: paint open sea' },
];
const BRUSH_TARGET = Object.fromEntries(TERRAIN_BRUSHES.map((b) => [b.t, b.target]));

/** A brush stroke paints the constraint (normalized x, y, r; signed d; and
 *  for the target brushes, t). It also paints how rugged the land is: the
 *  Mountains brush (and Raise) brings up scattered peaks wherever it goes,
 *  and the other brushes (and Lower) wear them away again. */
function paintConstraint(mesh, parts, s) {
  const { constraint, rugged } = parts;
  const { numTriangles, centroids } = mesh;
  const cx = s.x * MESH_W, cy = s.y * MESH_H, r = s.r * MESH_W;
  if (!(r > 0)) return;
  const target = BRUSH_TARGET[s.t];
  // the default strength (0.09) moves the middle of a dab about 45% of the way
  const rate = clamp(Math.abs(s.d) * 5, 0, 1);
  for (let t = 0; t < numTriangles; t++) {
    const dx = centroids[t * 2] - cx, dy = centroids[t * 2 + 1] - cy;
    if (Math.abs(dx) > r || Math.abs(dy) > r) continue;
    const k = 1 - Math.hypot(dx, dy) / r;
    if (k <= 0) continue;
    if (target !== undefined) {
      constraint[t] += (target - constraint[t]) * rate * k * k;
      rugged[t] += ((s.t === 'mountain' ? 1 : 0) - rugged[t]) * rate * k * k;
    } else {
      // twice the height-brush rate: one pass of the default brush lifts shallow
      // sea to land, as the other styles' brushes do
      constraint[t] = clamp(constraint[t] + (s.d * 2 / HEIGHT_SPAN) * k * k, -1, 1);
      rugged[t] = clamp(rugged[t] + s.d * 3 * k * k, 0, 1);
    }
  }
}

/** Hills where the constraint is low, ranges where it is high, scattered
 *  peaks where the land was painted rugged, sea below 0. High ground that was
 *  not painted stays an upland of hills cut by its ranges. */
function triangleElevation(parts) {
  const { constraint, rugged, hill, mount, massif, sea } = parts, n = constraint.length;
  const e = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const c = constraint[t];
    if (c > 0) {
      // valleys between ridges never sink below the surrounding hills
      const w = smoothstep(0.08, 0.65, c), hp = hill[t] * (0.4 + c), lift = 0.3 + 0.7 * c;
      const mp = Math.max(mount[t], massif[t] * rugged[t] * smoothstep(0.45, 0.8, c)) * lift;
      e[t] = (1 - w) * hp + w * Math.max(mp, hp) + 0.004;
    } else e[t] = c * sea[t];
  }
  return e;
}

/** The sea floor: depth follows the distance from the nearest land, a shallow
 *  shelf along every coast and then the drop to open ocean, so shoals hug the
 *  shore instead of floating in mid-ocean. A quarter of the painted depth is
 *  kept, so the Sea brush still deepens water and seas differ. Distances are
 *  walked across the triangle graph; land is never touched. */
function shapeSeaFloor(mesh, e, sea) {
  const { numTriangles, halfedges, centroids } = mesh;
  const dist = new Float32Array(numTriangles).fill(Infinity), queue = new Int32Array(numTriangles);
  let tail = 0;
  for (let t = 0; t < numTriangles; t++) if (e[t] >= 0) { dist[t] = 0; queue[tail++] = t; }
  for (let head = 0; head < tail; head++) {
    const t = queue[head];
    for (let k = 0; k < 3; k++) {
      const o = halfedges[t * 3 + k]; if (o < 0) continue;
      const u = (o / 3) | 0;
      if (e[u] >= 0 || dist[u] !== Infinity) continue;
      dist[u] = dist[t] + Math.hypot(centroids[u * 2] - centroids[t * 2], centroids[u * 2 + 1] - centroids[t * 2 + 1]);
      queue[tail++] = u;
    }
  }
  for (let t = 0; t < numTriangles; t++) {
    if (e[t] >= 0) continue;
    const d = Math.min(dist[t], 400), vary = 0.75 + 0.5 * clamp((sea[t] - 0.5) / 0.7, 0, 1);
    const profile = 0.02 + 0.1 * smoothstep(0, 26, d) + 0.7 * smoothstep(26, 140, d);
    e[t] = -Math.max(0.004, 0.75 * profile * vary - 0.25 * e[t]);
  }
  return e;
}

function regionValues(mesh, triValue) {
  const { numRegions, triangles } = mesh;
  const sum = new Float32Array(numRegions), count = new Uint16Array(numRegions);
  for (let e = 0; e < triangles.length; e++) { sum[triangles[e]] += triValue[(e / 3) | 0]; count[triangles[e]]++; }
  for (let r = 0; r < numRegions; r++) sum[r] = count[r] ? sum[r] / count[r] : 0;
  return sum;
}

// ---------- rainfall ----------

/** Regions sorted upwind first, for the wind's direction vector. */
function windOrder(mesh, angle) {
  const { numRegions, points } = mesh, wx = Math.cos(angle), wy = Math.sin(angle);
  const key = new Float32Array(numRegions);
  for (let r = 0; r < numRegions; r++) key[r] = points[r * 2] * wx + points[r * 2 + 1] * wy;
  const order = Int32Array.from({ length: numRegions }, (_, i) => i).sort((a, b) => key[a] - key[b] || a - b);
  const rank = new Int32Array(numRegions);
  order.forEach((r, i) => { rank[r] = i; });
  return { order, rank };
}

/** How far inland each region lies: distance in map pixels from the nearest
 *  sea region, walked across the region graph. */
function inlandDistance(mesh, elevation) {
  const { numRegions, adjStart, adj, points } = mesh;
  const dist = new Float32Array(numRegions).fill(Infinity), queue = new Int32Array(numRegions);
  let tail = 0;
  for (let r = 0; r < numRegions; r++) if (elevation[r] < 0) { dist[r] = 0; queue[tail++] = r; }
  for (let head = 0; head < tail; head++) {
    const r = queue[head];
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) {
      const q = adj[k];
      if (dist[q] !== Infinity) continue;
      dist[q] = dist[r] + Math.hypot(points[q * 2] - points[r * 2], points[q * 2 + 1] - points[r * 2 + 1]);
      queue[tail++] = q;
    }
  }
  return dist;
}

/** Humid air from the sea moves downwind; rising land wrings rain out of it.
 *  Every coast also gets the moisture of onshore breezes, so the far side of a
 *  continent is not all desert: dry country lies inland and behind ranges. */
function rainfall(mesh, elevation, wind, rain) {
  const { numRegions, adjStart, adj } = mesh, { order, rank } = wind;
  const humidity = new Float32Array(numRegions), moisture = new Float32Array(numRegions);
  const inland = inlandDistance(mesh, elevation);
  // drier worlds lose their humidity sooner inland and rain less overall
  const decay = 0.003 + 0.01 * Math.pow(1 - rain, 1.5), wetness = 0.6 + 0.8 * rain;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    let sum = 0, cnt = 0;
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) { const q = adj[k]; if (rank[q] < rank[r]) { sum += humidity[q]; cnt++; } }
    let h = cnt ? sum / cnt : 0.85;
    const e = elevation[r];
    if (e < 0) { humidity[r] = Math.min(1, h + 0.15); moisture[r] = 1; continue; }
    // rising air holds less: whatever it can't carry falls on the windward slope
    let oro = 0;
    const room = 1 - e * 1.1;
    if (h > room) { oro = (h - room) * 0.6; h -= oro; }
    const breeze = 0.2 * Math.exp(-inland[r] / 45);
    moisture[r] = clamp((h * 0.75 + oro * 3 + breeze) * wetness, 0, 1);
    humidity[r] = Math.max(0, h - decay);
  }
  // soften the per-region speckle without moving the climate
  const out = new Float32Array(numRegions);
  for (let r = 0; r < numRegions; r++) {
    let s = moisture[r] * 2, c = 2;
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) { s += moisture[adj[k]]; c++; }
    out[r] = s / c;
  }
  return out;
}

// ---------- rivers ----------

/** A binary min-heap on typed arrays, ties broken by id, so the pop order is
 *  a pure function of what was pushed. pop() leaves the popped key in .key. */
function makeHeap(capacity) {
  let ids = new Int32Array(Math.max(16, capacity)), keys = new Float64Array(ids.length), n = 0;
  const less = (i, j) => keys[i] < keys[j] || (keys[i] === keys[j] && ids[i] < ids[j]);
  const swap = (i, j) => { const a = ids[i]; ids[i] = ids[j]; ids[j] = a; const b = keys[i]; keys[i] = keys[j]; keys[j] = b; };
  return {
    key: 0,
    get length() { return n; },
    push(id, key) {
      if (n === ids.length) { const i2 = new Int32Array(n * 2), k2 = new Float64Array(n * 2); i2.set(ids); k2.set(keys); ids = i2; keys = k2; }
      let i = n++; ids[i] = id; keys[i] = key;
      while (i) { const q = (i - 1) >> 1; if (!less(i, q)) break; swap(i, q); i = q; }
    },
    pop() {
      const id = ids[0]; this.key = keys[0];
      n--; ids[0] = ids[n]; keys[0] = keys[n];
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < n && less(l, m)) m = l;
        if (r < n && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
      return id;
    },
  };
}

/** Priority flood over triangles from the sea (and the map's hull); every
 *  land triangle drains into the neighbour that reached it, so pits fill and
 *  water always finds its way out. Flow accumulates in reverse visit order. */
function drainTriangles(mesh, elevation, regionMoisture) {
  const { numTriangles, halfedges, triangles } = mesh;
  const down = new Int32Array(numTriangles).fill(-1), seen = new Uint8Array(numTriangles);
  const order = new Int32Array(numTriangles), queue = makeHeap(numTriangles);
  // the level water must rise to at each triangle before it can drain away
  const level = new Float32Array(numTriangles);
  let visited = 0;
  for (let t = 0; t < numTriangles; t++) {
    const hull = halfedges[t * 3] < 0 || halfedges[t * 3 + 1] < 0 || halfedges[t * 3 + 2] < 0;
    if (elevation[t] < 0 || hull) { seen[t] = 1; queue.push(t, elevation[t]); }
  }
  while (queue.length) {
    const t = queue.pop(), cost = queue.key;
    level[t] = cost;
    order[visited++] = t;
    for (let k = 0; k < 3; k++) {
      const o = halfedges[t * 3 + k]; if (o < 0) continue;
      const u = (o / 3) | 0; if (seen[u]) continue;
      seen[u] = 1; down[u] = t;
      queue.push(u, Math.max(elevation[u], cost + 1e-6));
    }
  }
  const flow = new Float32Array(numTriangles);
  for (let t = 0; t < numTriangles; t++) {
    if (elevation[t] < 0) continue;
    const a = triangles[t * 3], b = triangles[t * 3 + 1], c = triangles[t * 3 + 2];
    flow[t] = (regionMoisture[a] + regionMoisture[b] + regionMoisture[c]) / 3;
  }
  for (let k = visited - 1; k >= 0; k--) {
    const t = order[k];
    if (elevation[t] >= 0 && down[t] >= 0) flow[down[t]] += flow[t];
  }
  return { down, flow, level };
}

/** Lakes: basins the priority flood had to fill. A connected patch of land
 *  triangles lying below the level their water spills at holds a lake when it
 *  is deep enough to notice, no bigger than a large lake, and fed by enough
 *  water to keep it full (the flow leaving it; dry basins stay dry). Only the
 *  best-fed few are kept, so lakes stay landmarks rather than a rash. */
function findLakes(mesh, elevation, level, flow, minDepth, minFlow) {
  const { numTriangles, halfedges } = mesh;
  const lake = new Uint8Array(numTriangles), seen = new Uint8Array(numTriangles);
  const filled = (t) => elevation[t] >= 0 && level[t] - elevation[t] > 0.002;
  const maxSize = numTriangles * 0.01, found = [];
  for (let t0 = 0; t0 < numTriangles; t0++) {
    if (seen[t0] || !filled(t0)) continue;
    const group = [t0];
    let deepest = 0, inflow = 0;
    seen[t0] = 1;
    for (let i = 0; i < group.length; i++) {
      const t = group[i];
      deepest = Math.max(deepest, level[t] - elevation[t]);
      inflow = Math.max(inflow, flow[t]);
      for (let k = 0; k < 3; k++) {
        const o = halfedges[t * 3 + k]; if (o < 0) continue;
        const u = (o / 3) | 0;
        if (!seen[u] && filled(u)) { seen[u] = 1; group.push(u); }
      }
    }
    if (deepest >= minDepth && inflow >= minFlow && group.length >= 14 && group.length <= maxSize) found.push({ group, score: inflow * deepest, first: t0 });
  }
  found.sort((a, b) => b.score - a.score || a.first - b.first);
  for (const { group } of found.slice(0, MAX_LAKES)) for (const t of group) lake[t] = 1;
  return lake;
}

/** River polylines in map pixels over a downstream forest of `n` nodes at
 *  `pos`: from each source down to the sea or to the river it joins. `flows`
 *  holds the accumulated flow at each point, `nodes` the node indices. */
function traceRivers(n, pos, onLand, down, flow, threshold) {
  const isRiver = (t) => t >= 0 && onLand(t) && flow[t] >= threshold;
  const fed = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (isRiver(t) && down[t] >= 0) fed[down[t]] = 1;
  const used = new Uint8Array(n), rivers = [], sources = [], all = [];
  for (let t = 0; t < n; t++) if (isRiver(t)) { all.push(t); if (!fed[t]) sources.push(t); }
  // biggest catchments first, so main stems are traced whole
  sources.sort((a, b) => flow[b] - flow[a] || a - b);
  all.sort((a, b) => flow[a] - flow[b] || a - b);
  for (const s of [...sources, ...all]) {
    if (used[s]) continue;
    const pts = [], flows = [], nodes = [];
    let t = s;
    while (t >= 0) {
      pts.push([pos[t * 2], pos[t * 2 + 1]]); flows.push(flow[t]); nodes.push(t);
      if (used[t] || !onLand(t)) break;
      used[t] = 1;
      t = down[t];
    }
    if (pts.length >= 3) rivers.push({ pts, flows, nodes });
  }
  return rivers;
}

// ---------- erosion ----------

export const EROSION_MODES = { none: 'Off', rain: 'Rain & sediment', rivers: 'River networks' };

/**
 * River networks, after Daniel Andrino's "Terrain Erosion 3 Ways" (MIT,
 * https://github.com/dandrino/terrain-erosion-3-ways), written for this mesh.
 * Rivers grow upstream from the coast across the Delaunay graph: the next
 * region to join is the lowest one offered, and an offer that bends the river
 * waits behind one that keeps its heading (directional inertia), so every
 * land region joins one tree. Each region then carries the water of all the
 * regions above it, and valley floors are rebuilt from the mouths uphill:
 * each step keeps a share of the original rise that shrinks as the river
 * grows, capped so valley sides stay walkable. A region is pulled down toward
 * its valley floor as far as its river is large, so ridges and peaks between
 * rivers keep their height. Returns the carved region elevations and the
 * network's rivers.
 */
function riverNetwork(mesh, e0, wet, amount, threshold) {
  const { numRegions: n, points, adjStart, adj, adjFrom } = mesh;
  const parent = new Int32Array(n).fill(-1), joined = new Uint8Array(n), level = new Float32Array(n);
  const order = new Int32Array(n), outlet = new Int32Array(n).fill(-1);
  const heap = makeHeap(adj.length);
  const inertia = 0.04 + 0.12 * amount;
  let count = 0;
  const offer = (v) => {
    const px = parent[v] >= 0 ? points[v * 2] - points[parent[v] * 2] : 0, py = parent[v] >= 0 ? points[v * 2 + 1] - points[parent[v] * 2 + 1] : 0;
    const pm = Math.hypot(px, py);
    for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
      const u = adj[k];
      if (joined[u] || e0[u] < 0) continue;
      let bend = 0;
      if (pm) {
        const dx = points[u * 2] - points[v * 2], dy = points[u * 2 + 1] - points[v * 2 + 1];
        bend = (1 - (px * dx + py * dy) / (pm * (Math.hypot(dx, dy) || 1))) / 2;
      }
      heap.push(k, Math.max(e0[u], level[v]) + bend * inertia);
    }
  };
  // mouths: land regions on the coast, or at the map's edge
  for (let r = 0; r < n; r++) {
    if (e0[r] < 0) continue;
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) if (e0[adj[k]] < 0) { outlet[r] = adj[k]; break; }
    const x = points[r * 2], y = points[r * 2 + 1];
    if (outlet[r] >= 0 || x <= 0.5 || y <= 0.5 || x >= mesh.w - 0.5 || y >= mesh.h - 0.5) { joined[r] = 1; level[r] = e0[r]; order[count++] = r; }
  }
  for (let i = 0; i < count; i++) offer(order[i]);
  while (heap.length) {
    const k = heap.pop(), u = adj[k], v = adjFrom[k];
    if (joined[u]) continue;
    joined[u] = 1; parent[u] = v; level[u] = Math.max(e0[u], level[v]); order[count++] = u;
    offer(u);
  }
  // water: each region's rain plus everything upstream
  const volume = new Float32Array(n);
  for (let i = 0; i < count; i++) volume[order[i]] = 0.5 + wet[order[i]];
  for (let i = count - 1; i >= 0; i--) { const r = order[i]; if (parent[r] >= 0) volume[parent[r]] += volume[r]; }
  // valley floors from the mouths uphill, then each region pulled toward its floor
  const floor = new Float32Array(n), carved = Float32Array.from(e0);
  const share = 0.3 + 0.5 * amount, maxSlope = 0.012;
  for (let i = 0; i < count; i++) {
    const r = order[i], p = parent[r];
    if (p < 0) { floor[r] = e0[r]; continue; }
    const run = Math.hypot(points[r * 2] - points[p * 2], points[r * 2 + 1] - points[p * 2 + 1]);
    const rise = Math.max(0, e0[r] - e0[p]) / Math.pow(volume[r], share);
    floor[r] = Math.min(e0[r], floor[p] + Math.min(rise, run * maxSlope) + 1e-5);
  }
  for (let i = 0; i < count; i++) {
    const r = order[i], pull = amount * (1 - 1 / Math.sqrt(volume[r]));
    carved[r] = e0[r] + (floor[r] - e0[r]) * pull;
  }
  const rivers = traceRivers(n, points, (r) => e0[r] >= 0, parent, volume, threshold);
  // rivers reach the shoreline instead of stopping a region short of it
  for (const river of rivers) {
    const last = river.nodes[river.nodes.length - 1], sea = outlet[last];
    if (parent[last] < 0 && sea >= 0) {
      river.pts.push([(points[last * 2] + points[sea * 2]) / 2, (points[last * 2 + 1] + points[sea * 2 + 1]) / 2]);
      river.flows.push(river.flows[river.flows.length - 1]);
    }
  }
  return { carved, rivers };
}

/**
 * Rain and sediment: hydraulic erosion by water droplets, the particle form
 * of the simulation in "Terrain Erosion 3 Ways" (see Hans Theobald Beyer,
 * "Implementation of a method for hydraulic erosion", 2015). Each droplet
 * lands where the climate is wet, runs downhill with a little inertia, picks
 * up sediment while it is fast and the slope is steep, and drops it where it
 * slows, so gullies cut the mountains and silt flattens the valleys. Works on
 * the shared grid in mesh-elevation units and returns the eroded copy; the
 * sea is never eroded and sediment that reaches it is lost.
 */
function rainErosion(E, M, gw, gh, amount, seed) {
  const rng = makeRng(`${seed}:m4:erosion`);
  const Z = 40; // slopes in cells: mountains climb about one unit per cell
  const h = Float32Array.from(E, (v) => v * Z);
  // many gentle droplets: a few strong ones only pock the plains
  const inertia = 0.05, capacityK = 6, minSlope = 0.004, depositRate = 0.08, erodeRate = 0.3, evaporate = 0.02, gravity = 4, steps = 48;
  const R = 2.5, brush = [];
  let wsum = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const d = Math.hypot(dx, dy);
    if (d < R) { brush.push(dx, dy, R - d); wsum += R - d; }
  }
  for (let i = 2; i < brush.length; i += 3) brush[i] /= wsum;
  const at = (x, y) => {
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * gw + ix;
    return h[i] * (1 - fx) * (1 - fy) + h[i + 1] * fx * (1 - fy) + h[i + gw] * (1 - fx) * fy + h[i + gw + 1] * fx * fy;
  };
  // droplets fall only on land, more of them where it rains more
  const land = [];
  for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) if (h[y * gw + x] > 0) land.push(y * gw + x);
  if (!land.length) return h.map((v) => v / Z);
  const drops = Math.round(land.length * (0.4 + 0.9 * amount));
  for (let d = 0; d < drops; d++) {
    const cell = land[(rng() * land.length) | 0];
    let x = (cell % gw) + rng(), y = ((cell / gw) | 0) + rng();
    if (x >= gw - 1 || y >= gh - 1 || rng() > 0.25 + 0.75 * M[cell]) continue;
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;
    for (let s = 0; s < steps; s++) {
      const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * gw + ix;
      const a = h[i], b = h[i + 1], c = h[i + gw], e = h[i + gw + 1];
      const gx = (b - a) * (1 - fy) + (e - c) * fy, gy = (c - a) * (1 - fx) + (e - b) * fx;
      const here = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + e * fx * fy;
      dx = dx * inertia - gx * (1 - inertia); dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) break;
      dx /= len; dy /= len;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw - 1 || ny >= gh - 1) break;
      const there = at(nx, ny);
      if (there <= 0) break; // into the sea: the silt goes with it
      const dh = there - here;
      const capacity = Math.max(-dh, minSlope) * speed * water * capacityK;
      if (sediment > capacity || dh > 0) {
        const drop = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositRate;
        sediment -= drop;
        // silt settles on land only; the coastline stays where it was
        if (a > 0) h[i] += drop * (1 - fx) * (1 - fy);
        if (b > 0) h[i + 1] += drop * fx * (1 - fy);
        if (c > 0) h[i + gw] += drop * (1 - fx) * fy;
        if (e > 0) h[i + gw + 1] += drop * fx * fy;
      } else {
        const take = Math.min((capacity - sediment) * erodeRate, -dh);
        for (let k = 0; k < brush.length; k += 3) {
          const cx = ix + brush[k], cy = iy + brush[k + 1];
          if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
          const j = cy * gw + cx;
          if (h[j] > 0) h[j] = Math.max(h[j] - take * brush[k + 2], 0.01);
        }
        sediment += take;
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity));
      water *= 1 - evaporate;
      x = nx; y = ny;
    }
  }
  thermalErosion(h, gw, gh, 1.5, 0.22, Math.round(4 + 6 * amount));
  for (let i = 0; i < h.length; i++) h[i] /= Z;
  return h;
}

/** Thermal erosion, the "repose slope" step of the simulation in "Terrain
 *  Erosion 3 Ways": wherever land is steeper than loose rock can stand
 *  (`talus`, in the same cell units), a share of the excess slides to the
 *  lowest land neighbour, leaving scree slopes below crags. Each pass reads
 *  one copy and writes another, so the result never depends on scan order;
 *  nothing slides into the sea. */
function thermalErosion(h, gw, gh, talus, rate, passes) {
  const out = new Float32Array(h.length);
  for (let pass = 0; pass < passes; pass++) {
    out.set(h);
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x, v = h[i];
      if (v <= 0) continue;
      let low = -1, drop = talus;
      for (const j of [i - 1, i + 1, i - gw, i + gw]) if (h[j] > 0 && v - h[j] > drop) { drop = v - h[j]; low = j; }
      if (low < 0) continue;
      const move = (drop - talus) * rate / 2;
      out[i] -= move; out[low] += move;
    }
    h.set(out);
  }
}

/** FNV-1a over the bytes of typed arrays: the cache key of an erosion run is
 *  its exact input. */
function hashArrays(...arrays) {
  let x = 0x811c9dc5;
  for (const a of arrays) {
    const u = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    for (let i = 0; i < u.length; i++) x = Math.imul(x ^ u[i], 16777619);
  }
  return (x >>> 0).toString(36);
}

/** Erosion is the slowest step, and thumbnails, exports and the editor rebuild
 *  the same map again and again: identical input reuses the result. The 3x3
 *  blur afterwards takes out single-cell pocks and keeps the gullies. */
function rainDelta(gridE, moisture, amount, seed) {
  return cached(`rain|${seed}|${amount}|${hashArrays(gridE, moisture)}`, () => {
    const eroded = rainErosion(gridE, moisture, GRID_W, GRID_H, amount, seed);
    const raw = new Float32Array(gridE.length), delta = new Float32Array(gridE.length);
    for (let i = 0; i < raw.length; i++) raw[i] = eroded[i] - gridE[i];
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
        const w = (dx ? 1 : 2) * (dy ? 1 : 2); sum += raw[yy * GRID_W + xx] * w; n += w;
      }
      const i = y * GRID_W + x;
      // land stays land and sea stays sea: erosion reshapes, it never floods
      delta[i] = gridE[i] < 0 ? 0 : Math.max(sum / n, 1e-4 - gridE[i]);
    }
    return delta;
  });
}

/** Bilinear sample of a GRID_W x GRID_H field at map pixel (x, y). */
function sampleGrid(f, x, y) {
  const gx = clamp(x * GRID_W / MESH_W - 0.5, 0, GRID_W - 1.001), gy = clamp(y * GRID_H / MESH_H - 0.5, 0, GRID_H - 1.001);
  const ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy, i = iy * GRID_W + ix;
  return f[i] * (1 - fx) * (1 - fy) + f[i + 1] * fx * (1 - fy) + f[i + GRID_W] * (1 - fx) * fy + f[i + GRID_W + 1] * fx * fy;
}

// ---------- rasterize ----------

/** Linear interpolation of one or two per-region fields over every triangle,
 *  sampled at pixel centres of a gw x gh grid that spans the map. The two
 *  cases are written out because a general inner loop runs several times
 *  slower, and this is most of the cost of drawing a terrain map. */
function rasterizePair(mesh, va, vb, gw, gh, outA, outB) {
  const { points, triangles, numTriangles } = mesh;
  const sx = gw / mesh.w, sy = gh / mesh.h, eps = -1e-6;
  for (let t = 0; t < numTriangles; t++) {
    const a = triangles[t * 3], b = triangles[t * 3 + 1], c = triangles[t * 3 + 2];
    const ax = points[a * 2] * sx - 0.5, ay = points[a * 2 + 1] * sy - 0.5;
    const bx = points[b * 2] * sx - 0.5, by = points[b * 2 + 1] * sy - 0.5;
    const cx = points[c * 2] * sx - 0.5, cy = points[c * 2 + 1] * sy - 0.5;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (!det) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), x1 = Math.min(gw - 1, Math.floor(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), y1 = Math.min(gh - 1, Math.floor(Math.max(ay, by, cy)));
    if (x0 > x1 || y0 > y1) continue;
    // barycentrics are linear in x: each row's span inside the triangle is
    // solved for directly, then the values step along it
    const A1 = (by - cy) / det, B1 = (cx - bx) / det, A2 = (cy - ay) / det, B2 = (ax - cx) / det, A3 = -A1 - A2;
    const a1 = va[a], a2 = va[b], a3 = va[c], da = a1 * A1 + a2 * A2 + a3 * A3;
    const b1 = outB ? vb[a] : 0, b2 = outB ? vb[b] : 0, b3 = outB ? vb[c] : 0, db = b1 * A1 + b2 * A2 + b3 * A3;
    for (let y = y0; y <= y1; y++) {
      const k1 = B1 * (y - cy) - A1 * cx, k2 = B2 * (y - cy) - A2 * cx, k3 = 1 - k1 - k2;
      let lo = x0, hi = x1;
      // l = A * x + k must stay >= eps for all three
      if (A1 > 0) lo = Math.max(lo, Math.ceil((eps - k1) / A1)); else if (A1 < 0) hi = Math.min(hi, Math.floor((eps - k1) / A1)); else if (k1 < eps) continue;
      if (A2 > 0) lo = Math.max(lo, Math.ceil((eps - k2) / A2)); else if (A2 < 0) hi = Math.min(hi, Math.floor((eps - k2) / A2)); else if (k2 < eps) continue;
      if (A3 > 0) lo = Math.max(lo, Math.ceil((eps - k3) / A3)); else if (A3 < 0) hi = Math.min(hi, Math.floor((eps - k3) / A3)); else if (k3 < eps) continue;
      if (lo > hi) continue;
      const l1 = A1 * lo + k1, l2 = A2 * lo + k2, l3 = 1 - l1 - l2;
      let va0 = a1 * l1 + a2 * l2 + a3 * l3, vb0 = b1 * l1 + b2 * l2 + b3 * l3, i = y * gw + lo;
      if (outB) for (let x = lo; x <= hi; x++, i++, va0 += da, vb0 += db) { outA[i] = va0; outB[i] = vb0; }
      else for (let x = lo; x <= hi; x++, i++, va0 += da) outA[i] = va0;
    }
  }
}

export function rasterizeMany(mesh, sets, gw, gh, outs = sets.map(() => new Float32Array(gw * gh))) {
  for (let s = 0; s < sets.length; s += 2) rasterizePair(mesh, sets[s], sets[s + 1], gw, gh, outs[s], sets[s + 1] ? outs[s + 1] : null);
  return outs;
}

export function rasterize(mesh, values, gw, gh, out = new Float32Array(gw * gh)) {
  return rasterizeMany(mesh, [values], gw, gh, [out])[0];
}

/** Elevation (erosion detail included), rainfall, and when the map has them,
 *  how much of each pixel is lake (L, > 0.5 is water) and how far erosion
 *  moved it (D: < 0 worn away, > 0 silted up), at gw x gh, for drawing. */
export function terrainRaster(m, gw, gh) {
  const { regionElevation, regionMoisture, regionLake, delta } = m.terrain;
  const [E, M, L = null] = rasterizeMany(m.mesh, regionLake ? [regionElevation, regionMoisture, regionLake] : [regionElevation, regionMoisture], gw, gh);
  let D = null;
  if (delta) {
    D = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      const py = (y + 0.5) * MESH_H / gh;
      for (let x = 0; x < gw; x++) { const i = y * gw + x; D[i] = sampleGrid(delta, (x + 0.5) * MESH_W / gw, py); E[i] += D[i]; }
    }
  }
  return { E, M, L, D };
}

/** Per-region share of lake triangles, rasterized to the shared grid: the
 *  grid's lake mask, and the lakes as groups of cells (what the atlas code
 *  and carves read). Null fields when there are no lakes. */
function lakeGrid(mesh, lakeTri, height, water, mask) {
  mask.fill(0);
  if (!lakeTri.some(Boolean)) return { regionLake: null, field: null, lakes: [] };
  const { numRegions, triangles } = mesh;
  const regionLake = new Float32Array(numRegions), count = new Uint16Array(numRegions);
  for (let e = 0; e < triangles.length; e++) { regionLake[triangles[e]] += lakeTri[(e / 3) | 0]; count[triangles[e]]++; }
  for (let r = 0; r < numRegions; r++) regionLake[r] = count[r] ? regionLake[r] / count[r] : 0;
  const field = rasterize(mesh, regionLake, GRID_W, GRID_H);
  for (let i = 0; i < field.length; i++) if (field[i] > 0.5 && height[i] >= water) mask[i] = 1;
  const lakes = [], seen = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const group = [i];
    seen[i] = 1;
    for (let k = 0; k < group.length; k++) {
      const q = group[k], x = q % GRID_W, y = (q / GRID_W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy, j = yy * GRID_W + xx;
        if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H || !mask[j] || seen[j]) continue;
        seen[j] = 1; group.push(j);
      }
    }
    // a sliver where a lake narrows to a thread is no lake of its own
    if (group.length >= 4) lakes.push(group); else for (const q of group) mask[q] = 0;
  }
  return { regionLake, field, lakes };
}

/** River polylines in map pixels -> 8-connected grid-cell paths. */
function riverCellsOf(rivers, gw, gh) {
  const sx = gw / MESH_W, sy = gh / MESH_H, paths = [], cells = new Set();
  for (const river of rivers) {
    const path = [];
    const push = (x, y) => {
      const last = path[path.length - 1];
      if (last && last[0] === x && last[1] === y) return;
      path.push([x, y]); cells.add(y * gw + x);
    };
    for (let i = 0; i < river.pts.length; i++) {
      const [x, y] = river.pts[i];
      const gx = clamp(Math.floor(x * sx), 0, gw - 1), gy = clamp(Math.floor(y * sy), 0, gh - 1);
      const last = path[path.length - 1];
      if (last) {
        const steps = Math.max(Math.abs(gx - last[0]), Math.abs(gy - last[1]));
        for (let k = 1; k < steps; k++) push(Math.round(last[0] + (gx - last[0]) * k / steps), Math.round(last[1] + (gy - last[1]) * k / steps));
      }
      push(gx, gy);
    }
    if (path.length >= 6) paths.push(path);
  }
  return { paths, cells };
}

// ---------- the whole terrain ----------

/** Everything derived from the painted constraint. `live` is set while a
 *  brush gesture is still going: rain erosion then reuses the gullies it
 *  already has instead of rerunning its droplets (the editor rebuilds the
 *  map when the gesture ends). */
function finishTerrain(model, live = false) {
  const { mesh, parts, params: p } = model, prev = model.terrain;
  const mode = EROSION_MODES[p.erosion] ? p.erosion : 'none';
  const amount = clamp(Number(p.erosionAmount ?? 0.6), 0, 1);
  const elevation = shapeSeaFloor(mesh, triangleElevation(parts), parts.sea);
  const baseElevation = regionValues(mesh, elevation);
  const regionMoisture = rainfall(mesh, baseElevation, model.wind, clamp(Number(p.rain ?? 0.5), 0, 1));
  // the Rivers slider sets how much flow it takes to draw a river
  const riverParam = clamp(Number(p.rivers ?? 6), 0, 14);
  const threshold = riverParam ? 14 * Math.pow(1.3, 6 - riverParam) : Infinity;
  let regionElevation = baseElevation, rivers, delta = null, gridE, moisture, lakeTri = null;
  if (mode === 'rivers') {
    const net = riverNetwork(mesh, baseElevation, regionMoisture, amount, threshold);
    regionElevation = net.carved; rivers = net.rivers;
    [gridE, moisture] = rasterizeMany(mesh, [regionElevation, regionMoisture], GRID_W, GRID_H, [new Float32Array(GRID_W * GRID_H), model.moisture || new Float32Array(GRID_W * GRID_H)]);
  } else {
    [gridE, moisture] = rasterizeMany(mesh, [baseElevation, regionMoisture], GRID_W, GRID_H, [new Float32Array(GRID_W * GRID_H), model.moisture || new Float32Array(GRID_W * GRID_H)]);
    let drainOn = elevation;
    if (mode === 'rain') {
      const old = model.terrain?.delta;
      if (live && old) delta = old;
      else delta = rainDelta(gridE, moisture, amount, model.seed);
      for (let i = 0; i < gridE.length; i++) gridE[i] += delta[i];
      // rivers follow the gullies: the triangles drain over the eroded surface
      drainOn = elevation.map((v, t) => (v < 0 ? v : Math.max(1e-4, v + sampleGrid(delta, mesh.centroids[t * 2], mesh.centroids[t * 2 + 1]))));
    }
    const { down, flow, level } = drainTriangles(mesh, drainOn, regionMoisture);
    // rivers end where they reach a lake, and its outlet starts a new one
    // mid-gesture the lakes stay as they were; they settle when the brush lifts
    lakeTri = live && prev?.lakeTri ? prev.lakeTri : findLakes(mesh, drainOn, level, flow, LAKE_DEPTH, LAKE_FLOW);
    rivers = traceRivers(mesh.numTriangles, mesh.centroids, (t) => drainOn[t] >= 0 && !lakeTri[t], down, flow, threshold);
  }
  const water = model.water;
  const height = model.height || new Float32Array(GRID_W * GRID_H);
  for (let i = 0; i < height.length; i++) height[i] = clamp(water + gridE[i] * HEIGHT_SPAN, 0.02, 0.98);
  const lake = live && prev?.lakeTri && lakeTri === prev.lakeTri ? prev.lake : lakeGrid(mesh, lakeTri || new Uint8Array(0), height, water, model.lakeMask);
  const grid = riverCellsOf(rivers, GRID_W, GRID_H);
  Object.assign(model, {
    height, moisture, lakes: lake.lakes,
    terrain: { elevation, regionElevation, regionMoisture, regionLake: lake.regionLake, lakeField: lake.field, lakeTri, lake, threshold, rivers, delta, erosion: mode, live },
    rivers: grid.paths, riverCells: grid.cells,
  });
  return model;
}

/** The terrain half of a world model: mesh, painted constraint, elevation,
 *  climate, erosion and rivers, plus the shared grid fields. Strokes are
 *  applied to the constraint in order before anything is derived from it. */
export function buildMeshTerrain(map) {
  const p = map.params || {};
  const seed = map.seed;
  const mesh = buildMesh(seed);
  const parts = terrainParts(mesh, seed, p);
  for (const s of map.strokes || []) paintConstraint(mesh, parts, s);
  const windRng = makeRng(`${seed}:m4:wind`);
  const base = p.wind === 'east' ? Math.PI : 0;
  const angle = base + windRng.range(-0.35, 0.35);
  const wind = cached(`wind|${seed}|${angle}`, () => windOrder(mesh, angle));
  const water = clamp(Number(p.water ?? 0.5), 0.2, 0.8);
  const model = {
    seed, mesh, parts, wind, water, params: p, gw: GRID_W, gh: GRID_H,
    lakes: [], lakeMask: new Uint8Array(GRID_W * GRID_H),
  };
  return finishTerrain(model);
}

/** Live brush painting: the same arithmetic buildMeshTerrain applies to
 *  map.strokes (one stroke or a frame's worth), then everything derived from
 *  the constraint is worked out once. */
export function repaintMeshTerrain(model, strokes, { live = true } = {}) {
  for (const s of Array.isArray(strokes) ? strokes : [strokes]) paintConstraint(model.mesh, model.parts, s);
  return finishTerrain(model, live);
}
