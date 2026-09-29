import { el, uid, toast, readSetting, writeSetting } from '../util.js';
import { state, getEntity, visibleEntities, newEntity, saveEntity } from '../state.js';
import { sessionTracker } from '../sessiontracker.js';
import { combatantFromEntity } from '../trackercore.js';
import { partyPanel } from '../party.js';

export function render(container, requestedId = '') {
  if (!state.gm) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice' }, '🔒 The Encounter tracker is available in GM view.')));
    return;
  }
  const worldId = state.worldId;
  const page = el('div', { class: 'page wide session-page encounter-page' });
  const current = () => state.gm && state.worldId === worldId && page.isConnected;
  const sessions = visibleEntities().filter((e) => e.type === 'session')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.name.localeCompare(b.name));
  let remembered = '';
  try { remembered = readSetting(`encounter.${worldId}`) || ''; } catch { /* private browser storage */ }
  const selected = requestedId || (sessions.some((e) => e.id === remembered) ? remembered : sessions[0]?.id);
  const session = sessions.find((e) => e.id === selected);
  const remember = (id) => { try { writeSetting(`encounter.${worldId}`, id); } catch { /* selection still works */ } };
  if (session) remember(session.id);
  const selector = el('select', { 'aria-label': 'Session to track', onchange: () => {
    if (!current() || !selector.value) return;
    location.hash = `#/encounter/${encodeURIComponent(selector.value)}`;
  } }, !session ? el('option', { value: '' }, 'Choose a session…') : null,
  sessions.map((e) => el('option', { value: e.id, selected: e.id === session?.id }, e.name)));
  const name = el('input', { required: true, maxlength: 160, placeholder: 'Session name', 'aria-label': 'New session name' });
  const createButton = el('button', { type: 'submit' }, 'Create session');
  const status = el('div', { class: 'muted small', 'aria-live': 'polite' });
  let draft = null, creating = false;
  const createForm = el('form', { class: 'row', onsubmit: async (ev) => {
    ev.preventDefault();
    if (!current() || creating || !name.value.trim()) return;
    creating = true; createButton.disabled = true; status.textContent = 'Saving…';
    name.disabled = true;
    draft ??= newEntity(name.value.trim(), 'session');
    // Worlds can customize or remove their type definitions. A tracker always
    // belongs to a Session, even if that type is currently absent from the menu.
    draft.type = 'session'; draft.name = name.value.trim(); draft.gmOnly = true;
    try {
      await saveEntity(draft);
      if (current()) location.hash = `#/encounter/${encodeURIComponent(draft.id)}`;
    } catch (err) { if (current()) status.textContent = `Could not save: ${err.message}. Retry to save this session.`; }
    finally { creating = false; createButton.disabled = false; name.disabled = false; }
  } }, name, createButton);
  page.append(el('div', { class: 'session-page-head' },
    el('div', {}, el('div', { class: 'session-eyebrow' }, '🔒 GM WORKSPACE'), el('h1', {}, 'Encounter'),
      el('p', { class: 'muted' }, 'Initiative, turns, health, and conditions — saved with your session.')),
    el('a', { href: '#/dm-screen' }, 'Open DM Screen →')),
    el('div', { class: 'card encounter-session' },
      el('div', { class: 'row' }, el('label', {}, 'Session', selector),
        session ? el('a', { href: `#/e/${encodeURIComponent(session.id)}` }, 'Open session notes →') : null),
      el('details', { open: !sessions.length }, el('summary', {}, 'New session'), createForm,
        el('p', { class: 'muted small' }, '🔒 New sessions start GM-only. You can share their notes later from the entry page.'), status)));
  container.append(page);
  if (!session) {
    page.append(el('div', { class: 'notice' }, requestedId
      ? 'That session was removed or could not be loaded. Choose another session above, or create one.'
      : 'Create a session above to start tracking your encounter.'));
    return;
  }
  const tracker = sessionTracker(session);
  const search = el('input', { type: 'search', placeholder: 'Search characters or creatures…', 'aria-label': 'Find a combatant entry', oninput: () => refreshChoices() });
  const choices = el('select', { 'aria-label': 'Combatant entry' });
  const quantity = el('input', { type: 'number', min: 1, max: 200, step: 1, value: 1, 'aria-label': 'Number of combatants' });
  const add = el('button', { type: 'button', onclick: () => {
    if (!current()) return;
    const source = getEntity(choices.value), count = quantity.valueAsNumber;
    if (!source) return;
    if (!Number.isSafeInteger(count) || count < 1 || count > 200) { toast('Choose between 1 and 200 combatants.'); return; }
    tracker.addRows(Array.from({ length: count }, (_, i) => ({ ...combatantFromEntity(source, uid()), name: count > 1 ? `${source.name} ${i + 1}` : source.name })));
  } }, 'Add from entry');
  function refreshChoices() {
    const chosen = choices.value, query = search.value.trim().toLowerCase();
    const entries = visibleEntities().filter((e) => (['character', 'npc', 'creature'].includes(e.type)
      || e.blocks?.some((b) => ['statblock', 'sheet'].includes(b.kind))) && e.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
    choices.replaceChildren(...entries.map((e) => el('option', { value: e.id }, e.name)));
    if (entries.some((e) => e.id === chosen)) choices.value = chosen;
    if (!entries.length) choices.append(el('option', { value: '' }, 'No matching entries'));
    add.disabled = !entries.length;
  }
  const additions = el('details', { class: 'encounter-additions' }, el('summary', {}, 'Add from your world'),
    el('div', { class: 'reference-picker' }, search, choices, quantity, add),
    el('p', { class: 'muted small' }, 'Copies starting HP from a statblock or D&D sheet when available. Encounter damage stays in this session; the source entry is unchanged.'));
  const prepared = visibleEntities().flatMap((e) => (e.blocks || [])
    .filter((b) => b.kind === 'encounter' && b.enc?.rows?.length).map((b, i) => ({ entity: e, block: b, label: `${e.name} · Encounter ${i + 1}` })));
  if (prepared.length) {
    const picker = el('select', { 'aria-label': 'Prepared encounter' }, prepared.map((p, i) => el('option', { value: i }, p.label)));
    additions.append(el('div', { class: 'row' }, el('label', {}, 'Prepared encounter', picker), el('button', { type: 'button', onclick: () => {
      if (!current()) return;
      const chosen = prepared[Number(picker.value)], rows = [];
      if (!chosen || getEntity(chosen.entity.id) !== chosen.entity) return;
      for (const row of chosen.block.enc.rows) {
        const count = row.count == null || row.count === '' ? 1 : Number(row.count);
        if (!Number.isSafeInteger(count) || count < 1 || rows.length + count > 200) { toast('Each prepared count must be a whole number, with 200 combatants or fewer in total.'); return; }
        const source = row.to && getEntity(row.to);
        for (let i = 0; i < count; i++) {
          const name = source?.name || row.name || 'Unnamed combatant';
          rows.push({ ...combatantFromEntity(source, uid()), name: count > 1 ? `${name} ${i + 1}` : name });
        }
      }
      tracker.addRows(rows);
    } }, 'Add prepared combatants')));
  }
  page.querySelector('.encounter-session').append(additions);
  page.append(tracker.element, partyPanel({ current }).element);
  refreshChoices();
}
