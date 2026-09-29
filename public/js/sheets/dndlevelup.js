import { el } from '../util.js';
import { choicePicker, spellPicker } from './choicepicker.js';
import { ABILITIES, SKILLS, mod, fmtMod, sourceLabel, availableSpells, unique, canonSkill, classGrantedSpells, lower } from './dndrules.js';
import { advancementRequirements, eligibleFeat, planLevelUp, subclassSpells } from './dndadvance.js';

export function levelUpPanel(data, save, loadData) {
  const body = el('div', { class: 'level-up-body' });
  const panel = el('details', { 'data-advance': '', class: 'level-up-panel' }, el('summary', {}, `Level up · ${data.klass.level} → ${Math.min(20, Number(data.klass.level) + 1)}`), body);
  let generation = 0;
  async function render() {
    const ticket = ++generation, original = JSON.stringify(data);
    body.replaceChildren(el('p', { class: 'muted' }, 'Loading class progression and Library…'));
    if (data.klass.level >= 20) { body.replaceChildren(el('p', { class: 'notice' }, 'Level 20 reached.')); return; }
    let library;
    try { library = await loadData(); } catch (err) { body.replaceChildren(el('p', { class: 'notice warn' }, err.message)); return; }
    if (ticket !== generation) return;
    const klass = library.classes.find(c => c.name.toLowerCase() === data.klass.name.toLowerCase());
    if (!klass) { body.replaceChildren(el('p', { class: 'notice warn' }, `Import the class data for ${data.klass.name} in Library before advancing.`)); return; }
    let req = advancementRequirements(data, klass, data.klass.subclass || data.klass.plannedSubclass);
    const p = req.spells;
    const choices = { hpMethod: 'average', hpRoll: Math.floor(klass.hitDie / 2) + 1, addToCurrent: true, subclass: data.klass.subclass || (req.subclass ? data.klass.plannedSubclass || '' : ''),
      improvement: '', abilityIncreases: {}, featAbilities: {}, expertise: [], skills: [],
      cantrips: [...(data.spellcasting?.cantrips || [])], prepared: [...(data.spellcasting?.prepared || [])], newSpells: [], featureChoices: {} };
    let plan = null;
    const status = el('div', { role: 'status', class: 'notice', hidden: true });
    const preview = el('div', { class: 'level-up-review' });
    const apply = el('button', { class: 'primary', disabled: true, onclick: () => {
      if (!plan) return;
      if (JSON.stringify(data) !== original) { status.hidden = false; status.textContent = 'The sheet changed while you were choosing. Refresh this level-up to use the current values.'; apply.disabled = true; return; }
      Object.assign(data, plan.data); save(); apply.disabled = true;
      panel.dispatchEvent(new CustomEvent('sheet-reopen', { bubbles: true }));
    } }, `Apply level ${req.to}`);
    const invalidate = () => { plan = null; apply.disabled = true; preview.replaceChildren(); };
    const field = (title, control) => { control.setAttribute('aria-label', title); return el('label', { class: 'creator-field' }, el('span', { class: 'small' }, title), control); };
    function pick(options, value, changed) {
      const select = el('select', { onchange: ev => { changed(ev.target.value); invalidate(); } }, el('option', { value: '' }, 'Choose…'), options.map(v => el('option', { value: typeof v === 'string' ? v : v.value || v.name }, typeof v === 'string' ? v : v.label || `${v.name} · ${sourceLabel(v)}`)));
      select.value = value || ''; return select;
    }
    const checkboxList = (names, selected, limit) => el('div', { class: 'creator-checks' }, names.map(name => el('label', {},
      el('input', { type: 'checkbox', checked: selected.includes(name), onchange: ev => {
        if (ev.target.checked) selected.push(name); else selected.splice(selected.indexOf(name), 1); invalidate();
      } }), name)), el('p', { class: 'muted small' }, `Choose ${limit}.`));
    const featureArea = el('div', {});
    function renderFeatures() {
      const sub = klass.subclasses?.find(s => s.name === choices.subclass);
      const rows = [...req.features, ...(sub?.features || []).filter(f => f.level <= req.to && (f.level > data.klass.level || !data.klass.subclass))];
      featureArea.replaceChildren(el('h3', {}, 'Features gained'));
      for (const f of rows) {
        const note = el('textarea', { rows: 2, placeholder: 'Your selections, if this feature offers a choice…', oninput: ev => { choices.featureChoices[f.name] = ev.target.value; invalidate(); } });
        note.value = choices.featureChoices[f.name] || '';
        featureArea.append(el('details', { class: 'feature-choice' }, el('summary', {}, f.name), el('div', { class: 'choice-prose small' }, f.text || 'No description in this pack.'), field('Choices / notes', note)));
      }
      featureArea.append(el('label', { class: 'small' }, el('input', { type: 'checkbox', checked: choices.featuresReviewed, onchange: ev => { choices.featuresReviewed = ev.target.checked; invalidate(); } }),
        ' I reviewed the features and recorded any required selections.'));
    }
    const improve = el('div', {}), skillArea = el('div', {});
    function renderSkills() {
      const count = req.skill + (choices.feat === 'Skilled' ? 3 : 0);
      skillArea.replaceChildren();
      if (count) skillArea.append(el('h3', {}, 'New skill proficiencies'), checkboxList((choices.feat === 'Skilled' ? SKILLS.map(([n]) => n) : req.skillOptions).filter(n => !data.skills?.some(s => s.key === n)), choices.skills, count));
      if (req.expertise) skillArea.append(el('h3', {}, 'Expertise'), checkboxList((data.skills || []).filter(s => s.prof !== 'expert' && (klass.name !== 'Wizard' || ['Arcana', 'History', 'Investigation', 'Medicine', 'Nature', 'Religion'].includes(s.key))).map(s => s.key), choices.expertise, req.expertise));
    }
    function abilityInputs(target, max = 2) {
      return el('div', { class: 'creator-abilities' }, ABILITIES.map(a => field(`${a.toUpperCase()} ${data.abilities[a]} +`, el('input', { type: 'number', value: target[a] || 0, min: 0, max, step: 1, oninput: ev => { target[a] = Number(ev.target.value); invalidate(); } }))));
    }
    function renderImprovement() {
      improve.replaceChildren();
      if (!req.abilityOrFeat) return;
      improve.append(el('h3', {}, req.epic ? 'Epic boon or another eligible feat' : 'Ability increase or feat'),
        field('Choose your improvement', pick([{ value: 'asi', label: 'Increase ability scores' }, { value: 'feat', label: 'Choose a feat' }], choices.improvement, v => { choices.improvement = v; choices.feat = ''; choices.skills = []; choices.featReviewed = false; renderImprovement(); renderSkills(); })));
      if (choices.improvement === 'asi') improve.append(el('p', { class: 'small muted' }, '+2 to one score, or +1 to two scores. Maximum 20.'), abilityInputs(choices.abilityIncreases));
      if (choices.improvement === 'feat') {
        const feats = library.feats.filter(f => eligibleFeat(f, data, req.to));
        improve.append(choicePicker({ items: feats, selected: choices.feat, label: 'feats', describe: f => f.category, details: f => f.text || '', onPick: f => {
          choices.feat = f.name; choices.featAbilities = {}; choices.skills = []; choices.featReviewed = false; invalidate(); renderImprovement(); renderSkills();
        } }));
        const feat = feats.find(f => f.name === choices.feat);
        if (feat) {
          if (/^magic initiate$/i.test(feat.name)) {
            const p = choices.initiate ??= { className: '', ability: '', cantrips: [], spell: '' };
            improve.append(field('Magic Initiate spell list', pick(['Cleric', 'Druid', 'Wizard'], p.className, v => { p.className = v; p.cantrips = []; p.spell = ''; renderImprovement(); })),
              field('Magic Initiate ability', pick(['int', 'wis', 'cha'], p.ability, v => { p.ability = v; })));
            if (p.className) {
              const list = availableSpells(library, { name: p.className }, 1);
              improve.append(spellPicker({ items: list.filter(s => !s.level), picks: p.cantrips, onChange: invalidate, limit: 2, title: 'Magic Initiate cantrips' }),
                field('Magic Initiate level-1 spell', pick(list.filter(s => s.level === 1), p.spell, v => { p.spell = v; })));
            }
          }
          if (feat.ability?.some(a => a.choose)) improve.append(el('p', { class: 'small muted' }, feat.ability.filter(a => a.choose).map(a => `Increase ${a.choose.count || 1} of ${(a.choose.from || []).map(s => s.toUpperCase()).join(', ')} by ${a.choose.amount || 1} (maximum ${a.max || 20}).`).join(' Or ')), abilityInputs(choices.featAbilities, 1));
          improve.append(field('Additional feat selections', el('input', { value: choices.featNotes || '', oninput: ev => { choices.featNotes = ev.target.value; invalidate(); } })),
            el('label', { class: 'small' }, el('input', { type: 'checkbox', checked: choices.featReviewed, onchange: ev => { choices.featReviewed = ev.target.checked; invalidate(); } }), ' I meet the prerequisites and have recorded the feat’s other choices.'));
        }
      }
    }
    const method = pick([{ value: 'average', label: 'Fixed average' }, { value: 'rolled', label: 'Rolled hit die' }], choices.hpMethod, v => { choices.hpMethod = v; });
    const hpRoll = el('input', { type: 'number', value: choices.hpRoll, min: 1, max: klass.hitDie, step: 1, oninput: ev => { choices.hpRoll = Number(ev.target.value); invalidate(); } });
    body.replaceChildren(el('h2', {}, `${klass.name} · level ${data.klass.level} → ${req.to}`),
      el('p', { class: 'muted small' }, `${sourceLabel(klass)}. Choose below, review the changes, then apply once. Your current sheet stays intact until Apply.`),
      ...library.warnings.map(w => el('p', { class: 'notice warn small' }, w)),
      el('h3', {}, 'Hit points'), el('div', { class: 'row' }, field('Hit-die method', method), field(`Roll on d${klass.hitDie} (before CON)`, hpRoll),
        el('button', { class: 'small', onclick: () => { choices.hpRoll = 1 + Math.floor(Math.random() * klass.hitDie); hpRoll.value = choices.hpRoll; choices.hpMethod = 'rolled'; method.value = 'rolled'; invalidate(); } }, `🎲 Roll d${klass.hitDie}`)),
      el('p', { class: 'small muted' }, `Average die: ${Math.floor(klass.hitDie / 2) + 1}. Current CON modifier: ${fmtMod(mod(data.abilities.con))}. Constitution increases also adjust HP for earlier levels.`),
      el('label', { class: 'small' }, el('input', { type: 'checkbox', checked: true, onchange: ev => { choices.addToCurrent = ev.target.checked; invalidate(); } }), ' Add the gain to current HP as well as maximum HP'));
    if (req.to >= 3 && !data.klass.subclass) body.append(field('Subclass', pick(klass.subclasses || [], choices.subclass, v => { choices.subclass = v; req = advancementRequirements(data, klass, v); choices.skills = []; choices.expertise = []; choices.featuresReviewed = false; renderFeatures(); renderSkills(); renderSpells(); })));
    if (req.fightingStyle) body.append(field('Fighting Style', pick(library.feats.filter(f => f.category === 'Fighting Style' && !data.features?.some(x => x.name === f.name)), choices.fightingStyle, v => { choices.fightingStyle = v; })));
    body.append(improve, skillArea, featureArea); renderImprovement(); renderSkills(); renderFeatures();
    const spellArea = el('div', {}); body.append(spellArea);
    function renderSpells() {
      spellArea.replaceChildren();
      if (!klass.spellcasting) return;
      const list = availableSpells(library, klass, p.maxLevel);
      const sub = klass.subclasses?.find(s => s.name === choices.subclass);
      const grants = unique([...classGrantedSpells(klass, req.to), ...subclassSpells(sub, req.to)]).map(n => library.spells.find(s => lower(s.name) === lower(n))?.name || n);
      choices.prepared = choices.prepared.filter(n => !grants.includes(n));
      if (!p.supported) spellArea.append(el('p', { class: 'notice warn' }, 'This pack lacks spell progression data. Update it in Library before levelling up.'));
      else {
        spellArea.append(el('h3', {}, 'Spellcasting at the new level'), el('p', { class: 'small muted' }, `Slots: ${Object.entries(p.slots).map(([l, n]) => `level ${l} × ${n}`).join(', ')}. Expended slots remain expended; level-up does not take a rest.`));
        if (grants.length) spellArea.append(el('p', { class: 'notice small' }, `Always prepared: ${grants.join(', ')}. These are extra and do not use your choices below.`));
        if (p.cantrips) spellArea.append(spellPicker({ items: list.filter(s => !s.level), picks: choices.cantrips, onChange: invalidate, limit: p.cantrips, title: 'Class cantrips' }));
        if (klass.name === 'Wizard') {
          const known = data.spellcasting?.spellbook || data.spellcasting?.prepared || [];
          spellArea.append(el('p', { class: 'small muted' }, `Already in spellbook: ${known.join(', ') || 'none'}.`), spellPicker({ items: list.filter(s => s.level > 0 && !known.includes(s.name)), picks: choices.newSpells, onChange: invalidate, limit: 2, title: 'Learn two new spellbook spells' }));
        }
        spellArea.append(spellPicker({ items: list.filter(s => s.level > 0 && !grants.includes(s.name)), picks: choices.prepared, onChange: invalidate, limit: p.prepared, title: 'Prepared spells at your new level' }));
      }
    }
    renderSpells();
    const review = el('button', { class: 'primary', onclick: () => {
      status.hidden = true;
      try {
        if (JSON.stringify(data) !== original) throw new Error('The sheet has changed. Refresh level-up before continuing.');
        plan = planLevelUp(data, klass, choices, library);
        const c = plan.changes;
        preview.replaceChildren(...[el('h3', {}, `Ready for level ${c.to}`), el('p', {}, `HP: ${data.hp.max} → ${plan.data.hp.max} (+${c.hpGain}${c.retroactive ? `, including ${c.retroactive} for earlier levels` : ''}). Proficiency: +${c.proficiency[0]} → +${c.proficiency[1]}.`),
          ...Object.entries(c.abilities).map(([a, vals]) => el('p', { class: 'small' }, `${a.toUpperCase()}: ${vals[0]} → ${vals[1]}`)),
          el('p', { class: 'small' }, `Features: ${c.features.join(', ') || 'no new named features'}`),
          c.subclass ? el('p', { class: 'small' }, `Subclass: ${c.subclass}`) : null,
          plan.data.spellcasting ? el('p', { class: 'small' }, `Spell DC ${plan.data.spellcasting.dc}; attack ${fmtMod(plan.data.spellcasting.attackBonus)}. ${plan.data.spellcasting.prepared.length} prepared${plan.data.spellcasting.alwaysPrepared?.length ? ` plus ${plan.data.spellcasting.alwaysPrepared.length} subclass spells` : ''}.`) : null].filter(Boolean));
        apply.disabled = false;
      } catch (err) { plan = null; apply.disabled = true; status.textContent = err.message; status.hidden = false; }
    } }, 'Review level-up');
    body.append(el('div', { class: 'row', style: 'margin-top:16px' }, review, el('button', { class: 'ghost', onclick: render }, 'Refresh / start over')),
      status, preview, apply, el('p', { class: 'muted small' }, 'Named feature choices are recorded on the sheet. Conditional effects and unusual imported mechanics remain editable by the DM.'));
  }
  panel.addEventListener('toggle', () => { if (panel.open) render(); });
  panel.addEventListener('advance-refresh', () => { if (panel.open) render(); });
  return panel;
}
