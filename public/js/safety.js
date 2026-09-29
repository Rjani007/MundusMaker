// Safety check (1.9): before a player export, look for ways a hidden entry can
// still reach players through content the player edition DOES show. It only
// analyzes: it never edits content, stores no dismissals, and recomputes its
// findings every time. Findings never block an export. Pure (no DOM, no app
// state), and it reads content through the same projection as every export.

import { typeKeyOf, printableBlocks, factKeys, visibleRelations, overlayVisible, hiddenOverlayLinkIds, nameResolver } from './projection.js';
import { WIKILINK, mdToPlain } from './markdown.js';
import { localAsset, presentation } from './handouts/handoutcore.js';

const MIN_NAME = 3; // shorter names ("Io") match inside too much ordinary text
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** The file an asset reference names, or null for anything that isn't one. */
function assetFile(ref, worldId) {
  const url = localAsset(ref, worldId);
  if (!url) return null;
  try { return decodeURIComponent(url.split('/').pop()); } catch { return null; }
}

/**
 * findings: [{ kind, entity: {id, name}, hidden: {id, name} | null, where,
 *              message, href }]
 * kind: 'text' (public text names a hidden entry or links to one), 'label' (a
 * map label names a hidden entry), 'image' (visible content reuses an image of
 * hidden content), 'handout' (a handout's source is hidden).
 */
export function safetyCheck({ worldId, entities, typeKeys = null }) {
  const all = [...entities];
  const byId = new Map(all.map((e) => [e.id, e]));
  const included = (e) => !!e && !e.gmOnly && (!typeKeys || typeKeys.has(typeKeyOf(e)));
  const hidden = all.filter((e) => e.gmOnly && String(e.name || '').trim().length >= MIN_NAME);
  const resolve = nameResolver(all);
  const findings = [];
  const seen = new Set();
  const add = (f) => {
    const key = `${f.kind}|${f.entity.id}|${f.where}|${f.hidden?.id || ''}|${f.message.includes(' links to ') ? 'link' : 'name'}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  const ref = (e) => ({ id: e.id, name: e.name });

  // One pass per text: every hidden name as a whole phrase, ignoring case.
  const byLower = new Map(hidden.map((e) => [e.name.trim().toLowerCase(), e]));
  const alternatives = [...byLower.keys()].sort((a, b) => b.length - a.length).map(escRx);
  const namesRx = alternatives.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  const namesIn = (text) => {
    if (!namesRx || !text) return [];
    const out = new Set();
    for (const m of String(text).matchAll(namesRx)) out.add(byLower.get(m[1].toLowerCase()));
    return [...out].filter(Boolean);
  };
  const scanText = (e, text, where, href = `#/e/${encodeURIComponent(e.id)}`) => {
    for (const h of namesIn(text)) {
      add({ kind: 'text', entity: ref(e), hidden: ref(h), where, href,
        message: `${where} in “${e.name}” names the GM-only entry “${h.name}”.` });
    }
  };

  // Images that belong to hidden content: GM-only entries' portraits and
  // images, and images placed only inside secret blocks.
  const hiddenImages = new Map();
  const noteImage = (file, owner, how) => { if (file && !hiddenImages.has(file)) hiddenImages.set(file, { owner, how }); };
  for (const e of all) {
    for (const b of e.blocks || []) {
      if (!e.gmOnly && !b.secret) continue;
      for (const m of String(b.text || '').matchAll(/!\[[^\]]*\]\((\/assets\/[^\s)]+)\)/g)) {
        noteImage(assetFile(m[1], worldId), e, e.gmOnly ? 'GM-only entry' : 'secret block');
      }
    }
    if (e.gmOnly && e.image) noteImage(assetFile(e.image, worldId), e, 'GM-only entry');
  }
  const scanImage = (e, file, where) => {
    const owner = file && hiddenImages.get(file);
    if (!owner) return;
    add({ kind: 'image', entity: ref(e), hidden: owner.how === 'GM-only entry' ? ref(owner.owner) : null, where,
      href: `#/e/${encodeURIComponent(e.id)}`,
      message: owner.how === 'GM-only entry'
        ? `${where} in “${e.name}” reuses an image of the GM-only entry “${owner.owner.name}”.`
        : `${where} in “${e.name}” reuses an image from a secret block in “${owner.owner.name}”.` });
  };

  for (const e of all.filter(included)) {
    scanText(e, e.name, 'The entry name');
    for (const tag of e.tags || []) scanText(e, tag, `The tag “${clip(tag, 30)}”`);
    for (const k of factKeys(e, null)) scanText(e, `${k} ${e.fields[k]}`, `The quick fact “${clip(k, 30)}”`);
    if (e.image) scanImage(e, assetFile(e.image, worldId), 'The portrait');

    printableBlocks(e, false).forEach((b) => {
      const where = b.kind === 'heading' ? 'A heading' : b.kind === 'quote' ? 'A quote' : b.kind === 'table' ? `The random table “${clip(b.table?.title || 'Random table', 30)}”`
        : b.kind === 'statblock' ? 'A statblock' : b.kind === 'encounter' ? 'An encounter' : 'A text block';
      if (b.text) {
        for (const m of b.text.matchAll(WIKILINK)) {
          const target = resolve(m[1]);
          if (target?.gmOnly) {
            add({ kind: 'text', entity: ref(e), hidden: ref(target), where, href: `#/e/${encodeURIComponent(e.id)}`,
              message: `${where} in “${e.name}” links to the GM-only entry “${target.name}”. Players see the link text “${clip(m[2] || m[1], 40)}” as plain text.` });
          }
        }
        scanText(e, mdToPlain(b.text), where);
        for (const m of b.text.matchAll(/!\[[^\]]*\]\((\/assets\/[^\s)]+)\)/g)) scanImage(e, assetFile(m[1], worldId), 'An image');
      } else if (b.kind === 'table') {
        scanText(e, [b.table?.title, ...(b.table?.rows || []).map((r) => r?.text)].join('\n'), where);
      } else if (b.kind === 'statblock') {
        const s = b.stat || {};
        scanText(e, [s.name, s.meta, ...(s.traits || []), ...(s.actions || [])].map((t) => typeof t === 'string' ? t : `${t?.name || ''} ${t?.text || ''}`).join('\n'), where);
      } else if (b.kind === 'encounter') {
        // a row linked to a hidden creature prints its own typed name instead
        for (const row of b.enc?.rows || []) {
          if (!row.to || byId.get(row.to)?.gmOnly) scanText(e, row.name, where);
        }
      }
    });

    for (const { r } of visibleRelations(e, { gm: false, byId, included })) scanText(e, r.label, `The relation “${clip(r.label, 30)}”`);

    const map = e.map;
    if (map) {
      const href = `#/map/${encodeURIComponent(e.id)}`;
      const hiddenLinkIds = hiddenOverlayLinkIds(map, all);
      const label = (text, where) => {
        for (const h of namesIn(text)) {
          add({ kind: 'label', entity: ref(e), hidden: ref(h), where, href,
            message: `${where} on the map of “${e.name}” names the GM-only entry “${h.name}”.` });
        }
      };
      for (const lb of map.labels || []) label(lb.text, `The map label “${clip(lb.text, 40)}”`);
      for (const list of ['markers', 'stamps']) {
        for (const item of map[list] || []) {
          if (overlayVisible(item, { gm: false, hiddenLinkIds }) && item.label) label(item.label, `The ${list === 'markers' ? 'marker' : 'stamp'} “${clip(item.label, 40)}”`);
        }
      }
      const edits = map.siteEdits || {};
      for (const site of map.sites || []) {
        if (!edits[`custom:${site.id}`]?.hidden) label(edits[`custom:${site.id}`]?.name || site.name, `The place “${clip(edits[`custom:${site.id}`]?.name || site.name, 40)}”`);
      }
      for (const [key, edit] of Object.entries(edits)) {
        if (!key.startsWith('custom:') && edit?.name && !edit.hidden) label(edit.name, `The place “${clip(edit.name, 40)}”`);
      }
      if (map.params?.title) label(map.params.title, 'The map title');
      for (const name of Object.values(map.wardNames || {})) if (name) label(name, `The ward “${clip(name, 40)}”`);
      for (const [key, id] of Object.entries(map.scaleLinks || {})) {
        const target = byId.get(id);
        if (!target?.gmOnly || edits[key]?.hidden) continue;
        add({ kind: 'label', entity: ref(e), hidden: ref(target), where: `A place (${key.split(':').slice(2).join(':') || key})`, href,
          message: `A place on the map of “${e.name}” is linked to the GM-only entry “${target.name}”. Player maps don’t offer the link, but they still draw the place and its name.` });
      }
    }

    if (e.handout || e.type === 'handout') {
      const p = presentation(e);
      const source = p.sourceId ? byId.get(p.sourceId) : null;
      const secretLink = (e.relations || []).some((r) => r.to === p.sourceId && r.secret);
      if (source && (source.gmOnly || secretLink)) {
        add({ kind: 'handout', entity: ref(e), hidden: ref(source), where: 'The handout source', href: `#/handouts/${encodeURIComponent(e.id)}`,
          message: `The handout “${e.name}” takes content from “${source.name}”, which is ${source.gmOnly ? 'GM-only' : 'linked through a secret relation'}. The player edition leaves out that entry’s name, facts, blocks and image, so the handout may read differently than you expect.` });
      }
    }
  }
  return findings;
}
