// Cards from the library (the bundled SRD and imported 5etools packs): the
// Handouts page's picker and the Library page's ◇ Card button both end in
// makeLibraryCards. A row that already has a card reuses it, so picking the
// same sword twice never makes two.

import { el, uid } from '../util.js';
import { state, newEntity, saveEntity } from '../state.js';
import { COMPENDIUM, searchCompendium, rowSummary } from '../compendium.js';
import { libraryCard, isCardFor } from '../handouts/librarycards.js';
import { fitCard } from '../handouts/layout.js';
import { handoutMeasure } from '../handouts/output.js';

const cardFor = (kind, row) => [...state.entities.values()].find((e) => isCardFor(e, kind, row));

/** picks: [{ kind, row }]. Resolves to every card in pick order (new or
 * reused) and how many of them are new. Each card is sized to fit one slot. */
export async function makeLibraryCards(picks) {
  const wid = state.worldId, measure = await handoutMeasure(), cards = [];
  let made = 0;
  for (const { kind, row } of picks) {
    if (state.worldId !== wid) break;
    const found = cardFor(kind, row);
    if (found) { cards.push(found); continue; }
    const card = libraryCard(kind, row, newEntity(`${row.name} card`, 'handout'), uid);
    fitCard(card, measure, wid);
    await saveEntity(card);
    cards.push(card); made++;
  }
  return { cards, made };
}

/** The Handouts page's picker; onDone receives makeLibraryCards' result. */
export function openCardPicker(onDone) {
  let kind = 'item', query = '', filter = '', generation = 0;
  const picked = new Map(), keyOf = (k, row) => JSON.stringify([k, row._pack || '', row.name]);
  const list = el('div', { class: 'import-list card-picker-list' });
  const count = el('span', { class: 'muted small' });
  const status = el('p', { class: 'small muted', role: 'status' });
  const search = el('input', { type: 'search', placeholder: 'Search…', 'aria-label': 'Search the library', style: 'flex:1', oninput: () => { query = search.value; draw(); } });
  const filterSel = el('select', { 'aria-label': 'Narrow the list', onchange: () => { filter = filterSel.value; draw(); } });
  const make = el('button', { class: 'primary', disabled: true, onclick: () => run() }, 'Make cards');
  const kinds = Object.keys(COMPENDIUM);
  const tabs = el('div', { class: 'tool-row' }, kinds.map((key) => el('button', {
    type: 'button', onclick: () => { kind = key; query = filter = ''; search.value = ''; syncKind(); draw(); },
  }, COMPENDIUM[key].label)));

  function syncKind() {
    [...tabs.children].forEach((button, i) => { button.classList.toggle('on', kinds[i] === kind); button.setAttribute('aria-pressed', String(kinds[i] === kind)); });
    filterSel.replaceChildren(...COMPENDIUM[kind].filters.map(([value, label]) => el('option', { value }, label)));
  }
  function syncMake() {
    const n = picked.size;
    make.disabled = !n;
    make.textContent = n ? `Make ${n} ${n === 1 ? 'card' : 'cards'}` : 'Make cards';
  }
  async function draw() {
    const mine = ++generation, rowKind = kind;
    list.replaceChildren(el('div', { class: 'muted small' }, 'Loading…'));
    const rows = await searchCompendium(rowKind, query, filter);
    if (mine !== generation) return;
    count.textContent = `${rows.length} ${COMPENDIUM[rowKind].noun}`;
    list.replaceChildren();
    for (const row of rows.slice(0, 200)) {
      const key = keyOf(rowKind, row);
      const box = el('input', { type: 'checkbox', checked: picked.has(key), onchange: () => { if (box.checked) picked.set(key, { kind: rowKind, row }); else picked.delete(key); syncMake(); } });
      list.append(el('label', { class: 'import-row' }, box, el('span', {}, row.name),
        el('span', { class: 'muted small' }, rowSummary(rowKind, row)),
        cardFor(rowKind, row) ? el('span', { class: 'tag' }, 'has a card') : null));
    }
    if (!rows.length) list.append(el('div', { class: 'muted small' }, 'Nothing matches.'));
    if (rows.length > 200) list.append(el('div', { class: 'muted small' }, `Showing the first 200 of ${rows.length}. Narrow the search to see the rest.`));
  }
  async function run() {
    if (!state.gm) { status.textContent = 'Switch to GM view to make cards.'; return; }
    make.disabled = true;
    status.textContent = 'Making cards…';
    try {
      const result = await makeLibraryCards([...picked.values()]);
      close();
      onDone(result);
    } catch (err) {
      status.textContent = `Could not make the cards: ${err.message}`;
      syncMake();
    }
  }
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }

  const dialog = el('div', { class: 'dialog card-picker', role: 'dialog', 'aria-label': 'Cards from the library' },
    el('h3', {}, 'Cards from the library'),
    el('p', { class: 'muted small' }, 'Items, spells and monsters from the bundled SRD and your imported packs. Each one you pick becomes a card handout to edit, print or export as an image. A monster card shows players its name and kind; its numbers go in a 🔒 GM note.'),
    tabs,
    el('div', { class: 'row' }, search, filterSel, count),
    list, status,
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'ghost', onclick: close }, 'Cancel'), el('span', { class: 'spacer' }), make));
  const overlay = el('div', { class: 'overlay' }, dialog);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  syncKind();
  draw();
  search.focus();
}
