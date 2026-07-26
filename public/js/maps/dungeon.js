// Dungeon map generator: rooms + MST corridors + doors on a cell grid.
// The grid is editable — once the user paints, the edited grid is stored on the
// map (map.grid) and used instead of regenerating from the seed.

import { makeRng } from '../util.js';

export const CELL = 22;
export const FLOOR = 1, SOLID = 0, DOOR = 2;

export function defaultDungeonParams() {
  return { cols: 42, rows: 27, rooms: 9, loops: 0.25, style: 'rooms' };
}

export const DUNGEON_STYLES = { rooms: 'Rooms & corridors', caves: 'Natural caves' };

export function dungeonSize(map) {
  const p = { ...defaultDungeonParams(), ...(map.params || {}) };
  return [p.cols * CELL, p.rows * CELL];
}

// Cellular-automata caves: random rock, smooth it, then keep the big pockets
// and join them with rough tunnels. Its own rng stream — the 'rooms' path must
// keep consuming exactly what it always has so existing dungeons don't change.
function generateCaves(p, seed) {
  const { cols, rows } = p;
  const rng = makeRng(seed + ':caves');
  let grid = new Uint8Array(cols * rows);
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      grid[y * cols + x] = rng.chance(0.55) ? FLOOR : SOLID;
    }
  }
  // classic 4-5 rule, counting the cell itself — without self-count the rock erodes away
  const wallsAround = (g, x, y) => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx <= 0 || ny <= 0 || nx >= cols - 1 || ny >= rows - 1 || g[ny * cols + nx] === SOLID) n++;
      }
    }
    return n;
  };
  for (let pass = 0; pass < 4; pass++) {
    const next = new Uint8Array(grid);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        next[y * cols + x] = wallsAround(grid, x, y) >= 5 ? SOLID : FLOOR;
      }
    }
    grid = next;
  }
  // flood-fill the pockets; erase crumbs, tunnel the rest into the largest one
  const seen = new Int32Array(cols * rows).fill(-1);
  const pockets = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== FLOOR || seen[i] >= 0) continue;
    const cells = [i];
    seen[i] = pockets.length;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], x = c % cols, y = (c / cols) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (grid[ni] === FLOOR && seen[ni] < 0) { seen[ni] = pockets.length; cells.push(ni); }
      }
    }
    pockets.push(cells);
  }
  if (pockets.length) {
    pockets.sort((a, b) => b.length - a.length);
    const centerOf = (cells) => {
      const c = cells[(cells.length / 2) | 0];
      return [c % cols, (c / cols) | 0];
    };
    const [mx, my] = centerOf(pockets[0]);
    for (let pi = 1; pi < pockets.length; pi++) {
      if (pockets[pi].length < 12) {
        for (const c of pockets[pi]) grid[c] = SOLID;
        continue;
      }
      let [x, y] = centerOf(pockets[pi]);
      while (x !== mx || y !== my) {
        if (x !== mx && (y === my || rng.chance(0.6))) x += Math.sign(mx - x);
        else y += Math.sign(my - y);
        grid[y * cols + x] = FLOOR;
        if (rng.chance(0.4) && x > 1 && x < cols - 2) {
          grid[y * cols + x + (rng.chance(0.5) ? 1 : -1)] = FLOOR; // ragged, cave-like tunnels
        }
      }
    }
  }
  return { grid, cols, rows };
}

/** Generate the cell grid from seed + params. */
export function generateDungeonGrid(map) {
  const p = { ...defaultDungeonParams(), ...(map.params || {}) };
  if (p.style === 'caves') return generateCaves(p, map.seed);
  const { cols, rows } = p;
  const rng = makeRng(map.seed);
  const grid = new Uint8Array(cols * rows);

  // place non-overlapping rooms
  const rooms = [];
  for (let t = 0; t < p.rooms * 6 && rooms.length < p.rooms; t++) {
    const w = rng.int(3, 8), h = rng.int(3, 6);
    const x = rng.int(1, cols - w - 2), y = rng.int(1, rows - h - 2);
    if (rooms.some((r) => x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y)) continue;
    rooms.push({ x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) });
  }
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) grid[y * cols + x] = FLOOR;
    }
  }

  const inRoom = (x, y) => rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

  // connect rooms: MST (Prim) + a few extra loop edges
  if (rooms.length > 1) {
    const edges = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        edges.push([i, j, Math.hypot(rooms[i].cx - rooms[j].cx, rooms[i].cy - rooms[j].cy)]);
      }
    }
    edges.sort((a, b) => a[2] - b[2]);
    const connected = new Set([0]);
    const chosen = [];
    while (connected.size < rooms.length) {
      const e = edges.find(([i, j]) => connected.has(i) !== connected.has(j));
      if (!e) break;
      chosen.push(e);
      connected.add(e[0]); connected.add(e[1]);
    }
    const extra = Math.floor(p.loops * rooms.length);
    for (const e of edges) {
      if (chosen.length >= rooms.length - 1 + extra) break;
      if (!chosen.includes(e) && rng.chance(0.5)) chosen.push(e);
    }

    for (const [i, j] of chosen) {
      const a = rooms[i], b = rooms[j];
      const path = [];
      let x = a.cx, y = a.cy;
      const xFirst = rng.chance(0.5);
      const walkX = () => { while (x !== b.cx) { x += Math.sign(b.cx - x); path.push([x, y]); } };
      const walkY = () => { while (y !== b.cy) { y += Math.sign(b.cy - y); path.push([x, y]); } };
      if (xFirst) { walkX(); walkY(); } else { walkY(); walkX(); }

      let wasInRoom = true; // path starts at room center
      let prev = null;
      for (const [px, py] of path) {
        const nowInRoom = inRoom(px, py);
        if (grid[py * cols + px] === SOLID) grid[py * cols + px] = FLOOR;
        if (nowInRoom !== wasInRoom) {
          // crossing a room boundary — the door goes on the corridor side
          const doorCell = nowInRoom ? prev : [px, py];
          if (doorCell && !inRoom(doorCell[0], doorCell[1])) {
            const di = doorCell[1] * cols + doorCell[0];
            if (grid[di] === FLOOR) grid[di] = DOOR;
          }
        }
        wasInRoom = nowInRoom;
        prev = [px, py];
      }
    }
  }
  return { grid, cols, rows };
}

/** Get the working grid: user-edited if present, else generated from seed. */
export function dungeonGrid(map) {
  const p = { ...defaultDungeonParams(), ...(map.params || {}) };
  if (map.grid) {
    const rows = map.grid.split('\n');
    const grid = new Uint8Array(p.cols * p.rows);
    for (let y = 0; y < Math.min(rows.length, p.rows); y++) {
      for (let x = 0; x < Math.min(rows[y].length, p.cols); x++) {
        grid[y * p.cols + x] = rows[y][x] === '#' ? SOLID : rows[y][x] === 'D' ? DOOR : rows[y][x] === '.' ? FLOOR : SOLID;
      }
    }
    return { grid, cols: p.cols, rows: p.rows };
  }
  return generateDungeonGrid(map);
}

export function gridToString(grid, cols, rows) {
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const v = grid[y * cols + x];
      line += v === FLOOR ? '.' : v === DOOR ? 'D' : '#';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Number distinct floor areas (flood fill) so rooms get labels even after edits. */
function numberRooms(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const areas = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (grid[i] !== FLOOR || seen[i]) continue;
      const cells = [];
      const stack = [[x, y]];
      seen[i] = 1;
      while (stack.length) {
        const [px, py] = stack.pop();
        cells.push([px, py]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (grid[ni] === FLOOR && !seen[ni]) { seen[ni] = 1; stack.push([nx, ny]); }
        }
      }
      // treat compact blobs as "rooms", skip skinny corridors
      const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
      const bw = Math.max(...xs) - Math.min(...xs) + 1, bh = Math.max(...ys) - Math.min(...ys) + 1;
      if (cells.length >= 9 && cells.length / (bw * bh) > 0.6 && bw >= 3 && bh >= 3) {
        areas.push({ cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 });
      }
    }
  }
  return areas;
}

export function renderDungeonBase(map, model, scale = 1) {
  const { grid, cols, rows } = model || dungeonGrid(map);
  const W = cols * CELL, H = rows * CELL;
  const base = document.createElement('canvas');
  base.width = W * scale; base.height = H * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale); // all drawing below stays in native coordinates

  // exterior stone + hatching
  ctx.fillStyle = '#282132';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let d = -H; d < W; d += 8) {
    ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + H, H); ctx.stroke();
  }

  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? SOLID : grid[y * cols + x];

  // floors — hashed per-cell shading so large floors don't read as flat slabs
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid[y * cols + x];
      if (v === SOLID) continue;
      const shade = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
      ctx.fillStyle = `hsl(41, 33%, ${78 + (shade % 5)}%)`;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.strokeStyle = 'rgba(90, 75, 55, 0.25)';
      ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
    }
  }

  // walls: thick edges between floor and solid
  ctx.strokeStyle = '#151020';
  ctx.lineWidth = 3;
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

  // doors: brown bar across the narrow axis
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[y * cols + x] !== DOOR) continue;
      const px = x * CELL, py = y * CELL;
      const horizontalPassage = at(x - 1, y) !== SOLID && at(x + 1, y) !== SOLID;
      ctx.fillStyle = '#8a5a30';
      ctx.strokeStyle = '#3a250f';
      ctx.lineWidth = 1.5;
      if (horizontalPassage) {
        ctx.fillRect(px + 4, py + CELL / 2 - 3, CELL - 8, 6);
        ctx.strokeRect(px + 4, py + CELL / 2 - 3, CELL - 8, 6);
      } else {
        ctx.fillRect(px + CELL / 2 - 3, py + 4, 6, CELL - 8);
        ctx.strokeRect(px + CELL / 2 - 3, py + 4, 6, CELL - 8);
      }
    }
  }

  // room numbers
  ctx.font = `bold ${Math.round(CELL * 0.55)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  numberRooms(grid, cols, rows).forEach((room, i) => {
    ctx.fillStyle = 'rgba(60, 40, 20, 0.75)';
    ctx.fillText(String(i + 1), (room.cx + 0.5) * CELL, (room.cy + 0.5) * CELL);
  });

  return base;
}
