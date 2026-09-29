// Character creation wizards: #/create picks a game system, #/create/<system>
// walks its steps. This closure holds the draft. Finish creates one character
// entity with a sheet block; earlier steps write no entity data.

import { el, uid, toast } from '../util.js';
import { state, types, newEntity, saveEntity } from '../state.js';
import { SHEET_SYSTEMS } from '../sheets/sheetcore.js';

export function render(container, systemKey) {
  if (!state.gm) {
    container.append(el('div', { class: 'page' }, el('h1', {}, 'Character creator'), el('p', { class: 'notice' }, 'Switch to GM view to create or resume a character.')));
    return;
  }
  if (!systemKey) return renderPicker(container);
  const sys = SHEET_SYSTEMS[systemKey];
  if (!sys) {
    container.append(el('div', { class: 'page' },
      el('div', { class: 'notice warn' }, `Unknown game system “${systemKey}”. `, el('a', { href: '#/create' }, 'Pick one here.'))));
    return;
  }
  return renderWizard(container, systemKey, sys);
}

function renderPicker(container) {
  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Create a character'),
    el('p', { class: 'muted' }, 'Pick a game and the builder walks you through the whole character, checking the rules as it goes. What comes out is an ordinary entry with a playable sheet on it.'),
    el('div', { class: 'edition-cards', style: 'grid-template-columns:1fr' },
      Object.entries(SHEET_SYSTEMS).map(([key, sys]) => el('a', {
        class: 'edition-card', href: `#/create/${key}`, style: 'display:block;text-decoration:none;color:inherit',
      },
        el('div', { style: 'font-weight:600;font-size:17px' }, sys.label),
        el('div', { class: 'muted small' }, sys.tagline)))),
    el('p', { class: 'muted small' },
      'Already know exactly what you want? Any entry can carry a blank sheet instead: open it and press + 🎭 Sheet.')));
}

function renderWizard(container, systemKey, sys) {
  const worldId = state.worldId;
  const storageKey = `mundusmaker.character-draft.${worldId}.${systemKey}`;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { /* unavailable storage */ }
  // Older releases kept one draft per system. Adopt it into the current world
  // once, writing the new copy before removing the old key.
  if (!saved) try {
    const legacyKey = `mundusmaker.character-draft.${systemKey}`;
    const legacy = JSON.parse(sessionStorage.getItem(legacyKey) || 'null');
    if (legacy?.version === 1 && legacy.draft && typeof legacy.draft === 'object' && !Array.isArray(legacy.draft)) {
      const steps = systemKey === 'dnd2024' ? ['species', 'class', 'abilities', 'background', 'skills', 'equipment', ...(legacy.draft.klass?.spellcasting ? ['spells'] : []), 'review']
        : sys.wizard.steps.filter(s => !s.when || s.when(legacy.draft)).map(s => s.key);
      saved = { version: 2, draft: legacy.draft, stepKey: steps[legacy.stepIdx] || steps[0] };
      if (systemKey === 'dnd2024') {
        saved.draft.languages ??= ['Common Sign Language', 'Elvish'];
        if (saved.draft.bgBonus?.mode === '1+1+1') saved.draft.bgBonus.three ??= (saved.draft.background?.abilities || []).slice(0, 3);
        saved.draft.spellbook ??= [...(saved.draft.spells || [])];
      }
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
      sessionStorage.removeItem(legacyKey);
    }
  } catch { /* Keep the original if browser storage is unavailable. */ }
  const draft = saved?.version === 2 && saved.draft && typeof saved.draft === 'object' && !Array.isArray(saved.draft) ? saved.draft : {};
  let stepKey = saved?.stepKey || sys.wizard.steps[0].key, data = null, alive = true, finished = false, busy = false, pendingEntity = null;
  let touched = Boolean(saved);
  const rail = el('nav', { class: 'wiz-rail', 'aria-label': 'Character creation steps' });
  const body = el('div', { class: 'wiz-body' });
  const summary = el('aside', { class: 'creator-summary', 'aria-label': 'Character summary' });
  const status = el('span', { class: 'small muted', role: 'status' }, saved ? 'Draft resumed in this world.' : 'Draft saves in this browser tab.');
  const error = el('div', { class: 'notice warn creator-error', role: 'alert', hidden: true });
  const progress = el('span', { class: 'small muted' });
  const previous = el('button', { class: 'ghost', disabled: true }, '← Back');
  const next = el('button', { class: 'primary', disabled: true }, 'Next →');
  const stepList = () => sys.wizard.steps.filter(s => !s.when || s.when(draft));
  const current = () => alive && state.gm && state.worldId === worldId;
  const ctx = { get data() { return data; }, update: () => { touched = true; show(); }, changed: () => { touched = true; saveDraft(); updateSummary(); } };
  function saveDraft() {
    if (finished || !touched) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, stepKey, draft })); status.textContent = 'Draft saved in this tab · no entry created yet'; }
    catch { status.textContent = 'Browser draft storage is full or unavailable. Keep this page open until you finish.'; }
  }
  function clearDraft() { try { sessionStorage.removeItem(storageKey); } catch { /* no persisted draft */ } }
  function validation(step) { try { return step.validate?.(draft, ctx) || ''; } catch { return 'Complete the earlier choices first.'; } }
  function updateSummary() {
    if (!data || !current()) return;
    summary.replaceChildren();
    if (sys.wizard.summary) {
      try { summary.append(sys.wizard.summary(draft, data)); } catch { summary.append(el('p', { class: 'muted' }, 'Choose your character details to see a summary.')); }
    } else summary.append(el('div', { class: 'creator-kicker' }, 'YOUR CHARACTER'), el('h2', {}, draft.name || 'New character'),
      el('p', { class: 'muted small' }, sys.label), el('p', { class: 'small' }, 'Revisit completed steps at any time. All choices are checked before Finish.'));
  }
  function move(key) { if (!busy) { stepKey = key; show(); body.querySelector('h2')?.focus(); } }
  function show() {
    if (!data || !current()) return;
    const steps = stepList(); let idx = steps.findIndex(s => s.key === stepKey);
    if (idx < 0) { idx = 0; stepKey = steps[0].key; }
    const step = steps[idx];
    rail.replaceChildren();
    for (const [i, s] of steps.entries()) {
      const done = !validation(s);
      rail.append(el('button', { type: 'button', class: `wiz-step${i === idx ? ' on' : ''}${done ? ' done' : ''}`, 'aria-current': i === idx ? 'step' : null,
        disabled: busy, onclick: () => {
          // Other system renderers assume earlier drafts were seeded by visits.
          if (systemKey !== 'dnd2024' && i > idx) {
            for (const earlier of steps.slice(0, i)) if (validation(earlier)) { error.textContent = `${earlier.title}: ${validation(earlier)}`; error.hidden = false; return; }
          }
          move(s.key);
        } }, el('span', { class: 'step-number' }, done ? '✓' : i + 1), s.title));
    }
    body.replaceChildren(el('h2', { tabindex: -1 }, step.title)); error.hidden = true;
    const needs = systemKey === 'dnd2024' && !['home', 'class', 'species', 'background'].includes(step.key)
      ? [['klass', 'class'], ['species', 'species'], ['background', 'background']].filter(([key]) => !draft[key]) : [];
    if (needs.length) body.append(el('p', { class: 'notice' }, 'Make these choices first: ', needs.map(([, key]) => el('button', { class: 'small', onclick: () => move(key) }, key))));
    else {
      try { body.append(step.render(draft, ctx)); }
      catch (err) { console.error(err); body.append(el('p', { class: 'notice warn' }, `Could not show this step: ${err.message}`)); }
    }
    previous.disabled = busy || idx === 0;
    next.disabled = busy || needs.length > 0;
    next.textContent = idx === steps.length - 1 ? 'Create character' : 'Next →';
    progress.textContent = `Step ${idx + 1} of ${steps.length}`;
    updateSummary(); saveDraft();
  }
  previous.onclick = () => { const steps = stepList(), i = steps.findIndex(s => s.key === stepKey); if (i > 0) move(steps[i - 1].key); };
  next.onclick = async () => {
    if (busy || !data || !current()) return;
    const steps = stepList(), i = steps.findIndex(s => s.key === stepKey);
    const invalid = validation(steps[i]);
    if (invalid) { error.textContent = invalid; error.hidden = false; return; }
    if (i < steps.length - 1) { move(steps[i + 1].key); return; }
    for (const step of steps) {
      const invalid = validation(step);
      if (invalid) { move(step.key); error.textContent = invalid; error.hidden = false; return; }
    }
    busy = true; next.disabled = true; body.inert = true; rail.inert = true; controls.inert = true;
    try {
      if (!pendingEntity) {
        const spec = sys.wizard.finish(draft, ctx);
        pendingEntity = newEntity(spec.name, draft.entryType || 'character');
        pendingEntity.gmOnly = !!draft.gmOnly;
        pendingEntity.fields = { ...pendingEntity.fields, ...spec.fields };
        pendingEntity.tags = spec.tags || [];
        pendingEntity.blocks = [{ id: uid(), kind: 'sheet', system: systemKey, data: spec.data, text: '', secret: false }, ...pendingEntity.blocks];
      }
      await saveEntity(pendingEntity);
      finished = true; clearDraft();
      if (current()) { toast(`Welcome, ${pendingEntity.name}`); location.hash = `#/e/${pendingEntity.id}`; }
    } catch (err) { error.textContent = `Could not create the character: ${err.message}. Retry uses the same entry.`; error.hidden = false; }
    finally { busy = false; next.disabled = false; body.inert = false; rail.inert = false; controls.inert = false; }
  };
  for (const event of ['input', 'change', 'click']) body.addEventListener(event, () => { touched = true; saveDraft(); updateSummary(); });
  const entryType = el('select', { 'aria-label': 'Character category', onchange: ev => { draft.entryType = ev.target.value; touched = true; saveDraft(); } },
    Object.entries(types()).map(([key, t]) => el('option', { value: key }, t.plural || t.label)));
  entryType.value = draft.entryType || 'character';
  const controls = el('div', { class: 'row creator-draft-bar' }, entryType,
    el('label', { class: 'small' }, el('input', { type: 'checkbox', checked: !!draft.gmOnly, onchange: ev => { draft.gmOnly = ev.target.checked; touched = true; saveDraft(); } }), '🔒 GM-only character'),
    el('span', { class: 'spacer' }), el('a', { href: '#/create', onclick: saveDraft }, 'Save draft & exit'),
    el('button', { class: 'ghost small', onclick: () => { if (confirm('Discard this saved character draft?')) { finished = true; clearDraft(); location.hash = '#/create'; } } }, 'Discard draft'));
  container.append(el('div', { class: 'page creator-page' }, el('div', { class: 'row' }, el('h1', {}, sys.label), el('span', { class: 'spacer' }), progress),
    el('p', { class: 'small muted' }, sys.wizard.intro), controls,
    el('div', { class: 'creator-layout' }, rail, el('div', { class: 'creator-main' }, body, error,
      el('div', { class: 'row creator-footer' }, previous, status, el('span', { class: 'spacer' }), next)), summary)));
  body.append(el('p', { class: 'muted' }, 'Loading game data…'));
  (sys.wizardData ? sys.wizardData() : sys.loadData()).then(loaded => {
    if (!current()) return; data = loaded;
    if (systemKey === 'dnd2024') for (const [key, collection] of [['klass', 'classes'], ['species', 'species'], ['background', 'backgrounds']]) {
      if (draft[key]) draft[key] = data[collection].find(x => x.name === draft[key].name) || null;
    }
    show();
  }).catch(err => { if (current()) { body.replaceChildren(el('p', { class: 'notice warn' }, `Could not load game data: ${err.message}`)); } });
  const beforeUnload = () => saveDraft(); window.addEventListener('beforeunload', beforeUnload);
  return () => { saveDraft(); alive = false; window.removeEventListener('beforeunload', beforeUnload); };
}
