// Markdown-lite rendering with [[wiki-link]] support, plus backlink computation.
// The grammar itself lives in markdown.js, shared with the player wiki export.

import { esc } from './util.js';
import { state, findByName, visibleEntities, saveEntity } from './state.js';
import { formatDate } from './calendar.js';
import { renderMarkdown, mdToPlain, WIKILINK, mentionMatcher } from './markdown.js';
import { snippetOf } from './projection.js';

export { mdToPlain };

const DICE = /\b(\d{1,3}d\d{1,4}(?:\s*[+-]\s*\d{1,3})?)\b/g;

/** Wrap dice notation ("2d6+3") in clickable roll links. Input must be escaped HTML. */
export function linkDice(html) {
  return html.replace(DICE, (match) =>
    `<a class="dice" href="#" data-dice="${match.replace(/\s+/g, '')}" title="Click to roll">${match}</a>`);
}

// The app's reading of the shared grammar (markdown.js): links resolve against
// the live world and respect player preview; dice become roll links.
const APP_HOOKS = {
  link(target, display) {
    const ent = findByName(target);
    const label = esc((display || target).trim());
    if (ent && (state.gm || !ent.gmOnly)) {
      return `<a class="wl" href="#/e/${esc(ent.id)}">${label}</a>`;
    }
    if (ent) return label; // gm-only target in player preview: render as plain text
    return `<a class="wl missing" href="#/new/${encodeURIComponent(target.trim())}" title="Not written yet — click to create">${label}</a>`;
  },
  image: (alt, url) => `<img class="md-img" src="${url}" alt="${alt}" loading="lazy">`,
  dice: linkDice,
};

export function mdToHtml(text) {
  return renderMarkdown(text, APP_HOOKS);
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
 * Plan a [[wiki-link]] rewrite for an entity rename: find every text block
 * that links the old name and count the mentions. Returns null when nothing
 * links it; otherwise { entries, total, apply }. The caller confirms with the
 * user, then awaits apply(). Wiki-links resolve by NAME, so every rename path
 * must offer this — the entity page and the map editor's linked-site rename
 * both go through here so the wiki can't silently break (1.4).
 */
export function planWikiRenames(oldName, newName, entities = state.entities.values()) {
  const from = String(oldName || '').trim(), to = String(newName || '').trim();
  if (!from || !to || from === to) return null;
  const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const testRx = new RegExp(`\\[\\[\\s*${escRx(from)}\\s*(\\||\\]\\])`, 'i');
  const affected = [...entities].filter((other) =>
    (other.blocks || []).some((b) => testRx.test(b.text || '')));
  if (!affected.length) return null;
  const total = affected.reduce((n, other) =>
    n + (other.blocks || []).reduce((m, b) =>
      m + ((b.text || '').match(new RegExp(`\\[\\[\\s*${escRx(from)}\\s*(?=\\||\\]\\])`, 'gi')) || []).length, 0), 0);
  return {
    entries: affected.length,
    total,
    async apply() {
      const replaceRx = new RegExp(`\\[\\[\\s*${escRx(from)}\\s*(\\||\\]\\])`, 'gi');
      for (const other of affected) {
        for (const b of other.blocks || []) {
          if (b.text) b.text = b.text.replace(replaceRx, `[[${to}$1`);
        }
        await saveEntity(other);
      }
    },
  };
}

/**
 * Plan linking the plain-text mentions of an entry's name (1.9). Same shape
 * as planWikiRenames: null when there is nothing to link, otherwise
 * { hits, entries, total, apply(hits?) }. A mention matches the whole name,
 * ignoring case, with an optional plural ("s"/"es") or possessive ("'s");
 * text already inside a [[link]] or an image is left alone. The displayed
 * words never change: "port vellen's" becomes "[[Port Vellen|port vellen]]'s".
 */
export function planLinkMentions(entity, entities = state.entities.values()) {
  const matcher = mentionMatcher(entity?.name);
  if (!matcher) return null;
  const hits = [];
  for (const other of entities) {
    if (other.id === entity.id) continue;
    for (const block of other.blocks || []) {
      if (!['text', 'heading', 'quote'].includes(block.kind) || !block.text) continue;
      const { count, snippet } = matcher.find(block.text);
      if (count) hits.push({ entity: other, block, count, snippet });
    }
  }
  if (!hits.length) return null;
  return {
    hits,
    entries: new Set(hits.map((h) => h.entity)).size,
    total: hits.reduce((n, h) => n + h.count, 0),
    async apply(chosen = hits) {
      const touched = new Set();
      for (const h of chosen) {
        h.block.text = matcher.link(h.block.text);
        touched.add(h.entity);
      }
      for (const other of touched) await saveEntity(other);
    },
  };
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
  return snippetOf(entity, state.gm, maxLen);
}
