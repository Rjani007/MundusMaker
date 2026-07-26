// Full-screen map editor: seeded generation + hand editing.
//   world:   raise/lower terrain brush (stored as strokes → survives re-render)
//   town:    regenerate with different size/density/walls/river
//   dungeon: paint floor/wall/door cells (stored grid overrides the seed)
//   all:     draggable markers (with GM-secret flag) and text labels

import { el, toast, debounce, downloadBlob, clamp } from '../util.js';
import { state, getEntity, visibleEntities, scheduleSave } from '../state.js';
import {
  MAP_KINDS, newMarker, newLabel, MARKER_SHAPES, MARKER_COLORS,
  newStamp, STAMP_KINDS, STAMP_COLORS, newPath, PATH_STYLES,
  drawOverlay, renderMap,
} from '../maps/mapcore.js';
import { applyStrokeToGrid, renderWorldBase, buildWorldModel } from '../maps/world.js';
import { TOWN_LAYOUTS, TOWN_TERRAINS, TOWN_PAVINGS } from '../maps/town.js';
import { CELL, FLOOR, SOLID, DOOR, DUNGEON_STYLES, dungeonGrid, gridToString, renderDungeonBase } from '../maps/dungeon.js';
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
  let stampOpts = { kind: 'house', color: '', size: 1, secret: false }; // '' = kind default
  let drawOpts = { style: 'road', color: '', width: 0, secret: false }; // 0/'' = style default
  let labelSize = 24;
  let selected = null;
  let drawingPath = null; // path being drawn right now
  let lastDragPos = null;
  let model = null;
  let base = null;
  let W = 0, H = 0;

  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');

  function rebuild() {
    model = kind.buildModel(map);
    base = kind.renderBase(map, model);
    [W, H] = kind.size(map);
    canvas.width = W;
    canvas.height = H;
    redraw();
  }

  let rafPending = false;
  function redraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      ctx.drawImage(base, 0, 0);
      drawOverlay(ctx, map, W, H, { gm: state.gm, selected });
    });
  }
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

  function hitOverlay(p) {
    for (let i = (map.markers || []).length - 1; i >= 0; i--) {
      const mk = map.markers[i];
      if (mk.secret && !state.gm) continue;
      if (Math.hypot(mk.x * W - p.x, mk.y * H - p.y) < 14) return { obj: mk, list: 'markers' };
    }
    for (let i = (map.stamps || []).length - 1; i >= 0; i--) {
      const s = map.stamps[i];
      if (s.secret && !state.gm) continue;
      if (Math.hypot(s.x * W - p.x, s.y * H - p.y) < 16 * (s.size || 1)) return { obj: s, list: 'stamps' };
    }
    for (let i = (map.labels || []).length - 1; i >= 0; i--) {
      const lb = map.labels[i];
      ctx.font = `italic ${lb.size}px Georgia, serif`;
      const hw = ctx.measureText(lb.text).width / 2 + 8;
      if (Math.abs(lb.x * W - p.x) < hw && Math.abs(lb.y * H - p.y) < lb.size * 0.75) return { obj: lb, list: 'labels' };
    }
    for (let i = (map.paths || []).length - 1; i >= 0; i--) {
      const path = map.paths[i];
      if (path.secret && !state.gm) continue;
      if (distToPath(p, path) < 8) return { obj: path, list: 'paths' };
    }
    return null;
  }

  let dragging = null, painting = false, lastPaint = null;

  function paintWorld(p) {
    const stroke = {
      x: p.x / W, y: p.y / H, r: brush.r,
      d: (tool === 'raise' ? 1 : -1) * brush.strength,
    };
    if (lastPaint && Math.hypot(lastPaint.x - stroke.x, lastPaint.y - stroke.y) < brush.r * 0.35) return;
    lastPaint = stroke;
    (map.strokes ??= []).push(stroke);
    applyStrokeToGrid(model.height, stroke);
    base = renderWorldBase(map, model);
    redraw();
    save();
  }

  function paintDungeon(p) {
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
    if (cx < 0 || cy < 0 || cx >= model.cols || cy >= model.rows) return;
    const val = tool === 'floor' ? FLOOR : tool === 'wall' ? SOLID : DOOR;
    const i = cy * model.cols + cx;
    if (model.grid[i] === val) return;
    model.grid[i] = val;
    map.grid = gridToString(model.grid, model.cols, model.rows);
    base = renderDungeonBase(map, model);
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
      (map.stamps ??= []).push(s);
      selected = s.id;
      save(); redraw(); refreshLists();
    } else if (tool === 'draw') {
      drawingPath = newPath(drawOpts.style, {
        secret: drawOpts.secret,
        color: drawOpts.color || undefined,
        width: drawOpts.width || undefined,
      });
      drawingPath.pts.push([clamp(p.x / W, 0, 1), clamp(p.y / H, 0, 1)]);
      (map.paths ??= []).push(drawingPath);
    } else if (tool === 'marker') {
      const mk = newMarker(p.x / W, p.y / H, markerOpts);
      (map.markers ??= []).push(mk);
      selected = mk.id;
      save(); redraw(); refreshLists();
    } else if (tool === 'label') {
      const text = prompt('Label text:');
      if (text?.trim()) {
        const lb = newLabel(p.x / W, p.y / H, text.trim(), labelSize);
        (map.labels ??= []).push(lb);
        selected = lb.id;
        save(); redraw(); refreshLists();
      }
    } else if (tool === 'raise' || tool === 'lower') {
      painting = true; lastPaint = null; paintWorld(p);
    } else if (tool === 'floor' || tool === 'wall' || tool === 'door') {
      painting = true; paintDungeon(p);
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
      if (tool === 'raise' || tool === 'lower') paintWorld(p);
      else paintDungeon(p);
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
  canvas.addEventListener('mousemove', (ev) => {
    if (painting || dragging) return;
    if (!readOnly && tool !== 'move') return; // brush/marker tools keep their crosshair
    const hitRes = hitOverlay(pos(ev));
    canvas.style.cursor = hitRes?.obj?.to ? 'pointer' : 'default';
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
        brushOptsRow.style.display = (name === 'raise' || name === 'lower') ? '' : 'none';
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
    if (map.kind === 'dungeon' && map.grid) {
      if (!confirm('This regenerates the dungeon layout and discards your painted edits. Continue?')) return false;
      map.grid = null;
    }
    return true;
  }

  const seedInput = el('input', { type: 'text', value: map.seed, style: 'width:110px', oninput: (ev) => { map.seed = ev.target.value; } });

  const paramSection = el('div', {});
  if (map.kind === 'world') {
    paramSection.append(
      paramRow('Sea level', slider(p.water ?? 0.5, 0.36, 0.64, 0.01, (v) => { p.water = v; rebuild(); save(); })),
      paramRow('Zoom out', slider(p.scale ?? 3, 1.5, 6, 0.25, (v) => { p.scale = v; rebuild(); save(); })),
      paramRow('Rivers', slider(p.rivers ?? 6, 0, 14, 1, (v) => { p.rivers = v; rebuild(); save(); })),
      paramRow('Island', el('input', { type: 'checkbox', checked: !!p.island, onchange: (ev) => { p.island = ev.target.checked; rebuild(); save(); } })));
  } else if (map.kind === 'town') {
    // river is implied by riverside and replaced by the sea for coastal
    const riverRow = paramRow('River', el('input', {
      type: 'checkbox', checked: !!p.river,
      onchange: (ev) => { p.river = ev.target.checked; rebuild(); save(); },
    }));
    const syncRiverRow = () => {
      const layout = p.layout || 'auto';
      riverRow.style.display = (layout === 'coastal' || layout === 'riverside') ? 'none' : '';
    };
    paramSection.append(
      paramRow('Layout', el('select', {
        title: 'The overall shape of the settlement. “Surprise me” picks one from the seed.',
        onchange: (ev) => { p.layout = ev.target.value; syncRiverRow(); rebuild(); save(); },
      }, Object.entries(TOWN_LAYOUTS).map(([v, l]) =>
        el('option', { value: v, selected: v === (p.layout || 'auto') }, l)))),
      paramRow('Size', el('select', {
        onchange: (ev) => { p.size = Number(ev.target.value); rebuild(); save(); },
      }, [['1', 'Hamlet'], ['2', 'Village'], ['3', 'Town'], ['4', 'City'], ['5', 'Metropolis']].map(([v, l]) =>
        el('option', { value: v, selected: Number(v) === (p.size ?? 2) }, l)))),
      paramRow('Density', slider(p.density ?? 1, 0.4, 1.6, 0.1, (v) => { p.density = v; rebuild(); save(); })),
      // maps from before themes existed default to their original look
      paramRow('Terrain', el('select', {
        title: 'The land the town sits in — colors only, the town itself doesn’t change. “Surprise me” picks from the seed.',
        onchange: (ev) => { p.terrain = ev.target.value; rebuild(); save(); },
      }, Object.entries(TOWN_TERRAINS).map(([v, l]) =>
        el('option', { value: v, selected: v === (p.terrain ?? 'parchment') }, l)))),
      paramRow('Streets', el('select', {
        title: 'Dirt lanes, cobblestones, or grand flagstone avenues. “Auto” paves by settlement size.',
        onchange: (ev) => { p.paving = ev.target.value; rebuild(); save(); },
      }, Object.entries(TOWN_PAVINGS).map(([v, l]) =>
        el('option', { value: v, selected: v === (p.paving ?? 'dirt') }, l)))),
      paramRow('Walls', el('input', { type: 'checkbox', checked: !!p.walls, onchange: (ev) => { p.walls = ev.target.checked; rebuild(); save(); } })),
      riverRow);
    syncRiverRow();
  } else if (map.kind === 'dungeon') {
    const numInput = (key, min, max) => el('input', {
      type: 'number', value: p[key], min, max, style: 'width:70px',
      onchange: (ev) => {
        if (!confirmDiscardGrid()) { ev.target.value = p[key]; return; }
        p[key] = clamp(Number(ev.target.value), min, max);
        ev.target.value = p[key];
        rebuild(); save();
      },
    });
    const roomsRow = paramRow('Rooms', slider(p.rooms ?? 9, 3, 18, 1, (v) => {
      if (!confirmDiscardGrid()) return;
      p.rooms = v; rebuild(); save();
    }));
    const loopsRow = paramRow('Loops', slider(p.loops ?? 0.25, 0, 1, 0.05, (v) => {
      if (!confirmDiscardGrid()) return;
      p.loops = v; rebuild(); save();
    }));
    const syncStyleRows = () => {
      const caves = (p.style || 'rooms') === 'caves';
      roomsRow.style.display = caves ? 'none' : '';
      loopsRow.style.display = caves ? 'none' : '';
    };
    paramSection.append(
      paramRow('Style', el('select', {
        title: 'Built rooms joined by corridors, or natural caverns',
        onchange: (ev) => {
          if (!confirmDiscardGrid()) { ev.target.value = p.style || 'rooms'; return; }
          p.style = ev.target.value;
          syncStyleRows(); rebuild(); save();
        },
      }, Object.entries(DUNGEON_STYLES).map(([v, l]) =>
        el('option', { value: v, selected: v === (p.style || 'rooms') }, l)))),
      paramRow('Columns', numInput('cols', 16, 70)),
      paramRow('Rows', numInput('rows', 12, 50)),
      roomsRow, loopsRow);
    syncStyleRows();
  }

  // tools per kind
  const toolRow = el('div', { class: 'tool-row' }, toolBtn('move', '✋ Move', 'Select and drag markers/labels'));
  if (map.kind === 'world') {
    toolRow.append(toolBtn('raise', '⛰ Raise', 'Brush: raise terrain'), toolBtn('lower', '🌊 Lower', 'Brush: lower terrain'));
  }
  if (map.kind === 'dungeon') {
    toolRow.append(toolBtn('floor', '⬜ Floor'), toolBtn('wall', '⬛ Wall'), toolBtn('door', '🚪 Door'));
  }
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
      Object.entries(STAMP_KINDS).map(([v, l]) => el('option', { value: v, selected: v === stampOpts.kind }, l)))),
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

    if (map.markers?.length) {
      listsWrap.append(el('h3', {}, 'Markers'));
      const ml = el('div', { class: 'marker-list' });
      for (const mk of map.markers) {
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
    if (map.stamps?.length) {
      listsWrap.append(el('h3', {}, 'Placed things'));
      const sl = el('div', { class: 'marker-list' });
      for (const s of map.stamps) {
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
    if (map.labels?.length) {
      listsWrap.append(el('h3', {}, 'Labels'));
      const ll = el('div', { class: 'marker-list' });
      for (const lb of map.labels) {
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
    if (map.paths?.length) {
      listsWrap.append(el('h3', {}, 'Drawings'));
      const pl = el('div', { class: 'marker-list' });
      for (const pa of map.paths) {
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
    map.kind === 'world' && map.strokes?.length ? el('button', {
      class: 'ghost small', onclick: () => {
        if (!confirm('Undo all terrain brush edits?')) return;
        map.strokes = [];
        rebuild(); save();
      },
    }, 'Clear terrain edits') : el('span'),
    map.kind === 'dungeon' && map.grid ? el('button', {
      class: 'ghost small', onclick: () => {
        if (!confirm('Discard painted edits and return to the generated layout?')) return;
        map.grid = null;
        rebuild(); save();
      },
    }, 'Reset painted edits') : el('span'),
    readOnly ? el('span') : paramRow('Compass', el('input', {
      type: 'checkbox', checked: !!map.compass, title: 'Draw a compass rose in the corner',
      onchange: (ev) => { map.compass = ev.target.checked; save(); redraw(); },
    })),
    el('h3', {}, 'Tools'),
    readOnly ? el('div', { class: 'muted small' }, 'Editing disabled in player preview.') : toolRow,
    brushOptsRow, markerOptsRow, labelOptsRow, stampOptsRow, drawOptsRow,
    listsWrap,
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
