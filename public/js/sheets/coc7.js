// Call of Cthulhu 7th Edition investigator sheet + creation wizard.
// Data pack (public/systems/coc7.json) carries names, base values and the
// occupation point formulas — no rules text (Chaosium fan material policy).

import { el, esc } from '../util.js';
import { linkDice } from '../render.js';
import {
  rollBtn, kvHtml, sectionHtml,
  frow, textInput, numInput, areaInput, listEdit,
} from './sheetlib.js';

export const label = 'Call of Cthulhu 7e';
export const tagline = 'Percentile dice, a day job, and a sanity score to lose.';

let cached = null;
export async function loadData() {
  if (!cached) {
    const res = await fetch('/systems/coc7.json');
    if (!res.ok) throw new Error('systems/coc7.json missing');
    cached = await res.json();
  }
  return cached;
}

const CHARS = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];
const CHAR_NAMES = { STR: 'Strength', CON: 'Constitution', SIZ: 'Size', DEX: 'Dexterity', APP: 'Appearance', INT: 'Intelligence', POW: 'Power', EDU: 'Education' };

export function defaults() {
  return {
    era: '1920s', age: 30,
    characteristics: { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 50, POW: 50, EDU: 50 },
    occupation: { name: '', creditRange: [0, 99] },
    luck: 50,
    hp: { max: 10, current: 10 }, mp: { max: 10, current: 10 },
    san: { start: 50, current: 50, max: 99 },
    build: 0, damageBonus: '0', move: 8, dodge: 25,
    skills: [], weapons: [], gear: [],
    cash: '', spendingLevel: '',
    backstory: { description: '', ideology: '', significantPeople: '', meaningfulLocations: '', treasuredPossessions: '', traits: '', injuries: '', phobias: '' },
    notes: '',
  };
}

export function derive(d, data) {
  const c = d.characteristics;
  const out = {};
  out.hpMax = Math.floor((c.CON + c.SIZ) / 10);
  out.mpMax = Math.floor(c.POW / 5);
  out.sanStart = c.POW;
  out.dodge = Math.floor(c.DEX / 2);
  const strSiz = c.STR + c.SIZ;
  const row = (data?.damageBonus || cached?.damageBonus || []).find((r) => strSiz >= r.min && strSiz <= r.max);
  out.damageBonus = row?.db ?? '0';
  out.build = row?.build ?? 0;
  let mov = c.DEX < c.SIZ && c.STR < c.SIZ ? 7 : c.DEX >= c.SIZ && c.STR >= c.SIZ ? 9 : 8;
  const bracket = (data?.ageModifiers || cached?.ageModifiers || []).find((m) => d.age >= m.range[0] && d.age <= m.range[1]);
  out.move = mov + (bracket?.mov || 0);
  return out;
}

export function summary(data) {
  const d = data || defaults();
  return `${d.occupation?.name || 'Investigator'} · ${d.era}${d.age ? ` · age ${d.age}` : ''}`;
}

export function searchText(data) {
  const d = data || {};
  return [d.occupation?.name, d.era, ...(d.skills || []).map((s) => s.name), ...(d.weapons || []).map((w) => w.name)]
    .filter(Boolean).join(' ');
}

// ---------- rendered sheet ----------

const half = (v) => Math.floor(v / 2);
const fifth = (v) => Math.floor(v / 5);
const pct = (target, label) => rollBtn({ kind: 'pct', target, label }, String(target), 'Roll d100 vs this — Shift adds a bonus die, Ctrl a penalty die');

export function html(data) {
  const d = { ...defaults(), ...(data || {}) };
  const charTiles = CHARS.map((k) => {
    const v = d.characteristics[k] ?? 50;
    return `<div class="sb-ab"><div class="ab-n">${k}</div>` +
      `<div class="ab-v">${rollBtn({ kind: 'pct', target: v, label: `${CHAR_NAMES[k]} roll` }, String(v), 'Roll d100 vs this — Shift bonus die, Ctrl penalty die')}</div>` +
      `<div class="ab-m muted">${half(v)} / ${fifth(v)}</div></div>`;
  }).join('');

  const skills = (d.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const skillRows = skills.map((s) =>
    `<div class="sheet-skill">${s.occupational ? '●' : '○'} ${rollBtn({ kind: 'pct', target: s.value, label: s.name }, `${esc(s.name)} ${s.value}%`, 'Roll — Shift bonus die, Ctrl penalty die')} <span class="muted small">(${half(s.value)}/${fifth(s.value)})</span></div>`).join('');

  const weapons = (d.weapons || []).length
    ? d.weapons.map((w) => `<div class="sheet-kv"><span class="sk">${esc(w.name)}</span><span class="sv">` +
        rollBtn({ kind: 'pct', target: w.skill, label: `${w.name} attack` }, `${w.skill}%`, 'Attack roll') +
        ` · ${linkDice(esc(w.damage || ''))}${w.range ? ` · ${esc(w.range)}` : ''}${w.ammo ? ` · ammo ${esc(String(w.ammo))}` : ''}${w.malf ? ` · malf ${esc(String(w.malf))}` : ''}</span></div>`).join('')
    : '<div class="muted small">Unarmed.</div>';

  const back = Object.entries({
    Description: d.backstory.description, Ideology: d.backstory.ideology,
    'Significant people': d.backstory.significantPeople, 'Meaningful locations': d.backstory.meaningfulLocations,
    'Treasured possessions': d.backstory.treasuredPossessions, Traits: d.backstory.traits,
    'Injuries & scars': d.backstory.injuries, 'Phobias & manias': d.backstory.phobias,
  }).filter(([, v]) => v);

  return `<div class="sheet sheet-coc">
    <div class="sheet-head">
      <span class="sheet-title">${esc(summary(d))}</span>
    </div>
    <div class="sb-abilities">${charTiles}</div>
    ${sectionHtml('Derived',
      kvHtml('Hit points', `${d.hp.current} / ${d.hp.max}`) +
      kvHtml('Magic points', `${d.mp.current} / ${d.mp.max}`) +
      kvHtml('Luck', pct(d.luck, 'Luck roll')) +
      kvHtml('Sanity', `${pct(d.san.current, 'Sanity roll')} <span class="muted small">(start ${d.san.start}, max ${d.san.max})</span>`) +
      kvHtml('Damage bonus', `${esc(d.damageBonus)} · build ${d.build}`) +
      kvHtml('Move', String(d.move)) +
      kvHtml('Dodge', pct(d.dodge, 'Dodge')))}
    ${sectionHtml('Skills', `<div class="sheet-skills">${skillRows || '<span class="muted small">No skills recorded.</span>'}</div>`)}
    ${sectionHtml('Weapons', weapons)}
    ${(d.gear || []).length ? sectionHtml('Gear & possessions', `<div class="small">${esc(d.gear.map((g) => g.name || g).join(', '))}</div>` + (d.cash ? kvHtml('Cash & assets', esc(`${d.cash}${d.spendingLevel ? ` · spending level ${d.spendingLevel}` : ''}`)) : '')) : ''}
    ${back.length ? sectionHtml('Backstory', back.map(([k, v]) => kvHtml(k, esc(v))).join('')) : ''}
    ${d.notes ? sectionHtml('Notes', `<div class="small">${esc(d.notes).replace(/\n/g, '<br>')}</div>`) : ''}
  </div>`;
}

// ---------- editor ----------

export function editor(block, save) {
  const d = block.data = { ...defaults(), ...(block.data || {}) };
  const wrap = el('div', { class: 'sb-form' });

  const recompute = el('button', {
    class: 'ghost small', title: 'Recompute HP/MP/SAN maxima, dodge, damage bonus and move from the characteristics and age',
    onclick: async () => {
      await loadData();
      const der = derive(d, cached);
      d.hp.max = der.hpMax; d.hp.current = Math.min(d.hp.current, der.hpMax);
      d.mp.max = der.mpMax; d.mp.current = Math.min(d.mp.current, der.mpMax);
      d.dodge = der.dodge; d.damageBonus = der.damageBonus; d.build = der.build; d.move = der.move;
      save();
      wrap.dispatchEvent(new CustomEvent('sheet-reopen', { bubbles: true }));
    },
  }, '↻ Recompute derived');

  wrap.append(
    el('div', { class: 'row' },
      frow('Occupation', textInput(d.occupation.name, (v) => { d.occupation.name = v; save(); })),
      frow('Era', textInput(d.era, (v) => { d.era = v; save(); }, { style: 'width:90px' })),
      frow('Age', numInput(d.age, (v) => { d.age = v; save(); }, { min: 15, max: 90 })),
      recompute),
    el('div', { class: 'sb-abrow', style: 'grid-template-columns:repeat(8, 1fr)' },
      ...CHARS.map((k) => el('label', {}, k,
        numInput(d.characteristics[k], (v) => { d.characteristics[k] = v; save(); }, { min: 1, max: 99 })))),
    el('div', { class: 'row' },
      frow('HP', numInput(d.hp.current, (v) => { d.hp.current = v; save(); })),
      frow('/ max', numInput(d.hp.max, (v) => { d.hp.max = v; save(); })),
      frow('MP', numInput(d.mp.current, (v) => { d.mp.current = v; save(); })),
      frow('/ max', numInput(d.mp.max, (v) => { d.mp.max = v; save(); })),
      frow('Luck', numInput(d.luck, (v) => { d.luck = v; save(); })),
      frow('SAN now', numInput(d.san.current, (v) => { d.san.current = v; save(); }))));

  wrap.append(el('details', { open: true }, el('summary', {}, 'Skills'),
    listEdit(d.skills, (s) => el('span', { class: 'row', style: 'flex:1' },
      el('label', { class: 'small', style: 'display:flex;align-items:center;gap:3px' },
        el('input', { type: 'checkbox', checked: !!s.occupational, onchange: (ev) => { s.occupational = ev.target.checked; save(); } }), 'occ.'),
      textInput(s.name, (v) => { s.name = v; save(); }, { placeholder: 'Skill', style: 'flex:1' }),
      numInput(s.value, (v) => { s.value = v; save(); }, { min: 0, max: 99 })),
      () => ({ name: '', value: 20, occupational: false }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Weapons'),
    listEdit(d.weapons, (w) => el('span', { class: 'row', style: 'flex:1' },
      textInput(w.name, (v) => { w.name = v; save(); }, { placeholder: 'Weapon', style: 'flex:1' }),
      numInput(w.skill, (v) => { w.skill = v; save(); }, { title: 'skill %' }),
      textInput(w.damage, (v) => { w.damage = v; save(); }, { placeholder: '1d8+db', style: 'width:110px' }),
      textInput(w.range, (v) => { w.range = v; save(); }, { placeholder: 'range', style: 'width:80px' })),
      () => ({ name: '', skill: 25, damage: '1d3+db', range: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Gear & money'),
    listEdit(d.gear, (g) => textInput(g.name, (v) => { g.name = v; save(); }, { style: 'flex:1' }),
      () => ({ name: '' }), save),
    el('div', { class: 'row' },
      frow('Cash & assets', textInput(d.cash, (v) => { d.cash = v; save(); }, { style: 'flex:1' })),
      frow('Spending level', textInput(d.spendingLevel, (v) => { d.spendingLevel = v; save(); })))));

  wrap.append(el('details', {}, el('summary', {}, 'Backstory'),
    ...Object.entries({
      description: 'Description', ideology: 'Ideology & beliefs', significantPeople: 'Significant people',
      meaningfulLocations: 'Meaningful locations', treasuredPossessions: 'Treasured possessions',
      traits: 'Traits', injuries: 'Injuries & scars', phobias: 'Phobias & manias',
    }).map(([k, lab]) => frow(lab, areaInput(d.backstory[k], (v) => { d.backstory[k] = v; save(); }, { rows: 2, style: 'flex:1' })))));

  wrap.append(frow('Notes', areaInput(d.notes, (v) => { d.notes = v; save(); }, { style: 'flex:1' })));
  return wrap;
}

// ---------- PDF ----------

export function writePdf(w, data) {
  const d = { ...defaults(), ...(data || {}) };
  w.line(summary(d), { bold: true });
  w.line(CHARS.map((k) => `${k} ${d.characteristics[k]}`).join('   '));
  w.line(`HP ${d.hp.current}/${d.hp.max}   MP ${d.mp.current}/${d.mp.max}   Luck ${d.luck}   SAN ${d.san.current} (start ${d.san.start})   DB ${d.damageBonus}   Build ${d.build}   Move ${d.move}   Dodge ${d.dodge}`);
  const skills = (d.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length) w.para(`Skills: ${skills.map((s) => `${s.name} ${s.value}%${s.occupational ? '*' : ''}`).join(', ')}`);
  for (const wp of d.weapons || []) w.line(`Weapon: ${wp.name} ${wp.skill}%, ${wp.damage}${wp.range ? `, range ${wp.range}` : ''}`);
  if ((d.gear || []).length) w.line(`Gear: ${d.gear.map((g) => g.name || g).join(', ')}`);
  if (d.cash) w.line(`Cash & assets: ${d.cash}${d.spendingLevel ? ` (spending level ${d.spendingLevel})` : ''}`);
  for (const [k, lab] of [['description', 'Description'], ['ideology', 'Ideology'], ['significantPeople', 'Significant people'],
    ['meaningfulLocations', 'Meaningful locations'], ['treasuredPossessions', 'Treasured possessions'], ['traits', 'Traits'],
    ['injuries', 'Injuries'], ['phobias', 'Phobias & manias']]) {
    if (d.backstory?.[k]) w.line(`${lab}: ${d.backstory[k]}`);
  }
  if (d.notes) w.para(d.notes);
}

// ---------- wizard ----------

const rollD6 = () => 1 + Math.floor(Math.random() * 6);
const roll3d6x5 = () => (rollD6() + rollD6() + rollD6()) * 5;
const roll2d6p6x5 = () => (rollD6() + rollD6() + 6) * 5;

function skillBase(skill, chars) {
  if (typeof skill.base === 'number') return skill.base;
  if (skill.base === 'DEX/2') return Math.floor(chars.DEX / 2);
  if (skill.base === 'EDU') return chars.EDU;
  return 0;
}

function occupationPoints(occ, chars) {
  let pts = chars[occ.points.base[0]] * occ.points.base[1];
  if (occ.points.plus) {
    const best = Math.max(...occ.points.plus.options.map(([k, mult]) => chars[k] * mult));
    pts += best;
  }
  return pts;
}
const formulaLabel = (occ) => `${occ.points.base[0]} ×${occ.points.base[1]}` +
  (occ.points.plus ? ` + ${occ.points.plus.options.map(([k, m]) => `${k}×${m}`).join(' or ')}` : '');

export const wizard = {
  intro: 'An investigator by the 7th-edition book: roll the characteristics, pick a livelihood, spend the points, write down who they were before all this. The sanity looks after itself, briefly.',
  steps: [
    {
      key: 'basics', title: 'Occupation',
      render(draft, ctx) {
        draft.era ??= '1920s';
        draft.age ??= 30;
        const eraSel = el('select', {}, el('option', {}, '1920s'), el('option', {}, 'Modern'));
        eraSel.value = draft.era;
        eraSel.addEventListener('change', () => { draft.era = eraSel.value; });
        const ageInput = el('input', { type: 'number', min: 15, max: 89, value: draft.age, style: 'width:70px' });
        ageInput.addEventListener('input', () => { draft.age = Number(ageInput.value) || 30; });
        return el('div', {},
          el('div', { class: 'row' }, el('label', {}, 'Era'), eraSel, el('label', {}, 'Age'), ageInput),
          el('div', { class: 'edition-cards wiz-cards', style: 'margin-top:10px' },
            ctx.data.occupations.map((o) => el('div', {
              class: `edition-card${draft.occupation?.name === o.name ? ' sel' : ''}`,
              onclick: () => { draft.occupation = o; draft.occAlloc = null; draft.occPicks = {}; ctx.update(); },
            },
              el('div', { style: 'font-weight:600' }, o.name),
              el('div', { class: 'muted small' }, `Points: ${formulaLabel(o)} · Credit ${o.creditRating[0]}–${o.creditRating[1]}`)))));
      },
      validate: (draft) => draft.occupation ? null : 'Pick an occupation.',
    },
    {
      key: 'chars', title: 'Characteristics',
      render(draft, ctx) {
        draft.characteristics ??= null;
        draft.charLog ??= [];
        const wrap = el('div', {});
        const grid = el('div', { class: 'sb-abrow', style: 'grid-template-columns:repeat(8, 1fr)' });
        const log = el('div', { class: 'small muted', style: 'margin-top:8px;white-space:pre-line' });

        const bracket = ctx.data.ageModifiers.find((m) => draft.age >= m.range[0] && draft.age <= m.range[1]);
        const redraw = () => {
          grid.innerHTML = '';
          for (const k of CHARS) {
            const inp = el('input', { type: 'number', min: 1, max: 99, value: draft.characteristics?.[k] ?? '', placeholder: '—' });
            inp.addEventListener('input', () => { (draft.characteristics ??= {})[k] = Number(inp.value) || 0; });
            grid.append(el('label', {}, k, inp));
          }
          log.textContent = draft.charLog.join('\n');
        };
        const rollAll = el('button', {
          class: 'primary',
          onclick: () => {
            draft.characteristics = {};
            for (const c of ctx.data.characteristics) {
              draft.characteristics[c.key] = c.roll === '2d6+6' ? roll2d6p6x5() : roll3d6x5();
            }
            draft.charLog = [`Rolled: ${CHARS.map((k) => `${k} ${draft.characteristics[k]}`).join(', ')}`];
            // luck (best of two for teens)
            const l1 = roll3d6x5(), l2 = roll3d6x5();
            draft.luck = bracket?.luckBestOfTwo ? Math.max(l1, l2) : l1;
            draft.charLog.push(`Luck: ${draft.luck}${bracket?.luckBestOfTwo ? ` (best of ${l1}/${l2})` : ''}`);
            // age effects
            if (bracket) {
              if (bracket.edu) { draft.characteristics.EDU = Math.max(1, draft.characteristics.EDU + bracket.edu); draft.charLog.push(`Age ${draft.age}: EDU ${bracket.edu}`); }
              if (bracket.app) { draft.characteristics.APP = Math.max(1, draft.characteristics.APP + bracket.app); draft.charLog.push(`Age ${draft.age}: APP ${bracket.app}`); }
              for (let i = 0; i < bracket.eduChecks; i++) {
                const roll = 1 + Math.floor(Math.random() * 100);
                if (roll > draft.characteristics.EDU) {
                  const gain = 1 + Math.floor(Math.random() * 10);
                  draft.characteristics.EDU = Math.min(99, draft.characteristics.EDU + gain);
                  draft.charLog.push(`EDU improvement check: ${roll} > EDU — gained +${gain}`);
                } else draft.charLog.push(`EDU improvement check: ${roll} ≤ EDU — no change`);
              }
              if (bracket.deduct) {
                draft.charLog.push(`Deduct ${bracket.deduct.amount} points among ${bracket.deduct.pool.join('/')} (edit the boxes above).`);
              }
            }
            redraw();
          },
        }, '🎲 Roll characteristics');
        wrap.append(el('div', { class: 'row' }, rollAll,
          el('span', { class: 'muted small' }, `or type your own — the point-pool variant gives you ${ctx.data.pointPool} to divide across all eight`)),
          grid, log);
        redraw();
        return wrap;
      },
      validate(draft) {
        if (!draft.characteristics || CHARS.some((k) => !draft.characteristics[k])) return 'Roll or enter all eight characteristics.';
        return null;
      },
    },
    {
      key: 'occskills', title: 'Occupation skills',
      render(draft, ctx) {
        const occ = draft.occupation;
        const chars = draft.characteristics;
        const points = occupationPoints(occ, chars);
        draft.occAlloc ??= {};
        draft.occPicks ??= {};
        draft.creditRating ??= occ.creditRating[0];
        const allNames = ctx.data.skills.map((s) => s.name);

        // resolve the occupation's skill list: strings, {choose,from}, {any}
        const resolved = [];
        occ.skills.forEach((s, idx) => {
          if (typeof s === 'string') { resolved.push(s); return; }
          if (s.choose) {
            for (let i = 0; i < s.choose; i++) {
              const key = `c${idx}-${i}`;
              draft.occPicks[key] ??= s.from[0];
              resolved.push(draft.occPicks[key]);
            }
          } else if (s.any) {
            for (let i = 0; i < s.any; i++) {
              const key = `a${idx}-${i}`;
              draft.occPicks[key] ??= allNames[0];
              resolved.push(draft.occPicks[key]);
            }
          }
        });

        const note = el('div', { class: 'small', style: 'margin:8px 0' });
        const refresh = () => {
          const spent = Object.values(draft.occAlloc).reduce((s, v) => s + (v || 0), 0) + (draft.creditRating - 0);
          note.textContent = `${spent} / ${points} occupation points spent (credit rating counts).`;
          note.style.color = spent === points ? 'var(--ok)' : spent > points ? 'var(--danger)' : 'var(--muted)';
        };

        const article = /^[aeiou]/i.test(occ.name) ? 'An' : 'A';
        const wrap = el('div', {},
          el('p', { class: 'small muted' },
            `${article} ${occ.name.toLowerCase()} gets ${points} points to spend (${formulaLabel(occ)}). Credit Rating comes out of the same pot, and it has to land between ${occ.creditRating[0]} and ${occ.creditRating[1]}. Even doom has a budget.`));

        // choice selects first
        occ.skills.forEach((s, idx) => {
          if (typeof s === 'string') return;
          const from = s.choose ? s.from : allNames;
          const n = s.choose || s.any;
          for (let i = 0; i < n; i++) {
            const key = `${s.choose ? 'c' : 'a'}${idx}-${i}`;
            const sel = el('select', {}, from.map((name) => el('option', {}, name)));
            sel.value = draft.occPicks[key];
            sel.addEventListener('change', () => { draft.occPicks[key] = sel.value; ctx.update(); });
            wrap.append(el('div', { class: 'row small' }, el('span', { class: 'muted' }, s.label || 'any skill:'), sel));
          }
        });

        const crRow = el('div', { class: 'row small', style: 'margin-top:6px' },
          el('strong', {}, 'Credit Rating'),
          el('input', {
            type: 'number', min: occ.creditRating[0], max: occ.creditRating[1], value: draft.creditRating, style: 'width:70px',
            oninput: (ev) => { draft.creditRating = Number(ev.target.value) || 0; refresh(); },
          }),
          el('span', { class: 'muted' }, `(${occ.creditRating[0]}–${occ.creditRating[1]})`));

        const rows = el('div', { style: 'margin-top:8px' });
        for (const name of [...new Set(resolved)]) {
          const skill = ctx.data.skills.find((s) => s.name === name) || { base: 1 };
          const base = skillBase(skill, chars);
          const inp = el('input', {
            type: 'number', min: 0, max: 99, value: draft.occAlloc[name] || 0, style: 'width:70px',
            oninput: (ev) => { draft.occAlloc[name] = Number(ev.target.value) || 0; refresh(); },
          });
          rows.append(el('div', { class: 'row small' },
            el('span', { style: 'width:220px' }, name),
            el('span', { class: 'muted' }, `base ${base}`), el('span', {}, '+'), inp));
        }
        wrap.append(crRow, note, rows);
        refresh();
        return wrap;
      },
      validate(draft, ctx) {
        const occ = draft.occupation;
        const points = occupationPoints(occ, draft.characteristics);
        const spent = Object.values(draft.occAlloc || {}).reduce((s, v) => s + (v || 0), 0) + draft.creditRating;
        if (draft.creditRating < occ.creditRating[0] || draft.creditRating > occ.creditRating[1]) {
          return `Credit Rating must be between ${occ.creditRating[0]} and ${occ.creditRating[1]}.`;
        }
        if (spent !== points) return `Spend exactly ${points} occupation points (currently ${spent}).`;
        return null;
      },
    },
    {
      key: 'personal', title: 'Personal interests',
      render(draft, ctx) {
        const budget = draft.characteristics.INT * (ctx.data.personalInterestMultiplier || 2);
        draft.persAlloc ??= {};
        const note = el('div', { class: 'small', style: 'margin:8px 0' });
        const refresh = () => {
          const spent = Object.values(draft.persAlloc).reduce((s, v) => s + (v || 0), 0);
          note.textContent = `${spent} / ${budget} personal-interest points (INT × 2).`;
          note.style.color = spent === budget ? 'var(--ok)' : spent > budget ? 'var(--danger)' : 'var(--muted)';
        };
        const rows = el('div', {});
        for (const skill of ctx.data.skills) {
          if (skill.noPersonal) continue;
          const base = skillBase(skill, draft.characteristics);
          const occAdd = draft.occAlloc?.[skill.name] || 0;
          const inp = el('input', {
            type: 'number', min: 0, max: 99, value: draft.persAlloc[skill.name] || 0, style: 'width:64px',
            oninput: (ev) => { draft.persAlloc[skill.name] = Number(ev.target.value) || 0; refresh(); },
          });
          rows.append(el('div', { class: 'row small' },
            el('span', { style: 'width:220px' }, skill.name),
            el('span', { class: 'muted', style: 'width:90px' }, `now ${base + occAdd}`), el('span', {}, '+'), inp));
        }
        refresh();
        return el('div', {}, note, rows);
      },
      validate(draft, ctx) {
        const budget = draft.characteristics.INT * (ctx.data.personalInterestMultiplier || 2);
        const spent = Object.values(draft.persAlloc || {}).reduce((s, v) => s + (v || 0), 0);
        return spent === budget ? null : `Spend exactly ${budget} points (currently ${spent}).`;
      },
    },
    {
      key: 'backstory', title: 'Backstory',
      render(draft) {
        draft.backstory ??= {};
        const fields = [['description', 'Personal description'], ['ideology', 'Ideology & beliefs'],
          ['significantPeople', 'Significant people'], ['meaningfulLocations', 'Meaningful locations'],
          ['treasuredPossessions', 'Treasured possessions'], ['traits', 'Traits']];
        return el('div', {},
          fields.map(([k, lab]) => el('div', { style: 'margin-top:8px' },
            el('div', { class: 'small muted' }, lab),
            el('textarea', {
              rows: 2, style: 'width:100%',
              oninput: (ev) => { draft.backstory[k] = ev.target.value; },
            }, draft.backstory[k] || ''))));
      },
      validate: () => null,
    },
    {
      key: 'review', title: 'Review',
      render(draft, ctx) {
        draft.name ??= '';
        const der = derive({ characteristics: draft.characteristics, age: draft.age }, ctx.data);
        return el('div', {},
          el('div', { class: 'row' }, el('label', {}, 'Name'),
            el('input', { value: draft.name, placeholder: 'Investigator name', style: 'flex:1', oninput: (ev) => { draft.name = ev.target.value; } })),
          el('div', { class: 'card', style: 'margin-top:10px' },
            el('div', {}, `${draft.occupation.name}, ${draft.era}, age ${draft.age}`),
            el('div', { class: 'small muted' }, CHARS.map((k) => `${k} ${draft.characteristics[k]}`).join('  ')),
            el('div', { class: 'small muted' },
              `HP ${der.hpMax} · MP ${der.mpMax} · SAN ${der.sanStart} · Luck ${draft.luck ?? '—'} · DB ${der.damageBonus} · Build ${der.build} · Move ${der.move} · Dodge ${der.dodge}`)));
      },
      validate: (draft) => draft.name?.trim() ? null : 'Name the investigator.',
    },
  ],
  finish(draft, ctx) {
    const d = defaults();
    d.era = draft.era;
    d.age = draft.age;
    d.characteristics = { ...draft.characteristics };
    d.occupation = { name: draft.occupation.name, creditRange: draft.occupation.creditRating };
    d.luck = draft.luck ?? roll3d6x5();
    const der = derive(d, ctx.data);
    d.hp = { max: der.hpMax, current: der.hpMax };
    d.mp = { max: der.mpMax, current: der.mpMax };
    d.san = { start: der.sanStart, current: der.sanStart, max: 99 };
    d.dodge = der.dodge + (draft.persAlloc?.Dodge || 0) + (draft.occAlloc?.Dodge || 0);
    d.damageBonus = der.damageBonus;
    d.build = der.build;
    d.move = der.move;
    d.backstory = { ...defaults().backstory, ...(draft.backstory || {}) };
    // materialize every skill that ended up above base, plus occupation picks
    const touched = new Set([...Object.keys(draft.occAlloc || {}), ...Object.keys(draft.persAlloc || {})]);
    d.skills = [...touched].map((name) => {
      const skill = ctx.data.skills.find((s) => s.name === name) || { base: 1 };
      const value = skillBase(skill, d.characteristics) + (draft.occAlloc?.[name] || 0) + (draft.persAlloc?.[name] || 0);
      return { name, value, occupational: (draft.occAlloc?.[name] || 0) > 0 };
    }).filter((s) => s.value > 0).sort((a, b) => a.name.localeCompare(b.name));
    d.skills.push({ name: 'Credit Rating', value: draft.creditRating, occupational: true });
    return {
      name: draft.name.trim(),
      fields: { Role: 'PC', Species: 'Human', Status: 'Sane, for now' },
      data: d,
      tags: ['investigator', 'pc'],
    };
  },
};
