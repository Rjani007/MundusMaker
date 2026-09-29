// Modern town rendering (1.9): flat fills, road casings by street class and
// sans-serif labels. The day/night palette is a render-level theme
// (params.modernTheme) and never touches the model. Decorative draws (park
// trees, lit windows) come from ':modern:ink', a render-only stream.

import { makeRng } from '../util.js';

const W = 900, H = 640, TAU = Math.PI * 2;
const SANS = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

const PALETTES = {
  day: {
    ground: '#eeefe9', water: '#a9d0e6', waterEdge: '#86b6d2', park: '#c5e0b0', parkEdge: '#a9c994', field: '#b9da9d',
    yard: '#e5ebd9', lot: '#e7e4df', parking: '#d3d3d0', stripe: '#f6f6f2',
    casing: { arterial: '#d6a84a', collector: '#b9b6ad', local: '#c7c4bc', culdesac: '#c7c4bc' },
    fill: { arterial: '#fbe3a0', collector: '#ffffff', local: '#ffffff', culdesac: '#ffffff' },
    rail: '#7c7a78', railTie: '#aaa7a2', bridge: '#8e8a82',
    building: { downtown: '#b3b2c4', residential: '#d6c7b6', suburban: '#dfd0bd', industrial: '#bfc0ba', civic: '#d8c39a', waterfront: '#b8c6c9', parkland: '#c9b99f' },
    buildingEdge: '#8c887f', landmark: '#e2a86e', landmarkEdge: '#9c6a3a',
    text: '#2c2f36', halo: 'rgba(250,250,246,.92)', district: 'rgba(70,74,86,.55)', districtHalo: 'rgba(240,241,236,.6)',
    tree: ['#8fbf78', '#7fb46a', '#9cc884'], boat: '#f4f4f0', pier: '#a39d90', frame: '#9b9a92',
  },
  night: {
    ground: '#1b1f2a', water: '#0e2438', waterEdge: '#1d3c57', park: '#1d3025', parkEdge: '#274032', field: '#22382a',
    yard: '#20252f', lot: '#232733', parking: '#2c303b', stripe: '#474c58',
    casing: { arterial: '#0b0d12', collector: '#0b0d12', local: '#0e1016', culdesac: '#0e1016' },
    fill: { arterial: '#8a6d2c', collector: '#4a4f5c', local: '#3a3f4b', culdesac: '#3a3f4b' },
    rail: '#5c5a57', railTie: '#3e3c3a', bridge: '#555149',
    building: { downtown: '#353a4c', residential: '#383542', suburban: '#3a3744', industrial: '#353835', civic: '#463f33', waterfront: '#2f3a40', parkland: '#3a3528' },
    buildingEdge: '#12141b', landmark: '#6a4b2c', landmarkEdge: '#e0b070',
    text: '#e9e6dc', halo: 'rgba(16,18,26,.9)', district: 'rgba(210,205,190,.5)', districtHalo: 'rgba(20,22,30,.5)',
    tree: ['#2c4a34', '#335239', '#28432f'], boat: '#c9c9c4', pier: '#4d4a44', frame: '#454a58', window: 'rgba(255,214,120,.85)',
  },
};

function rect(ctx, r, pad = 0) {
  ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(r.rot || 0);
  ctx.beginPath(); ctx.rect(-r.w / 2 - pad, -r.h / 2 - pad, r.w + pad * 2, r.h + pad * 2);
  ctx.restore();
}
function polyline(ctx, pts) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}
const WIDTH = { arterial: 11, collector: 8, local: 5.6, culdesac: 5.2 };

/** Labels along a straight run of each named street; returns placed boxes. */
function streetLabels(ctx, m, pal, boxes, nameOf) {
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const road of m.roads) {
    const label = road.name ? nameOf(road) : '';
    if (!label) continue;
    const size = road.cls === 'arterial' ? 10 : 8.5;
    ctx.font = `${road.cls === 'arterial' ? '600 ' : ''}${size}px ${SANS}`;
    const width = ctx.measureText(label).width + 8;
    // the straightest window of the right length, nearest the middle
    const pts = road.pts, need = Math.ceil(width / 6) + 1;
    let best = null;
    for (let i = 0; i + need < pts.length; i += 2) {
      const a = pts[i], b = pts[i + need], chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let arc = 0; for (let k = i + 1; k <= i + need; k++) arc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (chord < arc * 0.97 || chord < width) continue;
      const mid = pts[i + (need >> 1)], score = Math.abs(i + need / 2 - pts.length / 2);
      const box = { x: mid[0] - width / 2, y: mid[1] - width / 2, w: width, h: width };
      if (mid[0] < 30 || mid[0] > W - 30 || mid[1] < 30 || mid[1] > H - 30) continue;
      if (boxes.some((o) => Math.hypot(o.cx - mid[0], o.cy - mid[1]) < (o.r + width / 2) * 0.8)) continue;
      if (!best || score < best.score) best = { a, b, mid, score, box };
    }
    if (!best) continue;
    let ang = Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0]);
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.save(); ctx.translate(best.mid[0], best.mid[1]); ctx.rotate(ang);
    ctx.lineWidth = 3; ctx.strokeStyle = pal.halo; ctx.strokeText(label, 0, 0);
    ctx.fillStyle = pal.text; ctx.fillText(label, 0, 0);
    ctx.restore();
    boxes.push({ cx: best.mid[0], cy: best.mid[1], r: width / 2 });
  }
  ctx.restore();
}

/** Point labels (places, districts), placed around the anchor without overlap. */
function pointLabels(ctx, items, pal, boxes) {
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of [...items].sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    ctx.font = `${f.bold ? '600 ' : ''}${f.caps ? '' : ''}${f.size}px ${SANS}`;
    const text = f.caps ? f.text.toUpperCase() : f.text, width = ctx.measureText(text).width + 6, height = f.size + 5;
    const spots = f.center ? [[f.x, f.y]] : [[f.x, f.y + 14], [f.x, f.y - 14], [f.x + width / 2 + 10, f.y], [f.x - width / 2 - 10, f.y]];
    for (const [x0, y0] of spots) {
      const x = Math.min(W - width / 2 - 14, Math.max(width / 2 + 14, x0)), y = Math.min(H - 20, Math.max(20, y0));
      const collide = boxes.some((o) => (o.cx !== undefined
        ? Math.hypot(o.cx - x, o.cy - y) < o.r + height / 2
        : x - width / 2 < o.x + o.w && x + width / 2 > o.x && y - height / 2 < o.y + o.h && y + height / 2 > o.y));
      if (collide) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = f.center ? pal.districtHalo : pal.halo; ctx.strokeText(text, x, y);
      ctx.fillStyle = f.center ? pal.district : pal.text; ctx.fillText(text, x, y);
      boxes.push({ x: x - width / 2, y: y - height / 2, w: width, h: height });
      break;
    }
  }
  ctx.restore();
}

export function renderModernTown(map, m, scale = 1) {
  const p = map.params || {};
  // GM renames apply at render time too, so an edit shows without a rebuild
  const landmarks = m.buildings.filter((b) => b.landmark);
  const placeName = (b) => String(map.placeNames?.[landmarks.indexOf(b)] || '').trim() || b.landmark;
  const streetName = (road) => String(map.streetNames?.[road.nameIndex] || '').trim() || road.name;
  const theme = p.modernTheme === 'night' ? 'night' : 'day';
  const pal = PALETTES[theme];
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const ink = makeRng(`${map.seed}:modern:ink`);
  ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H);

  // water
  if (m.water?.kind === 'sea') {
    const shore = m.water.shore, far = m.water.side === 'north' ? -20 : H + 20;
    ctx.beginPath(); ctx.moveTo(shore[0][0], shore[0][1]);
    for (const [x, y] of shore) ctx.lineTo(x, y);
    ctx.lineTo(W + 20, far); ctx.lineTo(-20, far); ctx.closePath();
    ctx.fillStyle = pal.water; ctx.fill();
    ctx.strokeStyle = pal.waterEdge; ctx.lineWidth = 2; polyline(ctx, shore); ctx.stroke();
  } else if (m.water?.kind === 'river') {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = pal.waterEdge; ctx.lineWidth = m.water.width + 3; polyline(ctx, m.water.pts); ctx.stroke();
    ctx.strokeStyle = pal.water; ctx.lineWidth = m.water.width; polyline(ctx, m.water.pts); ctx.stroke();
  }

  // ground uses
  for (const lot of m.lots) { if (lot.use === 'suburban' || lot.use === 'residential') { rect(ctx, lot); ctx.fillStyle = lot.use === 'suburban' ? pal.yard : pal.lot; ctx.fill(); } }
  for (const park of m.parks) { rect(ctx, park); ctx.fillStyle = pal.park; ctx.fill(); ctx.strokeStyle = pal.parkEdge; ctx.lineWidth = 1; ctx.stroke(); }
  for (const f of m.fields) {
    rect(ctx, f); ctx.fillStyle = pal.field; ctx.fill();
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot); ctx.strokeStyle = pal.stripe; ctx.lineWidth = 1;
    ctx.strokeRect(-f.w / 2 + 4, -f.h / 2 + 4, f.w - 8, f.h - 8); ctx.beginPath(); ctx.moveTo(0, -f.h / 2 + 4); ctx.lineTo(0, f.h / 2 - 4); ctx.stroke();
    ctx.restore();
  }
  for (const lot of m.parking) {
    rect(ctx, lot); ctx.fillStyle = pal.parking; ctx.fill();
    ctx.save(); ctx.translate(lot.x, lot.y); ctx.rotate(lot.rot); ctx.strokeStyle = pal.stripe; ctx.lineWidth = 0.7;
    for (let x = -lot.w / 2 + 3; x < lot.w / 2 - 1; x += 3.2) { ctx.beginPath(); ctx.moveTo(x, -lot.h / 2 + 1); ctx.lineTo(x, -lot.h / 2 + lot.h * 0.35); ctx.moveTo(x, lot.h / 2 - 1); ctx.lineTo(x, lot.h / 2 - lot.h * 0.35); ctx.stroke(); }
    ctx.restore();
  }

  // bridges sit under the road fills
  ctx.lineCap = 'butt';
  for (const b of m.bridges) {
    ctx.strokeStyle = pal.bridge; ctx.lineWidth = (WIDTH[b.cls] || 6) + 6; polyline(ctx, [b.a, b.b]); ctx.stroke();
  }

  // roads: casings, then fills, minor classes first
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const classes = ['culdesac', 'local', 'collector', 'arterial'];
  for (const cls of classes) for (const road of m.roads) if (road.cls === cls) { ctx.strokeStyle = pal.casing[cls]; ctx.lineWidth = WIDTH[cls] + 2; polyline(ctx, road.pts); ctx.stroke(); }
  for (const c of m.culdesacs) { ctx.fillStyle = pal.casing.culdesac; ctx.beginPath(); ctx.arc(c.x, c.y, 7.5, 0, TAU); ctx.fill(); }
  for (const cls of classes) for (const road of m.roads) if (road.cls === cls) { ctx.strokeStyle = pal.fill[cls]; ctx.lineWidth = WIDTH[cls]; polyline(ctx, road.pts); ctx.stroke(); }
  for (const c of m.culdesacs) { ctx.fillStyle = pal.fill.culdesac; ctx.beginPath(); ctx.arc(c.x, c.y, 6.2, 0, TAU); ctx.fill(); }

  // rail: a dark line with ties
  if (m.rail) {
    ctx.lineCap = 'butt';
    ctx.strokeStyle = pal.rail; ctx.lineWidth = 3.4; polyline(ctx, m.rail.pts); ctx.stroke();
    ctx.setLineDash([1.4, 4.2]); ctx.strokeStyle = pal.railTie; ctx.lineWidth = 7; polyline(ctx, m.rail.pts); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = pal.rail; ctx.lineWidth = 1.4; polyline(ctx, m.rail.pts); ctx.stroke();
  }

  // piers and boats
  for (const pier of m.piers) { ctx.strokeStyle = pal.pier; ctx.lineWidth = 3.5; polyline(ctx, [[pier.x0, pier.y0], [pier.x1, pier.y1]]); ctx.stroke(); }
  for (const boat of m.boats) { ctx.save(); ctx.translate(boat.x, boat.y); ctx.rotate(boat.rot); ctx.fillStyle = pal.boat; ctx.beginPath(); ctx.ellipse(0, 0, 6, 2.4, 0, 0, TAU); ctx.fill(); ctx.restore(); }

  // trees in parks
  for (const park of m.parks) {
    const count = Math.round(park.w * park.h / 140);
    for (let i = 0; i < count; i++) {
      const u = ink.range(-park.w / 2 + 4, park.w / 2 - 4), v = ink.range(-park.h / 2 + 4, park.h / 2 - 4);
      const x = park.x + u * Math.cos(park.rot) - v * Math.sin(park.rot), y = park.y + u * Math.sin(park.rot) + v * Math.cos(park.rot);
      ctx.fillStyle = pal.tree[i % 3]; ctx.beginPath(); ctx.arc(x, y, ink.range(2.2, 4), 0, TAU); ctx.fill();
    }
  }

  // buildings: flat fills; landmarks stand out
  for (const b of m.buildings) {
    rect(ctx, b);
    ctx.fillStyle = b.landmark ? pal.landmark : pal.building[b.use] || pal.building.residential; ctx.fill();
    ctx.strokeStyle = b.landmark ? pal.landmarkEdge : pal.buildingEdge; ctx.lineWidth = b.landmark ? 1.2 : 0.6; ctx.stroke();
    if (theme === 'night' && !b.landmark) {
      const lights = Math.floor(b.w * b.h / 45);
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.fillStyle = pal.window;
      for (let i = 0; i < lights; i++) if (ink.chance(b.use === 'industrial' ? 0.15 : 0.45)) ctx.fillRect(ink.range(-b.w / 2 + 1, b.w / 2 - 2), ink.range(-b.h / 2 + 1, b.h / 2 - 2), 1.3, 1.3);
      ctx.restore();
    }
  }
  if (m.station) {
    ctx.fillStyle = pal.rail; ctx.beginPath(); ctx.arc(m.station.x, m.station.y, 4, 0, TAU); ctx.fill();
    ctx.strokeStyle = pal.halo; ctx.lineWidth = 1.2; ctx.stroke();
  }

  // labels: title box reserved first, then streets, places and districts
  const boxes = [{ x: 18, y: 14, w: 250, h: 44 }];
  if (p.labels !== false) {
    streetLabels(ctx, m, pal, boxes, streetName);
    pointLabels(ctx, [
      ...landmarks.map((b) => ({ text: placeName(b), x: b.x, y: b.y, size: 9, bold: true, priority: b.landmarkKind === 'cityhall' ? 9 : 8 })),
      ...m.parks.map((park) => ({ text: park.name, x: park.x, y: park.y, size: 8.5, center: false, priority: 5 })),
      ...m.districts.filter((d) => d.use !== 'civic' && d.use !== 'parkland').map((d) => ({ text: d.name, x: d.cx, y: d.cy, size: 11, caps: true, center: true, priority: 3 })),
    ], pal, boxes);
    ctx.fillStyle = theme === 'night' ? 'rgba(22,25,34,.94)' : 'rgba(250,250,246,.95)'; ctx.fillRect(18, 14, 250, 44);
    ctx.strokeStyle = pal.frame; ctx.lineWidth = 0.8; ctx.strokeRect(18, 14, 250, 44);
    ctx.fillStyle = pal.text; ctx.font = `600 17px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(p.title || { grid: 'Downtown & Neighborhoods', sprawl: 'Town & Suburbs', waterfront: 'The Waterfront City', river: 'River Town' }[m.layout] || 'Street Map', 29, 36, 230);
  }
  ctx.strokeStyle = pal.frame; ctx.lineWidth = 1; ctx.strokeRect(6, 6, W - 12, H - 12);
  return canvas;
}
