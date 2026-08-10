// Full-screen map editor: seeded generation + hand editing.
// The per-kind parts (param rows, paint tools, brush vs grid painting, the
// reset-edits button) all come from the kind's declarative entry in MAP_KINDS
// — this file renders them generically and never branches on map.kind.
//   all kinds: draggable markers/stamps/labels/paths with GM-secret flags

import { el, toast, debounce, downloadBlob, clamp } from '../util.js';
import {
  state, getEntity, visibleEntities, scheduleSave, saveEntity, newEntity, types,
} from '../state.js';
import {
  MAP_KINDS, newMap, newMarker, newLabel, MARKER_SHAPES, MARKER_COLORS,
  newStamp, STAMP_KINDS, STAMP_COLORS, FURNITURE_STAMPS, newPath, PATH_STYLES,
  drawOverlay, renderMap,
} from '../maps/mapcore.js';
import {
  settlementSites, settlementLinkId, linkSettlement,
  townSizeForSettlement, townSeedForSettlement,
} from '../maps/crossscale.js';
import { supportsUniversalVtt, universalVttText } from '../maps/uvtt.js';
import { api } from '../api.js';

export function render(container, id) {
  const e = getEntity(id);
  if (!e?.map) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, 'This entry has no map.')));
    return;
  }
  if (!state.gm && e.gmOnly) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, '🔒 GM-only content is hidden in player preview.')));
    return;
  }
  const map = e.map;
  const kind = MAP_KINDS[map.kind];
  const readOnly = !state.gm;

  const save = () => scheduleSave(e); // batched + visible in the topbar Save indicator

  // ---------- editor state ----------
  let tool = 'move';
  let brush = { r: 0.045, strength: 0.09 };
  let markerOpts = { shape: 'dot', color: MARKER_COLORS[0], secret: false };
  // building maps offer furniture; everything else offers structures
  const stampChoices = kind.stampKinds || Object.keys(STAMP_KINDS).filter((k) => !FURNITURE_STAMPS.includes(k));
  let stampOpts = { kind: stampChoices[0], color: '', size: 1, secret: false }; // '' = kind default
  let drawOpts = { style: 'road', color: '', width: 0, secret: false }; // 0/'' = style default
  let labelSize = 24;
  let selected = null;
  let drawingPath = null; // path being drawn right now
  let lastDragPos = null;
  let model = null;
  let base = null;
  let W = 0, H = 0;
  let level = 0; // current floor of a multi-level kind; 0 for everything else

  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');

  const currentSettlements = () => settlementSites(map, model, [W, H]);
  const linkedTown = (site) => {
    const target = getEntity(settlementLinkId(map, site));
    if (!target || target.map?.kind !== 'town') return null;
    return state.gm || !target.gmOnly ? target : null;
  };
  const hitSettlement = (p) => {
    let best = null, distance = Infinity;
    for (const site of currentSettlements()) {
      const d = Math.hypot(site.x - p.x, site.y - p.y);
      if (d < 17 && d < distance) { best = site; distance = d; }
    }
    return best;
  };

  let openingSettlement = false;
  async function openSettlement(site) {
    if (openingSettlement) return;
    const linked = linkedTown(site);
    if (linked) { location.hash = `#/map/${linked.id}`; return; }
    if (readOnly) return;
    openingSettlement = true;
    try {
      // Reuse an existing same-name town map before offering to create another.
      const existing = [...state.entities.values()].find((candidate) =>
        candidate.name.trim().toLowerCase() === site.name.trim().toLowerCase()
        && candidate.map?.kind === 'town');
      if (existing) {
        linkSettlement(map, site, existing.id);
        await saveEntity(e);
        location.hash = `#/map/${existing.id}`;
        return;
      }
      if (!confirm(`Create a location entry and town map for ${site.name}?`)) return;
      const worldTypes = types();
      const locationType = worldTypes.location ? 'location'
        : (Object.entries(worldTypes).find(([, spec]) =>
          String(spec?.label || '').trim().toLowerCase() === 'location')?.[0] || 'note');
      let town = newEntity(site.name, locationType);
      town.fields.Kind = site.capital ? 'Capital settlement' : 'Settlement';
      town.map = newMap('town');
      town.map.seed = townSeedForSettlement(map, site);
      town.map.params.size = townSizeForSettlement(site);
      town = await saveEntity(town);
      linkSettlement(map, site, town.id);
      await saveEntity(e);
      toast(`Created ${town.name}'s town map`);
      location.hash = `#/map/${town.id}`;
    } catch (err) {
      console.error(err);
      toast('Could not create the town map');
    } finally {
      openingSettlement = false;
    }
  }

  function drawSettlementLinkHints() {
    ctx.save();
    for (const site of currentSettlements()) {
      if (!linkedTown(site)) continue;
      ctx.beginPath();
      ctx.arc(site.x, site.y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = '#7fd7ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(site.x + 9, site.y - 9, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#7fd7ff';
      ctx.fill();
    }
    ctx.restore();
  }

  function rebuild() {
    const count = kind.levelCount ? kind.levelCount(map) : 1;
    if (level >= count) level = count - 1;
    model = kind.buildModel(map, level);
    base = kind.renderBase(map, model);
    [W, H] = kind.size(map);
    canvas.width = W;
    canvas.height = H;
    refreshLevelChips?.();
    refreshExtraPanel?.();
    redraw();
  }

  // a kind may declare its own panel section (town uses it for ward names);
  // it re-renders whenever the model does
  const extraWrap = el('div', {});
  var refreshExtraPanel = () => {
    if (!kind.extraPanel) return;
    extraWrap.innerHTML = '';
    const section = kind.extraPanel({
      map,
      model,
      readOnly,
      save,
      refreshBase: () => {
        base = kind.renderBase(map, model);
        redraw();
      },
    });
    if (section) extraWrap.append(section);
  };

  let rafPending = false;
  function redraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      ctx.drawImage(base, 0, 0);
      drawOverlay(ctx, map, W, H, { gm: state.gm, selected, level });
      drawSettlementLinkHints();
    });
  }

  // floor chips for multi-level kinds (dungeons); hidden at 1 level
  const levelChips = el('div', { class: 'tool-row', style: 'margin-bottom:6px' });
  var refreshLevelChips = () => {
    const count = kind.levelCount ? kind.levelCount(map) : 1;
    levelChips.style.display = count > 1 ? '' : 'none';
    levelChips.innerHTML = '';
    for (let i = 0; i < count; i++) {
      levelChips.append(el('button', {
        class: i === level ? 'on' : '', title: `Show level ${i + 1}`,
        onclick: () => { level = i; selected = null; rebuild(); refreshLists(); },
      }, `L${i + 1}`));
    }
  };
  rebuild();

  // ---------- pointer interaction ----------
  const pos = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (W / rect.width),
      y: (ev.clientY - rect.top) * (H / rect.height),
    };
  };

  function distToPath(p, path) {
    let best = Infinity;
    const pts = path.pts || [];
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0] * W, ay = pts[i - 1][1] * H;
      const bx = pts[i][0] * W, by = pts[i][1] * H;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
      const d = Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
      if (d < best) best = d;
    }
    return best;
  }

  const onLevel = (o) => (o.level || 0) === level;

  function hitOverlay(p) {
    for (let i = (map.markers || []).length - 1; i >= 0; i--) {
      const mk = map.markers[i];
      if ((mk.secret && !state.gm) || !onLevel(mk)) continue;
      if (Math.hypot(mk.x * W - p.x, mk.y * H - p.y) < 14) return { obj: mk, list: 'markers' };
    }
    for (let i = (map.stamps || []).length - 1; i >= 0; i--) {
      const s = map.stamps[i];
      if ((s.secret && !state.gm) || !onLevel(s)) continue;
      if (Math.hypot(s.x * W - p.x, s.y * H - p.y) < 16 * (s.size || 1)) return { obj: s, list: 'stamps' };
    }
    for (let i = (map.labels || []).length - 1; i >= 0; i--) {
      const lb = map.labels[i];
      if (!onLevel(lb)) continue;
      ctx.font = `italic ${lb.size}px Georgia, serif`;
      const hw = ctx.measureText(lb.text).width / 2 + 8;
      if (Math.abs(lb.x * W - p.x) < hw && Math.abs(lb.y * H - p.y) < lb.size * 0.75) return { obj: lb, list: 'labels' };
    }
    for (let i = (map.paths || []).length - 1; i >= 0; i--) {
      const path = map.paths[i];
      if ((path.secret && !state.gm) || !onLevel(path)) continue;
      if (distToPath(p, path) < 8) return { obj: path, list: 'paths' };
    }
    return null;
  }

  let dragging = null, painting = false, lastPaint = null;

  // 'brush' kinds append normalized strokes and re-apply them to the model
  function paintBrush(p) {
    const stroke = {
      x: p.x / W, y: p.y / H, r: brush.r,
      d: (tool === 'lower' ? -1 : 1) * brush.strength,
    };
    if (lastPaint && Math.hypot(lastPaint.x - stroke.x, lastPaint.y - stroke.y) < brush.r * 0.35) return;
    lastPaint = stroke;
    (map.strokes ??= []).push(stroke);
    kind.applyStroke(model, stroke);
    base = kind.renderBase(map, model);
    redraw();
    save();
  }

  // 'grid' kinds paint cells; the kind serializes its own map.grid
  function paintGrid(p) {
    const cx = Math.floor(p.x / kind.cellSize), cy = Math.floor(p.y / kind.cellSize);
    if (!kind.paintCell(map, model, cx, cy, tool)) return;
    base = kind.renderBase(map, model);
    redraw();
    save();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (readOnly) return;
    const p = pos(ev);
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* stale/synthetic pointer */ }
    if (tool === 'move') {
      const hitRes = hitOverlay(p);
      selected = hitRes ? hitRes.obj.id : null;
      dragging = hitRes ? hitRes.obj : null;
      lastDragPos = p;
      redraw();
      refreshLists();
    } else if (tool === 'stamp') {
      const s = newStamp(p.x / W, p.y / H, {
        kind: stampOpts.kind, size: stampOpts.size, secret: stampOpts.secret,
        color: stampOpts.color || undefined,
      });
      if (level) s.level = level;
      (map.stamps ??= []).push(s);
      selected = s.id;
      save(); redraw(); refreshLists();
    } else if (tool === 'draw') {
      drawingPath = newPath(drawOpts.style, {
        secret: drawOpts.secret,
        color: drawOpts.color || undefined,
        width: drawOpts.width || undefined,
      });
      if (level) drawingPath.level = level;
      drawingPath.pts.push([clamp(p.x / W, 0, 1), clamp(p.y / H, 0, 1)]);
      (map.paths ??= []).push(drawingPath);
    } else if (tool === 'marker') {
      const mk = newMarker(p.x / W, p.y / H, markerOpts);
      if (level) mk.level = level;
      (map.markers ??= []).push(mk);
      selected = mk.id;
      save(); redraw(); refreshLists();
    } else if (tool === 'label') {
      const text = prompt('Label text:');
      if (text?.trim()) {
        const lb = newLabel(p.x / W, p.y / H, text.trim(), labelSize);
        if (level) lb.level = level;
        (map.labels ??= []).push(lb);
        selected = lb.id;
        save(); redraw(); refreshLists();
      }
    } else if ((kind.tools || []).some((t) => t.name === tool)) {
      painting = true; lastPaint = null;
      if (kind.paint === 'brush') paintBrush(p);
      else if (kind.paint === 'grid') paintGrid(p);
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (readOnly) return;
    const p = pos(ev);
    if (dragging) {
      if (dragging.pts) {
        // paths move as a whole — translate every point by the drag delta
        const dx = (p.x - lastDragPos.x) / W, dy = (p.y - lastDragPos.y) / H;
        for (const pt of dragging.pts) { pt[0] += dx; pt[1] += dy; }
        lastDragPos = p;
      } else {
        dragging.x = clamp(p.x / W, 0, 1);
        dragging.y = clamp(p.y / H, 0, 1);
      }
      redraw(); save();
    } else if (drawingPath) {
      const last = drawingPath.pts[drawingPath.pts.length - 1];
      if (Math.hypot(p.x - last[0] * W, p.y - last[1] * H) > 7) {
        drawingPath.pts.push([clamp(p.x / W, 0, 1), clamp(p.y / H, 0, 1)]);
        redraw();
      }
    } else if (painting) {
      if (kind.paint === 'brush') paintBrush(p);
      else if (kind.paint === 'grid') paintGrid(p);
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (drawingPath) {
      const pts = drawingPath.pts;
      if (pts.length < 3) {
        map.paths = map.paths.filter((x) => x !== drawingPath); // stray click
      } else {
        // strokes that end near their start close into a loop; borders tint it
        const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
        if (pts.length > 6 && Math.hypot((ex - sx) * W, (ey - sy) * H) < 18) {
          drawingPath.closed = true;
          if (drawingPath.style === 'border') drawingPath.fill = true;
        }
        selected = drawingPath.id;
        save();
      }
      drawingPath = null;
      redraw(); refreshLists();
    }
    dragging = null; painting = false; lastPaint = null;
  });

  // double-click a linked marker/stamp to open its entry (works in player view too)
  canvas.addEventListener('dblclick', (ev) => {
    const hitRes = hitOverlay(pos(ev));
    const obj = (hitRes?.list === 'markers' || hitRes?.list === 'stamps') ? hitRes.obj : null;
    if (obj?.to && getEntity(obj.to)) location.hash = `#/e/${obj.to}`;
  });
  // Generated atlas/region settlements are real navigation targets too. A
  // linked site opens on one click; the first GM click explicitly offers to
  // create and persist a normal Location with its own town map.
  canvas.addEventListener('click', (ev) => {
    if (tool !== 'move') return;
    const p = pos(ev);
    if (hitOverlay(p)) return;
    const site = hitSettlement(p);
    if (site) void openSettlement(site);
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (painting || dragging) return;
    if (!readOnly && tool !== 'move') return; // brush/marker tools keep their crosshair
    const p = pos(ev);
    const hitRes = hitOverlay(p);
    const site = !hitRes ? hitSettlement(p) : null;
    const siteClickable = site && (state.gm || linkedTown(site));
    canvas.style.cursor = hitRes?.obj?.to || siteClickable ? 'pointer' : 'default';
  });

  const onKey = (ev) => {
    if (ev.key === 'Delete' && selected && !readOnly) {
      map.markers = (map.markers || []).filter((m) => m.id !== selected);
      map.labels = (map.labels || []).filter((l) => l.id !== selected);
      map.stamps = (map.stamps || []).filter((s) => s.id !== selected);
      map.paths = (map.paths || []).filter((pa) => pa.id !== selected);
      selected = null;
      save(); redraw(); refreshLists();
    }
  };
  window.addEventListener('keydown', onKey);

  // ---------- panel ----------
  const panel = el('div', { class: 'mapedit-panel' });

  function toolBtn(name, label, title) {
    return el('button', {
      class: tool === name ? 'on' : '', title: title || '',
      onclick: (ev) => {
        tool = name;
        panel.querySelectorAll('.tool-row button').forEach((b) => b.classList.remove('on'));
        ev.target.classList.add('on');
        canvas.style.cursor = name === 'move' ? 'default' : 'crosshair';
        markerOptsRow.style.display = name === 'marker' ? '' : 'none';
        labelOptsRow.style.display = name === 'label' ? '' : 'none';
        brushOptsRow.style.display = (kind.paint === 'brush' && (kind.tools || []).some((t) => t.name === name)) ? '' : 'none';
        stampOptsRow.style.display = name === 'stamp' ? '' : 'none';
        drawOptsRow.style.display = name === 'draw' ? '' : 'none';
      },
    }, label);
  }

  function paramRow(label, input) {
    return el('div', { class: 'param-row' }, el('label', {}, label), input);
  }
  function slider(value, min, max, step, oninput) {
    // min/max/step must be set before value, or the browser snaps value to the default step
    return el('input', { type: 'range', min, max, step, value, oninput: (ev) => oninput(Number(ev.target.value)) });
  }

  const p = map.params;

  function confirmDiscardGrid() {
    if (kind.gridKind && (map.grid || (map.grids || []).some(Boolean))) {
      if (!confirm('This regenerates the layout and discards your painted edits. Continue?')) return false;
      map.grid = null;
      map.grids = null;
    }
    return true;
  }

  const seedInput = el('input', { type: 'text', value: map.seed, style: 'width:110px', oninput: (ev) => { map.seed = ev.target.value; } });

  // generic param rows from the kind's declarative schema (see mapcore.js)
  const paramSection = el('div', {});
  const paramRowEls = [];
  const syncParamRows = () => {
    for (const { spec, row } of paramRowEls) {
      row.style.display = !spec.show || spec.show(p) ? '' : 'none';
    }
  };
  for (const spec of kind.params || []) {
    const cur = () => p[spec.key] ?? spec.absent;
    const changed = () => { syncParamRows(); rebuild(); save(); };
    let input;
    if (spec.type === 'slider') {
      input = slider(cur(), spec.min, spec.max, spec.step, (v) => {
        if (spec.confirmGrid && !confirmDiscardGrid()) return;
        p[spec.key] = v; changed();
      });
    } else if (spec.type === 'checkbox') {
      input = el('input', {
        type: 'checkbox', checked: !!cur(),
        onchange: (ev) => {
          if (spec.confirmGrid && !confirmDiscardGrid()) { ev.target.checked = !!cur(); return; }
          p[spec.key] = ev.target.checked; changed();
        },
      });
    } else if (spec.type === 'number') {
      input = el('input', {
        type: 'number', min: spec.min, max: spec.max, value: cur(), style: 'width:70px',
        onchange: (ev) => {
          if (spec.confirmGrid && !confirmDiscardGrid()) { ev.target.value = cur(); return; }
          p[spec.key] = clamp(Number(ev.target.value), spec.min, spec.max);
          ev.target.value = p[spec.key];
          changed();
        },
      });
    } else { // select
      const options = typeof spec.options === 'function' ? spec.options() : spec.options;
      input = el('select', {
        onchange: (ev) => {
          if (spec.confirmGrid && !confirmDiscardGrid()) { ev.target.value = String(cur()); return; }
          p[spec.key] = spec.numeric ? Number(ev.target.value) : ev.target.value;
          changed();
        },
      }, Object.entries(options).map(([v, l]) =>
        el('option', { value: v, selected: String(v) === String(cur()) }, l)));
    }
    if (spec.title) input.title = spec.title;
    const row = paramRow(spec.label, input);
    paramRowEls.push({ spec, row });
    paramSection.append(row);
  }
  syncParamRows();

  // tools per kind, from the registry
  const toolRow = el('div', { class: 'tool-row' }, toolBtn('move', '✋ Move', 'Select and drag markers/labels'));
  for (const t of kind.tools || []) toolRow.append(toolBtn(t.name, t.label, t.title));
  toolRow.append(
    toolBtn('stamp', '🏰 Place', 'Place a building or landmark: houses, castles, cities, forests…'),
    toolBtn('draw', '✏️ Draw', 'Draw roads, rivers, borders, travel routes and walls'),
    toolBtn('marker', '📍 Marker'),
    toolBtn('label', '🔤 Label'));
  toolRow.querySelector('button').classList.add('on');

  const brushOptsRow = el('div', { style: 'display:none' },
    paramRow('Brush size', slider(brush.r, 0.015, 0.12, 0.005, (v) => { brush.r = v; })),
    paramRow('Strength', slider(brush.strength, 0.03, 0.2, 0.01, (v) => { brush.strength = v; })));

  const markerOptsRow = el('div', { style: 'display:none' },
    paramRow('Shape', el('select', { onchange: (ev) => { markerOpts.shape = ev.target.value; } },
      MARKER_SHAPES.map((s) => el('option', { value: s }, s)))),
    paramRow('Color', el('div', { class: 'row', style: 'gap:4px' },
      MARKER_COLORS.map((c) => el('button', {
        class: 'legend-swatch', style: `background:${c};width:20px;height:20px;padding:0;border:2px solid transparent`,
        onclick: (ev) => {
          markerOpts.color = c;
          markerOptsRow.querySelectorAll('.legend-swatch').forEach((b) => b.style.borderColor = 'transparent');
          ev.target.style.borderColor = '#fff';
        },
      })))),
    paramRow('🔒 Secret', el('input', {
      type: 'checkbox', title: 'Secret markers are only visible in GM view and GM exports (traps, hidden doors, ambushes…)',
      onchange: (ev) => { markerOpts.secret = ev.target.checked; },
    })));

  const labelOptsRow = el('div', { style: 'display:none' },
    paramRow('Size', el('select', { onchange: (ev) => { labelSize = Number(ev.target.value); } },
      [[16, 'Small'], [24, 'Medium'], [34, 'Large'], [48, 'Huge (region)']].map(([v, l]) => el('option', { value: v, selected: v === 24 }, l)))));

  function swatchRow(colors, get, set) {
    const wrap = el('div', { class: 'row', style: 'gap:4px' },
      el('button', {
        class: 'ghost small', title: 'Use the default color', style: 'padding:0 6px',
        onclick: (ev) => {
          set('');
          wrap.querySelectorAll('.legend-swatch').forEach((b) => b.style.borderColor = 'transparent');
        },
      }, '↺'),
      colors.map((c) => el('button', {
        class: 'legend-swatch', style: `background:${c};width:20px;height:20px;padding:0;border:2px solid ${get() === c ? '#fff' : 'transparent'}`,
        onclick: (ev) => {
          set(c);
          wrap.querySelectorAll('.legend-swatch').forEach((b) => b.style.borderColor = 'transparent');
          ev.target.style.borderColor = '#fff';
        },
      })));
    return wrap;
  }

  const stampOptsRow = el('div', { style: 'display:none' },
    paramRow('Stamp', el('select', { onchange: (ev) => { stampOpts.kind = ev.target.value; } },
      stampChoices.map((v) => el('option', { value: v, selected: v === stampOpts.kind }, STAMP_KINDS[v])))),
    paramRow('Size', slider(stampOpts.size, 0.6, 2.4, 0.1, (v) => { stampOpts.size = v; })),
    paramRow('Color', swatchRow(STAMP_COLORS, () => stampOpts.color, (c) => { stampOpts.color = c; })),
    paramRow('🔒 Secret', el('input', {
      type: 'checkbox', title: 'Secret stamps are only visible in GM view and GM exports (the hidden fortress…)',
      onchange: (ev) => { stampOpts.secret = ev.target.checked; },
    })));

  const drawOptsRow = el('div', { style: 'display:none' },
    paramRow('Style', el('select', {
      title: 'End a border stroke near its start to close it into a tinted territory',
      onchange: (ev) => { drawOpts.style = ev.target.value; },
    }, Object.entries(PATH_STYLES).map(([v, s]) => el('option', { value: v, selected: v === drawOpts.style }, s.label)))),
    paramRow('Color', swatchRow([...new Set([...Object.values(PATH_STYLES).map((s) => s.color), '#e0a72c', '#4a9e6f'])],
      () => drawOpts.color, (c) => { drawOpts.color = c; })),
    paramRow('Width', slider(6, 2, 14, 1, (v) => { drawOpts.width = v; })),
    paramRow('🔒 Secret', el('input', {
      type: 'checkbox', title: 'Secret drawings never appear to players — the true border, the smugglers’ route…',
      onchange: (ev) => { drawOpts.secret = ev.target.checked; },
    })));

  // marker & label lists
  const listsWrap = el('div', {});
  function refreshLists() {
    listsWrap.innerHTML = '';
    // Player preview must hide secret overlay items here too, not just on the
    // canvas. drawOverlay and hitOverlay already filter on `secret`; these lists
    // did not, so the panel printed secret marker labels directly underneath its
    // own "secret markers hidden" notice. Same convention as hitOverlay.
    const shown = (list) => (list || []).filter((o) => (state.gm || !o.secret) && onLevel(o));
    const linkables = visibleEntities()
      .filter((x) => x.id !== e.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    const linkSelect = (obj) => el('select', {
      title: 'Link to an entry — double-click it on the map to open. Linked items appear in that entry’s backlinks and in the PDF map key.',
      onchange: (ev) => {
        obj.to = ev.target.value || null;
        const target = obj.to ? getEntity(obj.to) : null;
        if (target && !(obj.label || '').trim()) obj.label = target.name;
        save(); redraw(); refreshLists();
      },
    },
      el('option', { value: '' }, '— link —'),
      linkables.map((x) => el('option', { value: x.id, selected: x.id === obj.to }, x.name)));
    const secretBtn = (obj) => el('button', {
      class: 'ghost', title: obj.secret ? 'Secret (GM only) — click to reveal to players' : 'Visible to players — click to make secret',
      style: obj.secret ? 'color:var(--accent)' : 'opacity:.45',
      onclick: () => { obj.secret = !obj.secret; save(); redraw(); refreshLists(); },
    }, '🔒');
    const deleteBtn = (list, obj) => el('button', {
      class: 'ghost', onclick: () => {
        map[list] = map[list].filter((o) => o.id !== obj.id);
        if (selected === obj.id) selected = null;
        save(); redraw(); refreshLists();
      },
    }, '✕');

    const generatedSites = currentSettlements();
    const shownSites = state.gm ? generatedSites : generatedSites.filter((site) => linkedTown(site));
    if (shownSites.length) {
      listsWrap.append(el('h3', {}, 'Settlement maps'));
      const sitesList = el('div', { class: 'marker-list' });
      for (const site of shownSites) {
        const target = linkedTown(site);
        sitesList.append(el('div', { class: 'mk-row' },
          el('span', { style: 'flex:1;font-size:12.5px' }, site.name),
          el('button', {
            class: 'ghost small',
            title: target ? `Open ${target.name}'s town map` : `Create a Location and town map for ${site.name}`,
            onclick: () => { void openSettlement(site); },
          }, target ? 'Open town' : 'Create town')));
      }
      listsWrap.append(sitesList);
    }

    if (shown(map.markers).length) {
      listsWrap.append(el('h3', {}, 'Markers'));
      const ml = el('div', { class: 'marker-list' });
      for (const mk of shown(map.markers)) {
        ml.append(el('div', { class: 'mk-row', style: selected === mk.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('span', { class: 'legend-swatch', style: `background:${mk.color}` }),
          el('input', {
            type: 'text', value: mk.label, placeholder: '(no label)',
            oninput: (ev) => { mk.label = ev.target.value; save(); redraw(); },
            onfocus: () => { selected = mk.id; redraw(); },
          }),
          linkSelect(mk), secretBtn(mk), deleteBtn('markers', mk)));
      }
      listsWrap.append(ml);
    }
    if (shown(map.stamps).length) {
      listsWrap.append(el('h3', {}, 'Placed things'));
      const sl = el('div', { class: 'marker-list' });
      for (const s of shown(map.stamps)) {
        sl.append(el('div', { class: 'mk-row', style: selected === s.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('span', { class: 'legend-swatch', style: `background:${s.color}` }),
          el('input', {
            type: 'text', value: s.label || '', placeholder: `(${STAMP_KINDS[s.kind] || s.kind})`,
            oninput: (ev) => { s.label = ev.target.value; save(); redraw(); },
            onfocus: () => { selected = s.id; redraw(); },
          }),
          linkSelect(s), secretBtn(s), deleteBtn('stamps', s)));
      }
      listsWrap.append(sl);
    }
    if ((map.labels || []).filter(onLevel).length) {
      listsWrap.append(el('h3', {}, 'Labels'));
      const ll = el('div', { class: 'marker-list' });
      for (const lb of (map.labels || []).filter(onLevel)) {
        ll.append(el('div', { class: 'mk-row', style: selected === lb.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('input', {
            type: 'text', value: lb.text,
            oninput: (ev) => { lb.text = ev.target.value; save(); redraw(); },
            onfocus: () => { selected = lb.id; redraw(); },
          }),
          el('select', {
            onchange: (ev) => { lb.size = Number(ev.target.value); save(); redraw(); },
          }, [[16, 'S'], [24, 'M'], [34, 'L'], [48, 'XL']].map(([v, l]) => el('option', { value: v, selected: Number(v) === lb.size }, l))),
          deleteBtn('labels', lb)));
      }
      listsWrap.append(ll);
    }
    if (shown(map.paths).length) {
      listsWrap.append(el('h3', {}, 'Drawings'));
      const pl = el('div', { class: 'marker-list' });
      for (const pa of shown(map.paths)) {
        pl.append(el('div', { class: 'mk-row', style: selected === pa.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('span', {
            class: 'legend-swatch', style: `background:${pa.color};cursor:pointer`,
            title: 'Select this drawing',
            onclick: () => { selected = pa.id; redraw(); refreshLists(); },
          }),
          el('span', { style: 'flex:1;font-size:12.5px' },
            (PATH_STYLES[pa.style]?.label || pa.style) + (pa.closed ? ' (closed)' : '')),
          pa.closed && pa.style === 'border' ? el('label', {
            class: 'rel-secret', title: 'Tint the enclosed territory with the border color',
          },
            el('input', {
              type: 'checkbox', checked: !!pa.fill,
              onchange: (ev) => { pa.fill = ev.target.checked; save(); redraw(); },
            }), 'fill') : null,
          secretBtn(pa), deleteBtn('paths', pa)));
      }
      listsWrap.append(pl);
    }
  }
  refreshLists();

  let exportScale = 2; // print-friendly default; 1× matches the screen

  async function exportPng(gm) {
    const out = el('canvas');
    renderMap(out, map, { gm, scale: exportScale });
    const suffix = (gm ? 'gm' : 'player') + (exportScale > 1 ? `@${exportScale}x` : '');
    const name = `${e.name.replace(/\W+/g, '-').toLowerCase()}-map-${suffix}.png`;
    out.toBlob(async (blob) => {
      downloadBlob(blob, name);
      const b64 = await blobToBase64(blob);
      try {
        const res = await api.exportFile(name, b64);
        toast(`Saved to ${res.path}`);
      } catch {
        toast('Downloaded PNG (server copy failed)');
      }
    }, 'image/png');
  }

  async function exportUvtt(gm) {
    const out = el('canvas');
    renderMap(out, map, { gm, scale: exportScale, level });
    const imageBase64 = out.toDataURL('image/png').split(',')[1];
    const text = universalVttText(map, imageBase64, {
      gm, level, scale: exportScale, model,
    });
    const floor = (kind.levelCount ? kind.levelCount(map) : 1) > 1 ? `-L${level + 1}` : '';
    const edition = gm ? 'gm' : 'player';
    const name = `${e.name.replace(/\W+/g, '-').toLowerCase()}-map${floor}-${edition}.uvtt`;
    const blob = new Blob([text], { type: 'application/json' });
    downloadBlob(blob, name);
    try {
      const res = await api.exportFile(name, await blobToBase64(blob));
      toast(`Saved UVTT to ${res.path}`);
    } catch {
      toast('Downloaded UVTT (server copy failed)');
    }
  }

  const vttExportSection = supportsUniversalVtt(map) ? el('div', {},
    el('h3', {}, 'Export to VTT'),
    el('div', { class: 'muted small', style: 'margin-bottom:6px' },
      `Universal VTT for the ${kind.levelCount ? 'current floor' : 'map'}: embedded PNG, grid-aligned walls, doors, and visible drawn wall paths.`),
    el('div', { class: 'tool-row' },
      el('button', { onclick: () => exportUvtt(false) }, 'UVTT · player-safe'),
      state.gm ? el('button', { onclick: () => exportUvtt(true) }, 'UVTT · GM') : el('span'))) : el('span');

  panel.append(
    el('div', { class: 'row', style: 'margin-bottom:6px' },
      el('a', { href: `#/e/${e.id}` }, `← ${e.name}`),
      el('span', { class: 'spacer' }),
      el('span', { class: 'type-badge' }, kind.label)),
    readOnly ? el('div', { class: 'notice', style: 'margin-bottom:10px' }, '👁 Player preview — read-only, secret markers hidden.') : el('span'),
    el('h3', {}, 'Generator'),
    el('div', { class: 'param-row' },
      el('label', {}, 'Seed'), seedInput,
      el('button', {
        title: 'Random seed', onclick: () => {
          if (!confirmDiscardGrid()) return;
          map.seed = Math.random().toString(36).slice(2, 10);
          seedInput.value = map.seed;
          rebuild(); save();
        },
      }, '🎲'),
      el('button', {
        title: 'Regenerate from the seed in the box', onclick: () => {
          if (!confirmDiscardGrid()) return;
          map.seed = seedInput.value;
          rebuild(); save();
        },
      }, '↻')),
    paramSection,
    kind.clearEdits?.has(map) ? el('button', {
      class: 'ghost small', onclick: () => {
        if (!confirm(kind.clearEdits.confirm)) return;
        kind.clearEdits.run(map);
        rebuild(); save();
      },
    }, kind.clearEdits.label) : el('span'),
    readOnly ? el('span') : paramRow('Compass', el('input', {
      type: 'checkbox', checked: !!map.compass, title: 'Draw a compass rose in the corner',
      onchange: (ev) => { map.compass = ev.target.checked; save(); redraw(); },
    })),
    levelChips,
    el('h3', {}, 'Tools'),
    readOnly ? el('div', { class: 'muted small' }, 'Editing disabled in player preview.') : toolRow,
    brushOptsRow, markerOptsRow, labelOptsRow, stampOptsRow, drawOptsRow,
    listsWrap,
    extraWrap,
    el('h3', {}, 'Export image'),
    paramRow('Resolution', el('select', {
      title: 'Higher resolutions re-render the map sharper — pick 2× or more if you plan to print it',
      onchange: (ev) => { exportScale = Number(ev.target.value); },
    }, [[1, 'screen'], [2, 'print'], [3, 'large print'], [4, 'poster']].map(([k, use]) =>
      el('option', { value: k, selected: k === exportScale },
        `${k}× — ${W * k} × ${H * k} px (${use})`)))),
    el('div', { class: 'tool-row' },
      el('button', { onclick: () => exportPng(false) }, 'PNG · player-safe'),
      state.gm ? el('button', { onclick: () => exportPng(true) }, 'PNG · GM') : el('span')),
    vttExportSection,
    el('div', { class: 'muted small', style: 'margin-top:10px' },
      'Everything autosaves. Anything marked 🔒 never appears to players. 🏰 Place drops buildings and landmarks, ✏️ Draw sketches roads, rivers, borders (end a border where it started to enclose a territory), routes and walls. Link a placed thing or marker to an entry and double-click it to jump there; linked items become the numbered key in the PDF. Select something and press Delete to remove it.'));

  container.append(el('div', { class: 'mapedit-layout' },
    el('div', { class: 'mapedit-canvas-wrap' }, canvas),
    panel));

  return () => window.removeEventListener('keydown', onKey);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
