// Dungeon map generator: rooms + MST corridors + doors on a cell grid.
// The grid is editable — once the user paints, the edited grid is stored on the
// map (map.grid) and used instead of regenerating from the seed.

import { makeRng } from '../util.js';
import { connectRooms, dungeonPurpose } from './floorplans.js';

export const CELL = 22;
export const FLOOR = 1, SOLID = 0, DOOR = 2, STAIR_DOWN = 3, STAIR_UP = 4;

export function defaultDungeonParams() {
  return { cols: 42, rows: 27, rooms: 9, loops: 0.25, style: 'rooms', levels: 1 };
}

export const DUNGEON_STYLES = {
  rooms: 'Rooms & corridors', caves: 'Natural caves',
  crypt: 'Crypt', mine: 'Mine', sewer: 'Sewers',
};

export function dungeonSize(map) {
  const p = { ...defaultDungeonParams(), ...(map.params || {}) };
  return [p.cols * CELL, p.rows * CELL];
}

export const dungeonLevels = (map) => Math.max(1, Math.min(5, map.params?.levels || 1));

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

// Crypt: a central processional spine, symmetric burial chambers with niches,
// and a grand tomb at the far end. Own stream — opt-in style, never the default.
function generateCrypt(p, seedStr) {
  const { cols, rows } = p;
  const rng = makeRng(seedStr + ':crypt');
  const grid = new Uint8Array(cols * rows);
  const midY = (rows / 2) | 0;
  const spineEnd = cols - 8;
  for (let x = 2; x <= spineEnd; x++) grid[midY * cols + x] = FLOOR;
  const step = rng.int(6, 8);
  for (let x = 5; x < spineEnd - 3; x += step) {
    for (const side of [-1, 1]) {
      if (rng.chance(0.2)) continue;
      const w = rng.int(3, 5), h = rng.int(3, 4), gap = rng.int(1, 2);
      const y0 = side < 0 ? midY - gap - h : midY + gap + 1;
      if (y0 < 2 || y0 + h > rows - 2) continue;
      for (let dy = 1; dy <= gap; dy++) grid[(midY + side * dy) * cols + x] = dy === gap ? DOOR : FLOOR;
      const x0 = x - ((w / 2) | 0);
      for (let yy = y0; yy < y0 + h; yy++) {
        for (let xx = x0; xx < x0 + w; xx++) {
          if (xx > 1 && xx < cols - 2) grid[yy * cols + xx] = FLOOR;
        }
      }
      // burial niches off the chamber's far wall
      const nichY = side < 0 ? y0 - 1 : y0 + h;
      if (nichY > 0 && nichY < rows - 1) {
        for (let xx = x0; xx < x0 + w; xx += 2) {
          if (rng.chance(0.7) && xx > 1 && xx < cols - 2) grid[nichY * cols + xx] = FLOOR;
        }
      }
    }
  }
  // the grand tomb
  const tw = rng.int(5, 7), th = rng.int(5, 7);
  const ty = Math.max(2, midY - ((th / 2) | 0));
  grid[midY * cols + spineEnd + 1] = DOOR;
  for (let yy = ty; yy < Math.min(rows - 2, ty + th); yy++) {
    for (let xx = spineEnd + 2; xx < Math.min(cols - 2, spineEnd + 2 + tw); xx++) grid[yy * cols + xx] = FLOOR;
  }
  return { grid, cols, rows };
}

// Mine: drifts random-walking from the adit, branching, with dug-out galleries.
function generateMine(p, seedStr) {
  const { cols, rows } = p;
  const rng = makeRng(seedStr + ':mine');
  const grid = new Uint8Array(cols * rows);
  const carve = (x, y) => {
    if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) grid[y * cols + x] = FLOOR;
  };
  const gallery = (x, y, r) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + 1) carve(x + dx, y + dy);
      }
    }
  };
  const drifts = [[1, rng.int((rows / 3) | 0, (2 * rows / 3) | 0)]];
  gallery(2, drifts[0][1], 1); // the adit
  let guard = 0;
  while (drifts.length && guard++ < 400) {
    const d = drifts.pop();
    let [x, y] = d;
    while (x < cols - 3) {
      carve(x, y);
      if (rng.chance(0.35)) carve(x, y + (rng.chance(0.5) ? 1 : -1));
      x++;
      if (rng.chance(0.3)) y += rng.chance(0.5) ? 1 : -1;
      y = Math.max(2, Math.min(rows - 3, y));
      if (rng.chance(0.05)) gallery(x, y, rng.int(1, 2));
      if (rng.chance(0.06) && drifts.length < 4) {
        // a branch heads off vertically before resuming the dig
        let by = y;
        const dir = rng.chance(0.5) ? 1 : -1;
        const len = rng.int(4, 9);
        for (let i = 0; i < len; i++) {
          by += dir;
          if (by < 2 || by > rows - 3) break;
          carve(x, by);
          if (rng.chance(0.25)) carve(x + 1, by);
        }
        if (rng.chance(0.5)) gallery(x, Math.max(2, Math.min(rows - 3, by)), rng.int(1, 2));
      }
    }
  }
  return { grid, cols, rows };
}

// Sewers: a wide main gallery, parallel side channels, junction chambers.
function generateSewer(p, seedStr) {
  const { cols, rows } = p;
  const rng = makeRng(seedStr + ':sewer');
  const grid = new Uint8Array(cols * rows);
  const midY = (rows / 2) | 0;
  for (let x = 1; x < cols - 1; x++) {
    for (let dy = -1; dy <= 1; dy++) grid[(midY + dy) * cols + x] = FLOOR;
  }
  const xs = [];
  for (let x = rng.int(4, 7); x < cols - 4; x += rng.int(5, 9)) xs.push(x);
  for (const x of xs) {
    const up = rng.chance(0.8), down = rng.chance(0.8);
    const wide = rng.chance(0.35) ? 1 : 0;
    if (up) {
      const yEnd = rng.int(2, midY - 3);
      for (let y = yEnd; y < midY; y++) {
        for (let dx = 0; dx <= wide; dx++) grid[y * cols + x + dx] = FLOOR;
      }
      if (rng.chance(0.5)) { // junction chamber at the dead end
        for (let yy = Math.max(1, yEnd - 2); yy <= yEnd + 1; yy++) {
          for (let xx = Math.max(1, x - 2); xx <= Math.min(cols - 2, x + 2 + wide); xx++) grid[yy * cols + xx] = FLOOR;
        }
      }
    }
    if (down) {
      const yEnd = rng.int(midY + 3, rows - 3);
      for (let y = midY; y <= yEnd; y++) {
        for (let dx = 0; dx <= wide; dx++) grid[y * cols + x + dx] = FLOOR;
      }
      if (rng.chance(0.5)) {
        for (let yy = yEnd - 1; yy <= Math.min(rows - 2, yEnd + 2); yy++) {
          for (let xx = Math.max(1, x - 2); xx <= Math.min(cols - 2, x + 2 + wide); xx++) grid[yy * cols + xx] = FLOOR;
        }
      }
    }
  }
  return { grid, cols, rows };
}

/** Generate one level's grid from seed + params. Level 0 consumes exactly what it always has. */
export function generateDungeonGrid(map, level = 0) {
  if (map.params?.generation==='1.8') {
    const legacy={...map,seed:map.seed+':v18:topology',params:{...map.params,generation:'legacy'}};
    const model=generateDungeonGrid(legacy,level);
    connectRooms(model.grid,model.cols,model.rows);
    return {...model,...dungeonPurpose(model.grid,model.cols,model.rows),generation:'1.8'};
  }
  const p = { ...defaultDungeonParams(), ...(map.params || {}) };
  const seedStr = level ? `${map.seed}:L${level}` : map.seed;
  if (p.style === 'caves') return generateCaves(p, seedStr);
  if (p.style === 'crypt') return generateCrypt(p, seedStr);
  if (p.style === 'mine') return generateMine(p, seedStr);
  if (p.style === 'sewer') return generateSewer(p, seedStr);
  const { cols, rows } = p;
  const rng = makeRng(seedStr);
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

const CHAR_CODE = { '#': SOLID, '.': FLOOR, D: DOOR, '>': STAIR_DOWN, '<': STAIR_UP };

function parseGrid(str, p) {
  const rows = str.split('\n');
  const grid = new Uint8Array(p.cols * p.rows);
  for (let y = 0; y < Math.min(rows.length, p.rows); y++) {
    for (let x = 0; x < Math.min(rows[y].length, p.cols); x++) {
      grid[y * p.cols + x] = CHAR_CODE[rows[y][x]] ?? SOLID; // unknown chars stay walls (fwd compat)
    }
  }
  return { grid, cols: p.cols, rows: p.rows };
}

/**
 * Carve stair pairs between freshly generated neighbouring levels. Levels the
 * user has painted (stored strings) are never written to — their stairs are
 * whatever the user painted, via the stair tools.
 */
function carveStairs(all, generated, map, cols, rows) {
  const rng = makeRng(map.seed + (map.params?.generation==='1.8'?':v18:stairs':':stairs'));
  for (let n = 0; n < all.length - 1; n++) {
    if (!generated[n] || !generated[n + 1]) continue;
    const a = all[n].grid, b = all[n + 1].grid;
    const candidates = [];
    for (let i = 0; i < a.length; i++) if (a[i] === FLOOR && b[i] === FLOOR) candidates.push(i);
    let c;
    if (candidates.length) {
      c = candidates[rng.int(0, candidates.length - 1)];
    } else {
      const floors = [];
      for (let i = 0; i < a.length; i++) if (a[i] === FLOOR) floors.push(i);
      if (!floors.length) continue;
      c = floors[rng.int(0, floors.length - 1)];
      const x = c % cols, y = (c / cols) | 0; // open a landing below
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx > 0 && ny > 0 && nx < cols - 1 && ny < rows - 1) b[ny * cols + nx] = FLOOR;
        }
      }
    }
    a[c] = STAIR_DOWN;
    b[c] = STAIR_UP;
    if (map.params?.generation==='1.8') {
      connectRooms(a,cols,rows);connectRooms(b,cols,rows);
      Object.assign(all[n],dungeonPurpose(a,cols,rows));Object.assign(all[n+1],dungeonPurpose(b,cols,rows));
    }
  }
}

/**
 * Get one level's working grid: user-edited if stored, else generated.
 * Storage contract: map.grid is level 1 exactly as it always was; deeper
 * levels live in map.grids[n] (index 0 unused/null). Old builds keep reading
 * map.grid and simply ignore the rest.
 */
export function dungeonGrid(map, level = 0) {
  const p = { ...defaultDungeonParams(), ...(map.params || {}) };
  const levels = dungeonLevels(map);
  if (levels === 1) {
    if (map.grid) return parseGrid(map.grid, p);
    return generateDungeonGrid(map);
  }
  const stored = (n) => (n === 0 ? map.grid : map.grids?.[n]);
  const all = [], generated = [];
  for (let n = 0; n < levels; n++) {
    if (stored(n)) { all.push(parseGrid(stored(n), p)); generated.push(false); }
    else { all.push(generateDungeonGrid(map, n)); generated.push(true); }
  }
  carveStairs(all, generated, map, p.cols, p.rows);
  return all[Math.max(0, Math.min(level, levels - 1))];
}

export function gridToString(grid, cols, rows) {
  const CODE_CHAR = { [SOLID]: '#', [FLOOR]: '.', [DOOR]: 'D', [STAIR_DOWN]: '>', [STAIR_UP]: '<' };
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      line += CODE_CHAR[grid[y * cols + x]] ?? '#';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Number distinct floor areas (flood fill) so rooms get labels even after edits.
 *  Room n is areas[n - 1]; map keys (mapkeys.js) find a room by its cells. */
export function dungeonRooms(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const areas = [];
  // stairs count as walkable floor here — a stair in a room must not split it
  const open = (v) => v === FLOOR || v === STAIR_DOWN || v === STAIR_UP;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!open(grid[i]) || seen[i]) continue;
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
          if (open(grid[ni]) && !seen[ni]) { seen[ni] = 1; stack.push([nx, ny]); }
        }
      }
      // treat compact blobs as "rooms", skip skinny corridors
      const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
      const bw = Math.max(...xs) - Math.min(...xs) + 1, bh = Math.max(...ys) - Math.min(...ys) + 1;
      if (cells.length >= 9 && cells.length / (bw * bh) > 0.6 && bw >= 3 && bh >= 3) {
        areas.push({ cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, cells });
      }
    }
  }
  return areas;
}

// `show` limits the generator's annotations for player renders; absent means
// a GM render (room numbers and 1.8 guidance), so callers that pass nothing
// draw exactly as before. See baseAnnotations() in mapcore.js.
export function renderDungeonBase(map, model, scale = 1, show = {}) {
  const m = model || dungeonGrid(map);
  const { grid, cols, rows } = m;
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

  // floors — hashed per-cell shading so large floors don't read as flat slabs.
  // New styles tint the stone; 'rooms' and 'caves' keep their exact colors.
  const style = map.params?.style || 'rooms';
  const floorHsl = style === 'crypt' ? [232, 10, 72] : style === 'mine' ? [27, 26, 70] : style === 'sewer' ? [158, 12, 66] : [41, 33, 78];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid[y * cols + x];
      if (v === SOLID) continue;
      const shade = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
      ctx.fillStyle = `hsl(${floorHsl[0]}, ${floorHsl[1]}%, ${floorHsl[2] + (shade % 5)}%)`;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.strokeStyle = 'rgba(90, 75, 55, 0.25)';
      ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
    }
  }

  // sewers get their central water channel, joining up with open neighbours
  if (style === 'sewer') {
    ctx.strokeStyle = 'rgba(38, 84, 74, 0.65)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (at(x, y) === SOLID || at(x, y) === DOOR) continue;
        const cx = (x + 0.5) * CELL, cy = (y + 0.5) * CELL;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const n = at(x + dx, y + dy);
          if (n !== SOLID && n !== DOOR) {
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + dx * CELL, cy + dy * CELL);
            ctx.stroke();
          }
        }
      }
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
        ctx.fillRect(px + CELL / 2 - 3, py + 4, 6, CELL - 8);
        ctx.strokeRect(px + CELL / 2 - 3, py + 4, 6, CELL - 8);
      } else {
        ctx.fillRect(px + 4, py + CELL / 2 - 3, CELL - 8, 6);
        ctx.strokeRect(px + 4, py + CELL / 2 - 3, CELL - 8, 6);
      }
    }
  }

  // stairs: classic shrinking-tread glyph; > descends (darker), < ascends
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid[y * cols + x];
      if (v !== STAIR_DOWN && v !== STAIR_UP) continue;
      const px = x * CELL, py = y * CELL;
      const down = v === STAIR_DOWN;
      ctx.strokeStyle = down ? '#3a250f' : '#6b5232';
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const inset = 3 + i * 2.4;
        ctx.beginPath();
        ctx.moveTo(px + inset, py + 4 + i * (CELL - 8) / 3.2);
        ctx.lineTo(px + CELL - inset, py + 4 + i * (CELL - 8) / 3.2);
        ctx.stroke();
      }
      ctx.font = `bold 9px Georgia, serif`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(down ? '▼' : '▲', px + CELL / 2, py + CELL - 5);
    }
  }

  // room numbers
  if (show.roomNumbers !== false) {
    ctx.font = `bold ${Math.round(CELL * 0.55)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    dungeonRooms(grid, cols, rows).forEach((room, i) => {
      ctx.fillStyle = 'rgba(60, 40, 20, 0.75)';
      ctx.fillText(String(i + 1), (room.cx + 0.5) * CELL, (room.cy + 0.5) * CELL);
    });
  }
  // IN/GOAL would point players straight at the adventure's destination
  if (m.generation==='1.8' && show.guidance !== false) {
    ctx.font='bold 10px Georgia';ctx.textAlign='left';
    for(const [point,label] of [[m.entrance,'IN'],[m.goal,'GOAL']])if(point){ctx.fillStyle='#552917';ctx.fillText(label,(point[0]+.1)*CELL,(point[1]+.2)*CELL);}
  }

  return base;
}
