// Markdown-lite rendering with [[wiki-link]] support, plus backlink computation.
//
// Supported syntax inside text blocks:
//   [[Entity Name]] / [[Entity Name|shown text]]   links (auto-backlinked)
//   **bold**  *italic*  `code`
//   - list item        > quoted line
//   blank line         paragraph break

import { esc } from './util.js';
import { state, findByName, visibleEntities } from './state.js';
import { formatDate } from './calendar.js';

const WIKILINK = /\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g;
const DICE = /\b(\d{1,3}d\d{1,4}(?:\s*[+-]\s*\d{1,3})?)\b/g;

/** Wrap dice notation ("2d6+3") in clickable roll links. Input must be escaped HTML. */
export function linkDice(html) {
  return html.replace(DICE, (match) =>
    `<a class="dice" href="#" data-dice="${match.replace(/\s+/g, '')}" title="Click to roll">${match}</a>`);
}

function inlineMd(text) {
  let html = esc(text);
  html = html.replace(/\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g, (_, target, display) => {
    const ent = findByName(target);
    const label = esc((display || target).trim());
    if (ent && (state.gm || !ent.gmOnly)) {
      return `<a class="wl" href="#/e/${esc(ent.id)}">${label}</a>`;
    }
    if (ent) return label; // gm-only target in player preview: render as plain text
    return `<a class="wl missing" href="#/new/${encodeURIComponent(target.trim())}" title="Not written yet — click to create">${label}</a>`;
  });
  // images, but ONLY from the world's own /assets/ — remote URLs stay plain
  // text, so a note can never make the app fetch anything off this machine
  html = html.replace(/!\[([^\]]*)\]\((\/assets\/[^\s)]+)\)/g,
    '<img class="md-img" src="$2" alt="$1" loading="lazy">');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = linkDice(html);
  return html;
}

export function mdToHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let list = null, quote = null, para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
  };
  const flushQuote = () => {
    if (quote) { out.push(`<blockquote>${quote.join('<br>')}</blockquote>`); quote = null; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^- /.test(line)) {
      flushPara(); flushQuote();
      (list ??= []).push(`<li>${inlineMd(line.slice(2))}</li>`);
    } else if (/^> ?/.test(line)) {
      flushPara(); flushList();
      (quote ??= []).push(inlineMd(line.replace(/^> ?/, '')));
    } else if (line === '') {
      flushPara(); flushList(); flushQuote();
    } else {
      flushList(); flushQuote();
      para.push(inlineMd(line));
    }
  }
  flushPara(); flushList(); flushQuote();
  return out.join('');
}

/** Plain text with markup stripped — for snippets and PDF export. */
export function mdToPlain(text) {
  return String(text || '')
    .replace(/!\[([^\]]*)\]\(\/assets\/[^\s)]+\)/g, '$1')
    .replace(WIKILINK, (_, target, display) => (display || target).trim())
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^> ?/gm, '')
    .replace(/^- /gm, '• ');
}

/** Entity ids referenced via [[wiki-links]] in an entity's blocks. */
export function extractLinkIds(entity, { includeSecret = true } = {}) {
  const ids = new Set();
  for (const b of entity.blocks || []) {
    if (!includeSecret && b.secret) continue;
    for (const m of String(b.text || '').matchAll(WIKILINK)) {
      const ent = findByName(m[1]);
      if (ent) ids.add(ent.id);
    }
  }
  return ids;
}

/**
 * Everything that points at `id`: wiki-link mentions and incoming relations.
 * Respects the current GM/player mode (secret blocks & relations hidden in player preview).
 */
export function backlinksFor(id) {
  const results = [];
  for (const src of visibleEntities()) {
    if (src.id === id) continue;
    const mentions = extractLinkIds(src, { includeSecret: state.gm });
    if (mentions.has(id)) results.push({ entity: src, via: 'mention' });
    for (const rel of src.relations || []) {
      if (rel.to === id && (state.gm || !rel.secret)) {
        results.push({ entity: src, via: 'relation', label: rel.label, secret: !!rel.secret });
      }
    }
  }
  return results;
}

/**
 * Format an in-world date against the ACTIVE world — the state-bound convenience
 * wrapper around calendar.js formatDate, which is now the single implementation.
 * Callers get intercalary days, ages and annually recurring dates for free.
 *
 * Byte-identical to the old local implementation for every shape that exists in
 * 0.8 data: same "no finite year -> empty string" gate, same named-month test
 * (the raw calendar.months entry must be truthy), same "1021.09.14" numeric
 * fallback, and the same era suffix whenever the world declares no ages.
 */
export function formatWorldDate(d) {
  return formatDate(d, state.world?.calendar, state.world?.era);
}

/** First visible text block, truncated — used in lists and timeline. */
export function snippetFor(entity, maxLen = 150) {
  for (const b of entity.blocks || []) {
    if (b.kind !== 'text' || !b.text?.trim()) continue;
    if (b.secret && !state.gm) continue;
    const plain = mdToPlain(b.text).replace(/\s+/g, ' ').trim();
    return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain;
  }
  return '';
}
