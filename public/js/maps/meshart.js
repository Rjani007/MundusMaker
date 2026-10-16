// Terrain style drawing (1.9.1). In the spirit of mapgen4's look: color from a
// two-way lookup of elevation and rainfall, light from the north-west across
// the interpolated mesh, and rivers whose width follows their flow. Everything
// is drawn from the model; nothing here draws from an RNG, so screen, PNG and
// PDF agree at every scale.

import { clamp } from '../util.js';
import { terrainRaster, HEIGHT_SPAN } from './meshterrain.js';
import { drawMapLabels } from './cartography.js';

const W = 960, H = 600, TAU = Math.PI * 2;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const DEEP = [34, 66, 112], SHALLOW = [92, 146, 180], LAKE = [104, 156, 190];
const DRY = [224, 207, 160], STEPPE = [196, 192, 130], GRASS = [134, 170, 98], WET = [72, 128, 82];
const ROCK = [160, 150, 134], SNOW = [246, 246, 244], TUNDRA = [208, 210, 196];
const SILT = [112, 152, 84], SCREE = [138, 128, 116];
const NATION_INK = 'rgba(112, 44, 92, .62)';

// The colormap is a lookup table built once, like mapgen4's colormap texture:
// land by elevation (EB bins) and rainfall (MB bins), sea by depth.
const EB = 256, MB = 64;
const LAND = new Uint8ClampedArray(EB * MB * 3), SEA = new Uint8ClampedArray(EB * 3);
for (let ei = 0; ei < EB; ei++) {
  const e = ei / (EB - 1);
  for (let mi = 0; mi < MB; mi++) {
    const m = mi / (MB - 1);
    let c = m < 0.35 ? mix(DRY, STEPPE, m / 0.35) : m < 0.65 ? mix(STEPPE, GRASS, (m - 0.35) / 0.3) : mix(GRASS, WET, (m - 0.65) / 0.35);
    c = mix(c, ROCK, smoothstep(0.32, 0.62, e) * 0.85);
    c = mix(c, SNOW, smoothstep(0.66, 0.9, e));
    LAND.set(c, (ei * MB + mi) * 3);
  }
  SEA.set(mix(SHALLOW, DEEP, Math.sqrt(e)), ei * 3);
}

/** Separable box blur of radius r, with clamped edges. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[row + x] = acc / n; acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = acc / n; acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}

// marching-squares segments for each corner pattern (bit 8 = top left, then
// clockwise); edges 0 top, 1 right, 2 bottom, 3 left
const CASES = [[], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[0, 3], [2, 1]], [[0, 2]], [[0, 3]], [[0, 3]], [[0, 2]], [[0, 1], [3, 2]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []];

/** The lines where a gw x gh field crosses each of `levels`, as one Path2D
 *  per level in map coordinates, from a single pass over the field.
 *  Shorelines are traced on the relief raster itself, so at print sizes they
 *  are as fine as the shading rather than the 480 x 300 grid. */
function isolines(field, gw, gh, levels) {
  const paths = levels.map(() => new Path2D()), sx = W / gw, sy = H / gh;
  const lo = Math.min(...levels), hi = Math.max(...levels), px = [0, 0, 0, 0], py = [0, 0, 0, 0];
  for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) {
    const i = y * gw + x, a = field[i], b = field[i + 1], c = field[i + gw + 1], d = field[i + gw];
    const mn = Math.min(a, b, c, d), mx = Math.max(a, b, c, d);
    if (mx <= lo || mn > hi) continue;
    for (let l = 0; l < levels.length; l++) {
      const level = levels[l];
      if (mx <= level || mn > level) continue;
      const pairs = CASES[(a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0)];
      px[0] = x + (level - a) / (b - a || 1e-9); py[0] = y;
      px[1] = x + 1; py[1] = y + (level - b) / (c - b || 1e-9);
      px[2] = x + (level - d) / (c - d || 1e-9); py[2] = y + 1;
      px[3] = x; py[3] = y + (level - a) / (d - a || 1e-9);
      for (const [u, v] of pairs) { paths[l].moveTo((px[u] + 0.5) * sx, (py[u] + 0.5) * sy); paths[l].lineTo((px[v] + 0.5) * sx, (py[v] + 0.5) * sy); }
    }
  }
  return paths;
}

function drawTerrain(ctx, m, k) {
  const rw = Math.max(1, Math.round(W * k)), rh = Math.max(1, Math.round(H * k));
  const { E, M, L, D } = terrainRaster(m, rw, rh);
  // light falls on a slightly softened surface, so the mesh's triangles
  // shade as slopes rather than facets; colours still read the exact height
  const S = boxBlur(E, rw, rh, Math.max(1, Math.round(1.5 * k)));
  const img = ctx.createImageData(rw, rh), d = img.data;
  const slope = 50 * k / 2; // scale-invariant: the same light at every export size
  const lx = -0.62, ly = -0.62, lz = 0.48;
  for (let y = 0; y < rh; y++) {
    const lat = 1 - Math.abs((y + 0.5) / rh - 0.5) * 2;
    const up = Math.max(0, y - 1) * rw, down = Math.min(rh - 1, y + 1) * rw, row = y * rw;
    for (let x = 0; x < rw; x++) {
      const i = row + x, e = E[i], o = i * 4;
      if (e < 0) {
        const j = Math.min(EB - 1, (-e * (EB - 1)) | 0) * 3;
        d[o] = SEA[j]; d[o + 1] = SEA[j + 1]; d[o + 2] = SEA[j + 2]; d[o + 3] = 255;
        continue;
      }
      if (L && L[i] > 0.5) {
        // still water: a level surface, slightly darker toward the middle
        const t = Math.min(1, (L[i] - 0.5) * 2.5);
        d[o] = LAKE[0] - 22 * t; d[o + 1] = LAKE[1] - 18 * t; d[o + 2] = LAKE[2] - 8 * t; d[o + 3] = 255;
        continue;
      }
      const j = (Math.min(EB - 1, (e * (EB - 1)) | 0) * MB + Math.min(MB - 1, (M[i] * (MB - 1)) | 0)) * 3;
      let r = LAND[j], g = LAND[j + 1], b = LAND[j + 2];
      if (D) {
        // rain erosion: silt spreads fertile flats along the valleys, and
        // worn slopes show bare rock and scree
        const dv = D[i];
        if (dv > 0.004) { const t = Math.min(1, (dv - 0.004) / 0.04) * (0.25 + 0.3 * M[i]); r += (SILT[0] - r) * t; g += (SILT[1] - g) * t; b += (SILT[2] - b) * t; }
        else if (dv < -0.02) { const t = Math.min(1, (-dv - 0.02) / 0.12) * 0.3; r += (SCREE[0] - r) * t; g += (SCREE[1] - g) * t; b += (SCREE[2] - b) * t; }
      }
      const temp = lat * 1.12 - e * 0.5;
      if (temp < 0.24) { const t = (0.24 - Math.max(0, temp)) / 0.24 * 0.75; r += (TUNDRA[0] - r) * t; g += (TUNDRA[1] - g) * t; b += (TUNDRA[2] - b) * t; }
      const gx = (S[row + Math.min(rw - 1, x + 1)] - S[row + Math.max(0, x - 1)]) * slope;
      const gy = (S[down + x] - S[up + x]) * slope;
      const lit = (-gx * lx - gy * ly + lz) / Math.sqrt(1 + gx * gx + gy * gy) / lz;
      const shade = 0.62 + 0.38 * lit, s = shade < 0.55 ? 0.55 : shade > 1.22 ? 1.22 : shade;
      d[o] = r * s; d[o + 1] = g * s; d[o + 2] = b * s; d[o + 3] = 255;
    }
  }
  // shorelines are traced on the softened copy the light uses, so the
  // mesh's facets don't crinkle them
  return { img, S, L: L && boxBlur(L, rw, rh, Math.max(1, Math.round(k))), rw, rh };
}

/** River courses follow triangle centres, which zigzag at the scale of the
 *  mesh. Two passes of a [1 2 1] average take the zigzag out; sources, mouths
 *  and the points where a tributary joins stay where they are, so every
 *  river still meets the one it flows into. */
function smoothCourses(rivers) {
  const pinned = new Set();
  for (const r of rivers) { pinned.add(r.nodes[0]); pinned.add(r.nodes[r.nodes.length - 1]); }
  return rivers.map(({ pts, flows, nodes }) => {
    let cur = pts;
    for (let pass = 0; pass < 2; pass++) {
      cur = cur.map((p, i) => {
        if (i === 0 || i === cur.length - 1 || pinned.has(nodes[i])) return p;
        const a = cur[i - 1], b = cur[i + 1];
        return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
      });
    }
    return { pts: cur, flows };
  });
}

/** Rivers in one stroke per width band rather than one per segment. */
function drawRivers(ctx, m) {
  const { rivers, threshold } = m.terrain;
  const bands = new Map();
  for (const { pts, flows } of smoothCourses(rivers)) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = i ? [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2] : pts[0];
      const b = i < n - 1 ? [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2] : pts[n - 1];
      const width = Math.round(clamp(0.35 + Math.sqrt(flows[i] / threshold) * 0.62, 0.6, 4.2) * 5) / 5;
      let path = bands.get(width);
      if (!path) bands.set(width, path = new Path2D());
      path.moveTo(a[0], a[1]); path.quadraticCurveTo(pts[i][0], pts[i][1], b[0], b[1]);
    }
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#4f86b4';
  for (const [width, path] of [...bands].sort((p, q) => p[0] - q[0])) { ctx.lineWidth = width; ctx.stroke(path); }
}

/** Nation frontiers as smooth polylines: the cell edges between different
 *  owners are chained from junction to junction (or around a loop), then the
 *  staircase is averaged away with the junctions pinned, so frontiers still
 *  meet. Returns polylines in grid-corner units. */
function frontierLines(owner, gw, gh) {
  const W1 = gw + 1, adj = new Map();
  const link = (a, b) => {
    let la = adj.get(a); if (!la) adj.set(a, la = []); la.push(b);
    let lb = adj.get(b); if (!lb) adj.set(b, lb = []); lb.push(a);
  };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x, a = owner[i];
    if (a < 0) continue;
    if (x + 1 < gw && owner[i + 1] >= 0 && owner[i + 1] !== a) link(y * W1 + x + 1, (y + 1) * W1 + x + 1);
    if (y + 1 < gh && owner[i + gw] >= 0 && owner[i + gw] !== a) link((y + 1) * W1 + x, (y + 1) * W1 + x + 1);
  }
  const used = new Set(), ekey = (a, b) => (a < b ? a * 1e6 + b : b * 1e6 + a);
  const walk = (start, nextNode) => {
    const line = [start];
    let prev = start, cur = nextNode;
    used.add(ekey(prev, cur));
    for (;;) {
      line.push(cur);
      const nb = adj.get(cur);
      if (nb.length !== 2 || cur === start) break;
      const nxt = nb[0] === prev ? nb[1] : nb[0];
      if (used.has(ekey(cur, nxt))) break;
      used.add(ekey(cur, nxt));
      prev = cur; cur = nxt;
    }
    return line;
  };
  const lines = [];
  const nodes = [...adj.keys()].sort((a, b) => a - b);
  for (const n of nodes) if (adj.get(n).length !== 2) for (const m of adj.get(n)) if (!used.has(ekey(n, m))) lines.push(walk(n, m));
  for (const n of nodes) for (const m of adj.get(n)) if (!used.has(ekey(n, m))) lines.push(walk(n, m));
  return lines.filter((l) => l.length > 2).map((line) => {
    let pts = line.map((k) => [k % W1, Math.floor(k / W1)]);
    for (let pass = 0; pass < 4; pass++) {
      pts = pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p
        : [(pts[i - 1][0] + 2 * p[0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * p[1] + pts[i + 1][1]) / 4]));
    }
    return pts;
  });
}

function drawFrontiers(ctx, m, sx, sy) {
  const path = new Path2D();
  for (const line of frontierLines(m.owner, m.gw, m.gh)) {
    path.moveTo(line[0][0] * sx, line[0][1] * sy);
    for (let i = 1; i < line.length; i++) path.lineTo(line[i][0] * sx, line[i][1] * sy);
  }
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(112, 44, 92, .14)'; ctx.lineWidth = 4; ctx.stroke(path);
  ctx.strokeStyle = NATION_INK; ctx.lineWidth = 1.1; ctx.setLineDash([6, 2.5, 1.5, 2.5]); ctx.stroke(path);
  ctx.restore();
}

function drawSettlement(ctx, x, y, t) {
  const r = t.capital ? 4.6 : t.size >= 2 ? 3.4 : 2.6;
  ctx.fillStyle = '#fbf6ea'; ctx.strokeStyle = '#2f2a25'; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
  if (t.capital) { ctx.fillStyle = '#7a3a34'; ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill(); }
}

export function renderTerrainMap(map, m, scale = 1) {
  const p = { ...m.params, ...(map.params || {}) };
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d');

  // the relief is rasterized at up to 2x; larger prints upsample it smoothly.
  // While a brush gesture is still going it is drawn at half size, so painting
  // keeps up with the pointer; the rebuild when the gesture ends is full size.
  const k = clamp(scale, 0.25, 2) * (m.terrain.live ? 0.5 : 1);
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(W * k)); off.height = Math.max(1, Math.round(H * k));
  const relief = drawTerrain(ctx, m, k);
  off.getContext('2d').putImageData(relief.img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale); // everything below draws in native coordinates

  const { gw, gh } = m, sx = W / gw, sy = H / gh;
  // shoreline: a pale wash, a firm ink line, and two offshore depth lines
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(214, 232, 238, .45)'; ctx.lineWidth = 0.8;
  // depths in grid height units, as before, traced on the relief raster
  const { S, L, rw, rh } = relief;
  const [deep, shallow, coast] = isolines(S, rw, rh, [-0.03 / HEIGHT_SPAN, -0.012 / HEIGHT_SPAN, 0]);
  ctx.stroke(deep); ctx.stroke(shallow);
  ctx.strokeStyle = 'rgba(238, 230, 200, .75)'; ctx.lineWidth = 2.6; ctx.stroke(coast);
  ctx.strokeStyle = 'rgba(48, 50, 46, .8)'; ctx.lineWidth = 0.9; ctx.stroke(coast);
  if (L) {
    const [shore] = isolines(L, rw, rh, [0.5]);
    ctx.strokeStyle = 'rgba(238, 230, 200, .6)'; ctx.lineWidth = 1.8; ctx.stroke(shore);
    ctx.strokeStyle = 'rgba(48, 50, 46, .7)'; ctx.lineWidth = 0.7; ctx.stroke(shore);
  }

  drawRivers(ctx, m);

  // nation borders follow the same owner grid the atlas styles use
  if (m.owner) drawFrontiers(ctx, m, sx, sy);

  for (const t of m.towns || []) drawSettlement(ctx, t.x * sx, t.y * sy, t);
  for (const nat of m.nations || []) if (nat.custom && !nat.hidden) drawSettlement(ctx, nat.capital[0] * sx, nat.capital[1] * sy, { capital: true });

  if (p.labels !== false) {
    drawMapLabels(ctx, [
      ...(m.towns || []).map((t) => ({ text: t.name, x: t.x * sx, y: t.y * sy, size: t.capital ? 14 : 11, bold: !!t.capital, priority: t.capital ? 12 : 9 })),
      ...(m.nations || []).filter((n) => !n.hidden && (n.cells > 200 || n.custom)).map((n) => ({ text: n.name.toUpperCase(), x: n.cx * sx, y: n.cy * sy, size: 20, center: true, priority: n.custom ? 10 : 5 })),
    ], W, H, [{ x: W / 2 - 185, y: 13, w: 370, h: 40 }, { x: W - 100, y: 5, w: 95, h: 100 }]);
    const title = String(p.title || 'The Known World');
    ctx.font = 'small-caps 20px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const tw = Math.min(370, ctx.measureText(title).width + 38);
    ctx.fillStyle = 'rgba(246, 241, 226, .9)'; ctx.fillRect((W - tw) / 2, 13, tw, 34);
    ctx.strokeStyle = 'rgba(70, 66, 58, .7)'; ctx.lineWidth = 0.7; ctx.strokeRect((W - tw) / 2, 13, tw, 34);
    ctx.fillStyle = '#3a372f'; ctx.fillText(title, W / 2, 36, tw - 16);
  }
  ctx.strokeStyle = 'rgba(40, 40, 36, .8)'; ctx.lineWidth = 1.2; ctx.strokeRect(6, 6, W - 12, H - 12);
  return canvas;
}
