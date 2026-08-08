// D&D 5.5e (2024 rules) character sheet + creation wizard, powered by the
// bundled SRD 5.2 content pack (public/srd52/, CC-BY-4.0).

import { el, esc } from '../util.js';
import { linkDice } from '../render.js';
import {
  dotsHtml, boxesHtml, rollBtn, kvHtml, sectionHtml,
  frow, textInput, numInput, areaInput, listEdit,
} from './sheetlib.js';

export const label = 'D&D 5.5e (2024)';
export const tagline = 'The 2024 rules, with the whole SRD in the box.';

// ---------- SRD 5.2 data (lazy, cached) ----------

const cache = {};
async function fetchPack(name) {
  if (!cache[name]) {
    const res = await fetch(`/srd52/${name}.json`);
    if (!res.ok) throw new Error(`srd52/${name}.json missing — run npm run srd52`);
    cache[name] = await res.json();
  }
  return cache[name];
}
export async function loadData() {
  const [classes, species, backgrounds, feats, spells, equipment] = await Promise.all(
    ['classes', 'species', 'backgrounds', 'feats', 'spells', 'equipment'].map(fetchPack));
  return {
    classes: classes.classes, species: species.species, backgrounds: backgrounds.backgrounds,
    feats: feats.feats, spells: spells.spells, equipment: equipment.equipment,
  };
}

// ---------- rules constants ----------

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABILITY_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const SKILLS = [
  ['Acrobatics', 'dex'], ['Animal Handling', 'wis'], ['Arcana', 'int'], ['Athletics', 'str'],
  ['Deception', 'cha'], ['History', 'int'], ['Insight', 'wis'], ['Intimidation', 'cha'],
  ['Investigation', 'int'], ['Medicine', 'wis'], ['Nature', 'int'], ['Perception', 'wis'],
  ['Performance', 'cha'], ['Persuasion', 'cha'], ['Religion', 'int'], ['Sleight of Hand', 'dex'],
  ['Stealth', 'dex'], ['Survival', 'wis'],
];
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
// starting cantrips-known / prepared-spells for level-1 casters (2024 tables)
const CASTER_L1 = {
  Bard: { cantrips: 2, prepared: 4 }, Cleric: { cantrips: 3, prepared: 4 },
  Druid: { cantrips: 2, prepared: 4 }, Paladin: { cantrips: 0, prepared: 2 },
  Ranger: { cantrips: 0, prepared: 2 }, Sorcerer: { cantrips: 4, prepared: 2 },
  Warlock: { cantrips: 2, prepared: 2 }, Wizard: { cantrips: 3, prepared: 4 },
};
const L1_SLOTS = { Bard: 2, Cleric: 2, Druid: 2, Sorcerer: 2, Wizard: 2, Warlock: 1, Paladin: 2, Ranger: 2 };

export const mod = (score) => Math.floor((score ?? 10) / 2) - 5;
const fmtMod = (m) => (m >= 0 ? `+${m}` : String(m));
export const profBonus = (level) => 2 + Math.floor(((level || 1) - 1) / 4);

// ---------- data shape ----------

export function defaults() {
  return {
    species: { name: '', size: 'Medium', speed: 30 },
    klass: { name: '', level: 1, hitDie: 8, subclass: '' },
    background: { name: '', feat: '' },
    abilityMethod: 'standard',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saves: [], skills: [], languages: [],
    ac: 10, speed: 30,
    hp: { max: 8, current: 8, temp: 0 },
    hitDice: { spent: 0 },
    attacks: [], equipment: [], coins: { gp: 0, sp: 0, cp: 0 },
    spellcasting: null,
    features: [], personality: { traits: '', ideals: '', bonds: '', flaws: '' },
    notes: '',
  };
}

export function summary(data) {
  const d = data || defaults();
  return `Level ${d.klass.level} ${d.species.name} ${d.klass.name}${d.klass.subclass ? ` (${d.klass.subclass})` : ''}`.replace(/\s+/g, ' ').trim();
}

export function searchText(data) {
  const d = data || {};
  return [d.species?.name, d.klass?.name, d.klass?.subclass, d.background?.name,
    ...(d.features || []).map((f) => f.name),
    ...(d.spellcasting?.prepared || []), ...(d.spellcasting?.cantrips || []),
  ].filter(Boolean).join(' ');
}

// ---------- rendered sheet ----------

export function html(data) {
  const d = { ...defaults(), ...(data || {}) };
  const pb = profBonus(d.klass.level);
  const abilityTiles = ABILITIES.map((a) => {
    const m = mod(d.abilities[a]);
    return `<div class="sb-ab"><div class="ab-n">${a.toUpperCase()}</div>` +
      `<div class="ab-v">${d.abilities[a] ?? 10}</div>` +
      `<div class="ab-m">${rollBtn({ kind: 'check', mod: m, label: `${ABILITY_NAMES[a]} check` }, fmtMod(m), 'Roll — Shift for advantage, Ctrl for disadvantage')}</div></div>`;
  }).join('');

  const saveRow = ABILITIES.map((a) => {
    const isProf = d.saves.includes(a);
    const m = mod(d.abilities[a]) + (isProf ? pb : 0);
    return `<span class="sheet-pill${isProf ? ' on' : ''}">${rollBtn({ kind: 'check', mod: m, label: `${ABILITY_NAMES[a]} save` }, `${a.toUpperCase()} ${fmtMod(m)}`, 'Roll save — Shift/Ctrl for adv/dis')}</span>`;
  }).join(' ');

  const skillRows = SKILLS.map(([name, a]) => {
    const entry = (d.skills || []).find((s) => s.key === name);
    const bonus = mod(d.abilities[a]) + (entry ? pb * (entry.prof === 'expert' ? 2 : 1) : 0);
    const mark = entry ? (entry.prof === 'expert' ? '◉' : '●') : '○';
    return `<div class="sheet-skill">${mark} ${rollBtn({ kind: 'check', mod: bonus, label: name }, `${esc(name)} ${fmtMod(bonus)}`, 'Roll — Shift/Ctrl for adv/dis')} <span class="muted">(${a.toUpperCase()})</span></div>`;
  }).join('');

  const attacks = (d.attacks || []).length
    ? d.attacks.map((atk) => `<div class="sheet-kv"><span class="sk">${esc(atk.name)}</span><span class="sv">` +
        rollBtn({ kind: 'check', mod: atk.bonus || 0, label: `${atk.name} attack` }, `${fmtMod(atk.bonus || 0)} to hit`, 'Attack roll — Shift/Ctrl adv/dis') +
        ` · ${linkDice(esc(atk.damage || ''))}${atk.notes ? ` <span class="muted">${esc(atk.notes)}</span>` : ''}</span></div>`).join('')
    : '<div class="muted small">No attacks recorded.</div>';

  let spellsHtml = '';
  if (d.spellcasting) {
    const sc = d.spellcasting;
    const slotRows = Object.entries(sc.slots || {}).filter(([, s]) => s.max > 0)
      .map(([lvl, s]) => kvHtml(`Level ${lvl} slots`, boxesHtml(s.max, s.used || 0, `spellcasting.slots.${lvl}.used`)))
      .join('');
    spellsHtml = sectionHtml('Spellcasting',
      kvHtml('Ability', `${(sc.ability || '').toUpperCase()} · save DC ${sc.dc ?? '—'} · ${rollBtn({ kind: 'check', mod: sc.attackBonus || 0, label: 'Spell attack' }, `${fmtMod(sc.attackBonus || 0)} to hit`, 'Spell attack roll')}`) +
      slotRows +
      ((sc.cantrips || []).length ? kvHtml('Cantrips', esc(sc.cantrips.join(', '))) : '') +
      ((sc.prepared || []).length ? kvHtml('Prepared', esc(sc.prepared.join(', '))) : ''));
  }

  const features = (d.features || []).map((f) =>
    `<div class="sheet-feature"><strong>${esc(f.name)}</strong>${f.source ? ` <span class="muted small">(${esc(f.source)})</span>` : ''}<div class="sheet-feature-text">${esc(f.text || '').replace(/\n/g, '<br>')}</div></div>`).join('');

  const equipment = (d.equipment || []).map((e) => `${esc(e.name)}${e.qty > 1 ? ` ×${e.qty}` : ''}`).join(', ');
  const initiative = fmtMod(mod(d.abilities.dex));

  return `<div class="sheet sheet-dnd">
    <div class="sheet-head">
      <span class="sheet-title">${esc(summary(d))}</span>
      <span class="muted">${esc(d.background.name ? `${d.background.name} background` : '')}${d.background.feat ? ` · ${esc(d.background.feat)}` : ''}</span>
    </div>
    <div class="sb-abilities">${abilityTiles}</div>
    ${sectionHtml('Combat',
      kvHtml('AC', `${d.ac}`) + kvHtml('Initiative', rollBtn({ kind: 'check', mod: mod(d.abilities.dex), label: 'Initiative' }, initiative, 'Roll initiative')) +
      kvHtml('Speed', `${d.speed} ft.`) +
      kvHtml('Hit points', `${d.hp.current} / ${d.hp.max}${d.hp.temp ? ` (+${d.hp.temp} temp)` : ''}`) +
      kvHtml('Hit dice', `${boxesHtml(d.klass.level, d.hitDice.spent || 0, 'hitDice.spent')} d${d.klass.hitDie}`) +
      kvHtml('Proficiency', fmtMod(pb)))}
    ${sectionHtml('Saving throws', `<div class="sheet-pills">${saveRow}</div>`)}
    ${sectionHtml('Skills', `<div class="sheet-skills">${skillRows}</div>`)}
    ${sectionHtml('Attacks', attacks)}
    ${spellsHtml}
    ${features ? sectionHtml('Features & traits', features) : ''}
    ${equipment ? sectionHtml('Equipment', `<div class="small">${equipment}</div>` + kvHtml('Coins', `${d.coins.gp || 0} gp, ${d.coins.sp || 0} sp, ${d.coins.cp || 0} cp`)) : ''}
    ${Object.values(d.personality || {}).some(Boolean) ? sectionHtml('Personality',
      ['traits', 'ideals', 'bonds', 'flaws'].filter((k) => d.personality[k]).map((k) => kvHtml(k[0].toUpperCase() + k.slice(1), esc(d.personality[k]))).join('')) : ''}
    ${d.notes ? sectionHtml('Notes', `<div class="small">${esc(d.notes).replace(/\n/g, '<br>')}</div>`) : ''}
  </div>`;
}

// ---------- editor ----------

export function editor(block, save) {
  const d = block.data = { ...defaults(), ...(block.data || {}) };
  const wrap = el('div', { class: 'sb-form' });

  wrap.append(
    el('div', { class: 'row' },
      frow('Species', textInput(d.species.name, (v) => { d.species.name = v; save(); })),
      frow('Class', textInput(d.klass.name, (v) => { d.klass.name = v; save(); })),
      frow('Subclass', textInput(d.klass.subclass, (v) => { d.klass.subclass = v; save(); })),
      frow('Level', numInput(d.klass.level, (v) => { d.klass.level = Math.max(1, v); save(); }, { min: 1, max: 20 }))),
    el('div', { class: 'row' },
      frow('Background', textInput(d.background.name, (v) => { d.background.name = v; save(); })),
      frow('Origin feat', textInput(d.background.feat, (v) => { d.background.feat = v; save(); }))),
    el('div', { class: 'sb-abrow' },
      ...ABILITIES.map((a) => el('label', {}, a.toUpperCase(),
        numInput(d.abilities[a], (v) => { d.abilities[a] = v; save(); }, { min: 1, max: 30 })))),
    el('div', { class: 'row' },
      frow('AC', numInput(d.ac, (v) => { d.ac = v; save(); })),
      frow('Speed', numInput(d.speed, (v) => { d.speed = v; save(); })),
      frow('HP max', numInput(d.hp.max, (v) => { d.hp.max = v; save(); })),
      frow('HP now', numInput(d.hp.current, (v) => { d.hp.current = v; save(); })),
      frow('Temp', numInput(d.hp.temp, (v) => { d.hp.temp = v; save(); }))),
    el('div', { class: 'row small' }, 'Save proficiencies: ',
      ...ABILITIES.map((a) => el('label', { style: 'display:flex;gap:3px;align-items:center' },
        el('input', {
          type: 'checkbox', checked: d.saves.includes(a),
          onchange: (ev) => {
            d.saves = ev.target.checked ? [...d.saves, a] : d.saves.filter((x) => x !== a);
            save();
          },
        }), a.toUpperCase()))));

  // skills: none / proficient / expertise
  const skillsWrap = el('div', { class: 'sheet-edit-skills' });
  for (const [name] of SKILLS) {
    const sel = el('select', {},
      el('option', { value: '' }, '—'),
      el('option', { value: 'prof' }, 'proficient'),
      el('option', { value: 'expert' }, 'expertise'));
    sel.value = (d.skills.find((s) => s.key === name) || {}).prof || '';
    sel.addEventListener('change', () => {
      d.skills = d.skills.filter((s) => s.key !== name);
      if (sel.value) d.skills.push({ key: name, prof: sel.value });
      save();
    });
    skillsWrap.append(el('label', { class: 'small' }, name, sel));
  }
  wrap.append(el('details', {}, el('summary', {}, 'Skills'), skillsWrap));

  wrap.append(el('details', {}, el('summary', {}, 'Attacks'),
    listEdit(d.attacks, (atk) => el('span', { class: 'row', style: 'flex:1' },
      textInput(atk.name, (v) => { atk.name = v; save(); }, { placeholder: 'Name', style: 'flex:1' }),
      numInput(atk.bonus, (v) => { atk.bonus = v; save(); }, { title: 'to hit' }),
      textInput(atk.damage, (v) => { atk.damage = v; save(); }, { placeholder: '1d8+3 slashing', style: 'flex:1' })),
      () => ({ name: '', bonus: 0, damage: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Equipment & coins'),
    listEdit(d.equipment, (eq) => el('span', { class: 'row', style: 'flex:1' },
      textInput(eq.name, (v) => { eq.name = v; save(); }, { style: 'flex:1' }),
      numInput(eq.qty ?? 1, (v) => { eq.qty = v; save(); }, { min: 1 })),
      () => ({ name: '', qty: 1 }), save),
    el('div', { class: 'row' },
      frow('gp', numInput(d.coins.gp, (v) => { d.coins.gp = v; save(); })),
      frow('sp', numInput(d.coins.sp, (v) => { d.coins.sp = v; save(); })),
      frow('cp', numInput(d.coins.cp, (v) => { d.coins.cp = v; save(); })))));

  // spellcasting (toggleable)
  const scWrap = el('div', {});
  const renderSc = () => {
    scWrap.innerHTML = '';
    if (!d.spellcasting) {
      scWrap.append(el('button', {
        class: 'ghost small',
        onclick: () => { d.spellcasting = { ability: 'int', dc: 8 + profBonus(d.klass.level) + mod(d.abilities.int), attackBonus: profBonus(d.klass.level) + mod(d.abilities.int), slots: { 1: { max: 2, used: 0 } }, cantrips: [], prepared: [] }; save(); renderSc(); },
      }, '+ Add spellcasting'));
      return;
    }
    const sc = d.spellcasting;
    scWrap.append(
      el('div', { class: 'row' },
        frow('Ability', textInput(sc.ability, (v) => { sc.ability = v; save(); }, { style: 'width:60px' })),
        frow('Save DC', numInput(sc.dc, (v) => { sc.dc = v; save(); })),
        frow('Attack', numInput(sc.attackBonus, (v) => { sc.attackBonus = v; save(); })),
        el('button', { class: 'ghost danger small', onclick: () => { d.spellcasting = null; save(); renderSc(); } }, 'Remove')),
      el('div', { class: 'row' },
        ...[1, 2, 3, 4, 5].map((lvl) => frow(`L${lvl} slots`, numInput(sc.slots?.[lvl]?.max ?? 0, (v) => {
          sc.slots ??= {};
          sc.slots[lvl] = { max: v, used: Math.min(sc.slots[lvl]?.used || 0, v) };
          save();
        }, { min: 0, max: 9 })))),
      frow('Cantrips', textInput((sc.cantrips || []).join(', '), (v) => { sc.cantrips = v.split(',').map((s) => s.trim()).filter(Boolean); save(); }, { placeholder: 'comma-separated', style: 'flex:1' })),
      frow('Prepared', textInput((sc.prepared || []).join(', '), (v) => { sc.prepared = v.split(',').map((s) => s.trim()).filter(Boolean); save(); }, { placeholder: 'comma-separated', style: 'flex:1' })));
  };
  renderSc();
  wrap.append(el('details', {}, el('summary', {}, 'Spellcasting'), scWrap));

  wrap.append(el('details', {}, el('summary', {}, 'Features & traits'),
    listEdit(d.features, (f) => el('span', { style: 'flex:1' },
      el('div', { class: 'row' },
        textInput(f.name, (v) => { f.name = v; save(); }, { placeholder: 'Feature', style: 'flex:1' }),
        textInput(f.source, (v) => { f.source = v; save(); }, { placeholder: 'Source', style: 'width:120px' })),
      areaInput(f.text, (v) => { f.text = v; save(); }, { placeholder: 'What it does…' })),
      () => ({ name: '', source: '', text: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Personality & notes'),
    ...['traits', 'ideals', 'bonds', 'flaws'].map((k) =>
      frow(k[0].toUpperCase() + k.slice(1), textInput(d.personality[k], (v) => { d.personality[k] = v; save(); }, { style: 'flex:1' }))),
    areaInput(d.notes, (v) => { d.notes = v; save(); }, { placeholder: 'Notes…' })));

  return wrap;
}

// ---------- PDF ----------

export function writePdf(w, data) {
  const d = { ...defaults(), ...(data || {}) };
  const pb = profBonus(d.klass.level);
  w.line(summary(d), { bold: true });
  if (d.background.name) w.line(`${d.background.name} background${d.background.feat ? ` — ${d.background.feat}` : ''}`);
  w.line(ABILITIES.map((a) => `${a.toUpperCase()} ${d.abilities[a]} (${fmtMod(mod(d.abilities[a]))})`).join('   '));
  w.line(`AC ${d.ac}   Initiative ${fmtMod(mod(d.abilities.dex))}   Speed ${d.speed} ft.   HP ${d.hp.max}   Hit dice ${d.klass.level}d${d.klass.hitDie}   Proficiency ${fmtMod(pb)}`);
  w.line(`Saves: ${ABILITIES.map((a) => `${a.toUpperCase()} ${fmtMod(mod(d.abilities[a]) + (d.saves.includes(a) ? pb : 0))}${d.saves.includes(a) ? '*' : ''}`).join(', ')}`);
  const profSkills = SKILLS.filter(([n]) => d.skills.some((s) => s.key === n));
  if (profSkills.length) {
    w.line(`Skills: ${profSkills.map(([n, a]) => {
      const entry = d.skills.find((s) => s.key === n);
      return `${n} ${fmtMod(mod(d.abilities[a]) + pb * (entry.prof === 'expert' ? 2 : 1))}`;
    }).join(', ')}`);
  }
  for (const atk of d.attacks || []) w.line(`Attack: ${atk.name} ${fmtMod(atk.bonus || 0)} to hit, ${atk.damage || ''} ${atk.notes || ''}`);
  if (d.spellcasting) {
    const sc = d.spellcasting;
    w.line(`Spellcasting (${(sc.ability || '').toUpperCase()}): DC ${sc.dc}, ${fmtMod(sc.attackBonus || 0)} to hit; slots ${Object.entries(sc.slots || {}).filter(([, s]) => s.max).map(([l, s]) => `L${l}: ${s.max}`).join(', ')}`);
    if (sc.cantrips?.length) w.line(`Cantrips: ${sc.cantrips.join(', ')}`);
    if (sc.prepared?.length) w.line(`Prepared: ${sc.prepared.join(', ')}`);
  }
  if (d.equipment?.length) w.line(`Equipment: ${d.equipment.map((e) => e.qty > 1 ? `${e.name} x${e.qty}` : e.name).join(', ')}`);
  for (const f of d.features || []) w.para(`${f.name}${f.source ? ` (${f.source})` : ''}. ${f.text || ''}`);
  for (const k of ['traits', 'ideals', 'bonds', 'flaws']) {
    if (d.personality?.[k]) w.line(`${k[0].toUpperCase() + k.slice(1)}: ${d.personality[k]}`);
  }
  if (d.notes) w.para(d.notes);
}

// ---------- wizard ----------

function pickCards(items, get, isSel, onPick) {
  return el('div', { class: 'edition-cards wiz-cards' },
    items.map((item) => {
      const { title, sub } = get(item);
      const card = el('div', { class: `edition-card${isSel(item) ? ' sel' : ''}`, onclick: () => onPick(item) },
        el('div', { style: 'font-weight:600' }, title),
        sub ? el('div', { class: 'muted small' }, sub) : null);
      return card;
    }));
}

export const wizard = {
  intro: 'A level-1 character by the 2024 book: species, class, abilities, background, skills, gear, spells. Every option here ships with the app.',
  steps: [
    {
      key: 'species', title: 'Species',
      render(draft, ctx) {
        return pickCards(ctx.data.species,
          (s) => ({ title: s.name, sub: `${s.size} · ${s.speed} ft.${s.darkvision ? ` · darkvision ${s.darkvision}` : ''}` }),
          (s) => draft.species?.name === s.name,
          (s) => { draft.species = s; ctx.update(); });
      },
      validate: (draft) => draft.species ? null : 'Pick a species.',
    },
    {
      key: 'class', title: 'Class',
      render(draft, ctx) {
        return pickCards(ctx.data.classes,
          (c) => ({ title: c.name, sub: `d${c.hitDie} hit die · ${c.saves.map((s) => s.toUpperCase()).join('/')} saves${c.spellcasting ? ' · spellcaster' : ''}` }),
          (c) => draft.klass?.name === c.name,
          (c) => { draft.klass = c; ctx.update(); });
      },
      validate: (draft) => draft.klass ? null : 'Pick a class.',
    },
    {
      key: 'abilities', title: 'Abilities',
      render(draft, ctx) {
        draft.abilities ??= { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
        draft.abilityMethod ??= 'standard';
        const wrap = el('div', {});
        const methodSel = el('select', {},
          el('option', { value: 'standard' }, 'Standard array (15 14 13 12 10 8)'),
          el('option', { value: 'pointbuy' }, 'Point buy (27 points)'),
          el('option', { value: 'roll' }, 'Roll 4d6, drop lowest'));
        methodSel.value = draft.abilityMethod;
        methodSel.addEventListener('change', () => { draft.abilityMethod = methodSel.value; ctx.update(); });
        const note = el('div', { class: 'small muted', style: 'margin:8px 0' });
        const grid = el('div', { class: 'sb-abrow' });

        const redraw = () => {
          grid.innerHTML = '';
          if (draft.abilityMethod === 'roll') {
            for (const a of ABILITIES) {
              grid.append(el('label', {}, a.toUpperCase(),
                el('input', { type: 'number', value: draft.abilities[a], min: 3, max: 18, oninput: (ev) => { draft.abilities[a] = Number(ev.target.value) || 8; refreshNote(); } })));
            }
          } else if (draft.abilityMethod === 'pointbuy') {
            for (const a of ABILITIES) {
              const inp = el('input', { type: 'number', min: 8, max: 15, value: Math.min(15, Math.max(8, draft.abilities[a])) });
              inp.addEventListener('input', () => { draft.abilities[a] = Math.min(15, Math.max(8, Number(inp.value) || 8)); refreshNote(); });
              grid.append(el('label', {}, a.toUpperCase(), inp));
            }
          } else {
            for (const a of ABILITIES) {
              const sel = el('select', {}, el('option', { value: '' }, '—'),
                STANDARD_ARRAY.map((v) => el('option', { value: v }, v)));
              sel.value = STANDARD_ARRAY.includes(draft.abilities[a]) ? String(draft.abilities[a]) : '';
              sel.addEventListener('change', () => { draft.abilities[a] = Number(sel.value) || 8; refreshNote(); });
              grid.append(el('label', {}, a.toUpperCase(), sel));
            }
          }
          refreshNote();
        };
        const refreshNote = () => {
          if (draft.abilityMethod === 'pointbuy') {
            const spent = ABILITIES.reduce((s, a) => s + (POINT_BUY_COST[draft.abilities[a]] ?? 0), 0);
            note.textContent = `${spent} / 27 points spent${spent > 27 ? ' — over budget!' : ''}`;
            note.style.color = spent > 27 ? 'var(--danger)' : 'var(--muted)';
          } else if (draft.abilityMethod === 'standard') {
            const used = ABILITIES.map((a) => draft.abilities[a]).filter((v) => STANDARD_ARRAY.includes(v));
            const dup = new Set(used).size !== used.length;
            note.textContent = dup ? 'Each array value can be used once.' : `${used.length} / 6 assigned`;
            note.style.color = dup ? 'var(--danger)' : 'var(--muted)';
          } else note.textContent = 'Click Roll to roll 4d6-drop-lowest for each, then swap freely.';
        };
        const rollBtnEl = el('button', {
          class: 'ghost small',
          onclick: () => {
            for (const a of ABILITIES) {
              const rolls = [0, 0, 0, 0].map(() => 1 + Math.floor(Math.random() * 6)).sort((x, y) => x - y);
              draft.abilities[a] = rolls[1] + rolls[2] + rolls[3];
            }
            draft.abilityMethod = 'roll';
            ctx.update();
          },
        }, '🎲 Roll 4d6dl1 ×6');
        wrap.append(el('div', { class: 'row' }, methodSel, rollBtnEl), note, grid);
        redraw();
        return wrap;
      },
      validate(draft) {
        const abs = draft.abilities || {};
        if (draft.abilityMethod === 'pointbuy') {
          const spent = ABILITIES.reduce((s, a) => s + (POINT_BUY_COST[abs[a]] ?? 99), 0);
          if (spent > 27) return `Point buy is over budget (${spent}/27).`;
          if (ABILITIES.some((a) => abs[a] < 8 || abs[a] > 15)) return 'Point-buy scores run 8–15.';
        }
        if (draft.abilityMethod === 'standard') {
          const vals = ABILITIES.map((a) => abs[a]);
          if (!STANDARD_ARRAY.every((v) => vals.includes(v))) return 'Assign each standard-array value exactly once.';
        }
        return null;
      },
    },
    {
      key: 'background', title: 'Background',
      render(draft, ctx) {
        const wrap = el('div', {});
        wrap.append(pickCards(ctx.data.backgrounds,
          (b) => ({ title: b.name, sub: `${b.abilities.map((a) => a.toUpperCase()).join('/')} · ${b.skills.join(', ')} · feat: ${b.feat}` }),
          (b) => draft.background?.name === b.name,
          (b) => { draft.background = b; draft.bgBonus = null; ctx.update(); }));
        if (draft.background) {
          const b = draft.background;
          draft.bgBonus ??= { mode: '2+1', two: b.abilities[0], one: b.abilities[1] };
          const mk = (key) => {
            const sel = el('select', {}, b.abilities.map((a) => el('option', { value: a }, a.toUpperCase())));
            sel.value = draft.bgBonus[key];
            sel.addEventListener('change', () => { draft.bgBonus[key] = sel.value; });
            return sel;
          };
          const modeSel = el('select', {},
            el('option', { value: '2+1' }, '+2 and +1'),
            el('option', { value: '1+1+1' }, '+1 to all three'));
          modeSel.value = draft.bgBonus.mode;
          modeSel.addEventListener('change', () => { draft.bgBonus.mode = modeSel.value; ctx.update(); });
          wrap.append(el('div', { class: 'row', style: 'margin-top:10px' },
            el('span', { class: 'small muted' }, 'Ability increases:'), modeSel,
            ...(draft.bgBonus.mode === '2+1' ? [el('span', { class: 'small' }, '+2 to'), mk('two'), el('span', { class: 'small' }, '+1 to'), mk('one')] : [])));
        }
        return wrap;
      },
      validate(draft) {
        if (!draft.background) return 'Pick a background.';
        if (draft.bgBonus?.mode === '2+1' && draft.bgBonus.two === draft.bgBonus.one) return 'The +2 and +1 must go to different abilities.';
        return null;
      },
    },
    {
      key: 'skills', title: 'Skills',
      render(draft, ctx) {
        const c = draft.klass;
        draft.skillPicks ??= [];
        const granted = draft.background?.skills || [];
        const wrap = el('div', {},
          el('p', { class: 'small muted' }, `Your background grants ${granted.join(' and ') || 'no skills'}. Choose ${c.skills.choose} more from the ${c.name} list:`));
        const grid = el('div', { class: 'sheet-edit-skills' });
        for (const s of c.skills.from) {
          const taken = granted.includes(s);
          const cb = el('input', {
            type: 'checkbox', checked: taken || draft.skillPicks.includes(s), disabled: taken,
            onchange: (ev) => {
              draft.skillPicks = ev.target.checked
                ? [...draft.skillPicks, s] : draft.skillPicks.filter((x) => x !== s);
              ctx.update();
            },
          });
          grid.append(el('label', { class: 'small' }, cb, ` ${s}${taken ? ' (background)' : ''}`));
        }
        wrap.append(grid, el('div', { class: 'small muted' }, `${draft.skillPicks.length} / ${c.skills.choose} chosen`));
        return wrap;
      },
      validate: (draft) => (draft.skillPicks || []).length === draft.klass.skills.choose
        ? null : `Choose exactly ${draft.klass.skills.choose} class skills.`,
    },
    {
      key: 'equipment', title: 'Equipment',
      render(draft, ctx) {
        draft.equipmentText ??= draft.klass.startingEquipment || '';
        const area = el('textarea', { rows: 6, style: 'width:100%' });
        area.value = draft.equipmentText;
        area.addEventListener('input', () => { draft.equipmentText = area.value; });
        return el('div', {},
          el('p', { class: 'small muted' }, 'What your class starts with. Edit it freely; each line becomes an item on the sheet.'),
          area,
          draft.background?.equipment ? el('p', { class: 'small muted' }, `Your background adds: ${draft.background.equipment}`) : null);
      },
      validate: () => null,
    },
    {
      key: 'spells', title: 'Spells',
      when: (draft) => !!draft.klass?.spellcasting,
      render(draft, ctx) {
        const c = draft.klass;
        const counts = CASTER_L1[c.name] || { cantrips: 2, prepared: 2 };
        draft.cantrips ??= [];
        draft.spells ??= [];
        const list = ctx.data.spells.filter((s) => s.classes.includes(c.name) && s.level <= 1);
        const wrap = el('div', {},
          el('p', { class: 'small muted' },
            `${c.name}s start with ${counts.cantrips ? `${counts.cantrips} cantrips and ` : ''}${counts.prepared} prepared level-1 spells.`));
        const grid = el('div', { class: 'wiz-spells' });
        for (const s of list) {
          const target = s.level === 0 ? draft.cantrips : draft.spells;
          const cb = el('input', {
            type: 'checkbox', checked: target.includes(s.name),
            onchange: (ev) => {
              const arr = s.level === 0 ? draft.cantrips : draft.spells;
              if (ev.target.checked) arr.push(s.name);
              else arr.splice(arr.indexOf(s.name), 1);
              ctx.update();
            },
          });
          grid.append(el('label', { class: 'small', title: s.text.slice(0, 400) },
            cb, ` ${s.name} `, el('span', { class: 'muted' }, s.level === 0 ? 'cantrip' : `L1 ${s.school}`)));
        }
        wrap.append(grid, el('div', { class: 'small muted' },
          `${draft.cantrips.length}/${counts.cantrips} cantrips · ${draft.spells.length}/${counts.prepared} spells`));
        return wrap;
      },
      validate(draft) {
        const counts = CASTER_L1[draft.klass.name] || { cantrips: 2, prepared: 2 };
        if (draft.cantrips.length !== counts.cantrips) return `Pick exactly ${counts.cantrips} cantrips.`;
        if (draft.spells.length !== counts.prepared) return `Pick exactly ${counts.prepared} level-1 spells.`;
        return null;
      },
    },
    {
      key: 'review', title: 'Review',
      render(draft, ctx) {
        const abs = finalAbilities(draft);
        const conMod = mod(abs.con);
        draft.name ??= '';
        draft.acFinal ??= 10 + mod(abs.dex);
        const nameInput = el('input', { value: draft.name, placeholder: 'Character name', style: 'flex:1', oninput: (ev) => { draft.name = ev.target.value; } });
        const acInput = el('input', { type: 'number', value: draft.acFinal, min: 5, max: 30, style: 'width:70px', oninput: (ev) => { draft.acFinal = Number(ev.target.value) || 10; } });
        return el('div', {},
          el('div', { class: 'row' }, el('label', {}, 'Name'), nameInput),
          el('div', { class: 'card', style: 'margin-top:10px' },
            el('div', {}, `${draft.species.name} ${draft.klass.name} (${draft.klass.subclass?.name || ''}) — ${draft.background.name}`),
            el('div', { class: 'small muted' }, ABILITIES.map((a) => `${a.toUpperCase()} ${abs[a]}`).join('  ')),
            el('div', { class: 'small muted' }, `HP ${draft.klass.hitDie + conMod} · Speed ${draft.species.speed} ft. · Origin feat: ${draft.background.feat}`),
            el('div', { class: 'row small', style: 'margin-top:6px' }, el('span', {}, 'AC (adjust for your armor):'), acInput)));
      },
      validate: (draft) => draft.name?.trim() ? null : 'Give the character a name.',
    },
  ],
  finish(draft) {
    const abs = finalAbilities(draft);
    const d = defaults();
    d.species = { name: draft.species.name, size: draft.species.size, speed: draft.species.speed };
    d.klass = { name: draft.klass.name, level: 1, hitDie: draft.klass.hitDie, subclass: draft.klass.subclass?.name || '' };
    d.background = { name: draft.background.name, feat: draft.background.feat };
    d.abilityMethod = draft.abilityMethod;
    d.abilities = abs;
    d.saves = draft.klass.saves;
    d.skills = [...(draft.background.skills || []), ...(draft.skillPicks || [])].map((key) => ({ key, prof: 'prof' }));
    d.ac = draft.acFinal ?? 10 + mod(abs.dex);
    d.speed = draft.species.speed;
    d.hp = { max: draft.klass.hitDie + mod(abs.con), current: draft.klass.hitDie + mod(abs.con), temp: 0 };
    d.equipment = String(draft.equipmentText || '').split(/\n|;/).map((s) => s.replace(/^[-•\s]+/, '').trim()).filter(Boolean).map((name) => ({ name, qty: 1 }));
    d.features = [
      ...(draft.species.traits || []).map((t) => ({ name: t.name, source: draft.species.name, text: t.text })),
      ...(draft.klass.features || []).filter((f) => f.level === 1).map((f) => ({ name: f.name, source: `${draft.klass.name} 1`, text: f.text })),
    ];
    if (draft.klass.spellcasting) {
      const ability = draft.klass.spellcasting.ability;
      const dc = 8 + 2 + mod(abs[ability]);
      d.spellcasting = {
        ability, dc, attackBonus: 2 + mod(abs[ability]),
        slots: { 1: { max: L1_SLOTS[draft.klass.name] ?? 2, used: 0 } },
        cantrips: draft.cantrips || [], prepared: draft.spells || [],
      };
    }
    const featData = draft.background.feat;
    if (featData) d.features.push({ name: featData, source: 'Origin feat', text: '' });
    return {
      name: draft.name.trim(),
      fields: { Role: 'PC', Species: d.species.name, Status: 'Alive' },
      data: d,
      tags: [d.klass.name.toLowerCase(), 'pc'],
    };
  },
};

function finalAbilities(draft) {
  const out = { ...draft.abilities };
  if (draft.bgBonus && draft.background) {
    if (draft.bgBonus.mode === '1+1+1') for (const a of draft.background.abilities) out[a] = (out[a] ?? 10) + 1;
    else { out[draft.bgBonus.two] = (out[draft.bgBonus.two] ?? 10) + 2; out[draft.bgBonus.one] = (out[draft.bgBonus.one] ?? 10) + 1; }
  }
  return out;
}
