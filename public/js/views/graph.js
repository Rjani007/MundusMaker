// Relationship graph: force-directed canvas of all visible entities.
// Solid edges = explicit relations, dashed edges = [[wiki-link]] mentions.
// Player preview automatically drops GM-only nodes and secret relations.

import { el } from '../util.js';
import { state, types, typeOf, visibleEntities } from '../state.js';
import { extractLinkIds } from '../render.js';

export function render(container) {
  const wrap = el('div', { class: 'graph-wrap' });
  const canvas = el('canvas', { id: 'graphCanvas' });
  wrap.append(canvas);

  const enabledTypes = new Set(Object.keys(types()));
  let showMentions = true;

  const hud = el('div', { class: 'graph-hud' });
  function buildHud() {
    hud.innerHTML = '';
    hud.append(el('strong', {}, 'Graph'));
    for (const [key, t] of Object.entries(types())) {
      hud.append(el('label', {},
        el('input', {
          type: 'checkbox', checked: enabledTypes.has(key),
          onchange: (ev) => { ev.target.checked ? enabledTypes.add(key) : enabledTypes.delete(key); rebuild(); },
        }),
        el('span', { class: 'dot', style: `background:${t.color}` }),
        t.plural || t.label));
    }
    hud.append(el('label', { style: 'margin-top:6px;border-top:1px solid var(--line);padding-top:6px' },
      el('input', { type: 'checkbox', checked: showMentions, onchange: (ev) => { showMentions = ev.target.checked; rebuild(); } }),
      'show [[mention]] links'));
    hud.append(el('span', { class: 'muted', style: 'font-size:12px' }, 'drag nodes · scroll to zoom · click to open'));
  }
  buildHud();
  wrap.append(hud);
  container.append(wrap);

  const ctx = canvas.getContext('2d');
  let nodes = [], edges = [], nodeById = new Map();
  let view = { x: 0, y: 0, scale: 1 };
  let dragNode = null, panning = false, downPos = null, hoverNode = null;
  let alpha = 1;

  function rebuild() {
    const ents = visibleEntities().filter((e) => enabledTypes.has(e.type));
    const keep = new Map(nodes.map((n) => [n.id, n]));
    nodes = ents.map((e, i) => {
      const old = keep.get(e.id);
      const angle = (i / Math.max(1, ents.length)) * Math.PI * 2;
      return old || {
        id: e.id, name: e.name, color: typeOf(e).color,
        x: Math.cos(angle) * 220 + Math.random() * 40,
        y: Math.sin(angle) * 220 + Math.random() * 40,
        vx: 0, vy: 0, gmOnly: !!e.gmOnly,
      };
    });
    nodeById = new Map(nodes.map((n) => [n.id, n]));
    edges = [];
    const seen = new Set();
    for (const e of ents) {
      for (const r of e.relations || []) {
        if (!state.gm && r.secret) continue;
        if (!nodeById.has(r.to)) continue;
        edges.push({ a: e.id, b: r.to, label: r.label, kind: 'rel', secret: !!r.secret });
        seen.add(`${e.id}→${r.to}`);
      }
      if (showMentions) {
        for (const target of extractLinkIds(e, { includeSecret: state.gm })) {
          if (!nodeById.has(target) || target === e.id) continue;
          if (seen.has(`${e.id}→${target}`) || seen.has(`${target}→${e.id}`)) continue;
          edges.push({ a: e.id, b: target, kind: 'mention' });
          seen.add(`${e.id}→${target}`);
        }
      }
    }
    // node radius by degree
    const deg = new Map();
    for (const ed of edges) {
      deg.set(ed.a, (deg.get(ed.a) || 0) + 1);
      deg.set(ed.b, (deg.get(ed.b) || 0) + 1);
    }
    for (const n of nodes) n.r = 7 + Math.min(9, (deg.get(n.id) || 0) * 1.4);
    alpha = 1;
  }
  rebuild();

  function resize() {
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  function step() {
    if (alpha < 0.005) return;
    const k = 3600;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (k / d2) * alpha;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      a.vx -= a.x * 0.004 * alpha; // gentle centering
      a.vy -= a.y * 0.004 * alpha;
    }
    for (const ed of edges) {
      const a = nodeById.get(ed.a), b = nodeById.get(ed.b);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = ((d - 110) / d) * 0.04 * alpha;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      if (n === dragNode) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += Math.max(-14, Math.min(14, n.vx));
      n.y += Math.max(-14, Math.min(14, n.vy));
    }
    alpha *= 0.995;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2 + view.x, canvas.height / 2 + view.y);
    ctx.scale(view.scale, view.scale);

    const neighbors = hoverNode ? new Set([hoverNode.id]) : null;
    if (hoverNode) {
      for (const ed of edges) {
        if (ed.a === hoverNode.id) neighbors.add(ed.b);
        if (ed.b === hoverNode.id) neighbors.add(ed.a);
      }
    }

    for (const ed of edges) {
      const a = nodeById.get(ed.a), b = nodeById.get(ed.b);
      const dim = hoverNode && !(neighbors.has(ed.a) && neighbors.has(ed.b) && (ed.a === hoverNode.id || ed.b === hoverNode.id));
      ctx.strokeStyle = ed.secret ? `rgba(180, 140, 242, ${dim ? 0.12 : 0.7})` : `rgba(156, 148, 176, ${dim ? 0.1 : 0.45})`;
      ctx.lineWidth = ed.kind === 'rel' ? 1.6 : 1;
      ctx.setLineDash(ed.kind === 'mention' ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ed.label && view.scale > 0.7 && (!hoverNode || !dim)) {
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillStyle = 'rgba(156, 148, 176, 0.8)';
        ctx.textAlign = 'center';
        ctx.fillText(ed.label + (ed.secret ? ' 🔒' : ''), (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
      }
    }

    for (const n of nodes) {
      const dim = hoverNode && !neighbors.has(n.id);
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = n.color;
      ctx.strokeStyle = n === hoverNode ? '#fff' : 'rgba(0,0,0,0.4)';
      ctx.lineWidth = n === hoverNode ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (n.gmOnly && state.gm) {
        ctx.font = `${Math.round(n.r)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🔒', n.x, n.y - n.r - 8);
      }
      if (view.scale > 0.55 || n === hoverNode) {
        ctx.font = `${n === hoverNode ? 'bold ' : ''}12px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(10,8,14,0.9)';
        ctx.strokeStyle = 'rgba(10,8,14,0.9)';
        ctx.lineWidth = 3;
        ctx.strokeText(n.name, n.x, n.y + n.r + 3);
        ctx.fillStyle = dim ? 'rgba(232,228,240,0.4)' : '#e8e4f0';
        ctx.fillText(n.name, n.x, n.y + n.r + 3);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (!nodes.length) {
      ctx.fillStyle = '#9c94b0';
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nothing to show — create some entries and relations first.', canvas.width / 2, canvas.height / 2);
    }
  }

  let raf;
  function loop() {
    step();
    draw();
    raf = requestAnimationFrame(loop);
  }
  loop();

  const toWorld = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - canvas.width / 2 - view.x) / view.scale,
      y: (ev.clientY - rect.top - canvas.height / 2 - view.y) / view.scale,
    };
  };
  const hit = (p) => nodes.findLast((n) => Math.hypot(n.x - p.x, n.y - p.y) < n.r + 4);

  canvas.addEventListener('pointerdown', (ev) => {
    const p = toWorld(ev);
    downPos = { x: ev.clientX, y: ev.clientY };
    dragNode = hit(p) || null;
    panning = !dragNode;
    canvas.setPointerCapture(ev.pointerId);
    if (dragNode) alpha = Math.max(alpha, 0.3);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragNode) {
      const p = toWorld(ev);
      dragNode.x = p.x; dragNode.y = p.y;
      alpha = Math.max(alpha, 0.25);
    } else if (panning && downPos) {
      view.x += ev.movementX;
      view.y += ev.movementY;
    } else {
      hoverNode = hit(toWorld(ev)) || null;
      canvas.style.cursor = hoverNode ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    const moved = downPos && Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > 5;
    if (dragNode && !moved) location.hash = `#/e/${dragNode.id}`;
    dragNode = null; panning = false; downPos = null;
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 0.89;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left - canvas.width / 2;
    const my = ev.clientY - rect.top - canvas.height / 2;
    view.x = mx - (mx - view.x) * factor;
    view.y = my - (my - view.y) * factor;
    view.scale = Math.max(0.2, Math.min(3.5, view.scale * factor));
  }, { passive: false });

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}
