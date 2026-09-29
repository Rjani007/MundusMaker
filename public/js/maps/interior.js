// Interior map generator: battle-scale floor plans for single buildings.
// Same editing contract as dungeon.js — once the user paints, the grid persists
// as a string on map.grid and regeneration only happens without it. Furniture
// is re-derived from whatever grid is current (its own rng stream), so a
// hand-edited plan still gets furnished sensibly.

import { makeRng } from '../util.js';
import { plannedInterior } from './floorplans.js';

export const INTERIOR_CELL = 26;
const CELL = INTERIOR_CELL;
const SOLID = 0, FLOOR = 1, DOOR = 2, WINDOW = 3;
const NESW = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export const INTERIOR_BUILDINGS = ['tavern', 'inn', 'keep', 'temple', 'shop', 'house', 'manor', 'workshop'];

export function defaultInteriorParams() {
  return { building: 'tavern', cols: 24, rows: 16, furnished: true };
}

function paramsOf(map) {
  const p = { ...defaultInteriorParams(), ...(map.params || {}) };
  p.cols = Math.max(16, Math.min(48, Math.round(p.cols ?? 24)));
  p.rows = Math.max(12, Math.min(36, Math.round(p.rows ?? 16)));
  if (!INTERIOR_BUILDINGS.includes(p.building)) p.building = 'tavern';
  return p;
}

export function interiorSize(map) {
  const p = paramsOf(map);
  return [p.cols * CELL, p.rows * CELL];
}

// ---------- persistence (mirrors dungeon.js) ----------

const CHARS = ['#', '.', 'D', 'W'];

export function interiorGridToString(grid, cols, rows) {
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) line += CHARS[grid[y * cols + x]] || '#';
    lines.push(line);
  }
  return lines.join('\n');
}

/** Any character this build doesn't know parses as solid — forward compat. */
export function interiorGridFromString(str, cols, rows) {
  const grid = new Uint8Array(cols * rows);
  const lines = String(str || '').split('\n');
  for (let y = 0; y < Math.min(lines.length, rows); y++) {
    for (let x = 0; x < Math.min(lines[y].length, cols); x++) {
      const c = lines[y][x];
      grid[y * cols + x] = c === '.' ? FLOOR : c === 'D' ? DOOR : c === 'W' ? WINDOW : SOLID;
    }
  }
  return grid;
}

/** Generate from seed + params and return the persistence string. */
export function generateInteriorGrid(map) {
  const p = paramsOf(map);
  return interiorGridToString(generate(map), p.cols, p.rows);
}

export function buildInteriorModel(map) {
  const p = paramsOf(map);
  if (map.params?.generation==='1.8' && !map.grid) return plannedInterior(map,p);
  const grid = map.grid ? interiorGridFromString(map.grid, p.cols, p.rows) : generate(map);
  const furniture = p.furnished ? furnish(map, grid, p) : [];
  return { grid, cols: p.cols, rows: p.rows, furniture };
}

// ---------- shared grid analysis ----------

/** Solid cells connected to the map edge — the outdoors, as opposed to walls. */
function outsideMask(grid, cols, rows) {
  const out = new Uint8Array(cols * rows);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    const i = y * cols + x;
    if (out[i] || grid[i] !== SOLID) return;
    out[i] = 1;
    stack.push([x, y]);
  };
  for (let x = 0; x < cols; x++) { push(x, 0); push(x, rows - 1); }
  for (let y = 0; y < rows; y++) { push(0, y); push(cols - 1, y); }
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of NESW) push(x + dx, y + dy);
  }
  return out;
}

/** Connected floor areas in scan order; doors separate rooms and belong to neither. */
function roomsOf(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const rooms = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (seen[i] || (grid[i] !== FLOOR && grid[i] !== WINDOW)) continue;
      const cells = [[x, y]];
      seen[i] = 1;
      for (let k = 0; k < cells.length; k++) {
        const [px, py] = cells[k];
        for (const [dx, dy] of NESW) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (!seen[ni] && (grid[ni] === FLOOR || grid[ni] === WINDOW)) {
            seen[ni] = 1;
            cells.push([nx, ny]);
          }
        }
      }
      let x0 = cols, y0 = rows, x1 = 0, y1 = 0;
      for (const [cx, cy] of cells) {
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      }
      rooms.push({ cells, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
  }
  return rooms;
}

// ---------- generation ----------

function generate(map) {
  const p = paramsOf(map);
  if (map.params?.generation==='1.8') return plannedInterior(map,p).grid;
  const { cols, rows } = p;
  const rng = makeRng(map.seed);
  const g = new Uint8Array(cols * rows);
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? SOLID : g[y * cols + x];
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < cols && y < rows) g[y * cols + x] = v; };
  const wallV = (x, ya, yb) => { for (let y = ya; y <= yb; y++) if (at(x, y) === FLOOR) set(x, y, SOLID); };
  const wallH = (y, xa, xb) => { for (let x = xa; x <= xb; x++) if (at(x, y) === FLOOR) set(x, y, SOLID); };

  // pierce an interior wall near (x, y): the door needs open cells on both
  // sides of the wall axis, so slide along (dx, dy) until a valid spot appears
  // (the slide range must clear the widest possible L-notch)
  const pierce = (x, y, dx, dy) => {
    for (let k = 0; k < 12; k++) {
      for (const sgn of k === 0 ? [1] : [1, -1]) {
        const px = x + dx * k * sgn, py = y + dy * k * sgn;
        if (at(px, py) !== SOLID) continue;
        const horiz = at(px - 1, py) === FLOOR && at(px + 1, py) === FLOOR;
        const vert = at(px, py - 1) === FLOOR && at(px, py + 1) === FLOOR;
        if (horiz || vert) { set(px, py, DOOR); return; }
      }
    }
  };

  // footprint, inset so the surround reads as outdoors
  const x0 = 2, y0 = 2, x1 = cols - 3, y1 = rows - 3;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, FLOOR);
  const b = p.building;

  // entrance through the footprint edge; slides along the wall past L-notches
  const entrance = (x, y) => {
    for (let k = 0; k < 10; k++) {
      for (const sgn of k === 0 ? [1] : [1, -1]) {
        const ex = y === y1 ? Math.max(x0, Math.min(x1, x + k * sgn)) : x;
        const ey = y === y1 ? y : Math.max(y0, Math.min(y1, y + k * sgn));
        const inward = y === y1 ? at(ex, ey - 1) : at(ex - 1, ey);
        if (at(ex, ey) === FLOOR && inward === FLOOR) { set(ex, ey, DOOR); return; }
      }
    }
  };

  if (b === 'tavern' || b === 'house' || b === 'shop') {
    // sometimes L-shaped: bite the NW corner out (entrances live south/east)
    if (rng.chance(0.35)) {
      const bw = Math.max(3, Math.round((x1 - x0) * rng.range(0.25, 0.4)));
      const bh = Math.max(3, Math.round((y1 - y0) * rng.range(0.3, 0.45)));
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) set(x, y, SOLID);
    }
  }

  if (b === 'tavern') {
    // one big common room, service strip east: kitchen north, store south
    const wx = x1 - Math.max(4, Math.round((x1 - x0) * rng.range(0.28, 0.34)));
    wallV(wx, y0, y1);
    const wy = Math.round((y0 + y1) / 2 + rng.range(-1, 1));
    wallH(wy, wx + 1, x1);
    pierce(wx, Math.round((y0 + wy) / 2), 0, 1); // common -> kitchen
    pierce(wx, Math.round((wy + y1) / 2), 0, 1); // common -> store
    entrance(rng.int(x0 + 2, wx - 2), y1);
    if (rng.chance(0.5)) entrance(x1, Math.round((y0 + wy) / 2)); // kitchen back door
  } else if (b === 'inn') {
    // tavern ground floor, plus guest rooms off a corridor along the north face
    // (guest depth shrinks on short grids so the common room survives)
    const wy1 = y0 + Math.max(2, Math.min(3, y1 - y0 - 5));
    const wy2 = wy1 + 2; // corridor is the row between these walls
    wallH(wy1, x0, x1);
    wallH(wy2, x0, x1);
    const roomW = 4;
    const wallXs = [];
    for (let x = x0 + roomW; x < x1 - 1; x += roomW) { wallV(x, y0, wy1 - 1); wallXs.push(x); }
    let sx = x0;
    for (const wx of [...wallXs, x1 + 1]) {
      pierce((sx + wx - 1) >> 1, wy1, 1, 0); // corridor -> each guest room
      sx = wx + 1;
    }
    pierce(rng.int(x0 + 2, x1 - 2), wy2, 1, 0); // common room -> corridor
    const kx = x1 - 4; // small kitchen off the common room
    wallV(kx, wy2 + 1, y1);
    pierce(kx, rng.int(wy2 + 2, y1 - 1), 0, 1);
    entrance(rng.int(x0 + 2, kx - 2), y1);
  } else if (b === 'keep') {
    // 2-cell curtain wall, great hall, side chambers; the generic window pass
    // pierces the curtain with arrow slits
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < x0 + 2 || x > x1 - 2 || y < y0 + 2 || y > y1 - 2) set(x, y, SOLID);
      }
    }
    const cx = Math.max(x0 + 5, x1 - 6);
    if (cx < x1 - 3) {
      wallV(cx, y0 + 2, y1 - 2);
      const my = (y0 + y1) >> 1;
      wallH(my, cx + 1, x1 - 2);
      pierce(cx, Math.round((y0 + 2 + my) / 2), 0, 1);
      pierce(cx, Math.round((my + y1 - 2) / 2), 0, 1);
    }
    const gx = rng.int(x0 + 4, Math.max(x0 + 4, cx - 2)); // stays clear of the chamber wall
    set(gx, y1, DOOR); // gate pierces both wall courses
    set(gx, y1 - 1, DOOR);
  } else if (b === 'temple') {
    // nave runs west-east: apse behind the west wall, entrance east,
    // two side rooms flanking the entrance bay
    const ax = x0 + 4;
    wallV(ax, y0, y1);
    const midY = (y0 + y1) >> 1;
    for (const yy of [midY, midY + 1]) { // wide processional opening
      if (at(ax, yy) === SOLID && at(ax - 1, yy) === FLOOR && at(ax + 1, yy) === FLOOR) set(ax, yy, DOOR);
    }
    const sx = x1 - 4;
    const sd = Math.min(3, ((y1 - y0) >> 1) - 1); // side rooms leave an entrance bay
    wallV(sx, y0, y0 + sd);
    wallH(y0 + sd, sx + 1, x1);
    pierce((sx + 1 + x1) >> 1, y0 + sd, 1, 0);
    wallV(sx, y1 - sd, y1);
    wallH(y1 - sd, sx + 1, x1);
    pierce((sx + 1 + x1) >> 1, y1 - sd, 1, 0);
    entrance(x1, midY);
  } else if (b === 'shop') {
    // front room with the counter, back room for stock
    const fy = y0 + Math.max(3, Math.round((y1 - y0) * rng.range(0.38, 0.5)));
    wallH(fy, x0, x1);
    pierce(rng.int(x0 + 2, x1 - 2), fy, 1, 0);
    entrance(rng.int(x0 + 2, x1 - 2), y1);
    if (rng.chance(0.4)) entrance(x1, rng.int(fy + 2, y1 - 1)); // side door
  } else {
    // house: 2-4 cozy rooms
    if (rng.chance(0.5)) {
      const wx = x0 + Math.max(3, Math.round((x1 - x0) * rng.range(0.4, 0.6)));
      wallV(wx, y0, y1);
      pierce(wx, rng.int(y0 + 1, y1 - 1), 0, 1);
      if (rng.chance(0.6)) {
        const east = rng.chance(0.5);
        const hy = y0 + Math.max(2, Math.round((y1 - y0) * rng.range(0.35, 0.6)));
        if (east) { wallH(hy, wx + 1, x1); pierce(rng.int(wx + 2, x1 - 1), hy, 1, 0); }
        else { wallH(hy, x0, wx - 1); pierce(rng.int(x0 + 1, wx - 2), hy, 1, 0); }
      }
    } else {
      const hy = y0 + Math.max(3, Math.round((y1 - y0) * rng.range(0.4, 0.6)));
      wallH(hy, x0, x1);
      pierce(rng.int(x0 + 1, x1 - 1), hy, 1, 0);
      if (rng.chance(0.6)) {
        const south = rng.chance(0.5);
        const wx = x0 + Math.max(2, Math.round((x1 - x0) * rng.range(0.35, 0.6)));
        if (south) { wallV(wx, hy + 1, y1); pierce(wx, rng.int(hy + 2, y1 - 1), 0, 1); }
        else { wallV(wx, y0, hy - 1); pierce(wx, rng.int(y0 + 1, hy - 2), 0, 1); }
      }
    }
    if (rng.chance(0.65)) entrance(rng.int(x0 + 2, x1 - 2), y1);
    else entrance(x1, rng.int(y0 + 2, y1 - 2));
  }

  // windows spaced along walls that face the outdoors. outsideMask floods
  // through connected solid, so floor beside the keep's curtain wall counts as
  // exterior-facing too — those windows read as arrow slits, deliberately
  const outside = outsideMask(g, cols, rows);
  const isOut = (x, y) => x < 0 || y < 0 || x >= cols || y >= rows || outside[y * cols + x] === 1;
  const phase = rng.int(0, 2);
  const tryWindow = (x, y) => {
    if (at(x, y) !== FLOOR) return;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === DOOR) return; // keep doorways clear
    }
    set(x, y, WINDOW);
  };
  const north = [], south = [], west = [], east = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (g[y * cols + x] !== FLOOR) continue;
      if (isOut(x, y - 1)) north.push([x, y]);
      if (isOut(x, y + 1)) south.push([x, y]);
      if (isOut(x - 1, y)) west.push([x, y]);
      if (isOut(x + 1, y)) east.push([x, y]);
    }
  }
  for (const wallCells of [north, south, west, east]) {
    let i = 0;
    for (const [x, y] of wallCells) if (i++ % 3 === phase) tryWindow(x, y);
  }
  return g;
}

// ---------- furnishing ----------

function furnish(map, grid, p) {
  const { cols, rows } = p;
  const rng = makeRng(map.seed + ':furnish');
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? SOLID : grid[y * cols + x];
  const rooms = [...roomsOf(grid, cols, rows)]
    .sort((a, b) => b.cells.length - a.cells.length || a.y0 - b.y0 || a.x0 - b.x0);
  if (!rooms.length) return [];

  const used = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[y * cols + x] !== DOOR) continue;
      used[y * cols + x] = 1; // doors and their thresholds stay walkable
      for (const [dx, dy] of NESW) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) used[ny * cols + nx] = 1;
      }
    }
  }

  const outside = outsideMask(grid, cols, rows);
  let ent = null; // the front door, for rooms that care where you walk in
  for (let y = 0; y < rows && !ent; y++) {
    for (let x = 0; x < cols && !ent; x++) {
      if (grid[y * cols + x] !== DOOR) continue;
      const open = NESW.some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx < 0 || ny < 0 || nx >= cols || ny >= rows || outside[ny * cols + nx] === 1;
      });
      if (open) ent = [x, y];
    }
  }

  const out = [];
  const freeAt = (x, y) => (at(x, y) === FLOOR || at(x, y) === WINDOW) && !used[y * cols + x];
  const wallSide = (x, y) => at(x, y - 1) === SOLID ? 0 : at(x + 1, y) === SOLID ? 1
    : at(x, y + 1) === SOLID ? 2 : at(x - 1, y) === SOLID ? 3 : -1;
  const place = (x, y, kind, rot = 0) => { used[y * cols + x] = 1; out.push({ x, y, kind, rot }); };
  const placeIn = (room, kind, tries, need = null, rotOf = null) => {
    for (let t = 0; t < tries; t++) {
      const x = rng.int(room.x0, room.x1), y = rng.int(room.y0, room.y1);
      if (!freeAt(x, y) || (need && !need(x, y))) continue;
      place(x, y, kind, rotOf ? rotOf(x, y) : 0);
      return true;
    }
    return false;
  };
  const placeWall = (room, kind, tries) =>
    placeIn(room, kind, tries, (x, y) => wallSide(x, y) >= 0, (x, y) => wallSide(x, y));
  const placeTable = (room, tries) => {
    for (let t = 0; t < tries; t++) {
      const x = rng.int(room.x0, room.x1), y = rng.int(room.y0, room.y1);
      const horiz = rng.chance(0.5);
      const x2 = horiz ? x + 1 : x, y2 = horiz ? y : y + 1;
      if (!freeAt(x, y) || !freeAt(x2, y2)) continue;
      place(x, y, 'table', horiz ? 0 : 1);
      used[y2 * cols + x2] = 1;
      const seats = horiz
        ? [[x, y - 1, 0], [x2, y - 1, 0], [x, y + 1, 2], [x2, y + 1, 2], [x - 1, y, 3], [x2 + 1, y, 1]]
        : [[x - 1, y, 3], [x - 1, y2, 3], [x + 1, y, 1], [x + 1, y2, 1], [x, y - 1, 0], [x, y2 + 1, 2]];
      for (const [cx, cy, crot] of seats) {
        if (freeAt(cx, cy) && rng.chance(0.7)) place(cx, cy, 'chair', crot);
      }
      return true;
    }
    return false;
  };

  const b = p.building;
  const big = rooms[0];
  const small = rooms.slice(1).filter((r) => r.cells.length >= 4);

  if (b === 'tavern' || b === 'inn') {
    const nTables = rng.int(2, 4);
    for (let i = 0; i < nTables; i++) placeTable(big, 14);
    placeWall(big, 'hearth', 16);
    if (b === 'tavern') {
      if (small[0]) { placeWall(small[0], 'shelf', 12); placeWall(small[0], 'hearth', 12); }
      if (small[1]) { placeIn(small[1], 'barrel', 10); placeIn(small[1], 'barrel', 10); placeIn(small[1], 'chest', 10); }
    } else {
      // north of the corridor: guest rooms get beds; south of it: the kitchen
      const corridor = rooms.find((r) => r !== big && (r.y1 === r.y0 || r.x1 === r.x0));
      for (const room of small) {
        if (room === corridor) continue;
        if (corridor && room.cy > corridor.cy) {
          placeWall(room, 'shelf', 10);
          placeIn(room, 'barrel', 8);
        } else {
          placeWall(room, 'bed', 12);
          placeIn(room, 'chest', 8);
        }
      }
    }
  } else if (b === 'keep') {
    placeIn(big, 'rug', 12);
    placeTable(big, 16);
    placeTable(big, 16);
    placeWall(big, 'hearth', 16);
    for (const room of small) {
      placeWall(room, 'bed', 10);
      placeIn(room, 'chest', 8);
    }
  } else if (b === 'temple') {
    const dist = (r) => ent ? Math.hypot(r.cx - ent[0], r.cy - ent[1]) : r.cells.length;
    let apse = null;
    for (const r of small) if (!apse || dist(r) > dist(apse)) apse = r;
    if (apse) {
      if (!placeWall(apse, 'altar', 20)) placeIn(apse, 'altar', 10);
      for (const room of small) {
        if (room === apse) continue;
        placeWall(room, 'shelf', 8);
        placeIn(room, 'chest', 6);
      }
    }
    // pews face the apse down the nave
    const horiz = (big.x1 - big.x0) >= (big.y1 - big.y0);
    const pewRot = !apse ? 0 : horiz ? (apse.cx < big.cx ? 1 : 3) : (apse.cy < big.cy ? 2 : 0);
    if (horiz) {
      const ay = Math.round(big.cy);
      for (let x = big.x0 + 1; x <= big.x1 - 1; x += 2) {
        for (const yy of [ay - 2, ay - 1, ay + 1, ay + 2]) if (freeAt(x, yy)) place(x, yy, 'chair', pewRot);
      }
    } else {
      const ax = Math.round(big.cx);
      for (let y = big.y0 + 1; y <= big.y1 - 1; y += 2) {
        for (const xx of [ax - 2, ax - 1, ax + 1, ax + 2]) if (freeAt(xx, y)) place(xx, y, 'chair', pewRot);
      }
    }
  } else if (b === 'shop') {
    const front = (ent && rooms.find((r) => r.cells.some(([x, y]) => Math.abs(x - ent[0]) + Math.abs(y - ent[1]) === 1))) || big;
    const back = rooms.find((r) => r !== front && r.cells.length >= 4) || front;
    const cy = Math.round(front.cy);
    for (let i = -1; i <= 1; i++) { // counter bars across the sales floor
      const x = Math.round(front.cx) + i;
      if (freeAt(x, cy)) place(x, cy, 'counter', 0);
    }
    placeWall(front, 'shelf', 10);
    placeWall(front, 'shelf', 10);
    placeIn(back, 'barrel', 8);
    placeIn(back, 'barrel', 8);
    placeWall(back, 'shelf', 10);
    placeIn(back, 'chest', 8);
  } else {
    placeTable(big, 12);
    placeWall(big, 'hearth', 14);
    placeIn(big, 'rug', 8);
    for (const room of small) {
      placeWall(room, 'bed', 12);
      placeIn(room, 'chest', 8);
    }
    if (!small.length) placeWall(big, 'bed', 12); // one-room cottage
  }
  return out;
}

// ---------- rendering ----------

function drawFurniture(ctx, f) {
  const u = CELL;
  ctx.save();
  ctx.lineJoin = 'round';
  if (f.kind === 'table') {
    // tables span the anchor cell plus the next cell along the rot axis
    ctx.translate((f.x + (f.rot === 0 ? 1 : 0.5)) * u, (f.y + (f.rot === 1 ? 1 : 0.5)) * u);
    if (f.rot === 1) ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#8a5f38';
    ctx.strokeStyle = '#3a250f';
    ctx.lineWidth = 1.6;
    ctx.fillRect(-u + 5, -u / 2 + 5, 2 * u - 10, u - 10);
    ctx.strokeRect(-u + 5, -u / 2 + 5, 2 * u - 10, u - 10);
    ctx.strokeStyle = 'rgba(58, 37, 15, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-u + 8, 0);
    ctx.lineTo(u - 8, 0);
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.translate((f.x + 0.5) * u, (f.y + 0.5) * u);
  ctx.rotate((f.rot || 0) * Math.PI / 2); // rot = which wall the back is against
  ctx.strokeStyle = '#3a250f';
  ctx.lineWidth = 1.4;
  switch (f.kind) {
    case 'chair':
      ctx.fillStyle = '#7a5232';
      ctx.fillRect(-5, -3, 10, 9);
      ctx.strokeRect(-5, -3, 10, 9);
      ctx.fillRect(-6, -7, 12, 4); // back rail
      ctx.strokeRect(-6, -7, 12, 4);
      break;
    case 'bed':
      ctx.fillStyle = '#7a5232';
      ctx.fillRect(-9, -10, 18, 20);
      ctx.strokeRect(-9, -10, 18, 20);
      ctx.fillStyle = '#9c3f2e'; // blanket
      ctx.fillRect(-9, -1, 18, 11);
      ctx.fillStyle = '#e0d8c4'; // pillow
      ctx.fillRect(-6, -8, 12, 5);
      ctx.strokeRect(-6, -8, 12, 5);
      break;
    case 'hearth':
      ctx.fillStyle = '#6f6a75';
      ctx.fillRect(-11, -13, 22, 12);
      ctx.strokeRect(-11, -13, 22, 12);
      ctx.beginPath();
      ctx.arc(0, -1, 6, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = '#2a1c14';
      ctx.fill();
      ctx.fillStyle = '#c96b32'; // embers
      for (const ex of [-3, 0, 3]) { ctx.beginPath(); ctx.arc(ex, -3, 1.3, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'altar':
      ctx.fillStyle = '#cfc7b4';
      ctx.fillRect(-8, -6, 16, 12);
      ctx.strokeRect(-8, -6, 16, 12);
      ctx.beginPath();
      ctx.moveTo(-8, -2); ctx.lineTo(8, -2); // cloth edge
      ctx.stroke();
      ctx.fillStyle = '#e0c477';
      for (const cx of [-5, 5]) { ctx.beginPath(); ctx.arc(cx, -4, 1.4, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'counter':
      ctx.fillStyle = '#8a5f38';
      ctx.fillRect(-11, -5, 22, 10);
      ctx.strokeRect(-11, -5, 22, 10);
      ctx.strokeStyle = 'rgba(58, 37, 15, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-9, 0); ctx.lineTo(9, 0);
      ctx.stroke();
      break;
    case 'barrel':
      ctx.fillStyle = '#8a5f38';
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'chest':
      ctx.fillStyle = '#7a5232';
      ctx.fillRect(-7, -5, 14, 10);
      ctx.strokeRect(-7, -5, 14, 10);
      ctx.beginPath();
      ctx.moveTo(-7, -1); ctx.lineTo(7, -1); // lid
      ctx.stroke();
      ctx.fillStyle = '#e0c477';
      ctx.fillRect(-1, -2, 2, 3); // latch
      break;
    case 'shelf':
      ctx.fillStyle = '#6d4c2f';
      ctx.fillRect(-11, -12, 22, 6);
      ctx.strokeRect(-11, -12, 22, 6);
      ctx.fillStyle = '#c9a86a';
      for (const sx of [-7, -2, 3, 8]) { ctx.beginPath(); ctx.arc(sx, -9, 1.4, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'rug':
      ctx.fillStyle = 'rgba(148, 63, 46, 0.5)';
      ctx.fillRect(-10, -8, 20, 16);
      ctx.strokeStyle = 'rgba(240, 230, 210, 0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-8, -6, 16, 12);
      break;
  }
  ctx.restore();
}

export function renderInteriorBase(map, model, scale = 1) {
  const m = model || buildInteriorModel(map);
  const { grid, cols, rows } = m;
  const W = cols * CELL, H = rows * CELL;
  const base = document.createElement('canvas');
  base.width = W * scale;
  base.height = H * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale); // all drawing below stays in native coordinates

  // outdoors: the same dark hatched surround as the dungeon exterior
  ctx.fillStyle = '#282132';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let d = -H; d < W; d += 8) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + H, H);
    ctx.stroke();
  }

  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? SOLID : grid[y * cols + x];
  const outside = outsideMask(grid, cols, rows);

  // floors: light parchment, hashed per-cell so boards don't read flat.
  // Generated walls connect to the border through solid, so they keep the
  // outdoor hatch (dungeon-style); only sealed-off pockets — user-painted
  // pillars and the like — get the wall-mass fill instead
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (grid[i] === SOLID) {
        if (!outside[i]) {
          ctx.fillStyle = '#2f2740';
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
        continue;
      }
      const shade = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
      ctx.fillStyle = `hsl(39, 34%, ${79 + (shade % 5)}%)`;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.strokeStyle = 'rgba(90, 75, 55, 0.22)';
      ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
    }
  }

  // walls: thick edges wherever floor meets solid
  ctx.strokeStyle = '#171123';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'square';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (at(x, y) === SOLID) continue;
      const px = x * CELL, py = y * CELL;
      ctx.beginPath();
      if (at(x, y - 1) === SOLID) { ctx.moveTo(px, py); ctx.lineTo(px + CELL, py); }
      if (at(x, y + 1) === SOLID) { ctx.moveTo(px, py + CELL); ctx.lineTo(px + CELL, py + CELL); }
      if (at(x - 1, y) === SOLID) { ctx.moveTo(px, py); ctx.lineTo(px, py + CELL); }
      if (at(x + 1, y) === SOLID) { ctx.moveTo(px + CELL, py); ctx.lineTo(px + CELL, py + CELL); }
      ctx.stroke();
    }
  }

  // windows: double thin lines set into each wall-facing edge
  ctx.strokeStyle = '#7e93ad';
  ctx.lineWidth = 1.4;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[y * cols + x] !== WINDOW) continue;
      const px = x * CELL, py = y * CELL;
      ctx.beginPath();
      if (at(x, y - 1) === SOLID) { ctx.moveTo(px + 4, py + 2); ctx.lineTo(px + CELL - 4, py + 2); ctx.moveTo(px + 4, py + 5); ctx.lineTo(px + CELL - 4, py + 5); }
      if (at(x, y + 1) === SOLID) { ctx.moveTo(px + 4, py + CELL - 2); ctx.lineTo(px + CELL - 4, py + CELL - 2); ctx.moveTo(px + 4, py + CELL - 5); ctx.lineTo(px + CELL - 4, py + CELL - 5); }
      if (at(x - 1, y) === SOLID) { ctx.moveTo(px + 2, py + 4); ctx.lineTo(px + 2, py + CELL - 4); ctx.moveTo(px + 5, py + 4); ctx.lineTo(px + 5, py + CELL - 4); }
      if (at(x + 1, y) === SOLID) { ctx.moveTo(px + CELL - 2, py + 4); ctx.lineTo(px + CELL - 2, py + CELL - 4); ctx.moveTo(px + CELL - 5, py + 4); ctx.lineTo(px + CELL - 5, py + CELL - 4); }
      ctx.stroke();
    }
  }

  // doors: brown bar across the passage, oriented like dungeon.js
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[y * cols + x] !== DOOR) continue;
      const px = x * CELL, py = y * CELL;
      const horizontalPassage = at(x - 1, y) !== SOLID && at(x + 1, y) !== SOLID;
      ctx.fillStyle = '#8a5a30';
      ctx.strokeStyle = '#3a250f';
      ctx.lineWidth = 1.5;
      if (horizontalPassage) {
        ctx.fillRect(px + CELL / 2 - 3, py + 4, 6, CELL - 8);
        ctx.strokeRect(px + CELL / 2 - 3, py + 4, 6, CELL - 8);
      } else {
        ctx.fillRect(px + 4, py + CELL / 2 - 3, CELL - 8, 6);
        ctx.strokeRect(px + 4, py + CELL / 2 - 3, CELL - 8, 6);
      }
    }
  }

  // furniture: rugs lie under everything else
  const furniture = m.furniture || [];
  for (const f of furniture) if (f.kind === 'rug') drawFurniture(ctx, f);
  for (const f of furniture) if (f.kind !== 'rug') drawFurniture(ctx, f);

  // room numbers tucked into corners
  ctx.font = 'bold 10px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(60, 40, 20, 0.7)';
  roomsOf(grid, cols, rows).filter((r) => r.cells.length >= 4).forEach((room, i) => {
    const [ax, ay] = room.cells[0]; // topmost-leftmost floor cell
    const roomLabel = m.rooms?.find(r=>ax>=r.x0&&ax<=r.x1&&ay>=r.y0&&ay<=r.y1);
    ctx.fillText(roomLabel ? `${i+1}. ${roomLabel.role}` : String(i + 1), ax * CELL + 4, ay * CELL + 3);
  });

  return base;
}
