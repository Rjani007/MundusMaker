'use strict';
// Terrain world style (meshterrain.js, mapgen4's approach) and the Metro
// modern-town layout (tensorcity.js, tensor-field streets). Models only; the
// pixels of every older map are pinned by `npm run test:render`.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

test('the Delaunay triangulation is valid: no point inside any circumcircle, twins agree', async () => {
  const { delaunay } = await load('maps/meshterrain.js');
  const { makeRng } = await load('util.js');
  const rng = makeRng('delaunay-check'), pts = [];
  for (let i = 0; i < 1500; i++) pts.push(rng.range(0, 400), rng.range(0, 250));
  const { triangles, halfedges } = delaunay(Float64Array.from(pts));
  const n = pts.length / 2;
  let hull = 0;
  for (const o of halfedges) if (o < 0) hull++;
  assert.equal(triangles.length / 3, 2 * n - 2 - hull, 'Euler count for a triangulated point set');
  for (let e = 0; e < halfedges.length; e++) {
    const o = halfedges[e];
    if (o < 0) continue;
    assert.equal(halfedges[o], e);
    assert.equal(triangles[e], triangles[o % 3 === 2 ? o - 2 : o + 1], 'twin runs the other way');
  }
  for (let t = 0; t < triangles.length / 3; t++) {
    const [a, b, c] = [triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]];
    const [ax, ay, bx, by, cx, cy] = [pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1], pts[c * 2], pts[c * 2 + 1]];
    assert.ok((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0, 'consistent orientation');
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    for (let i = 0; i < n; i++) {
      if (i === a || i === b || i === c) continue;
      assert.ok((pts[i * 2] - ux) ** 2 + (pts[i * 2 + 1] - uy) ** 2 >= r2 * (1 - 1e-9), `point ${i} inside triangle ${t}'s circumcircle`);
    }
  }
});

test('terrain worlds are deterministic, and live brush strokes equal a rebuild with them', async () => {
  const { buildWorldModel, applyWorldStroke, applyWorldStrokes } = await load('maps/world.js');
  for (const erosion of ['none', 'rivers']) {
    const map = { kind: 'world', seed: 'trial-terrain', params: { style: 'terrain', generation: '1.8', water: 0.5, nations: 3, erosion }, strokes: [] };
    const a = buildWorldModel(map), b = buildWorldModel(map);
    assert.ok(a.mesh && a.atlas && a.generation === '1.8', 'a terrain model on the shared atlas grid');
    assert.deepEqual(Array.from(a.height), Array.from(b.height));
    assert.deepEqual(a.towns.map((t) => [t.key, t.x, t.y]), b.towns.map((t) => [t.key, t.x, t.y]));
    assert.equal(a.height.length, a.gw * a.gh);
    const land = a.height.filter((h) => h >= a.water).length / a.height.length;
    assert.ok(land > 0.1 && land < 0.9, `some land and some sea (${land.toFixed(2)})`);
    assert.ok(a.nations.length === 3 && a.towns.length > 3, 'nations and settlements come from the shared atlas code');
    // one stroke at a time, or a frame's worth at once: the same as a rebuild
    // (raise/lower strokes and the target brushes alike)
    const strokes = [{ x: 0.3, y: 0.4, r: 0.05, d: 0.09 }, { x: 0.32, y: 0.41, r: 0.05, d: 0.09, t: 'mountain' }, { x: 0.6, y: 0.6, r: 0.04, d: -0.09 }, { x: 0.5, y: 0.5, r: 0.05, d: -0.09, t: 'sea' }];
    applyWorldStroke(a, strokes[0]);
    applyWorldStrokes(a, strokes.slice(1));
    applyWorldStrokes(b, strokes);
    const rebuilt = buildWorldModel({ ...map, strokes });
    assert.deepEqual(Array.from(a.height), Array.from(rebuilt.height), `${erosion}: painting live matches what a reload draws`);
    assert.deepEqual(Array.from(b.height), Array.from(rebuilt.height), `${erosion}: a batch of strokes matches too`);
    // the mesh is cached by seed, so a rebuild can never have written into it
    assert.equal(buildWorldModel(map).mesh, rebuilt.mesh);
  }
});

test('every erosion mode drains to the sea, rivers widen downstream, and rain erosion is repeatable', async () => {
  const { buildMeshTerrain } = await load('maps/meshterrain.js');
  for (const erosion of ['none', 'rivers', 'rain']) {
    const m = buildMeshTerrain({ seed: 'rivers', params: { water: 0.5, rivers: 8, erosion }, strokes: [] });
    const { rivers } = m.terrain;
    assert.ok(rivers.length > 3, `${erosion}: a world with rivers`);
    for (const { pts, flows } of rivers) {
      assert.equal(pts.length, flows.length);
      for (let i = 1; i < flows.length; i++) assert.ok(flows[i] >= flows[i - 1] - 1e-6, `${erosion}: flow never shrinks downstream`);
    }
    for (const path of m.rivers) for (const [x, y] of path) assert.ok(m.riverCells.has(y * m.gw + x));
    assert.ok(m.height.every((h) => h >= 0.02 && h <= 0.98));
    const again = buildMeshTerrain({ seed: 'rivers', params: { water: 0.5, rivers: 8, erosion }, strokes: [] });
    assert.deepEqual(Array.from(again.height), Array.from(m.height), `${erosion}: the same input, the same terrain`);
  }
  // erosion never moves the coast: the sea stays where the uneroded map has it
  const plain = buildMeshTerrain({ seed: 'rivers', params: { water: 0.5 }, strokes: [] });
  for (const erosion of ['rivers', 'rain']) {
    const m = buildMeshTerrain({ seed: 'rivers', params: { water: 0.5, erosion }, strokes: [] });
    let moved = 0;
    for (let i = 0; i < m.height.length; i++) if ((m.height[i] >= m.water) !== (plain.height[i] >= plain.water)) moved++;
    assert.ok(moved / m.height.length < 0.002, `${erosion}: only a sliver of coast may shift (${moved} cells)`);
  }
});

test('target brushes settle on their kind of ground instead of piling up', async () => {
  const { buildMeshTerrain, TERRAIN_BRUSHES } = await load('maps/meshterrain.js');
  const dab = (t, n) => Array.from({ length: n }, () => ({ x: 0.5, y: 0.5, r: 0.06, d: 0.09, t }));
  const at = (m) => {
    const { centroids, numTriangles } = m.mesh;
    let best = 0, bd = Infinity;
    for (let t = 0; t < numTriangles; t++) { const d = (centroids[t * 2] - 480) ** 2 + (centroids[t * 2 + 1] - 300) ** 2; if (d < bd) { bd = d; best = t; } }
    return best;
  };
  for (const { t, target } of TERRAIN_BRUSHES) {
    const m = buildMeshTerrain({ seed: 'brushes', params: { water: 0.5 }, strokes: dab(t, 12) });
    const c = m.parts.constraint[at(m)];
    assert.ok(Math.abs(c - target) < 0.01, `${t}: the brushed spot settles at ${target} (${c.toFixed(3)})`);
  }
  const sea = buildMeshTerrain({ seed: 'brushes', params: { water: 0.5 }, strokes: dab('sea', 6) });
  assert.ok(sea.terrain.elevation[at(sea)] < 0, 'the Sea brush makes sea');
  const peaks = buildMeshTerrain({ seed: 'brushes', params: { water: 0.5 }, strokes: dab('mountain', 6) });
  const plain = buildMeshTerrain({ seed: 'brushes', params: { water: 0.5 }, strokes: dab('lowland', 6) });
  assert.ok(peaks.terrain.elevation[at(peaks)] > plain.terrain.elevation[at(plain)] + 0.1, 'mountains stand well above lowland');
});

/** Grid distance (in cells, 4-neighbour) from every cell to the nearest cell where `from` holds. */
function gridDistance(n, gw, gh, from) {
  const d = new Int32Array(n).fill(-1), q = [];
  for (let i = 0; i < n; i++) if (from(i)) { d[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % gw, y = (i / gw) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy, j = yy * gw + xx;
      if (xx < 0 || yy < 0 || xx >= gw || yy >= gh || d[j] >= 0) continue;
      d[j] = d[i] + 1; q.push(j);
    }
  }
  return d;
}

test('terrain seas shelve off the coast, and every coast gets rain', async () => {
  const { buildMeshTerrain } = await load('maps/meshterrain.js');
  let coastCells = 0, dryCoast = 0;
  for (const [seed, landform] of [['shelf-a', 'continents'], ['shelf-b', 'archipelago'], ['shelf-c', 'highlands'], ['shelf-d', 'continents'], ['shelf-e', 'inlandsea']]) {
    const m = buildMeshTerrain({ seed, params: { water: 0.5, landform }, strokes: [] });
    const { height, moisture, water, gw, gh } = m, n = height.length;
    const toLand = gridDistance(n, gw, gh, (i) => height[i] >= water);
    const toSea = gridDistance(n, gw, gh, (i) => height[i] < water);
    // depth follows the distance from shore (a shelf, then the drop-off),
    // rather than wandering into shoals far out at sea
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) if (height[i] < water && toLand[i] >= 0) { xs.push(Math.min(toLand[i], 60)); ys.push(water - height[i]); }
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
    const corr = sxy / Math.sqrt(sxx * syy);
    assert.ok(corr > 0.88, `${seed}: water deepens steadily away from the coast (correlation ${corr.toFixed(3)})`);
    for (let i = 0; i < n; i++) if (height[i] >= water && toSea[i] <= 3) { coastCells++; if (moisture[i] < 0.3) dryCoast++; }
  }
  // onshore breezes: hardly any coast is desert, downwind shores included
  assert.ok(dryCoast / coastCells < 0.015, `coasts get rain (${(100 * dryCoast / coastCells).toFixed(1)}% desert)`);
});

test('high ground stays an upland of ranges unless painted rugged with the Mountains brush', async () => {
  const { buildMeshTerrain } = await load('maps/meshterrain.js');
  const natural = buildMeshTerrain({ seed: 'upland', params: { water: 0.4, landform: 'highlands' }, strokes: [] });
  assert.ok(natural.parts.rugged.every((v) => v === 0), 'nothing is rugged before anything is painted');
  const dab = (t, n) => Array.from({ length: n }, () => ({ x: 0.5, y: 0.5, r: 0.06, d: 0.09, t }));
  const painted = buildMeshTerrain({ seed: 'upland', params: { water: 0.4, landform: 'highlands' }, strokes: dab('mountain', 8) });
  const cleared = buildMeshTerrain({ seed: 'upland', params: { water: 0.4, landform: 'highlands' }, strokes: [...dab('mountain', 8), ...dab('hills', 8)] });
  const { centroids, numTriangles } = natural.mesh;
  let mid = 0, bd = Infinity;
  for (let t = 0; t < numTriangles; t++) { const d = (centroids[t * 2] - 480) ** 2 + (centroids[t * 2 + 1] - 300) ** 2; if (d < bd) { bd = d; mid = t; } }
  assert.ok(painted.parts.rugged[mid] > 0.9, 'the Mountains brush makes the land rugged');
  assert.ok(cleared.parts.rugged[mid] < 0.1, 'painting hills over it wears the peaks away again');
  // a low sea gives more land, not a field of peaks
  const low = buildMeshTerrain({ seed: 'upland', params: { water: 0.3, landform: 'highlands' }, strokes: [] });
  const mean = (m) => { let s = 0, k = 0; for (const e of m.terrain.elevation) if (e > 0) { s += e; k++; } return s / k; };
  assert.ok(mean(low) < mean(natural) * 1.25, `lowering the sea barely lifts the uplands (${mean(natural).toFixed(3)} -> ${mean(low).toFixed(3)})`);
});

test('lakes fill well-fed basins on land, and settlements and nations stay off them', async () => {
  const { buildWorldModel } = await load('maps/world.js');
  let lakesSeen = 0;
  for (const seed of ['review-1', 'review-2', 'high-7', 'c']) {
    const m = buildWorldModel({ kind: 'world', seed, params: { style: 'terrain', generation: '1.8', nations: 3 }, strokes: [] });
    assert.ok(m.lakes.length <= 10, `${seed}: lakes stay landmarks (${m.lakes.length})`);
    lakesSeen += m.lakes.length;
    for (const lake of m.lakes) for (const i of lake) {
      assert.equal(m.lakeMask[i], 1);
      assert.ok(m.height[i] >= m.water, 'a lake is inland water, never sea');
      assert.equal(m.owner[i], -1, 'no nation owns a lake');
    }
    for (const t of m.towns) assert.ok(!m.lakeMask[Math.round(t.y) * m.gw + Math.round(t.x)], `${seed}: ${t.name} is not in a lake`);
  }
  assert.ok(lakesSeen > 0, 'some of these worlds have lakes');
  const rivers = buildWorldModel({ kind: 'world', seed: 'review-1', params: { style: 'terrain', generation: '1.8', erosion: 'rivers' }, strokes: [] });
  assert.equal(rivers.lakes.length, 0, 'river-network erosion drains every basin');
});

test('the one-pass rasterizer matches a per-pixel barycentric fill', async () => {
  const { buildMesh, rasterize, rasterizeMany } = await load('maps/meshterrain.js');
  const mesh = buildMesh('raster-check');
  const values = Float32Array.from({ length: mesh.numRegions }, (_, i) => Math.sin(i * 0.37));
  const other = Float32Array.from({ length: mesh.numRegions }, (_, i) => Math.cos(i * 0.11));
  for (const [gw, gh] of [[240, 150], [960, 600]]) {
    const one = rasterize(mesh, values, gw, gh), [two, three] = rasterizeMany(mesh, [values, other], gw, gh);
    assert.deepEqual(Array.from(one), Array.from(two), 'one field or two, the same values');
    const { points, triangles } = mesh, sx = gw / mesh.w, sy = gh / mesh.h;
    for (let t = 0; t < mesh.numTriangles; t += 53) {
      const [a, b, c] = [triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]];
      const ax = points[a * 2] * sx - 0.5, ay = points[a * 2 + 1] * sy - 0.5, bx = points[b * 2] * sx - 0.5, by = points[b * 2 + 1] * sy - 0.5, cx = points[c * 2] * sx - 0.5, cy = points[c * 2 + 1] * sy - 0.5;
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      const x = Math.round((ax + bx + cx) / 3), y = Math.round((ay + by + cy) / 3);
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det, l3 = 1 - l1 - l2;
      if (l1 < 0.01 || l2 < 0.01 || l3 < 0.01 || x < 0 || y < 0 || x >= gw || y >= gh) continue;
      assert.ok(Math.abs(one[y * gw + x] - (values[a] * l1 + values[b] * l2 + values[c] * l3)) < 1e-4);
      assert.ok(Math.abs(three[y * gw + x] - (other[a] * l1 + other[b] * l2 + other[c] * l3)) < 1e-4);
    }
    assert.ok(one.every(Number.isFinite), 'no pixel is left unfilled');
  }
});

test('the terrain style never changes classic or atlas worlds', async () => {
  const { buildWorldModel } = await load('maps/world.js');
  for (const style of [undefined, 'atlas']) {
    const m = buildWorldModel({ kind: 'world', seed: 'old', params: style ? { style } : {}, strokes: [] });
    assert.equal(m.mesh, undefined, `${style || 'classic'} builds without a mesh`);
  }
});

test('metro cities are deterministic and every building stays dry and off the streets', async () => {
  const { buildTownModel } = await load('maps/town.js');
  for (const seed of ['metro-a', 'metro-b', 'metro-c']) {
    const map = { kind: 'town', seed, params: { era: 'modern', modernLayout: 'tensor', size: 4, generation: '1.8' } };
    const m = buildTownModel(map), again = buildTownModel(map);
    assert.equal(JSON.stringify(m.buildings), JSON.stringify(again.buildings), 'same seed, same city');
    assert.equal(m.layout, 'tensor');
    assert.ok(m.blocks.length > 100 && m.buildings.length > 200, `${seed}: a filled city (${m.blocks.length} blocks, ${m.buildings.length} buildings)`);
    assert.ok(m.buildings.some((b) => b.landmarkKind === 'cityhall'), 'a city hall');
    for (const b of m.buildings) {
      assert.ok(Array.isArray(b.poly) && b.poly.length >= 3 && Number.isFinite(b.x) && Number.isFinite(b.w), 'polygon plus the box keys and populate read');
    }
    // no building centre on a street: farther from every centreline than its half width
    const HALF = { arterial: 5.5, collector: 4, local: 2.8 };
    const segs = m.roads.flatMap((r) => r.pts.slice(1).map((p, i) => [r.pts[i], p, HALF[r.cls]]));
    for (const b of m.buildings) {
      for (const [a, c, half] of segs) {
        const dx = c[0] - a[0], dy = c[1] - a[1], len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((b.x - a[0]) * dx + (b.y - a[1]) * dy) / len2));
        assert.ok(Math.hypot(b.x - a[0] - dx * t, b.y - a[1] - dy * t) > half, `${seed}: building at ${b.x.toFixed(0)},${b.y.toFixed(0)} sits on a street`);
      }
    }
    if (m.water.sea) {
      const inside = (x, y, poly) => { let o = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) o = !o; } return o; };
      for (const b of m.buildings) assert.ok(!inside(b.x, b.y, m.water.sea.poly), 'no building in the sea');
    }
    assert.ok(m.streets.includes('Main Street'));
    // every named road points at its name; stretches of one shore road share one
    const used = new Set();
    for (const r of m.roads.filter((r) => r.name)) { assert.equal(m.streets[r.nameIndex], r.name); used.add(r.nameIndex); }
    assert.equal(used.size, m.streets.length, 'no unused street names');
    for (const b of m.buildings) assert.ok(Number.isInteger(b.levels) && b.levels >= 1, 'every building has storeys');
  }
});

test('metro shore roads, big parks and towers', async () => {
  const { buildTownModel } = await load('maps/town.js');
  const inside = (x, y, poly) => { let o = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) o = !o; } return o; };
  const coastal = buildTownModel({ kind: 'town', seed: 'harbor-9', params: { era: 'modern', modernLayout: 'tensor', size: 3, layout: 'coastal' } });
  const river = buildTownModel({ kind: 'town', seed: 'metro-b', params: { era: 'modern', modernLayout: 'tensor', size: 5 } });
  assert.ok(coastal.water.sea && river.water.river, 'one city on the sea, one on a river');
  const shoreRoads = (m, names) => m.roads.filter((r) => names.includes(r.name));
  const drive = shoreRoads(coastal, ['Harbor Drive', 'Ocean Avenue', 'Bay Shore Drive', 'Seaside Boulevard', 'Marine Parade', 'Beach Road']);
  assert.ok(drive.length, 'a drive runs along the sea front');
  for (const r of drive) for (const [x, y] of r.pts) assert.ok(!inside(x, y, coastal.water.sea.poly), 'the sea drive stays on land');
  const banks = new Set(shoreRoads(river, ['Riverside Drive', 'River Road', 'Water Street', 'Embankment Road', 'Canal Street', 'Mill Road']).map((r) => r.name));
  assert.equal(banks.size, 2, 'a differently named road down each bank');
  for (const m of [coastal, river]) {
    const big = m.parks.filter((p) => p.kind === 'big');
    assert.ok(big.length >= 1 && big.length <= 2, `one or two big parks (${big.length})`);
    for (const park of big) {
      // local streets would have cut it into ordinary blocks
      const area = Math.abs(park.poly.reduce((s, p, i) => { const q = park.poly[(i + 1) % park.poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
      assert.ok(area > 3500, `the park stays one large block (${Math.round(area)})`);
      for (const b of m.buildings) assert.ok(!inside(b.x, b.y, park.poly), 'no building in the park');
      if (park.pond) for (const [x, y] of park.pond) assert.ok(inside(x, y, park.poly), 'the pond is inside its park');
    }
  }
  // towers downtown, houses at the edge
  const avg = (use) => { const bs = river.buildings.filter((b) => b.use === use && !b.landmark); return bs.reduce((s, b) => s + b.levels, 0) / bs.length; };
  assert.ok(avg('downtown') > avg('residential') && avg('residential') > avg('suburban'), 'buildings get lower away from downtown');
});

const inPoly = (x, y, poly) => {
  let o = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) o = !o;
  }
  return o;
};
// distance from a point to a polyline
const toLine = (x, y, pts) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
};
const crosses = (A, B) => {
  for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) {
    const [ax, ay] = A[i - 1], [bx, by] = A[i], [cx, cy] = B[j - 1], [dx, dy] = B[j];
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  return false;
};

test('metro railways run edge to edge past downtown and cross rivers square-on', async () => {
  const { buildTownModel } = await load('maps/town.js');
  let rivers = 0;
  for (let i = 1; i <= 12; i++) {
    // every other city on a river, so crossings get tested
    const m = buildTownModel({ kind: 'town', seed: `rail-${i}`, params: { era: 'modern', modernLayout: 'tensor', size: 3 + (i % 3), ...(i % 2 ? { layout: 'riverside' } : {}) } });
    assert.ok(m.rail && m.station, `rail-${i}: a city has its railway and a station`);
    const pts = m.rail.pts, near = (p) => p[0] < 15 || p[1] < 15 || p[0] > 885 || p[1] > 625;
    assert.ok(near(pts[0]) && near(pts[pts.length - 1]), `rail-${i}: the line runs off the map at both ends`);
    assert.ok(Math.hypot(m.station.x - m.center.x, m.station.y - m.center.y) < m.R, `rail-${i}: the station is near downtown`);
    if (m.water.river) {
      rivers++;
      const { pts: course, width } = m.water.river;
      // consecutive rail points in the channel: a square crossing is about its width
      let wet = 0, longest = 0;
      for (const [x, y] of pts) { wet = toLine(x, y, course) < width / 2 ? wet + 1 : 0; longest = Math.max(longest, wet); }
      assert.ok(longest * 6 <= width * 1.5 + 12, `rail-${i}: crosses the river square-on (${longest * 6} px wet, river ${Math.round(width)})`);
    }
    if (m.water.sea) for (const [x, y] of pts) if (x >= 0 && y >= 0 && x <= 900 && y <= 640) assert.ok(!inPoly(x, y, m.water.sea.poly), 'the railway stays out of the sea');
    for (const r of m.roads.filter((q) => q.cls === 'local')) assert.ok(!crosses(r.pts, pts), `rail-${i}: local streets end at the tracks`);
  }
  assert.ok(rivers > 0, 'some of these cities have a river to cross');
});

test('metro streets have no scraps: none ends in the river, rides on another, or stands alone', async () => {
  const { buildTownModel } = await load('maps/town.js');
  for (let i = 0; i < 8; i++) {
    const m = buildTownModel({ kind: 'town', seed: `scraps-${i}`, params: { era: 'modern', modernLayout: 'tensor', size: 2 + (i % 4) } });
    for (const r of m.roads) {
      if (m.water.river) for (const end of [r.pts[0], r.pts[r.pts.length - 1]]) {
        assert.ok(toLine(end[0], end[1], m.water.river.pts) > m.water.river.width / 2 + 2, `scraps-${i}: a ${r.cls} ends in the river`);
      }
      const others = m.roads.filter((o) => o !== r);
      assert.ok(others.some((o) => crosses(o.pts, r.pts) || [r.pts[0], r.pts[r.pts.length - 1]].some(([x, y]) => toLine(x, y, o.pts) < 2.5)),
        `scraps-${i}: a ${r.cls} meets no other street`);
      for (const o of others) {
        const riding = r.pts.filter(([x, y]) => toLine(x, y, o.pts) < 3).length;
        assert.ok(riding <= 3, `scraps-${i}: a ${r.cls} runs along on top of a ${o.cls} (${riding} points)`);
      }
    }
  }
});

test('metro names follow GM overrides without moving anything', async () => {
  const { buildTownModel } = await load('maps/town.js');
  const map = { kind: 'town', seed: 'names', params: { era: 'modern', modernLayout: 'tensor', size: 3 } };
  const plain = buildTownModel(map);
  const renamed = buildTownModel({ ...map, placeNames: { 0: 'Town Hall of Testing' }, streetNames: { 0: 'Trial Way' } });
  assert.equal(renamed.buildings.filter((b) => b.landmark)[0].label, 'Town Hall of Testing');
  assert.equal(renamed.roads.find((r) => r.nameIndex === 0).label, 'Trial Way');
  assert.deepEqual(renamed.buildings.map((b) => [b.x, b.y]), plain.buildings.map((b) => [b.x, b.y]));
});

test('"Surprise me" never picks the metro layout, so existing modern towns keep theirs', async () => {
  const { buildTownModel } = await load('maps/town.js');
  for (let i = 0; i < 12; i++) {
    const m = buildTownModel({ kind: 'town', seed: `auto-${i}`, params: { era: 'modern', size: 2 } });
    assert.notEqual(m.layout, 'tensor');
  }
});

test('planar faces of a street grid are its blocks', async () => {
  const { planarFaces } = await load('maps/tensorcity.js');
  const lines = [];
  for (const x of [100, 200, 300]) lines.push({ pts: [[x, -10], [x, 410]], cls: 'local' });
  for (const y of [100, 200, 300]) lines.push({ pts: [[-10, y], [410, y]], cls: 'local' });
  // a dangling spur is pruned rather than splitting a block
  lines.push({ pts: [[150, 100], [150, 160]], cls: 'local' });
  lines.push({ pts: [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]], cls: 'edge' });
  const faces = planarFaces(lines);
  assert.equal(faces.length, 16);
  for (const f of faces) assert.equal(Math.round(Math.abs(f.area)), 10000);
});
