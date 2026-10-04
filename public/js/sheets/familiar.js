// Familiar sheet layouts (1.9; redrawn to look like the sheets players
// know). Each system has ONE section map: the sections of that game's standard
// character sheet, in its order and positions, with its field names and visual
// conventions (D&D's cut-corner frames, modifier circles and diamonds; V5's
// red headings, dot tracks and damage boxes; Call of Cthulhu's half/fifth
// boxes, numbered tracks and fixed skill grid). Everything is drawn for the
// project from lines, boxes and the standard PDF fonts: no publisher logos,
// artwork, borders or fonts, and nothing here calls a layout "official".
//
// One drawing routine renders the map through a "pen" with two backends: jsPDF
// for print and inline SVG for the in-app sheet, so screen and paper are the
// same drawing. Values come from the existing sheet data; the data model does
// not change. All line breaks and truncation are decided with the PDF fonts'
// own metrics (Helvetica and Times; the SVG asks for their metric-compatible
// system fonts), so both backends break lines in the same places.
//
// Page space: 100 x 129 units, portrait (US Letter's shape), like all three
// publishers' sheets. On A4 the page is scaled to fit and centered, so it never clips.

import { ABILITY_NAMES, SKILLS, mod, fmtMod, profBonus, passivePerception, skillBonus } from './dndrules.js';
import { sliderAria, damageAria, attrsHtml } from './sheetaria.js';

const PORTRAIT = [100, 129];
const LABELS = { dnd2024: 'D&D 2024', vtm5: 'VAMPIRE: THE MASQUERADE V5', coc7: 'CALL OF CTHULHU 7TH EDITION' };
export const FAMILIAR_SYSTEMS = Object.keys(LABELS);
// V5's layout is measured from Renegade's sheet, so sheets open in it; the
// others stay opt-in until testers approve them.
export const FAMILIAR_DEFAULT_SYSTEMS = ['vtm5'];

/**
 * The layout a sheet of `system` shows: the GM's choice for that game (a
 * per-browser setting, `sheetLayout.<system>`), else an older all-games
 * "familiar" choice, else the game's default. `read` is readSetting.
 */
export function sheetLayoutFor(system, read) {
  try {
    const own = read(`sheetLayout.${system}`);
    if (own === 'standard' || own === 'familiar') return FAMILIAR_SYSTEMS.includes(system) ? own : 'standard';
    if (read('sheetLayout') === 'familiar' && FAMILIAR_SYSTEMS.includes(system)) return 'familiar';
  } catch { /* storage unavailable: the defaults */ }
  return FAMILIAR_DEFAULT_SYSTEMS.includes(system) ? 'familiar' : 'standard';
}
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const str = (v) => (v == null ? '' : String(v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const pad2 = (n) => String(n).padStart(2, '0');

// Printed under the last page of each layout; the in-app sheet leaves it to
// Settings → About.
const NOTICES = {
  dnd2024: 'Sheet layout drawn by MundusMaker; not an official character sheet. Includes material from the System Reference Document 5.2 by Wizards of the Coast LLC, licensed under CC-BY-4.0.',
  vtm5: 'Fan material under the World of Darkness Dark Pack. Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. Sheet layout drawn by MundusMaker; not an official character sheet.',
  coc7: 'Fan material under Chaosium’s Fan Material Policy. Call of Cthulhu is a trademark of Chaosium Inc. Sheet layout drawn by MundusMaker; not an official character sheet.',
};

// ---------- text metrics (shared by both backends) ----------

const FONT = { sans: 'helvetica', serif: 'times' };
const FAMILY = { sans: "Helvetica, Arial, 'Liberation Sans', sans-serif", serif: "'Times New Roman', Times, 'Liberation Serif', serif" };
let measureDoc;
function unitWidth(s, font, style) {
  if (measureDoc === undefined) {
    const lib = globalThis.window?.jspdf;
    try { measureDoc = lib ? new lib.jsPDF({ unit: 'pt' }) : null; } catch { measureDoc = null; }
  }
  if (measureDoc) { measureDoc.setFont(FONT[font] || 'helvetica', style || 'normal'); return measureDoc.getStringUnitWidth(s); }
  // without jsPDF (the Node tests): average widths of the standard fonts
  let n = 0;
  for (const c of s) n += /[iljtfrI.,;:'!| ]/.test(c) ? 0.28 : /[mwMW@]/.test(c) ? 0.85 : /[A-Z0-9#%&]/.test(c) ? 0.66 : 0.52;
  return n * (/bold/.test(style || '') ? 1.05 : 1) * (font === 'serif' ? 0.95 : 1);
}
export function textWidth(s, size, font = 'sans', style = 'normal', spacing = 0) {
  const t = str(s);
  return unitWidth(t, font, style) * size + spacing * Math.max(0, [...t].length - 1);
}
function clip(s, w, size, font, style, spacing = 0) {
  const t = str(s);
  if (!w || textWidth(t, size, font, style, spacing) <= w) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (textWidth(t.slice(0, mid) + '…', size, font, style, spacing) <= w) lo = mid; else hi = mid - 1; }
  return lo ? t.slice(0, lo).trimEnd() + '…' : '…';
}
function wrap(text, w, size, font = 'sans', style = 'normal') {
  const out = [];
  for (const para of str(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (let word of words) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, font, style) <= w) { line = next; continue; }
      if (line) out.push(line);
      // a single word wider than the line breaks by characters
      while (word.length > 1 && textWidth(word, size, font, style) > w) {
        let k = word.length - 1;
        while (k > 1 && textWidth(word.slice(0, k), size, font, style) > w) k--;
        out.push(word.slice(0, k)); word = word.slice(k);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}
/** The largest size from `sizes` at which `s` fits in `w` (the last one otherwise). */
function fitSize(s, w, sizes, font, style) {
  return sizes.find((z) => textWidth(s, z, font, style) <= w) ?? sizes[sizes.length - 1];
}
/**
 * A text area: the wrapped lines that fit `rows`, the rest moved to the
 * continued details in full. Both renderers print exactly these lines.
 */
function area(text, w, rows, size, font, cont, title, style = 'normal') {
  const value = str(text).trim();
  if (!value || rows <= 0) return { lines: [], cap: Math.max(0, rows) };
  const lines = wrap(value, w, size, font, style);
  if (lines.length <= rows) return { lines, cap: rows };
  cont.push({ title, text: value });
  return { lines: [...lines.slice(0, rows - 1), '(continued on a later page)'], cap: rows };
}

// ---------- pens ----------

const hex = (c) => { const v = parseInt(String(c).slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

function pdfPen(doc, safe) {
  let u = 1, ox = 0, oy = 0;
  const X = (v) => ox + v * u, Y = (v) => oy + v * u;
  const paint = (o) => {
    doc.setLineWidth((o.w ?? 0.15) * u);
    doc.setDrawColor(...hex(o.c || '#000000'));
    if (o.fill) doc.setFillColor(...hex(o.fill));
    doc.setLineDashPattern(o.dash ? o.dash.map((v) => v * u) : [], 0);
    return o.fill ? (o.stroke === false ? 'F' : 'FD') : 'S';
  };
  return {
    page(pw, ph) {
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
      u = Math.min(W / pw, H / ph); ox = (W - pw * u) / 2; oy = (H - ph * u) / 2;
    },
    background(color) {
      if (color.toLowerCase() === '#ffffff') return;
      doc.setFillColor(...hex(color));
      doc.rect(0, 0, doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight(), 'F');
    },
    line(x1, y1, x2, y2, o = {}) { paint({ ...o, fill: null }); doc.line(X(x1), Y(y1), X(x2), Y(y2)); },
    rect(x, y, w, h, o = {}) {
      if (o.hit) return; // click targets exist only on screen
      const st = paint(o);
      if (o.r) doc.roundedRect(X(x), Y(y), w * u, h * u, o.r * u, o.r * u, st); else doc.rect(X(x), Y(y), w * u, h * u, st);
    },
    poly(pts, o = {}) {
      const st = paint(o.open ? { ...o, fill: null } : o);
      const deltas = pts.slice(1).map(([px, py], i) => [(px - pts[i][0]) * u, (py - pts[i][1]) * u]);
      doc.lines(deltas, X(pts[0][0]), Y(pts[0][1]), [1, 1], st, !o.open);
    },
    circle(cx, cy, r, o = {}) { const st = paint(o); doc.circle(X(cx), Y(cy), r * u, st); },
    ellipse(cx, cy, rx, ry, o = {}) { const st = paint(o); doc.ellipse(X(cx), Y(cy), rx * u, ry * u, st); },
    text(s, x, y, o = {}) {
      const size = o.size || 1.2, font = o.font || 'sans', style = o.style || 'normal', sp = o.spacing || 0;
      let t = safe(str(s));
      if (!t) return;
      if (o.maxW) t = clip(t, o.maxW, size, font, style, sp);
      doc.setFont(FONT[font], style); doc.setFontSize(size * u); doc.setTextColor(...hex(o.c || '#000000'));
      // alignment is measured here so spaced and rotated text line up too
      const w = textWidth(t, size, font, style, sp), shift = o.align === 'center' ? w / 2 : o.align === 'right' ? w : 0;
      const opts = { baseline: 'alphabetic' };
      if (sp) opts.charSpace = sp * u;
      if (o.angle === 90) doc.text(t, X(x), Y(y + shift), { ...opts, angle: 90 });
      else if (o.angle === -90) doc.text(t, X(x), Y(y - shift), { ...opts, angle: -90 });
      else doc.text(t, X(x - shift), Y(y), opts);
    },
    group(_attrs, fn) { fn(); },
  };
}

const esc = (s) => str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// SVG coordinates are page units x 10, so text sizes stay well above the
// sizes some browsers refuse to scale. A group with `aria` is one keyboard
// stop (sheetaria.js); the pen measures what is drawn inside it and adds a
// focus ring the stylesheet shows on :focus-visible.
function svgPen() {
  const K = 10, parts = [], boxes = [];
  const n = (v) => Math.round(v * K * 100) / 100;
  const grow = (x0, y0, x1, y1) => { for (const b of boxes) { b[0] = Math.min(b[0], x0); b[1] = Math.min(b[1], y0); b[2] = Math.max(b[2], x1); b[3] = Math.max(b[3], y1); } };
  const extra = (o) => (o.cls ? ` class="${o.cls}"` : '') + Object.entries(o.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('') + attrsHtml(o.aria);
  const paint = (o) => ` fill="${o.hit ? 'transparent' : o.fill || 'none'}" stroke="${o.hit || o.stroke === false ? 'none' : o.c || '#000'}" stroke-width="${n(o.w ?? 0.15)}"${o.dash ? ` stroke-dasharray="${o.dash.map(n).join(' ')}"` : ''}`;
  return {
    parts, K,
    line(x1, y1, x2, y2, o = {}) { grow(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)); parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"${paint({ ...o, fill: null })}/>`); },
    rect(x, y, w, h, o = {}) { grow(x, y, x + w, y + h); parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${o.r ? ` rx="${n(o.r)}"` : ''}${paint(o)}${extra(o)}/>`); },
    poly(pts, o = {}) { grow(Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))); parts.push(`<${o.open ? 'polyline' : 'polygon'} points="${pts.map(([a, b]) => `${n(a)},${n(b)}`).join(' ')}"${paint(o.open ? { ...o, fill: null } : o)}${extra(o)}/>`); },
    circle(cx, cy, r, o = {}) { grow(cx - r, cy - r, cx + r, cy + r); parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"${paint(o)}${extra(o)}/>`); },
    ellipse(cx, cy, rx, ry, o = {}) { grow(cx - rx, cy - ry, cx + rx, cy + ry); parts.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}"${paint(o)}${extra(o)}/>`); },
    text(s, x, y, o = {}) {
      const size = o.size || 1.2, font = o.font || 'sans', style = o.style || 'normal', sp = o.spacing || 0;
      let t = str(s);
      if (!t) return;
      if (o.maxW) t = clip(t, o.maxW, size, font, style, sp);
      const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start';
      const tw = textWidth(t, size, font, style, sp), tx = anchor === 'middle' ? x - tw / 2 : anchor === 'end' ? x - tw : x;
      if (!o.angle) grow(tx, y - size * 0.75, tx + tw, y + size * 0.2);
      parts.push(`<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" font-family="${FAMILY[font]}"`
        + `${/bold/.test(style) ? ' font-weight="bold"' : ''}${/italic/.test(style) ? ' font-style="italic"' : ''} fill="${o.c || '#000'}"`
        + `${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}${sp ? ` letter-spacing="${n(sp)}"` : ''}`
        + `${o.angle ? ` transform="rotate(${-o.angle} ${n(x)} ${n(y)})"` : ''}${extra(o)}>${esc(t)}</text>`);
    },
    group(o, fn) {
      parts.push(`<g${extra(o)}>`);
      if (!o.aria) { fn(); parts.push('</g>'); return; }
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      boxes.push(box); fn(); boxes.splice(boxes.indexOf(box), 1);
      if (box[0] < box[2]) parts.push(`<rect class="fam-focus" x="${n(box[0] - 0.6)}" y="${n(box[1] - 0.6)}" width="${n(box[2] - box[0] + 1.2)}" height="${n(box[3] - box[1] + 1.2)}" rx="${n(0.6)}" fill="none" stroke="none"/>`);
      parts.push('</g>');
    },
  };
}

// ---------- shapes ----------

const chamfer = (x, y, w, h, c) => [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]];
const diamondPts = (cx, cy, r) => [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];

// ======================================================================
// D&D 2024 (portrait, two pages: the free rules sheet is US Letter upright)
// ======================================================================

const DND = { ink: '#231f20', soft: '#5f5b5c', faint: '#a9a6a6', grid: '#e7e5e5', paper: '#ffffff' };
// ability block rows: title, modifier circle, saving throw, each skill, bottom
const AB = { title: 2.8, circle: 8.0, save: 3.2, skill: 2.4, pad: 1.2 };
// Expended-slot diamonds per level on the printed sheet
const SLOT_DIAMONDS = [4, 3, 3, 3, 3, 2, 2, 1, 1];
const DND_TEXT = { size: 1.15, line: 1.6, top: 4.35 };
// the two columns of the printed sheet's left half
const COL1 = { x: 2, w: 15.2 }, COL2 = { x: 19.4, w: 15.7 }, RIGHT = { x: 36.7, w: 61.2 };

// the width a dnd-text section wraps its lines to: exactly what it draws
const dndTextW = (w, cols = 1) => (w - 1.6) / cols - 0.9;
// casting times as players write them in the narrow column
export const shortTime = (t) => str(t).replace(/,.*$/, '').replace(/^1 bonus action$|^bonus action$/i, 'Bonus').replace(/^1 (action|reaction)$/i, (_, w) => cap(w))
  .replace(/\bminutes?\b/i, 'min').replace(/\bhours?\b/i, 'hr');

function dndRows(h, footer = 0) { return Math.max(0, Math.floor((h - DND_TEXT.top + DND_TEXT.line - 0.9 - footer) / DND_TEXT.line)); }

function dnd(d, name) {
  const cont = [];
  const abs = d.abilities || {}, c = d.klass || {}, hp = d.hp || {}, level = num(c.level, 1), pb = profBonus(level);
  const sec = (kind, title, x, y, w, h, props = {}) => ({ kind, title, x, y, w, h, ...props });
  const skillRow = (n) => { const s = (d.skills || []).find((x) => x.key === n); return { label: n, on: !!s, expert: s?.prof === 'expert', value: fmtMod(skillBonus(d, n, pb)) }; };
  const ability = (a, col, y) => {
    const skills = SKILLS.filter(([, ab]) => ab === a).map(([n]) => n).sort();
    const on = !!d.saves?.includes(a);
    return sec('dnd-ability', ABILITY_NAMES[a], col.x, y, col.w, AB.title + AB.circle + AB.save + skills.length * AB.skill + AB.pad, {
      score: abs[a] ?? 10, mod: fmtMod(mod(abs[a])), save: { on, value: fmtMod(mod(abs[a]) + (on ? pb : 0)) }, skills: skills.map(skillRow),
    });
  };
  const features = d.features || [];
  const isFeat = (f) => /feat/i.test(f.source || '') || f.kind === 'feat';
  const isSpecies = (f) => (d.species?.name && (f.source || '').includes(d.species.name)) || /species|lineage|trait/i.test(f.source || '');
  const names = (list) => list.map((f) => f.name).join('\n');
  const classFeats = features.filter((f) => !isFeat(f) && !isSpecies(f)), speciesTraits = features.filter((f) => !isFeat(f) && isSpecies(f)), feats = features.filter(isFeat);
  for (const f of features.filter((x) => x.text)) cont.push({ title: [f.name, f.source].filter(Boolean).join(' · '), text: f.text });
  const prof = d.proficiencies || {};
  const armor = (prof.armor || []).map((s) => String(s).toLowerCase());
  const attacks = d.attacks || [];
  if (attacks.length > 6) cont.push({ title: 'All weapons & attacks', text: attacks.map((a) => `${a.name}: ${typeof a.bonus === 'number' ? fmtMod(a.bonus) : str(a.bonus)}; ${a.damage || ''}; ${a.notes || ''}`).join('\n') });
  const statW = (RIGHT.w - 3 * 1.2) / 4;
  const stat = (title, i, value, size) => sec('dnd-stat', title, RIGHT.x + i * (statW + 1.2), 18.8, statW, 7.1, { value, size });
  const classH = 38, classRows = dndRows(classH), classArea = area(names(classFeats), dndTextW(RIGHT.w, 2), classRows * 2, DND_TEXT.size, 'sans', cont, 'Class features');
  const halfW = (RIGHT.w - 1.4) / 2;

  const page1 = [
    sec('dnd-identity', 'Character name', 2, 2.1, 38.3, 12.4, { name, fields: [['Background', d.background?.name], ['Class', c.name], ['Species', d.species?.name], ['Subclass', c.subclass]] }),
    sec('dnd-level', 'Level', 40.8, 2.1, 10.4, 12.6, { level, xp: d.xp }),
    sec('dnd-ac', 'Armor class', 51.8, 2.1, 9.6, 12.6, { ac: d.ac ?? 10, shield: !!d.defense?.shield }),
    sec('dnd-vitals', 'Hit points', 62, 2.1, 36, 12.4, {
      hp: { current: hp.current ?? '', temp: hp.temp || '', max: hp.max ?? '' },
      hitDice: { spent: d.hitDice?.spent || 0, max: `${level}d${c.hitDie || 8}` },
      death: { success: num(d.deathSaves?.success), failure: num(d.deathSaves?.failure) },
    }),
    sec('dnd-band', '', 2, 15.2, 96, 2.2),
    sec('dnd-stat', 'Proficiency bonus', COL1.x, 18.8, COL1.w, 11.2, { value: fmtMod(pb), plaque: true }),
    ability('str', COL1, 31.4), ability('dex', COL1, 50.4), ability('con', COL1, 74.3),
    sec('dnd-inspiration', 'Heroic inspiration', COL1.x, 91, COL1.w, 10, { on: !!d.inspiration }),
    ability('int', COL2, 18.8), ability('wis', COL2, 47.4), ability('cha', COL2, 76.0),
    sec('dnd-training', 'Equipment training & proficiencies', 2, 102.6, 33.1, 24.4, {
      armor: [['Light', 'light'], ['Medium', 'medium'], ['Heavy', 'heavy'], ['Shields', 'shield']].map(([label, k]) => ({ label, on: armor.some((a) => a.includes(k)) })),
      weapons: area((prof.weapons || []).join(', '), 30.6, 5, 1.1, 'sans', cont, 'Weapon proficiencies'),
      tools: area((prof.tools || []).join(', '), 30.6, 3, 1.1, 'sans', cont, 'Tool proficiencies'),
    }),
    stat('Initiative', 0, fmtMod(mod(abs.dex) + num(d.initiativeBonus))),
    stat('Speed', 1, `${d.speed ?? 30} ft`),
    stat('Size', 2, d.species?.size || 'Medium', 1.8),
    stat('Passive perception', 3, passivePerception({ ...d, abilities: abs }, pb)),
    sec('dnd-table', 'Weapons & damage cantrips', RIGHT.x, 27.3, RIGHT.w, 26.2, {
      cols: [['Name', 30], ['Atk Bonus / DC', 15], ['Damage & Type', 24], ['Notes', 31]],
      rows: attacks.slice(0, 6).map((a) => [a.name, typeof a.bonus === 'number' ? fmtMod(a.bonus) : str(a.bonus), a.damage, a.notes]), count: 6,
    }),
    sec('dnd-text', 'Class features', RIGHT.x, 54.9, RIGHT.w, classH, { text: classArea, columns: 2, rows: classRows }),
    sec('dnd-text', 'Species traits', RIGHT.x, 94.5, halfW, 32.5, { text: area(names(speciesTraits), dndTextW(halfW), dndRows(32.5), DND_TEXT.size, 'sans', cont, 'Species traits') }),
    sec('dnd-text', 'Feats', RIGHT.x + halfW + 1.4, 94.5, halfW, 32.5, { text: area(names(feats), dndTextW(halfW), dndRows(32.5), DND_TEXT.size, 'sans', cont, 'Feats') }),
  ];

  const sc = d.spellcasting || {};
  const spells = spellList(d);
  if (spells.length > 30) cont.push({ title: 'All spells', text: spells.map((s) => `${s.level === 0 ? 'Cantrip' : `Level ${s.level ?? '?'}`} · ${s.name}${s.note ? ` · ${s.note}` : ''}`).join('\n') });
  for (const s of spells.filter((x) => x.text)) cont.push({ title: s.name, text: [[s.castingTime, s.range, s.components, s.duration].filter(Boolean).join(' · '), s.text, s.higherLevel].filter(Boolean).join('\n\n') });
  const personality = Object.entries(d.personality || {}).filter(([, v]) => str(v).trim()).map(([k, v]) => `${cap(k)}: ${v}`).join('\n');
  const coins = d.coins || {};
  const abilityName = sc.ability ? ABILITY_NAMES[sc.ability] || String(sc.ability).toUpperCase() : '';
  const side = { x: 67.3, w: 30.7 };
  const equipRows = dndRows(44, 8.6);
  const page2 = [
    sec('dnd-spellcasting', 'Spellcasting ability', 2, 2.1, 20.6, 19.7, {
      ability: abilityName,
      rows: [['Spellcasting', 'modifier', sc.ability ? fmtMod(mod(abs[sc.ability])) : ''], ['Spell save DC', '', sc.dc ?? ''], ['Spell attack', 'bonus', sc.attackBonus == null || sc.attackBonus === '' ? '' : fmtMod(num(sc.attackBonus))]],
    }),
    sec('dnd-banner', '', 24.1, 2.1, 41.8, 5.6, { name, line: [c.name ? `${c.name} ${level}` : '', c.subclass].filter(Boolean).join(' · ') }),
    sec('dnd-slots', 'Spell slots', 24.1, 8.8, 41.8, 13, {
      slots: Array.from({ length: 9 }, (_, i) => { const s = sc.slots?.[i + 1] || {}; return { level: i + 1, max: num(s.max), used: num(s.used), path: `spellcasting.slots.${i + 1}.used`, live: !!sc.slots?.[i + 1] }; }),
    }),
    sec('dnd-spells', 'Cantrips & prepared spells', 2, 23.3, 63.9, 103.7, {
      rows: spells.slice(0, 30).map((s) => ({ level: s.level === 0 ? 'C' : str(s.level ?? ''), name: s.name, time: shortTime(s.castingTime), range: s.range, c: !!s.concentration, r: !!s.ritual, m: /\bM\b/.test(s.components || ''), note: s.note })), count: 30,
    }),
    sec('dnd-text', 'Appearance', side.x, 2.1, side.w, 16.1, { text: area(d.appearance, dndTextW(side.w), dndRows(16.1), DND_TEXT.size, 'sans', cont, 'Appearance') }),
    sec('dnd-text', 'Backstory & personality', side.x, 19.9, side.w, 31, {
      text: area([personality, d.backstory || ''].filter(Boolean).join('\n'), dndTextW(side.w), dndRows(31, 3.6), DND_TEXT.size, 'sans', cont, 'Backstory & personality'),
      footer: { kind: 'line', label: 'Alignment', value: d.alignment },
    }),
    sec('dnd-text', 'Languages', side.x, 52.4, side.w, 11.1, { text: area((d.languages || []).join(', '), dndTextW(side.w), dndRows(11.1), DND_TEXT.size, 'sans', cont, 'Languages') }),
    sec('dnd-text', 'Equipment', side.x, 65, side.w, 44, {
      text: area((d.equipment || []).map((e) => `${(e.qty || 1) > 1 ? `${e.qty} × ` : ''}${e.name}`).join('\n'), dndTextW(side.w), equipRows, DND_TEXT.size, 'sans', cont, 'Equipment'),
      footer: { kind: 'attune', label: 'Magic Item Attunement', values: (d.attuned || []).slice(0, 3) },
    }),
    sec('dnd-coins', 'Coins', side.x, 110.6, side.w, 11.6, { coins: ['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => [k.toUpperCase(), coins[k] ?? '']) }),
  ];
  if ((d.attuned || []).length > 3) cont.push({ title: 'Attuned magic items', text: d.attuned.join('\n') });
  if (d.notes) cont.push({ title: 'Notes', text: d.notes });
  return { system: 'dnd2024', size: PORTRAIT, font: 'sans', pages: [page1, page2], continuations: cont, notice: NOTICES.dnd2024 };
}

export function spellList(d) {
  const sc = d.spellcasting || {}, found = new Map();
  for (const [list, note] of [[sc.cantrips, ''], [sc.alwaysPrepared, 'Always prepared'], [sc.prepared, ''], [sc.spellbook, 'Spellbook']]) {
    for (const nm of list || []) if (!found.has(nm)) { const detail = d.spellDetails?.find((s) => s.name === nm) || {}; found.set(nm, { ...detail, level: detail.level ?? (list === sc.cantrips ? 0 : undefined), name: nm, note }); }
  }
  for (const s of d.innateSpells || []) if (!found.has(s.name)) found.set(s.name, { ...(d.spellDetails?.find((x) => x.name === s.name) || {}), ...s, note: s.uses ? `${s.uses}/Long Rest` : (s.source || 'Innate') });
  return [...found.values()].sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name));
}

// ---- D&D drawing ----

function dndFrame(pen, s, { title = s.title, rule = false, cut = 1.1, fill = DND.paper, titleY = 1.9 } = {}) {
  pen.poly(chamfer(s.x, s.y, s.w, s.h, cut), { w: 0.24, c: DND.ink, fill });
  if (title) pen.text(title.toUpperCase(), s.x + s.w / 2, s.y + titleY, { size: 1.0, style: 'bold', align: 'center', c: DND.ink, maxW: s.w - 2 });
  if (rule) pen.line(s.x + 0.9, s.y + 2.55, s.x + s.w - 0.9, s.y + 2.55, { w: 0.1, c: DND.ink });
}
function gridPaper(pen, x, y, w, h, step = 1.6) {
  for (let gx = x + step; gx < x + w - 0.1; gx += step) pen.line(gx, y, gx, y + h, { w: 0.05, c: DND.grid });
  for (let gy = y + step; gy < y + h - 0.1; gy += step) pen.line(x, gy, x + w, gy, { w: 0.05, c: DND.grid });
}
function bubble(pen, cx, cy, on, expert) {
  pen.circle(cx, cy, 0.52, { w: 0.14, c: DND.ink, fill: on ? DND.ink : DND.paper });
  if (expert) pen.circle(cx, cy, 0.84, { w: 0.12, c: DND.ink });
}
function diamond(pen, cx, cy, r, on, o = {}) {
  pen.poly(diamondPts(cx, cy, r), { w: 0.14, c: DND.ink, fill: on ? DND.ink : DND.paper, ...o });
}
// "○ __+3__ Arcana": the bubble, the value written on a short line, the label
function dndCheckRow(pen, x, w, top, h, row, bold) {
  const base = top + h * 0.68;
  bubble(pen, x + 1.25, base - 0.4, row.on, row.expert);
  pen.line(x + 2.3, base + 0.3, x + 4.9, base + 0.3, { w: 0.08, c: DND.ink });
  pen.text(row.value, x + 3.6, base, { size: 1.1, style: 'bold', align: 'center', c: DND.ink });
  pen.text(row.label, x + 5.3, base, { size: 1.02, style: bold ? 'bold' : 'normal', c: DND.ink, maxW: w - 5.8 });
}
function dndValueLine(pen, x, w, base, value, label, { size = 1.45, align = 'center' } = {}) {
  pen.text(value, align === 'center' ? x + w / 2 : x + 0.2, base, { size, style: 'bold', align, c: DND.ink, maxW: w });
  pen.line(x, base + 0.55, x + w, base + 0.55, { w: 0.1, c: DND.ink });
  if (label) pen.text(label.toUpperCase(), x, base + 1.5, { size: 0.74, style: 'bold', c: DND.ink, maxW: w });
}

const DRAW = {};

DRAW['dnd-identity'] = (pen, s) => {
  dndFrame(pen, s, { title: '' });
  const x = s.x + 1.3, w = s.w - 2.6;
  dndValueLine(pen, x, w, s.y + s.h * 0.27, s.name, 'Character name', { size: 2.0, align: 'left' });
  const half = (w - 1.6) / 2;
  s.fields.forEach(([label, value], i) => {
    const fx = x + (i % 2) * (half + 1.6), base = s.y + s.h * (i < 2 ? 0.56 : 0.84);
    dndValueLine(pen, fx, half, base, value, label, { size: 1.25, align: 'left' });
  });
};

DRAW['dnd-level'] = (pen, s) => {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, rx = s.w / 2, ry = s.h / 2;
  pen.ellipse(cx, cy, rx, ry, { w: 0.24, c: DND.ink, fill: DND.paper });
  pen.text(s.level, cx, cy - ry * 0.12, { size: 2.7, style: 'bold', align: 'center', c: DND.ink });
  pen.text('LEVEL', cx, cy + ry * 0.24, { size: 0.76, style: 'bold', align: 'center', c: DND.ink });
  const chord = (dy) => rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2));
  const ly = ry * 0.42, half = chord(ly) - 0.5;
  pen.line(cx - half, cy + ly, cx + half, cy + ly, { w: 0.1, c: DND.ink });
  pen.text(s.xp ?? '', cx, cy + ry * 0.66, { size: 0.98, align: 'center', c: DND.ink, maxW: chord(ry * 0.66) * 2 - 0.4 });
  pen.text('XP', cx, cy + ry * 0.88, { size: 0.7, style: 'bold', align: 'center', c: DND.ink });
};

DRAW['dnd-ac'] = (pen, s) => {
  const { x, y, w, h } = s, cx = x + w / 2;
  pen.poly([[x + 0.6, y], [x + w - 0.6, y], [x + w, y + 0.6], [x + w, y + h * 0.6], [cx, y + h], [x, y + h * 0.6], [x, y + 0.6]], { w: 0.24, c: DND.ink, fill: DND.paper });
  pen.text('ARMOR', cx, y + 1.9, { size: 0.86, style: 'bold', align: 'center', c: DND.ink });
  pen.text('CLASS', cx, y + 2.95, { size: 0.86, style: 'bold', align: 'center', c: DND.ink });
  pen.text(s.ac, cx, y + h * 0.55, { size: 2.8, style: 'bold', align: 'center', c: DND.ink });
  pen.text('SHIELD', cx, y + h * 0.74, { size: 0.66, style: 'bold', align: 'center', c: DND.ink });
  diamond(pen, cx, y + h * 0.85, 0.55, s.shield);
};

DRAW['dnd-vitals'] = (pen, s) => {
  dndFrame(pen, s, { title: '' });
  const { y, h } = s, hpW = s.w * 0.515, hdW = s.w * 0.215, hpX = s.x, hdX = s.x + hpW, dsX = hdX + hdW, dsW = s.w - hpW - hdW;
  pen.line(hdX, y + 0.5, hdX, y + h - 0.5, { w: 0.18, c: DND.ink });
  pen.line(dsX, y + 0.5, dsX, y + h - 0.5, { w: 0.18, c: DND.ink });
  // hit points: current on the left, temp and max stacked on the right
  pen.text('HIT POINTS', hpX + hpW / 2, y + 1.9, { size: 0.95, style: 'bold', align: 'center', c: DND.ink });
  const split = hpX + hpW * 0.56;
  pen.line(split, y + 3.2, split, y + h - 0.8, { w: 0.08, c: DND.ink });
  pen.text(s.hp.current, (hpX + split) / 2, y + h * 0.66, { size: 3.0, style: 'bold', align: 'center', c: DND.ink });
  pen.line(hpX + 1.0, y + h * 0.8, split - 0.6, y + h * 0.8, { w: 0.1, c: DND.ink });
  pen.text('CURRENT', hpX + 1.0, y + h * 0.8 + 1.4, { size: 0.72, style: 'bold', c: DND.ink });
  dndValueLine(pen, split + 0.6, hpX + hpW - split - 1.2, y + h * 0.42, s.hp.temp, 'Temp', { size: 1.3 });
  dndValueLine(pen, split + 0.6, hpX + hpW - split - 1.2, y + h * 0.8, s.hp.max, 'Max', { size: 1.3 });
  // hit dice
  pen.text('HIT DICE', hdX + hdW / 2, y + 1.9, { size: 0.9, style: 'bold', align: 'center', c: DND.ink });
  dndValueLine(pen, hdX + 0.8, hdW - 1.6, y + h * 0.42, s.hitDice.spent, 'Spent', { size: 1.3 });
  dndValueLine(pen, hdX + 0.8, hdW - 1.6, y + h * 0.8, s.hitDice.max, 'Max', { size: 1.3 });
  // death saves
  pen.text('DEATH SAVES', dsX + dsW / 2, y + 1.9, { size: 0.86, style: 'bold', align: 'center', c: DND.ink, maxW: dsW - 0.6 });
  [['success', 'SUCCESSES', 0.44], ['failure', 'FAILURES', 0.76]].forEach(([key, label, at]) => {
    const pitch = Math.min(2.4, (dsW - 2.4) / 2.6);
    pen.group({ cls: 'dots', data: { dots: `deathSaves.${key}` }, aria: sliderAria({ label: key === 'success' ? 'Death save successes' : 'Death save failures', value: s.death[key], max: 3 }) }, () => {
      for (let i = 0; i < 3; i++) diamond(pen, dsX + dsW / 2 + (i - 1) * pitch, y + h * at, 0.72, i < s.death[key], { cls: 'dot-p', data: { dot: i + 1 } });
    });
    pen.text(label, dsX + dsW / 2, y + h * at + 1.85, { size: 0.68, style: 'bold', align: 'center', c: DND.ink });
  });
};

DRAW['dnd-band'] = (pen, s) => {
  const cx = s.x + s.w / 2, my = s.y + s.h / 2;
  for (const dy of [-0.3, 0.3]) {
    pen.line(s.x + 1.2, my + dy, cx - 3.2, my + dy, { w: 0.12, c: DND.ink });
    pen.line(cx + 3.2, my + dy, s.x + s.w - 1.2, my + dy, { w: 0.12, c: DND.ink });
  }
  pen.circle(s.x + 0.6, my, 0.45, { w: 0.12, c: DND.ink, fill: DND.ink });
  pen.circle(s.x + s.w - 0.6, my, 0.45, { w: 0.12, c: DND.ink, fill: DND.ink });
  pen.poly(diamondPts(cx, my, 1.0), { w: 0.14, c: DND.ink, fill: DND.paper });
  pen.poly(diamondPts(cx, my, 0.45), { w: 0.1, c: DND.ink, fill: DND.ink });
  pen.poly(diamondPts(cx - 2.3, my, 0.4), { w: 0.1, c: DND.ink, fill: DND.ink });
  pen.poly(diamondPts(cx + 2.3, my, 0.4), { w: 0.1, c: DND.ink, fill: DND.ink });
};

DRAW['dnd-stat'] = (pen, s) => {
  dndFrame(pen, s);
  if (s.plaque) {
    const pw = Math.min(9, s.w - 5), ph = s.h - 3.8, px = s.x + (s.w - pw) / 2, py = s.y + 2.8;
    pen.poly([[px, py], [px + pw, py], [px + pw, py + ph - 1.4], [px + pw / 2, py + ph], [px, py + ph - 1.4]], { w: 0.16, c: DND.ink });
    pen.text(s.value, s.x + s.w / 2, py + ph * 0.6, { size: 2.6, style: 'bold', align: 'center', c: DND.ink });
    return;
  }
  pen.line(s.x + 0.9, s.y + 2.55, s.x + s.w - 0.9, s.y + 2.55, { w: 0.1, c: DND.ink });
  pen.text(s.value, s.x + s.w / 2, s.y + s.h - 1.35, { size: s.size || 2.5, style: 'bold', align: 'center', c: DND.ink, maxW: s.w - 1.6 });
};

DRAW['dnd-ability'] = (pen, s) => {
  dndFrame(pen, s);
  const r = Math.min(2.6, s.w * 0.165), cx = s.x + s.w * 0.36, cy = s.y + AB.title + 3.3;
  const tx = cx + r * 0.4, tr = s.x + s.w - 0.8, scoreX = (cx + r + tr) / 2;
  // the score tab sits behind the modifier circle
  pen.poly([[tx, cy - 1.7], [tr - 1.0, cy - 1.7], [tr, cy - 0.7], [tr, cy + 1.7], [tx, cy + 1.7]], { w: 0.14, c: DND.ink, fill: DND.paper });
  pen.circle(cx, cy, r, { w: 0.22, c: DND.ink, fill: DND.paper });
  pen.text(s.mod, cx, cy + 0.8, { size: 2.1, style: 'bold', align: 'center', c: DND.ink });
  pen.text(s.score, scoreX, cy + 0.5, { size: 1.35, align: 'center', c: DND.ink });
  pen.text('MODIFIER', cx, cy + r + 0.95, { size: 0.64, style: 'bold', align: 'center', c: DND.ink });
  pen.text('SCORE', scoreX, cy + 2.75, { size: 0.64, style: 'bold', align: 'center', c: DND.ink });
  let top = s.y + AB.title + AB.circle;
  pen.line(s.x + 0.4, top, s.x + s.w - 0.4, top, { w: 0.14, c: DND.ink });
  dndCheckRow(pen, s.x, s.w, top, AB.save, { ...s.save, label: 'Saving Throw' }, true);
  top += AB.save;
  if (s.skills.length) pen.line(s.x + 0.4, top, s.x + s.w - 0.4, top, { w: 0.14, c: DND.ink });
  top += 0.3;
  for (const row of s.skills) { dndCheckRow(pen, s.x, s.w, top, AB.skill, row, false); top += AB.skill; }
};

DRAW['dnd-inspiration'] = (pen, s) => {
  dndFrame(pen, s, { title: '' });
  pen.text('HEROIC', s.x + s.w / 2, s.y + 1.9, { size: 0.95, style: 'bold', align: 'center', c: DND.ink });
  pen.text('INSPIRATION', s.x + s.w / 2, s.y + 3.0, { size: 0.95, style: 'bold', align: 'center', c: DND.ink });
  const cx = s.x + s.w / 2, cy = s.y + s.h * 0.68;
  pen.circle(cx, cy, 2.4, { w: 0.18, c: DND.ink });
  diamond(pen, cx, cy, 1.3, s.on);
};

DRAW['dnd-training'] = (pen, s) => {
  dndFrame(pen, s, { rule: true });
  const x = s.x + 0.9, w = s.w - 1.8;
  pen.text('ARMOR', x, s.y + 4.1, { size: 0.74, style: 'bold', c: DND.ink });
  pen.text('TRAINING', x, s.y + 5.05, { size: 0.74, style: 'bold', c: DND.ink });
  const ax0 = s.x + 7.8, pitch = (s.x + s.w - 0.8 - ax0) / 4;
  s.armor.forEach((a, i) => {
    const ax = ax0 + i * pitch;
    diamond(pen, ax + 0.5, s.y + 4.25, 0.5, a.on);
    pen.text(a.label, ax + 1.3, s.y + 4.65, { size: 0.92, c: DND.ink, maxW: pitch - 1.4 });
  });
  pen.line(s.x + 0.6, s.y + 5.7, s.x + s.w - 0.6, s.y + 5.7, { w: 0.08, c: DND.ink });
  const block = (label, lines, top, bottom) => {
    gridPaper(pen, s.x + 0.5, top, s.w - 1.0, bottom - top);
    pen.text(label, x, top + 1.25, { size: 0.74, style: 'bold', c: DND.ink });
    lines.forEach((ln, i) => pen.text(ln, x + 0.2, top + 2.9 + i * 1.6, { size: 1.1, c: DND.ink, maxW: w - 0.4 }));
  };
  block('WEAPONS', s.weapons.lines, s.y + 5.8, s.y + 15.4);
  pen.line(s.x + 0.6, s.y + 15.4, s.x + s.w - 0.6, s.y + 15.4, { w: 0.08, c: DND.ink });
  block('TOOLS', s.tools.lines, s.y + 15.5, s.y + s.h - 0.6);
};

function tableColumns(cols, x, w) {
  const total = cols.reduce((n, [, cw]) => n + cw, 0);
  let at = x;
  return cols.map(([label, cw]) => { const col = { label, x: at, w: (cw / total) * w }; at += col.w; return col; });
}

DRAW['dnd-table'] = (pen, s) => {
  dndFrame(pen, s, { rule: true });
  const cols = tableColumns(s.cols, s.x + 0.9, s.w - 1.8), top = s.y + 4.9, rowH = (s.h - 5.7) / s.count;
  cols.forEach((col) => {
    pen.text(col.label, col.x + 0.3, s.y + 4.15, { size: 0.8, c: DND.ink, maxW: col.w - 0.6 });
    pen.line(col.x + 0.3, s.y + 4.45, col.x + Math.min(col.w - 0.4, textWidth(col.label, 0.8) + 0.4), s.y + 4.45, { w: 0.06, c: DND.ink });
  });
  cols.slice(1).forEach((col) => pen.line(col.x, s.y + 3.1, col.x, top + s.count * rowH, { w: 0.06, c: DND.faint }));
  for (let r = 0; r < s.count; r++) {
    const ry = top + r * rowH;
    pen.line(s.x + 0.9, ry + rowH, s.x + s.w - 0.9, ry + rowH, { w: 0.07, c: DND.faint });
    (s.rows[r] || []).forEach((v, i) => pen.text(v, cols[i].x + 0.4, ry + rowH * 0.68, { size: 1.1, c: DND.ink, maxW: cols[i].w - 0.8 }));
  }
};

DRAW['dnd-text'] = (pen, s) => {
  dndFrame(pen, s, { rule: true });
  const footerH = s.footer ? (s.footer.kind === 'attune' ? 8.6 : 3.6) : 0;
  gridPaper(pen, s.x + 0.5, s.y + 2.75, s.w - 1.0, s.h - 3.4 - footerH);
  const cols = s.columns || 1, cw = (s.w - 1.6) / cols, per = s.rows || s.text.cap;
  if (cols > 1) pen.line(s.x + s.w / 2, s.y + 3.2, s.x + s.w / 2, s.y + s.h - 0.8 - footerH, { w: 0.1, c: DND.ink });
  s.text.lines.forEach((ln, i) => {
    const col = Math.floor(i / per), row = i % per;
    pen.text(ln, s.x + 1.1 + col * cw, s.y + DND_TEXT.top + row * DND_TEXT.line, { size: DND_TEXT.size, c: DND.ink, maxW: cw - 0.9, style: ln === '(continued on a later page)' ? 'italic' : 'normal' });
  });
  if (!s.footer) return;
  const fy = s.y + s.h - footerH;
  pen.line(s.x + 0.6, fy, s.x + s.w - 0.6, fy, { w: 0.08, c: DND.ink });
  if (s.footer.kind === 'line') {
    pen.text(s.footer.label, s.x + 1.1, fy + 2.4, { size: 0.9, c: DND.ink });
    pen.text(s.footer.value || '', s.x + 7.8, fy + 2.4, { size: 1.12, style: 'bold', c: DND.ink, maxW: s.w - 8.8 });
    pen.line(s.x + 7.4, fy + 2.8, s.x + s.w - 1.0, fy + 2.8, { w: 0.07, c: DND.ink });
    return;
  }
  pen.text(s.footer.label, s.x + 1.1, fy + 1.9, { size: 0.9, c: DND.ink });
  for (let i = 0; i < 3; i++) {
    const ly = fy + 3.75 + i * 1.95;
    diamond(pen, s.x + 1.8, ly - 0.4, 0.5, !!s.footer.values[i]);
    pen.line(s.x + 2.8, ly + 0.3, s.x + s.w - 1.0, ly + 0.3, { w: 0.07, c: DND.ink });
    pen.text(s.footer.values[i] || '', s.x + 3.0, ly, { size: 1.05, c: DND.ink, maxW: s.w - 4.4 });
  }
};

DRAW['dnd-spellcasting'] = (pen, s) => {
  dndFrame(pen, s, { title: '' });
  pen.text(s.ability, s.x + 1.0, s.y + 2.7, { size: 1.3, style: 'bold', c: DND.ink, maxW: s.w - 2 });
  pen.line(s.x + 0.6, s.y + 3.25, s.x + s.w - 0.6, s.y + 3.25, { w: 0.08, c: DND.ink });
  pen.text('SPELLCASTING ABILITY', s.x + 1.0, s.y + 4.25, { size: 0.72, style: 'bold', c: DND.ink });
  const top0 = s.y + 5.0, rowH = (s.h - 5.0) / 3, boxW = 5.6;
  pen.line(s.x + 0.4, top0, s.x + s.w - 0.4, top0, { w: 0.14, c: DND.ink });
  s.rows.forEach(([l1, l2, value], i) => {
    const top = top0 + i * rowH;
    if (i) pen.line(s.x + 0.4, top, s.x + s.w - 0.4, top, { w: 0.1, c: DND.ink });
    pen.line(s.x + boxW, top, s.x + boxW, top + rowH, { w: 0.1, c: DND.ink });
    pen.text(value, s.x + boxW / 2, top + rowH * 0.66, { size: 2.0, style: 'bold', align: 'center', c: DND.ink });
    pen.text(l1.toUpperCase(), s.x + boxW + 0.9, top + rowH * (l2 ? 0.45 : 0.6), { size: 0.86, style: 'bold', c: DND.ink, maxW: s.w - boxW - 1.4 });
    if (l2) pen.text(l2.toUpperCase(), s.x + boxW + 0.9, top + rowH * 0.45 + 1.1, { size: 0.86, style: 'bold', c: DND.ink });
  });
};

DRAW['dnd-banner'] = (pen, s) => {
  const { x, y, w, h } = s, m = y + h / 2;
  pen.poly([[x + 2.2, y], [x + w - 2.2, y], [x + w, m], [x + w - 2.2, y + h], [x + 2.2, y + h], [x, m]], { w: 0.22, c: DND.ink, fill: DND.paper });
  pen.poly([[x + 2.7, y + 0.5], [x + w - 2.7, y + 0.5], [x + w - 0.8, m], [x + w - 2.7, y + h - 0.5], [x + 2.7, y + h - 0.5], [x + 0.8, m]], { w: 0.08, c: DND.ink });
  pen.text(str(s.name).toUpperCase(), x + w / 2, y + (s.line ? h * 0.47 : h * 0.62), { size: 1.4, style: 'bold', align: 'center', c: DND.ink, spacing: 0.1, maxW: w - 7 });
  if (s.line) pen.text(s.line, x + w / 2, y + h * 0.78, { size: 0.86, align: 'center', c: DND.soft, maxW: w - 7 });
};

DRAW['dnd-slots'] = (pen, s) => {
  dndFrame(pen, s, { rule: true });
  const cw = (s.w - 1.8) / 3, pitch = Math.min(1.5, cw * 0.32 / 4);
  for (let col = 0; col < 3; col++) {
    const cx = s.x + 0.9 + col * cw, totalX = cx + cw * 0.5, diaX = cx + cw * 0.69;
    if (col) pen.line(cx, s.y + 3.0, cx, s.y + s.h - 0.7, { w: 0.08, c: DND.faint });
    pen.text('Total', totalX, s.y + 4.0, { size: 0.64, align: 'center', c: DND.ink });
    pen.text('Expended', diaX + pitch * 1.5, s.y + 4.0, { size: 0.64, align: 'center', c: DND.ink });
    for (let row = 0; row < 3; row++) {
      const slot = s.slots[col * 3 + row], base = s.y + 6.6 + row * ((s.h - 7.6) / 2.6);
      pen.text(`LEVEL ${slot.level}`, cx + 0.4, base, { size: 0.76, style: 'bold', c: DND.ink });
      pen.line(totalX - 1.2, base + 0.3, totalX + 1.2, base + 0.3, { w: 0.08, c: DND.ink });
      pen.text(slot.max || '', totalX, base, { size: 1.05, style: 'bold', align: 'center', c: DND.ink });
      const count = Math.max(SLOT_DIAMONDS[slot.level - 1], slot.max);
      const slotAria = sliderAria({ label: `Level ${slot.level} spell slots expended`, value: slot.used, max: slot.max || count, text: `${slot.used} of ${slot.max || count} used` });
      pen.group(slot.live ? { cls: 'track', data: { track: slot.path, mode: 'fill' }, aria: slotAria } : {}, () => {
        for (let k = 0; k < count; k++) diamond(pen, diaX + k * pitch, base - 0.4, Math.min(0.55, pitch * 0.4), k < slot.used, slot.live ? { cls: 'track-box', data: { box: k } } : {});
      });
    }
  }
};

DRAW['dnd-spells'] = (pen, s) => {
  dndFrame(pen, s, { rule: true });
  const cols = tableColumns([['Level', 6], ['Name', 30], ['Casting Time', 11], ['Range', 11], ['crm', 15], ['Notes', 27]], s.x + 0.9, s.w - 1.8);
  const top = s.y + 6.0, rowH = (s.h - 6.8) / s.count;
  cols.forEach((col) => {
    if (col.label === 'crm') {
      pen.text('Concentration, Ritual,', col.x + 0.3, s.y + 4.15, { size: 0.62, c: DND.ink, maxW: col.w - 0.4 });
      pen.text('& Required Material', col.x + 0.3, s.y + 5.1, { size: 0.62, c: DND.ink, maxW: col.w - 0.4 });
      return;
    }
    const two = col.label === 'Casting Time';
    if (two) { pen.text('Casting', col.x + 0.4, s.y + 4.15, { size: 0.76, c: DND.ink }); pen.text('Time', col.x + 0.4, s.y + 5.1, { size: 0.76, c: DND.ink }); }
    else pen.text(col.label, col.x + 0.4, s.y + 5.1, { size: 0.76, c: DND.ink });
    pen.line(col.x + 0.4, s.y + 5.4, col.x + Math.min(col.w - 0.4, textWidth(two ? 'Casting' : col.label, 0.76) + 0.8), s.y + 5.4, { w: 0.06, c: DND.ink });
  });
  cols.slice(1).forEach((col) => pen.line(col.x, s.y + 3.1, col.x, top + s.count * rowH, { w: 0.06, c: DND.faint }));
  const crm = cols[4];
  for (let r = 0; r < s.count; r++) {
    const ry = top + r * rowH, base = ry + rowH * 0.7, row = s.rows[r];
    pen.line(s.x + 0.9, ry + rowH, s.x + s.w - 0.9, ry + rowH, { w: 0.07, c: DND.faint });
    ['C', 'R', 'M'].forEach((letter, k) => {
      const dx = crm.x + 0.9 + k * (crm.w - 0.8) / 3;
      diamond(pen, dx, base - 0.4, 0.46, !!row?.[letter.toLowerCase()]);
      pen.text(letter, dx + 0.7, base, { size: 0.76, c: DND.ink });
    });
    if (!row) continue;
    [[0, row.level], [1, row.name], [2, row.time], [3, row.range], [5, row.note]].forEach(([i, v]) => pen.text(v, cols[i].x + 0.4, base, { size: 1.08, c: DND.ink, maxW: cols[i].w - 0.8 }));
  }
};

DRAW['dnd-coins'] = (pen, s) => {
  dndFrame(pen, s, { rule: true });
  const bw = (s.w - 1.8 - 4 * 0.7) / 5, bh = s.h - 4.0;
  s.coins.forEach(([label, value], i) => {
    const bx = s.x + 0.9 + i * (bw + 0.7);
    pen.poly(chamfer(bx, s.y + 3.1, bw, bh, 0.5), { w: 0.12, c: DND.ink });
    pen.text(label, bx + bw / 2, s.y + 4.3, { size: 0.8, style: 'bold', align: 'center', c: DND.ink });
    pen.text(value, bx + bw / 2, s.y + 3.1 + bh * 0.78, { size: 1.25, style: 'bold', align: 'center', c: DND.ink, maxW: bw - 0.5 });
  });
};

// ======================================================================
// Vampire: The Masquerade V5 (portrait, two pages)
// ======================================================================
// Positions are measured from Renegade's free fillable V5 sheet (US Letter, in
// page units): the same boxes, rows and columns, hairline grids on a cream
// page inside a thin double frame with clipped corners. It is drawn from
// primitives in the standard PDF fonts (Times for Cormorant and Bodoni,
// Helvetica for Gill Sans, at about 92% because Times sets larger); the logo
// and Renegade's typefaces are not copied, and the title is plain text.

const V5 = { ink: '#141414', red: '#751016', off: '#ddd2c6', paper: '#faf3e9' };
export const V5_ATTRS = [['Physical', ['strength', 'dexterity', 'stamina']], ['Social', ['charisma', 'manipulation', 'composure']], ['Mental', ['intelligence', 'wits', 'resolve']]];
export const V5_SKILLS = [['Physical', ['Athletics', 'Brawl', 'Craft', 'Drive', 'Firearms', 'Larceny', 'Melee', 'Stealth', 'Survival']],
  ['Social', ['Animal Ken', 'Etiquette', 'Insight', 'Intimidation', 'Leadership', 'Performance', 'Persuasion', 'Streetwise', 'Subterfuge']],
  ['Mental', ['Academics', 'Awareness', 'Finance', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science', 'Technology']]];
const V5_TEXT = { size: 1.2, line: 1.85 };
const V5_HAIR = 0.06; // the sheet's grid lines are hairlines
const V5_COLS = [9.7, 36.57, 63.43, 90.3]; // page 1's three columns
// wrapped lines that fit a box of height h whose first baseline is `first` below its top
const v5rows = (h, first) => Math.max(0, Math.floor((h - 0.6 - first) / V5_TEXT.line) + 1);

function vtm(d, name) {
  const cont = [];
  const a = d.attributes || {}, sk = d.skills || {};
  const sec = (kind, title, x, y, w, h, props = {}) => ({ kind, title, x, y, w, h, ...props });
  const spec = (s) => (d.specialties || []).filter((x) => x.skill === s).map((x) => x.name).join(', ');
  const health = num(a.stamina, 1) + 3, wp = num(a.composure, 1) + num(a.resolve, 1);
  const list = d.disciplines || [];
  for (const x of list) {
    const text = (x.powers || []).map((p) => `${p.name} (level ${p.level})${p.desc ? `\n${p.desc}` : ''}`).join('\n\n');
    if (text && ((x.powers || []).some((p) => p.desc) || (x.powers || []).length > 5 || list.indexOf(x) >= 6)) cont.push({ title: `${x.name} ${x.rating}`, text });
  }
  const disciplines = Array.from({ length: 6 }, (_, i) => (list[i] ? { name: list[i].name, rating: num(list[i].rating), powers: (list[i].powers || []).slice(0, 5).map((p) => p.name), path: `disciplines.${i}.rating` } : null));
  const touch = (d.convictions || []).map((cv, i) => `${cv}${d.touchstones?.[i]?.name ? ` — ${d.touchstones[i].name}` : ''}`)
    .concat((d.touchstones || []).slice((d.convictions || []).length).map((t) => t.name)).join('\n');
  const advantages = d.advantages || [];
  const advRows = advantages.filter((x) => !x.flaw).concat(advantages.filter((x) => x.flaw)).map((x) => ({ name: x.flaw ? `${x.name} (flaw)` : x.name, dots: Math.max(0, Math.min(5, num(x.dots))) }));
  if (advRows.length > 11) cont.push({ title: 'All advantages & flaws', text: advRows.map((x) => `${x.name} ${'•'.repeat(x.dots)}`).join('\n') });
  for (const x of advantages.filter((y) => y.desc)) cont.push({ title: `${x.flaw ? 'Flaw' : 'Advantage'} · ${x.name}`, text: x.desc });
  for (const t of (d.touchstones || []).filter((y) => y.desc || y.conviction)) cont.push({ title: `Touchstone · ${t.name}`, text: [t.conviction, t.desc].filter(Boolean).join('\n') });
  const box = (value, w, h, first, title) => area(value, w - 1.4, v5rows(h, first), V5_TEXT.size, 'serif', cont, title);

  const page1 = [
    sec('v5-header', '', 9.7, 14.9, 80.6, 11.2, { fields: [['Name', name], ['Concept', d.concept], ['Predator', d.predatorType], ['Chronicle', d.chronicle], ['Ambition', d.ambition], ['Clan', d.clan], ['Sire', d.sire], ['Desire', d.desire], ['Generation', d.generation ? `${d.generation}th` : '']] }),
    sec('v5-attrs', 'Attributes', 9.7, 26.4, 80.6, 15.4, { cols: V5_ATTRS.map(([head, keys]) => ({ head, rows: keys.map((k) => ({ label: cap(k), value: num(a[k], 1), path: `attributes.${k}` })) })) }),
    sec('v5-tracks', 'Health and willpower', 9.7, 42.0, 80.6, 4.2, { tracks: [
      { label: 'Health', max: health, sup: num(d.health?.superficial), agg: num(d.health?.aggravated), path: 'health', at: 38.95 },
      { label: 'Willpower', max: wp, sup: num(d.willpower?.superficial), agg: num(d.willpower?.aggravated), path: 'willpower', at: 60.7 },
    ] }),
    sec('v5-skills', 'Skills', 9.7, 46.4, 80.6, 35.0, { cols: V5_SKILLS.map(([, names]) => names.map((s) => ({ label: s, spec: spec(s), value: num(sk[s]), path: `skills.${s}` }))) }),
    sec('v5-disciplines', 'Disciplines', 9.7, 81.4, 80.6, 36.6, { cells: disciplines }),
    sec('v5-bottom', 'Resonance, hunger and humanity', 9.7, 119.0, 80.6, 3.0, { resonance: d.resonance, hunger: num(d.hunger), humanity: num(d.humanity, 7) }),
  ];
  const trio = [9.7, 36.8, 63.8, 90.3], trioW = (i) => trio[i + 1] - trio[i];
  const page2 = [
    sec('v5-trio', 'Tenets, touchstones and bane', 9.7, 12.0, 80.6, 25.7, { edges: trio, cells: [
      ['Chronicle Tenets', box(d.tenets, trioW(0), 22.2, 2.4, 'Chronicle tenets')],
      ['Touchstones & Convictions', box(touch, trioW(1), 22.2, 2.4, 'Touchstones & convictions')],
      ['Clan Bane', box(d.bane, trioW(2), 22.2, 2.4, 'Clan bane')],
    ] }),
    sec('v5-advantages', 'Advantages & flaws', 9.7, 38.2, 39.4, 44.0, { rows: advRows.slice(0, 11), count: 11 }),
    sec('v5-notes', 'Notes', 9.7, 83.8, 39.4, 36.6, { text: box(d.notes, 39.4, 36.6, 3.6, 'Notes') }),
    sec('v5-divider', '', 49.6, 41.5, 0.8, 78.9),
    sec('v5-potency', 'Blood potency', 50.9, 38.2, 39.4, 22.7, {
      value: num(d.bloodPotency, 1), path: 'bloodPotency',
      fields: [['Blood Surge', d.bloodSurge], ['Mend Amount', d.mendAmount], ['Power Bonus', d.powerBonus], ['Rouse Re-Roll', d.rouseReroll], ['Feeding Penalty', d.feedingPenalty], ['Bane Severity', d.baneSeverity]],
    }),
    sec('v5-xp', 'Experience', 50.9, 62.4, 39.4, 7.6, { total: d.xp?.total ?? 0, spent: d.xp?.spent ?? 0 }),
    sec('v5-table', 'Ages, appearance and history', 50.9, 71.2, 39.4, 49.2, { rows: [
      { label: 'True age', h: 3.2, value: d.trueAge }, { label: 'Apparent age', h: 3.25, value: d.apparentAge },
      { label: 'Date of birth', h: 3.2, value: d.dateOfBirth }, { label: 'Date of death', h: 3.2, value: d.dateOfDeath },
      { label: 'Appearance', h: 6.5, text: box(d.appearance, 39.4, 6.5, 3.95, 'Appearance') },
      { label: 'Distinguishing features', h: 6.5, text: box(d.features, 39.4, 6.5, 3.95, 'Distinguishing features') },
      { label: 'History', h: 23.35, text: box(d.history, 39.4, 23.35, 3.95, 'History') },
    ] }),
  ];
  return { system: 'vtm5', size: PORTRAIT, font: 'serif', pages: [page1, page2], continuations: cont, notice: NOTICES.vtm5, paper: V5.paper, frame: v5Frame };
}

// ---- V5 drawing ----

/** The double frame with clipped corners, broken where the title sits. */
function v5Frame(pen, pageIndex) {
  pen.poly(chamfer(6.67, 6.8, 86.66, 116.04, 1.96), { w: 0.055, c: V5.red });
  pen.poly(chamfer(6.94, 7.07, 86.12, 115.5, 1.89), { w: 0.055, c: V5.red });
  const title = 'Vampire: The Masquerade';
  if (pageIndex === 0) {
    pen.rect(36.9, 5.7, 26.1, 8.6, { stroke: false, fill: V5.paper });
    pen.text(title, 50, 10.6, { size: 2.6, font: 'serif', style: 'italic', align: 'center', c: V5.ink });
  } else {
    const w = textWidth(title, 1.9, 'serif', 'italic');
    pen.rect(9.7, 6.0, w + 1.0, 5.6, { stroke: false, fill: V5.paper });
    pen.text(title, 10.2, 9.2, { size: 1.9, font: 'serif', style: 'italic', c: V5.ink });
  }
}
function v5Heading(pen, title, x, base, w) {
  pen.text(title.toUpperCase(), x + w / 2, base, { size: 1.7, style: 'bold', font: 'serif', align: 'center', c: V5.red, spacing: 0.2 });
  pen.line(x, base + 1.0, x + w, base + 1.0, { w: 0.12, c: V5.red });
}
const v5DotsWidth = (max, { r = 0.6, step = 1.58, gap = 0.7 } = {}) => (max - 1) * step + 2 * r + Math.floor((max - 1) / 5) * gap;
function v5Dots(pen, x, base, value, max, path, label = '', { r = 0.6, step = 1.58, gap = 0.7 } = {}) {
  pen.group(path ? { cls: 'dots', data: { dots: path }, aria: sliderAria({ label, value, max }) } : {}, () => {
    for (let i = 0; i < max; i++) {
      pen.circle(x + r + i * step + Math.floor(i / 5) * gap, base - 0.45, r, { w: 0.1, c: V5.ink, fill: i < value ? V5.ink : V5.paper, ...(path ? { cls: 'dot-p', data: { dot: i + 1 } } : {}) });
    }
  });
}
const V5_BOX = { size: 1.25, pitch: 1.67, gap: 1.67 };
const boxesWidth = (count) => (count - 1) * V5_BOX.pitch + V5_BOX.size + Math.floor((count - 1) / 5) * V5_BOX.gap;
function v5Boxes(pen, x, top, count, opts) {
  const { max = count, filled = 0, sup = 0, agg = 0, path, mode, label = '' } = opts, { size, pitch, gap } = V5_BOX;
  const aria = mode === 'fill' ? sliderAria({ label, value: filled, max }) : damageAria({ label, max, sup, agg });
  pen.group(path ? { cls: 'track', data: { track: path, ...(mode ? { mode } : {}) }, aria } : {}, () => {
    for (let i = 0; i < count; i++) {
      const bx = x + i * pitch + Math.floor(i / 5) * gap, live = i < max;
      pen.rect(bx, top, size, size, { w: 0.1, c: V5.ink, fill: !live ? V5.off : i < filled ? V5.ink : V5.paper, ...(path && live ? { cls: 'track-box', data: { box: i } } : {}) });
      const state = i < agg ? 2 : i < agg + sup ? 1 : 0;
      if (state) pen.line(bx + 0.22, top + size - 0.22, bx + size - 0.22, top + 0.22, { w: 0.14, c: V5.ink });
      if (state === 2) pen.line(bx + 0.22, top + 0.22, bx + size - 0.22, top + size - 0.22, { w: 0.14, c: V5.ink });
    }
  });
}
function v5Leader(pen, x1, x2, y) {
  if (x2 > x1) pen.line(x1, y, x2, y, { w: 0.08, c: V5.ink, dash: [0.08, 0.25] });
}
function v5Lines(pen, x, top, w, text, first = 2.4) {
  text.lines.forEach((ln, r) => {
    if (ln) pen.text(ln, x + 0.7, top + first + r * V5_TEXT.line, { size: V5_TEXT.size, font: 'serif', c: V5.ink, maxW: w - 1.4, style: ln === '(continued on a later page)' ? 'italic' : 'normal' });
  });
}
const v5Label = (pen, label, x, base, size = 1.35) => pen.text(label, x, base, { size, font: 'serif', c: V5.ink });
const v5Red = (pen, label, x, base, o = {}) => pen.text(label, x, base, { size: 1.38, style: 'bold', c: V5.red, ...o });

DRAW['v5-header'] = (pen, s) => {
  const rowH = s.h / 3, colW = s.w / 3;
  pen.rect(s.x, s.y, s.w, s.h, { w: V5_HAIR, c: V5.ink });
  for (let i = 1; i < 3; i++) { pen.line(s.x, s.y + i * rowH, s.x + s.w, s.y + i * rowH, { w: V5_HAIR, c: V5.ink }); pen.line(s.x + i * colW, s.y, s.x + i * colW, s.y + s.h, { w: V5_HAIR, c: V5.ink }); }
  s.fields.forEach(([label, value], i) => {
    const cx = s.x + (i % 3) * colW, base = s.y + Math.floor(i / 3) * rowH + 2.3;
    v5Label(pen, label, cx + 0.7, base);
    const lw = textWidth(label, 1.35, 'serif') + 1.3;
    pen.text(value, cx + 0.7 + lw, base, { size: 1.35, font: 'serif', c: V5.ink, maxW: colW - lw - 1.4 });
  });
};

DRAW['v5-attrs'] = (pen, s) => {
  v5Heading(pen, s.title, s.x, s.y + 2.2, s.w);
  s.cols.forEach((col, i) => {
    const cx = V5_COLS[i];
    if (i) pen.line(cx, s.y + 5.4, cx, s.y + 15.1, { w: V5_HAIR, c: V5.ink });
    pen.text(col.head, cx + (V5_COLS[i + 1] - cx) / 2, s.y + 5.4, { size: 1.6, font: 'serif', style: 'italic', align: 'center', c: V5.ink });
    col.rows.forEach((row, r) => {
      const base = s.y + 7.7 + r * 3.25;
      pen.text(row.label, cx + 6.75, base, { size: 1.95, font: 'serif', align: 'center', c: V5.ink });
      v5Dots(pen, cx + 16.1, base, row.value, 5, row.path, row.label);
    });
  });
};

DRAW['v5-tracks'] = (pen, s) => {
  for (const t of s.tracks) {
    const count = Math.max(10, t.max), w = boxesWidth(count);
    v5Red(pen, t.label, t.at, s.y + 1.7, { align: 'center' });
    v5Boxes(pen, t.at - w / 2, s.y + 2.55, count, { max: t.max, sup: t.sup, agg: t.agg, path: t.path, label: t.label });
  }
};

const V5_SKILL_X = [[9.7, 27.7], [36.8, 54.9], [64.2, 82.2]]; // label and dots, per column
DRAW['v5-skills'] = (pen, s) => {
  v5Heading(pen, s.title, s.x, s.y + 2.3, s.w);
  s.cols.forEach((rows, i) => rows.forEach((row, r) => {
    const [lx0, dotsX] = V5_SKILL_X[i], base = s.y + 6.7 + r * 3.3875;
    v5Label(pen, row.label, lx0, base);
    const lx = lx0 + 0.3 + textWidth(row.label, 1.35, 'serif');
    v5Leader(pen, lx, dotsX - 0.9, base + 0.1);
    if (row.spec) pen.text(row.spec, lx + 0.4, base - 0.25, { size: 1.05, font: 'serif', style: 'italic', c: V5.red, maxW: dotsX - lx - 1.4 });
    v5Dots(pen, dotsX, base, row.value, 5, row.path, row.label);
  }));
};

DRAW['v5-disciplines'] = (pen, s) => {
  v5Heading(pen, s.title, s.x, s.y + 2.1, s.w);
  const top = s.y + 3.1, rh = 2.78;
  for (let k = 1; k <= 12; k++) pen.line(s.x, top + k * rh, s.x + s.w, top + k * rh, { w: V5_HAIR, c: V5.ink });
  for (const cx of V5_COLS) pen.line(cx, top, cx, top + 12 * rh, { w: V5_HAIR, c: V5.ink });
  s.cells.forEach((cell, i) => {
    const cx = V5_COLS[i % 3], cw = V5_COLS[i % 3 + 1] - cx, cy = top + Math.floor(i / 3) * 6 * rh;
    if (cell) pen.text(cell.name, cx + 0.7, cy + 1.95, { size: 1.3, font: 'serif', style: 'bold', c: V5.ink, maxW: 16.9 });
    v5Dots(pen, cx + 18.3, cy + 1.95, cell?.rating || 0, 5, cell?.path, cell ? `${cell.name} rating` : '');
    for (let k = 0; k < 5; k++) if (cell?.powers[k]) pen.text(cell.powers[k], cx + 0.7, cy + (k + 1) * rh + 1.95, { size: 1.2, font: 'serif', c: V5.ink, maxW: cw - 1.4 });
  });
};

DRAW['v5-bottom'] = (pen, s) => {
  const base = s.y + 2.2;
  v5Red(pen, 'Resonance', s.x, base);
  const lx = s.x + textWidth('Resonance', 1.38, 'sans', 'bold') + 0.4;
  v5Leader(pen, lx, 36.6, base + 0.2);
  pen.text(s.resonance || '', lx + 0.5, base - 0.1, { size: 1.35, font: 'serif', c: V5.ink, maxW: 36.6 - lx - 0.6 });
  v5Red(pen, 'Hunger', 42.7, base);
  v5Boxes(pen, 48.4, base - 1.25, 5, { filled: s.hunger, path: 'hunger', mode: 'fill', label: 'Hunger' });
  v5Red(pen, 'Humanity', 64.1, base);
  v5Boxes(pen, 71.4, base - 1.25, 10, { filled: s.humanity, path: 'humanity', mode: 'fill', label: 'Humanity' });
};

DRAW['v5-trio'] = (pen, s) => {
  const top = s.y + 3.5, bottom = s.y + s.h;
  pen.rect(s.x, top, s.w, bottom - top, { w: V5_HAIR, c: V5.ink });
  s.cells.forEach(([title, text], i) => {
    const x = s.edges[i], w = s.edges[i + 1] - x;
    if (i) pen.line(x, top, x, bottom, { w: V5_HAIR, c: V5.ink });
    pen.text(title, x + w / 2, s.y + 2.6, { size: 1.72, font: 'serif', align: 'center', c: V5.red });
    v5Lines(pen, x, top, w, text);
  });
};

DRAW['v5-advantages'] = (pen, s) => {
  const top = s.y + 3.3, rh = 3.7;
  v5Red(pen, 'Advantages & Flaws', s.x + s.w / 2, s.y + 2.3, { size: 1.65, align: 'center' });
  pen.line(s.x, top, s.x + s.w, top, { w: 0.1, c: V5.ink });
  for (let r = 1; r <= s.count; r++) pen.line(s.x, top + r * rh, s.x + s.w, top + r * rh, { w: V5_HAIR, c: V5.ink });
  for (const x of [s.x, s.x + s.w]) pen.line(x, top, x, top + s.count * rh, { w: V5_HAIR, c: V5.ink });
  for (let r = 0; r < s.count; r++) {
    const base = top + r * rh + 2.5, row = s.rows[r];
    if (row) pen.text(row.name, s.x + 0.7, base, { size: 1.3, font: 'serif', c: V5.ink, maxW: 29.4 });
    v5Dots(pen, s.x + 30.8, base, row?.dots || 0, 5, null);
  }
};

DRAW['v5-notes'] = (pen, s) => {
  pen.rect(s.x, s.y, s.w, s.h, { w: V5_HAIR, c: V5.ink });
  v5Label(pen, 'Notes', s.x + 0.7, s.y + 1.7, 1.05);
  v5Lines(pen, s.x, s.y, s.w, s.text, 3.6);
};

DRAW['v5-divider'] = (pen, s) => pen.line(s.x + s.w / 2, s.y, s.x + s.w / 2, s.y + s.h, { w: V5_HAIR, c: V5.ink });

DRAW['v5-potency'] = (pen, s) => {
  const tw = textWidth('Blood Potency', 1.65, 'sans', 'bold'), dw = v5DotsWidth(10), x0 = s.x + (s.w - tw - 1.6 - dw) / 2;
  v5Red(pen, 'Blood Potency', x0, s.y + 2.3, { size: 1.65 });
  v5Dots(pen, x0 + tw + 1.6, s.y + 2.5, s.value, 10, s.path, 'Blood potency');
  const top = s.y + 3.3, rows = [top, top + 6.5, top + 12.9, s.y + s.h], cw = s.w / 2;
  pen.rect(s.x, top, s.w, s.y + s.h - top, { w: V5_HAIR, c: V5.ink });
  pen.line(s.x + cw, top, s.x + cw, s.y + s.h, { w: V5_HAIR, c: V5.ink });
  for (const y of rows.slice(1, 3)) pen.line(s.x, y, s.x + s.w, y, { w: V5_HAIR, c: V5.ink });
  s.fields.forEach(([label, value], i) => {
    const cx = s.x + (i % 2) * cw, cy = rows[Math.floor(i / 2)];
    v5Label(pen, label, cx + 0.7, cy + 2.0);
    pen.text(value ?? '', cx + 0.7, cy + 4.6, { size: 1.35, font: 'serif', c: V5.ink, maxW: cw - 1.4 });
  });
};

DRAW['v5-xp'] = (pen, s) => {
  [['Total Experience', s.total, 2.7], ['Spent Experience', s.spent, 6.6]].forEach(([label, value, dy]) => {
    const base = s.y + dy, lx = s.x + textWidth(label, 1.65, 'sans', 'bold') + 0.4;
    v5Red(pen, label, s.x, base, { size: 1.65 });
    v5Leader(pen, lx, s.x + s.w - 0.3, base + 0.1);
    pen.text(value ?? '', lx + 0.6, base - 0.15, { size: 1.35, font: 'serif', c: V5.ink, maxW: s.x + s.w - lx - 1 });
  });
};

DRAW['v5-table'] = (pen, s) => {
  pen.rect(s.x, s.y, s.w, s.h, { w: V5_HAIR, c: V5.ink });
  let y = s.y;
  for (const row of s.rows) {
    if (y > s.y) pen.line(s.x, y, s.x + s.w, y, { w: V5_HAIR, c: V5.ink });
    v5Label(pen, row.label, s.x + 0.7, y + 2.2);
    if (row.text) v5Lines(pen, s.x, y, s.w, row.text, 3.95);
    else {
      const lw = textWidth(row.label, 1.35, 'serif') + 1.3;
      pen.text(row.value ?? '', s.x + 0.7 + lw, y + 2.2, { size: 1.35, font: 'serif', c: V5.ink, maxW: s.w - lw - 1.4 });
    }
    y += row.h;
  }
};

// ======================================================================
// Call of Cthulhu 7th edition (portrait, two pages)
// ======================================================================

const COC = { ink: '#1b1b1b', soft: '#555555', band: '#d7d7d7', stripe: '#eeeeee', off: '#b9b9b9', faint: '#b5b5b5', paper: '#ffffff' };
// The printed sheet's skill grid: four columns of fifteen rows, in its order.
// Strings are skills (catalog names); [group] rows are blank lines for that
// group's specialisms; null rows are blank lines for anything else.
const COC_GRID = [
  ['Accounting', 'Anthropology', 'Appraise', 'Archaeology', 'Art/Craft', ['Art/Craft'], ['Art/Craft'], 'Charm', 'Climb', 'Credit Rating', 'Cthulhu Mythos', 'Disguise', 'Dodge', 'Drive Auto', 'Electrical Repair'],
  ['Fast Talk', 'Fighting (Brawl)', ['Fighting'], ['Fighting'], 'Firearms (Handgun)', 'Firearms (Rifle/Shotgun)', ['Firearms'], 'First Aid', 'History', 'Intimidate', 'Jump', 'Language (Other)', ['Language'], ['Language'], 'Language (Own)'],
  ['Law', 'Library Use', 'Listen', 'Locksmith', 'Mechanical Repair', 'Medicine', 'Natural World', 'Navigate', 'Occult', 'Operate Heavy Machinery', 'Persuade', 'Pilot', 'Psychology', 'Psychoanalysis', 'Ride'],
  ['Science', ['Science'], ['Science'], 'Sleight of Hand', 'Spot Hidden', 'Stealth', 'Survival', null, 'Swim', 'Throw', 'Track', null, null, null, null],
];
const COC_SHORT = { 'Electrical Repair': 'Elec. Repair', 'Mechanical Repair': 'Mech. Repair', 'Operate Heavy Machinery': 'Op. Hv. Machine' };
const COC_NO_TICK = new Set(['Credit Rating', 'Cthulhu Mythos']);
// a specialism "Group (Name)" fills its group's blank rows
const SPEC_GROUPS = [['Art/Craft', /^art\s*\/\s*craft\b/i], ['Science', /^science\b/i], ['Fighting', /^fighting\b/i], ['Firearms', /^firearms\b/i], ['Language', /^language\b/i], ['Pilot', /^pilot\b/i], ['Survival', /^survival\b/i]];

function cocSkillGrid(d, cont) {
  const bases = d.skillBases || {};
  const baseOf = (n) => { const b = bases[n]; return b == null ? '' : typeof b === 'number' ? `${pad2(b)}%` : b === 'EDU' ? 'EDU' : 'half DEX'; };
  const skills = (d.skills || []).map((s) => ({ name: str(s.name).trim(), value: num(s.value), improve: !!s.improve }));
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  const fixed = new Set(COC_GRID.flat().filter((x) => typeof x === 'string').map((x) => x.toLowerCase()));
  const cell = (label, s, base, tick = true) => ({ label, base, value: s ? s.value : null, improve: !!s?.improve, tick });
  const spare = skills.filter((s) => !fixed.has(s.name.toLowerCase()));
  const groupOf = (s) => SPEC_GROUPS.find(([, re]) => re.test(s.name))?.[0] ?? null;
  const take = (group) => { const i = spare.findIndex((s) => groupOf(s) === group); return i < 0 ? null : spare.splice(i, 1)[0]; };
  const grid = COC_GRID.map((col) => col.map((slot) => {
    if (slot === null) return { blank: true };
    if (Array.isArray(slot)) { const s = take(slot[0]); return s ? cell(s.name, s, '') : { blank: true, group: slot[0] }; }
    const s = byName.get(slot.toLowerCase());
    // an undeveloped generic row ("Art/Craft (05%)") gives its place to the first specialism
    const generic = ['Art/Craft', 'Science', 'Language (Other)', 'Pilot', 'Survival'].includes(slot);
    if (generic && (!s || s.value <= num(bases[slot], 0))) {
      const group = SPEC_GROUPS.find(([g]) => slot.startsWith(g))?.[0];
      const sp = take(group);
      if (sp) return cell(sp.name, sp, '');
    }
    return cell(COC_SHORT[slot] || slot, s, baseOf(slot), !COC_NO_TICK.has(slot));
  }));
  // everything else fills the free rows, the plain blank ones first
  for (const pass of [(c) => c.blank && !c.group, (c) => c.blank]) {
    for (const col of grid) for (let r = 0; r < col.length; r++) {
      if (!spare.length || !pass(col[r])) continue;
      const s = spare.shift();
      col[r] = cell(s.name, s, '');
    }
  }
  if (spare.length) cont.push({ title: 'More skills', text: spare.map((s) => `${s.name}: ${s.value}%`).join('\n') });
  return grid;
}

function coc(d, name) {
  const cont = [];
  const ch = d.characteristics || {};
  const sec = (kind, title, x, y, w, h, props = {}) => ({ kind, title, x, y, w, h, ...props });
  const stat = (k, sub) => ({ label: k, sub, value: num(ch[k]) });
  const skills = d.skills || [];
  const brawl = skills.find((s) => s.name === 'Fighting (Brawl)')?.value ?? 25;
  const db = d.damageBonus && d.damageBonus !== '0' ? d.damageBonus : '';
  const weapons = [{ name: 'Unarmed', skill: brawl, damage: `1D3${db ? ` + ${db}` : ' + DB'}`, range: '—', attacks: '1', ammo: '—', malf: '—' }, ...(d.weapons || [])];
  if (weapons.length > 6) cont.push({ title: 'All weapons', text: d.weapons.map((w) => `${w.name} · ${w.skill}% · ${w.damage} · ${w.range || ''}`).join('\n') });
  const b = d.backstory || {};
  const backLeft = [['Personal Description', b.description], ['Ideology/Beliefs', b.ideology], ['Significant People', b.significantPeople], ['Meaningful Locations', b.meaningfulLocations], ['Treasured Possessions', b.treasuredPossessions], ['Traits', b.traits]];
  const backRight = [['Injuries & Scars', b.injuries], ['Phobias & Manias', b.phobias], ['Arcane Tomes, Spells & Artifacts', b.tomes], ['Encounters with Strange Entities', b.encounters]];
  const leftH = (69 - 3.4) / 6, rightH = (69 - 3.4) / 4, rowsIn = (h) => Math.max(1, Math.floor((h - 2.0) / 2.4));
  const entry = ([title, text], h) => ({ title, text: area(text, 43.4, rowsIn(h), 1.2, 'serif', cont, title) });
  const gear = (d.gear || []).map((g) => (typeof g === 'string' ? g : g?.name)).filter(Boolean);
  const era = /modern/i.test(d.era || '') ? 'Modern era investigator' : '1920s era investigator';

  const page1 = [
    sec('coc-investigator', era, 3, 3, 27.5, 22, { fields: [['Name', name], ['Player', d.player], ['Occupation', d.occupation?.name], ['Age', d.age, 'Sex', d.sex], ['Residence', d.residence], ['Birthplace', d.birthplace]] }),
    sec('coc-chars', 'Characteristics', 31.5, 3, 46, 22, { stats: [stat('STR'), stat('DEX'), stat('POW'), stat('CON'), stat('APP'), stat('EDU'), stat('SIZ'), stat('INT', 'Idea'), { label: 'Move Rate', move: true, value: d.move ?? 8 }] }),
    sec('coc-portrait', '', 78.5, 3, 18.5, 22),
    sec('coc-hp', 'Hit points', 3, 26, 25.5, 13, { max: num(d.hp?.max), current: num(d.hp?.current), majorWound: !!d.majorWound }),
    sec('coc-sanity', 'Sanity', 29.5, 26, 67.5, 11, { start: d.san?.start ?? '', max: num(d.san?.max, 99), current: num(d.san?.current), temp: !!d.tempInsane, indef: !!d.indefInsane }),
    sec('coc-luck', 'Luck', 3, 40, 74, 11, { current: num(d.luck) }),
    sec('coc-mp', 'Magic points', 78, 38, 19, 13, { max: num(d.mp?.max), current: num(d.mp?.current) }),
    sec('coc-skills', 'Investigator skills', 3, 52, 94, 52.6, { grid: cocSkillGrid(d, cont) }),
    sec('coc-weapons', 'Weapons', 3, 105.6, 74, 20.4, { rows: weapons.slice(0, 6).map((w) => { const v = num(w.skill); return [w.name, `${v}%`, Math.floor(v / 2), Math.floor(v / 5), w.damage, w.range, w.attacks ?? '', w.ammo ?? '', w.malf ?? '']; }), count: 6 }),
    sec('coc-combat', 'Combat', 78, 105.6, 19, 20.4, { db: d.damageBonus ?? '0', build: d.build ?? 0, dodge: num(d.dodge) }),
  ];
  const gearRows = Math.floor((31 - 3.6) / 2.4);
  const page2 = [
    sec('coc-backstory', 'Backstory', 3, 3, 94, 69, { left: backLeft.map((e) => entry(e, leftH)), right: backRight.map((e) => entry(e, rightH)), leftH, rightH }),
    sec('coc-lines', 'Gear & possessions', 3, 73, 46, 31, { text: area(gear.join('\n'), 20.4, gearRows * 2, 1.2, 'serif', cont, 'Gear & possessions'), columns: 2, rows: gearRows }),
    sec('coc-cash', 'Cash & assets', 51, 73, 46, 15, { fields: [['Spending Level', d.spendingLevel], ['Cash', d.cash]], assets: area(d.assets, 34, 2, 1.2, 'serif', cont, 'Assets') }),
    sec('coc-fellows', 'Fellow investigators', 51, 89, 46, 15, { rows: (d.fellows || []).slice(0, 8).map((f) => { const [char, player] = str(f).split(/\s+[—-]\s+/); return [char || '', player || '']; }) }),
    sec('coc-lines', 'Notes', 3, 105, 94, 21, { text: area(d.notes, 92, Math.floor((21 - 3.6) / 2.4), 1.2, 'serif', cont, 'Notes'), columns: 1 }),
  ];
  if ((d.fellows || []).length > 8) cont.push({ title: 'Fellow investigators', text: d.fellows.join('\n') });
  return { system: 'coc7', size: PORTRAIT, font: 'serif', pages: [page1, page2], continuations: cont, notice: NOTICES.coc7 };
}

// ---- CoC drawing ----

function cocBand(pen, title, x, y, w, h = 2.6, dark = false) {
  pen.rect(x, y, w, h, { w: 0.15, c: COC.ink, fill: dark ? COC.ink : COC.band });
  pen.text(title.toUpperCase().replace(/(\d0)S\b/, '$1s'), x + w / 2, y + h * 0.74, { size: 1.4, style: 'bold', font: 'serif', align: 'center', c: dark ? '#ffffff' : COC.ink, spacing: 0.14, maxW: w - 1 });
}
function cocFrame(pen, s) { pen.rect(s.x, s.y, s.w, s.h, { w: 0.22, c: COC.ink }); }
// a value box with the half and fifth stacked in a split box beside it
function halfFifth(pen, x, y, w, h, value, { big = 2.0, small = 0.92, sw = w * 0.62 } = {}) {
  pen.rect(x, y, w, h, { w: 0.16, c: COC.ink, fill: COC.paper });
  pen.rect(x + w, y, sw, h, { w: 0.16, c: COC.ink, fill: COC.paper });
  pen.line(x + w, y + h / 2, x + w + sw, y + h / 2, { w: 0.12, c: COC.ink });
  if (value == null || value === '') return;
  const v = num(value);
  pen.text(v, x + w / 2, y + h / 2 + big * 0.36, { size: big, style: 'bold', align: 'center', c: COC.ink });
  pen.text(Math.floor(v / 2), x + w + sw / 2, y + h / 2 - (h / 2 - small * 0.7) / 2, { size: small, align: 'center', c: COC.ink });
  pen.text(Math.floor(v / 5), x + w + sw / 2, y + h - (h / 2 - small * 0.7) / 2, { size: small, align: 'center', c: COC.ink });
}
function pill(pen, x, y, w, h, parts) {
  pen.rect(x, y, w, h, { w: 0.14, c: COC.ink, r: h / 2, fill: COC.paper });
  const pw = w / parts.length;
  parts.forEach(([label, value], i) => {
    if (i) pen.line(x + i * pw, y + 0.2, x + i * pw, y + h - 0.2, { w: 0.1, c: COC.ink });
    const filled = value !== '' && value != null;
    pen.text(filled ? `${label} ${value}` : label, x + i * pw + pw / 2, y + h * 0.7, { size: filled ? 0.95 : 0.85, style: filled ? 'bold' : 'italic', font: 'serif', align: 'center', c: filled ? COC.ink : COC.soft, maxW: pw - 0.6 });
  });
}
function tickBox(pen, x, y, size, on) {
  pen.rect(x, y, size, size, { w: 0.14, c: COC.ink, fill: COC.paper });
  if (on) { pen.line(x + 0.25, y + 0.25, x + size - 0.25, y + size - 0.25, { w: 0.18, c: COC.ink }); pen.line(x + size - 0.25, y + 0.25, x + 0.25, y + size - 0.25, { w: 0.18, c: COC.ink }); }
}
// a numbered track: numbers at fixed cells, the current one circled, those
// above the maximum greyed, each one clickable in the app
function numberTrack(pen, cells, { current, max = Infinity, path, size = 1.0, label = '' }) {
  const top = Math.min(max, Math.max(...cells.map((c) => c.n)));
  pen.group(path ? { cls: 'track', data: { track: path, mode: 'set' }, aria: sliderAria({ label, value: current, max: top }) } : {}, () => {
    for (const { n, x, y } of cells) {
      const live = n <= max;
      if (path && live) pen.rect(x - 1.1, y - 1.05, 2.2, 1.5, { hit: true, cls: 'track-box', data: { box: n, value: n } });
      pen.text(pad2(n), x, y, { size, align: 'center', c: live ? COC.ink : COC.off, style: n === current ? 'bold' : 'normal' });
      if (n === current) pen.circle(x, y - size * 0.34, size * 0.82, { w: 0.18, c: COC.ink });
    }
  });
}
function sideLabel(pen, text, x, y, h, right) {
  pen.text(text.toUpperCase(), x, y + h / 2, { size: 1.05, style: 'bold', font: 'serif', align: 'center', c: COC.ink, angle: right ? -90 : 90, spacing: 0.12 });
}
// the long tracks (Sanity, Luck): a short first row ending at 07, then four
// rows of 23 numbers from 08 to 99
function longTrackCells(x0, x1, firstY, rowGap) {
  const cw = (x1 - x0) / 23, cells = [];
  for (let n = 0; n <= 7; n++) cells.push({ n, x: x0 + (15 + n) * cw + cw / 2, y: firstY });
  for (let n = 8; n <= 99; n++) { const i = n - 8; cells.push({ n, x: x0 + (i % 23) * cw + cw / 2, y: firstY + (Math.floor(i / 23) + 1) * rowGap }); }
  return { cells, labelX: x0 + 15 * cw - 0.4 };
}

DRAW['coc-investigator'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w, 2.6, true);
  s.fields.forEach(([label, value, label2, value2], i) => {
    const base = s.y + 5.7 + i * 3.05, lx = s.x + 0.7;
    const field = (lab, val, x, right) => {
      pen.text(lab, x, base, { size: 1.15, font: 'serif', style: 'bold', c: COC.ink });
      const vx = x + textWidth(lab, 1.15, 'serif', 'bold') + 0.6;
      pen.line(vx, base + 0.35, right, base + 0.35, { w: 0.1, c: COC.ink });
      pen.text(val ?? '', vx + 0.3, base - 0.05, { size: 1.25, font: 'serif', c: COC.ink, maxW: right - vx - 0.4 });
    };
    if (label2) { field(label, value, lx, s.x + s.w * 0.52); field(label2, value2, s.x + s.w * 0.56, s.x + s.w - 0.7); }
    else field(label, value, lx, s.x + s.w - 0.7);
  });
};

DRAW['coc-chars'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const cw = s.w / 3, rh = (s.h - 3.2) / 3;
  s.stats.forEach((st, i) => {
    const cx = s.x + (i % 3) * cw, top = s.y + 3.0 + Math.floor(i / 3) * rh;
    if (st.move) {
      pen.text('Move', cx + 0.8, top + 2.7, { size: 1.15, font: 'serif', style: 'bold', c: COC.ink });
      pen.text('Rate', cx + 0.8, top + 4.0, { size: 1.15, font: 'serif', style: 'bold', c: COC.ink });
      pen.ellipse(cx + 8.6, top + 2.95, 2.9, 2.1, { w: 0.16, c: COC.ink, fill: COC.paper });
      pen.text(st.value, cx + 8.6, top + 3.7, { size: 2.0, style: 'bold', align: 'center', c: COC.ink });
      return;
    }
    pen.text(st.label, cx + 0.8, top + (st.sub ? 3.0 : 3.55), { size: 1.45, font: 'serif', style: 'bold', c: COC.ink });
    if (st.sub) pen.text(st.sub, cx + 1.2, top + 4.25, { size: 0.82, font: 'serif', style: 'italic', c: COC.ink });
    halfFifth(pen, cx + 5.0, top + 0.75, 5.6, 4.5, st.value, { sw: 3.8 });
  });
};

DRAW['coc-portrait'] = (pen, s) => { cocFrame(pen, s); pen.rect(s.x + 0.8, s.y + 0.8, s.w - 1.6, s.h - 1.6, { w: 0.08, c: COC.faint }); };

DRAW['coc-hp'] = (pen, s) => {
  cocFrame(pen, s);
  sideLabel(pen, 'Hit points', s.x + 1.85, s.y, s.h, false);
  pen.line(s.x + 2.7, s.y, s.x + 2.7, s.y + s.h, { w: 0.14, c: COC.ink });
  pen.text('Major', s.x + 3.3, s.y + 1.55, { size: 0.78, font: 'serif', style: 'bold', c: COC.ink });
  pen.text('Wound', s.x + 3.3, s.y + 2.45, { size: 0.78, font: 'serif', style: 'bold', c: COC.ink });
  tickBox(pen, s.x + 6.4, s.y + 0.75, 1.5, s.majorWound);
  pill(pen, s.x + 11.5, s.y + 0.6, 13.2, 2.0, [['Max HP', s.max || '']]);
  const top = Math.max(20, s.max), x0 = s.x + 3.2, cw = (s.w - 3.8) / 5, rows = 2 + Math.ceil((top - 5) / 5), gap = Math.min(1.75, (s.h - 4.3) / rows);
  pen.text('Dying', x0 + cw * 0.95, s.y + 4.3, { size: 0.82, font: 'serif', style: 'italic', align: 'center', c: COC.ink });
  pen.text('Unconscious', x0 + cw * 0.95, s.y + 4.3 + gap, { size: 0.82, font: 'serif', style: 'italic', align: 'center', c: COC.ink });
  const cells = [];
  for (let n = 0; n <= top; n++) {
    const pos = n < 3 ? [n + 2, 0] : n < 6 ? [n - 1, 1] : [(n - 6) % 5, 2 + Math.floor((n - 6) / 5)];
    cells.push({ n, x: x0 + pos[0] * cw + cw / 2, y: s.y + 4.3 + pos[1] * gap });
  }
  numberTrack(pen, cells, { current: s.current, max: s.max || Infinity, path: 'hp.current', size: 1.0, label: 'Hit points' });
};

DRAW['coc-sanity'] = (pen, s) => {
  cocFrame(pen, s);
  sideLabel(pen, 'Sanity', s.x + s.w - 1.85, s.y, s.h, true);
  pen.line(s.x + s.w - 2.7, s.y, s.x + s.w - 2.7, s.y + s.h, { w: 0.14, c: COC.ink });
  const tiny = (t, x, y) => pen.text(t, x, y, { size: 0.78, font: 'serif', style: 'bold', c: COC.ink });
  tiny('Temp.', s.x + 0.7, s.y + 1.45); tiny('Insane', s.x + 0.7, s.y + 2.35); tickBox(pen, s.x + 4.0, s.y + 0.7, 1.5, s.temp);
  tiny('Indef.', s.x + 6.4, s.y + 1.45); tiny('Insane', s.x + 6.4, s.y + 2.35); tickBox(pen, s.x + 9.7, s.y + 0.7, 1.5, s.indef);
  pill(pen, s.x + 12.4, s.y + 0.55, 23, 2.0, [['Start', s.start], ['Max', s.max]]);
  const { cells, labelX } = longTrackCells(s.x + 0.4, s.x + s.w - 3.0, s.y + 2.25, 2.05);
  pen.text('Insane', labelX, s.y + 2.25, { size: 0.82, font: 'serif', style: 'italic', align: 'right', c: COC.ink });
  numberTrack(pen, cells, { current: s.current, max: s.max, path: 'san.current', size: 0.98, label: 'Sanity' });
};

DRAW['coc-luck'] = (pen, s) => {
  cocFrame(pen, s);
  sideLabel(pen, 'Luck', s.x + 1.85, s.y, s.h, false);
  pen.line(s.x + 2.7, s.y, s.x + 2.7, s.y + s.h, { w: 0.14, c: COC.ink });
  const { cells, labelX } = longTrackCells(s.x + 3.0, s.x + s.w - 0.4, s.y + 2.25, 2.05);
  pen.text('Out of Luck', labelX, s.y + 2.25, { size: 0.82, font: 'serif', style: 'italic', align: 'right', c: COC.ink });
  numberTrack(pen, cells, { current: s.current, path: 'luck', size: 0.98, label: 'Luck' });
};

DRAW['coc-mp'] = (pen, s) => {
  cocFrame(pen, s);
  sideLabel(pen, 'Magic points', s.x + s.w - 1.85, s.y, s.h, true);
  pen.line(s.x + s.w - 2.7, s.y, s.x + s.w - 2.7, s.y + s.h, { w: 0.14, c: COC.ink });
  pill(pen, s.x + 1.2, s.y + 0.6, 13.6, 2.0, [['Max MP', s.max || '']]);
  const top = Math.max(24, s.max), x0 = s.x + 0.4, cw = (s.w - 3.4) / 5, rows = Math.ceil((top + 1) / 5), gap = Math.min(1.75, (s.h - 4.3) / rows);
  const cells = [];
  for (let n = 0; n <= top; n++) cells.push({ n, x: x0 + (n % 5) * cw + cw / 2, y: s.y + 4.3 + Math.floor(n / 5) * gap });
  numberTrack(pen, cells, { current: s.current, max: s.max || Infinity, path: 'mp.current', size: 1.0, label: 'Magic points' });
};

DRAW['coc-skills'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const cw = s.w / 4, rh = (s.h - 2.6) / 15, top = s.y + 2.6;
  for (let r = 1; r < 15; r += 2) pen.rect(s.x + 0.11, top + r * rh, s.w - 0.22, rh, { w: 0, stroke: false, fill: COC.stripe });
  s.grid.forEach((col, c) => col.forEach((cell, r) => {
    const x = s.x + c * cw, y = top + r * rh, base = y + rh * 0.66, vx = x + cw - 6.1, lx = x + 2.3;
    if (cell.blank) {
      tickBox(pen, x + 0.6, y + rh / 2 - 0.62, 1.25, false);
      pen.line(lx, base + 0.3, vx - 0.5, base + 0.3, { w: 0.08, c: COC.ink });
    } else {
      if (cell.tick) tickBox(pen, x + 0.6, y + rh / 2 - 0.62, 1.25, cell.improve);
      const label = cell.base ? `${cell.label} (${cell.base})` : cell.label, room = vx - lx - 0.5;
      const size = fitSize(label, room, [1.15, 1.02, 0.92], 'serif');
      pen.text(label, cell.tick ? lx : lx - 0.6, base, { size, font: 'serif', c: COC.ink, maxW: room });
    }
    halfFifth(pen, vx, y + 0.35, 3.4, rh - 0.7, cell.value, { big: 1.3, small: 0.78, sw: 2.3 });
  }));
};

DRAW['coc-weapons'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const cols = tableColumns([['Weapon', 24], ['Regular', 9], ['Hard', 7], ['Extreme', 9], ['Damage', 15], ['Range', 9], ['Attacks', 9], ['Ammo', 8], ['Malf.', 7]], s.x + 0.6, s.w - 1.2);
  cols.forEach((col, i) => pen.text(col.label, i ? col.x + col.w / 2 : col.x + 0.3, s.y + 4.2, { size: 1.0, font: 'serif', style: 'bold', align: i ? 'center' : 'left', c: COC.ink }));
  for (let r = 0; r < s.count; r++) {
    const base = s.y + 6.6 + r * 2.5, row = s.rows[r];
    pen.line(s.x + 0.6, base + 0.45, s.x + s.w - 0.6, base + 0.45, { w: 0.08, c: COC.ink });
    (row || []).forEach((v, i) => pen.text(v, i ? cols[i].x + cols[i].w / 2 : cols[i].x + 0.3, base, { size: 1.1, font: 'serif', align: i ? 'center' : 'left', c: COC.ink, maxW: cols[i].w - 0.5 }));
  }
};

DRAW['coc-combat'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const label = (a, b, y) => { pen.text(a, s.x + 0.8, y, { size: 1.1, font: 'serif', style: 'bold', c: COC.ink }); if (b) pen.text(b, s.x + 0.8, y + 1.25, { size: 1.1, font: 'serif', style: 'bold', c: COC.ink }); };
  label('Damage', 'Bonus', s.y + 5.6);
  pen.ellipse(s.x + 13.4, s.y + 6.0, 4.1, 1.9, { w: 0.16, c: COC.ink, fill: COC.paper });
  pen.text(s.db, s.x + 13.4, s.y + 6.6, { size: 1.6, style: 'bold', align: 'center', c: COC.ink, maxW: 7 });
  label('Build', '', s.y + 11.0);
  pen.ellipse(s.x + 13.4, s.y + 10.6, 4.1, 1.9, { w: 0.16, c: COC.ink, fill: COC.paper });
  pen.text(s.build, s.x + 13.4, s.y + 11.2, { size: 1.6, style: 'bold', align: 'center', c: COC.ink });
  label('Dodge', '', s.y + 16.4);
  halfFifth(pen, s.x + 9.6, s.y + 13.8, 4.6, 4.2, s.dodge, { big: 1.7, small: 0.85, sw: 3.0 });
};

function cocLines(pen, x, w, top, lines, rows, gap = 2.4) {
  for (let r = 0; r < rows; r++) {
    const ly = top + (r + 1) * gap;
    pen.line(x, ly, x + w, ly, { w: 0.08, c: COC.faint });
    if (lines[r]) pen.text(lines[r], x + 0.2, ly - 0.5, { size: 1.2, font: 'serif', c: COC.ink, maxW: w - 0.4, style: lines[r] === '(continued on a later page)' ? 'italic' : 'normal' });
  }
}

DRAW['coc-backstory'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  pen.line(s.x + s.w / 2, s.y + 2.6, s.x + s.w / 2, s.y + s.h, { w: 0.14, c: COC.ink });
  [[s.left, s.leftH, s.x + 1.2], [s.right, s.rightH, s.x + s.w / 2 + 1.2]].forEach(([entries, h, x]) => entries.forEach((e, i) => {
    const top = s.y + 3.2 + i * h;
    pen.text(e.title, x, top + 1.5, { size: 1.15, font: 'serif', style: 'bold', c: COC.ink });
    cocLines(pen, x, s.w / 2 - 2.4, top + 1.6, e.text.lines, e.text.cap);
  }));
};

DRAW['coc-lines'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const cols = s.columns || 1, cw = (s.w - 1.6) / cols, per = s.rows || s.text.cap;
  for (let c = 0; c < cols; c++) cocLines(pen, s.x + 0.8 + c * cw + (c ? 0.6 : 0), cw - 0.8, s.y + 2.9, s.text.lines.slice(c * per, (c + 1) * per), per);
};

DRAW['coc-cash'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const row = (label, value, base) => {
    pen.text(label, s.x + 0.8, base, { size: 1.15, font: 'serif', style: 'bold', c: COC.ink });
    const vx = s.x + 1.4 + textWidth(label, 1.15, 'serif', 'bold');
    pen.line(vx, base + 0.35, s.x + s.w - 0.8, base + 0.35, { w: 0.1, c: COC.ink });
    pen.text(value ?? '', vx + 0.3, base - 0.05, { size: 1.2, font: 'serif', c: COC.ink, maxW: s.x + s.w - vx - 1.4 });
  };
  s.fields.forEach(([label, value], i) => row(label, value, s.y + 5.2 + i * 2.6));
  row('Assets', s.assets.lines[0], s.y + 10.4);
  pen.line(s.x + 0.8, s.y + 13.35, s.x + s.w - 0.8, s.y + 13.35, { w: 0.1, c: COC.ink });
  pen.text(s.assets.lines[1] || '', s.x + 1.1, s.y + 12.95, { size: 1.2, font: 'serif', c: COC.ink, maxW: s.w - 2.2 });
};

DRAW['coc-fellows'] = (pen, s) => {
  cocFrame(pen, s);
  cocBand(pen, s.title, s.x, s.y, s.w);
  const half = (s.w - 2.4) / 2;
  for (let i = 0; i < 8; i++) {
    const cx = s.x + 0.8 + (i % 2) * (half + 0.8), base = s.y + 5.4 + Math.floor(i / 2) * 2.55, [char, player] = s.rows[i] || ['', ''];
    pen.text('Char.', cx, base, { size: 0.85, font: 'serif', style: 'italic', c: COC.soft });
    pen.line(cx + 3.0, base + 0.3, cx + half * 0.58, base + 0.3, { w: 0.08, c: COC.ink });
    pen.text(char, cx + 3.2, base - 0.05, { size: 1.05, font: 'serif', c: COC.ink, maxW: half * 0.58 - 3.4 });
    pen.text('Player', cx + half * 0.6, base, { size: 0.85, font: 'serif', style: 'italic', c: COC.soft });
    pen.line(cx + half * 0.6 + 3.3, base + 0.3, cx + half, base + 0.3, { w: 0.08, c: COC.ink });
    pen.text(player, cx + half * 0.6 + 3.5, base - 0.05, { size: 1.05, font: 'serif', c: COC.ink, maxW: half * 0.4 - 3.6 });
  }
};

// ======================================================================
// model and renderers
// ======================================================================

/** The section map filled with one character's data. Pure; Node tests use it. */
export function familiarModel(system, data, { name = '' } = {}) {
  const d = data || {};
  if (system === 'dnd2024') return dnd(d, name);
  if (system === 'vtm5') return vtm(d, name);
  if (system === 'coc7') return coc(d, name);
  return null;
}

function drawPage(pen, model, sections, pageIndex) {
  const [PW, PH] = model.size, paper = model.paper || '#ffffff';
  // the PDF tints the whole sheet, margins included, so A4 has no white bands
  if (pen.background) pen.background(paper); else pen.rect(0, 0, PW, PH, { w: 0, stroke: false, fill: paper });
  model.frame?.(pen, pageIndex);
  for (const s of sections) DRAW[s.kind]?.(pen, s);
}

// ---------- PDF ----------

/**
 * Write one sheet in its familiar layout. `safe` is the caller's PDF text
 * sanitizer (pdfSafe); every page, continuation pages included, carries the
 * edition banner. `firstPage` draws onto the document's current page first.
 */
export function writeFamiliarSheet(doc, system, data, { name, gm = false, secret = false, safe = (s) => s, firstPage = false, format = 'a4', footer = true }) {
  const model = familiarModel(system, data, { name });
  if (!model) return;
  const [PW, PH] = model.size, landscape = PW > PH;
  const pen = pdfPen(doc, safe), font = model.font;
  const gray = '#686c76', banner = secret ? 'GM SECRET' : gm ? 'GM EDITION' : 'PLAYER COPY';
  let first = firstPage;
  const newPage = (land, pw, ph) => {
    if (first) first = false;
    else doc.addPage(format, land ? 'landscape' : 'portrait');
    pen.page(pw, ph);
  };
  const bannerLine = (width) => {
    pen.text(LABELS[system], 3, 1.75, { size: 0.95, style: 'bold', c: gray });
    pen.text(`${banner} · familiar layout`, width - 3, 1.75, { size: 0.95, style: 'bold', c: secret ? '#8a3c78' : gray, align: 'right' });
  };

  model.pages.forEach((sections, pageIndex) => {
    newPage(landscape, PW, PH);
    drawPage(pen, model, sections, pageIndex);
    bannerLine(PW);
    if (footer) pen.text(`MundusMaker · page ${pageIndex + 1}`, 3, PH - 0.8, { size: 0.8, c: gray });
    if (pageIndex === model.pages.length - 1) pen.text(model.notice, PW / 2 + (footer ? 4 : 0), PH - 0.8, { size: 0.6, c: gray, align: 'center', maxW: PW - 24 });
  });

  // continuation pages: portrait text, banner repeated on every page
  if (model.continuations.length) {
    const PW2 = 100, PH2 = 129, bodySize = 1.3, line = 1.75, width = 94;
    let y = 0;
    const contPage = () => {
      newPage(false, PW2, PH2); bannerLine(PW2);
      pen.text(`${name || 'Character'} · continued details`, 3, 6, { size: 1.9, style: 'bold', font });
      pen.line(3, 7.3, 97, 7.3, { w: 0.12, c: '#787c84' });
      y = 10;
    };
    contPage();
    for (const entry of model.continuations) {
      const head = wrap(entry.title, width, 1.5, font, 'bold');
      const body = wrap(entry.text, width, bodySize, font);
      if (y + head.length * 2 + 4 > PH2 - 4) contPage();
      for (const ln of head) { pen.text(ln, 3, y, { size: 1.5, style: 'bold', font }); y += 2; }
      y += 0.6;
      for (const ln of body) {
        if (y > PH2 - 4) { contPage(); pen.text(`${entry.title} · continued`, 3, y, { size: bodySize, style: 'bold', font }); y += 2.4; }
        pen.text(ln, 3, y, { size: bodySize, font }); y += line;
      }
      y += 2.4;
    }
  }
}

// ---------- HTML (the in-app sheet) ----------

/** The in-app sheet in its familiar layout: the same drawing as the PDF, as SVG. */
export function familiarHtml(system, data, { name = '' } = {}) {
  const model = familiarModel(system, data, { name });
  if (!model) return '';
  const [PW, PH] = model.size;
  const pages = model.pages.map((sections, i) => {
    const pen = svgPen();
    drawPage(pen, model, sections, i);
    return `<div class="fam-page"><svg class="fam-svg" viewBox="0 0 ${PW * pen.K} ${PH * pen.K}" role="group" aria-label="${esc(`${LABELS[system]} sheet, page ${i + 1}`)}">${pen.parts.join('')}</svg></div>`;
  }).join('');
  const more = model.continuations.length
    ? `<details class="fam-more"><summary>Continued details (${model.continuations.length})</summary>${model.continuations.map((c) => `<h4>${esc(c.title)}</h4><p>${esc(c.text).replace(/\n/g, '<br>')}</p>`).join('')}</details>` : '';
  return `<div class="fam-wrap fam-${esc(system)}"><div class="fam-label">${esc(LABELS[system])} · familiar layout</div>${pages}${more}</div>`;
}
