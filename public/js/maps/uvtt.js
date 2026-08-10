// Universal VTT 0.3 export for grid-based interior and dungeon maps.
// Geometry is expressed in grid units; pixels_per_grid describes the embedded
// PNG. This is the coordinate contract used by Foundry's Universal Battlemap
// Importer and keeps walls aligned at every image export scale.

import { MAP_KINDS } from './mapcore.js';

const SOLID = 0;
const DOOR = 2;

export const supportsUniversalVtt = (map) => map?.kind === 'dungeon' || map?.kind === 'interior';

const point = (x, y) => ({ x, y });

function addInterval(groups, axis, a, b) {
  let list = groups.get(axis);
  if (!list) groups.set(axis, list = []);
  list.push([a, b]);
}

function mergedSegments(groups, horizontal) {
  const out = [];
  for (const [axis, intervals] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let [start, end] = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      const [nextStart, nextEnd] = intervals[i];
      if (nextStart <= end) end = Math.max(end, nextEnd);
      else {
        out.push(horizontal
          ? [point(start, axis), point(end, axis)]
          : [point(axis, start), point(axis, end)]);
        [start, end] = [nextStart, nextEnd];
      }
    }
    out.push(horizontal
      ? [point(start, axis), point(end, axis)]
      : [point(axis, start), point(axis, end)]);
  }
  return out;
}

/** Extract merged floor-to-solid boundaries in Universal VTT grid units. */
export function gridLineOfSight(grid, cols, rows) {
  const horizontal = new Map(), vertical = new Map();
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? SOLID : grid[y * cols + x];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (at(x, y) === SOLID) continue;
      if (at(x, y - 1) === SOLID) addInterval(horizontal, y, x, x + 1);
      if (at(x, y + 1) === SOLID) addInterval(horizontal, y + 1, x, x + 1);
      if (at(x - 1, y) === SOLID) addInterval(vertical, x, y, y + 1);
      if (at(x + 1, y) === SOLID) addInterval(vertical, x + 1, y, y + 1);
    }
  }
  return [...mergedSegments(horizontal, true), ...mergedSegments(vertical, false)];
}

/** Extract door cells as closed UVTT portals across each passage's narrow axis. */
export function gridPortals(grid, cols, rows, cellSize) {
  const portals = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? SOLID : grid[y * cols + x];
  const inset = Math.min(0.25, 4 / cellSize);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[y * cols + x] !== DOOR) continue;
      const horizontalPassage = at(x - 1, y) !== SOLID && at(x + 1, y) !== SOLID;
      const bounds = horizontalPassage
        ? [point(x + 0.5, y + inset), point(x + 0.5, y + 1 - inset)]
        : [point(x + inset, y + 0.5), point(x + 1 - inset, y + 0.5)];
      portals.push({
        position: point(x + 0.5, y + 0.5),
        bounds,
        // Universal VTT rotations are radians. The portal is a barrier across
        // the passage, not a segment running along it.
        rotation: horizontalPassage ? Math.PI / 2 : 0,
        closed: true,
        freestanding: false,
      });
    }
  }
  return portals;
}

function drawnWallLines(map, cols, rows, { gm, level }) {
  const clamp = (n, max) => Math.max(0, Math.min(max, n));
  const lines = [];
  for (const path of map.paths || []) {
    if (path.style !== 'wall' || (path.secret && !gm) || (path.level || 0) !== level) continue;
    const pts = (path.pts || []).map(([x, y]) => point(clamp(x * cols, cols), clamp(y * rows, rows)));
    if (pts.length < 2) continue;
    if (path.closed) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a.x !== b.x || a.y !== b.y) pts.push(point(a.x, a.y));
    }
    lines.push(pts);
  }
  return lines;
}

export function universalVttGeometry(map, opts = {}) {
  if (!supportsUniversalVtt(map)) throw new Error('Universal VTT export is only available for dungeons and interiors.');
  const level = Math.max(0, Number(opts.level) || 0);
  const kind = MAP_KINDS[map.kind];
  const model = opts.model || kind.buildModel(map, level);
  const { grid, cols, rows } = model;
  return {
    cols,
    rows,
    cellSize: kind.cellSize,
    lineOfSight: [
      ...gridLineOfSight(grid, cols, rows),
      ...drawnWallLines(map, cols, rows, { gm: !!opts.gm, level }),
    ],
    portals: gridPortals(grid, cols, rows, kind.cellSize),
  };
}

/** Build a schema-complete Universal VTT document around a rendered PNG. */
export function buildUniversalVtt(map, imageBase64, opts = {}) {
  const scale = Math.max(1, Number(opts.scale) || 1);
  const geometry = universalVttGeometry(map, opts);
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    // catches the easy mistake of passing opts in the image slot — a silent
    // "[object Object]" image would export a document Foundry can't read
    throw new Error('Universal VTT export needs an embedded map image (base64 string).');
  }
  const image = imageBase64.replace(/^data:image\/[^;]+;base64,/, '');
  return {
    format: 0.3,
    resolution: {
      map_origin: point(0, 0),
      map_size: point(geometry.cols, geometry.rows),
      pixels_per_grid: geometry.cellSize * scale,
    },
    line_of_sight: geometry.lineOfSight,
    portals: geometry.portals,
    lights: [],
    environment: { baked_lighting: true, ambient_light: 'ffffffff' },
    image,
  };
}

export function universalVttText(map, imageBase64, opts = {}) {
  return JSON.stringify(buildUniversalVtt(map, imageBase64, opts), null, 2);
}
