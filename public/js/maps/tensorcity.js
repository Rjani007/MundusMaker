// Metro layout for modern towns (1.9.1). Streets are traced through a tensor
// field: the method of Chen, Esch, Wonka, Müller and Zhang, "Interactive
// Procedural Street Modeling" (SIGGRAPH 2008), which Keir's (ProbableTrain)
// MapGenerator made popular for city maps. This is an original implementation
// of the published method; no MapGenerator code is used.
//
//   1. A tensor field from grid and radial basis fields, bent to follow the
//      shore and the river, and twisted by noise out in the suburbs. The
//      railway is the best of many candidate lines near the grid's
//      directions, and the field bends to it too.
//   2. Shore roads first: a drive along the sea front and a road down each
//      river bank. Other streets keep back from the water and meet them.
//   3. Evenly spaced streamlines of its major and minor eigenvectors, traced
//      with RK4 in three classes (arterial, collector, local) of shrinking
//      separation; dangling ends join the nearest street ahead of them.
//      Arterials stop at the edge of town and the ones heading outward run on
//      to the map's edge; local streets stop at the railway. Loose ends that
//      lead nowhere are then cut back to their last junction.
//      Before the local streets, one or two large blocks of the main-street
//      graph near the centre are kept as big parks that local streets
//      stay out of.
//   4. A planar graph of every street, the railway, the shore and the map
//      frame. Its faces are the city blocks.
//   5. Blocks inset by street width and split across their longest edge
//      into frontage lots; each lot gets a building suited to its district,
//      and every building a number of storeys (for its shadow).
//
// town.js takes this path only for params.modernLayout === 'tensor' on a
// modern town (read directly), so no existing town changes. Every draw comes
// from streams under ':metro'. The model has the modern town's shape, plus
// polygons (`poly`), building `levels`, big-park ponds and paths and the
// shore bands, which modernart.js draws only when they are present.

import { makeRng, makeFbm, clamp } from '../util.js';
import { landmarkNames, TREES, SURNAMES, PLACE_WORDS, LOCAL_SUFFIX } from './moderntown.js';

const W = 900, H = 640, TAU = Math.PI * 2;
const LAND = 0, SEA = 1, RIVER = 2;
const MC = 2, MW = W / MC, MH = H / MC; // water mask cells
const TS = 4, TW = Math.ceil(W / TS) + 1, TH = Math.ceil(H / TS) + 1; // tensor grid

// separation per eigenvector family [major, minor]: unequal spacing gives
// blocks longer than they are deep, as real ones are
const CLASSES = [
  // arterials stop at the edge of town (extent); runOut carries the ones
  // heading away from it on to the map's edge as highways
  { name: 'arterial', dsep: [190, 190], dtest: [80, 80], dstep: 3, lookahead: 160, minLen: 140, bridges: true, extent: 2, tries: 50 },
  { name: 'collector', dsep: [68, 92], dtest: [30, 40], dstep: 3, lookahead: 80, minLen: 50, bridges: true, extent: 1.75, tries: 160 },
  { name: 'local', dsep: [29, 50], dtest: [13, 22], dstep: 2.5, lookahead: 36, minLen: 16, bridges: false, extent: 1.45, tries: 420 },
];
// how far blocks pull back from each kind of edge (half the drawn width + a sidewalk)
const INSET = { arterial: 7, collector: 5.5, local: 4, rail: 4.5, shore: 3.5, edge: 0.5 };
// shore roads run this far in from the sea's edge and the river's banks; no
// other street comes closer to the water than the road's own far side
const SEA_DRIVE = 15, RIVER_DRIVE = 9;
const SEA_ROADS = ['Harbor Drive', 'Ocean Avenue', 'Bay Shore Drive', 'Seaside Boulevard', 'Marine Parade', 'Beach Road'];
const RIVER_ROADS = ['Riverside Drive', 'River Road', 'Water Street', 'Embankment Road', 'Canal Street', 'Mill Road'];
const LOTS = {
  downtown: { target: 420, front: 0.6, side: 0.6, fill: 0.97, min: 60 },
  residential: { target: 165, front: 2.2, side: 1.3, fill: 0.9, min: 30 },
  suburban: { target: 230, front: 4.2, side: 2.8, fill: 0.78, min: 26 },
  industrial: { target: 900, front: 3, side: 2.5, fill: 0.85, min: 120 },
  waterfront: { target: 360, front: 2, side: 1.6, fill: 0.85, min: 50 },
};

// ---------- geometry ----------
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function signedArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s / 2;
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [cx / (3 * a), cy / (3 * a)];
}

function pointIn(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segX(ax, ay, bx, by, cx, cy, dx, dy, eps = 1e-6) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { t: clamp(t, 0, 1), u: clamp(u, 0, 1), x: ax + rx * t, y: ay + ry * t };
}

/** Douglas–Peucker; returns the kept indices. */
function simplifyIdx(pts, tol) {
  const n = pts.length, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Douglas–Peucker for a closed ring: anchored at vertex 0 and the vertex
 *  farthest from it, so the chord never has zero length. */
function simplifyRing(pts, tol) {
  const n = pts.length;
  let far = 1, fd = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = simplifyIdx(pts.slice(0, far + 1), tol);
  const b = simplifyIdx([...pts.slice(far), pts[0]], tol).map((i) => i + far);
  return [...a, ...b.slice(1, -1)];
}

function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= len) { out.push([ax + (bx - ax) * d / len, ay + (by - ay) * d / len]); d += step; }
    carry = len - (d - step);
  }
  const last = pts[pts.length - 1], prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.3) out.push(last); else out[out.length - 1] = last;
  return out;
}

const pathLength = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };

/** Offset every edge of a polygon inward by its own distance. Null when the
 *  result folds over (a block too small for its streets). */
function inset(pts, off) {
  if (pts.length < 3) return null;
  const s = Math.sign(signedArea(pts)) || 1;
  let lines = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    dx /= len; dy /= len;
    const nx = -dy * s, ny = dx * s;
    lines.push({ px: a[0] + nx * off[i], py: a[1] + ny * off[i], ax: a[0], ay: a[1], dx, dy, nx, ny, d: off[i] });
  }
  const corner = (L1, L2) => {
    const d = Math.max(L1.d, L2.d), cross = L1.dx * L2.dy - L1.dy * L2.dx;
    const bevel = () => {
      let bx = L1.nx + L2.nx, by = L1.ny + L2.ny; const m = Math.hypot(bx, by) || 1;
      return [L2.ax + bx / m * d, L2.ay + by / m * d];
    };
    if (Math.abs(cross) < 0.08) return bevel();
    const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / cross;
    const x = L1.px + L1.dx * t, y = L1.py + L1.dy * t;
    return Math.hypot(x - L2.ax, y - L2.ay) > 3 * Math.max(d, 1) ? bevel() : [x, y];
  };
  // an edge shorter than its corners' offsets comes out backwards: drop it and
  // meet its neighbours directly, until every edge keeps its direction
  for (let guard = lines.length; guard > 0; guard--) {
    const n = lines.length;
    if (n < 3) return null;
    const out = lines.map((L, i) => corner(lines[(i - 1 + n) % n], L));
    let drop = -1;
    for (let i = 0; i < n; i++) {
      const a = out[i], b = out[(i + 1) % n];
      if ((b[0] - a[0]) * lines[i].dx + (b[1] - a[1]) * lines[i].dy < 0) { drop = i; break; }
    }
    if (drop >= 0) { lines.splice(drop, 1); continue; }
    const area = signedArea(out);
    if (Math.sign(area) !== s || Math.abs(area) < 4) return null;
    // a folded inset still crosses itself
    if (n <= 90) for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const A = out[i], B = out[(i + 1) % n], C = out[j], D = out[(j + 1) % n];
      if (segX(A[0], A[1], B[0], B[1], C[0], C[1], D[0], D[1], -1e-9)) return null;
    }
    return out;
  }
  return null;
}

/** The oriented box of a polygon, along its longest edge (labels, keys and
 *  populate read x, y, w, h and rot from every building). */
function orientedBox(poly) {
  let best = 0, rot = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > best) { best = len; rot = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  const c = Math.cos(rot), s = Math.sin(rot);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of poly) { const u = x * c + y * s, v = -x * s + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  // anchored on the polygon's own centroid: a lopsided footprint's box centre
  // can fall outside it, and labels, keys and populate all point at x, y
  const [x, y] = centroid(poly);
  return { x, y, w: u1 - u0, h: v1 - v0, rot };
}

/** Split a lot across its longest edge. Vertices carry `o`: whether the edge
 *  leaving them faces a street (the cut edges never do). */
function splitLot(poly, rng) {
  const n = poly.length, flat = poly.map((v) => [v.x, v.y]);
  let li = 0, best = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) { best = len; li = i; }
  }
  const a = poly[li], b = poly[(li + 1) % n], t = rng.range(0.4, 0.6);
  const P = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
  let dx = -(b.y - a.y) / best, dy = (b.x - a.x) / best;
  if (!pointIn(P[0] + dx * 0.4, P[1] + dy * 0.4, flat)) { dx = -dx; dy = -dy; }
  let hit = null;
  for (let k = 0; k < n; k++) {
    if (k === li) continue;
    const c = poly[k], d = poly[(k + 1) % n];
    const r = segX(P[0], P[1], P[0] + dx * 4000, P[1] + dy * 4000, c.x, c.y, d.x, d.y, 0);
    if (r && r.t * 4000 > 0.05 && (!hit || r.t < hit.t)) hit = { t: r.t, k, x: r.x, y: r.y };
  }
  if (!hit) return null;
  const A = [{ x: P[0], y: P[1], o: a.o }], B = [{ x: hit.x, y: hit.y, o: poly[hit.k].o }];
  for (let i = (li + 1) % n; ; i = (i + 1) % n) { A.push(poly[i]); if (i === hit.k) break; }
  A.push({ x: hit.x, y: hit.y, o: false });
  for (let i = (hit.k + 1) % n; ; i = (i + 1) % n) { B.push(poly[i]); if (i === li) break; }
  B.push({ x: P[0], y: P[1], o: false });
  return [A, B];
}

function subdivide(poly, target, rng, out, depth = 0) {
  const area = Math.abs(signedArea(poly.map((v) => [v.x, v.y])));
  if (area < target * rng.range(1.1, 1.7) || depth > 14) { out.push(poly); return; }
  const halves = splitLot(poly, rng);
  if (!halves) { out.push(poly); return; }
  for (const h of halves) subdivide(h, target, rng, out, depth + 1);
}

// ---------- spatial point store ----------
function pointStore(cell) {
  const buckets = new Map();
  const key = (gx, gy) => gy * 8192 + gx;
  const each = (x, y, d, fn) => {
    const g0 = Math.floor((x - d + 256) / cell), g1 = Math.floor((x + d + 256) / cell);
    const h0 = Math.floor((y - d + 256) / cell), h1 = Math.floor((y + d + 256) / cell);
    for (let gy = h0; gy <= h1; gy++) for (let gx = g0; gx <= g1; gx++) {
      const b = buckets.get(key(gx, gy));
      if (b) for (let i = 0; i < b.length; i += 5) if (fn(b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4]) === false) return;
    }
  };
  return {
    add(x, y, ref, dx = 0, dy = 0) {
      const k = key(Math.floor((x + 256) / cell), Math.floor((y + 256) / cell));
      let b = buckets.get(k); if (!b) buckets.set(k, b = []);
      b.push(x, y, ref, dx, dy);
    },
    /** A stored point within d whose street runs along (ux, uy). */
    parallel(x, y, d, ux, uy) {
      let hit = false;
      each(x, y, d, (px, py, ref, dx, dy) => {
        if ((px - x) ** 2 + (py - y) ** 2 < d * d && Math.abs(dx * ux + dy * uy) > 0.87) { hit = true; return false; }
        return true;
      });
      return hit;
    },
    near(x, y, d) {
      let hit = false;
      each(x, y, d, (px, py) => { if ((px - x) ** 2 + (py - y) ** 2 < d * d) { hit = true; return false; } return true; });
      return hit;
    },
    nearest(x, y, d, accept) {
      let best = null, bd = d * d;
      each(x, y, d, (px, py, ref) => {
        const dd = (px - x) ** 2 + (py - y) ** 2;
        if (dd < bd && accept(px, py, ref)) { bd = dd; best = { x: px, y: py, ref }; }
      });
      return best;
    },
  };
}

// ---------- water ----------
const FRAMES = {
  south: { to: (u, v) => [u, H - v], from: (x, y) => [x, H - y], len: W, deep: H },
  north: { to: (u, v) => [u, v], from: (x, y) => [x, y], len: W, deep: H },
  east: { to: (u, v) => [W - v, u], from: (x, y) => [y, W - x], len: H, deep: W },
  west: { to: (u, v) => [v, u], from: (x, y) => [y, x], len: H, deep: W },
};

function makeWater(seed, p, size) {
  const rng = makeRng(`${seed}:metro:water`), noise = makeFbm(`${seed}:metro:water`, 4);
  const hinted = p.layout === 'coastal' ? 'sea' : p.layout === 'riverside' ? 'river' : null;
  const hasSea = hinted ? hinted === 'sea' : rng.chance(0.5);
  const hasRiver = hinted ? hinted === 'river' || rng.chance(0.35) : rng.chance(0.55);
  let sea = null, river = null;
  const mask = new Uint8Array(MW * MH);
  if (hasSea) {
    const side = p.seaSide && FRAMES[p.seaSide] ? p.seaSide : rng.pick(['south', 'south', 'east', 'west', 'north']);
    const F = FRAMES[side], depth = F.deep * rng.range(0.16, 0.3);
    // the shore is a streamline of a noise-rotated field, kept monotonic along the edge
    const coastUV = [];
    let u = -30, v = depth;
    while (u < F.len + 30) {
      coastUV.push([u, v]);
      const a = clamp((noise(u / 210 + 5, v / 210 + 5) - 0.5) * 3.2, -1.05, 1.05);
      u += Math.cos(a) * 5; v = clamp(v + Math.sin(a) * 5, depth * 0.45, depth * 1.9);
    }
    const coastV = (uu) => {
      const i = clamp(Math.floor((uu + 30) / 5), 0, coastUV.length - 2);
      let k = i; while (k > 0 && coastUV[k][0] > uu) k--; while (k < coastUV.length - 2 && coastUV[k + 1][0] < uu) k++;
      const [u0, v0] = coastUV[k], [u1, v1] = coastUV[k + 1];
      return v0 + (v1 - v0) * clamp((uu - u0) / ((u1 - u0) || 1), 0, 1);
    };
    const coast = coastUV.map(([uu, vv]) => F.to(uu, vv));
    const poly = [...coast, F.to(F.len + 60, -60), F.to(-60, -60)];
    sea = { side, coast, poly, isSea: (x, y) => { const [uu, vv] = F.from(x, y); return vv < coastV(uu); } };
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (sea.isSea(x * MC + 1, y * MC + 1)) mask[y * MW + x] = SEA;
  }
  if (hasRiver) {
    const width = rng.range(18, 28) * (size >= 4 ? 1.15 : 1);
    let x, y, heading;
    if (sea) {
      // rise at the far edge and run down to the sea
      const F = FRAMES[sea.side];
      [x, y] = F.to(F.len * rng.range(0.25, 0.75), F.deep + 10);
      const [tx, ty] = F.to(F.len / 2, 0);
      heading = Math.atan2(ty - y, tx - x);
    } else if (rng.chance(0.5)) { x = -10; y = H * rng.range(0.3, 0.7); heading = rng.range(-0.3, 0.3); }
    else { x = W * rng.range(0.3, 0.7); y = -10; heading = Math.PI / 2 + rng.range(-0.3, 0.3); }
    const pts = [];
    let wetSteps = 0;
    for (let i = 0; i < 900; i++) {
      pts.push([x, y]);
      const a = heading + (noise(x / 170, y / 170) - 0.5) * 2;
      x += Math.cos(a) * 5; y += Math.sin(a) * 5;
      if (x < -30 || y < -30 || x > W + 30 || y > H + 30) { pts.push([x, y]); break; }
      if (sea?.isSea(x, y) && ++wetSteps > width / 4) break;
    }
    river = { pts, width };
    const stamp = (cx, cy, r) => {
      for (let yy = Math.max(0, Math.floor((cy - r) / MC)); yy <= Math.min(MH - 1, Math.floor((cy + r) / MC)); yy++)
        for (let xx = Math.max(0, Math.floor((cx - r) / MC)); xx <= Math.min(MW - 1, Math.floor((cx + r) / MC)); xx++) {
          if (mask[yy * MW + xx] === LAND && Math.hypot(xx * MC + 1 - cx, yy * MC + 1 - cy) <= r) mask[yy * MW + xx] = RIVER;
        }
    };
    for (const q of resample(pts, 2)) stamp(q[0], q[1], width / 2);
  }
  const at = (x, y) => mask[clamp(Math.floor(y / MC), 0, MH - 1) * MW + clamp(Math.floor(x / MC), 0, MW - 1)];
  // distance to water on a coarse grid, for districts and the marina
  const DC = 8, DW = Math.ceil(W / DC), DH = Math.ceil(H / DC), dist = new Float32Array(DW * DH).fill(1e9);
  const queue = [];
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) if (at(x * DC + DC / 2, y * DC + DC / 2) !== LAND) { dist[y * DW + x] = 0; queue.push(y * DW + x); }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h], x = i % DW, y = (i / DW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= DW || yy >= DH) continue;
      const j = yy * DW + xx; if (dist[j] <= dist[i] + DC) continue;
      dist[j] = dist[i] + DC; queue.push(j);
    }
  }
  const distTo = (x, y) => dist[clamp(Math.floor(y / DC), 0, DH - 1) * DW + clamp(Math.floor(x / DC), 0, DW - 1)];
  // finer distances to the sea and to the river (2 px cells), which keep
  // streets back from the water where the shore roads run
  const seaDist = chamfer(mask, SEA), riverDist = chamfer(mask, RIVER);
  const fine = (f) => (x, y) => f[clamp(Math.floor(y / MC), 0, MH - 1) * MW + clamp(Math.floor(x / MC), 0, MW - 1)];
  return { sea, river, mask, at, distTo, toSea: fine(seaDist), toRiver: fine(riverDist) };
}

/** Distance in map pixels from every mask cell to the nearest cell of one
 *  kind: a two-pass 3-4 chamfer transform, close to Euclidean. */
function chamfer(mask, kind) {
  const d = new Float32Array(MW * MH).fill(1e9), a = MC, b = MC * Math.SQRT2;
  for (let i = 0; i < d.length; i++) if (mask[i] === kind) d[i] = 0;
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const i = y * MW + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + a);
    if (y > 0) {
      d[i] = Math.min(d[i], d[i - MW] + a);
      if (x > 0) d[i] = Math.min(d[i], d[i - MW - 1] + b);
      if (x < MW - 1) d[i] = Math.min(d[i], d[i - MW + 1] + b);
    }
  }
  for (let y = MH - 1; y >= 0; y--) for (let x = MW - 1; x >= 0; x--) {
    const i = y * MW + x;
    if (x < MW - 1) d[i] = Math.min(d[i], d[i + 1] + a);
    if (y < MH - 1) {
      d[i] = Math.min(d[i], d[i + MW] + a);
      if (x < MW - 1) d[i] = Math.min(d[i], d[i + MW + 1] + b);
      if (x > 0) d[i] = Math.min(d[i], d[i + MW - 1] + b);
    }
  }
  return d;
}

/** Roads along the water: a drive set back from the sea, and a road down
 *  each bank of the river. Each is the shoreline offset toward the land,
 *  smoothed so tight bends don't fold it, and cut wherever it would leave dry
 *  land, crowd the water or run out past the city. */
function shoreDrives(water, ell) {
  const out = [];
  const offset = (line, d, side) => {
    const pts = resample(line, 4), n = pts.length;
    let off = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
      const tx = b[0] - a[0], ty = b[1] - a[1], m = Math.hypot(tx, ty) || 1;
      return [p[0] - ty / m * d * side, p[1] + tx / m * d * side];
    });
    for (let pass = 0; pass < 4; pass++) off = off.map((p, i) => (i === 0 || i === n - 1 ? p : [(off[i - 1][0] + 2 * p[0] + off[i + 1][0]) / 4, (off[i - 1][1] + 2 * p[1] + off[i + 1][1]) / 4]));
    return off;
  };
  const runs = (pts, ok, kind) => {
    let cur = [];
    const flush = () => { if (pathLength(cur) > 90) out.push({ pts: resample(cur, 6), shore: kind }); cur = []; };
    for (const p of pts) { if (ok(p)) cur.push(p); else flush(); }
    flush();
  };
  const inFrame = ([x, y]) => x > 2 && y > 2 && x < W - 2 && y < H - 2;
  if (water.sea) {
    const coast = water.sea.coast, mid = coast[coast.length >> 1], next = coast[(coast.length >> 1) + 1];
    const tx = next[0] - mid[0], ty = next[1] - mid[1], m = Math.hypot(tx, ty) || 1;
    const side = water.at(mid[0] - ty / m * 20, mid[1] + tx / m * 20) === LAND ? 1 : -1;
    runs(offset(coast, SEA_DRIVE, side), (p) => inFrame(p) && water.at(p[0], p[1]) === LAND && water.toSea(p[0], p[1]) > SEA_DRIVE * 0.6 && water.toRiver(p[0], p[1]) > RIVER_DRIVE && ell(p[0], p[1]) < 1.55, 'sea');
  }
  if (water.river) {
    const d = water.river.width / 2 + RIVER_DRIVE;
    for (const side of [1, -1]) {
      runs(offset(water.river.pts, d, side), (p) => inFrame(p) && water.at(p[0], p[1]) === LAND && water.toRiver(p[0], p[1]) > RIVER_DRIVE * 0.5 && water.toSea(p[0], p[1]) > SEA_DRIVE && ell(p[0], p[1]) < 1.5, side > 0 ? 'river-a' : 'river-b');
    }
  }
  return out;
}

// ---------- tensor field ----------
function makeField(seed, center, R, size, water, ell) {
  const rng = makeRng(`${seed}:metro`), twist = makeFbm(`${seed}:metro:twist`, 3);
  const base = rng.range(-0.6, 0.6);
  const fields = [{ grid: true, x: center.x, y: center.y, size: R * 1.1, theta: base, w: 1.3 }];
  const grids = 2 + Math.min(4, size);
  for (let k = 0; k < grids; k++) fields.push({ grid: true, x: rng.range(0, W), y: rng.range(0, H), size: rng.range(170, 360), theta: base + rng.range(-0.85, 0.85), w: rng.range(0.6, 1) });
  if (rng.chance(0.65)) fields.push({ grid: false, x: center.x + rng.range(-70, 70), y: center.y + rng.range(-70, 70), size: rng.range(80, 150), w: 1.6 });
  const A = new Float32Array(TW * TH), B = new Float32Array(TW * TH);
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const x = i * TS, y = j * TS;
    let a = Math.cos(2 * base) * 0.04, b = Math.sin(2 * base) * 0.04;
    for (const f of fields) {
      const dx = x - f.x, dy = y - f.y, d2 = dx * dx + dy * dy, w = f.w * Math.exp(-d2 / (f.size * f.size));
      if (w < 1e-4) continue;
      if (f.grid) { a += w * Math.cos(2 * f.theta); b += w * Math.sin(2 * f.theta); }
      else if (d2 > 1) { a += w * (dy * dy - dx * dx) / d2; b += w * (-2 * dx * dy) / d2; }
    }
    A[j * TW + i] = a; B[j * TW + i] = b;
  }
  /** Streets near a line (a shore, the river, the railway) run along it. */
  const addLine = (line, weight, sigma) => {
    const pts = resample(line, 10), r = sigma * 2.7;
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], phi = Math.atan2(y1 - y0, x1 - x0), ca = Math.cos(2 * phi), sa = Math.sin(2 * phi);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (let j = Math.max(0, Math.floor((cy - r) / TS)); j <= Math.min(TH - 1, Math.ceil((cy + r) / TS)); j++)
        for (let i = Math.max(0, Math.floor((cx - r) / TS)); i <= Math.min(TW - 1, Math.ceil((cx + r) / TS)); i++) {
          const d2 = (i * TS - cx) ** 2 + (j * TS - cy) ** 2, w = weight * Math.exp(-d2 / (2 * sigma * sigma));
          A[j * TW + i] += w * ca; B[j * TW + i] += w * sa;
        }
    }
  };
  for (const line of [...(water.sea ? [water.sea.coast] : []), ...(water.river ? [water.river.pts] : [])]) addLine(line, 0.55, 26);
  // suburbs curve: the tensor turns with low-frequency noise past the core
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const x = i * TS, y = j * TS, k = smoothstep(0.75, 1.5, ell(x, y));
    if (!k) continue;
    const al = (twist(x / 240, y / 240) - 0.5) * 2.4 * k, c = Math.cos(2 * al), s = Math.sin(2 * al);
    const a = A[j * TW + i], b = B[j * TW + i];
    A[j * TW + i] = a * c - b * s; B[j * TW + i] = a * s + b * c;
  }
  const at = (x, y) => {
    const fx = clamp(x / TS, 0, TW - 1.001), fy = clamp(y / TS, 0, TH - 1.001), i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const k = j * TW + i;
    const a = (A[k] * (1 - tx) + A[k + 1] * tx) * (1 - ty) + (A[k + TW] * (1 - tx) + A[k + TW + 1] * tx) * ty;
    const b = (B[k] * (1 - tx) + B[k + 1] * tx) * (1 - ty) + (B[k + TW] * (1 - tx) + B[k + TW + 1] * tx) * ty;
    return [a, b];
  };
  // later lines (the railway) bend the field without the suburban twist
  return { at, base, addLine };
}

// ---------- the city ----------
export function buildTensorCity(map) {
  const p = { size: 2, density: 1, ...(map.params || {}) };
  const seed = map.seed;
  const size = clamp(Math.round(Number(p.size) || 2), 1, 5);
  const density = clamp(Number(p.density) || 1, 0.4, 1.6);
  const R = [0, 130, 175, 230, 290, 350][size];
  const water = makeWater(seed, p, size);

  // downtown sits on dry land near the middle, a little back from the water
  const siteRng = makeRng(`${seed}:metro:site`);
  let center = { x: W / 2, y: H / 2 }, bestScore = -Infinity;
  for (let k = 0; k < 160; k++) {
    const x = siteRng.range(W * 0.25, W * 0.75), y = siteRng.range(H * 0.25, H * 0.75);
    if (water.at(x, y) !== LAND) continue;
    const d = water.distTo(x, y);
    const score = -Math.hypot(x - W / 2, y - H / 2) - (d < 1e8 ? Math.abs(d - R * 0.5) * 0.8 : 0);
    if (score > bestScore) { bestScore = score; center = { x, y }; }
  }
  const edge = makeFbm(`${seed}:metro:edge`, 3);
  const ellRaw = (x, y) => Math.hypot((x - center.x) / (R * 1.1), (y - center.y) / (R * 0.85));
  const ell = (x, y) => ellRaw(x, y) * (1 + (edge(x / 150, y / 150) - 0.5) * 0.5);
  const field = makeField(seed, center, R, size, water, ellRaw);

  // ---------- railway ----------
  // One main line crosses the map. Candidate lines run close to one of the
  // street grid's two directions and are scored: the best passes a little off
  // downtown (the station a short walk from City Hall), runs edge to edge,
  // and crosses a river square-on instead of running down it or along its
  // bank. Streets near it then line up with it, and local streets stop at it.
  const railRng = makeRng(`${seed}:metro:rail`), riverWidth = water.river?.width || 0;
  let rail = null, station = null;
  const railCandidate = (ang, off, bend) => {
    const ox = center.x - Math.sin(ang) * off, oy = center.y + Math.cos(ang) * off, pts = [];
    for (let t = -1300; t <= 1300; t += 6) pts.push([ox + Math.cos(ang) * t - Math.sin(ang) * bend * t * t, oy + Math.sin(ang) * t + Math.cos(ang) * bend * t * t]);
    // the longest stretch inside the frame (and a margin) that keeps off the sea
    const runs = []; let cur = [];
    for (const q of pts) {
      const ok = q[0] > -20 && q[1] > -20 && q[0] < W + 20 && q[1] < H + 20 && water.at(q[0], q[1]) !== SEA && water.toSea(q[0], q[1]) > 8;
      if (ok) cur.push(q); else { if (cur.length > 20) runs.push(cur); cur = []; }
    }
    if (cur.length > 20) runs.push(cur);
    const run = runs.sort((a, b) => b.length - a.length)[0];
    if (!run || pathLength(run) < Math.min(W, H) * 0.7) return null;
    const offFrame = ([x, y]) => x < 12 || y < 12 || x > W - 12 || y > H - 12;
    let score = (offFrame(run[0]) ? 0 : 600) + (offFrame(run[run.length - 1]) ? 0 : 600); // a line that stops short of the edge
    let wet = 0, crossings = 0, closest = Infinity;
    for (const [x, y] of run) {
      const w = water.at(x, y);
      if (w === RIVER) {
        if (!wet) crossings++;
        if (++wet * 6 > riverWidth * 1.3 + 6) score += 400; // a shallow crossing is a bridge down the river
      } else {
        wet = 0;
        if (water.toRiver(x, y) < 16) score += 25; // running alongside the bank
      }
      if (Math.min(x, y, W - x, H - y) < 30) score += 8; // hugging the map's edge
      closest = Math.min(closest, Math.hypot(x - center.x, y - center.y));
    }
    score += Math.max(0, crossings - 1) * 500 + Math.abs(closest - R * 0.4) * 3;
    return { pts: run, score };
  };
  // every city has its railway; a small town only sometimes
  if (size >= 3 || (size === 2 && railRng.chance(0.7))) {
    let best = null;
    for (let k = 0; k < 32; k++) {
      const ang = field.base + (railRng.chance(0.5) ? Math.PI / 2 : 0) + railRng.range(-0.25, 0.25);
      const off = R * railRng.range(0.2, 0.75) * (railRng.chance(0.5) ? 1 : -1), bend = railRng.range(-0.00035, 0.00035);
      const cand = railCandidate(ang, off, bend);
      if (cand && (!best || cand.score < best.score)) best = cand;
    }
    // no line the city could live with: no railway
    if (best && best.score < 3000) {
      rail = { pts: best.pts };
      // the station: the dry point nearest downtown, clear of the water and the edge
      let bd = Infinity;
      rail.pts.forEach(([x, y], i) => {
        const d = Math.hypot(x - center.x, y - center.y);
        if (d >= bd || water.at(x, y) !== LAND || water.toRiver(x, y) < 30 || water.toSea(x, y) < 40 || x < 40 || y < 40 || x > W - 40 || y > H - 40) return;
        const a = rail.pts[Math.max(0, i - 2)], b = rail.pts[Math.min(rail.pts.length - 1, i + 2)];
        bd = d; station = { x, y, rot: Math.atan2(b[1] - a[1], b[0] - a[0]), platform: true };
      });
      field.addLine(rail.pts, 0.8, 22);
    }
  }
  // the tracks: a street of the other family may cross them, but none runs
  // alongside them too closely, and local streets stop at them
  const railStore = pointStore(12);
  if (rail) for (const q of resample(rail.pts, 3)) railStore.add(q[0], q[1], -1);

  // ---------- streets ----------
  const streetRng = makeRng(`${seed}:metro:streets`);
  const roads = [];
  const famStore = [pointStore(12), pointStore(12)];
  const allStore = pointStore(16);
  const dirAt = (x, y, fam) => {
    const [a, b] = field.at(x, y);
    if (a * a + b * b < 1e-8) return null;
    const phi = Math.atan2(b, a) / 2 + (fam ? Math.PI / 2 : 0);
    return [Math.cos(phi), Math.sin(phi)];
  };
  const aligned = (d, ref) => (d[0] * ref[0] + d[1] * ref[1] < 0 ? [-d[0], -d[1]] : d);
  const rk4 = (x, y, fam, ref, h) => {
    let k1 = dirAt(x, y, fam); if (!k1) return null; k1 = aligned(k1, ref);
    let k2 = dirAt(x + k1[0] * h / 2, y + k1[1] * h / 2, fam); if (!k2) return k1; k2 = aligned(k2, k1);
    let k3 = dirAt(x + k2[0] * h / 2, y + k2[1] * h / 2, fam); if (!k3) return k1; k3 = aligned(k3, k1);
    let k4 = dirAt(x + k3[0] * h, y + k3[1] * h, fam); if (!k4) return k1; k4 = aligned(k4, k1);
    const dx = k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0], dy = k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1], m = Math.hypot(dx, dy) || 1;
    return [dx / m, dy / m];
  };
  const clipFrame = (x, y, nx, ny) => {
    let t = 1;
    if (nx < 0) t = Math.min(t, -x / (nx - x)); if (nx > W) t = Math.min(t, (W - x) / (nx - x));
    if (ny < 0) t = Math.min(t, -y / (ny - y)); if (ny > H) t = Math.min(t, (H - y) / (ny - y));
    return [clamp(x + (nx - x) * t, 0, W), clamp(y + (ny - y) * t, 0, H)];
  };
  // the railway in the street store (ref -1): nothing may run parallel along
  // it, and nothing joins it as if it were a street
  if (rail) {
    const rp = resample(rail.pts, 6);
    rp.forEach(([x, y], i) => {
      const a = rp[Math.max(0, i - 1)], b = rp[Math.min(rp.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
      allStore.add(x, y, -1, dx / m, dy / m);
    });
  }

  const trace = (seedPt, fam, P) => {
    const dtest = P.dtest[fam], halves = [[], []], self = pointStore(8), lag = Math.ceil(dtest * 2 / P.dstep);
    // the line may not come back on itself: a point counts once it is `lag`
    // steps behind on this half, or `lag` steps out from the seed on the other
    const selfNear = (x, y, side, i) => !!self.nearest(x, y, dtest * 0.9, (px, py, ref) => {
      const s = ref >= 100000 ? 1 : 0, k = ref % 100000;
      return s === side ? k < i - lag : k >= lag;
    });
    for (let side = 0; side < 2; side++) {
      let d = dirAt(seedPt[0], seedPt[1], fam); if (!d) return null;
      if (side) d = [-d[0], -d[1]];
      let x = seedPt[0], y = seedPt[1], prev = d, wet = 0;
      const pts = halves[side];
      for (let i = 0; i < 1800; i++) {
        const s = rk4(x, y, fam, prev, P.dstep); if (!s) break;
        if (s[0] * prev[0] + s[1] * prev[1] < 0.5) break; // a kink at a singular point
        const nx = x + s[0] * P.dstep, ny = y + s[1] * P.dstep;
        if (nx < 0 || ny < 0 || nx > W || ny > H) { pts.push(clipFrame(x, y, nx, ny)); break; }
        const w = water.at(nx, ny);
        if (w === SEA || (w === RIVER && !P.bridges)) break;
        if (w === RIVER) {
          // a bridge crosses the river; a road running down the channel stops at the bank
          // bridges cross nearly square-on, and never meet the railway mid-river
          if (++wet * P.dstep > riverWidth * 1.3 || railStore.near(nx, ny, 8)) {
            // no crossing here: back off the bank to where the shore road runs
            pts.length = Math.max(0, pts.length - wet + 1);
            while (pts.length && water.toRiver(pts[pts.length - 1][0], pts[pts.length - 1][1]) < RIVER_DRIVE - 3) pts.pop();
            break;
          }
        } else wet = 0;
        if (!P.inside(nx, ny)) break;
        // the shore roads have the water's edge to themselves; local streets
        // end at the railway, main roads cross it
        if (water.toSea(nx, ny) < SEA_DRIVE - 5 || (!P.bridges && water.toRiver(nx, ny) < RIVER_DRIVE - 4)) break;
        if (!P.bridges && railStore.near(nx, ny, 6)) break;
        if (famStore[fam].near(nx, ny, dtest)) break;
        // where two grids meet at right angles the families swap, so a street
        // of the other family can lie right here, running the same way
        if (allStore.parallel(nx, ny, dtest * 0.6, s[0], s[1])) break;
        if (selfNear(nx, ny, side, pts.length)) break;
        self.add(nx, ny, side * 100000 + pts.length);
        pts.push([nx, ny]);
        x = nx; y = ny; prev = s;
      }
      // a street never ends in the river: one that stopped part way across
      // backs off to the bank it came from
      if (wet) {
        const last = () => pts[pts.length - 1];
        while (pts.length && water.at(last()[0], last()[1]) === RIVER) pts.pop();
        while (pts.length && water.toRiver(last()[0], last()[1]) < RIVER_DRIVE - 3) pts.pop();
      }
    }
    const line = [...halves[1].reverse(), seedPt, ...halves[0]];
    if (pathLength(line) < P.minLen) return null;
    return { pts: line, cls: P.name, fam };
  };

  const accept = (road) => {
    road.index = roads.length; roads.push(road);
    const p = road.pts;
    p.forEach(([x, y], i) => {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
      famStore[road.fam].add(x, y, road.index); allStore.add(x, y, road.index, dx / m, dy / m);
    });
  };

  const joinEnds = (road, P) => {
    for (const end of [0, 1]) {
      const pts = road.pts, n = pts.length;
      if (n < 2) continue;
      const e = end ? pts[n - 1] : pts[0], q = end ? pts[n - 2] : pts[1];
      if (e[0] <= 0.01 || e[1] <= 0.01 || e[0] >= W - 0.01 || e[1] >= H - 0.01) continue; // left the map
      // another street already joined this end
      if (allStore.nearest(e[0], e[1], 1.5, (x, y, ref) => ref >= 0 && ref !== road.index)) continue;
      const dx = e[0] - q[0], dy = e[1] - q[1], m = Math.hypot(dx, dy) || 1, ux = dx / m, uy = dy / m;
      // only a street nearly straight ahead: a sharp dog-leg reads as a mistake
      const hit = allStore.nearest(e[0], e[1], P.lookahead, (x, y, ref) => {
        if (ref < 0 || ref === road.index) return false;
        const vx = x - e[0], vy = y - e[1], d = Math.hypot(vx, vy);
        return d > 0.5 && (vx * ux + vy * uy) / d > 0.72;
      });
      if (!hit) { road.dead = [...(road.dead || []), end]; continue; }
      // the connector is a straight join, so it never bridges water (a bridge
      // that skews across a river reads as a mistake), and a local street never
      // cuts across a big park or the railway to reach the far side
      let dry = true;
      for (let k = 1; k < 10; k++) {
        const x = e[0] + (hit.x - e[0]) * k / 10, y = e[1] + (hit.y - e[1]) * k / 10, w = water.at(x, y);
        if (w === SEA || w === RIVER || (P.name === 'local' && inBigPark(x, y)) || (!P.bridges && railStore.near(x, y, 4.5))) { dry = false; break; }
      }
      if (!dry) { road.dead = [...(road.dead || []), end]; continue; }
      if (end) pts.push([hit.x, hit.y]); else pts.unshift([hit.x, hit.y]);
      allStore.add(hit.x, hit.y, road.index);
    }
  };

  const atFrame = ([x, y]) => x <= 0.5 || y <= 0.5 || x >= W - 0.5 || y >= H - 0.5;

  /** Highways out of town: an arterial that stops at the edge of town while
   *  heading away from the centre runs on to the map's edge, turning gently
   *  outward, instead of wandering through the fields. It may bridge a river
   *  square-on, joins a road it meets, and gives up at the sea (the loose end
   *  is cut back later). */
  const runOut = (road, P) => {
    for (const end of [0, 1]) {
      const pts = road.pts, n = pts.length;
      if (n < 2) continue;
      const e = end ? pts[n - 1] : pts[0], q = end ? pts[n - 2] : pts[1];
      if (atFrame(e) || ell(e[0], e[1]) < P.extent - 0.2) continue; // it stopped for another reason
      let dx = e[0] - q[0], dy = e[1] - q[1];
      const m = Math.hypot(dx, dy) || 1, rl = Math.hypot(e[0] - center.x, e[1] - center.y) || 1;
      dx /= m; dy /= m;
      if ((dx * (e[0] - center.x) + dy * (e[1] - center.y)) / rl < 0.3) continue; // heading round the town, not out of it
      const ext = [];
      let x = e[0], y = e[1], wet = 0, ok = false;
      for (let i = 0; i < 400; i++) {
        const rx = x - center.x, ry = y - center.y, r = Math.hypot(rx, ry) || 1;
        dx = dx * 0.94 + rx / r * 0.06; dy = dy * 0.94 + ry / r * 0.06;
        const dm = Math.hypot(dx, dy) || 1; dx /= dm; dy /= dm;
        const nx = x + dx * 6, ny = y + dy * 6;
        if (nx < 0 || ny < 0 || nx > W || ny > H) { ext.push(clipFrame(x, y, nx, ny)); ok = true; break; }
        const w = water.at(nx, ny);
        if (w === SEA || water.toSea(nx, ny) < SEA_DRIVE - 5) break;
        if (w === RIVER) { if (++wet * 6 > riverWidth * 1.3 || railStore.near(nx, ny, 8)) break; } else wet = 0;
        const hit = !wet && allStore.nearest(nx, ny, 8, (px, py, ref) => ref >= 0 && ref !== road.index);
        if (hit) { ext.push([hit.x, hit.y]); ok = true; break; }
        ext.push([nx, ny]); x = nx; y = ny;
      }
      if (!ok) continue;
      if (end) pts.push(...ext); else pts.unshift(...ext.reverse());
      ext.forEach(([px, py], i) => {
        const a = ext[Math.max(0, i - 1)], b = ext[Math.min(ext.length - 1, i + 1)], ddx = b[0] - a[0], ddy = b[1] - a[1], mm = Math.hypot(ddx, ddy) || 1;
        famStore[road.fam].add(px, py, road.index); allStore.add(px, py, road.index, ddx / mm, ddy / mm);
      });
      road.dead = (road.dead || []).filter((d) => d !== end);
    }
  };

  /** Every edge of the city's planar graph: streets, rail, the shore, the
   *  river banks and the map frame. Its faces are the blocks. */
  const graphLines = (streets) => {
    const lines = streets.map((r) => {
      const pts = r.pts.slice(), n = pts.length;
      // a small overshoot keeps T-junctions closed after resampling
      const ext = (a, b) => { const dx = a[0] - b[0], dy = a[1] - b[1], m = Math.hypot(dx, dy) || 1; return [a[0] + dx / m * 1.5, a[1] + dy / m * 1.5]; };
      if (n >= 2) { pts[0] = ext(pts[0], pts[1]); pts[n - 1] = ext(pts[n - 1], pts[n - 2]); }
      return { pts, cls: r.cls };
    });
    if (rail) lines.push({ pts: rail.pts, cls: 'rail' });
    if (water.sea) lines.push({ pts: water.sea.coast, cls: 'shore' });
    if (water.river) {
      const c = resample(water.river.pts, 6), half = water.river.width / 2 + 0.5;
      for (const sgn of [1, -1]) {
        lines.push({ cls: 'shore', pts: c.map((q, i) => {
          const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
          return [q[0] - dy / m * half * sgn, q[1] + dx / m * half * sgn];
        }) });
      }
    }
    lines.push({ pts: [[0, 0], [W, 0], [W, H], [0, H], [0, 0]], cls: 'edge' });
    return lines;
  };

  // shore roads go down first, so the streets that reach the water meet them
  for (const s of shoreDrives(water, ell)) {
    const mid = s.pts[s.pts.length >> 1], nb = s.pts[(s.pts.length >> 1) + 1] || s.pts[(s.pts.length >> 1) - 1];
    const d = dirAt(mid[0], mid[1], 0), tx = nb[0] - mid[0], ty = nb[1] - mid[1], m = Math.hypot(tx, ty) || 1;
    accept({ pts: s.pts, cls: 'collector', shore: s.shore, fam: d && Math.abs(d[0] * tx + d[1] * ty) / m > 0.7 ? 0 : 1 });
  }

  // big parks: once the main streets are down, one or two of the large
  // blocks they enclose near the centre are kept free of local streets
  const bigParks = [];
  const inBigPark = (x, y) => bigParks.some((bp) => x >= bp.x0 && x <= bp.x1 && y >= bp.y0 && y <= bp.y1 && pointIn(x, y, bp.poly));
  const pickBigParks = () => {
    const rng = makeRng(`${seed}:metro:bigparks`), want = size >= 4 ? 2 : size >= 3 ? 1 : 0;
    const scored = [];
    for (const f of planarFaces(graphLines(roads))) {
      const area = Math.abs(f.area), [cx, cy] = centroid(f.pts), e = ell(cx, cy);
      if (area < 4500 || area > 26000 || e < 0.2 || e > 1.15 || water.at(cx, cy) !== LAND || !pointIn(cx, cy, f.pts) || f.cls.includes('rail')) continue;
      const perim = pathLength([...f.pts, f.pts[0]]);
      if (area / (perim * perim) < 0.052 || f.cls.includes('shore')) continue; // a sliver or a wedge by the water, not a park
      scored.push({ f, cx, cy, score: Math.abs(e - 0.55) * 9000 + Math.abs(area - 12000) * 0.25 + rng.range(0, 1500) });
    }
    scored.sort((a, b) => a.score - b.score);
    for (const s of scored) {
      if (bigParks.length >= want) break;
      if (bigParks.some((bp) => Math.hypot(bp.cx - s.cx, bp.cy - s.cy) < 170)) continue;
      const xs = s.f.pts.map((q) => q[0]), ys = s.f.pts.map((q) => q[1]);
      bigParks.push({ poly: s.f.pts, cx: s.cx, cy: s.cy, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
  };

  for (const C of CLASSES) {
    if (C.name === 'local') pickBigParks();
    const P = { ...C, inside: (x, y) => (C.extent === Infinity || ell(x, y) < C.extent) && !(C.name === 'local' && inBigPark(x, y)) };
    const queue = [];
    const seedAlong = (road) => {
      const pts = road.pts;
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc < Math.min(...P.dsep) * 0.5) continue;
        acc = 0;
        const [x, y] = pts[i], tx = pts[i][0] - pts[i - 1][0], ty = pts[i][1] - pts[i - 1][1], tm = Math.hypot(tx, ty) || 1;
        const nx = -ty / tm, ny = tx / tm, d = P.dsep[road.fam];
        queue.push({ p: [x + nx * d, y + ny * d], fam: road.fam }, { p: [x - nx * d, y - ny * d], fam: road.fam }, { p: [x + nx * 2, y + ny * 2], fam: 1 - road.fam });
      }
    };
    if (C.name === 'arterial') queue.push({ p: [center.x, center.y], fam: 0 }, { p: [center.x, center.y], fam: 1 });
    for (const r of roads) seedAlong(r);
    const first = roads.length;
    let tries = 0;
    for (let qi = 0; ; ) {
      let cand;
      if (qi < queue.length) cand = queue[qi++];
      else if (tries++ < P.tries) cand = { p: [streetRng.range(0, W), streetRng.range(0, H)], fam: streetRng.int(0, 1) };
      else break;
      const [x, y] = cand.p;
      if (x < 1 || y < 1 || x > W - 1 || y > H - 1 || water.at(x, y) !== LAND || !P.inside(x, y)) continue;
      if (water.toSea(x, y) < SEA_DRIVE - 5 || water.toRiver(x, y) < RIVER_DRIVE - 4 || railStore.near(x, y, 8)) continue;
      if (famStore[cand.fam].near(x, y, P.dsep[cand.fam])) continue;
      const road = trace(cand.p, cand.fam, P);
      if (!road) continue;
      accept(road); seedAlong(road);
    }
    for (let i = first; i < roads.length; i++) joinEnds(roads[i], P);
    if (C.name === 'arterial') for (let i = first; i < roads.length; i++) runOut(roads[i], P);
  }
  for (const road of roads) road.pts = resample(road.pts, 6);
  trimLooseEnds(roads, ell);

  // ---------- blocks: faces of the street graph ----------
  const faces = planarFaces(graphLines(roads));

  // ---------- districts ----------
  const distRail = (x, y) => {
    if (!rail) return Infinity;
    let best = Infinity;
    for (let i = 0; i < rail.pts.length; i += 2) best = Math.min(best, Math.hypot(rail.pts[i][0] - x, rail.pts[i][1] - y));
    return best;
  };
  const districtAt = (x, y) => {
    const e = ell(x, y), dw = water.distTo(x, y);
    if (dw < 40 && e < 1.5) return 'waterfront';
    if (distRail(x, y) < 70 && e > 0.5 && e < 1.6) return 'industrial';
    if (e < 0.42) return 'downtown';
    if (e < 1.0) return 'residential';
    if (e < 1.45) return 'suburban';
    return 'rural';
  };

  const blocks = [];
  for (const f of faces) {
    const [cx, cy] = centroid(f.pts);
    if (water.at(cx, cy) !== LAND || !pointIn(cx, cy, f.pts)) continue;
    // the strip between a shore road and the water is the promenade (drawn
    // with the water), not a block
    if (f.cls.includes('shore') && f.pts.every(([x, y]) => water.toSea(x, y) < SEA_DRIVE + 7 || water.toRiver(x, y) < RIVER_DRIVE + 6)) continue;
    const idx = simplifyRing(f.pts, 1);
    if (idx.length < 3) continue;
    const pts = idx.map((i) => f.pts[i]), off = idx.map((i) => INSET[f.cls[i]] ?? 3);
    // a sliver that pinches shut at full width still keeps its fat end; the
    // shortfall goes onto the building setbacks so nothing reaches the street
    let poly = null, short = 0;
    for (const k of [1, 0.75, 0.5]) { poly = inset(pts, off.map((d) => d * k)); if (poly) { short = (1 - k) * Math.max(...off); break; } }
    if (!poly) continue;
    const area = Math.abs(signedArea(poly));
    if (area < 40) continue;
    const touches = {};
    for (const c of f.cls) touches[c] = true;
    blocks.push({ poly, area, cx, cy, use: districtAt(cx, cy), touches, short });
  }

  // ---------- parks ----------
  const parkRng = makeRng(`${seed}:metro:parks`);
  const parks = [];
  for (const b of blocks) if (inBigPark(b.cx, b.cy)) b.park = 'big';
  const parkable = blocks.filter((b) => !b.park && ['downtown', 'residential', 'suburban'].includes(b.use) && b.area > 700 && b.area < 16000);
  const central = parkable.filter((b) => ell(b.cx, b.cy) < 0.75).sort((a, b) => (Math.abs(ell(a.cx, a.cy) - 0.3) * 4000 - Math.min(a.area, 6000)) - (Math.abs(ell(b.cx, b.cy) - 0.3) * 4000 - Math.min(b.area, 6000)))[0];
  if (central) { central.park = 'square'; parks.push(central); }
  parks.push(...blocks.filter((b) => b.park === 'big'));
  const want = 1 + Math.floor(size / 2) + parkRng.int(0, 1) + parks.length;
  for (let k = 0; k < 80 && parks.length < want; k++) {
    const b = parkable[parkRng.int(0, Math.max(0, parkable.length - 1))];
    if (!b || b.park || ell(b.cx, b.cy) > 1.35 || parks.some((q) => Math.hypot(q.cx - b.cx, q.cy - b.cy) < 120)) continue;
    b.park = 'park'; parks.push(b);
  }

  // ---------- lots and buildings ----------
  // dead-end streets were pruned from the block graph, so a block can still
  // hold one: no footprint may touch any street
  const ROAD_HALF = { arterial: 6.3, collector: 4.8, local: 3.6 };
  const segGrid = new Map(), SG = 16;
  for (const r of roads) for (let i = 1; i < r.pts.length; i++) {
    const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i], half = ROAD_HALF[r.cls];
    for (let gy = Math.floor((Math.min(ay, by) - half) / SG); gy <= Math.floor((Math.max(ay, by) + half) / SG); gy++)
      for (let gx = Math.floor((Math.min(ax, bx) - half) / SG); gx <= Math.floor((Math.max(ax, bx) + half) / SG); gx++) {
        const k = (gy + 64) * 4096 + gx + 64; let b = segGrid.get(k); if (!b) segGrid.set(k, b = []); b.push([ax, ay, bx, by, half]);
      }
  }
  const onStreet = (x, y) => (segGrid.get((Math.floor(y / SG) + 64) * 4096 + Math.floor(x / SG) + 64) || []).some(([ax, ay, bx, by, half]) => {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1, t = clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
    return Math.hypot(x - ax - dx * t, y - ay - dy * t) < half;
  });
  const touchesStreet = (poly) => {
    const [cx, cy] = centroid(poly);
    if (onStreet(cx, cy)) return true;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (onStreet(a[0], a[1]) || onStreet((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) return true;
    }
    return false;
  };
  const lotRng = makeRng(`${seed}:metro:lots`);
  const lots = [], buildings = [], candidates = [];
  for (const b of blocks) {
    if (b.park || b.use === 'rural') continue;
    const spec = LOTS[b.use];
    const pieces = [];
    subdivide(b.poly.map(([x, y]) => ({ x, y, o: true })), spec.target / Math.sqrt(density), lotRng, pieces);
    for (const piece of pieces) {
      if (!piece.some((v) => v.o)) continue; // no street frontage: a courtyard
      const lp = piece.map((v) => [v.x, v.y]);
      const larea = Math.abs(signedArea(lp));
      if (larea < spec.min * 0.6) continue;
      const box = orientedBox(lp);
      if (Math.min(box.w, box.h) < 3.5) continue;
      const lot = { poly: lp, ...box, use: b.use };
      lots.push(lot);
      if (!lotRng.chance(Math.min(1, spec.fill * density))) continue;
      let fp = inset(lp, piece.map((v) => (v.o ? spec.front + b.short : spec.side)));
      if (!fp) { const [mx, my] = centroid(lp), k = b.use === 'downtown' ? 0.9 : 0.72; fp = lp.map(([x, y]) => [mx + (x - mx) * k, my + (y - my) * k]); }
      const farea = Math.abs(signedArea(fp));
      if (farea < spec.min * 0.5 || touchesStreet(fp)) continue;
      const building = { poly: fp, ...orientedBox(fp), use: b.use, landmark: null, tone: lotRng.int(0, 2) };
      buildings.push(building);
      candidates.push({ lot, building, block: b, use: b.use, area: farea, ell: ell(building.x, building.y), touches: b.touches });
    }
  }

  // ---------- landmarks ----------
  const civic = makeRng(`${seed}:metro:civic`);
  const placeNames = makeRng(`${seed}:metro:names:places`);
  const near = (c, x, y) => Math.hypot(c.building.x - x, c.building.y - y);
  const KINDS = [
    ['cityhall', 1, 'civic', (c) => c.ell < 0.5 && c.area > 160, (c) => c.ell * 120 - Math.sqrt(c.area)],
    ['police', 2, 'civic', (c) => c.ell < 0.8, (c) => Math.abs(c.ell - 0.3) * 100 - (c.touches.arterial || c.touches.collector ? 12 : 0)],
    ['library', 2, 'civic', (c) => c.ell < 0.85, (c) => Math.abs(c.ell - 0.45) * 100 + civic.range(0, 6)],
    ['station', 2, 'civic', (c) => !!station && near(c, station.x, station.y) < 70, (c) => near(c, station.x, station.y)],
    ['hospital', 3, 'residential', (c) => c.use === 'residential' && c.area > 220, (c) => Math.abs(c.ell - 0.8) * 100 - Math.sqrt(c.area)],
    ['school', 1, 'residential', (c) => (c.use === 'residential' || c.use === 'suburban') && c.area > 120, (c) => Math.abs(c.ell - 1.05) * 100 - Math.sqrt(c.area) * 0.6],
    ['church', 1, 'residential', (c) => c.use === 'residential', (c) => Math.abs(c.ell - 0.65) * 100 + civic.range(0, 10)],
    ['diner', 1, 'downtown', (c) => c.ell > 0.45 && !!c.touches.arterial, (c) => Math.abs(c.ell - 0.9) * 100],
    ['gas', 1, 'suburban', (c) => c.ell > 0.6 && !!c.touches.arterial, (c) => Math.abs(c.ell - 1.3) * 100],
    ['motel', 1, 'suburban', (c) => c.ell > 0.95 && !!(c.touches.arterial || c.touches.collector), (c) => -c.ell * 40 + civic.range(0, 8)],
    ['marina', 1, 'waterfront', (c) => water.distTo(c.building.x, c.building.y) < 30, (c) => water.distTo(c.building.x, c.building.y) * 3 + c.ell * 30],
    ['warehouse', 2, 'industrial', (c) => c.use === 'industrial', (c) => distRail(c.building.x, c.building.y) + civic.range(0, 6)],
  ];
  const taken = [];
  for (const [kind, minSize, use, ok, score] of KINDS) {
    const name = landmarkNames[kind](placeNames); // drawn for every kind, so names never shift
    if (size < minSize) continue;
    if (kind === 'marina' && !water.sea && !water.river) continue;
    let best = null, bs = Infinity;
    for (const c of candidates) {
      if (c.building.landmark || !ok(c) || taken.some((t) => Math.hypot(t.x - c.building.x, t.y - c.building.y) < 28)) continue;
      const s = score(c);
      if (s < bs) { bs = s; best = c; }
    }
    if (!best) continue;
    const b = best.building, grown = inset(best.lot.poly, best.lot.poly.map(() => 1));
    if (grown && !touchesStreet(grown)) Object.assign(b, { poly: grown, ...orientedBox(grown) });
    Object.assign(b, { use, landmark: name, landmarkKind: kind });
    taken.push({ x: b.x, y: b.y });
  }

  // ---------- waterfront piers ----------
  const piers = [], boats = [];
  const marina = buildings.find((b) => b.landmarkKind === 'marina');
  if (marina) {
    const dockRng = makeRng(`${seed}:metro:docks`);
    let dir = null;
    for (let k = 0; k < 24 && !dir; k++) {
      for (let r = 4; r < 90; r += 3) {
        const a = k / 24 * TAU, x = marina.x + Math.cos(a) * r, y = marina.y + Math.sin(a) * r;
        if (water.at(x, y) !== LAND) { if (!dir || r < dir.r) dir = { a, r, x, y }; break; }
      }
    }
    if (dir) {
      const ux = Math.cos(dir.a), uy = Math.sin(dir.a), len = water.sea ? dockRng.range(22, 40) : riverWidth * 0.38;
      for (let k = -1.5; k <= 1.5; k++) {
        const x0 = dir.x - uy * k * 12, y0 = dir.y + ux * k * 12;
        if (water.at(x0 + ux * 3, y0 + uy * 3) === LAND) continue;
        piers.push({ x0, y0, x1: x0 + ux * len, y1: y0 + uy * len });
        if (dockRng.chance(0.7)) boats.push({ x: x0 + ux * len * 0.6 - uy * 6, y: y0 + uy * len * 0.6 + ux * 6, rot: dir.a });
      }
    }
  }

  // ---------- bridges and dead ends ----------
  const bridges = [], culdesacs = [];
  const findBridges = (pts, cls) => {
    for (let i = 1; i < pts.length; i++) {
      if (water.at(...pts[i - 1]) === RIVER || water.at(...pts[i]) !== RIVER) continue;
      let k = i; while (k < pts.length - 1 && water.at(...pts[k]) === RIVER) k++;
      bridges.push({ a: pts[i - 1], b: pts[k], cls });
      i = k;
    }
  };
  for (const r of roads) if (r.cls !== 'local') findBridges(r.pts, r.cls);
  if (rail) findBridges(rail.pts, 'rail');
  // a turning circle needs room: never on another road, the railway or a bank
  const clearOfRoads = (r, [x, y]) => roads.every((o) => o === r || o.pts.every(([px, py]) => (px - x) ** 2 + (py - y) ** 2 > 144))
    && !railStore.near(x, y, 12);
  for (const r of roads) {
    if (r.cls !== 'local' || !r.dead) continue;
    for (const end of r.dead) {
      const q = end ? r.pts[r.pts.length - 1] : r.pts[0];
      if (ell(q[0], q[1]) > 0.9 && water.distTo(q[0], q[1]) > 20 && clearOfRoads(r, q)) culdesacs.push({ x: q[0], y: q[1] });
    }
  }

  // ---------- names ----------
  const streetNames = makeRng(`${seed}:metro:names:streets`);
  const streets = [], trees = [...TREES], people = [...SURNAMES];
  const takeFrom = (list) => list.splice(streetNames.int(0, list.length - 1), 1)[0] || streetNames.pick(TREES);
  const toCenter = (r) => Math.min(...r.pts.map((q) => Math.hypot(q[0] - center.x, q[1] - center.y)));
  const main = roads.filter((r) => r.cls === 'arterial').sort((a, b) => toCenter(a) - toCenter(b))[0];
  let localIx = 0;
  // every stretch of one shore road shares one name (and one GM rename)
  const shoreNames = makeRng(`${seed}:metro:names:shore`);
  const bankA = shoreNames.int(0, RIVER_ROADS.length - 1), bankB = (bankA + 1 + shoreNames.int(0, RIVER_ROADS.length - 2)) % RIVER_ROADS.length;
  const shoreName = { sea: shoreNames.pick(SEA_ROADS), 'river-a': RIVER_ROADS[bankA], 'river-b': RIVER_ROADS[bankB] }, shoreIndex = {};
  for (const road of roads) {
    let name = null;
    const len = pathLength(road.pts);
    if (road.shore) {
      if (shoreIndex[road.shore] === undefined) { shoreIndex[road.shore] = streets.length; streets.push(shoreName[road.shore]); }
      road.name = shoreName[road.shore]; road.nameIndex = shoreIndex[road.shore];
      continue;
    }
    if (road === main) name = 'Main Street';
    else if (road.cls === 'arterial') name = `${takeFrom(people)} ${streetNames.pick(['Avenue', 'Boulevard', 'Avenue'])}`;
    else if (road.cls === 'collector' && len > 90) name = `${takeFrom(trees)} ${streetNames.pick(['Avenue', 'Street', 'Street'])}`;
    else if (road.cls === 'local' && len > 150 && localIx++ % 3 === 0) name = `${takeFrom(trees)} ${streetNames.pick(LOCAL_SUFFIX)}`;
    if (name) { road.name = name; road.nameIndex = streets.length; streets.push(name); }
  }
  const districtNames = makeRng(`${seed}:metro:names:districts`);
  const DISTRICT_NAMES = {
    downtown: () => 'Downtown',
    residential: (r) => r.pick([`${r.pick(TREES)} Heights`, `${r.pick(SURNAMES)} Park`, 'Old Town', `${r.pick(PLACE_WORDS)}side`]),
    suburban: (r) => r.pick([`${r.pick(TREES)} Estates`, `${r.pick(PLACE_WORDS)} Meadows`, `${r.pick(TREES)}wood`, `${r.pick(SURNAMES)} Acres`]),
    industrial: (r) => r.pick([`${r.pick(PLACE_WORDS)} Industrial Park`, 'The Rail Yards', `${r.pick(SURNAMES)} Works`]),
    civic: () => 'Civic Center',
    parkland: (r) => `${r.pick(SURNAMES)} Park`,
    waterfront: (r) => r.pick(['The Waterfront', 'Harborside', `${r.pick(PLACE_WORDS)} Landing`]),
  };
  const parkModels = parks.map((b) => ({ poly: b.poly, ...orientedBox(b.poly), kind: b.park }));
  const featureRng = makeRng(`${seed}:metro:bigparks:features`);
  for (const park of parkModels) if (park.kind === 'big') Object.assign(park, parkFeatures(park.poly, featureRng));
  const districts = [];
  for (const use of ['downtown', 'residential', 'suburban', 'industrial', 'civic', 'parkland', 'waterfront']) {
    const name = DISTRICT_NAMES[use](districtNames);
    const mine = use === 'parkland' ? parkModels : buildings.filter((b) => b.use === use);
    if (mine.length < (use === 'civic' || use === 'parkland' ? 1 : 3)) continue;
    // label on one of the district's own buildings nearest its middle, so a
    // ring of suburbs never puts its name downtown
    const mx = mine.reduce((s, b) => s + b.x, 0) / mine.length, my = mine.reduce((s, b) => s + b.y, 0) / mine.length;
    const anchor = mine.reduce((best, b) => (Math.hypot(b.x - mx, b.y - my) < Math.hypot(best.x - mx, best.y - my) ? b : best), mine[0]);
    districts.push({ use, name, cx: anchor.x, cy: anchor.y, count: mine.length });
  }
  let bigIx = 0;
  parkModels.forEach((park, i) => {
    if (park.kind === 'big') park.name = bigIx++ === 0 && size >= 3 ? 'Central Park' : `${takeFrom(people)} Park`;
    else park.name = i === 0 && park.kind === 'square' ? `${takeFrom(people)} Square` : `${takeFrom(trees)} Park`;
  });

  // ---------- heights ----------
  // storeys, for the shadows that give the map its depth: towers downtown,
  // falling away to houses at the edge; landmarks by what they are
  const heightRng = makeRng(`${seed}:metro:heights`);
  const LANDMARK_LEVELS = { cityhall: 7, police: 3, library: 3, station: 3, hospital: 9, school: 3, church: 4, diner: 1, gas: 1, motel: 2, marina: 1, warehouse: 2 };
  for (const b of buildings) {
    const e = ell(b.x, b.y), r = heightRng();
    let levels;
    if (b.landmarkKind) levels = LANDMARK_LEVELS[b.landmarkKind] || 2;
    else if (b.use === 'downtown') levels = Math.round((5 + 40 * Math.pow(1 - clamp(e / 0.5, 0, 1), 1.3)) * (0.5 + r * r)) + 2;
    else if (b.use === 'residential') levels = 2 + Math.floor(r * (e < 0.7 ? 6 : 3));
    else if (b.use === 'waterfront') levels = 2 + Math.floor(r * 5);
    else if (b.use === 'industrial') levels = 1 + Math.floor(r * 3);
    else levels = 1 + (r < 0.3 ? 1 : 0);
    b.levels = levels;
  }

  // ---------- GM overrides, strictly after every stream ----------
  buildings.filter((b) => b.landmark).forEach((b, i) => { b.label = String(map.placeNames?.[i] || '').trim() || b.landmark; });
  for (const road of roads) if (road.name) road.label = String(map.streetNames?.[road.nameIndex] || '').trim() || road.name;

  return {
    era: 'modern', generation: map.params?.generation || '1.8', layout: 'tensor', size, center, angle: field.base, R,
    roads: roads.map(({ pts, cls, name, nameIndex, label }) => ({ pts, cls, ...(name ? { name, nameIndex, label } : {}) })),
    culdesacs, rail, station, bridges, parks: parkModels, fields: [], lots, parking: [], buildings, piers, boats,
    districts, streets,
    water: { kind: 'metro', sea: water.sea ? { poly: water.sea.poly, coast: water.sea.coast, side: water.sea.side } : null, river: water.river },
    blocks: blocks.filter((b) => !b.park).map((b) => ({ poly: b.poly, use: b.use })),
    // how wide the strips the shore roads leave along the water are
    shoreBands: { sea: SEA_DRIVE - 4, river: RIVER_DRIVE - 3 },
  };
}

/** A big park's pond and footpaths. The pond is a lobed blob kept well
 *  inside the park, with a walk around it; the other paths cross the park
 *  between its longest sides, bowed to one side or the other until they
 *  clear the pond. */
function parkFeatures(poly, rng) {
  const [cx, cy] = centroid(poly), area = Math.abs(signedArea(poly));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  let pond = null;
  for (let tries = 0; tries < 6 && !pond; tries++) {
    const px = cx + rng.range(-0.18, 0.18) * bw, py = cy + rng.range(-0.18, 0.18) * bh, r = Math.sqrt(area) * rng.range(0.12, 0.17);
    const lobes = [rng.range(0, TAU), rng.range(0, TAU)], amp = [rng.range(0.1, 0.25), rng.range(0.05, 0.15)];
    const blob = [];
    for (let k = 0; k < 18; k++) {
      const a = k / 18 * TAU, rr = r * (1 + amp[0] * Math.cos(2 * a + lobes[0]) + amp[1] * Math.cos(3 * a + lobes[1]));
      blob.push([px + Math.cos(a) * rr * 1.25, py + Math.sin(a) * rr * 0.85]);
    }
    // the pond keeps a margin from every side of the park
    const inner = inset(poly, poly.map(() => 6));
    if (inner && blob.every(([x, y]) => pointIn(x, y, inner))) pond = { poly: blob, x: px, y: py, r };
  }
  const paths = [];
  // a path stays a few pixels clear of the pond's edge
  const wet = ([x, y]) => pond && Math.hypot((x - pond.x) / 1.25, (y - pond.y) / 0.85) < pond.r * 1.45;
  if (pond) {
    const loop = [];
    for (let k = 0; k <= 24; k++) { const a = k / 24 * TAU; loop.push([pond.x + Math.cos(a) * pond.r * 1.25 * 1.6, pond.y + Math.sin(a) * pond.r * 0.85 * 1.6]); }
    if (loop.every(([x, y]) => pointIn(x, y, poly))) paths.push(loop);
  }
  const sides = poly.map((a, i) => { const b = poly[(i + 1) % poly.length]; return { a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) }; })
    .sort((p, q) => q.len - p.len).slice(0, 4)
    .map(({ a, b }) => { const t = rng.range(0.35, 0.65); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; });
  for (const [i, j] of [[0, 1], [2, 3], [0, 2], [1, 3]]) {
    if (paths.length >= 3 || !sides[i] || !sides[j]) break;
    const s = sides[i], e = sides[j], dx = e[0] - s[0], dy = e[1] - s[1];
    if (Math.hypot(dx, dy) < 40) continue;
    for (const bend of [0.22, -0.22, 0.45, -0.45]) {
      const ctrl = [(s[0] + e[0]) / 2 - dy * bend, (s[1] + e[1]) / 2 + dx * bend], pts = [];
      for (let k = 0; k <= 16; k++) {
        const u = k / 16, v = 1 - u;
        pts.push([v * v * s[0] + 2 * v * u * ctrl[0] + u * u * e[0], v * v * s[1] + 2 * v * u * ctrl[1] + u * u * e[1]]);
      }
      // the ends sit on the park's edge; everything between stays inside
      if (pts.some(wet) || !pts.slice(1, -1).every(([x, y]) => pointIn(x, y, poly))) continue;
      paths.push(pts);
      break;
    }
  }
  // the park's name goes beside the pond, not on it
  let label = null;
  if (pond) for (const [ux, uy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const x = pond.x + ux * (pond.r * 1.25 + 34), y = pond.y + uy * (pond.r * 0.85 + 12);
    if (pointIn(x, y, poly)) { label = [x, y]; break; }
  }
  return { pond: pond?.poly || null, paths, ...(label ? { labelX: label[0], labelY: label[1] } : {}) };
}

/** Loose ends. A street that runs on past its last junction is cut back to
 *  it, unless what is left is a short stub (a cul-de-sac); a street left with
 *  no junction at all is dropped. Main roads are cut back only where they end
 *  out in the country. Cutting one street can leave another loose, so this
 *  repeats until nothing changes. Leaves road.dead listing the ends still
 *  loose (0 = start, 1 = end), for the cul-de-sacs. */
export function trimLooseEnds(roads, ell) {
  const STUB = { local: 30, collector: 40, arterial: 0 };
  const onFrame = ([x, y]) => x <= 0.5 || y <= 0.5 || x >= W - 0.5 || y >= H - 0.5;
  const CELL = 24, NUDGE = 2;
  const cumulative = (p) => { const c = [0]; for (let i = 1; i < p.length; i++) c.push(c[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])); return c; };
  const pointAt = (p, c, s) => {
    let i = 1; while (i < p.length - 1 && c[i] < s) i++;
    const t = clamp((s - c[i - 1]) / ((c[i] - c[i - 1]) || 1), 0, 1);
    return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
  };
  const cut = (p, c, s0, s1) => {
    const out = [pointAt(p, c, s0)];
    for (let i = 0; i < p.length; i++) if (c[i] > s0 + 0.01 && c[i] < s1 - 0.01) out.push(p[i]);
    out.push(pointAt(p, c, s1));
    return out;
  };
  // first, a street whose last stretch runs on top of another (two streets
  // that merged at a shallow angle) ends where it first meets that street
  {
    const grid = new Map();
    roads.forEach((r, ri) => { for (let i = 1; i < r.pts.length; i++) {
      const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i];
      for (let gy = Math.floor(Math.min(ay, by) / CELL); gy <= Math.floor(Math.max(ay, by) / CELL); gy++)
        for (let gx = Math.floor(Math.min(ax, bx) / CELL); gx <= Math.floor(Math.max(ax, bx) / CELL); gx++) {
          const k = (gy + 64) * 4096 + gx + 64; let b = grid.get(k); if (!b) grid.set(k, b = []); b.push([ri, ax, ay, bx, by]);
        }
    } });
    const onOther = (ri, [x, y]) => {
      for (let gy = Math.floor((y - 3) / CELL); gy <= Math.floor((y + 3) / CELL); gy++) for (let gx = Math.floor((x - 3) / CELL); gx <= Math.floor((x + 3) / CELL); gx++) {
        for (const [rj, ax, ay, bx, by] of grid.get((gy + 64) * 4096 + gx + 64) || []) {
          if (rj === ri) continue;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1, t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
          if (Math.hypot(x - ax - dx * t, y - ay - dy * t) < 3) return true;
        }
      }
      return false;
    };
    roads.forEach((r, ri) => {
      const p = r.pts;
      let a = 0, b = p.length - 1;
      while (a < b && onOther(ri, p[a]) && onOther(ri, p[a + 1])) a++;
      while (b > a && onOther(ri, p[b]) && onOther(ri, p[b - 1])) b--;
      if (a > 0 || b < p.length - 1) r.pts = p.slice(a, b + 1);
    });
    for (let i = roads.length - 1; i >= 0; i--) if (roads[i].pts.length < 2) roads.splice(i, 1);
  }
  let loose = [];
  for (let pass = 0; pass < 6; pass++) {
    const segs = [], buckets = new Map();
    roads.forEach((r, ri) => {
      const p = r.pts, n = p.length;
      for (let i = 0; i < n - 1; i++) {
        let [ax, ay] = p[i], [bx, by] = p[i + 1];
        const dx = bx - ax, dy = by - ay, m = Math.hypot(dx, dy) || 1;
        // ends reach a little past their last point, so a street that stops
        // on another registers as meeting it
        if (i === 0) { ax -= dx / m * NUDGE; ay -= dy / m * NUDGE; }
        if (i === n - 2) { bx += dx / m * NUDGE; by += dy / m * NUDGE; }
        const idx = segs.length;
        segs.push([ri, i, ax, ay, bx, by]);
        for (let gy = Math.floor(Math.min(ay, by) / CELL); gy <= Math.floor(Math.max(ay, by) / CELL); gy++)
          for (let gx = Math.floor(Math.min(ax, bx) / CELL); gx <= Math.floor(Math.max(ax, bx) / CELL); gx++) {
            const k = (gy + 64) * 4096 + gx + 64; let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(idx);
          }
      }
    });
    const cums = roads.map((r) => cumulative(r.pts)), junctions = roads.map(() => []), seen = new Set();
    const place = (ri, i, x, y) => {
      const p = roads[ri].pts, c = cums[ri], a = p[i], b = p[i + 1], len = c[i + 1] - c[i] || 1;
      const t = ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (len * len);
      junctions[ri].push(clamp(c[i] + t * len, 0, c[c.length - 1]));
    };
    for (const b of buckets.values()) for (let u = 0; u < b.length; u++) for (let v = u + 1; v < b.length; v++) {
      const s1 = segs[b[u]], s2 = segs[b[v]];
      if (s1[0] === s2[0]) continue;
      const key = Math.min(b[u], b[v]) * 1e6 + Math.max(b[u], b[v]);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = segX(s1[2], s1[3], s1[4], s1[5], s2[2], s2[3], s2[4], s2[5]);
      if (!hit) continue;
      place(s1[0], s1[1], hit.x, hit.y); place(s2[0], s2[1], hit.x, hit.y);
    }
    let changed = false;
    loose = roads.map(() => []);
    const drop = new Set();
    roads.forEach((r, ri) => {
      const p = r.pts, c = cums[ri], L = c[c.length - 1], J = junctions[ri].sort((a, b) => a - b);
      if (!J.length) {
        if (!(r.cls === 'arterial' && onFrame(p[0]) && onFrame(p[p.length - 1]))) { drop.add(ri); changed = true; }
        return;
      }
      const limit = STUB[r.cls] ?? 30;
      // out in the country a main road may not simply stop; in town it may
      const mayCut = (pt) => r.cls !== 'arterial' || ell(pt[0], pt[1]) > 1.4;
      let s0 = 0, s1 = L;
      if (!onFrame(p[0]) && J[0] > 2) { if (J[0] > limit + 2 && mayCut(p[0])) s0 = J[0]; else loose[ri].push(0); }
      if (!onFrame(p[p.length - 1]) && L - J[J.length - 1] > 2) { if (L - J[J.length - 1] > limit + 2 && mayCut(p[p.length - 1])) s1 = J[J.length - 1]; else loose[ri].push(1); }
      // what is left must still be a street, not a scrap between two others
      if (s1 - s0 < (r.cls === 'arterial' ? 6 : 18)) { drop.add(ri); changed = true; return; }
      if (s0 > 0 || s1 < L) { r.pts = cut(p, c, s0, s1); changed = true; }
    });
    if (drop.size) { const keep = roads.filter((_, i) => !drop.has(i)); loose = loose.filter((_, i) => !drop.has(i)); roads.length = 0; roads.push(...keep); }
    if (!changed) break;
  }
  roads.forEach((r, i) => { r.dead = loose[i] || []; });
}

/** Faces of the planar graph made by a set of polylines: every crossing is a
 *  node, dangling pieces are pruned, and each face is walked by always taking
 *  the next edge around the node. Returns [{ pts, cls }] where cls[i] is the
 *  class of the edge leaving pts[i]. */
export function planarFaces(lines) {
  const segs = [];
  lines.forEach((L, li) => { for (let si = 0; si < L.pts.length - 1; si++) segs.push([li, si]); });
  const CELL = 24, buckets = new Map();
  segs.forEach(([li, si], idx) => {
    const [ax, ay] = lines[li].pts[si], [bx, by] = lines[li].pts[si + 1];
    for (let gy = Math.floor((Math.min(ay, by) + 128) / CELL); gy <= Math.floor((Math.max(ay, by) + 128) / CELL); gy++)
      for (let gx = Math.floor((Math.min(ax, bx) + 128) / CELL); gx <= Math.floor((Math.max(ax, bx) + 128) / CELL); gx++) {
        const k = gy * 4096 + gx; let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(idx);
      }
  });
  const nodes = [], nodeKey = new Map();
  const nodeAt = (x, y) => {
    const kx = Math.round(x * 2), ky = Math.round(y * 2);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const id = nodeKey.get((ky + dy) * 100000 + kx + dx);
      if (id !== undefined && Math.hypot(nodes[id][0] - x, nodes[id][1] - y) < 0.8) return id;
    }
    nodes.push([x, y]); nodeKey.set(ky * 100000 + kx, nodes.length - 1);
    return nodes.length - 1;
  };
  const splits = lines.map(() => []);
  const seen = new Set();
  for (const b of buckets.values()) {
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
      const s1 = segs[b[i]], s2 = segs[b[j]];
      if (s1[0] === s2[0]) {
        const L = lines[s1[0]], n = L.pts.length - 1, d = Math.abs(s1[1] - s2[1]);
        const closed = L.pts[0][0] === L.pts[n][0] && L.pts[0][1] === L.pts[n][1];
        if (d <= 1 || (closed && d === n - 1)) continue;
      }
      const key = Math.min(b[i], b[j]) * 1e6 + Math.max(b[i], b[j]);
      if (seen.has(key)) continue;
      seen.add(key);
      const A = lines[s1[0]].pts, B = lines[s2[0]].pts;
      const r = segX(A[s1[1]][0], A[s1[1]][1], A[s1[1] + 1][0], A[s1[1] + 1][1], B[s2[1]][0], B[s2[1]][1], B[s2[1] + 1][0], B[s2[1] + 1][1]);
      if (!r) continue;
      const id = nodeAt(r.x, r.y);
      splits[s1[0]].push({ pos: s1[1] + r.t, id });
      splits[s2[0]].push({ pos: s2[1] + r.u, id });
    }
  }
  const edges = [];
  lines.forEach((L, li) => {
    const n = L.pts.length;
    splits[li].push({ pos: 0, id: nodeAt(L.pts[0][0], L.pts[0][1]) }, { pos: n - 1, id: nodeAt(L.pts[n - 1][0], L.pts[n - 1][1]) });
    const sp = splits[li].sort((p, q) => p.pos - q.pos);
    for (let k = 1; k < sp.length; k++) {
      const s0 = sp[k - 1], s1 = sp[k];
      if (s0.id === s1.id) continue;
      const g = [nodes[s0.id]];
      for (let v = Math.floor(s0.pos) + 1; v < s1.pos; v++) if (v > s0.pos) g.push(L.pts[v]);
      g.push(nodes[s1.id]);
      edges.push({ a: s0.id, b: s1.id, pts: g, cls: L.cls });
    }
  });
  // prune dangling edges
  const deg = new Int32Array(nodes.length), incident = nodes.map(() => []), alive = edges.map(() => true);
  edges.forEach((e, i) => { deg[e.a]++; deg[e.b]++; incident[e.a].push(i); incident[e.b].push(i); });
  const stack = [];
  for (let v = 0; v < nodes.length; v++) if (deg[v] === 1) stack.push(v);
  const prune = () => {
    while (stack.length) {
      const v = stack.pop();
      if (deg[v] !== 1) continue;
      for (const i of incident[v]) {
        if (!alive[i]) continue;
        alive[i] = false; deg[edges[i].a]--; deg[edges[i].b]--;
        const o = edges[i].a === v ? edges[i].b : edges[i].a;
        if (deg[o] === 1) stack.push(o);
      }
    }
  };
  prune();
  // half-edges 2i (a->b) and 2i+1 (b->a), sorted by angle around each node;
  // each face is walked by taking the next half-edge around its end node
  const target = (h) => (h & 1 ? edges[h >> 1].a : edges[h >> 1].b);
  const walk = () => {
    const out = nodes.map(() => []);
    // an edge leaves its node in the direction of its first point that is
    // clearly apart from the node (crossings can sit a hair from a vertex)
    const leaving = (p, from, step) => {
      const [x0, y0] = p[from];
      for (let k = from + step; k >= 0 && k < p.length; k += step) {
        const dx = p[k][0] - x0, dy = p[k][1] - y0;
        if (dx * dx + dy * dy > 0.25 || k === 0 || k === p.length - 1) return Math.atan2(dy, dx);
      }
      return 0;
    };
    edges.forEach((e, i) => {
      if (!alive[i]) return;
      out[e.a].push({ h: 2 * i, ang: leaving(e.pts, 0, 1) });
      out[e.b].push({ h: 2 * i + 1, ang: leaving(e.pts, e.pts.length - 1, -1) });
    });
    const pos = new Int32Array(edges.length * 2);
    out.forEach((list) => { list.sort((a, b) => a.ang - b.ang); list.forEach((o, k) => { pos[o.h] = k; }); });
    const faceOf = new Int32Array(edges.length * 2).fill(-1), found = [];
    for (let i = 0; i < edges.length; i++) {
      if (!alive[i]) continue;
      for (const h0 of [2 * i, 2 * i + 1]) {
        if (faceOf[h0] >= 0) continue;
        const pts = [], cls = [], id = found.length;
        let h = h0, guard = 0;
        while (faceOf[h] < 0 && guard++ < 20000) {
          faceOf[h] = id;
          const e = edges[h >> 1], g = h & 1 ? [...e.pts].reverse() : e.pts;
          for (let k = 0; k < g.length - 1; k++) { pts.push(g[k]); cls.push(e.cls); }
          const v = target(h), list = out[v], k = pos[h ^ 1];
          h = list[(k - 1 + list.length) % list.length].h;
        }
        found.push({ pts, cls, area: signedArea(pts), closed: h === h0 });
      }
    }
    return { found, faceOf };
  };
  let faces = [];
  for (let round = 0; round < 6; round++) {
    const { found, faceOf } = walk();
    faces = found.filter((f) => f.closed && f.pts.length >= 3);
    // a bridge has the same face on both sides; it would make that face
    // double back on itself, so take it out and walk again
    let bridges = 0;
    for (let i = 0; i < edges.length; i++) {
      if (!alive[i] || faceOf[2 * i] !== faceOf[2 * i + 1]) continue;
      alive[i] = false; deg[edges[i].a]--; deg[edges[i].b]--; bridges++;
      for (const v of [edges[i].a, edges[i].b]) if (deg[v] === 1) stack.push(v);
    }
    if (!bridges) break;
    prune();
  }
  // bounded faces share one orientation; the outer face runs the other way
  const pos2 = faces.filter((f) => f.area > 0).length;
  const sign = pos2 >= faces.length - pos2 ? 1 : -1;
  return faces.filter((f) => Math.sign(f.area) === sign && Math.abs(f.area) > 20 && Math.abs(f.area) < W * H * 0.6);
}
