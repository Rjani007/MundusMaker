// Shared map plumbing: kind registry, marker/label overlay (with GM-secret
// filtering), full renders for the editor, thumbnails, PNG and PDF export.

import { uid } from '../util.js';
import { WORLD_W, WORLD_H, defaultWorldParams, buildWorldModel, renderWorldBase } from './world.js';
import { TOWN_W, TOWN_H, defaultTownParams, buildTownModel, renderTownBase } from './town.js';
import { defaultDungeonParams, dungeonSize, dungeonGrid, renderDungeonBase } from './dungeon.js';

export const MAP_KINDS = {
  world: {
    label: 'World map',
    size: () => [WORLD_W, WORLD_H],
    defaults: defaultWorldParams,
    buildModel: buildWorldModel,
    renderBase: renderWorldBase,
    labelStyle: 'light',
  },
  town: {
    label: 'Town map',
    size: () => [TOWN_W, TOWN_H],
    defaults: defaultTownParams,
    buildModel: buildTownModel,
    renderBase: renderTownBase,
    labelStyle: 'dark',
  },
  dungeon: {
    label: 'Dungeon map',
    size: (map) => dungeonSize(map),
    defaults: defaultDungeonParams,
    buildModel: dungeonGrid,
    renderBase: renderDungeonBase,
    labelStyle: 'light',
  },
};

export function newMap(kind) {
  const def = MAP_KINDS[kind];
  return {
    kind,
    seed: Math.random().toString(36).slice(2, 10),
    params: def.defaults(),
    strokes: [],
    grid: null,
    markers: [],
    labels: [],
    stamps: [],
    paths: [],
    compass: false,
  };
}

export const MARKER_SHAPES = ['dot', 'star', 'triangle', 'square', 'diamond', 'cross', 'flag', 'pin'];
export const MARKER_COLORS = ['#e0524a', '#e0a72c', '#4a9e6f', '#4a86e0', '#9b59d0', '#e8e4f0'];

export function newMarker(x, y, opts = {}) {
  // `to` optionally links the marker to an entity id (like relations do)
  return { id: uid(), x, y, shape: opts.shape || 'dot', color: opts.color || '#e0524a', label: opts.label || '', secret: !!opts.secret, to: opts.to || null };
}

/**
 * Visible markers + stamps in map-key order (markers first) — matches the
 * numbers drawn by opts.numbered, so the printed key and the badges agree.
 */
export function mapKey(map, opts = {}) {
  return [...(map.markers || []), ...(map.stamps || [])].filter((o) => opts.gm || !o.secret);
}

export function newLabel(x, y, text, size = 22) {
  return { id: uid(), x, y, text, size };
}

// ---------- stamps: placeable structures drawn as inked glyphs ----------

export const STAMP_KINDS = {
  house: 'House', village: 'Village', city: 'City', castle: 'Castle', tower: 'Tower',
  temple: 'Temple', inn: 'Inn', market: 'Market', ruin: 'Ruin', camp: 'Camp',
  mine: 'Mine', port: 'Port', forest: 'Forest', mountain: 'Mountains', graveyard: 'Graveyard',
};

export const STAMP_COLORS = ['#c9b184', '#7d5138', '#9c3f2e', '#8b8fa8', '#5f7f42', '#4a86b8', '#e8e4f0'];

const STAMP_DEFAULT_COLOR = {
  house: '#7d5138', village: '#7d5138', city: '#c9b184', castle: '#8b8fa8', tower: '#8b8fa8',
  temple: '#e8e4f0', inn: '#7d5138', market: '#9c3f2e', ruin: '#8b8fa8', camp: '#c9b184',
  mine: '#7d5138', port: '#4a86b8', forest: '#5f7f42', mountain: '#8b8fa8', graveyard: '#8b8fa8',
};

export function newStamp(x, y, opts = {}) {
  const kind = STAMP_KINDS[opts.kind] ? opts.kind : 'house';
  return {
    id: uid(), x, y, kind,
    size: opts.size || 1,
    color: opts.color || STAMP_DEFAULT_COLOR[kind],
    label: opts.label || '',
    secret: !!opts.secret,
    to: opts.to || null,
  };
}

const INK = '#2e2318';

/** Draw one stamp glyph centered on (x, y). `halo` gives a parchment token
 *  backing so glyphs stay readable on busy terrain (world/dungeon maps). */
export function drawStamp(ctx, stamp, x, y, halo) {
  const u = 9 * (stamp.size || 1);
  const fill = stamp.color || STAMP_DEFAULT_COLOR[stamp.kind] || '#c9b184';
  ctx.save();
  ctx.translate(x, y);
  if (halo) {
    ctx.beginPath();
    ctx.arc(0, 0, u * 1.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(238, 230, 205, 0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46, 35, 24, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = fill;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.1, u * 0.16);
  ctx.lineJoin = 'round';

  const rect = (rx, ry, rw, rh) => { ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.fill(); ctx.stroke(); };
  const tri = (x1, y1, x2, y2, x3, y3) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill(); ctx.stroke();
  };
  const roofTri = (cx, topY, hw, baseY) => tri(cx - hw, baseY, cx, topY, cx + hw, baseY);
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };

  switch (stamp.kind) {
    case 'house':
      rect(-u * 0.7, -u * 0.2, u * 1.4, u * 1.0);
      roofTri(0, -u * 1.0, u * 0.85, -u * 0.2);
      break;
    case 'village':
      rect(-u * 1.1, 0, u * 0.9, u * 0.8);
      roofTri(-u * 0.65, -u * 0.55, u * 0.55, 0);
      rect(u * 0.2, 0, u * 0.9, u * 0.8);
      roofTri(u * 0.65, -u * 0.55, u * 0.55, 0);
      break;
    case 'city':
      rect(-u * 1.1, -u * 0.1, u * 2.2, u * 0.9); // wall base
      rect(-u * 1.0, -u * 0.7, u * 0.55, u * 0.6);
      roofTri(-u * 0.72, -u * 1.1, u * 0.36, -u * 0.7);
      rect(u * 0.45, -u * 0.7, u * 0.55, u * 0.6);
      roofTri(u * 0.72, -u * 1.1, u * 0.36, -u * 0.7);
      rect(-u * 0.28, -u * 1.1, u * 0.56, u * 1.0);
      roofTri(0, -u * 1.55, u * 0.38, -u * 1.1);
      break;
    case 'castle':
      rect(-u * 1.05, -u * 0.65, u * 0.45, u * 1.45); // left tower
      rect(u * 0.6, -u * 0.65, u * 0.45, u * 1.45);   // right tower
      rect(-u * 0.6, -u * 0.25, u * 1.2, u * 1.05);   // wall
      rect(-u * 0.3, -u * 1.05, u * 0.6, u * 0.8);    // keep
      line(-u * 0.95, -u * 0.65, -u * 0.95, -u * 0.85);
      line(-u * 0.7, -u * 0.65, -u * 0.7, -u * 0.85);
      line(u * 0.7, -u * 0.65, u * 0.7, -u * 0.85);
      line(u * 0.95, -u * 0.65, u * 0.95, -u * 0.85);
      line(0, -u * 1.05, 0, -u * 1.5);
      tri(0, -u * 1.5, u * 0.35, -u * 1.38, 0, -u * 1.26); // pennant
      break;
    case 'tower':
      rect(-u * 0.32, -u * 0.9, u * 0.64, u * 1.7);
      roofTri(0, -u * 1.5, u * 0.45, -u * 0.9);
      break;
    case 'temple':
      rect(-u * 0.95, u * 0.5, u * 1.9, u * 0.3);   // steps
      line(-u * 0.65, u * 0.5, -u * 0.65, -u * 0.35);
      line(-u * 0.22, u * 0.5, -u * 0.22, -u * 0.35);
      line(u * 0.22, u * 0.5, u * 0.22, -u * 0.35);
      line(u * 0.65, u * 0.5, u * 0.65, -u * 0.35);
      tri(-u * 0.95, -u * 0.35, 0, -u * 1.0, u * 0.95, -u * 0.35); // pediment
      break;
    case 'inn':
      rect(-u * 0.8, -u * 0.2, u * 1.3, u * 1.0);
      roofTri(-u * 0.15, -u * 0.95, u * 0.8, -u * 0.2);
      line(u * 0.65, -u * 0.5, u * 0.65, -u * 0.05);
      rect(u * 0.5, -u * 0.45, u * 0.55, u * 0.4); // hanging sign
      break;
    case 'market':
      line(-u * 0.75, u * 0.7, -u * 0.75, -u * 0.3);
      line(u * 0.75, u * 0.7, u * 0.75, -u * 0.3);
      rect(-u * 0.95, -u * 0.65, u * 1.9, u * 0.45); // awning
      line(-u * 0.95, -u * 0.2, -u * 0.55, u * 0.05);
      line(-u * 0.15, -u * 0.2, u * 0.2, u * 0.05);
      break;
    case 'ruin': {
      ctx.beginPath();
      ctx.moveTo(-u * 0.85, u * 0.6);
      ctx.lineTo(-u * 0.85, -u * 0.5);
      ctx.lineTo(-u * 0.45, -u * 0.3);
      ctx.lineTo(-u * 0.35, -u * 0.75);
      ctx.lineTo(u * 0.05, -u * 0.35);
      ctx.lineTo(u * 0.3, -u * 0.55);
      ctx.lineTo(u * 0.5, -u * 0.1);
      ctx.lineTo(u * 0.85, u * 0.0);
      ctx.lineTo(u * 0.85, u * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'camp':
      tri(-u * 0.85, u * 0.6, 0, -u * 0.85, u * 0.85, u * 0.6);
      line(0, u * 0.6, 0, -u * 0.05); // door slit
      break;
    case 'mine': {
      ctx.beginPath();
      ctx.arc(0, u * 0.5, u * 0.75, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      line(-u * 0.95, u * 0.5, u * 0.95, u * 0.5);
      line(-u * 0.75, u * 0.5, -u * 0.95, -u * 0.55);
      line(u * 0.75, u * 0.5, u * 0.95, -u * 0.55);
      line(-u * 0.95, -u * 0.55, u * 0.95, -u * 0.55);
      break;
    }
    case 'port': {
      line(0, -u * 0.55, 0, u * 0.7); // shank
      ctx.beginPath();
      ctx.arc(0, -u * 0.72, u * 0.22, 0, Math.PI * 2);
      ctx.stroke();
      line(-u * 0.55, -u * 0.15, u * 0.55, -u * 0.15); // stock
      ctx.beginPath();
      ctx.arc(0, u * 0.25, u * 0.6, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      break;
    }
    case 'forest': {
      const treeAt = (tx, ty, r) => {
        line(tx, ty + r * 1.2, tx, ty);
        ctx.beginPath();
        ctx.arc(tx, ty, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      };
      treeAt(-u * 0.55, u * 0.1, u * 0.45);
      treeAt(u * 0.55, u * 0.1, u * 0.45);
      treeAt(0, -u * 0.45, u * 0.5);
      break;
    }
    case 'mountain':
      tri(-u * 1.0, u * 0.6, -u * 0.25, -u * 0.7, u * 0.45, u * 0.6);
      tri(-u * 0.15, u * 0.6, u * 0.5, -u * 1.0, u * 1.05, u * 0.6);
      ctx.fillStyle = '#f4f2ec';
      tri(u * 0.32, -u * 0.65, u * 0.5, -u * 1.0, u * 0.68, -u * 0.65);
      break;
    case 'graveyard':
      ctx.beginPath();
      ctx.moveTo(-u * 0.75, u * 0.6);
      ctx.lineTo(-u * 0.75, -u * 0.25);
      ctx.arc(-u * 0.45, -u * 0.25, u * 0.3, Math.PI, 0);
      ctx.lineTo(-u * 0.15, u * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      line(u * 0.45, u * 0.6, u * 0.45, -u * 0.7);
      line(u * 0.15, -u * 0.35, u * 0.75, -u * 0.35);
      break;
    default:
      rect(-u * 0.6, -u * 0.6, u * 1.2, u * 1.2);
  }
  ctx.restore();
}

// ---------- drawn paths: roads, rivers, borders, routes, walls ----------

export const PATH_STYLES = {
  road: { label: 'Road', color: '#c9b184', width: 8, twoPass: true },
  river: { label: 'River', color: '#5c88a8', width: 6, twoPass: true },
  border: { label: 'Border', color: '#8a2f2f', width: 3, dash: [10, 5, 3, 5] },
  route: { label: 'Travel route', color: '#3a2a18', width: 3, dash: [2, 7] },
  wall: { label: 'Wall', color: '#4a3a28', width: 5, dash: [9, 4] },
};

export function newPath(style, opts = {}) {
  const s = PATH_STYLES[style] ? style : 'road';
  return {
    id: uid(), style: s, pts: [],
    color: opts.color || PATH_STYLES[s].color,
    width: opts.width || PATH_STYLES[s].width,
    secret: !!opts.secret,
    closed: false, // set when the drawn stroke ends near its start
    fill: false,   // closed borders can tint their territory
  };
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

export function drawMapPath(ctx, path, W, H) {
  const st = PATH_STYLES[path.style] || PATH_STYLES.road;
  const pts = path.pts || [];
  if (pts.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
    if (path.closed) ctx.closePath();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (path.closed && path.fill) {
    trace();
    ctx.fillStyle = hexToRgba(path.color, 0.14);
    ctx.fill();
  }
  if (st.twoPass) {
    trace();
    ctx.strokeStyle = shade(path.color, 0.55);
    ctx.lineWidth = path.width + 3;
    ctx.stroke();
    trace();
    ctx.strokeStyle = path.color;
    ctx.lineWidth = path.width;
    ctx.stroke();
  } else {
    trace();
    if (st.dash) ctx.setLineDash(st.dash);
    ctx.strokeStyle = path.color;
    ctx.lineWidth = path.width;
    ctx.stroke();
  }
  ctx.restore();
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Simple 8-point compass rose, drawn top-right. */
function drawCompass(ctx, W) {
  const cx = W - 52, cy = 52, R = 30;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(238, 230, 205, 0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(46, 35, 24, 0.6)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const long = i % 2 === 0;
    const r = long ? R : R * 0.55;
    const wHalf = long ? 4.5 : 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a + Math.PI / 2) * wHalf, cy + Math.sin(a + Math.PI / 2) * wHalf);
    ctx.lineTo(cx + Math.cos(a - Math.PI / 2) * wHalf, cy + Math.sin(a - Math.PI / 2) * wHalf);
    ctx.closePath();
    ctx.fillStyle = long ? INK : '#8a6a4a';
    ctx.fill();
  }
  ctx.fillStyle = INK;
  ctx.font = 'bold 13px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 14);
  ctx.restore();
}

// ---------- overlay drawing ----------

function drawShape(ctx, shape, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(10, 8, 6, 0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  switch (shape) {
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? r * 1.35 : r * 0.55;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx[i === 0 ? 'moveTo' : 'lineTo'](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
      }
      ctx.closePath();
      break;
    }
    case 'triangle':
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 1.1, y + r * 0.9);
      ctx.lineTo(x - r * 1.1, y + r * 0.9);
      ctx.closePath();
      break;
    case 'square':
      ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
      break;
    case 'diamond':
      ctx.moveTo(x, y - r * 1.25);
      ctx.lineTo(x + r * 1.05, y);
      ctx.lineTo(x, y + r * 1.25);
      ctx.lineTo(x - r * 1.05, y);
      ctx.closePath();
      break;
    case 'cross':
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = 'rgba(10,8,6,0.9)';
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.stroke();
      return;
    case 'flag':
      ctx.lineWidth = 2;
      ctx.moveTo(x - r * 0.5, y + r * 1.3);
      ctx.lineTo(x - r * 0.5, y - r * 1.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r * 0.5, y - r * 1.3);
      ctx.lineTo(x + r * 1.2, y - r * 0.75);
      ctx.lineTo(x - r * 0.5, y - r * 0.2);
      ctx.closePath();
      break;
    case 'pin':
      ctx.moveTo(x, y + r * 1.4);
      ctx.arc(x, y - r * 0.3, r, Math.PI * 0.82, Math.PI * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 8, 6, 0.85)';
      ctx.fill();
      return;
    default: // dot
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
}

/**
 * Draw paths, stamps, labels and markers over the base map.
 * opts.gm       — include secret overlay items (drawn with a dashed halo)
 * opts.selected — id of the currently selected item (editor highlight)
 * opts.numbered — numbered badges on markers+stamps for the printed map key
 */
export function drawOverlay(ctx, map, W, H, opts = {}) {
  const style = MAP_KINDS[map.kind]?.labelStyle || 'light';
  const secretHalo = (x, y, r) => {
    ctx.save();
    ctx.strokeStyle = '#b48cf2';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  const itemLabel = (text, x, y) => {
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = style === 'light' ? 'rgba(10,10,14,0.85)' : 'rgba(238,226,195,0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = style === 'light' ? '#fff' : '#3a2a18';
    ctx.fillText(text, x, y);
  };

  // drawn paths sit right on the terrain, under everything hand-placed
  for (const path of map.paths || []) {
    if (path.secret && !opts.gm) continue;
    drawMapPath(ctx, path, W, H);
    if (opts.selected === path.id && path.pts?.length) {
      const [mx, my] = path.pts[(path.pts.length / 2) | 0];
      highlight(ctx, mx * W, my * H, 14);
    }
  }

  for (const s of map.stamps || []) {
    if (s.secret && !opts.gm) continue;
    const x = s.x * W, y = s.y * H;
    drawStamp(ctx, s, x, y, style === 'light');
    if (s.secret) secretHalo(x, y, 16 * (s.size || 1));
    if (!opts.numbered && s.label) itemLabel(s.label, x, y + 13 * (s.size || 1) + 2);
    if (opts.selected === s.id) highlight(ctx, x, y, 18 * (s.size || 1));
  }

  for (const lb of map.labels || []) {
    const x = lb.x * W, y = lb.y * H;
    ctx.font = `italic ${lb.size}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (style === 'light') {
      ctx.strokeStyle = 'rgba(10, 10, 14, 0.85)';
      ctx.lineWidth = Math.max(3, lb.size / 6);
      ctx.strokeText(lb.text, x, y);
      ctx.fillStyle = '#f4efdf';
    } else {
      ctx.strokeStyle = 'rgba(238, 226, 195, 0.8)';
      ctx.lineWidth = Math.max(3, lb.size / 6);
      ctx.strokeText(lb.text, x, y);
      ctx.fillStyle = '#3a2a18';
    }
    ctx.fillText(lb.text, x, y);
    if (opts.selected === lb.id) highlight(ctx, x, y, ctx.measureText(lb.text).width / 2 + 10);
  }

  for (const mk of map.markers || []) {
    if (mk.secret && !opts.gm) continue;
    const x = mk.x * W, y = mk.y * H;
    drawShape(ctx, mk.shape, x, y, 7, mk.color);
    if (mk.secret) secretHalo(x, y, 13);
    if (!opts.numbered && mk.label) itemLabel(mk.label, x, y + 11);
    if (opts.selected === mk.id) highlight(ctx, x, y, 16);
  }

  if (opts.numbered) {
    // printed-map mode: badges on markers+stamps, numbered to match mapKey()
    mapKey(map, opts).forEach((o, i) => {
      const x = o.x * W, y = o.y * H;
      const n = String(i + 1);
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      const r = Math.max(8, ctx.measureText(n).width / 2 + 5);
      ctx.beginPath();
      ctx.arc(x + 12, y - 12, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20, 16, 28, 0.88)';
      ctx.fill();
      ctx.strokeStyle = '#f4efdf';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f4efdf';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n, x + 12, y - 12);
    });
  }

  if (map.compass) drawCompass(ctx, W);
}

function highlight(ctx, x, y, r) {
  ctx.save();
  ctx.strokeStyle = '#7fd7ff';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------- full renders ----------

/**
 * Render a complete map (base + overlay) onto `canvas`. opts.scale > 1
 * renders at a multiple of the native size — a true re-render (vector strokes,
 * text, glyphs all stay sharp), not a pixel upscale. Handy for printing.
 */
export function renderMap(canvas, map, opts = {}) {
  const kind = MAP_KINDS[map.kind];
  const scale = opts.scale || 1;
  const [W, H] = kind.size(map);
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  const base = opts.base || kind.renderBase(map, opts.model, scale);
  ctx.drawImage(base, 0, 0, W * scale, H * scale);
  ctx.save();
  ctx.scale(scale, scale);
  drawOverlay(ctx, map, W, H, opts);
  ctx.restore();
  return canvas;
}

/** JPEG data-url (for PDF embedding) rendered in GM or player mode. */
export function mapToJpeg(map, opts = {}) {
  const canvas = document.createElement('canvas');
  renderMap(canvas, map, opts);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height };
}

/** Draw a small thumbnail of the map into the given canvas element. */
export function renderThumbnail(canvas, map, thumbWidth = 300, opts = {}) {
  const full = document.createElement('canvas');
  renderMap(full, map, opts);
  const scale = thumbWidth / full.width;
  canvas.width = thumbWidth;
  canvas.height = Math.round(full.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
}
