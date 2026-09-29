import { el, toast } from '../util.js';
import { state, types, visibleEntities, saveWorld, emit } from '../state.js';
import { categoryKey, categoryGroups } from '../categorycore.js';

export function render(container) {
  const world = state.world, wid = state.worldId;
  const page = el('div', { class: 'page wide categories-page' });
  const list = el('div', { class: 'category-cards' });
  const search = el('input', { type: 'search', placeholder: 'Find a category…', 'aria-label': 'Find a category', oninput: draw });
  const status = el('p', { class: 'small', role: 'status' });
  async function persist(button) {
    if (!state.gm || state.worldId !== wid) return;
    button.disabled = true;
    try { await saveWorld(); emit('categories'); status.textContent = 'Categories saved.'; draw(); return true; }
    catch (err) { status.textContent = `Could not save: ${err.message}`; return false; }
    finally { button.disabled = false; }
  }
  function editor(key, t = {}) {
    let pendingKey = key;
    const name = el('input', { value: t.label || '', placeholder: 'God', required: true, maxLength: 70 });
    const plural = el('input', { value: t.plural || '', placeholder: 'Gods', maxLength: 70 });
    const color = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#b48cf2' });
    const fields = el('input', { value: (t.fields || []).join(', '), placeholder: 'Domain, Symbol, Pantheon' });
    const submit = el('button', { class: 'primary', type: 'submit' }, key ? 'Save category' : 'Create category');
    const form = el('form', { class: 'category-form', onsubmit: async ev => {
      ev.preventDefault();
      if (!state.gm || state.worldId !== wid || !name.value.trim()) return;
      const typeKey = pendingKey || categoryKey(plural.value.trim() || name.value, types());
      pendingKey = typeKey;
      world.types = { ...types(), [typeKey]: { ...t, label: name.value.trim(), plural: plural.value.trim() || name.value.trim(),
        color: color.value, fields: [...new Set(fields.value.split(',').map(s => s.trim()).filter(Boolean))] } };
      const saved = await persist(submit);
      if (!key && saved) { pendingKey = null; name.value = ''; plural.value = ''; fields.value = ''; toast('Category created.'); }
    } },
    el('label', {}, 'Singular name', name), el('label', {}, 'Category name', plural),
    el('label', {}, 'Color', color), el('label', {}, 'Suggested quick facts (comma separated)', fields), submit);
    return form;
  }
  function draw() {
    const entities = visibleEntities();
    list.replaceChildren();
    for (const [key, t] of categoryGroups(types(), entities)) {
      if (!`${t.label} ${t.plural}`.toLowerCase().includes(search.value.toLowerCase())) continue;
      const n = entities.filter(e => (e.type || '') === key).length;
      const card = el('section', { class: 'card category-card', style: `border-top:3px solid ${t.color}` },
        el('a', { class: 'category-title', href: `#/t/${encodeURIComponent(key)}` }, t.plural || t.label),
        el('p', { class: 'muted small' }, `${n} ${n === 1 ? 'entry' : 'entries'}`));
      if (state.gm && Object.hasOwn(types(), key)) {
        const keys = Object.keys(types()), index = keys.indexOf(key);
        const move = direction => async ev => {
          if (!state.gm || state.worldId !== wid) return;
          const order = Object.entries(types()), i = order.findIndex(([k]) => k === key);
          if (!order[i + direction]) return;
          [order[i], order[i + direction]] = [order[i + direction], order[i]];
          world.types = Object.fromEntries(order); await persist(ev.currentTarget);
        };
        card.append(el('div', { class: 'row' },
          el('button', { class: 'small ghost', disabled: index === 0, onclick: move(-1), 'aria-label': `Move ${t.plural || t.label} earlier` }, '↑ Earlier'),
          el('button', { class: 'small ghost', disabled: index === keys.length - 1, onclick: move(1), 'aria-label': `Move ${t.plural || t.label} later` }, '↓ Later')),
          el('details', {}, el('summary', {}, 'Edit category'), editor(key, t)));
      }
      list.append(card);
    }
    if (!list.childElementCount) list.append(el('p', { class: 'muted' }, 'No categories match.'));
  }
  page.append(el('h1', {}, 'Categories'), el('p', { class: 'muted' }, 'Organize this world your way. Gods, guilds, factions, places—each category has its own page and quick facts.'), search);
  if (state.gm) page.append(el('details', { class: 'card', open: false }, el('summary', {}, '+ New category'), editor()));
  page.append(status, list);
  container.append(page); draw();
}
