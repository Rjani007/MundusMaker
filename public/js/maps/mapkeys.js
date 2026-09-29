// Map keys (1.9): GM prep notes attached to places a generator made — dungeon
// rooms, settlements, landmarks and region hexes. `map.keys` maps an anchor
// string to { block } (a block on the map's own entry) or { entity } (a place
// promoted to its own entry). Notes are ordinary blocks and entries, secret by
// default, so the existing flags govern them.
//
// Anchors never store a derived number:
//   room:<level>:<x>,<y>   a cell inside a dungeon room (numbers are recomputed
//                          from the grid on every render; the room holding the
//                          cell is the one keyed)
//   <site key>             generated settlements and landmarks keep their
//                          existing keys (world:3:vinton, landmark:1:the-old-mill)
//   landmark:<i>:<name>    town landmarks: i counts landmark buildings in model
//                          order, name is the generated one
//   hex:<col>,<row>        the region's fixed hex overlay (flat-top, R = 24)
//
// Everything here reads a finished model and draws in the overlay pass: no
// generator stream is read and no model is written, so a map without keys
// renders exactly as before.

import { settlementSites, siteKey } from './crossscale.js';
import { dungeonRooms } from './dungeon.js';

export const HEX_R = 24;
const HEX_ROW = Math.sqrt(3) * HEX_R;

export function hexCenter(col, row) {
  return [col * HEX_R * 1.5, row * HEX_ROW + (col % 2) * HEX_ROW / 2];
}

/** The hex whose centre is nearest (x, y), matching region.js drawHexes. */
export function hexAt(x, y) {
  let best = null, dist = Infinity;
  const c0 = Math.round(x / (HEX_R * 1.5));
  for (let col = Math.max(0, c0 - 1); col <= c0 + 1; col++) {
    const r0 = Math.round((y - (col % 2) * HEX_ROW / 2) / HEX_ROW);
    for (let row = Math.max(0, r0 - 1); row <= r0 + 1; row++) {
      const [cx, cy] = hexCenter(col, row);
      const d = Math.hypot(cx - x, cy - y);
      if (d < dist) { dist = d; best = { col, row }; }
    }
  }
  return best;
}

const pad2 = (n) => String(n).padStart(2, '0');
export const hexName = (col, row) => `Hex ${pad2(col)}${pad2(row)}`;

/** Words for an anchor that no longer resolves (its key embeds a name). */
export function anchorFallbackLabel(anchor) {
  const [kind, a, b] = String(anchor).split(':');
  if (kind === 'room') { const [x, y] = String(b || '').split(','); return `A room on level ${Number(a) + 1} (cell ${x}, ${y})`; }
  if (kind === 'hex') { const [col, row] = String(a || '').split(',').map(Number); return hexName(col, row); }
  try { return decodeURIComponent(b || '') || anchor; } catch { return anchor; }
}

export const anchorLevel = (anchor) => String(anchor).startsWith('room:') ? Number(String(anchor).split(':')[1]) || 0 : 0;

// ---------- per-kind places: [{ anchor, label, x, y, n?, level, hex? }] ----------

function roomCell(room) {
  // the cell nearest the room's centre stands for the room
  let best = room.cells[0], dist = Infinity;
  for (const c of room.cells) {
    const d = Math.hypot(c[0] - room.cx, c[1] - room.cy);
    if (d < dist) { dist = d; best = c; }
  }
  return best;
}

export const dungeonKeys = {
  places(map, model, level, cell) {
    return dungeonRooms(model.grid, model.cols, model.rows).map((room, i) => {
      const [x, y] = roomCell(room);
      return { anchor: `room:${level}:${x},${y}`, label: `Room ${i + 1}`, n: i + 1, level,
        x: (room.cx + 0.5) * cell, y: (room.cy + 0.5) * cell, cells: room.cells };
    });
  },
  locate(map, model, level, anchor, cell) {
    const [kind, l, xy] = String(anchor).split(':');
    if (kind !== 'room' || Number(l) !== level) return null;
    const [x, y] = String(xy).split(',').map(Number);
    return this.places(map, model, level, cell).find((p) => p.cells.some((c) => c[0] === x && c[1] === y)) || null;
  },
  at(map, model, level, x, y, cell) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    return this.places(map, model, level, cell).find((p) => p.cells.some((c) => c[0] === cx && c[1] === cy)) || null;
  },
};

function siteKeysFor(listPlaces) {
  return {
    places: listPlaces,
    locate(map, model, level, anchor, size) {
      if (String(anchor).startsWith('hex:')) {
        if (!map.params?.hexes) return null;
        const [col, row] = anchor.slice(4).split(',').map(Number);
        if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
        const [x, y] = hexCenter(col, row);
        if (x < 0 || y < 0 || x > size[0] + HEX_R || y > size[1] + HEX_ROW) return null;
        return { anchor, label: hexName(col, row), x, y, level: 0, hex: true };
      }
      return listPlaces(map, model, level, size).find((p) => p.anchor === anchor) || null;
    },
    at(map, model, level, x, y, size) {
      let best = null, dist = 18;
      for (const p of listPlaces(map, model, level, size)) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < dist) { dist = d; best = p; }
      }
      if (best || !map.params?.hexes) return best;
      const h = hexAt(x, y);
      return h ? this.locate(map, model, level, `hex:${h.col},${h.row}`, size) : null;
    },
  };
}

const settlementPlaces = (map, model, level, size) =>
  settlementSites(map, model, size).map((s) => ({ anchor: s.key, label: s.name, x: s.x, y: s.y, level: 0 }));

export const worldKeys = siteKeysFor(settlementPlaces);

export const regionKeys = siteKeysFor((map, model, level, size) => [
  ...settlementPlaces(map, model, level, size),
  ...(model.landmarks || []).map((l, i) => ({ anchor: l.key || siteKey('landmark', i, l.name), label: l.name, x: l.x, y: l.y, level: 0 })),
]);

export const townKeys = siteKeysFor((map, model) =>
  (model.buildings || []).filter((b) => b.landmark).map((b, i) => ({ anchor: siteKey('landmark', i, b.landmark), label: b.label || b.landmark, x: b.x, y: b.y, level: 0 })));

// ---------- resolution ----------

export const hasKeys = (map) => !!map?.keys && Object.keys(map.keys).length > 0;

/** The last argument every kind's keys functions take: a grid kind's cell
 *  size, otherwise the map's native [width, height]. */
export const keySpace = (kind, map) => kind.cellSize || kind.size(map);

/** Blocks on the map's own entry that serve as key notes. */
export const keyBlockIds = (map) => new Set(Object.values(map?.keys || {}).map((t) => t?.block).filter(Boolean));

/**
 * Resolve the stored keys (all levels, or only `level`). modelFor(level)
 * returns that level's model. Returns { placed: [{ anchor, place, target }],
 * unplaced: [{ anchor, target }] }, placed in print order: level, room
 * number, label.
 */
export function resolveKeys(map, kind, modelFor, { level: only = null } = {}) {
  const placed = [], unplaced = [];
  if (!kind?.keys || !hasKeys(map)) return { placed, unplaced };
  const models = new Map();
  const model = (level) => { if (!models.has(level)) models.set(level, modelFor(level)); return models.get(level); };
  const levels = kind.levelCount ? kind.levelCount(map) : 1;
  const extra = keySpace(kind, map);
  for (const [anchor, target] of Object.entries(map.keys)) {
    const level = anchorLevel(anchor);
    if (only != null && level !== only) continue;
    const place = level < levels ? kind.keys.locate(map, model(level), level, anchor, extra) : null;
    (place ? placed : unplaced).push({ anchor, place, target: target || {} });
  }
  placed.sort((a, b) => a.place.level - b.place.level || (a.place.n ?? 0) - (b.place.n ?? 0) || a.place.label.localeCompare(b.place.label));
  return { placed, unplaced };
}

/** GM-only badges: a gold ring on every keyed place, plus the hex name for
 *  hexes (rooms and sites already carry their number or name). */
export function drawKeyBadges(ctx, placed, level = 0) {
  ctx.save();
  for (const { place } of placed) {
    if ((place.level || 0) !== level) continue;
    ctx.beginPath();
    ctx.arc(place.x, place.y, place.hex ? 16 : 12, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(214, 170, 60, 0.95)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(40, 28, 10, 0.8)';
    ctx.stroke();
    if (place.hex) {
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(244, 239, 223, 0.9)';
      const text = place.label.replace('Hex ', '');
      ctx.strokeText(text, place.x, place.y);
      ctx.fillStyle = '#3a2a18';
      ctx.fillText(text, place.x, place.y);
    }
  }
  ctx.restore();
}
