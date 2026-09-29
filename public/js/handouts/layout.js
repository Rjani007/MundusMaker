import { PAGE_SIZES } from './handoutcore.js';

const MM = 72 / 25.4;
const glyphs = text => typeof Intl?.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(v => v.segment) : [...text];
/** Measured word wrapping, including long URLs/names and explicit newlines. */
export function wrapText(text, width, measure) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      if (measure(word) <= width) { line = word; continue; }
      for (const c of glyphs(word)) {
        if (line && measure(line + c) > width) { lines.push(line); line = ''; }
        line += c;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function decorate(page, model, index) {
  const { width: W, height: H, ops } = page, { p } = model;
  const ink = p.ink, bg = p.paper === 'white' ? '#ffffff' : p.paper === 'aged' ? '#f2e3c3' : '#fbf7ec';
  ops.push({ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: bg });
  if (p.paper === 'aged') {
    // Original, deterministic paper flecks. No external texture or image service.
    let rng = 173 + index * 31;
    const random = () => { rng = Math.imul(rng, 1664525) + 1013904223 | 0; return (rng >>> 0) / 4294967296; };
    for (let i = 0; i < 135; i++) ops.push({ kind: 'rect', x: random() * W, y: random() * H, w: .4 + random() * 1.3, h: .35, fill: '#ddcaa5' });
    for (let i = 0; i < 3; i++) ops.push({ kind: 'rect', x: 2 + i * 2, y: 2 + i * 2, w: W - 4 - i * 4, h: H - 4 - i * 4, stroke: ['#d5bd91', '#e0cba5', '#e8d4af'][i], line: 2 });
  }
  if (p.border !== 'none') {
    const inset = Math.min(p.margin * MM * .52, 22);
    ops.push({ kind: 'rect', x: inset, y: inset, w: W - inset * 2, h: H - inset * 2, stroke: ink, line: .65 });
    if (p.border === 'double' || p.border === 'ornament') ops.push({ kind: 'rect', x: inset + 3, y: inset + 3, w: W - inset * 2 - 6, h: H - inset * 2 - 6, stroke: ink, line: .3 });
    if (p.border === 'ornament') for (const x of [inset + 8, W - inset - 8]) for (const y of [inset + 8, H - inset - 8]) {
      ops.push({ kind: 'line', x: x - 4, y, x2: x + 4, y2: y, stroke: ink, line: 1 });
      ops.push({ kind: 'line', x, y: y - 4, x2: x, y2: y + 4, stroke: ink, line: 1 });
    }
  }
  if (model.gm) ops.push({ kind: 'text', text: 'GM EDITION · MAY CONTAIN SECRETS', x: W / 2, y: Math.max(18, p.margin * MM * .62), size: W < 300 ? 6 : 8, font: 'sans', style: 'bold', color: '#8e2525', align: 'center' });
}

/** Layout uses PDF font metrics. Both renderers consume these exact operations
 * and page boundaries; no HTML screenshot or independent CSS pagination. */
export function layoutHandout(model, measure, images = new Map()) {
  if (!model) return { pages: [], warnings: [], title: '' };
  const { p } = model, [W, H] = PAGE_SIZES[p.size], margin = p.margin * MM;
  const pages = [], warnings = [...model.warnings], width = W - 2 * margin, bottom = H - margin - 15;
  let page, y, firstBody = true;
  const textOp = (text, x, at, size, style = 'normal', align = 'left', font = p.font, color = p.ink) => page.ops.push({ kind: 'text', text, x, y: at, size, font, style, color, align });
  function newPage() {
    if (pages.length >= 250) throw Error('This handout exceeds 250 pages. Split it into separate entries before exporting.');
    page = { width: W, height: H, ops: [], title: model.title, gm: model.gm };
    pages.push(page); decorate(page, model, pages.length); y = margin + (model.gm ? 7 : 0);
  }
  const need = height => { if (y + height > bottom && y > margin + 20) newPage(); };
  function textBlock(text, { size = p.fontSize, style = 'normal', align = 'left', gap = size * .65, keep = false, drop = false } = {}) {
    const m = value => measure(value, p.font, style, size), lineHeight = size * p.lineHeight;
    let lines = wrapText(text, width, m), first = '';
    if (drop && text.trim().length > 1 && width > 220) {
      first = glyphs(text.trim())[0];
      const largeSize = size * 3.1, inset = measure(first, p.font, 'normal', largeSize) + size * .5;
      // First three short lines wrap beside the initial; the rest use full width.
      const firstBreak = text.indexOf('\n'), head = firstBreak >= 0 ? text.slice(0,firstBreak) : text, tail = firstBreak >= 0 ? text.slice(firstBreak) : '';
      const words = head.trim().slice(first.length).split(/\s+/); let intro = '', used = 0;
      while (used < words.length && wrapText((intro ? intro + ' ' : '') + words[used], width - inset, m).length <= 3) { intro += (intro ? ' ' : '') + words[used++]; }
      const short = wrapText(intro, width - inset, m);
      need(Math.max(largeSize, short.length * lineHeight) + size);
      textOp(first, margin, y + largeSize * .82, largeSize);
      for (const line of short) { textOp(line, margin + inset, y + size, size, style); y += lineHeight; }
      if (short.length < 3) y += (3 - short.length) * lineHeight;
      const remainder = words.slice(used).join(' ') + tail;
      lines = remainder ? wrapText(remainder, width, m) : [];
    }
    if (keep) need(Math.min(lines.length + 2, 5) * lineHeight);
    // Avoid stranding one line of a short paragraph at the bottom of a page.
    if (lines.length >= 2 && y + lineHeight * 2 > bottom) need(lineHeight * 2);
    for (const line of lines) {
      need(lineHeight);
      if (line) textOp(line, align === 'center' ? W / 2 : align === 'right' ? W - margin : margin, y + size, size, style, align);
      y += lineHeight;
    }
    y += gap;
  }
  function imageBlock(url, maxHeight = H * .28, seal = false) {
    const img = images.get(url);
    if (!img) { warnings.push('A local image could not be loaded and has been omitted.'); return; }
    const maxWidth = seal ? Math.min(90, width * .35) : width;
    const ratio = Math.min(maxWidth / img.width, maxHeight / img.height), w = img.width * ratio, h = img.height * ratio;
    need(h + 10); page.ops.push({ kind: 'image', url, x: (W - w) / 2, y, w, h }); y += h + 12;
  }
  newPage();
  const titleSize = p.kind === 'notice' ? Math.min(42, W / 14) : p.kind === 'book' ? 30 : p.kind === 'card' ? 14 : 25;
  if (p.kind === 'book' && p.cover) {
    y = H * .23; textBlock(model.title, { size: titleSize, style: 'bold', align: 'center', gap: 24 });
    for (const block of model.blocks.filter(b => b.role === 'author')) textBlock((block.secret ? 'SECRET · ' : '') + block.text, { size: 13, style: 'italic', align: 'center' });
    if (model.image) imageBlock(model.image, H * .30);
    newPage();
  } else {
    textBlock(model.title, { size: titleSize, style: 'bold', align: p.kind === 'letter' ? 'left' : 'center', gap: p.kind==='card'?10:16, keep: true });
    if (model.image && p.kind !== 'letter') imageBlock(model.image, p.kind === 'card' ? H * .22 : H * .30);
  }
  for (const block of model.blocks) {
    if (block.role === 'author' && p.kind === 'book' && p.cover) continue;
    if (block.kind === 'image') { imageBlock(block.url, block.tall ? H * .62 : undefined); continue; }
    if (block.secret) { need(p.fontSize * 3); textOp('SECRET', margin, y + 8, 8, 'bold', 'left', 'sans', '#8e2525'); y += 15; }
    const role = block.role, heading = role === 'heading' || block.kind === 'heading';
    const style = heading ? 'bold' : role === 'signature' || block.kind === 'quote' || role === 'author' ? 'italic' : 'normal';
    const size = heading ? p.fontSize * 1.25 : role === 'signature' ? Math.min(22, p.fontSize * 1.6) : p.fontSize;
    textBlock(block.text, { size, style, align: role === 'date' ? 'right' : p.kind === 'notice' || role === 'author' ? 'center' : 'left', gap: ['sender', 'date', 'closing'].includes(role) ? 3 : size * .7, keep: heading, drop: firstBody && role === 'body' && p.dropCap });
    if (role === 'body') firstBody = false;
  }
  if (model.image && p.kind === 'letter') imageBlock(model.image, 80, true);
  pages.forEach((page, i) => {
    if (p.pageNumbers) page.ops.push({ kind: 'text', text: `${i + 1} / ${pages.length}`, x: W / 2, y: H - Math.max(18, margin * .55), size: 8, font: p.font, style: 'normal', align: 'center', color: p.ink });
  });
  if(p.kind==='card'&&pages.length>1)warnings.push('This card continues into another slot. Shorten the text, use a larger card, or reduce type size to keep it on one card.');
  return { pages, warnings: [...new Set(warnings)], title: model.title, images };
}

/** Consecutive card pages share printable sheets. Mixed packets preserve their
 * selected order; longer cards continue in the next slot and keep page numbers. */
export function cardSheets(pages, size = 'a4') {
  const [W, H] = PAGE_SIZES[size] || PAGE_SIZES.a4, result = [], margin = 24, gap = 12;
  let sheet = null, key = '', slot = 0, cols = 0, rows = 0;
  for (const page of pages) {
    if (page.width > 300 || page.height > 450) { result.push(page); sheet = null; continue; }
    const nextKey = `${page.width}/${page.height}/${page.gm}`;
    if (!sheet || key !== nextKey || slot >= cols * rows) {
      cols = Math.max(1, Math.floor((W - 2 * margin + gap) / (page.width + gap)));
      rows = Math.max(1, Math.floor((H - 2 * margin + gap) / (page.height + gap)));
      sheet = { width: W, height: H, ops: [{ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: '#ffffff' }], gm: page.gm, title: page.title }; result.push(sheet); key = nextKey; slot = 0;
    }
    const x = (W - cols * page.width - (cols - 1) * gap) / 2 + slot % cols * (page.width + gap);
    const y = margin + Math.floor(slot / cols) * (page.height + gap); slot++;
    sheet.ops.push(...page.ops.map(op => ({ ...op, x: op.x + x, y: op.y + y, ...(op.kind === 'line' ? { x2: op.x2 + x, y2: op.y2 + y } : {}) })));
    for (const cx of [x, x + page.width]) for (const cy of [y, y + page.height]) {
      const dx = cx === x ? -1 : 1, dy = cy === y ? -1 : 1;
      sheet.ops.push({ kind: 'line', x: cx + dx * 2, y: cy, x2: cx + dx * 5, y2: cy, stroke: '#777777', line: .3 }, { kind: 'line', x: cx, y: cy + dy * 2, x2: cx, y2: cy + dy * 5, stroke: '#777777', line: .3 });
    }
  }
  return result;
}
