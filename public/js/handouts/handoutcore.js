// Handouts are ordinary entries. Only presentation and block IDs live in
// entity.handout; every edition passes through projectHandout before layout.
export const HANDOUT_KINDS = {
  book: { label: 'Old book / journal', icon: '▤', description: 'A cover and chapters that flow onto numbered pages.',
    style: { paper: 'aged', border: 'double', cover: true, dropCap: true },
    starter: [['author', 'text', 'From the journals of Elian Vale'], ['heading', 'heading', 'The road beyond the marsh'], ['body', 'text', 'On the third morning, the bells of the drowned village rang beneath the water. We made camp on the old causeway and waited for the tide to turn.\n\nBetween these pages I have kept a record of what we found, and what we dared not carry home.']] },
  letter: { label: 'Letter', icon: '✉', description: 'Correspondence with a date, signature and optional local seal.',
    style: { paper: 'ivory', border: 'none', cover: false },
    starter: [['sender', 'text', 'The Lantern House'], ['date', 'text', 'The first day of winter'], ['recipient', 'text', 'My dear friend,'], ['body', 'text', 'If this letter reaches you, the northern road remains open. Come to the old observatory at dusk. Bring the brass key, and tell no one where you are going.\n\nThere is still time to put matters right.'], ['closing', 'text', 'Yours, in hope,'], ['signature', 'quote', 'Mara']] },
  scroll: { label: 'Scroll', icon: '≋', description: 'A proclamation, prophecy or discovered fragment.',
    style: { paper: 'aged', border: 'ornament', cover: false },
    starter: [['body', 'text', 'When the last watchfire fades,\nand the river runs beneath the stone,\nseek the door that casts no shadow.\n\nOnly a willing hand may turn the key.']] },
  card: { label: 'Item card', icon: '◇', description: 'Illustrated equipment, treasures and clues, with printable card sheets.',
    style: { paper: 'ivory', border: 'double', size: 'card', fontSize: 10, lineHeight: 1.35, margin: 7, cover: false },
    starter: [['heading', 'heading', 'A curious discovery'], ['body', 'text', 'A small brass key, warm to the touch. Its bow is shaped like a lantern.'], ['footer', 'text', 'Found beneath the observatory.']] },
  notice: { label: 'Notice / wanted poster', icon: '▣', description: 'A bold headline, portrait and reward or closing line.',
    style: { paper: 'aged', border: 'ornament', cover: false, fontSize: 14 },
    starter: [['heading', 'heading', 'By order of the council'], ['body', 'text', 'Information is sought concerning the disappearance of the keeper of the north gate.\n\nLast seen at the ferry crossing, carrying a blue lantern. Speak to the steward at the town hall.'], ['footer', 'heading', 'Reward: 100 silver crowns']] },
  mapfragment: { label: 'Map fragment', icon: '⌖', description: 'A torn piece of one of your maps, drawn from the player map when you export.',
    style: { paper: 'aged', border: 'none', cover: false },
    starter: [['body', 'text', 'Scrawled on the back in a hurried hand: “Not all the tunnels are on this map.”']] },
};

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], card: [198.43, 297.64], largecard: [283.46, 425.20] };
export const ROLES = { title: 'Printed title', body: 'Body', heading: 'Chapter / heading', author: 'Author', sender: 'Sender', date: 'Date', recipient: 'Recipient', closing: 'Closing', signature: 'Signature', footer: 'Footer', subtitle: 'Subtitle', credit: 'Credit line' };
const bound = (n, low, high, fallback) => Number.isFinite(Number(n)) ? Math.min(high, Math.max(low, Number(n))) : fallback;
export function presentation(entity) {
  const h = entity.handout || {}, kind = HANDOUT_KINDS[h.kind] ? h.kind : 'letter';
  const p = { kind, size: 'a4', paper: 'ivory', border: 'none', font: 'serif', fontSize: 12, lineHeight: 1.55, margin: 20, ink: '#392d23', pageNumbers: true, ...HANDOUT_KINDS[kind].style, ...h };
  p.kind = kind; p.size = PAGE_SIZES[p.size] ? p.size : 'a4';
  p.fontSize = bound(p.fontSize, 8, 24, 12); p.lineHeight = bound(p.lineHeight, 1.2, 2, 1.55); p.margin = bound(p.margin, 6, p.size.includes('card') ? 14 : 35, 20);
  p.ink = /^#[0-9a-f]{6}$/i.test(p.ink) ? p.ink : '#392d23';
  p.font = p.font === 'sans' ? 'sans' : 'serif';
  return p;
}

export function initializeHandout(entity, kind, makeId) {
  const def = HANDOUT_KINDS[kind] || HANDOUT_KINDS.letter;
  entity.handout = { kind: HANDOUT_KINDS[kind] ? kind : 'letter', ...def.style, slots: {} };
  entity.blocks = [['title','heading',entity.name], ...def.starter].map(([role, kind, text]) => {
    const id = makeId(); entity.handout.slots[id] = role;
    return { id, kind, text, secret: false };
  });
  return entity;
}

export function localAsset(value, worldId) {
  if (!value) return null;
  const raw = String(value);
  if (/^[\w. -]+$/.test(raw) && !raw.includes('..')) return `/assets/${encodeURIComponent(worldId)}/${encodeURIComponent(raw)}`;
  // Explicitly reject other origins, traversal and assets belonging to another
  // world. URL strings from imports are never fetched remotely.
  const prefix = `/assets/${encodeURIComponent(worldId)}/`;
  if (!raw.startsWith(prefix) || /[?#\\]/.test(raw)) return null;
  try { const file = decodeURIComponent(raw.slice(prefix.length)); return file && !/[\/\\]/.test(file) && !file.includes('..') ? raw : null; } catch { return null; }
}

export function plainText(text, entities, gm) {
  const all = entities instanceof Map ? [...entities.values()] : entities || [];
  return String(text || '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, name, alias) => {
    const target = all.find(e => e.id === name || e.name?.toLowerCase() === name.trim().toLowerCase());
    return target && (gm || !target.gmOnly) ? alias || target.name : '[unavailable reference]';
  }).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/(\*\*|__|`)/g, '').replace(/\*([^*\n]+)\*/g, '$1').replace(/^>\s?/gm, '').replace(/\r\n?/g, '\n').normalize('NFC');
}

/** The ONLY input to layout/preview/PDF/PNG. Hidden blocks are removed before
 * image collection, text measurement, page counts or missing-asset warnings. */
export function projectHandout(entity, { entities = new Map(), worldId, gm = false } = {}) {
  if (!entity || (!gm && entity.gmOnly)) return null;
  const p = presentation(entity), byId = entities instanceof Map ? entities : new Map(entities.map(e => [e.id, e]));
  const visible = target => target && (gm || !target.gmOnly);
  const relation = (entity.relations || []).find(r => r.to === p.sourceId && r.secret);
  const source = (gm || !relation?.secret) && visible(byId.get(p.sourceId)) ? byId.get(p.sourceId) : null;
  const warnings = [], blocks = [];
  function add(block, role) {
    if (!block || (!gm && block.secret)) return;
    if (!['heading', 'text', 'quote'].includes(block.kind)) { warnings.push('A non-text block is available in the entry but is not part of this handout.'); return; }
    const raw = String(block.text || ''), pieces = raw.split(/(!\[[^\]]*\]\([^)]*\))/g);
    for (const piece of pieces) {
      const img = piece.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
      if (img) {
        const url = localAsset(img[2], worldId);
        if (url) blocks.push({ kind: 'image', url, alt: plainText(img[1], byId, gm), secret: !!block.secret });
        else warnings.push('An image was omitted because it is not a local asset in this world.');
      } else {
        const text = plainText(piece, byId, gm).trim();
        if (text) blocks.push({ kind: block.kind, role, text, secret: !!block.secret });
      }
    }
  }
  // A map fragment (1.9) stores a map entry ID and a crop, never pixels; output
  // renders the PLAYER map at export time, so it follows later map edits.
  if (p.map?.id) {
    const mapEntry = byId.get(p.map.id);
    if (mapEntry?.map && visible(mapEntry)) {
      const c = p.map.crop || {};
      const crop = [c.x ?? 0, c.y ?? 0, c.w ?? 1, c.h ?? 1].map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
      blocks.push({ kind: 'image', url: `mapfrag:${mapEntry.id}:${crop.join(',')}:${Math.max(0, Math.trunc(Number(p.map.level) || 0))}`, alt: 'A fragment of a map', tall: true, secret: false });
    } else warnings.push('The map for this fragment is hidden or missing, so it is left out.');
  }
  for (const block of entity.blocks || []) add(block, p.slots?.[block.id] || (block.kind === 'heading' ? 'heading' : 'body'));
  if (source) {
    blocks.push({ kind: 'heading', role: 'heading', text: plainText(source.name, byId, gm), secret: !!source.gmOnly || !!relation?.secret });
    for (const key of p.sourceFields || []) {
      const value = source.fields?.[key];
      if (value != null && String(value).trim()) blocks.push({ kind: 'text', role: 'body', text: plainText(`${key}: ${value}`, byId, gm), secret: !!source.gmOnly || !!relation?.secret });
    }
    for (const id of p.sourceBlocks || []) {
      const b = source.blocks?.find(b => b.id === id);
      if (b) add({ ...b, secret: b.secret || source.gmOnly || relation?.secret }, b.kind === 'heading' ? 'heading' : 'body');
    }
  }
  const image = localAsset(entity.image, worldId) || (p.sourceImage && source ? localAsset(source.image, worldId) : null);
  return { id: entity.id, title: blocks.find(b=>b.role==='title')?.text || plainText(entity.name, byId, gm), p, blocks: blocks.filter(b=>b.role!=='title'), image, gm: !!gm, warnings: [...new Set(warnings)] };
}
