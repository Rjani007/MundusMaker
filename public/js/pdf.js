// PDF export via jsPDF (vendored, MIT). Two editions:
//   player — GM-only entries, secret blocks, secret relations and secret map
//            markers are stripped entirely; nothing leaks, not even counts.
//   gm     — everything, with secrets visually flagged.

import { state, types, typeOf } from './state.js';
import { mdToPlain, formatWorldDate } from './render.js';
import { mapToJpeg, mapKey } from './maps/mapcore.js';
import { ABILITIES, abilityMod } from './statblock.js';
import { computeEncounter } from './encounter.js';
import { api } from './api.js';

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

export async function buildPdf(opts) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const world = state.world;
  const edition = opts.gm ? 'Game Master Edition' : 'Player Edition';

  const ents = [...state.entities.values()]
    .filter((e) => (opts.gm || !e.gmOnly) && opts.typeKeys.has(e.type))
    .sort((a, b) => a.name.localeCompare(b.name));
  const visible = (e) => opts.gm || !e.gmOnly; // for relation targets

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
  doc.text(`Exported ${new Date().toISOString().slice(0, 10)} · Made with Loreweave`, PAGE_W / 2, PAGE_H - 46, { align: 'center' });

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
    doc.text(text, M, y + 2);
    y += 30;
  }

  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  function writeEncounter(b, secretStyle) {
    const enc = b.enc || { partySize: 4, partyLevel: 1, rows: [] };
    const c = computeEncounter(enc, (id) => state.entities.get(id));
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

  // ---------- entities by type ----------
  for (const [typeKey, t] of Object.entries(types())) {
    if (!opts.typeKeys.has(typeKey)) continue;
    const group = ents.filter((e) => e.type === typeKey);
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
      if (e.date?.year != null) {
        metaBits.push(`${formatWorldDate(e.date)}${e.date.endYear ? ' – ' + e.date.endYear : ''}`.trim());
      }
      para(metaBits.join('  ·  '), 9, 'normal', [130, 124, 150], { maxW: headMaxW });
      y += 4;

      const fieldKeys = [...new Set([...(t.fields || []), ...Object.keys(e.fields || {})])]
        .filter((k) => e.fields?.[k]);
      for (const k of fieldKeys) {
        para(`${k}:  ${e.fields[k]}`, 10, 'normal', [70, 64, 90], { maxW: headMaxW });
      }
      if (fieldKeys.length) y += 4;

      // body text flows below the portrait, never through it
      if (imgBottom >= 0 && doc.getNumberOfPages() === imgPageNum) y = Math.max(y, imgBottom + 10);

      // skip headings whose whole section is empty (fresh template scaffolds)
      const shownBlocks = (e.blocks || []).filter((b) => opts.gm || !b.secret);
      const blockHasContent = (b) => b.kind === 'statblock' || b.kind === 'encounter' || b.text?.trim();
      const printable = shownBlocks.filter((b, i) => {
        if (b.kind !== 'heading') return true;
        for (let j = i + 1; j < shownBlocks.length && shownBlocks[j].kind !== 'heading'; j++) {
          if (blockHasContent(shownBlocks[j])) return true;
        }
        return false;
      });

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
        const rels = (e.relations || [])
          .filter((r) => (opts.gm || !r.secret))
          .map((r) => ({ r, target: state.entities.get(r.to) }))
          .filter(({ target }) => target && visible(target) && opts.typeKeys.size);
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
          const keyMarkers = mapKey(e.map, { gm: opts.gm });
          const numbered = keyMarkers.some((mk) => mk.label || mk.to);
          // 2× by default: maps print at ~270 DPI instead of ~135
          const img = mapToJpeg(e.map, { gm: opts.gm, numbered, scale: opts.mapScale || 2 });
          const maxW = CW, maxH = 330;
          const scale = Math.min(maxW / img.width, maxH / img.height);
          const w = img.width * scale, h = img.height * scale;
          ensure(h + 16);
          doc.addImage(img.dataUrl, 'JPEG', M + (CW - w) / 2, y, w, h);
          y += h + 6;
          para(`Map of ${e.name}${opts.gm ? '' : ' (player version)'}`, 8.5, 'italic', [130, 124, 150]);
          if (numbered) {
            y += 2;
            keyMarkers.forEach((mk, i) => {
              const target = mk.to ? state.entities.get(mk.to) : null;
              const linked = target && visible(target) ? target.name : null;
              const label = mk.label || linked;
              if (!label) return; // unnamed markers keep their number on the map only
              let text = `${i + 1}.  ${label}`;
              if (linked && mk.label && linked !== mk.label) text += `  — ${linked}`;
              if (opts.gm && mk.secret) text += '   [secret]';
              para(text, 9, mk.secret ? 'italic' : 'normal',
                mk.secret ? [138, 95, 194] : [90, 84, 112], { indent: 8 });
            });
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
    const dated = [...state.entities.values()]
      .filter((e) => (opts.gm || !e.gmOnly) && e.date && Number.isFinite(e.date.year))
      .sort((a, b) => (a.date.year - b.date.year) || ((a.date.month ?? 0) - (b.date.month ?? 0)));
    if (dated.length) {
      doc.addPage();
      y = M;
      sectionHeading('Timeline', [90, 74, 140]);
      if (world.calendar?.today) {
        para(`Current date: ${world.calendar.today}`, 9.5, 'italic', [110, 104, 130]);
        y += 4;
      }
      const era = world.era ? ` ${world.era}` : '';
      for (const e of dated) {
        ensure(34);
        y += 4;
        doc.setFont('times', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(90, 74, 140);
        const yearStr = pdfSafe(`${e.date.endYear ? `${e.date.year}–${e.date.endYear}${era}` : formatWorldDate(e.date)}`);
        doc.text(yearStr, M, y);
        const nameX = Math.max(95, doc.getTextWidth(yearStr) + 14);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(40, 34, 60);
        doc.text(pdfSafe(e.name), M + nameX, y);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(130, 124, 150);
        doc.text(typeOf(e).label + (opts.gm && e.gmOnly ? ' · GM only' : ''), M + nameX + doc.getTextWidth(pdfSafe(e.name)) + 12, y);
        y += 14;
        const firstBlock = (e.blocks || []).find((b) => b.kind === 'text' && b.text?.trim() && (opts.gm || !b.secret));
        if (firstBlock) {
          const snippet = mdToPlain(firstBlock.text).replace(/\s+/g, ' ').trim().slice(0, 220);
          para(snippet, 9, 'normal', [110, 104, 130], { indent: nameX });
        }
        y += 4;
      }
    }
  }

  // ---------- footers ----------
  const total = doc.getNumberOfPages();
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(150, 144, 168);
    doc.text(pdfSafe(`${world.name} · ${edition}`), M, PAGE_H - 26);
    doc.text(`${i - 1} / ${total - 1}`, PAGE_W - M, PAGE_H - 26, { align: 'right' });
  }

  return doc;
}
