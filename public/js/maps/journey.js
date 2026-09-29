// Journey planner (1.9), pure part: a route between a region's settlements
// over its roads and ferries, its distance from the map's scale, and travel
// days from a pace table. The route is a deterministic shortest path with
// ties broken by site key; no RNG is used and nothing here writes the map.

/** Generic defaults, per day, in kilometers. Editable in the planner. */
export const DEFAULT_PACES = [
  { key: 'foot', label: 'On foot', km: 30 },
  { key: 'mounted', label: 'Mounted', km: 50 },
  { key: 'cart', label: 'Cart or wagon', km: 25 },
  { key: 'ship', label: 'Ship or ferry', km: 120 },
  { key: 'car', label: 'Car', km: 500, modern: true },
  { key: 'train', label: 'Train', km: 800, modern: true },
];

export const UNIT_KM = { km: 1, mi: 1.609344, m: 0.001, ft: 0.0003048 };

const polyLength = (pts) => {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
};

/**
 * Nodes are sites ({ key, name, x, y } in native pixels); roads are polylines
 * and ferries two-point segments, as region models store them. A road joins
 * the sites nearest its two ends when both lie within `snap` pixels.
 */
export function travelGraph(sites, roads = [], ferries = [], snap = 24) {
  const nearest = ([x, y]) => {
    let best = null, dist = snap;
    for (const s of sites) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < dist || (d === dist && best && s.key < best.key)) { dist = d; best = s; }
    }
    return best;
  };
  const edges = [];
  const add = (pts, mode) => {
    if (!pts || pts.length < 2) return;
    const a = nearest(pts[0]), b = nearest(pts[pts.length - 1]);
    if (a && b && a.key !== b.key) edges.push({ a: a.key, b: b.key, mode, px: polyLength(pts), pts });
  };
  for (const road of roads) add(road, 'road');
  for (const ferry of ferries) add(ferry, 'ferry');
  return { sites, edges };
}

/** Shortest route by distance; equal distances resolve by site key. */
export function planJourney(graph, fromKey, toKey) {
  const byKey = new Map(graph.sites.map((s) => [s.key, s]));
  if (!byKey.has(fromKey) || !byKey.has(toKey) || fromKey === toKey) return null;
  const dist = new Map([[fromKey, 0]]), via = new Map(), done = new Set();
  for (;;) {
    let current = null;
    for (const [key, d] of dist) {
      if (done.has(key)) continue;
      if (current === null || d < dist.get(current) || (d === dist.get(current) && key < current)) current = key;
    }
    if (current === null) return null;
    if (current === toKey) break;
    done.add(current);
    const edges = graph.edges.filter((e) => e.a === current || e.b === current)
      .sort((x, y) => (x.a === current ? x.b : x.a).localeCompare(y.a === current ? y.b : y.a) || x.px - y.px);
    for (const edge of edges) {
      const next = edge.a === current ? edge.b : edge.a;
      if (done.has(next)) continue;
      const d = dist.get(current) + edge.px;
      if (!dist.has(next) || d < dist.get(next) - 1e-9) { dist.set(next, d); via.set(next, { from: current, edge }); }
    }
  }
  const legs = [];
  for (let key = toKey; key !== fromKey; key = via.get(key).from) {
    const { from, edge } = via.get(key);
    const pts = edge.a === from ? edge.pts : [...edge.pts].reverse();
    legs.unshift({ from: byKey.get(from), to: byKey.get(key), mode: edge.mode, px: edge.px, pts });
  }
  return { legs, px: dist.get(toKey) };
}

/**
 * Distance and days for a planned route. `scale` is the map's
 * { distance, units, width }: `distance` units across `width` pixels.
 * Land legs use `pace`, ferry legs `shipPace` (km per day).
 * Returns null when the map has no distance scale.
 */
export function journeyTime(route, { distance, units = 'km', width }, pace, shipPace) {
  if (!(Number(distance) > 0) || !(width > 0) || !route) return null;
  const perPx = Number(distance) / width; // map units per pixel
  const legs = route.legs.map((leg) => {
    const length = leg.px * perPx;
    const km = length * (UNIT_KM[units] || 1);
    return { ...leg, length, days: km / (leg.mode === 'ferry' ? shipPace : pace) };
  });
  const length = legs.reduce((n, l) => n + l.length, 0);
  const exact = legs.reduce((n, l) => n + l.days, 0);
  return { legs, length, units, days: Math.max(1, Math.ceil(exact - 1e-9)), exactDays: exact };
}
