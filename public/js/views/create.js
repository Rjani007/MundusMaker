// Character creation wizards: #/create picks a game system, #/create/<system>
// walks its steps. The draft lives in this closure and nothing is saved until
// Finish — which creates one 'character' entity with a sheet block.

import { el, uid, toast } from '../util.js';
import { state, newEntity, saveEntity } from '../state.js';
import { SHEET_SYSTEMS } from '../sheets/sheetcore.js';

export function render(container, systemKey) {
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
  const draft = {};
  let stepIdx = 0;
  let data = null;

  const rail = el('div', { class: 'wiz-rail' });
  const body = el('div', { class: 'wiz-body' });
  const errEl = el('div', { class: 'small', style: 'color:var(--danger);min-height:18px' });
  const backBtn = el('button', { class: 'ghost' }, '← Back');
  const nextBtn = el('button', { class: 'primary' }, 'Next →');

  const activeSteps = () => sys.wizard.steps.filter((s) => !s.when || s.when(draft));

  const ctx = {
    get data() { return data; },
    update: () => show(), // re-render the current step (selection changed)
  };

  function show() {
    const steps = activeSteps();
    stepIdx = Math.min(stepIdx, steps.length - 1);
    const step = steps[stepIdx];
    rail.innerHTML = '';
    steps.forEach((s, i) => {
      rail.append(el('div', {
        class: `wiz-step${i === stepIdx ? ' on' : ''}${i < stepIdx ? ' done' : ''}`,
      }, `${i < stepIdx ? '✓' : i + 1}. ${s.title}`));
    });
    body.innerHTML = '';
    errEl.textContent = '';
    try {
      body.append(el('h2', {}, step.title), step.render(draft, ctx));
    } catch (err) {
      console.error(err);
      body.append(el('div', { class: 'notice warn' }, 'This step failed to render: ', err.message));
    }
    backBtn.style.visibility = stepIdx === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = stepIdx === steps.length - 1 ? '✦ Create character' : 'Next →';
  }

  backBtn.addEventListener('click', () => { if (stepIdx > 0) { stepIdx--; show(); } });
  nextBtn.addEventListener('click', async () => {
    const steps = activeSteps();
    const err = steps[stepIdx].validate?.(draft, ctx);
    if (err) { errEl.textContent = err; return; }
    if (stepIdx < steps.length - 1) { stepIdx++; show(); return; }
    // finish
    nextBtn.disabled = true;
    try {
      const spec = sys.wizard.finish(draft, ctx);
      const e = newEntity(spec.name, 'character');
      e.fields = { ...e.fields, ...spec.fields };
      if (spec.tags?.length) e.tags = spec.tags;
      e.blocks = [
        { id: uid(), kind: 'sheet', system: systemKey, data: spec.data, text: '', secret: false },
        ...e.blocks,
      ];
      await saveEntity(e);
      toast(`Welcome, ${spec.name}`);
      location.hash = `#/e/${e.id}`;
    } catch (err) {
      console.error(err);
      errEl.textContent = 'Could not create the character: ' + err.message;
      nextBtn.disabled = false;
    }
  });

  container.append(el('div', { class: 'page wide' },
    el('h1', {}, sys.label),
    el('p', { class: 'muted small' }, sys.wizard.intro),
    el('div', { class: 'wizard' }, rail,
      el('div', { style: 'flex:1;min-width:0' }, body, errEl,
        el('div', { class: 'row', style: 'margin-top:14px' }, backBtn, el('span', { class: 'spacer' }), nextBtn)))));

  // system data loads async; steps render once it's here — wizardData, when a
  // system provides it, folds the user's imported library packs into the picks
  body.append(el('p', { class: 'muted' }, 'Loading game data…'));
  (sys.wizardData ? sys.wizardData() : sys.loadData()).then((loaded) => { data = loaded; show(); }).catch((err) => {
    body.innerHTML = '';
    body.append(el('div', { class: 'notice warn' }, 'Could not load this system’s data: ', err.message));
  });
}
