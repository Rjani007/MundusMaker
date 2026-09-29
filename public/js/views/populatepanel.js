// The map editor's Populate section (1.9). Previews suggested people and
// places for a town's districts; Create writes GM-only entries, each related
// to the town and linked from a marker on a building of its district. Nothing
// is written before Create, and a role already filled is never offered again.
// GM view only. Shown for kinds with `populate` whose model has districts.

import { el, uid, toast } from '../util.js';
import { getEntity, newEntity, saveEntity } from '../state.js';
import { newMarker } from '../maps/mapcore.js';
import { populateSuggestions } from '../maps/populate.js';

/** ctx: { e, map, kind, model(), save(), redraw(), refreshLists(), locationType(), personType() } */
export function populatePanel(ctx) {
  const { e, map, kind } = ctx;
  const wrap = el('div', { class: 'populate-panel' });
  const filled = (key) => !!map.populated?.[key] && !!getEntity(map.populated[key]);
  const open = () => populateSuggestions(map, ctx.model(), kind.size(map), filled);

  function refresh() {
    wrap.replaceChildren();
    const count = open().length;
    const done = Object.keys(map.populated || {}).filter(filled).length;
    wrap.append(el('h3', {}, '👥 Populate'),
      el('p', { class: 'muted small' }, 'Drafts of people and places for this town’s districts. You see them first; created entries are GM-only until you reveal them.'),
      el('div', { class: 'row' },
        el('button', { disabled: !count, onclick: preview }, count ? `Suggest ${count} people and places…` : 'Every role is filled'),
        done ? el('span', { class: 'muted small' }, `${done} created so far`) : null));
  }

  function preview() {
    const suggestions = open();
    if (!suggestions.length) return;
    const rows = suggestions.map((s) => {
      const tick = el('input', { type: 'checkbox', checked: true, 'aria-label': `Create ${s.title}` });
      const name = el('input', { value: s.name, maxlength: 160, 'aria-label': `${s.title} name` });
      return { s, tick, name, node: el('label', { class: 'populate-row' }, tick,
        el('span', { class: 'populate-title' }, s.title), name,
        el('span', { class: 'muted small populate-blurb' }, s.blurb)) };
    });
    const byDistrict = new Map();
    for (const row of rows) {
      if (!byDistrict.has(row.s.district)) byDistrict.set(row.s.district, []);
      byDistrict.get(row.s.district).push(row.node);
    }
    const close = () => overlay.remove();
    const create = el('button', { class: 'primary', onclick: async () => {
      const chosen = rows.filter((r) => r.tick.checked && r.name.value.trim());
      if (!chosen.length) { close(); return; }
      create.disabled = true;
      try {
        await apply(chosen.map((r) => ({ ...r.s, name: r.name.value.trim() })));
        close();
      } catch (err) {
        create.disabled = false;
        toast(`Could not create them all: ${err.message}. Created entries are kept; try again for the rest.`, 6000);
      }
    } }, 'Create selected');
    const overlay = el('div', { class: 'overlay' }, el('div', { class: 'dialog populate-dialog', role: 'dialog', 'aria-modal': 'true' },
      el('h3', {}, `Populate ${e.name}`),
      el('p', { class: 'muted small' }, 'Untick anything you don’t want, and rename freely. Each one becomes a GM-only entry with a marker on a building in its district.'),
      [...byDistrict].map(([district, nodes]) => el('div', {}, el('h4', {}, district), nodes)),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'ghost', onclick: close }, 'Cancel'), create)));
    document.body.append(overlay);
  }

  async function apply(chosen) {
    for (const s of chosen) {
      if (filled(s.key)) continue; // another tab got there first
      let entry = newEntity(s.name, s.kind === 'npc' ? ctx.personType() : ctx.locationType());
      entry.gmOnly = true;
      if (s.kind === 'npc') { entry.fields.Role = s.title; entry.fields['Found at'] = `${s.district}, ${e.name}`; }
      else entry.fields.Kind = s.title;
      entry.blocks = [{ id: uid(), kind: 'text', text: s.blurb, secret: false },
        ...entry.blocks.filter((b) => b.kind !== 'text' || b.text?.trim())];
      entry.relations = [{ to: e.id, label: s.kind === 'npc' ? 'lives in' : 'located in', secret: false }];
      entry = await saveEntity(entry);
      // a marker linked to a GM-only entry is hidden from players automatically
      (map.markers ??= []).push(newMarker(s.x, s.y, { shape: s.kind === 'npc' ? 'dot' : 'square', color: s.kind === 'npc' ? '#e0a72c' : '#4a86e0', label: s.name, to: entry.id }));
      (map.populated ??= {})[s.key] = entry.id;
      ctx.save();
    }
    ctx.redraw();
    ctx.refreshLists();
    refresh();
    toast(`Created ${chosen.length} GM-only ${chosen.length === 1 ? 'entry' : 'entries'} with map markers.`, 4000);
  }

  refresh();
  return { element: wrap, refresh };
}
