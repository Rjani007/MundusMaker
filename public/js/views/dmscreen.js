import { el, uid, toast, rollDice, compareNames } from '../util.js';
import { partyPanel } from '../party.js';
import { state, getEntity, visibleEntities, typeOf, newEntity, saveEntity, scheduleSave, scheduleWorldSave } from '../state.js';
import { mdToHtml } from '../render.js';
import { statblockHtml } from '../statblock.js';
import { randomTableHtml, rollRandomTable } from '../randomtable.js';
import { referenceBrowser } from './referencebrowser.js';

export function render(container) {
  if (!state.gm) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice' }, '🔒 The DM Screen is available in GM view.')));
    return;
  }
  const world = state.world, worldId = state.worldId;
  const page = el('div', { class: 'page wide session-page' });
  const current = () => state.gm && state.worldId === worldId && state.world === world && page.isConnected;
  // Store only entry IDs. References stay current when an entry is edited,
  // and missing entries cannot leak an old cached name in player preview.
  const pins = () => Array.isArray(world.dmScreen?.pins) ? world.dmScreen.pins : [];
  const setPins = (next) => {
    if (!current()) return;
    world.dmScreen = { ...world.dmScreen, pins: next };
    scheduleWorldSave(); refreshCards(); refreshPicker(); readyRules.refresh();
  };
  const pin = (id) => {
    if (!current() || !getEntity(id)) return;
    if (pins().includes(id)) { toast('That entry is already on your screen.'); return; }
    setPins([...pins(), id]);
  };
  const readyRules = referenceBrowser({ current, pin, pins });
  const cards = el('div', { class: 'dm-grid' });
  const count = el('span', { class: 'muted small', 'aria-live': 'polite' });
  const search = el('input', { type: 'search', placeholder: 'Search names or tags…', 'aria-label': 'Find a reference to pin', oninput: () => refreshPicker() });
  const choices = el('select', { 'aria-label': 'Entry to pin' });
  const pinButton = el('button', { type: 'button', onclick: () => pin(choices.value) }, 'Pin entry');
  function refreshPicker() {
    const selected = choices.value, query = search.value.trim().toLowerCase();
    const entries = visibleEntities().filter((e) => !pins().includes(e.id)
      && [e.name, ...(e.tags || [])].join(' ').toLowerCase().includes(query))
      .sort((a, b) => compareNames(a.name, b.name));
    choices.replaceChildren(...entries.slice(0, 200).map((e) => el('option', { value: e.id }, `${e.name} · ${typeOf(e).label}`)));
    if (entries.slice(0, 200).some((e) => e.id === selected)) choices.value = selected;
    pinButton.disabled = !entries.length;
    if (!entries.length) choices.append(el('option', { value: '' }, 'No matching entries'));
  }

  function blockView(entity, block) {
    const wrap = el('div', { class: `dm-block${block.secret ? ' dm-secret-block' : ''}` });
    if (block.secret) wrap.append(el('span', { class: 'muted small' }, '🔒 Secret block'));
    const body = el('div', { class: 'block-content' });
    if (['text', 'heading', 'quote'].includes(block.kind)) {
      if (!block.text?.trim()) return null;
      if (block.kind === 'heading') body.append(el('h3', {}, block.text));
      else {
        const text = el(block.kind === 'quote' ? 'blockquote' : 'div', {});
        text.innerHTML = mdToHtml(block.text);
        body.append(text);
      }
      const edit = el('button', { type: 'button', class: 'ghost small dm-edit', 'aria-label': `Edit ${block.kind} in ${entity.name}`, onclick: () => {
        if (!current() || getEntity(entity.id) !== entity) return;
        const input = el('textarea', { rows: 7, 'aria-label': `Text in ${entity.name}`, oninput: () => {
          if (!current() || getEntity(entity.id) !== entity) return;
          block.text = input.value; scheduleSave(entity);
        } });
        input.value = block.text || '';
        wrap.replaceChildren(input, el('button', { type: 'button', class: 'small', onclick: () => { if (current()) refreshCards(); } }, 'Done'));
        input.focus();
      } }, 'Edit text');
      wrap.append(body, edit);
    } else if (block.kind === 'statblock') {
      body.innerHTML = statblockHtml(block.stat, entity.name); wrap.append(body);
    } else if (block.kind === 'table') {
      body.innerHTML = randomTableHtml(block.table);
      body.querySelector('[data-table-roll]')?.addEventListener('click', () => {
        if (!current()) return;
        const result = rollRandomTable(block.table);
        body.querySelector('[data-table-result]').textContent = result?.text || 'No enabled rows to roll.';
      });
      wrap.append(body);
    } else {
      wrap.append(el('a', { href: `#/e/${encodeURIComponent(entity.id)}`, class: 'small' },
        block.kind === 'sheet' ? 'Open character sheet →' : block.kind === 'encounter' ? 'Open prepared encounter →' : 'Open this block in the entry →'));
    }
    return wrap;
  }

  function refreshCards() {
    const ids = pins();
    count.textContent = `${ids.length} pinned ${ids.length === 1 ? 'entry' : 'entries'}`;
    cards.replaceChildren();
    if (!ids.length) {
      cards.append(el('div', { class: 'dm-empty' }, el('h2', {}, 'Your references, within reach'),
        el('p', {}, 'Choose a ready-written rule above, pin an entry from your world, or write a reference below.'),
        el('p', { class: 'muted small' }, 'Your screen is saved with this world. Pinned entries stay up to date as you edit them.')));
    }
    ids.forEach((id, index) => {
      const entity = getEntity(id), name = entity?.name || 'Missing entry';
      const kind = entity?.tags?.includes('rules-reference') ? 'Rules reference'
        : entity?.tags?.includes('cheat-sheet') ? 'Cheat sheet' : entity ? typeOf(entity).label : '';
      const move = (delta) => {
        const next = [...pins()], other = index + delta;
        if (next[index] !== id || other < 0 || other >= next.length) return;
        [next[index], next[other]] = [next[other], next[index]]; setPins(next);
        cards.children[other]?.querySelector('a, button')?.focus();
      };
      const body = el('div', { class: 'dm-card-body', tabindex: 0, 'aria-label': `${name} reference` });
      if (entity) {
        const facts = Object.entries(entity.fields || {}).filter(([, v]) => v != null && String(v).trim());
        if (facts.length) body.append(el('dl', { class: 'dm-facts' }, facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])));
        for (const block of entity.blocks || []) {
          const view = blockView(entity, block);
          if (view) body.append(view);
        }
        if (!body.childElementCount) body.append(el('p', { class: 'muted' }, 'This entry has no reference text yet. Open the entry to add notes or a statblock.'));
      } else body.append(el('p', { class: 'muted' }, 'This entry was removed or could not be loaded. You can unpin it or check Settings → Recovery.'));
      cards.append(el('article', { class: 'dm-card', 'aria-label': name },
        el('div', { class: 'dm-card-head' },
          el('div', { class: 'dm-card-title' }, el('span', { class: 'muted small' }, entity ? `${entity.gmOnly ? '🔒 ' : ''}${kind}` : 'Reference unavailable'),
            el('h2', {}, entity ? el('a', { href: `#/e/${encodeURIComponent(id)}`, title: 'Open entry' }, name) : name)),
          el('div', { class: 'dm-card-actions' },
            el('button', { type: 'button', class: 'ghost small', disabled: index === 0, 'aria-label': `Move ${name} earlier`, onclick: () => move(-1) }, '←'),
            el('button', { type: 'button', class: 'ghost small', disabled: index === ids.length - 1, 'aria-label': `Move ${name} later`, onclick: () => move(1) }, '→'),
            el('button', { type: 'button', class: 'ghost small', 'aria-label': `Unpin ${name}`, title: 'Unpin (keeps the entry)', onclick: () => setPins(pins().filter((key) => key !== id)) }, '✕'))), body));
    });
  }

  const title = el('input', { required: true, maxlength: 160, placeholder: 'e.g. Travel cheat sheet', 'aria-label': 'Reference title' });
  const category = el('select', { 'aria-label': 'Reference kind' },
    el('option', { value: 'note' }, 'Note'), el('option', { value: 'rules-reference' }, 'Rules reference'), el('option', { value: 'cheat-sheet' }, 'Cheat sheet'));
  const content = el('textarea', { rows: 5, required: true, placeholder: 'Write your reference. Markdown and [[wiki-links]] work here.', 'aria-label': 'Reference text' });
  const source = el('input', { placeholder: 'Optional book and page', 'aria-label': 'Reference source' });
  const createButton = el('button', { type: 'submit', class: 'primary' }, 'Create & pin');
  const status = el('span', { class: 'small', 'aria-live': 'polite' });
  let draft = null, creating = false;
  const form = el('form', { class: 'dm-create-form', onsubmit: async (ev) => {
    ev.preventDefault();
    if (!current() || creating || !title.value.trim() || !content.value.trim()) return;
    creating = true; createButton.disabled = true; status.textContent = 'Saving…';
    [title, category, content, source].forEach((input) => { input.disabled = true; });
    draft ??= newEntity(title.value.trim(), 'note');
    draft.name = title.value.trim(); draft.gmOnly = true;
    draft.tags = category.value === 'note' ? [] : [category.value];
    draft.fields = source.value.trim() ? { Source: source.value.trim() } : {};
    draft.blocks = [{ id: draft.blocks[0]?.id || uid(), kind: 'text', text: content.value, secret: false }];
    try {
      await saveEntity(draft);
      if (!current()) return;
      pin(draft.id); draft = null; form.reset(); status.textContent = 'Created and pinned. 🔒 Only visible to the GM.';
    } catch (err) { if (current()) status.textContent = `Could not save: ${err.message}. Your text is still here; retry when ready.`; }
    finally { creating = false; createButton.disabled = false; [title, category, content, source].forEach((input) => { input.disabled = false; }); }
  } }, el('div', { class: 'reference-picker' }, title, category), content,
  el('div', { class: 'row' }, source, createButton, status),
  el('p', { class: 'muted small' }, '🔒 New references are GM-only Note entries. You can edit them here or open them from the sidebar.'));

  const dice = el('input', { value: 'd20', 'aria-label': 'Dice expression', placeholder: '2d6+3' });
  const result = el('output', { class: 'dm-dice-result', 'aria-live': 'polite' }, 'Ready to roll');
  const roll = (notation = dice.value) => {
    if (!current()) return;
    dice.value = notation;
    const value = rollDice(notation);
    result.textContent = value ? `${notation}: ${value.total} · Kept ${value.kept.join(', ')}${value.dropped.length ? `; dropped ${value.dropped.join(', ')}` : ''}${value.mod ? `; modifier ${value.mod > 0 ? '+' : ''}${value.mod}` : ''}` : 'Try d20, 2d6+3, or 2d20kh1.';
  };
  page.append(el('div', { class: 'session-page-head' },
    el('div', {}, el('div', { class: 'session-eyebrow' }, '🔒 GM WORKSPACE'), el('h1', {}, 'DM Screen'),
      el('p', { class: 'muted' }, 'Rules, cheat sheets, notes, and statblocks for the session ahead.')),
    el('a', { href: '#/encounter' }, 'Open Encounter →')),
    el('div', { class: 'card' }, el('h3', {}, 'Pin a reference'),
      readyRules.element,
      el('h4', {}, 'From your world'),
      el('div', { class: 'reference-picker' }, search, choices, pinButton),
      el('p', { class: 'muted small' }, 'Choose an entry from this world. Find more statblocks and spells in the ', el('a', { href: '#/library' }, 'Library'), '.')),
    partyPanel({ current }).element,
    el('div', { class: 'dm-section-head' }, el('h2', {}, 'On your screen'), count), cards,
    el('div', { class: 'dm-bottom' },
      el('details', { class: 'card dm-create' }, el('summary', {}, 'New reference or note'), form),
      el('div', { class: 'card dm-dice' }, el('h3', {}, 'Quick dice'),
        el('form', { class: 'row', onsubmit: (ev) => { ev.preventDefault(); roll(); } }, dice, el('button', { type: 'submit' }, 'Roll')),
        el('div', { class: 'row' }, ['d20', '2d20kh1', '2d20kl1', '2d6'].map((notation) => el('button', { type: 'button', class: 'small ghost', onclick: () => roll(notation) }, notation))),
        result, el('p', { class: 'muted small' }, 'kh1 keeps the highest die; kl1 keeps the lowest.'))));
  container.append(page); refreshPicker(); refreshCards();
}
