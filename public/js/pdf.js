// PDF export via jsPDF (vendored, MIT). Two editions:
//   player — GM-only entries, secret blocks, secret relations and secret map
//            markers are stripped entirely; nothing leaks, not even counts.
//   gm     — everything, with secrets visually flagged.

import { state, types, typeOf } from './state.js';
import { mdToPlain, formatWorldDate } from './render.js';
import { isHistoric, formatYear } from './calendar.js';
import { mapToJpeg, MAP_KINDS } from './maps/mapcore.js';
import { hasKeys, resolveKeys, keyBlockIds, anchorFallbackLabel } from './maps/mapkeys.js';
import { typeKeyOf, typeGroupsOf, printableBlocks, factKeys, visibleRelations, mapKeyRows, mapLevels, timelineGroups } from './projection.js';
import { ABILITIES, abilityMod } from './statblock.js';
import { computeEncounter } from './encounter.js';
import { SHEET_SYSTEMS } from './sheets/sheetcore.js';
import { tableRows } from './randomtable.js';
import { api } from './api.js';
import { writeSystemSheet } from './sheets/sheetpdf.js';
import { withSkillBases } from './sheets/cocskills.js';
import { writeFamiliarSheet } from './sheets/familiar.js';

async function prepareSheet(block) {
  if (block.system !== 'coc7') return block;
  const catalog = await SHEET_SYSTEMS.coc7.loadData();
  return { ...block, data: withSkillBases(block.data || {}, catalog) };
}

/** Load an image from the world's assets and re-encode as a bounded JPEG. */
function loadImageJpeg(url, maxDim = 480) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // flatten transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), width: canvas.width, height: canvas.height });
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const PAGE_W = 595.28, PAGE_H = 841.89, M = 56;
const CW = PAGE_W - 2 * M; // content width

// The 14 standard PDF fonts only cover cp1252. Any character outside it makes
// jsPDF garble the whole string, so map/strip everything else up front.
const CP1252_HIGH = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const REPLACE = { '→': '->', '←': '<-', '↳': '->', '−': '-', ' ': ' ', '―': '-', '‐': '-', '′': "'", '″': '"' };
function pdfSafe(s) {
  let out = '';
  for (const c of String(s ?? '')) {
    const cp = c.codePointAt(0);
    if (cp <= 0xFF || CP1252_HIGH.has(c)) out += c;
    else if (REPLACE[c]) out += REPLACE[c];
    // anything else (emoji etc.) is dropped
  }
  return out;
}

export { typeKeyOf };

/** Chapter groups: every type the world defines, then any type that only exists
 *  on an entity — from an import, a hand-edited file, or a deleted type. Those
 *  entries used to have no chapter and were dropped from the PDF without a word.
 *  The Export view builds its checkboxes from this same list so the two can
 *  never disagree about which keys exist. */
export function typeGroups(entities) {
  return typeGroupsOf(types(), entities);
}

export async function buildPdf(opts) {
  opts = { ...opts, gm: Boolean(opts.gm && state.gm) };
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const world = state.world;
  const edition = opts.gm ? 'Game Master Edition' : 'Player Edition';

  const all = [...state.entities.values()];
  const groups = typeGroups(all);
  const labelOf = new Map(groups.map(([key, t]) => [key, t.label]));
  const included = (e) => (opts.gm || !e.gmOnly) && opts.typeKeys.has(typeKeyOf(e));
  const ents = all.filter(included).sort((a, b) => a.name.localeCompare(b.name));
  const characterSheets = [];
  const preparedSheets = new Map();
  for (const e of ents) for (const b of e.blocks || []) {
    if (b.kind === 'sheet' && (opts.gm || !b.secret)) preparedSheets.set(b, await prepareSheet(b));
  }

  // preload portraits so layout can stay synchronous
  const portraits = new Map();
  await Promise.all(ents.filter((e) => e.image).map(async (e) => {
    const img = await loadImageJpeg(api.assetUrl(state.worldId, e.image));
    if (img) portraits.set(e.id, img);
  }));

  let y = M;
  const ensure = (h) => {
    if (y + h > PAGE_H - M - 20) { doc.addPage(); y = M; }
  };

  // ---------- cover ----------
  doc.setFillColor(36, 30, 52);
  doc.rect(0, 0, PAGE_W, PAGE_H, 'F');
  doc.setTextColor(232, 228, 240);
  doc.setFont('times', 'bold');
  doc.setFontSize(38);
  const nameLines = doc.splitTextToSize(pdfSafe(world.name || 'Untitled World'), CW);
  doc.text(nameLines, PAGE_W / 2, 300, { align: 'center' });
  doc.setDrawColor(180, 140, 242);
  doc.setLineWidth(1.2);
  const ruleY = 300 + nameLines.length * 40 - 18;
  doc.line(PAGE_W / 2 - 90, ruleY, PAGE_W / 2 + 90, ruleY);
  if (world.description) {
    doc.setFont('times', 'italic');
    doc.setFontSize(13);
    doc.setTextColor(190, 182, 210);
    doc.text(doc.splitTextToSize(pdfSafe(world.description), CW - 80), PAGE_W / 2, ruleY + 30, { align: 'center' });
  }
  // edition badge
  const badgeW = 250, badgeY = 560;
  if (opts.gm) doc.setFillColor(122, 79, 180); else doc.setFillColor(74, 158, 111);
  doc.roundedRect(PAGE_W / 2 - badgeW / 2, badgeY, badgeW, 44, 6, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text(edition.toUpperCase(), PAGE_W / 2, badgeY + 19, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(opts.gm ? 'includes all secrets' : 'all secrets removed — safe to share', PAGE_W / 2, badgeY + 33, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(140, 132, 160);
  doc.text(`Exported ${new Date().toISOString().slice(0, 10)} · Made with MundusMaker`, PAGE_W / 2, PAGE_H - 46, { align: 'center' });

  doc.addPage();
  y = M;

  // ---------- helpers ----------
  const lineH = (size) => size * 1.35;

  function writeLines(lines, size, style, color, opts2 = {}) {
    doc.setFont(opts2.font || 'helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lh = lineH(size);
    for (const ln of lines) {
      ensure(lh);
      if (opts2.bg) {
        doc.setFillColor(...opts2.bg);
        doc.rect(M - 8 + (opts2.indent || 0), y - size + 1, CW + 16 - (opts2.indent || 0), lh, 'F');
        if (opts2.bar) {
          doc.setFillColor(...opts2.bar);
          doc.rect(M - 8 + (opts2.indent || 0), y - size + 1, 3, lh, 'F');
        }
        doc.setTextColor(...color);
      }
      doc.text(ln, M + (opts2.indent || 0), y);
      y += lh;
    }
  }

  function para(text, size, style, color, opts2 = {}) {
    doc.setFont(opts2.font || 'helvetica', style);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(pdfSafe(text), (opts2.maxW ?? CW) - (opts2.indent || 0));
    writeLines(lines, size, style, color, opts2);
  }

  function sectionHeading(text, color) {
    ensure(64);
    y += 10;
    doc.setFillColor(...color);
    doc.rect(M - 8, y - 16, CW + 16, 26, 'F');
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(255, 255, 255);
    doc.text(pdfSafe(text), M, y + 2);
    y += 30;
  }

  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  function writeEncounter(b, secretStyle) {
    const enc = b.enc || { partySize: 4, partyLevel: 1, rows: [] };
    // Resolve monster rows through the SAME visibility rule as the rest of the
    // export. A revealed encounter may reference a gmOnly creature; resolving it
    // through the raw entity map printed that creature's name and its secret
    // statblock's CR straight into the player edition. computeEncounter already
    // falls back to the row's own typed name when the entity resolves to null.
    const c = computeEncounter(enc, (id) => {
      const m = state.entities.get(id);
      return m && (opts.gm || !m.gmOnly) ? m : null;
    });
    y += 4;
    para(`Encounter — ${c.difficulty}`, 12, 'bold', [190, 75, 85], { font: 'times', ...secretStyle });
    for (const r of c.rows) {
      para(`${r.count} × ${r.displayName}   ·   CR ${r.cr}   ·   ${(r.xpEach * r.count).toLocaleString()} XP`,
        10, 'normal', [58, 52, 74], { indent: 8, ...secretStyle });
    }
    para(`${c.totalXp.toLocaleString()} XP raw · ×${c.multiplier} = ${c.adjustedXp.toLocaleString()} adjusted · party of ${enc.partySize}, level ${enc.partyLevel} (deadly from ${c.party.deadly.toLocaleString()})`,
      9, 'italic', [110, 104, 130], { indent: 8, ...secretStyle });
    y += 4;
  }

  // classic statblock: tan background, red accents (secret blocks keep the purple wash)
  function writeStatblock(stat, fallbackName, secretStyle) {
    const s = stat || {};
    const style = Object.keys(secretStyle).length ? secretStyle : { bg: [243, 233, 210], bar: [156, 63, 46] };
    y += 4;
    para(s.name || fallbackName || 'Unnamed', 12.5, 'bold', [156, 63, 46], { font: 'times', ...style });
    if (s.meta) para(s.meta, 9, 'italic', [110, 90, 70], style);
    para(`Armor Class ${s.ac ?? '—'}     Hit Points ${s.hp ?? '—'}     Speed ${s.speed ?? '—'}`, 9.5, 'normal', [58, 42, 24], style);
    para(ABILITIES.map((a) => `${a.toUpperCase()} ${s[a] ?? 10} (${abilityMod(s[a])})`).join('    '), 9.5, 'bold', [122, 47, 34], style);
    for (const v of s.vitals || []) {
      if (v.k || v.v) para(`${v.k}: ${v.v}`, 9, 'normal', [80, 62, 40], style);
    }
    for (const tr of s.traits || []) {
      if (tr.name || tr.text) para(`${tr.name}. ${tr.text}`, 9.5, 'normal', [58, 42, 24], style);
    }
    if ((s.actions || []).some((a) => a.name || a.text)) {
      para('ACTIONS', 9.5, 'bold', [156, 63, 46], style);
      for (const a of s.actions || []) {
        if (a.name || a.text) para(`${a.name}. ${a.text}`, 9.5, 'normal', [58, 42, 24], style);
      }
    }
    y += 4;
  }

  // Character sheets print through their system module via this tiny writer
  // facade — every string still flows through para() and therefore pdfSafe().
  function writeSheet(b, fallbackName, secretStyle, gmOnly) {
    b = preparedSheets.get(b) || b;
    const sys = SHEET_SYSTEMS[b.system];
    if (sys && opts.sheetLayout !== 'compact') {
      characterSheets.push({ block: b, name: fallbackName, secret: !!(b.secret || gmOnly) });
      para('Character sheet: included in the character sheets section at the end.', 9, 'italic', [80, 76, 96], secretStyle);
      return;
    }
    const style = Object.keys(secretStyle).length ? secretStyle : { bg: [236, 240, 246], bar: [90, 110, 160] };
    y += 4;
    if (!sys) {
      para(`Character sheet (${b.system || 'unknown system'}) — not printable in this build`, 9, 'italic', [110, 104, 130], style);
      return;
    }
    const w = {
      line: (text, o = {}) => para(String(text ?? ''), o.bold ? 10.5 : 9.5, o.bold ? 'bold' : 'normal', o.bold ? [40, 50, 90] : [58, 52, 74], style),
      para: (text) => para(String(text ?? ''), 9, 'normal', [80, 76, 96], { indent: 8, ...style }),
    };
    sys.writePdf(w, b.data, fallbackName);
    y += 4;
  }

  function writeRandomTable(b, secretStyle) {
    const table = b.table || {};
    const style = Object.keys(secretStyle).length ? secretStyle : { bg: [246, 243, 234], bar: [148, 112, 55] };
    y += 4;
    para(table.title || 'Random table', 11, 'bold', [92, 65, 34], style);
    for (const row of tableRows(table)) {
      if (!row.text.trim()) continue;
      para(`[weight ${row.weight}]  ${row.text}`, 9.5, 'normal', [58, 52, 45], { indent: 8, ...style });
    }
    y += 4;
  }

  // ---------- entities by type ----------
  for (const [typeKey, t] of groups) {
    if (!opts.typeKeys.has(typeKey)) continue;
    const group = ents.filter((e) => typeKeyOf(e) === typeKey);
    if (!group.length) continue;
    sectionHeading(t.plural || t.label, hexToRgb(t.color));

    for (const e of group) {
      const img = portraits.get(e.id);
      let imgBottom = -1, imgPageNum = -1;
      const imgW = 92;
      const imgH = img ? Math.min(130, Math.round(imgW * (img.height / img.width))) : 0;
      const headMaxW = img ? CW - imgW - 14 : CW;
      ensure(Math.max(70, imgH + 40));
      y += 8;

      if (img) {
        doc.addImage(img.dataUrl, 'JPEG', M + CW - imgW, y - 13, imgW, imgH);
        imgBottom = y - 13 + imgH;
        imgPageNum = doc.getNumberOfPages();
      }

      doc.setFont('times', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(30, 25, 45);
      const nameLines = doc.splitTextToSize(pdfSafe(e.name), headMaxW);
      doc.text(nameLines, M, y);
      if (opts.gm && e.gmOnly) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(160, 60, 170);
        doc.text('GM ONLY', M + doc.getTextWidth(pdfSafe(nameLines[0])) + 12, y);
      }
      y += 8 + (nameLines.length - 1) * 19;

      const metaBits = [t.label, ...(e.tags || [])];
      // Was `e.date?.year != null`, which dropped recurring dates — they have no
      // year at all. The formatted string is the honest test, and only a
      // historic date can carry an end year.
      const dateStr = formatWorldDate(e.date);
      if (dateStr) {
        metaBits.push(`${dateStr}${isHistoric(e.date) && e.date.endYear ? ' – ' + e.date.endYear : ''}`.trim());
      }
      para(metaBits.join('  ·  '), 9, 'normal', [130, 124, 150], { maxW: headMaxW });
      y += 4;

      const fieldKeys = factKeys(e, t);
      for (const k of fieldKeys) {
        para(`${k}:  ${e.fields[k]}`, 10, 'normal', [70, 64, 90], { maxW: headMaxW });
      }
      if (fieldKeys.length) y += 4;

      // body text flows below the portrait, never through it
      if (imgBottom >= 0 && doc.getNumberOfPages() === imgPageNum) y = Math.max(y, imgBottom + 10);

      // skip headings whose whole section is empty (fresh template scaffolds).
      // The GM edition prints map key notes in the map's key instead (1.9).
      const keyNotes = opts.gm && opts.includeMaps && hasKeys(e.map) ? keyBlockIds(e.map) : new Set();
      const printable = printableBlocks(e, opts.gm).filter((b) => !keyNotes.has(b.id));

      for (const b of printable) {
        const secretStyle = b.secret && opts.gm ? { bg: [240, 232, 250], bar: [138, 95, 194] } : {};
        if (b.kind === 'statblock') {
          if (b.secret && opts.gm) {
            ensure(14);
            writeLines(['GM SECRET'], 7, 'bold', [138, 95, 194], secretStyle);
          }
          writeStatblock(b.stat, e.name, secretStyle);
          continue;
        }
        if (b.kind === 'encounter') {
          if (b.secret && opts.gm) {
            ensure(14);
            writeLines(['GM SECRET'], 7, 'bold', [138, 95, 194], secretStyle);
          }
          writeEncounter(b, secretStyle);
          continue;
        }
        if (b.kind === 'sheet') {
          if (b.secret && opts.gm) {
            ensure(14);
            writeLines(['GM SECRET'], 7, 'bold', [138, 95, 194], secretStyle);
          }
          writeSheet(b, e.name, secretStyle, e.gmOnly);
          continue;
        }
        if (b.kind === 'table') {
          if (b.secret && opts.gm) {
            ensure(14);
            writeLines(['GM SECRET'], 7, 'bold', [138, 95, 194], secretStyle);
          }
          writeRandomTable(b, secretStyle);
          continue;
        }
        const text = mdToPlain(b.text).trim();
        if (!text) continue;
        if (b.secret && opts.gm) {
          ensure(14);
          writeLines(['GM SECRET'], 7, 'bold', [138, 95, 194], secretStyle);
        }
        if (b.kind === 'heading') {
          y += 4;
          para(text, 12.5, 'bold', [40, 34, 60], { font: 'times', ...secretStyle });
        } else if (b.kind === 'quote') {
          para(text, 10.5, 'italic', [110, 104, 130], { indent: 16, ...secretStyle });
        } else {
          para(text, 10.5, 'normal', [45, 40, 62], secretStyle);
        }
        y += 5;
      }

      if (opts.includeRelations) {
        // never points at a chapter this edition doesn't contain
        const rels = visibleRelations(e, { gm: opts.gm, byId: state.entities, included });
        if (rels.length) {
          y += 2;
          for (const { r, target } of rels) {
            para(`• ${r.label || 'related to'}: ${target.name}${r.secret ? '   [secret]' : ''}`,
              9.5, r.secret ? 'italic' : 'normal', r.secret ? [138, 95, 194] : [90, 84, 112], { indent: 8 });
          }
        }
      }

      if (opts.includeMaps && e.map) {
        try {
          // numbered badges + printed key when any visible marker/stamp has a name or link
          const { hiddenLinkIds, numbered, rows: keyRows } = mapKeyRows(e.map, { gm: opts.gm, entities: all, byId: state.entities });
          // multi-level dungeons print one image per floor; the key stays global
          const nLevels = mapLevels(e.map);
          for (let lvl = 0; lvl < nLevels; lvl++) {
            // 2× by default: maps print at ~270 DPI instead of ~135
            const img = mapToJpeg(e.map, { gm: opts.gm, numbered, scale: opts.mapScale || 2, level: lvl, roomNumbers: !!opts.roomNumbers, hiddenLinkIds });
            const maxW = CW, maxH = 330;
            const scale = Math.min(maxW / img.width, maxH / img.height);
            const w = img.width * scale, h = img.height * scale;
            ensure(h + 16);
            doc.addImage(img.dataUrl, 'JPEG', M + (CW - w) / 2, y, w, h);
            y += h + 6;
            if (nLevels > 1) para(`Level ${lvl + 1}`, 8.5, 'italic', [130, 124, 150]);
          }
          para(`Map of ${e.name}${opts.gm ? '' : ' (player version)'}`, 8.5, 'italic', [130, 124, 150]);
          if (numbered) {
            y += 2;
            // unnamed markers keep their number on the map only
            for (const row of keyRows) {
              const linked = row.linked?.name;
              let text = `${row.n}.  ${row.label}`;
              if (linked && linked !== row.label) text += `  — ${linked}`;
              if (opts.gm && row.secret) text += '   [secret]';
              para(text, 9, row.secret ? 'italic' : 'normal',
                row.secret ? [138, 95, 194] : [90, 84, 112], { indent: 8 });
            }
          }
          // the GM key: notes on rooms and places, per level in number order.
          // Players never get it; a note they may see is an ordinary revealed block.
          if (opts.gm && hasKeys(e.map)) {
            const kind = MAP_KINDS[e.map.kind];
            const { placed, unplaced } = resolveKeys(e.map, kind, (level) => kind.buildModel(e.map, level));
            const noteText = (target) => {
              if (target.entity) { const linked = state.entities.get(target.entity); return linked ? `See “${linked.name}”.` : '(its entry was deleted)'; }
              const block = (e.blocks || []).find((b) => b.id === target.block);
              return block ? mdToPlain(block.text).trim() || '(empty note)' : '(the note was deleted)';
            };
            if (placed.length || unplaced.length) {
              y += 4;
              para('Map key', 10.5, 'bold', [92, 65, 34], { font: 'times' });
              let shownLevel = -1;
              for (const { place, target } of placed) {
                if (nLevels > 1 && place.level !== shownLevel) { shownLevel = place.level; para(`Level ${place.level + 1}`, 9, 'italic', [130, 124, 150]); }
                para(`${place.label}.  ${noteText(target)}`, 9, 'normal', [58, 52, 74], { indent: 8 });
              }
              if (unplaced.length) {
                para('Unplaced notes', 9, 'italic', [130, 124, 150]);
                for (const { anchor, target } of unplaced) para(`${anchorFallbackLabel(anchor)}.  ${noteText(target)}`, 9, 'normal', [58, 52, 74], { indent: 8 });
              }
            }
          }
        } catch (err) {
          console.error('map render failed for', e.id, err);
        }
      }

      y += 6;
      ensure(10);
      doc.setDrawColor(210, 205, 220);
      doc.setLineWidth(0.6);
      doc.line(M, y, M + CW, y);
      y += 14;
    }
  }

  // ---------- timeline ----------
  if (opts.includeTimeline) {
    // Recurring dates have no year, so they must be split out BEFORE any
    // chronological comparison (undefined - undefined is NaN and the sort goes
    // silently wrong). They print in their own band, ordered by slot.
    const cal = world.calendar;
    const { dated, annual, bands } = timelineGroups(all.filter((e) => included(e) && e.date), cal);

    // PARITY WITH THE SCREEN. The row uses the same formatter the Timeline view
    // uses — formatWorldDate for the date, formatYear for the end year on its own
    // small line underneath — instead of the old `${year}–${endYear}` string,
    // which dropped the month and day of a ranged date and skipped the age suffix
    // on its start year.
    function timelineRow(e) {
      const dateText = pdfSafe(formatWorldDate(e.date));
      const untilText = isHistoric(e.date) && Number.isFinite(e.date.endYear)
        ? pdfSafe(`until ${formatYear(e.date.endYear, cal, world.era)}`)
        : '';
      doc.setFont('times', 'bold');
      doc.setFontSize(12);
      const dateW = doc.getTextWidth(dateText);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      const untilW = untilText ? doc.getTextWidth(untilText) : 0;
      // the date column has to hold BOTH lines, or a long range runs under the
      // snippet (on screen .tl-date is a fixed column and simply wraps)
      const nameX = Math.max(95, dateW + 14, untilW + 14);

      ensure(untilText ? 44 : 34);
      y += 4;
      doc.setFont('times', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(90, 74, 140);
      doc.text(dateText, M, y);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(40, 34, 60);
      doc.text(pdfSafe(e.name), M + nameX, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(130, 124, 150);
      const typeLabel = labelOf.get(typeKeyOf(e)) || typeOf(e).label || '';
      doc.text(pdfSafe(typeLabel + (opts.gm && e.gmOnly ? ' · GM only' : '')), M + nameX + doc.getTextWidth(pdfSafe(e.name)) + 12, y);
      if (untilText) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(130, 124, 150);
        doc.text(untilText, M, y + 11);
      }
      y += 14;
      const firstBlock = (e.blocks || []).find((b) => b.kind === 'text' && b.text?.trim() && (opts.gm || !b.secret));
      if (firstBlock) {
        const snippet = mdToPlain(firstBlock.text).replace(/\s+/g, ' ').trim().slice(0, 220);
        para(snippet, 9, 'normal', [110, 104, 130], { indent: nameX });
      }
      y += 4;
    }

    /** Age band / "Every year" heading — one shape, so the two cannot drift. */
    function bandHeading(text) {
      y += 10;
      ensure(26);
      para(text, 12.5, 'bold', [90, 74, 140], { font: 'times' });
      y += 2;
    }

    if (dated.length || annual.length) {
      doc.addPage();
      y = M;
      sectionHeading('Timeline', [90, 74, 140]);
      if (world.calendar?.today) {
        para(`Current date: ${world.calendar.today}`, 9.5, 'italic', [110, 104, 130]);
        y += 4;
      }
      // Same banding rule as the Timeline view, from the same kernel helpers, over
      // the list `included()` has already filtered — so the player edition never
      // prints a band header for an age only GM-only entries fall in. A world with
      // no ages takes the flat branch and prints exactly as it does in 0.8.
      if (bands) {
        for (const band of bands) {
          bandHeading(band.label + (Number.isFinite(band.age?.startYear) ? `  ·  from ${band.age.startYear}` : ''));
          for (const e of band.items) timelineRow(e);
        }
      } else {
        for (const e of dated) timelineRow(e);
      }
      if (annual.length) {
        bandHeading('Every year');
        for (const e of annual) timelineRow(e);
      }
    }
  }

  // ---------- footers ----------
  for (const sheet of characterSheets) (opts.sheetLayout === 'familiar' ? writeFamiliarSheet : writeSystemSheet)(doc, sheet.block.system, sheet.block.data, {
    name: sheet.name, gm: opts.gm, secret: sheet.secret, safe: pdfSafe, footer: false, format: 'a4',
  });
  const total = doc.getNumberOfPages();
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(150, 144, 168);
    // familiar D&D sheets are landscape pages, so measure each page
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), fy = pw > ph ? ph - 7 : ph - 26;
    doc.text(pdfSafe(`${world.name} · ${edition}`), M, fy);
    doc.text(`${i - 1} / ${total - 1}`, pw - M, fy, { align: 'right' });
  }

  return doc;
}

/** A standalone sheet uses exactly the world-export visibility flags. */
export async function buildCharacterPdf(entity, { gm = false, blockId, format = 'a4', layout = 'standard' } = {}) {
  gm = Boolean(gm && state.gm);
  if (!entity || (entity.gmOnly && !gm)) throw new Error('This character is not available in the player edition.');
  const blocks = (entity.blocks || []).filter(b => b.kind === 'sheet' && (gm || !b.secret) && (!blockId || b.id === blockId) && SHEET_SYSTEMS[b.system]);
  if (!blocks.length) throw new Error('There is no visible character sheet to export.');
  const familiar = layout === 'familiar';
  const paper = format === 'letter' ? 'letter' : 'a4';
  // the familiar D&D sheet is landscape, like the standard one it follows
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: paper, orientation: familiar && blocks[0].system === 'dnd2024' ? 'landscape' : 'portrait' });
  const prepared = await Promise.all(blocks.map(prepareSheet));
  prepared.forEach((b, i) => (familiar ? writeFamiliarSheet : writeSystemSheet)(doc, b.system, b.data, {
    name: entity.name, gm, secret: !!(entity.gmOnly || b.secret), safe: pdfSafe, firstPage: i === 0, format: paper,
  }));
  const total = doc.getNumberOfPages();
  // familiar layouts number their own pages inside the bottom margin
  for (let i = 1; i <= (familiar ? 0 : total); i++) {
    doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(111, 117, 126);
    doc.text(`${i} / ${total}`, doc.internal.pageSize.getWidth() - 32, doc.internal.pageSize.getHeight() - 18, { align: 'right' });
  }
  return doc;
}
