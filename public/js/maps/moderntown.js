// Modern towns (1.9): a separate town era for modern settings. town.js takes
// this path only when map.params.era === 'modern' (read directly, never from
// defaults), so no historical or 1.8 town can change. Every draw comes from
// streams under a ':modern' prefix; nothing reads a legacy or 1.8 stream.
//
// The model has street classes (arterial, collector, local, cul-de-sac),
// blocks filled by frontage lots with district setbacks, parking, parks, a
// rail line and station, bridges and a waterfront. Districts: downtown,
// residential, suburban, industrial, civic, parkland and waterfront. Street and
// place names come from original tables; GM overrides (map.streetNames,
// map.placeNames) apply after generation, and map keys still anchor to the
// generated names.

import { makeRng, makeFbm, clamp } from '../util.js';

const W = 900, H = 640, C = 2, GW = W / C, GH = H / C;

// 'tensor' (Metro, 1.9.1) is built by tensorcity.js; town.js routes it there, and 'auto' never picks it
export const MODERN_LAYOUTS = { auto: 'Surprise me', grid: 'Downtown grid', sprawl: 'Suburban sprawl', waterfront: 'Waterfront city', river: 'River town', tensor: 'Metro (tensor-field streets)' };
export const MODERN_THEMES = { day: 'Day', night: 'Night' };
export const MODERN_USES = { downtown: 'Downtown', residential: 'Homes and apartments', suburban: 'Suburbs', industrial: 'Industry', civic: 'Civic', parkland: 'Parks', waterfront: 'Waterfront' };

// ---------- original name tables (shared with tensorcity.js) ----------
export const TREES = ['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Aspen', 'Chestnut', 'Hawthorn', 'Juniper', 'Laurel', 'Magnolia', 'Poplar', 'Spruce', 'Sycamore', 'Walnut', 'Hickory', 'Linden', 'Alder', 'Cypress', 'Dogwood'];
export const SURNAMES = ['Lincoln', 'Franklin', 'Madison', 'Harrison', 'Monroe', 'Carter', 'Hayes', 'Parker', 'Morgan', 'Holloway', 'Whitman', 'Prescott', 'Calloway', 'Fairbanks', 'Ellery', 'Barlow', 'Kendrick', 'Ashby', 'Delmont', 'Wexford', 'Hartley', 'Sutton'];
export const GIVEN = ['Anne', 'Mary', 'Rosie', 'Mae', 'Lou', 'Frank', 'Dot', 'Hank', 'Joan', 'Earl', 'Iris', 'Walt'];
export const PLACE_WORDS = ['Lake', 'River', 'Hill', 'Grove', 'Meadow', 'Ridge', 'Brook', 'Harbor', 'Valley', 'Prairie', 'Summit', 'Bay'];
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th', '16th'];
export const LOCAL_SUFFIX = ['Drive', 'Lane', 'Court', 'Way', 'Place', 'Circle', 'Terrace', 'Road'];
const FUEL = [['Star', 'Rapid', 'Blue', 'Circle', 'Prairie', 'Summit', 'Liberty', 'Beacon'], ['Fuel', 'Gas', 'Service', 'Petrol']];
const MOTEL = ['Starlite', 'Blue Moon', 'Sleepy Pines', 'Roadside', 'Silver Spur', 'Sunset', 'Wagon Wheel', 'Evergreen'];

export const landmarkNames = {
  cityhall: () => 'City Hall',
  police: (r) => r.chance(0.5) ? 'Police Department' : `${r.pick(PLACE_WORDS)} Street Precinct`,
  library: (r) => `${r.pick(SURNAMES)} Public Library`,
  hospital: (r) => r.chance(0.5) ? `${r.pick(SURNAMES)} Memorial Hospital` : `${r.pick(PLACE_WORDS)} General Hospital`,
  school: (r) => r.chance(0.5) ? `${r.pick(SURNAMES)} High School` : `${r.pick(TREES)} Elementary School`,
  church: (r) => r.chance(0.5) ? `St. ${r.pick(GIVEN)}'s Church` : `${r.pick(TREES)} Community Church`,
  diner: (r) => r.chance(0.6) ? `${r.pick(GIVEN)}'s Diner` : `The ${r.pick(PLACE_WORDS)} Diner`,
  gas: (r) => `${r.pick(FUEL[0])} ${r.pick(FUEL[1])}`,
  motel: (r) => `${r.pick(MOTEL)} Motel`,
  station: (r) => r.chance(0.5) ? 'Union Station' : `${r.pick(TREES)} Street Station`,
  marina: (r) => `${r.pick(PLACE_WORDS)} Marina`,
  warehouse: (r) => `${r.pick(SURNAMES)} Freight Warehouse`,
};

// ---------- geometry ----------
const lerp = (a, b, t) => a + (b - a) * t;
function segDist(px, py, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    best = Math.min(best, Math.hypot(px - ax - dx * t, py - ay - dy * t));
  }
  return best;
}
/** Split a sampled polyline into the runs where keep(x, y) holds. */
function runs(pts, keep, min = 3) {
  const out = []; let cur = [];
  for (const p of pts) {
    if (keep(p[0], p[1])) cur.push(p);
    else { if (cur.length >= min) out.push(cur); cur = []; }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

export function buildModernTown(map) {
  const p = { size: 2, density: 1, ...(map.params || {}) };
  const size = clamp(Math.round(Number(p.size) || 2), 1, 5);
  const density = clamp(Number(p.density) || 1, 0.4, 1.6);
  const pick = makeRng(`${map.seed}:modern`);
  // drilled towns keep their parent's geography: a coastal site gets a
  // waterfront, a riverside one a river, unless the GM picked a layout
  const hinted = p.layout === 'coastal' ? 'waterfront' : p.layout === 'riverside' ? 'river' : null;
  const autoLayout = pick.pick(['grid', 'sprawl', 'waterfront', 'river']);
  const layout = MODERN_LAYOUTS[p.modernLayout] && p.modernLayout !== 'auto' ? p.modernLayout : hinted || autoLayout;
  const rng = makeRng(`${map.seed}:modern:streets`);
  const noise = makeFbm(`${map.seed}:modern:water`, 4);

  const R = [0, 115, 165, 215, 270, 320][size] * (layout === 'grid' ? 1.12 : layout === 'sprawl' ? 0.72 : 1);
  const Rdown = R * 0.42;
  const block = layout === 'grid' ? 52 : 56;
  const angle = layout === 'grid' ? rng.range(-0.08, 0.08) : rng.range(-0.28, 0.28);
  const cos = Math.cos(angle), sin = Math.sin(angle);

  // ---------- water ----------
  let water = null;
  const center = { x: W / 2 + rng.range(-70, 70), y: H * 0.46 + rng.range(-40, 40) };
  if (layout === 'waterfront') {
    const phase = rng.range(0, 6);
    const shoreAt = (x) => H * 0.8 + Math.sin(x / 170 + phase) * 16 + (noise(x / 150, 3) - 0.5) * 40;
    const shore = []; for (let x = -20; x <= W + 20; x += 6) shore.push([x, shoreAt(x)]);
    water = { kind: 'sea', shore, shoreAt };
    center.y = clamp(shoreAt(center.x) - Math.max(120, R * 0.65), H * 0.3, H * 0.6);
  } else if (layout === 'river') {
    const phase = rng.range(0, 6), slope = rng.range(-0.18, 0.18), width = rng.range(28, 40);
    const riverAt = (x) => H * 0.52 + Math.sin(x / 190 + phase) * 38 + (x - W / 2) * slope + (noise(x / 160, 5) - 0.5) * 30;
    const pts = []; for (let x = -20; x <= W + 20; x += 6) pts.push([x, riverAt(x)]);
    water = { kind: 'river', pts, width, riverAt };
    center.y = riverAt(center.x) - rng.range(60, 110);
  }
  const wet = (x, y, pad = 0) => water?.kind === 'sea' ? y > water.shoreAt(x) - pad
    : water?.kind === 'river' ? Math.abs(y - water.riverAt(x)) < water.width / 2 + pad : false;
  const onMap = (x, y, m = 6) => x > m && y > m && x < W - m && y < H - m;
  const toXY = (u, v) => [center.x + u * cos - v * sin, center.y + u * sin + v * cos];
  const toUV = (x, y) => { const dx = x - center.x, dy = y - center.y; return [dx * cos + dy * sin, -dx * sin + dy * cos]; };
  const ellipse = (x, y) => { const [u, v] = toUV(x, y); return Math.hypot(u / (R * 1.1), v / (R * 0.82)); };

  // ---------- streets ----------
  const roads = [];
  const bridges = [];
  const line = (u0, v0, u1, v1, step = 6) => {
    const n = Math.max(2, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / step)), pts = [];
    for (let i = 0; i <= n; i++) pts.push(toXY(lerp(u0, u1, i / n), lerp(v0, v1, i / n)));
    return pts;
  };
  // arterials cross water on bridges; everything else stops at the bank
  const addRoad = (pts, cls, { bridge = false, inGrid = false, family = null, k = 0 } = {}) => {
    const keep = (x, y) => onMap(x, y, 2) && (bridge ? !(water?.kind === 'sea' && wet(x, y, 8)) : !wet(x, y, 8)) && (!inGrid || ellipse(x, y) <= 1);
    for (const r of runs(pts, keep)) {
      roads.push({ pts: r, cls, ...(family ? { family, k } : {}) });
      if (bridge && water?.kind === 'river') {
        for (let i = 1; i < r.length; i++) {
          const a = r[i - 1], b = r[i];
          if (wet(a[0], a[1]) !== wet(b[0], b[1]) && !wet(a[0], a[1])) {
            // walk to the far bank for the bridge's extent
            let k = i; while (k < r.length - 1 && wet(r[k][0], r[k][1], 2)) k++;
            bridges.push({ a: r[i - 1], b: r[k], cls });
          }
        }
      }
    }
  };
  addRoad(line(-1400, 0, 1400, 0), 'arterial', { bridge: true });
  addRoad(line(0, -1400, 0, 1400), 'arterial', { bridge: true });
  const n = Math.ceil(R * 1.15 / block) + 1;
  for (let k = -n; k <= n; k++) {
    if (!k) continue;
    const cls = k % 3 === 0 ? 'collector' : 'local';
    addRoad(line(k * block, -R * 0.9, k * block, R * 0.9), cls, { inGrid: true, bridge: cls === 'collector', family: 'u', k });
    addRoad(line(-R * 1.2, k * block, R * 1.2, k * block), cls, { inGrid: true, bridge: cls === 'collector', family: 'v', k });
  }
  // a boulevard skirting the older town
  {
    const off = -(R * 0.82 + 60), wob = rng.range(0, 6), pts = [];
    for (let u = -1400; u <= 1400; u += 6) pts.push(toXY(u, off + Math.sin(u / 160 + wob) * 18));
    addRoad(pts, 'arterial', { bridge: true });
  }
  if (water?.kind === 'sea') {
    const pts = []; for (let x = 0; x <= W; x += 6) pts.push([x, water.shoreAt(x) - 22]);
    addRoad(pts, 'collector');
  }
  // suburbs: broken rings of curving collectors with cul-de-sacs off them
  const culdesacs = [];
  const ringPhase = rng.range(0, 6);
  for (let ring = 0; ring < Math.min(3, size); ring++) {
    const r = R * (1.28 + ring * 0.42) + 20;
    const gaps = Array.from({ length: 4 }, () => [rng.range(0, Math.PI * 2), rng.range(0.15, 0.45)]);
    const pts = [];
    for (let t = 0; t < Math.PI * 2 + 0.01; t += 0.012) {
      if (gaps.some(([g, len]) => ((t - g + Math.PI * 4) % (Math.PI * 2)) < len)) { pts.push([NaN, NaN]); continue; }
      const rr = r * (1 + Math.sin(t * 3 + ringPhase + ring) * 0.07);
      pts.push(toXY(Math.cos(t) * rr * 1.1, Math.sin(t) * rr * 0.82));
    }
    const before = roads.length;
    addRoad(pts, ring ? 'local' : 'collector');
    // lanes off each ring segment
    for (const road of roads.slice(before)) {
      for (let i = 6; i < road.pts.length - 6; i += 11) {
        const [x0, y0] = road.pts[i], [x1, y1] = road.pts[i + 1];
        const ang = Math.atan2(y1 - y0, x1 - x0), side = rng.chance(0.5) ? 1 : -1, len = rng.range(34, 62), bend = rng.range(-0.35, 0.35);
        const lane = [[x0, y0]];
        for (let d = 6; d <= len; d += 6) {
          const a = ang + side * Math.PI / 2 + bend * d / len;
          const [px, py] = lane[lane.length - 1];
          lane.push([px + Math.cos(a) * 6, py + Math.sin(a) * 6]);
        }
        const end = lane[lane.length - 1];
        if (lane.every(([x, y]) => onMap(x, y, 14) && !wet(x, y, 12) && ellipse(x, y) > 1.05)) {
          roads.push({ pts: lane, cls: 'culdesac' });
          culdesacs.push({ x: end[0], y: end[1] });
        }
      }
    }
  }
  // two diagonal connectors from the grid to the edge of town
  for (const a of [Math.PI / 4 + rng.range(-0.2, 0.2), Math.PI * 1.25 + rng.range(-0.2, 0.2)]) {
    const pts = [];
    for (let r = R * 0.95; r < 1300; r += 6) pts.push(toXY(Math.cos(a) * r * 1.1, Math.sin(a) * r * 0.82));
    addRoad(pts, 'collector', { bridge: true });
  }

  // ---------- rail ----------
  let rail = null, station = null;
  if (size >= 2) {
    const side = rng.chance(0.5) ? 1 : -1, ra = angle + rng.range(0.35, 0.6) * side, off = (R * 0.5 + 30) * side;
    const nx = -Math.sin(ra), ny = Math.cos(ra), ox = center.x + nx * off, oy = center.y + ny * off, pts = [];
    for (let t = -1400; t <= 1400; t += 6) pts.push([ox + Math.cos(ra) * t, oy + Math.sin(ra) * t]);
    const rails = runs(pts, (x, y) => onMap(x, y, 0) && !(water?.kind === 'sea' && wet(x, y, 10)), 10);
    if (rails.length) {
      rail = { pts: rails.sort((a, b) => b.length - a.length)[0] };
      let best = null, bd = Infinity;
      for (const [x, y] of rail.pts) { const d = Math.hypot(x - center.x, y - center.y); if (!wet(x, y, 14) && d < bd) { bd = d; best = [x, y]; } }
      if (best) station = { x: best[0], y: best[1], rot: ra };
      if (water?.kind === 'river') {
        for (let i = 1; i < rail.pts.length; i++) {
          const a = rail.pts[i - 1], b = rail.pts[i];
          if (!wet(a[0], a[1]) && wet(b[0], b[1])) { let k = i; while (k < rail.pts.length - 1 && wet(rail.pts[k][0], rail.pts[k][1], 2)) k++; bridges.push({ a, b: rail.pts[k], cls: 'rail' }); }
        }
      }
    }
  }

  // ---------- occupancy ----------
  const HALF = { arterial: 6.5, collector: 5, local: 3.6, culdesac: 3.4 };
  const CLEAR = 3.5; // lots start past the road's reserved cells (radius HALF + 1, 2 px cells)
  const occupied = new Uint8Array(GW * GH);
  // a true disc: a square would reach past CLEAR on diagonal and curved streets
  const markDisc = (x, y, r) => {
    for (let yy = Math.max(0, Math.floor((y - r) / C)); yy <= Math.min(GH - 1, Math.floor((y + r) / C)); yy++)
      for (let xx = Math.max(0, Math.floor((x - r) / C)); xx <= Math.min(GW - 1, Math.floor((x + r) / C)); xx++) {
        if (Math.hypot(xx * C + C / 2 - x, yy * C + C / 2 - y) <= r + 0.75) occupied[yy * GW + xx] = 1;
      }
  };
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (!onMap(x * C, y * C, 8) || wet(x * C, y * C, 6)) occupied[y * GW + x] = 1;
  const markLine = (pts, r) => {
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1], b = pts[j], steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
      for (let k = 0; k <= steps; k++) markDisc(lerp(a[0], b[0], k / steps), lerp(a[1], b[1], k / steps), r);
    }
  };
  for (const r of roads) markLine(r.pts, HALF[r.cls] + 1);
  for (const c of culdesacs) markDisc(c.x, c.y, 9);
  if (rail) markLine(rail.pts, 6);
  const cellsFor = (x, y, w, h, rot) => {
    const out = new Set(), c = Math.cos(rot), s = Math.sin(rot);
    const sx = Math.ceil(w / (C / 2)), sy = Math.ceil(h / (C / 2));
    for (let iy = 0; iy <= sy; iy++) for (let ix = 0; ix <= sx; ix++) {
      const u = -w / 2 + w * ix / sx, v = -h / 2 + h * iy / sy, xx = x + u * c - v * s, yy = y + u * s + v * c;
      if (!onMap(xx, yy, 4)) return null;
      const i = Math.floor(yy / C) * GW + Math.floor(xx / C);
      if (occupied[i]) return null;
      out.add(i);
    }
    return [...out];
  };
  const take = (cells) => { for (const c of cells) occupied[c] = 1; };

  // ---------- districts ----------
  const distToRail = (x, y) => (rail ? segDist(x, y, rail.pts) : Infinity);
  const distToWater = (x, y) => (water?.kind === 'sea' ? Math.abs(y - water.shoreAt(x)) : water?.kind === 'river' ? Math.abs(y - water.riverAt(x)) - water.width / 2 : Infinity);
  const districtAt = (x, y) => {
    const e = ellipse(x, y);
    if (distToWater(x, y) < 50) return 'waterfront';
    if (distToRail(x, y) < 85 && e > 0.55) return 'industrial';
    if (e < 0.42) return 'downtown';
    if (e < 1) return 'residential';
    return 'suburban';
  };

  // ---------- parks ----------
  const parks = [];
  const parkRng = makeRng(`${map.seed}:modern:parks`);
  {
    // a green square one block off the center
    const [px, py] = toXY((parkRng.chance(0.5) ? 1.5 : -1.5) * block, (parkRng.chance(0.5) ? 0.5 : -0.5) * block);
    const cells = cellsFor(px, py, block - 12, block - 12, angle);
    if (cells) { take(cells); parks.push({ x: px, y: py, w: block - 12, h: block - 12, rot: angle, kind: 'square' }); }
  }
  for (let i = 0, made = 0; i < 60 && made < 1 + Math.floor(size / 2); i++) {
    const a = parkRng.range(0, Math.PI * 2), r = R * parkRng.range(1.1, 1.9);
    const [x, y] = toXY(Math.cos(a) * r * 1.1, Math.sin(a) * r * 0.82), w = parkRng.range(46, 80), h = parkRng.range(34, 56), rot = parkRng.range(-0.4, 0.4);
    const cells = cellsFor(x, y, w, h, rot);
    if (cells) { take(cells); parks.push({ x, y, w, h, rot, kind: 'park' }); made++; }
  }

  // ---------- landmarks ----------
  const civic = makeRng(`${map.seed}:modern:civic`);
  const placeNames = makeRng(`${map.seed}:modern:names:places`);
  const buildings = [], lots = [], parking = [], fields = [];
  const frontage = (predicate, w, h, setback) => {
    const found = [];
    for (const road of roads) {
      if (!predicate.roads.includes(road.cls)) continue;
      for (let j = 2; j < road.pts.length; j += 2) {
        const [ax, ay] = road.pts[j - 1], [bx, by] = road.pts[j], rot = Math.atan2(by - ay, bx - ax);
        for (const side of [-1, 1]) {
          const off = HALF[road.cls] + CLEAR + setback + h / 2, x = bx - Math.sin(rot) * off * side, y = by + Math.cos(rot) * off * side;
          if (predicate.where(x, y)) found.push({ x, y, rot, score: predicate.score(x, y) });
        }
      }
    }
    return found.sort((a, b) => a.score - b.score);
  };
  const LANDMARKS = [
    ['cityhall', 1, 'civic', 34, 26, { roads: ['arterial', 'collector', 'local'], where: (x, y) => ellipse(x, y) < 0.5, score: (x, y) => Math.hypot(x - center.x, y - center.y) }],
    ['police', 2, 'civic', 26, 20, { roads: ['arterial', 'collector'], where: (x, y) => ellipse(x, y) < 0.7, score: (x, y) => Math.abs(ellipse(x, y) - 0.3) }],
    ['library', 2, 'civic', 24, 20, { roads: ['collector', 'local'], where: (x, y) => ellipse(x, y) < 0.8, score: (x, y) => Math.abs(ellipse(x, y) - 0.45) }],
    ['station', 2, 'civic', 36, 16, null],
    ['hospital', 3, 'residential', 44, 32, { roads: ['arterial', 'collector'], where: (x, y) => districtAt(x, y) === 'residential', score: (x, y) => Math.abs(ellipse(x, y) - 0.8) }],
    ['school', 1, 'residential', 38, 22, { roads: ['collector', 'local', 'arterial'], where: (x, y) => ['residential', 'suburban'].includes(districtAt(x, y)), score: (x, y) => Math.abs(ellipse(x, y) - 1.15) }],
    ['church', 1, 'residential', 18, 28, { roads: ['local', 'collector'], where: (x, y) => districtAt(x, y) === 'residential', score: (x, y) => Math.abs(ellipse(x, y) - 0.65) + civic.range(0, 0.1) }],
    ['diner', 1, 'downtown', 16, 12, { roads: ['arterial'], where: (x, y) => ellipse(x, y) > 0.45, score: (x, y) => Math.abs(ellipse(x, y) - 0.9) }],
    ['gas', 1, 'suburban', 18, 14, { roads: ['arterial'], where: (x, y) => ellipse(x, y) > 0.6, score: (x, y) => Math.abs(ellipse(x, y) - 1.35) }],
    ['motel', 1, 'suburban', 40, 12, { roads: ['arterial'], where: (x, y) => ellipse(x, y) > 1, score: (x, y) => Math.abs(ellipse(x, y) - 1.9) }],
    ['marina', 1, 'waterfront', 20, 12, { roads: ['collector', 'arterial', 'local'], where: (x, y) => distToWater(x, y) < 60, score: (x, y) => distToWater(x, y) + Math.hypot(x - center.x, y - center.y) * 0.05 }],
    ['warehouse', 2, 'industrial', 50, 30, { roads: ['collector', 'local', 'arterial'], where: (x, y) => districtAt(x, y) === 'industrial', score: (x, y) => distToRail(x, y) + civic.range(0, 4) }],
  ];
  for (const [kind, minSize, use, w, h, predicate] of LANDMARKS) {
    const name = landmarkNames[kind](placeNames); // drawn for every kind, so names never shift
    if (size < minSize) continue;
    let spot = null;
    if (kind === 'station') {
      if (!station) continue;
      const toward = Math.sign((center.x - station.x) * -Math.sin(station.rot) + (center.y - station.y) * Math.cos(station.rot)) || 1;
      for (const off of [14, 20, 28]) {
        const x = station.x - Math.sin(station.rot) * off * toward, y = station.y + Math.cos(station.rot) * off * toward;
        const cells = cellsFor(x, y, w, h, station.rot);
        if (cells) { spot = { x, y, rot: station.rot, cells }; break; }
      }
    } else {
      if (kind === 'marina' && !water) continue;
      for (const c of frontage(predicate, w, h, 3)) {
        const cells = cellsFor(c.x, c.y, w + 2, h + 2, c.rot);
        if (cells) { spot = { ...c, cells }; break; }
      }
    }
    if (!spot) continue;
    take(spot.cells);
    buildings.push({ x: spot.x, y: spot.y, w, h, rot: spot.rot, use, landmark: name, landmarkKind: kind });
    if (kind === 'school') {
      // a playing field beside the school, on whichever side has room
      for (const s of [1, -1]) {
        const x = spot.x + Math.sin(spot.rot) * (h / 2 + 24) * s, y = spot.y - Math.cos(spot.rot) * (h / 2 + 24) * s;
        const cells = cellsFor(x, y, 58, 36, spot.rot);
        if (cells) { take(cells); fields.push({ x, y, w: 58, h: 36, rot: spot.rot }); break; }
      }
    }
    if (kind === 'gas' || kind === 'diner' || kind === 'motel' || kind === 'hospital') {
      const pw = kind === 'hospital' ? 34 : 20, ph = kind === 'hospital' ? h : 14;
      for (const s of [1, -1]) {
        const x = spot.x + Math.cos(spot.rot) * (w / 2 + pw / 2 + 3) * s, y = spot.y + Math.sin(spot.rot) * (w / 2 + pw / 2 + 3) * s;
        const cells = cellsFor(x, y, pw, ph, spot.rot);
        if (cells) { take(cells); parking.push({ x, y, w: pw, h: ph, rot: spot.rot }); break; }
      }
    }
  }

  // ---------- frontage lots ----------
  const lotRng = makeRng(`${map.seed}:modern:lots`);
  const SPEC = {
    downtown: { w: [16, 30], d: [12, 17], set: 1, side: 1, fill: 0.95 },
    residential: { w: [8, 12], d: [8, 11], set: 3, side: 2, fill: 0.85 },
    suburban: { w: [8, 11], d: [7, 9], set: 5, side: 6, yard: 5, fill: 0.7 },
    industrial: { w: [22, 40], d: [16, 26], set: 4, side: 4, fill: 0.75 },
    waterfront: { w: [14, 24], d: [10, 15], set: 3, side: 3, fill: 0.7 },
  };
  const order = ['arterial', 'collector', 'local', 'culdesac'];
  for (const cls of order) for (const road of roads) {
    if (road.cls !== cls) continue;
    const pts = road.pts;
    for (let j = 1; j < pts.length; j++) {
      const [ax, ay] = pts[j - 1], [bx, by] = pts[j], len = Math.hypot(bx - ax, by - ay);
      if (!len) continue;
      const rot = Math.atan2(by - ay, bx - ax);
      for (let d = 0; d < len; d += 3) for (const side of [-1, 1]) {
        const px = ax + (bx - ax) * d / len, py = ay + (by - ay) * d / len;
        const use = districtAt(px - Math.sin(rot) * 12 * side, py + Math.cos(rot) * 12 * side);
        const s = SPEC[use];
        if (!lotRng.chance(Math.min(1, s.fill * density))) continue;
        const width = lotRng.range(...s.w), depth = lotRng.range(...s.d), yard = s.yard || 0;
        const off = HALF[cls] + CLEAR + s.set + depth / 2;
        const x = px - Math.sin(rot) * off * side, y = py + Math.cos(rot) * off * side;
        const lotDepth = depth + s.set + yard, lx = px - Math.sin(rot) * (HALF[cls] + CLEAR + lotDepth / 2) * side, ly = py + Math.cos(rot) * (HALF[cls] + CLEAR + lotDepth / 2) * side;
        const cells = cellsFor(lx, ly, width + s.side, lotDepth, rot);
        if (!cells) continue;
        take(cells);
        lots.push({ x: lx, y: ly, w: width + s.side, h: lotDepth, rot, use });
        buildings.push({ x, y, w: width, h: depth, rot, use, landmark: null, tone: lotRng.int(0, 2) });
        if ((use === 'downtown' || use === 'industrial') && width * depth > 320 && lotRng.chance(0.3)) {
          const pw = lotRng.range(16, 26);
          for (const sgn of [1, -1]) {
            const qx = lx + Math.cos(rot) * ((width + s.side) / 2 + pw / 2 + 1.5) * sgn, qy = ly + Math.sin(rot) * ((width + s.side) / 2 + pw / 2 + 1.5) * sgn;
            const pc = cellsFor(qx, qy, pw, lotDepth, rot);
            if (pc) { take(pc); parking.push({ x: qx, y: qy, w: pw, h: lotDepth, rot }); break; }
          }
        }
      }
    }
  }

  // ---------- waterfront piers ----------
  const piers = [], boats = [];
  const marina = buildings.find((b) => b.landmarkKind === 'marina');
  if (marina && water) {
    const dockRng = makeRng(`${map.seed}:modern:docks`);
    for (let k = 0; k < 4; k++) {
      const x0 = marina.x - 36 + k * 24;
      const y0 = water.kind === 'sea' ? water.shoreAt(x0) : water.riverAt(x0) + (marina.y > water.riverAt(marina.x) ? 1 : -1) * water.width / 2;
      const dir = water.kind === 'sea' ? 1 : (marina.y > water.riverAt(marina.x) ? -1 : 1);
      const len = water.kind === 'sea' ? dockRng.range(28, 48) : water.width * 0.4;
      piers.push({ x0, y0, x1: x0, y1: y0 + dir * len });
      if (dockRng.chance(0.7)) boats.push({ x: x0 + 7, y: y0 + dir * len * 0.6, rot: Math.PI / 2 });
    }
  }

  // ---------- names ----------
  const streetNames = makeRng(`${map.seed}:modern:names:streets`);
  const streets = [];
  const trees = [...TREES], people = [...SURNAMES];
  const takeFrom = (list) => list.splice(streetNames.int(0, list.length - 1), 1)[0] || streetNames.pick(TREES);
  let localIx = 0;
  // numbered streets run one way across the grid, west to east; named ones the other
  const ks = [...new Set(roads.filter((rd) => rd.family === 'u').map((rd) => rd.k))].sort((a, b) => a - b);
  const cross = new Map([...new Set(roads.filter((rd) => rd.family === 'v').map((rd) => rd.k))].sort((a, b) => a - b).map((k) => [k, null]));
  for (const k of cross.keys()) cross.set(k, `${takeFrom(trees)} ${streetNames.pick(['Street', 'Avenue', 'Street'])}`);
  roads.forEach((road, i) => {
    let name = null;
    if (road.cls === 'arterial') name = i === 0 ? 'Main Street' : i === 1 ? `${takeFrom(people)} Avenue` : `${takeFrom(people)} Boulevard`;
    else if (road.family === 'u') name = ks.indexOf(road.k) < ORDINALS.length ? `${ORDINALS[ks.indexOf(road.k)]} Street` : null;
    else if (road.family === 'v') name = cross.get(road.k);
    else if (road.cls === 'collector') name = `${takeFrom(trees)} Avenue`;
    else if (road.cls === 'local' && road.pts.length > 12 && localIx++ % 2 === 0) name = `${takeFrom(trees)} ${streetNames.pick(LOCAL_SUFFIX)}`;
    if (name) { road.name = name; road.nameIndex = streets.length; streets.push(name); }
  });
  const districtNames = makeRng(`${map.seed}:modern:names:districts`);
  const DISTRICT_NAMES = {
    downtown: () => 'Downtown',
    residential: (r) => r.pick([`${r.pick(TREES)} Heights`, `${r.pick(SURNAMES)} Park`, 'Old Town', `${r.pick(PLACE_WORDS)}side`]),
    suburban: (r) => r.pick([`${r.pick(TREES)} Estates`, `${r.pick(PLACE_WORDS)} Meadows`, `${r.pick(TREES)}wood`, `${r.pick(SURNAMES)} Acres`]),
    industrial: (r) => r.pick([`${r.pick(PLACE_WORDS)} Industrial Park`, 'The Rail Yards', `${r.pick(SURNAMES)} Works`]),
    civic: () => 'Civic Center',
    waterfront: (r) => r.pick(['The Waterfront', 'Harborside', `${r.pick(PLACE_WORDS)} Landing`]),
    parkland: (r) => `${r.pick(SURNAMES)} Park`,
  };
  const districts = [];
  for (const use of Object.keys(MODERN_USES)) {
    const name = DISTRICT_NAMES[use](districtNames);
    const mine = use === 'parkland' ? parks : buildings.filter((b) => b.use === use);
    if (mine.length < (use === 'civic' || use === 'parkland' ? 1 : 3)) continue;
    districts.push({ use, name, cx: mine.reduce((s, b) => s + b.x, 0) / mine.length, cy: mine.reduce((s, b) => s + b.y, 0) / mine.length, count: mine.length });
  }
  parks.forEach((park, i) => { park.name = i === 0 ? `${takeFrom(people)} Square` : `${takeFrom(trees)} Park`; });

  // ---------- GM overrides, strictly after every stream ----------
  const landmarksInOrder = buildings.filter((b) => b.landmark);
  landmarksInOrder.forEach((b, i) => { b.label = String(map.placeNames?.[i] || '').trim() || b.landmark; });
  for (const road of roads) if (road.name) road.label = String(map.streetNames?.[road.nameIndex] || '').trim() || road.name;

  const model = {
    era: 'modern', generation: map.params?.generation || '1.8', layout, size, center, angle, R,
    roads, culdesacs, rail, station, water, bridges, parks, fields, lots, parking, buildings, piers, boats,
    districts, streets,
  };
  return map.params?.seaSide === 'north' && water?.kind === 'sea' ? flipNorth(model) : model;
}

/** A coastal town facing north: mirror the finished model top to bottom. */
function flipNorth(m) {
  const fy = ([x, y]) => [x, H - y];
  const flipRect = (r) => { r.y = H - r.y; r.rot = -r.rot; };
  for (const road of m.roads) road.pts = road.pts.map(fy);
  if (m.rail) m.rail.pts = m.rail.pts.map(fy);
  if (m.station) { m.station.y = H - m.station.y; m.station.rot = -m.station.rot; }
  for (const b of m.bridges) { b.a = fy(b.a); b.b = fy(b.b); }
  for (const list of [m.parks, m.fields, m.lots, m.parking, m.buildings]) list.forEach(flipRect);
  for (const c of m.culdesacs) c.y = H - c.y;
  for (const pier of m.piers) { pier.y0 = H - pier.y0; pier.y1 = H - pier.y1; }
  for (const boat of m.boats) { boat.y = H - boat.y; boat.rot = -boat.rot; }
  for (const d of m.districts) d.cy = H - d.cy;
  m.center = { x: m.center.x, y: H - m.center.y };
  const shoreAt = m.water.shoreAt;
  m.water = { ...m.water, shore: m.water.shore.map(fy), shoreAt: (x) => H - shoreAt(x), side: 'north' };
  return m;
}
