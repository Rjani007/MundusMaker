// World / region map generator: seeded fBm heightmap + moisture, biome coloring,
// hillshade, rivers, and hand-edits stored as brush strokes (so they survive re-rendering).

import { makeFbm, makeRng, clamp } from '../util.js';

export const WORLD_W = 960;
export const WORLD_H = 600;
const GW = 480; // simulation grid (rendered at 2x)
const GH = 300;

export function defaultWorldParams() {
  return { water: 0.5, scale: 3, island: true, rivers: 6 };
}

/** Build the height/moisture grids from seed + params + stored brush strokes. */
export function buildWorldModel(map) {
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

/** Trace rivers: descend from random highlands to the sea. Deterministic from seed. */
function traceRivers(model, seed, count) {
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
  for (const path of traceRivers(model, map.seed, p.rivers)) {
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
  return base;
}
