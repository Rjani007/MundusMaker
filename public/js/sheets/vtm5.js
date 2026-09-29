// Vampire: The Masquerade 5th Edition sheet + creation wizard.
// Data pack (public/systems/vtm5.json) carries names and creation math only —
// power descriptions are user-pasted, with reference links to the wiki.

import { el, esc, makeRng } from '../util.js';
import { nameFor } from '../names.js';
import {
  dotsHtml, trackHtml, rollBtn, kvHtml, sectionHtml,
  frow, textInput, numInput, areaInput, listEdit, surprisePickButton,
} from './sheetlib.js';

export const label = 'Vampire: The Masquerade 5e';
export const tagline = 'The V5 sheet: dots, hunger, and the Beast underneath.';

let cached = null;
export async function loadData() {
  if (!cached) {
    const res = await fetch('/systems/vtm5.json');
    if (!res.ok) throw new Error('systems/vtm5.json missing');
    cached = await res.json();
  }
  return cached;
}

const ATTR_GROUPS = {
  physical: ['strength', 'dexterity', 'stamina'],
  social: ['charisma', 'manipulation', 'composure'],
  mental: ['intelligence', 'wits', 'resolve'],
};
const ALL_ATTRS = Object.values(ATTR_GROUPS).flat();
const SKILL_GROUPS = {
  physical: ['Athletics', 'Brawl', 'Craft', 'Drive', 'Firearms', 'Larceny', 'Melee', 'Stealth', 'Survival'],
  social: ['Animal Ken', 'Etiquette', 'Insight', 'Intimidation', 'Leadership', 'Performance', 'Persuasion', 'Streetwise', 'Subterfuge'],
  mental: ['Academics', 'Awareness', 'Finance', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science', 'Technology'],
};
const ALL_SKILLS = Object.values(SKILL_GROUPS).flat();
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const XP_SPEND_TYPES = {
  attribute: { label: 'Attribute', multiplier: 5, rating: true },
  skill: { label: 'Skill', multiplier: 3, rating: true },
  clanDiscipline: { label: 'In-clan discipline', multiplier: 5, rating: true },
  otherDiscipline: { label: 'Out-of-clan discipline', multiplier: 7, rating: true },
  caitiffDiscipline: { label: 'Caitiff discipline', multiplier: 6, rating: true },
  bloodPotency: { label: 'Blood Potency', multiplier: 10, rating: true },
  specialty: { label: 'Specialty', fixed: 3 },
  advantage: { label: 'Advantage dot', fixed: 3 },
  ritual: { label: 'Blood Sorcery ritual', multiplier: 3, level: true },
  formula: { label: 'Thin-blood formula', multiplier: 3, level: true },
  manual: { label: 'Other / storyteller-approved', manual: true },
};

export function xpSpendCost(kind, rating = 1, manualCost = 0) {
  const rule = XP_SPEND_TYPES[kind];
  if (!rule) throw new Error('Choose an XP spend type.');
  if (rule.manual) return Math.max(1, Math.floor(Number(manualCost) || 0));
  if (rule.fixed) return rule.fixed;
  const next = Math.max(1, Math.floor(Number(rating) || 1));
  return next * rule.multiplier;
}

const lower = (s) => String(s || '').trim().toLowerCase();
const personName = () => nameFor(makeRng(`vtm-wizard:${Date.now()}:${Math.random()}`), 'person');
function findKey(items, wanted) {
  return items.find((item) => lower(item) === lower(wanted));
}

/** Record and apply one V5 XP purchase. One rating dot is bought per entry. */
export function spendXp(data, spec) {
  const kind = spec?.kind;
  const rule = XP_SPEND_TYPES[kind];
  if (!rule) throw new Error('Choose what the XP buys.');
  data.xp ??= { total: 0, spent: 0, ledger: [] };
  data.xp.ledger ??= [];

  let target = String(spec.target || '').trim();
  let before = null, after = null;
  if (kind === 'attribute') {
    data.attributes ??= {};
    const key = findKey(ALL_ATTRS, target);
    if (!key) throw new Error('Enter an attribute name from the sheet.');
    before = Number(data.attributes?.[key] || 0); after = before + 1; target = cap(key);
    if (after > 5) throw new Error(`${target} is already at 5.`);
  } else if (kind === 'skill') {
    data.skills ??= {};
    const key = findKey(ALL_SKILLS, target);
    if (!key) throw new Error('Enter a skill name from the sheet.');
    before = Number(data.skills?.[key] || 0); after = before + 1; target = key;
    if (after > 5) throw new Error(`${target} is already at 5.`);
  } else if (['clanDiscipline', 'otherDiscipline', 'caitiffDiscipline'].includes(kind)) {
    if (!target) throw new Error('Name the discipline.');
    const disc = (data.disciplines || []).find((item) => lower(item.name) === lower(target));
    before = Number(disc?.rating || 0); after = before + 1;
    if (after > 5) throw new Error(`${target} is already at 5.`);
  } else if (kind === 'bloodPotency') {
    target = 'Blood Potency'; before = Number(data.bloodPotency || 0); after = before + 1;
    if (after > 10) throw new Error('Blood Potency is already at 10.');
  } else if (kind === 'specialty') {
    if (!target) throw new Error('Use “Skill: Specialty” so the sheet knows where to put it.');
    const parts = target.split(':');
    if (parts.length < 2 || !parts.slice(1).join(':').trim()) throw new Error('Use “Skill: Specialty”.');
    const skill = findKey(ALL_SKILLS, parts[0]);
    if (!skill) throw new Error('Use a skill name from the sheet before the colon.');
    target = `${skill}: ${parts.slice(1).join(':').trim()}`;
  } else if (kind === 'advantage') {
    if (!target) throw new Error('Name the advantage.');
    const adv = (data.advantages || []).find((item) => !item.flaw && lower(item.name) === lower(target));
    before = Number(adv?.dots || 0); after = before + 1;
    if (after > 5) throw new Error(`${target} is already at 5 dots.`);
  } else if (kind === 'ritual' || kind === 'formula') {
    if (!target) throw new Error(`Name the ${kind}.`);
    after = Math.max(1, Math.min(5, Math.floor(Number(spec.rating) || 1)));
  } else if (!target) target = 'Storyteller-approved spend';

  const ratingForCost = rule.rating ? after : rule.level ? after : 1;
  const cost = xpSpendCost(kind, ratingForCost, spec.manualCost);
  const total = Math.max(0, Number(data.xp.total) || 0);
  const spent = Math.max(0, Number(data.xp.spent) || 0);
  if (cost > total - spent) throw new Error(`That costs ${cost} XP; only ${Math.max(0, total - spent)} XP is available.`);

  if (kind === 'attribute') data.attributes[findKey(ALL_ATTRS, target)] = after;
  else if (kind === 'skill') data.skills[findKey(ALL_SKILLS, target)] = after;
  else if (['clanDiscipline', 'otherDiscipline', 'caitiffDiscipline'].includes(kind)) {
    data.disciplines ??= [];
    let disc = data.disciplines.find((item) => lower(item.name) === lower(target));
    if (!disc) { disc = { name: target, rating: 0, powers: [] }; data.disciplines.push(disc); }
    disc.rating = after;
  } else if (kind === 'bloodPotency') data.bloodPotency = after;
  else if (kind === 'specialty') {
    const [skill, ...rest] = target.split(':');
    data.specialties ??= [];
    data.specialties.push({ skill: skill.trim(), name: rest.join(':').trim() });
  } else if (kind === 'advantage') {
    data.advantages ??= [];
    let adv = data.advantages.find((item) => !item.flaw && lower(item.name) === lower(target));
    if (!adv) { adv = { name: target, dots: 0, flaw: false, desc: '' }; data.advantages.push(adv); }
    adv.dots = after;
  }

  const detail = rule.rating ? `${before} → ${after}` : rule.level ? `level ${after}` : '';
  const entry = {
    at: new Date().toISOString(), kind, target, before, after, cost,
    label: `${rule.label}: ${target}${detail ? ` (${detail})` : ''}`,
  };
  data.xp.spent = spent + cost;
  data.xp.ledger.push(entry);
  if (data.xp.ledger.length > 100) data.xp.ledger.splice(0, data.xp.ledger.length - 100);
  return entry;
}

export function defaults() {
  return {
    clan: '', generation: 13, bloodPotency: 1, predatorType: '', sire: '',
    ambition: '', desire: '',
    attributes: Object.fromEntries(ALL_ATTRS.map((a) => [a, 1])),
    skills: Object.fromEntries(ALL_SKILLS.map((s) => [s, 0])),
    specialties: [],
    disciplines: [],
    advantages: [],
    convictions: [], touchstones: [],
    hunger: 1, humanity: 7,
    health: { superficial: 0, aggravated: 0 },
    willpower: { superficial: 0, aggravated: 0 },
    xp: { total: 0, spent: 0, ledger: [] },
    notes: '',
  };
}

export const healthMax = (d) => (d.attributes?.stamina ?? 1) + 3;
export const willpowerMax = (d) => (d.attributes?.composure ?? 1) + (d.attributes?.resolve ?? 1);

export function summary(data) {
  const d = data || defaults();
  return `${d.clan || 'Clanless'} · ${d.generation}th gen${d.predatorType ? ` · ${d.predatorType}` : ''}`;
}

export function searchText(data) {
  const d = data || {};
  return [d.clan, d.predatorType, d.sire,
    ...(d.disciplines || []).flatMap((x) => [x.name, ...(x.powers || []).map((p) => p.name)]),
    ...(d.advantages || []).map((a) => a.name),
  ].filter(Boolean).join(' ');
}

// ---------- rendered sheet ----------

export function html(data) {
  const d = { ...defaults(), ...(data || {}) };
  const attrCols = Object.entries(ATTR_GROUPS).map(([group, attrs]) =>
    `<div class="sheet-col"><div class="sheet-sec-title">${cap(group)}</div>` +
    attrs.map((a) => `<div class="sheet-kv"><span class="sk">${cap(a)}</span><span class="sv">${dotsHtml(d.attributes[a] ?? 1, 5, { edit: true, path: `attributes.${a}` })}</span></div>`).join('') +
    '</div>').join('');

  const specBySkill = {};
  for (const sp of d.specialties || []) (specBySkill[sp.skill] ??= []).push(sp.name);
  const skillCols = Object.entries(SKILL_GROUPS).map(([group, skills]) =>
    `<div class="sheet-col">` +
    skills.map((s) => `<div class="sheet-kv"><span class="sk">${esc(s)}${specBySkill[s] ? ` <span class="muted small">(${esc(specBySkill[s].join(', '))})</span>` : ''}</span><span class="sv">${dotsHtml(d.skills[s] ?? 0, 5, { edit: true, path: `skills.${s}` })}</span></div>`).join('') +
    '</div>').join('');

  const attrOpts = ALL_ATTRS.map((a) => `<option data-v="${d.attributes[a] ?? 1}">${cap(a)}</option>`).join('');
  const skillOpts = ALL_SKILLS.map((s) => `<option data-v="${d.skills[s] ?? 0}">${esc(s)}</option>`).join('');
  const rollbar = `<div class="sheet-rollbar row">` +
    `<select>${attrOpts}</select><span class="muted">+</span><select>${skillOpts}</select>` +
    `<span class="muted small">hunger ${d.hunger}</span>` +
    rollBtn({ kind: 'pool', hunger: d.hunger }, '🎲 Roll pool', 'Roll the selected attribute + skill as a V5 pool with hunger dice') +
    '</div>';

  const disciplines = (d.disciplines || []).map((disc) =>
    `<div class="sheet-feature"><strong>${esc(disc.name)}</strong> ${dotsHtml(disc.rating || 0, 5)}` +
    (disc.powers || []).map((p) =>
      `<div class="sheet-power">• <strong>${esc(p.name)}</strong> <span class="muted small">L${p.level}</span>` +
      (p.wikiUrl ? ` <a class="muted small" href="${esc(p.wikiUrl)}" target="_blank" rel="noopener">reference ↗</a>` : '') +
      (p.desc ? `<div class="sheet-feature-text">${esc(p.desc).replace(/\n/g, '<br>')}</div>` : '') +
      '</div>').join('') +
    '</div>').join('') || '<div class="muted small">No disciplines yet.</div>';

  const advantages = (d.advantages || []).length
    ? d.advantages.map((a) => `<div class="sheet-kv"><span class="sk">${a.flaw ? '⚑ ' : ''}${esc(a.name)}</span><span class="sv">${dotsHtml(a.dots || 0, 5)}${a.desc ? ` <span class="muted small">${esc(a.desc)}</span>` : ''}</span></div>`).join('')
    : '';

  const convictions = (d.convictions || []).map((c, i) => {
    const t = (d.touchstones || [])[i];
    return `<div class="small">• ${esc(c)}${t?.name ? ` <span class="muted">— touchstone: ${esc(t.name)}</span>` : ''}</div>`;
  }).join('');
  const xp = { total: 0, spent: 0, ledger: [], ...(d.xp || {}) };
  const lastSpend = xp.ledger?.[xp.ledger.length - 1];

  return `<div class="sheet sheet-vtm">
    <div class="sheet-head">
      <span class="sheet-title">${esc(summary(d))}</span>
      <span class="muted small">${d.sire ? `childe of ${esc(d.sire)}` : ''}</span>
    </div>
    ${d.ambition || d.desire ? `<div class="small muted">${d.ambition ? `Ambition: ${esc(d.ambition)}` : ''}${d.ambition && d.desire ? ' · ' : ''}${d.desire ? `Desire: ${esc(d.desire)}` : ''}</div>` : ''}
    ${rollbar}
    ${sectionHtml('Attributes', `<div class="sheet-cols">${attrCols}</div>`)}
    ${sectionHtml('Skills', `<div class="sheet-cols">${skillCols}</div>`)}
    ${sectionHtml('Trackers',
      kvHtml('Health', trackHtml(healthMax(d), d.health.superficial, d.health.aggravated, 'health') + ` <span class="muted small">${healthMax(d)}</span>`) +
      kvHtml('Willpower', trackHtml(willpowerMax(d), d.willpower.superficial, d.willpower.aggravated, 'willpower') + ` <span class="muted small">${willpowerMax(d)}</span>`) +
      kvHtml('Hunger', dotsHtml(d.hunger, 5, { edit: true, path: 'hunger' })) +
      kvHtml('Humanity', dotsHtml(d.humanity, 10, { edit: true, path: 'humanity' })) +
      kvHtml('Blood potency', dotsHtml(d.bloodPotency, 10, { edit: true, path: 'bloodPotency' })))}
    ${sectionHtml('Disciplines', disciplines)}
    ${advantages ? sectionHtml('Advantages & flaws', advantages) : ''}
    ${convictions ? sectionHtml('Convictions & touchstones', convictions) : ''}
    ${xp.total || xp.spent || xp.ledger?.length ? sectionHtml('Experience',
      `<div class="small"><strong>${Math.max(0, xp.total - xp.spent)} XP available</strong> · ${xp.spent} / ${xp.total} spent</div>` +
      (lastSpend ? `<div class="muted small">Last: ${esc(lastSpend.label)} · ${lastSpend.cost} XP</div>` : '')) : ''}
    ${d.notes ? sectionHtml('Notes', `<div class="small">${esc(d.notes).replace(/\n/g, '<br>')}</div>`) : ''}
    <div class="sheet-attrib muted">Unofficial Dark Pack fan material. Dots are click-editable in GM view.</div>
  </div>`;
}

// ---------- editor ----------

export function editor(block, save) {
  const d = block.data = { ...defaults(), ...(block.data || {}) };
  d.xp = { total: 0, spent: 0, ledger: [], ...(d.xp || {}) };
  d.xp.ledger ??= [];
  const wrap = el('div', { class: 'sb-form' },
    el('p', { class: 'muted small' }, 'Attributes, skills, hunger, humanity and damage are edited by clicking the dots and boxes on the sheet itself. Everything else lives here.'),
    el('div', { class: 'row' },
      frow('Clan', textInput(d.clan, (v) => { d.clan = v; save(); })),
      frow('Generation', numInput(d.generation, (v) => { d.generation = v; save(); }, { min: 4, max: 16 })),
      frow('Predator', textInput(d.predatorType, (v) => { d.predatorType = v; save(); })),
      frow('Sire', textInput(d.sire, (v) => { d.sire = v; save(); }))),
    el('div', { class: 'row' },
      frow('Ambition', textInput(d.ambition, (v) => { d.ambition = v; save(); }, { style: 'flex:1' })),
      frow('Desire', textInput(d.desire, (v) => { d.desire = v; save(); }, { style: 'flex:1' }))),
    el('div', { class: 'row' },
      frow('XP total', numInput(d.xp.total, (v) => { d.xp.total = v; save(); redrawXpAssistant(); })),
      frow('XP spent', numInput(d.xp.spent, (v) => { d.xp.spent = v; save(); redrawXpAssistant(); }))));

  const xpDetails = el('details', {});
  const xpSummary = el('summary', {});
  const xpBody = el('div', {});
  xpDetails.append(xpSummary, xpBody);
  let xpMessage = '';

  function currentRating(kind, target) {
    if (kind === 'attribute') {
      const key = findKey(ALL_ATTRS, target);
      return Number(key ? d.attributes[key] : 0) || 0;
    }
    if (kind === 'skill') {
      const key = findKey(ALL_SKILLS, target);
      return Number(key ? d.skills[key] : 0) || 0;
    }
    if (['clanDiscipline', 'otherDiscipline', 'caitiffDiscipline'].includes(kind)) {
      return Number(d.disciplines.find((disc) => lower(disc.name) === lower(target))?.rating || 0);
    }
    if (kind === 'bloodPotency') return Number(d.bloodPotency || 0);
    if (kind === 'advantage') return Number(d.advantages.find((adv) => !adv.flaw && lower(adv.name) === lower(target))?.dots || 0);
    return 0;
  }

  function redrawXpAssistant() {
    const available = Math.max(0, Number(d.xp.total || 0) - Number(d.xp.spent || 0));
    xpSummary.textContent = `Spend XP · ${available} available`;
    xpBody.innerHTML = '';

    const kindSel = el('select', {}, Object.entries(XP_SPEND_TYPES).map(([key, rule]) =>
      el('option', { value: key }, rule.label)));
    kindSel.value = 'attribute';
    const targetHost = el('span', { style: 'display:flex;flex:1' });
    const levelLabel = el('span', { class: 'small muted' }, 'Level');
    const levelInput = numInput(1, () => updateCost(), { min: 1, max: 5, title: 'level' });
    const manualLabel = el('span', { class: 'small muted' }, 'Cost');
    const manualInput = numInput(1, () => updateCost(), { min: 1, max: 999, title: 'XP cost' });
    const costText = el('strong', { class: 'small' });
    const status = el('div', { class: 'muted small' }, xpMessage);
    let targetInput;

    function targetValue() {
      if (kindSel.value === 'bloodPotency') return 'Blood Potency';
      return targetInput?.value || '';
    }
    function updateCost() {
      const kind = kindSel.value, rule = XP_SPEND_TYPES[kind];
      const before = currentRating(kind, targetValue());
      const rating = rule.rating ? before + 1 : rule.level ? Number(levelInput.value) || 1 : 1;
      let cost = 0;
      try { cost = xpSpendCost(kind, rating, Number(manualInput.value)); } catch { /* incomplete */ }
      costText.textContent = `${cost} XP${rule.rating ? ` · ${before} → ${rating}` : ''}`;
      costText.style.color = cost > available ? 'var(--danger)' : '';
      levelLabel.style.display = rule.level ? '' : 'none';
      levelInput.style.display = rule.level ? '' : 'none';
      manualLabel.style.display = rule.manual ? '' : 'none';
      manualInput.style.display = rule.manual ? '' : 'none';
    }
    function rebuildTarget() {
      const kind = kindSel.value;
      if (kind === 'attribute' || kind === 'skill') {
        const choices = kind === 'attribute' ? ALL_ATTRS.map(cap) : ALL_SKILLS;
        targetInput = el('select', {}, choices.map((name) => el('option', { value: name }, name)));
        targetInput.value = choices[0];
        targetInput.addEventListener('change', updateCost);
        targetHost.replaceChildren(targetInput);
      } else if (kind === 'bloodPotency') {
        targetInput = null;
        targetHost.replaceChildren(el('span', { class: 'small' }, 'Blood Potency'));
      } else {
        const placeholder = kind === 'specialty' ? 'Skill: Specialty'
          : kind === 'ritual' ? 'Ritual name'
          : kind === 'formula' ? 'Formula name'
          : kind === 'advantage' ? 'Advantage name'
          : kind === 'manual' ? 'What the XP bought'
          : 'Discipline name';
        targetInput = textInput('', () => updateCost(), { placeholder, style: 'flex:1' });
        targetHost.replaceChildren(targetInput);
      }
      updateCost();
    }
    kindSel.addEventListener('change', rebuildTarget);

    const apply = el('button', {
      class: 'primary small',
      onclick: () => {
        try {
          const entry = spendXp(d, {
            kind: kindSel.value,
            target: targetValue(),
            rating: Number(levelInput.value),
            manualCost: Number(manualInput.value),
          });
          save();
          xpMessage = `Recorded ${entry.label} for ${entry.cost} XP.`;
          redrawXpAssistant();
        } catch (err) {
          status.textContent = err.message;
          status.style.color = 'var(--danger)';
        }
      },
    }, 'Buy & record');

    const ledger = (d.xp.ledger || []).slice(-8).reverse();
    xpBody.append(
      el('p', { class: 'muted small' },
        'The assistant buys one dot at a time and applies it to the sheet. Rating costs use the new rating; specialties and advantage dots cost 3 XP. Rituals and formulae are recorded without bundling their text.'),
      el('div', { class: 'row' }, kindSel, targetHost,
        levelLabel, levelInput,
        manualLabel, manualInput,
        costText, apply),
      status,
      ledger.length ? el('div', { class: 'card', style: 'margin-top:8px' },
        el('div', { class: 'small muted' }, 'Recent XP ledger'),
        ledger.map((entry) => el('div', { class: 'small' },
          `${entry.label} · ${entry.cost} XP`))) : null);
    rebuildTarget();
  }
  redrawXpAssistant();
  wrap.append(xpDetails);

  wrap.append(el('details', { open: true }, el('summary', {}, 'Disciplines & powers'),
    listEdit(d.disciplines, (disc) => el('span', { style: 'flex:1' },
      el('div', { class: 'row' },
        textInput(disc.name, (v) => { disc.name = v; save(); }, { placeholder: 'Discipline', style: 'flex:1' }),
        numInput(disc.rating, (v) => { disc.rating = v; save(); }, { min: 0, max: 5, title: 'rating' })),
      listEdit(disc.powers ??= [], (p) => el('span', { style: 'flex:1' },
        el('div', { class: 'row' },
          textInput(p.name, (v) => { p.name = v; save(); }, { placeholder: 'Power', style: 'flex:1' }),
          numInput(p.level, (v) => { p.level = v; save(); }, { min: 1, max: 5, title: 'level' }),
          textInput(p.wikiUrl, (v) => { p.wikiUrl = v; save(); }, { placeholder: 'reference URL', style: 'width:180px' })),
        areaInput(p.desc, (v) => { p.desc = v; save(); }, { placeholder: 'Paste the power description from your book or the wiki…', rows: 2 })),
        () => ({ name: '', level: 1, desc: '', wikiUrl: '' }), save)),
      () => ({ name: '', rating: 1, powers: [] }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Specialties'),
    listEdit(d.specialties, (sp) => el('span', { class: 'row', style: 'flex:1' },
      textInput(sp.skill, (v) => { sp.skill = v; save(); }, { placeholder: 'Skill', style: 'width:140px' }),
      textInput(sp.name, (v) => { sp.name = v; save(); }, { placeholder: 'Specialty', style: 'flex:1' })),
      () => ({ skill: '', name: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Advantages & flaws'),
    listEdit(d.advantages, (a) => el('span', { class: 'row', style: 'flex:1' },
      el('label', { class: 'small', style: 'display:flex;align-items:center;gap:3px' },
        el('input', { type: 'checkbox', checked: !!a.flaw, onchange: (ev) => { a.flaw = ev.target.checked; save(); } }), 'flaw'),
      textInput(a.name, (v) => { a.name = v; save(); }, { placeholder: 'Name', style: 'flex:1' }),
      numInput(a.dots, (v) => { a.dots = v; save(); }, { min: 0, max: 5 }),
      textInput(a.desc, (v) => { a.desc = v; save(); }, { placeholder: 'note', style: 'flex:1' })),
      () => ({ name: '', dots: 1, flaw: false, desc: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Convictions & touchstones'),
    listEdit(d.convictions, (c, onCh) => textInput(c, () => {}, { style: 'flex:1', disabled: true, title: 'Convictions are plain strings — remove and re-add to change' }),
      () => (prompt('Conviction:') || '').trim(), save),
    listEdit(d.touchstones, (t) => el('span', { class: 'row', style: 'flex:1' },
      textInput(t.name, (v) => { t.name = v; save(); }, { placeholder: 'Touchstone', style: 'width:160px' }),
      textInput(t.desc, (v) => { t.desc = v; save(); }, { placeholder: 'who they are to you', style: 'flex:1' })),
      () => ({ name: '', conviction: '', desc: '' }), save)));

  wrap.append(frow('Notes', areaInput(d.notes, (v) => { d.notes = v; save(); }, { style: 'flex:1' })));
  return wrap;
}

// ---------- PDF ----------

export function writePdf(w, data) {
  const d = { ...defaults(), ...(data || {}) };
  w.line(summary(d), { bold: true });
  if (d.sire) w.line(`Childe of ${d.sire}`);
  if (d.ambition) w.line(`Ambition: ${d.ambition}`);
  if (d.desire) w.line(`Desire: ${d.desire}`);
  for (const [group, attrs] of Object.entries(ATTR_GROUPS)) {
    w.line(`${cap(group)}: ${attrs.map((a) => `${cap(a)} ${d.attributes[a] ?? 1}`).join(', ')}`);
  }
  const rated = ALL_SKILLS.filter((s) => (d.skills[s] ?? 0) > 0);
  if (rated.length) w.line(`Skills: ${rated.map((s) => `${s} ${d.skills[s]}`).join(', ')}`);
  if ((d.specialties || []).length) w.line(`Specialties: ${d.specialties.map((sp) => `${sp.skill} (${sp.name})`).join(', ')}`);
  w.line(`Health ${healthMax(d)}   Willpower ${willpowerMax(d)}   Hunger ${d.hunger}   Humanity ${d.humanity}   Blood potency ${d.bloodPotency}`);
  for (const disc of d.disciplines || []) {
    w.line(`${disc.name} ${disc.rating}: ${(disc.powers || []).map((p) => `${p.name} (L${p.level})`).join(', ')}`);
    for (const p of disc.powers || []) if (p.desc) w.para(`${p.name}. ${p.desc}`);
  }
  const adv = (d.advantages || []).filter((a) => !a.flaw), flaws = (d.advantages || []).filter((a) => a.flaw);
  if (adv.length) w.line(`Advantages: ${adv.map((a) => `${a.name} ${a.dots}`).join(', ')}`);
  if (flaws.length) w.line(`Flaws: ${flaws.map((a) => `${a.name} ${a.dots}`).join(', ')}`);
  (d.convictions || []).forEach((c, i) => {
    const t = (d.touchstones || [])[i];
    w.line(`Conviction: ${c}${t?.name ? ` — touchstone: ${t.name}` : ''}`);
  });
  if (d.xp?.total || d.xp?.spent) {
    w.line(`Experience: ${Math.max(0, Number(d.xp.total || 0) - Number(d.xp.spent || 0))} available; ${d.xp.spent || 0} / ${d.xp.total || 0} spent`);
  }
  for (const entry of (d.xp?.ledger || []).slice(-10)) w.line(`XP: ${entry.label} (${entry.cost})`);
  if (d.notes) w.para(d.notes);
}

// ---------- wizard ----------

function counts(values) {
  const c = {};
  for (const v of values) c[v] = (c[v] || 0) + 1;
  return c;
}
function spreadOk(values, spread) {
  const c = counts(values.filter((v) => v > 0));
  const want = Object.fromEntries(Object.entries(spread).map(([k, v]) => [Number(k), v]));
  const keys = new Set([...Object.keys(c).map(Number), ...Object.keys(want).map(Number)]);
  for (const k of keys) if ((c[k] || 0) !== (want[k] || 0)) return false;
  return true;
}
const spreadLabel = (spread) => Object.entries(spread).sort((a, b) => b[0] - a[0])
  .map(([v, n]) => `${n}× at ${v}`).join(', ');

export const wizard = {
  intro: 'An Embrace, step by step: clan, attributes, skills, disciplines, how you hunt, what still tethers you to your Humanity. The app knows the names and the math; the power text comes from your own books, one paste away.',
  steps: [
    {
      key: 'clan', title: 'Clan',
      render(draft, ctx) {
        const pickClan = (c) => {
          if (draft.clan && draft.clan.name !== c.name) {
            // the discipline picks belong to the old clan's options
            draft.discDots = null;
            draft.powerPicks = {};
          }
          draft.clan = c;
          ctx.update();
        };
        return el('div', {},
          el('div', { class: 'wiz-card-actions' }, surprisePickButton(ctx.data.clans, pickClan)),
          el('div', { class: 'edition-cards wiz-cards' },
            ctx.data.clans.map((c) => el('div', {
              class: `edition-card${draft.clan?.name === c.name ? ' sel' : ''}`,
              onclick: () => pickClan(c),
            },
              el('div', { style: 'font-weight:600' }, c.name),
              el('div', { class: 'muted small' }, c.disciplines.join(' · ') || c.note || ''),
              c.compulsion ? el('div', { class: 'muted small' }, `Compulsion: ${c.compulsion}`) : null))),
          draft.clan ? el('a', { class: 'small', href: draft.clan.wikiUrl, target: '_blank', rel: 'noopener' }, `Read about the ${draft.clan.name} ↗`) : null);
      },
      validate: (draft) => draft.clan ? null : 'Pick a clan.',
    },
    {
      key: 'attributes', title: 'Attributes',
      render(draft, ctx) {
        draft.attributes ??= Object.fromEntries(ALL_ATTRS.map((a) => [a, 1]));
        const spread = ctx.data.attributeSpread;
        const note = el('div', { class: 'small', style: 'margin:8px 0' });
        const refresh = () => {
          const ok = spreadOk(Object.values(draft.attributes), spread);
          note.textContent = `Take one attribute at 4, three at 3, four at 2 and one at 1 (${spreadLabel(spread)}). ` +
            (ok ? '✓ spread is legal' : 'Current: ' + Object.entries(counts(Object.values(draft.attributes))).sort((a, b) => b[0] - a[0]).map(([v, n]) => `${n}× at ${v}`).join(', '));
          note.style.color = ok ? 'var(--ok)' : 'var(--muted)';
        };
        const cols = el('div', { class: 'sheet-cols' },
          Object.entries(ATTR_GROUPS).map(([group, attrs]) => el('div', { class: 'sheet-col' },
            el('div', { class: 'sheet-sec-title' }, cap(group)),
            attrs.map((a) => {
              const sel = el('select', {}, [1, 2, 3, 4].map((v) => el('option', { value: v }, '●'.repeat(v))));
              sel.value = draft.attributes[a];
              sel.addEventListener('change', () => { draft.attributes[a] = Number(sel.value); refresh(); });
              return el('div', { class: 'row small', style: 'justify-content:space-between' }, cap(a), sel);
            }))));
        refresh();
        return el('div', {}, note, cols);
      },
      validate: (draft, ctx) => spreadOk(Object.values(draft.attributes || {}), ctx.data.attributeSpread)
        ? null : 'The attribute spread must be exactly 4/3/3/3/2/2/2/2/1.',
    },
    {
      key: 'skills', title: 'Skills',
      render(draft, ctx) {
        draft.skills ??= Object.fromEntries(ALL_SKILLS.map((s) => [s, 0]));
        const dists = ctx.data.skillDistributions;
        draft.skillDist ??= 'balanced';
        const note = el('div', { class: 'small', style: 'margin:8px 0' });
        const refresh = () => {
          const spread = dists[draft.skillDist].spread;
          const ok = spreadOk(Object.values(draft.skills), spread);
          note.textContent = `${dists[draft.skillDist].label}: ${spreadLabel(spread)}. ` + (ok ? '✓ spread is legal' : 'Keep assigning…');
          note.style.color = ok ? 'var(--ok)' : 'var(--muted)';
        };
        const distChoices = Object.entries(dists);
        const pickDist = ([key]) => { draft.skillDist = key; ctx.update(); };
        const distCards = el('div', {},
          el('div', { class: 'wiz-card-actions' }, surprisePickButton(distChoices, pickDist)),
          el('div', { class: 'edition-cards' },
            distChoices.map((choice) => {
              const [key, dist] = choice;
              return el('div', {
                class: `edition-card${draft.skillDist === key ? ' sel' : ''}`,
                onclick: () => pickDist(choice),
              }, el('div', { style: 'font-weight:600' }, dist.label), el('div', { class: 'muted small' }, spreadLabel(dist.spread)));
            })));
        const cols = el('div', { class: 'sheet-cols' },
          Object.entries(SKILL_GROUPS).map(([group, skills]) => el('div', { class: 'sheet-col' },
            el('div', { class: 'sheet-sec-title' }, cap(group)),
            skills.map((s) => {
              const sel = el('select', {}, [0, 1, 2, 3, 4].map((v) => el('option', { value: v }, v ? '●'.repeat(v) : '—')));
              sel.value = draft.skills[s];
              sel.addEventListener('change', () => { draft.skills[s] = Number(sel.value); refresh(); });
              return el('div', { class: 'row small', style: 'justify-content:space-between' }, s, sel);
            }))));
        refresh();
        return el('div', {}, distCards, note, cols);
      },
      validate: (draft, ctx) => spreadOk(Object.values(draft.skills || {}), ctx.data.skillDistributions[draft.skillDist].spread)
        ? null : 'The skill dots must match the chosen distribution exactly.',
    },
    {
      key: 'disciplines', title: 'Disciplines',
      render(draft, ctx) {
        const options = draft.clan.disciplines.length ? draft.clan.disciplines
          : ctx.data.disciplines.map((d) => d.name); // Caitiff: anything goes
        draft.discDots ??= [options[0], options[1] || options[0]];
        const wrap = el('div', {},
          el('p', { class: 'small muted' }, 'You wake with two dots of your clan\'s disciplines. Put both in one for a deeper power, or split them for breadth.'));
        const mkSel = (i) => {
          const sel = el('select', {}, options.map((o) => el('option', { value: o }, o)));
          sel.value = draft.discDots[i];
          sel.addEventListener('change', () => { draft.discDots[i] = sel.value; draft.powerPicks = {}; ctx.update(); });
          return sel;
        };
        wrap.append(el('div', { class: 'row' }, el('span', { class: 'small' }, 'Dot 1:'), mkSel(0), el('span', { class: 'small' }, 'Dot 2:'), mkSel(1)));

        draft.powerPicks ??= {};
        const ratings = counts(draft.discDots);
        for (const [discName, rating] of Object.entries(ratings)) {
          const disc = ctx.data.disciplines.find((x) => x.name === discName);
          if (!disc) continue;
          const picksNeeded = rating === 2 ? [1, 2] : [1];
          const box = el('div', { class: 'card', style: 'margin-top:10px' },
            el('div', { class: 'row' }, el('strong', {}, discName), el('span', { class: 'muted small' }, '●'.repeat(rating)),
              el('a', { class: 'small', href: disc.wikiUrl, target: '_blank', rel: 'noopener' }, 'reference ↗')));
          picksNeeded.forEach((maxLevel, i) => {
            const eligible = disc.powers.filter((p) => p.level <= maxLevel);
            const key = `${discName}:${i}`;
            const sel = el('select', {}, el('option', { value: '' }, `— pick a level ≤${maxLevel} power —`),
              eligible.map((p) => el('option', { value: p.name }, `${p.name} (L${p.level})`)));
            sel.value = draft.powerPicks[key] || '';
            sel.addEventListener('change', () => { draft.powerPicks[key] = sel.value; });
            box.append(el('div', { class: 'row small', style: 'margin-top:6px' }, `Power ${i + 1}:`, sel));
          });
          wrap.append(box);
        }
        return wrap;
      },
      validate(draft) {
        const ratings = counts(draft.discDots || []);
        for (const [discName, rating] of Object.entries(ratings)) {
          const need = rating === 2 ? 2 : 1;
          const picked = [];
          for (let i = 0; i < need; i++) {
            const p = draft.powerPicks?.[`${discName}:${i}`];
            if (!p) return `Pick your ${discName} power${need > 1 ? 's' : ''}.`;
            picked.push(p);
          }
          if (new Set(picked).size !== picked.length) return `Pick two different ${discName} powers.`;
        }
        return null;
      },
    },
    {
      key: 'predator', title: 'Predator type',
      render(draft, ctx) {
        const pickPredator = (p) => { draft.predator = p; ctx.update(); };
        return el('div', {},
          el('div', { class: 'wiz-card-actions' }, surprisePickButton(ctx.data.predatorTypes, pickPredator)),
          el('div', { class: 'edition-cards wiz-cards' },
            ctx.data.predatorTypes.map((p) => el('div', {
              class: `edition-card${draft.predator?.name === p.name ? ' sel' : ''}`,
              onclick: () => pickPredator(p),
            }, el('div', { style: 'font-weight:600' }, p.name),
              el('ul', { class: 'muted small', style: 'margin:4px 0 0 16px;padding:0' },
                p.gains.map((g) => el('li', {}, g)))))),
          el('p', { class: 'small muted', style: 'margin-top:8px' },
            'These picks get written into the finished sheet\'s notes. Apply the dots afterwards by clicking them on the sheet.'));
      },
      validate: (draft) => draft.predator ? null : 'Pick how you hunt.',
    },
    {
      key: 'convictions', title: 'Convictions',
      render(draft) {
        draft.convictions ??= [{ text: '', touchstone: '' }];
        const wrap = el('div', {}, el('p', { class: 'small muted' }, 'One to three things you still believe, each anchored to a living mortal. Pick ones that can be threatened.'));
        const list = el('div', {});
        const redraw = () => {
          list.innerHTML = '';
          draft.convictions.forEach((c, i) => {
            list.append(el('div', { class: 'row', style: 'margin-top:6px' },
              el('input', { value: c.text, placeholder: 'Conviction (e.g. Never betray family)', style: 'flex:1', oninput: (ev) => { c.text = ev.target.value; } }),
              el('input', { value: c.touchstone, placeholder: 'Touchstone (a mortal who embodies it)', style: 'flex:1', oninput: (ev) => { c.touchstone = ev.target.value; } }),
              draft.convictions.length > 1 ? el('button', { class: 'ghost danger small', onclick: () => { draft.convictions.splice(i, 1); redraw(); } }, '✕') : null));
          });
          if (draft.convictions.length < 3) {
            list.append(el('button', { class: 'ghost small', style: 'margin-top:6px', onclick: () => { draft.convictions.push({ text: '', touchstone: '' }); redraw(); } }, '+ Add conviction'));
          }
        };
        redraw();
        wrap.append(list);
        return wrap;
      },
      validate: (draft) => (draft.convictions || []).some((c) => c.text.trim()) ? null : 'Write at least one conviction.',
    },
    {
      key: 'advantages', title: 'Advantages & flaws',
      render(draft) {
        draft.advantages ??= [];
        const note = el('div', { class: 'small', style: 'margin:8px 0' });
        const refresh = () => {
          const adv = draft.advantages.filter((a) => !a.flaw).reduce((s, a) => s + (a.dots || 0), 0);
          const flaw = draft.advantages.filter((a) => a.flaw).reduce((s, a) => s + (a.dots || 0), 0);
          note.textContent = `${adv} / 7 advantage dots · ${flaw} / 2 flaw dots`;
          note.style.color = adv === 7 && flaw === 2 ? 'var(--ok)' : 'var(--muted)';
        };
        const list = el('div', {});
        const redraw = () => {
          list.innerHTML = '';
          draft.advantages.forEach((a, i) => {
            list.append(el('div', { class: 'row', style: 'margin-top:6px' },
              el('label', { class: 'small', style: 'display:flex;align-items:center;gap:3px' },
                el('input', { type: 'checkbox', checked: !!a.flaw, onchange: (ev) => { a.flaw = ev.target.checked; refresh(); } }), 'flaw'),
              el('input', { value: a.name, placeholder: a.flaw ? 'Flaw (e.g. Enemy)' : 'Advantage (e.g. Resources, Herd, Loresheet)', style: 'flex:1', oninput: (ev) => { a.name = ev.target.value; } }),
              el('input', { type: 'number', min: 1, max: 5, value: a.dots, style: 'width:60px', oninput: (ev) => { a.dots = Number(ev.target.value) || 1; refresh(); } }),
              el('button', { class: 'ghost danger small', onclick: () => { draft.advantages.splice(i, 1); redraw(); refresh(); } }, '✕')));
          });
          list.append(el('button', { class: 'ghost small', style: 'margin-top:6px', onclick: () => { draft.advantages.push({ name: '', dots: 1, flaw: false }); redraw(); refresh(); } }, '+ Add'));
        };
        redraw();
        refresh();
        return el('div', {}, el('p', { class: 'small muted' }, 'Seven dots of advantages, two dots of flaws. The book says so, and this wizard will hold you to it. Your predator type may pile more on afterwards.'), note, list);
      },
      validate(draft) {
        const adv = (draft.advantages || []).filter((a) => !a.flaw).reduce((s, a) => s + (a.dots || 0), 0);
        const flaw = (draft.advantages || []).filter((a) => a.flaw).reduce((s, a) => s + (a.dots || 0), 0);
        if (adv !== 7) return `Spend exactly 7 advantage dots (currently ${adv}).`;
        if (flaw !== 2) return `Take exactly 2 dots of flaws (currently ${flaw}).`;
        if ((draft.advantages || []).some((a) => !a.name.trim())) return 'Every advantage and flaw needs a name.';
        return null;
      },
    },
    {
      key: 'review', title: 'Review',
      render(draft, ctx) {
        draft.name ??= '';
        draft.genPick ??= ctx.data.generation.find((g) => g.generation === 13);
        const genSel = el('select', {}, ctx.data.generation.map((g, i) => el('option', { value: i }, g.label)));
        genSel.value = String(ctx.data.generation.indexOf(draft.genPick));
        genSel.addEventListener('change', () => { draft.genPick = ctx.data.generation[Number(genSel.value)]; ctx.update(); });
        const a = draft.attributes;
        const nameInput = el('input', { value: draft.name, placeholder: 'Character name', style: 'flex:1', oninput: (ev) => { draft.name = ev.target.value; } });
        const nameRoll = el('button', {
          class: 'ghost small', title: 'Suggest a person name', 'aria-label': 'Suggest a person name',
          onclick: () => { draft.name = personName(); nameInput.value = draft.name; },
        }, '🎲');
        return el('div', {},
          el('div', { class: 'row' },
            el('label', {}, 'Name'), nameInput, nameRoll,
            el('label', {}, 'Sire'), el('input', { value: draft.sire || '', style: 'flex:1', oninput: (ev) => { draft.sire = ev.target.value; } })),
          el('div', { class: 'row', style: 'margin-top:8px' },
            el('label', {}, 'Ambition'), el('input', { value: draft.ambition || '', style: 'flex:1', oninput: (ev) => { draft.ambition = ev.target.value; } }),
            el('label', {}, 'Desire'), el('input', { value: draft.desire || '', style: 'flex:1', oninput: (ev) => { draft.desire = ev.target.value; } })),
          el('div', { class: 'row', style: 'margin-top:8px' }, el('label', {}, 'Generation'), genSel),
          el('div', { class: 'card', style: 'margin-top:10px' },
            el('div', {}, `${draft.clan.name} · ${draft.predator.name} · ${draft.genPick.label}`),
            el('div', { class: 'small muted' },
              `Health ${a.stamina + 3} · Willpower ${a.composure + a.resolve} · Humanity 7 · Blood potency ${draft.genPick.bloodPotency} · Hunger starts at 1`)));
      },
      validate: (draft) => draft.name?.trim() ? null : 'Give the character a name.',
    },
  ],
  finish(draft, ctx) {
    const d = defaults();
    d.clan = draft.clan.name;
    d.generation = draft.genPick.generation;
    d.bloodPotency = draft.genPick.bloodPotency;
    d.predatorType = draft.predator.name;
    d.sire = draft.sire || '';
    d.ambition = draft.ambition || '';
    d.desire = draft.desire || '';
    d.attributes = { ...draft.attributes };
    d.skills = { ...draft.skills };
    const ratings = counts(draft.discDots);
    d.disciplines = Object.entries(ratings).map(([name, rating]) => {
      const disc = ctx.data.disciplines.find((x) => x.name === name);
      const powers = [];
      for (let i = 0; i < (rating === 2 ? 2 : 1); i++) {
        const pName = draft.powerPicks[`${name}:${i}`];
        const p = disc?.powers.find((x) => x.name === pName);
        if (p) powers.push({ name: p.name, level: p.level, desc: '', wikiUrl: disc.wikiUrl });
      }
      return { name, rating, powers };
    });
    d.advantages = draft.advantages.map((a) => ({ ...a, desc: '' }));
    d.convictions = draft.convictions.filter((c) => c.text.trim()).map((c) => c.text.trim());
    d.touchstones = draft.convictions.filter((c) => c.text.trim()).map((c) => ({ name: c.touchstone.trim(), conviction: c.text.trim(), desc: '' }));
    d.notes = `Predator type picks to apply:\n${draft.predator.gains.map((g) => `• ${g}`).join('\n')}`;
    return {
      name: draft.name.trim(),
      fields: { Role: 'PC', Species: 'Vampire', Status: 'Undead' },
      data: d,
      tags: ['vampire', 'pc'],
    };
  },
};
