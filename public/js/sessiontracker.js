import { el, uid, toast } from './util.js';
import { state, getEntity, scheduleSave } from './state.js';
import { trackerFor, activeIndex, trackerRound, stepTurn, sortInitiative, removeCombatant, adjustHp } from './trackercore.js';

// The entry page and Encounter tab edit the very same sessionTracker object.
export function sessionTracker(session, { compact = false } = {}) {
  const root = el('div', { class: `session-tracker${compact ? ' compact' : ''}` });
  if (!state.gm || session.type !== 'session') return { element: root, addRows: () => {} };
  const worldId = state.worldId;
  let tracker = trackerFor(session);
  if (!tracker || typeof tracker !== 'object' || Array.isArray(tracker) || (tracker.rows != null && (!Array.isArray(tracker.rows) || tracker.rows.some((row) => !row || typeof row !== 'object')))) {
    root.append(el('div', { class: 'notice warn' }, 'This session’s tracker could not be read. Its saved data has been left intact. Check the entry’s version history to recover an earlier copy.'));
    return { element: root, addRows: () => {} };
  }
  let undo = null;
  let summary, undoButton, previousButton;
  const amounts = new Map();
  const current = () => state.gm && state.worldId === worldId && getEntity(session.id) === session && root.isConnected;
  const save = () => { session.sessionTracker = tracker; scheduleSave(session); };
  const updateSummary = () => {
    const rows = tracker.rows || [];
    const active = rows[activeIndex(tracker)];
    summary.textContent = active ? `Round ${trackerRound(tracker)} · ${active.name || 'Unnamed combatant'}’s turn` : 'Ready when you are';
    undoButton.disabled = !undo;
    previousButton.disabled = !rows.length || (activeIndex(tracker) === 0 && trackerRound(tracker) === 1);
  };
  const edit = (fn) => {
    if (!current()) return;
    fn(); undo = null; save(); updateSummary();
  };
  const action = (fn, focusKey) => {
    if (!current()) return;
    const before = structuredClone(tracker);
    if (fn() === false) return;
    undo = before; save(); refresh(focusKey);
  };
  const addRows = (rows) => {
    if (!current() || !rows.length) return;
    if ((tracker.rows?.length || 0) + rows.length > 200) { toast('Keep a tracker to 200 combatants or fewer.'); return; }
    action(() => { (tracker.rows ??= []).push(...rows); }, `name-${(tracker.rows?.length || 0) + rows.length - 1}`);
  };

  function refresh(focusKey = document.activeElement?.dataset?.focusKey) {
    root.replaceChildren();
    const rows = tracker.rows || [];
    summary = el('div', { class: 'tracker-current', 'aria-live': 'polite' });
    undoButton = el('button', {
      type: 'button', class: 'ghost small', dataset: { focusKey: 'undo' },
      onclick: () => {
        if (!current() || !undo) return;
        tracker = undo; undo = null; save(); refresh('undo');
      },
    }, 'Undo last action');
    previousButton = el('button', { type: 'button', dataset: { focusKey: 'previous' }, onclick: () => action(() => stepTurn(tracker, -1), 'previous') }, '← Previous');
    root.append(el('div', { class: 'tracker-toolbar' },
      el('div', {}, el('span', { class: 'muted small' }, 'INITIATIVE & HP'), summary),
      el('div', { class: 'row' },
        el('label', { class: 'tracker-round' }, 'Round', el('input', {
          type: 'number', min: 1, step: 1, value: trackerRound(tracker), 'aria-label': 'Round',
          oninput: (ev) => {
            const value = ev.target.valueAsNumber;
            if (Number.isSafeInteger(value) && value >= 1) edit(() => { tracker.round = value; });
          },
        })),
        previousButton,
        el('button', { type: 'button', class: 'primary', disabled: !rows.length, dataset: { focusKey: 'next' }, onclick: () => action(() => stepTurn(tracker), 'next') }, 'Next turn →'))),
      el('div', { class: 'row tracker-tools' },
        el('button', { type: 'button', disabled: rows.length < 2, dataset: { focusKey: 'sort' }, title: 'Highest first; keeps the current combatant active', onclick: () => action(() => sortInitiative(tracker), 'sort') }, 'Sort initiative'),
        el('button', { type: 'button', dataset: { focusKey: 'add' }, onclick: () => addRows([{ id: uid(), name: '', initiative: '', hp: '', maxHp: '', conditions: '' }]) }, '+ Add combatant'),
        undoButton));
    updateSummary();
    if (!rows.length) root.append(el('div', { class: 'tracker-empty' },
      el('h3', {}, 'Bring the encounter to the table'),
      el('p', { class: 'muted' }, 'Add combatants, enter initiative, then use Next turn. HP and conditions save with this session.')));

    rows.forEach((row, index) => {
      let label = row.name || `Combatant ${index + 1}`;
      const active = index === activeIndex(tracker);
      const numberInput = (key, title) => el('input', {
        type: 'number', step: 1, value: row[key] ?? '', 'aria-label': `${title} — ${label}`,
        oninput: (ev) => {
          const value = ev.target.value === '' ? '' : ev.target.valueAsNumber;
          if (value === '' || Number.isSafeInteger(value)) {
            edit(() => { row[key] = value; });
            if (key === 'hp') updateHp();
          }
        },
      });
      const amount = el('input', { type: 'number', min: 1, step: 1, value: amounts.get(row.id ?? index) ?? 1, class: 'hp-amount', 'aria-label': `Damage or healing amount — ${label}`,
        oninput: (ev) => amounts.set(row.id ?? index, ev.target.value) });
      const changeHp = (direction) => {
        const value = amount.valueAsNumber;
        if (!Number.isSafeInteger(value) || value < 1) { toast('Enter a positive whole amount for damage or healing.'); amount.focus(); return; }
        action(() => adjustHp(row, direction * value), `${direction < 0 ? 'damage' : 'heal'}-${index}`);
      };
      const damage = el('button', { type: 'button', class: 'hp-damage', dataset: { focusKey: `damage-${index}` }, 'aria-label': `Apply damage — ${label}`, onclick: () => changeHp(-1) }, '− Damage');
      const heal = el('button', { type: 'button', class: 'hp-heal', dataset: { focusKey: `heal-${index}` }, 'aria-label': `Apply healing — ${label}`, onclick: () => changeHp(1) }, '+ Heal');
      const hpNote = el('span', { class: 'muted small' });
      const updateHp = () => {
        const known = row.hp !== '' && row.hp != null && Number.isSafeInteger(Number(row.hp));
        damage.disabled = heal.disabled = !known;
        hpNote.textContent = !known ? 'Enter current HP to adjust it.' : Number(row.hp) <= 0 ? `${row.hp} HP` : '';
      };
      updateHp();
      const source = row.to && getEntity(row.to);
      const item = el('section', { class: `tracker-combatant${active ? ' is-active' : ''}`, 'aria-label': label },
        el('div', { class: 'combatant-identity' },
          el('button', { type: 'button', class: 'tracker-turn', 'aria-label': `Set current turn — ${label}`, 'aria-pressed': String(active), onclick: () => action(() => { tracker.active = index; }) }, active ? '▶ Turn' : String(index + 1)),
          el('label', {}, 'Initiative', numberInput('initiative', 'Initiative')),
          el('label', { class: 'combatant-name' }, 'Combatant', el('input', {
            class: 'tracker-name', value: row.name || '', placeholder: 'Name', dataset: { focusKey: `name-${index}` },
            oninput: (ev) => {
              edit(() => { row.name = ev.target.value; });
              const next = row.name || `Combatant ${index + 1}`;
              item.setAttribute('aria-label', next);
              item.querySelectorAll('[aria-label]').forEach((node) => {
                node.setAttribute('aria-label', node.getAttribute('aria-label').replace(` — ${label}`, ` — ${next}`));
              });
              label = next;
            },
          })),
          source ? el('a', { class: 'small', href: `#/e/${encodeURIComponent(source.id)}` }, 'Open entry') : null,
          el('button', { type: 'button', class: 'ghost danger', 'aria-label': `Remove combatant — ${label}`, onclick: () => action(() => removeCombatant(tracker, index), 'add') }, '✕')),
        el('div', { class: 'combatant-details' },
          el('div', { class: 'tracker-health' },
            el('label', {}, 'Current HP', numberInput('hp', 'Current HP')),
            el('label', {}, 'Max HP', numberInput('maxHp', 'Max HP')),
            el('label', {}, 'Amount', amount), damage, heal, hpNote),
          el('label', { class: 'tracker-conditions' }, 'Conditions & reminders', el('input', {
            value: row.conditions || '', placeholder: 'Poisoned, concentrating, fleeing…',
            oninput: (ev) => edit(() => { row.conditions = ev.target.value; }),
          }))));
      root.append(item);
    });
    if (focusKey) root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
  refresh();
  return { element: root, addRows };
}
