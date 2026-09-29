// The map editor's Key panel (1.9): GM notes on rooms, settlements, landmarks
// and hexes. Driven entirely by the kind's `keys` hooks (mapkeys.js), so the
// editor still never branches on map.kind. GM view only.

import { el, uid, toast } from '../util.js';
import { getEntity, newEntity, saveEntity, scheduleSave } from '../state.js';
import { resolveKeys, keySpace, anchorFallbackLabel } from '../maps/mapkeys.js';

/**
 * ctx: { e, map, kind, model(), level(), save(), redraw(), locationType(), useKeyTool() }
 * save() records map history and schedules the entry; note text edits skip
 * history (they change a block, not the map).
 */
export function mapKeyPanel(ctx) {
  const { e, map, kind } = ctx;
  const wrap = el('div', { class: 'mapkey-panel' });
  let resolved = { placed: [], unplaced: [] };
  let reanchor = null; // anchor waiting for a new place
  const multiLevel = () => (kind.levelCount ? kind.levelCount(map) : 1) > 1;
  const placeName = (place) => (multiLevel() ? `Level ${place.level + 1}, ${place.label.toLowerCase()}` : place.label);

  function resolveAll() {
    resolved = resolveKeys(map, kind, (level) => (level === ctx.level() ? ctx.model() : kind.buildModel(map, level)));
  }

  function noteEditor(target, anchor) {
    if (target.entity) {
      const linked = getEntity(target.entity);
      return linked
        ? el('div', { class: 'small' }, 'Its own entry: ', el('a', { href: `#/e/${encodeURIComponent(linked.id)}` }, linked.name))
        : el('div', { class: 'small muted' }, 'Its entry was deleted. Remove the anchor, or add a new note.');
    }
    const block = (e.blocks || []).find((b) => b.id === target.block);
    if (!block) return el('div', { class: 'small muted' }, 'This note was deleted from the entry page.');
    return el('div', {},
      el('textarea', {
        class: 'mapkey-note', rows: 3, 'data-anchor': anchor,
        placeholder: 'What is here: occupants, treasure, traps, secrets…',
        oninput: (ev) => { block.text = ev.target.value; scheduleSave(e); },
      }, block.text || ''),
      el('div', { class: 'muted small' }, block.secret ? '🔒 Secret note: players never see it. Reveal it on the entry page to share it.' : '👁 Revealed: players see this note on the entry page.'));
  }

  async function promote(anchor, place, target) {
    const block = (e.blocks || []).find((b) => b.id === target.block);
    if (!block) return;
    const name = place.n ? `${e.name}, ${placeName(place).toLowerCase()}` : place.hex ? `${e.name}, ${place.label.toLowerCase()}` : place.label;
    if (!confirm(`Make “${name}” its own GM-only entry? The note moves there, and this key points at it.`)) return;
    try {
      let entry = newEntity(name, ctx.locationType());
      entry.gmOnly = true;
      entry.blocks = [block, ...entry.blocks.filter((b) => b.text?.trim() || b.kind !== 'text')];
      entry.relations = [{ to: e.id, label: 'located in', secret: false }];
      entry = await saveEntity(entry);
      e.blocks = e.blocks.filter((b) => b.id !== block.id);
      map.keys[anchor] = { entity: entry.id };
      ctx.save();
      refresh();
      toast(`Created ${entry.name}. The note moved there.`);
    } catch (err) {
      toast(`Could not create the entry: ${err.message}`);
    }
  }

  function removeAnchor(anchor) {
    delete map.keys[anchor];
    if (!Object.keys(map.keys).length) delete map.keys;
    ctx.save();
    refresh();
    ctx.redraw();
    toast('Anchor removed. The note itself stays on the entry page.');
  }

  function row(anchor, target, place) {
    return el('div', { class: 'mapkey-row' },
      el('div', { class: 'mapkey-head' },
        el('strong', {}, place ? placeName(place) : anchorFallbackLabel(anchor)),
        el('span', { class: 'spacer' }),
        place && target.block && (e.blocks || []).some((b) => b.id === target.block)
          ? el('button', { class: 'ghost small', title: 'Give this place its own GM-only entry, and move the note there', onclick: () => promote(anchor, place, target) }, 'Promote to entry')
          : null,
        place ? null : el('button', { class: 'ghost small', title: 'Click the place on the map this note belongs to now', onclick: () => {
          reanchor = anchor;
          ctx.useKeyTool();
          toast('Click the room or place this note belongs to now.', 5000);
        } }, 'Re-anchor'),
        el('button', { class: 'ghost small', title: 'Detach the note from the map. The note stays on the entry page.', onclick: () => removeAnchor(anchor) }, 'Remove anchor')),
      noteEditor(target, anchor));
  }

  function refresh() {
    resolveAll();
    wrap.replaceChildren();
    wrap.append(el('h3', {}, '🗝 Map key'),
      el('p', { class: 'muted small' }, 'Notes on the places this map generated. Pick 🗝 Key, then click a room, settlement, landmark or hex. Notes are secret blocks on this entry; the GM PDF prints them as the map’s key.'));
    const level = ctx.level();
    const places = kind.keys.places(map, ctx.model(), level, keySpace(kind, map));
    const keyed = new Set(resolved.placed.map((p) => p.place.anchor));
    const open = places.filter((p) => !keyed.has(p.anchor));
    if (open.length && open.length <= 60) {
      wrap.append(el('div', { class: 'mapkey-chips' }, el('span', { class: 'muted small' }, 'Add a note to: '),
        open.map((place) => el('button', { class: 'ghost small', onclick: () => pick(place) }, place.label))));
    }
    const here = resolved.placed.filter((p) => p.place.level === level);
    for (const { anchor, target, place } of here) wrap.append(row(anchor, target, place));
    const elsewhere = resolved.placed.length - here.length;
    if (elsewhere) wrap.append(el('p', { class: 'muted small' }, `${elsewhere} more ${elsewhere === 1 ? 'note is' : 'notes are'} on other levels.`));
    if (resolved.unplaced.length) {
      wrap.append(el('h4', {}, 'Unplaced notes'),
        el('p', { class: 'muted small' }, 'These places changed: a room was repainted, a site was hidden or regenerated, or the hex grid is off. Nothing was deleted. Re-anchor a note or remove its anchor.'));
      for (const { anchor, target } of resolved.unplaced) wrap.append(row(anchor, target, null));
    }
  }

  /** The key tool clicked a place: re-anchor a waiting note, open an
   *  existing one, or start a new secret note. */
  function pick(place) {
    const existing = resolved.placed.find((p) => p.place.anchor === place.anchor);
    if (reanchor) {
      const from = reanchor;
      reanchor = null;
      if (existing) { toast(`${place.label} already has a note. Remove its anchor first.`); return; }
      map.keys[place.anchor] = map.keys[from];
      delete map.keys[from];
      ctx.save();
      refresh();
      ctx.redraw();
      toast(`Note re-anchored to ${place.label}.`);
      return;
    }
    if (!existing) {
      const block = { id: uid(), kind: 'text', text: '', secret: true };
      (e.blocks ??= []).push(block);
      (map.keys ??= {})[place.anchor] = { block: block.id };
      ctx.save();
      refresh();
      ctx.redraw();
    }
    const box = [...wrap.querySelectorAll('textarea.mapkey-note')].find((t) => t.dataset.anchor === (existing?.anchor || place.anchor));
    // after the canvas click's own mousedown, which would take focus back
    if (box) setTimeout(() => { box.focus(); box.scrollIntoView({ block: 'nearest' }); }, 30);
  }

  return {
    element: wrap,
    refresh,
    pick,
    placedOn: (level) => resolved.placed.filter((p) => p.place.level === level),
  };
}
