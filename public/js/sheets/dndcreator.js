import { el } from '../util.js';
import { randomName } from '../names.js';
import { choicePicker, spellPicker } from './choicepicker.js';
import { ABILITIES, ABILITY_NAMES, SKILLS, STANDARD_ARRAY, POINT_BUY_COST, mod, fmtMod, lower, canonSkill, unique,
  sourceLabel, isAvailable, finalAbilities, recommendedAbilities, validateAbilities, validateBackground,
  classSkills, spellProgression, availableSpells, classGrantedSpells, equipmentChoices, parseEquipment, armorClass,
  draftSkills, originFeats, buildCharacter } from './dndrules.js';

const field = (title, control) => {
  control.setAttribute('aria-label', title);
  return el('label', { class: 'creator-field' }, el('span', { class: 'small' }, title), control);
};
const input = (draft, key, placeholder = '') => el('input', { value: draft[key] || '', placeholder, oninput: ev => { draft[key] = ev.target.value; } });
const browse = (d, key) => (d.browse ??= {})[key] ??= {};
const items = (ctx, key, d) => ctx.data[key].filter(x => isAvailable(x, d));
const selectedValid = (d, ctx, key, collection, label) => !d[key] || !items(ctx, collection, d).some(x => x.name === d[key].name) ? `Choose an available ${label}.` : null;
const featuresText = rows => (rows || []).map(f => `${f.name}\n${f.text || ''}`).join('\n\n');
const backgroundSkills = d => unique([...(d.background?.skills || []), ...(d.backgroundSkillPicks || [])].map(canonSkill));
const bonusSkillCount = (d, data) => (['Human', 'Elf'].includes(d.species?.name) ? 1 : 0) + originFeats(d, data).filter(f => lower(f.name) === 'skilled').length * 3;

function chooseList(options, value, onChange, placeholder = 'Choose…') {
  const select = el('select', { onchange: ev => onChange(ev.target.value) }, el('option', { value: '' }, placeholder),
    options.map(option => el('option', { value: typeof option === 'string' ? option : option.name }, typeof option === 'string' ? option : `${option.name} · ${sourceLabel(option)}`)));
  select.value = value || ''; return select;
}

function skillChecks(options, picks, count, changed, granted = []) {
  return el('div', { class: 'creator-checks' }, options.map(name => el('label', {},
    el('input', { type: 'checkbox', checked: granted.includes(name) || picks.includes(name),
      disabled: granted.includes(name) || (!picks.includes(name) && picks.length >= count), onchange: ev => {
        if (ev.target.checked) picks.push(name); else picks.splice(picks.indexOf(name), 1); changed();
      } }), name, granted.includes(name) ? el('span', { class: 'muted small' }, ' Background') : null)));
}

function featsFor(d, data) { return data.feats.filter(f => isAvailable(f, d) && lower(f.category) === 'origin'); }
function magicOrigins(d, data) { return originFeats(d, data).filter(f => /^magic initiate/i.test(f.name)); }
function validSpellPicks(picks, list, count, label) {
  if (unique(picks).length !== count || picks?.length !== count) return `Choose exactly ${count} ${label}.`;
  if (picks.some(n => !list.some(s => s.name === n))) return `Some ${label} are no longer available. Review your selection.`;
  return null;
}

export const wizard = {
  intro: 'Build a level-1 adventurer with the 2024 rules and your local Library. Every choice stays editable; the sheet is created only when you finish. Use Level up on the sheet to advance through level 20.',
  summary(d, data) {
    const abs = finalAbilities(d), p = d.klass ? spellProgression(d.klass, 1) : null;
    const gear = parseEquipment(d.equipmentText, data.equipment);
    const armor = gear.items.find(e => e.name === d.armor);
    const ac = d.acOverride === '' || d.acOverride == null ? armorClass(abs, d.klass, armor, d.shield, [{ name: d.fightingStyle || '' }]) : d.acOverride;
    return el('div', {}, el('div', { class: 'creator-kicker' }, 'YOUR CHARACTER'), el('h2', {}, d.name || 'An adventurer in the making'),
      el('p', { class: 'muted small' }, [d.species?.name, d.klass?.name, d.background?.name].filter(Boolean).join(' · ') || 'Your choices appear here.'),
      el('div', { class: 'creator-ability-summary' }, ABILITIES.map(a => el('div', {}, el('span', { class: 'muted small' }, a.toUpperCase()), el('strong', {}, abs[a]), el('span', { class: 'small' }, fmtMod(mod(abs[a])))))),
      el('dl', { class: 'creator-facts' }, [['Level', 1], ['Armor class', ac], ['Starting HP', d.klass ? Math.max(1, d.klass.hitDie + mod(abs.con)) + (d.species?.name === 'Dwarf' ? 1 : 0) + (originFeats(d, data).some(f => lower(f.name) === 'tough') ? 2 : 0) : '—'],
        ['Speed', d.species ? `${d.species.speed} ft.` : '—'], ['Skills', draftSkills(d).length], ['Spells', p?.prepared != null ? `${(d.spells || []).length} / ${p.prepared}` : '—']]
        .map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      el('p', { class: 'small muted' }, 'Ability totals include your background increases. Review equipment and feature choices before finishing.'));
  },
  steps: [
    { key: 'home', title: 'Character & sources', render(d, ctx) {
      d.role ??= 'PC'; d.languages ??= ['Common Sign Language', 'Elvish'];
      const name = input(d, 'name', 'Character name');
      const packs = [...new Set(['SRD 5.2', ...['classes', 'species', 'backgrounds', 'feats', 'spells', 'equipment'].flatMap(k => ctx.data[k].map(x => x._pack || 'SRD 5.2'))])];
      return el('div', {}, el('div', { class: 'row' }, field('Name', name), el('button', { class: 'ghost', onclick: () => { d.name = randomName('person'); name.value = d.name; } }, '🎲 Suggest name'),
        field('Role', chooseList(['PC', 'NPC'], d.role, v => { d.role = v; }))),
        el('h3', {}, 'Content sources'), el('p', { class: 'muted small' }, 'Choose the local sources allowed at your table. Search and source filters are available in every choice browser. Bundled SRD entries take precedence when names match.'),
        el('div', { class: 'creator-checks' }, packs.map(pack => el('label', {}, el('input', { type: 'checkbox', checked: !(d.excludedSources || []).includes(pack), onchange: ev => {
          d.excludedSources = ev.target.checked ? (d.excludedSources || []).filter(s => s !== pack) : unique([...(d.excludedSources || []), pack]);
        } }), pack))),
        (ctx.data.warnings || []).map(w => el('p', { class: 'notice warn small' }, w)),
        el('p', { class: 'small muted' }, 'Add 5etools packs in ', el('a', { href: '#/library' }, 'Library'), '. Return here to resume this draft.'));
    }, validate: () => null },
    { key: 'class', title: 'Class', render(d, ctx) {
      const wrap = choicePicker({ items: items(ctx, 'classes', d), selected: d.klass, browse: browse(d, 'class'), label: 'classes',
        describe: c => `d${c.hitDie} · ${(c.primaryAbility || []).map(a => a.toUpperCase()).join('/')} · ${c.spellcasting ? 'Spellcaster' : 'Martial'}`,
        details: c => el('div', {}, el('p', { class: 'small' }, `Saving throws: ${c.saves.join(', ').toUpperCase()}. Choose ${c.skills.choose} skills. Armor: ${c.armor.join(', ') || 'none'}.`),
          el('div', { class: 'choice-prose' }, featuresText(c.features.filter(f => f.level === 1)))),
        onPick: c => { if (d.klass?.name !== c.name) { d.skillPicks = []; d.expertise = []; d.cantrips = []; d.spells = []; d.spellbook = []; d.subclassPick = ''; d.fightingStyle = ''; } d.klass = c; ctx.update(); } });
      if (d.klass) wrap.append(field('Plan a subclass (features begin at its required level)', chooseList((d.klass.subclasses || []).filter(s => isAvailable(s, d)), d.subclassPick, v => { d.subclassPick = v; }, 'Decide when levelling up')));
      return wrap;
    }, validate: (d, ctx) => selectedValid(d, ctx, 'klass', 'classes', 'class') },
    { key: 'species', title: 'Species', render(d, ctx) {
      return choicePicker({ items: items(ctx, 'species', d), selected: d.species, browse: browse(d, 'species'), label: 'species',
        describe: s => `${s.size} · ${s.speed} ft.${s.darkvision ? ` · Darkvision ${s.darkvision} ft.` : ''}`, details: s => featuresText(s.traits),
        onPick: s => { if (d.species?.name !== s.name) { d.bonusSkills = []; d.humanFeat = ''; } d.species = s; ctx.update(); } });
    }, validate: (d, ctx) => selectedValid(d, ctx, 'species', 'species', 'species') },
    { key: 'background', title: 'Background', render(d, ctx) {
      return choicePicker({ items: items(ctx, 'backgrounds', d), selected: d.background, browse: browse(d, 'background'), label: 'backgrounds',
        describe: b => `${b.skills.join(', ')}${b.feat ? ` · ${b.feat}` : ' · Choose an origin feat'}`, details: b => [b.text, b.equipment].filter(Boolean).join('\n\n'),
        onPick: b => { if (d.background?.name !== b.name) { d.bgBonus = null; d.backgroundSkillPicks = []; d.skillPicks = []; d.originFeat = ''; } d.background = b; ctx.update(); } });
    }, validate: (d, ctx) => selectedValid(d, ctx, 'background', 'backgrounds', 'background') },
    { key: 'abilities', title: 'Ability scores', render(d, ctx) {
      d.abilityMethod ??= 'standard'; d.abilities ??= recommendedAbilities(d.klass);
      const allowed = d.background.abilities?.length ? d.background.abilities : ABILITIES;
      const preferred = unique([...(d.klass.primaryAbility || []), 'con', 'dex', ...allowed]).filter(a => allowed.includes(a));
      d.bgBonus ??= { mode: '2+1', two: preferred[0], one: preferred[1], three: allowed.slice(0, 3) };
      const method = chooseList([{ name: 'Standard array' }, { name: 'Point buy' }, { name: 'Roll dice' }, { name: 'Manual scores' }], '', () => {});
      method.replaceChildren(...[['standard', 'Standard array'], ['pointbuy', 'Point buy · 27 points'], ['roll', 'Roll 4d6, drop lowest'], ['manual', 'Manual scores']].map(([v, label]) => el('option', { value: v }, label)));
      method.value = d.abilityMethod;
      method.onchange = () => { d.abilityMethod = method.value; if (method.value === 'pointbuy') d.abilities = Object.fromEntries(ABILITIES.map(a => [a, 8])); ctx.update(); };
      const totals = el('div', { class: 'creator-ability-totals small', role: 'status' });
      const update = () => { const abs = finalAbilities(d); const spent = ABILITIES.reduce((n, a) => n + (POINT_BUY_COST[d.abilities[a]] ?? 0), 0);
        totals.textContent = `${d.abilityMethod === 'pointbuy' ? `${spent}/27 points spent. ` : ''}Final scores: ${ABILITIES.map(a => `${a.toUpperCase()} ${abs[a]} (${fmtMod(mod(abs[a]))})`).join(' · ')}`; };
      const controls = ABILITIES.map(a => {
        let control;
        if (d.abilityMethod === 'standard') {
          control = chooseList(STANDARD_ARRAY.map(String), String(d.abilities[a]), v => { d.abilities[a] = Number(v); update(); });
        } else control = el('input', { type: 'number', min: d.abilityMethod === 'pointbuy' ? 8 : 3, max: d.abilityMethod === 'pointbuy' ? 15 : 18, step: 1, value: d.abilities[a], oninput: ev => { d.abilities[a] = ev.target.value === '' ? null : Number(ev.target.value); update(); } });
        return field(ABILITY_NAMES[a], control);
      });
      const bonusMode = chooseList(['2+1', '1+1+1'], d.bgBonus.mode, v => { d.bgBonus.mode = v; ctx.update(); });
      const bonuses = d.bgBonus.mode === '2+1'
        ? [field('+2', chooseList(allowed, d.bgBonus.two, v => { d.bgBonus.two = v; update(); })), field('+1', chooseList(allowed, d.bgBonus.one, v => { d.bgBonus.one = v; update(); }))]
        : [skillChecks(allowed, d.bgBonus.three ??= [], 3, () => { update(); ctx.update(); })];
      update();
      return el('div', {}, el('div', { class: 'row' }, field('Method', method),
        el('button', { class: 'ghost', onclick: () => { d.abilities = recommendedAbilities(d.klass); d.abilityMethod = 'standard'; ctx.update(); } }, `Use ${d.klass.name} recommendations`),
        el('button', { class: 'ghost', onclick: () => { d.abilityMethod = 'roll'; d.rolls = ABILITIES.map(() => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6)).sort((a, b) => a - b)); d.abilities = Object.fromEntries(ABILITIES.map((a, i) => [a, d.rolls[i].slice(1).reduce((a, b) => a + b)])); ctx.update(); } }, '🎲 Roll all scores')),
        el('div', { class: 'creator-abilities' }, controls),
        d.rolls && d.abilityMethod === 'roll' ? el('p', { class: 'muted small' }, d.rolls.map((r, i) => `${ABILITIES[i].toUpperCase()}: [${r[0]} dropped] ${r.slice(1).join(' + ')}`).join(' · ')) : null,
        el('h3', {}, 'Background increases'), el('div', { class: 'row' }, field('Distribution', bonusMode), bonuses), totals);
    }, validate: d => validateAbilities(d) || validateBackground(d) },
    { key: 'features', title: 'Features & choices', render(d, ctx) {
      const wrap = el('div', {}); d.featureChoices ??= {};
      if (!d.background.feat) wrap.append(field('Origin feat', chooseList(featsFor(d, ctx.data), d.originFeat, v => { d.originFeat = v; ctx.update(); })));
      if (d.species.name === 'Human') wrap.append(field('Versatile · extra origin feat', chooseList(featsFor(d, ctx.data).filter(f => lower(f.name) !== lower(d.background.feat || d.originFeat)), d.humanFeat, v => { d.humanFeat = v; ctx.update(); })));
      if (d.klass.name === 'Fighter') wrap.append(field('Fighting Style', chooseList(items(ctx, 'feats', d).filter(f => f.category === 'Fighting Style'), d.fightingStyle, v => { d.fightingStyle = v; ctx.update(); })));
      wrap.append(el('p', { class: 'small muted' }, 'Read the features you gain. Record choices such as ancestry, lineage, tools or weapon mastery below; these notes are carried onto the sheet. Effects beyond the calculated ability scores, HP, equipment and spellcasting can be adjusted in the sheet editor.'));
      const choices = [...d.species.traits, ...d.klass.features.filter(f => f.level === 1), ...originFeats(d, ctx.data)];
      for (const f of choices) wrap.append(el('details', { class: 'feature-choice' }, el('summary', {}, f.name),
        el('div', { class: 'choice-prose small' }, f.text || ''), field('Your choices / notes', input(d.featureChoices, f.name, 'Record any choices this feature asks for…'))));
      return wrap;
    }, validate(d, ctx) {
      if (!d.background.feat && !featsFor(d, ctx.data).some(f => f.name === d.originFeat)) return 'Choose an origin feat for this background.';
      if (d.species.name === 'Human' && (!featsFor(d, ctx.data).some(f => f.name === d.humanFeat) || lower(d.humanFeat) === lower(d.background.feat || d.originFeat))) return 'Choose a different extra origin feat for Human Versatile.';
      if (d.klass.name === 'Fighter' && !items(ctx, 'feats', d).some(f => f.category === 'Fighting Style' && f.name === d.fightingStyle)) return 'Choose a Fighting Style.';
      return null;
    } },
    { key: 'skills', title: 'Skills & languages', render(d, ctx) {
      const wrap = el('div', {}); d.skillPicks ??= []; d.backgroundSkillPicks ??= []; d.bonusSkills ??= []; d.expertise ??= [];
      const bgChoices = d.background.skillChoices || [];
      const bgCount = bgChoices.reduce((n, c) => n + (c.count || 1), 0);
      if (bgCount) wrap.append(el('h3', {}, `Background · choose ${bgCount}`), skillChecks(unique(bgChoices.flatMap(c => c.from || SKILLS.map(([n]) => n)).map(canonSkill)), d.backgroundSkillPicks, bgCount, ctx.update, d.background.skills));
      wrap.append(el('p', { class: 'small muted' }, `Background grants: ${backgroundSkills(d).join(', ') || 'none'}.`),
        el('h3', {}, `${d.klass.name} skills · ${d.skillPicks.length}/${d.klass.skills.choose}`), skillChecks(classSkills(d.klass), d.skillPicks, d.klass.skills.choose, ctx.update, backgroundSkills(d)));
      const extra = bonusSkillCount(d, ctx.data);
      if (extra) wrap.append(el('h3', {}, `Species / feat skills · ${d.bonusSkills.length}/${extra}`), skillChecks(SKILLS.map(([n]) => n), d.bonusSkills, extra, ctx.update, unique([...backgroundSkills(d), ...d.skillPicks])));
      if (d.klass.name === 'Rogue') wrap.append(el('h3', {}, `Expertise · ${d.expertise.length}/2`), skillChecks(draftSkills(d), d.expertise, 2, ctx.update));
      wrap.append(el('h3', {}, 'Languages'), el('p', { class: 'small muted' }, 'Common plus two standard languages. Add any additional languages from your features in the notes.'),
        ...[0, 1].map(i => field(`Language ${i + 1}`, chooseList(['Common Sign Language', 'Draconic', 'Dwarvish', 'Elvish', 'Giant', 'Gnomish', 'Goblin', 'Halfling', 'Orc'], d.languages?.[i], v => { (d.languages ??= [])[i] = v; }))));
      return wrap;
    }, validate(d, ctx) {
      const bg = backgroundSkills(d), picks = d.skillPicks || [], extra = d.bonusSkills || [];
      if (unique(picks).length !== d.klass.skills.choose || picks.some(s => bg.includes(s) || !classSkills(d.klass).includes(s))) return `Choose ${d.klass.skills.choose} distinct class skills outside your background skills.`;
      const bgChoices = d.background.skillChoices || [], bgCount = bgChoices.reduce((n, c) => n + (c.count || 1), 0);
      if ((d.backgroundSkillPicks || []).length !== bgCount) return `Choose ${bgCount} background skills.`;
      if (unique(extra).length !== bonusSkillCount(d, ctx.data) || extra.some(s => [...bg, ...picks].includes(s))) return 'Choose the remaining species / feat skills without duplicates.';
      if (d.species.name === 'Elf' && !extra.some(s => ['Insight', 'Perception', 'Survival'].includes(s))) return 'Elf Keen Senses must grant Insight, Perception or Survival.';
      if (d.klass.name === 'Rogue' && (unique(d.expertise).length !== 2 || d.expertise.some(s => !draftSkills(d).includes(s)))) return 'Choose expertise in two proficient skills.';
      if (unique(d.languages).length !== 2 || d.languages.some(s => !s || s === 'Common')) return 'Choose two different languages in addition to Common.';
      return null;
    } },
    { key: 'equipment', title: 'Equipment', render(d, ctx) {
      const wrap = el('div', {}); d.gearPicks ??= {};
      const choices = [['Class', d.klass.startingEquipment], ['Background', d.background.equipment]];
      const seed = () => choices.map(([key, text]) => { const opts = equipmentChoices(text); return (opts.find(o => o.key === d.gearPicks[key]) || opts[0])?.text || ''; }).filter(Boolean).join('\n');
      if (d.equipmentText == null) { d.equipmentText = seed(); d.gearSeed = d.equipmentText; }
      for (const [key, text] of choices) {
        const opts = equipmentChoices(text); if (!opts.length) continue;
        d.gearPicks[key] ??= opts[0].key;
        wrap.append(el('h3', {}, `${key} starting equipment`), el('div', { class: 'gear-options' }, opts.map(o => el('label', { class: 'choice-detail' },
          el('input', { type: 'radio', name: `gear-${key}`, checked: d.gearPicks[key] === o.key, onchange: () => { d.gearPicks[key] = o.key; } }),
          el('strong', {}, `Option ${o.key}`), el('span', { class: 'small' }, o.text)))));
      }
      wrap.append(el('button', { class: 'small', onclick: () => { d.equipmentText = seed(); d.gearSeed = d.equipmentText; d.gold = parseEquipment(d.equipmentText).gp; delete d.armor; delete d.shield; ctx.update(); } }, 'Use selected starting equipment'));
      const area = el('textarea', { rows: 5, 'aria-label': 'Carried equipment', oninput: ev => { d.equipmentText = ev.target.value; } }); area.value = d.equipmentText;
      const gear = parseEquipment(d.equipmentText, ctx.data.equipment);
      const armors = gear.items.filter(e => /armor/i.test(e.kind || e.category || '') && e.ac != null);
      d.armor ??= armors[0]?.name || '';
      d.shield ??= gear.items.some(e => /shield/i.test(e.kind || e.category || ''));
      d.gold ??= gear.gp;
      wrap.append(field('Carried equipment (one item per line, or comma separated)', area),
        el('p', { class: 'small muted' }, 'The starting options supply items and gold. Pick worn armor below; weapons in your inventory become attacks. Edit unresolved choices, such as an instrument, in the inventory.'),
        el('div', { class: 'row' }, field('Worn armor', chooseList(armors, d.armor, v => { d.armor = v; }, 'Unarmored')),
          field('Shield equipped', el('input', { type: 'checkbox', checked: d.shield, onchange: ev => { d.shield = ev.target.checked; } })),
          field('Gold pieces', el('input', { type: 'number', value: d.gold, min: 0, step: 0.01, oninput: ev => { d.gold = Number(ev.target.value); } })),
          field('Custom AC (optional)', el('input', { type: 'number', value: d.acOverride ?? '', min: 1, max: 40, oninput: ev => { d.acOverride = ev.target.value; } }))),
        el('details', {}, el('summary', {}, 'Add from the equipment library'), choicePicker({ items: items(ctx, 'equipment', d), browse: browse(d, 'equipment'), label: 'equipment', describe: e => [e.kind || e.category, e.cost, e.damage].filter(Boolean).join(' · '), onPick: e => { d.equipmentText += `\n${e.name}`; ctx.update(); } })));
      return wrap;
    }, validate(d, ctx) {
      const gear = parseEquipment(d.equipmentText, ctx.data.equipment);
      if (d.armor && !gear.items.some(e => e.name === d.armor && e.ac != null)) return 'Your worn armor is no longer in the inventory. Select it again.';
      if (d.shield && !gear.items.some(e => /shield/i.test(e.kind || e.category || e.name))) return 'Add a shield to your inventory or turn off Shield equipped.';
      if (!Number.isFinite(Number(d.gold)) || Number(d.gold) < 0) return 'Enter a valid nonnegative gold amount.';
      if (d.acOverride !== '' && d.acOverride != null && (!Number.isInteger(Number(d.acOverride)) || Number(d.acOverride) < 1 || Number(d.acOverride) > 40)) return 'Custom AC must be a whole number from 1 to 40.';
      return null;
    } },
    { key: 'spells', title: 'Spells', when: d => !!d.klass?.spellcasting || !!d.background?.feat?.match(/magic initiate/i) || !!d.originFeat?.match(/magic initiate/i) || !!d.humanFeat?.match(/magic initiate/i), render(d, ctx) {
      const wrap = el('div', {}), c = d.klass, p = spellProgression(c, 1); d.cantrips ??= []; d.spells ??= []; d.spellbook ??= [];
      if (c.spellcasting) {
        if (!p.supported) wrap.append(el('p', { class: 'notice warn' }, 'This imported class is missing its spell progression. Re-import an updated class pack from Library before creating this spellcaster.'));
        const list = availableSpells(ctx.data, c, 1, d);
        if (p.cantrips) wrap.append(spellPicker({ items: list.filter(s => s.level === 0), picks: d.cantrips, onChange: () => {}, limit: p.cantrips, title: 'Class cantrips', browse: browse(d, 'cantrips') }));
        if (c.name === 'Wizard') wrap.append(spellPicker({ items: list.filter(s => s.level === 1), picks: d.spellbook, onChange: () => {}, limit: 6, title: 'Spellbook · learn six spells', browse: browse(d, 'book') }));
        const grants = classGrantedSpells(c, 1);
        if (grants.length) wrap.append(el('p', { class: 'notice small' }, `Always prepared: ${grants.join(', ')}. These are extra and do not use your choices below.`));
        wrap.append(spellPicker({ items: list.filter(s => s.level === 1 && !grants.includes(s.name)), picks: d.spells, onChange: () => {}, limit: p.prepared, title: 'Prepared spells', browse: browse(d, 'spells') }));
        if (c.name === 'Wizard') wrap.append(el('p', { class: 'small muted' }, 'Prepared spells must be among the six spells in your spellbook.'));
      }
      d.initiate ??= {};
      for (const f of magicOrigins(d, ctx.data)) {
        const pick = d.initiate[f.name] ??= { className: f.name.split(';')[1]?.trim() || '', ability: 'wis', cantrips: [], spell: '' };
        wrap.append(el('h3', {}, f.name), field('Spell list', chooseList(['Cleric', 'Druid', 'Wizard'], pick.className, v => { pick.className = v; pick.cantrips = []; pick.spell = ''; ctx.update(); })),
          field('Spellcasting ability', chooseList(['int', 'wis', 'cha'], pick.ability, v => { pick.ability = v; })));
        if (pick.className) {
          const list = availableSpells(ctx.data, { name: pick.className }, 1, d);
          wrap.append(spellPicker({ items: list.filter(s => !s.level), picks: pick.cantrips, onChange: () => {}, limit: 2, title: `${f.name} cantrips`, browse: browse(d, f.name) }),
            field('Level-1 spell · one free cast per Long Rest', chooseList(list.filter(s => s.level === 1), pick.spell, v => { pick.spell = v; })));
        }
      }
      return wrap;
    }, validate(d, ctx) {
      const p = spellProgression(d.klass, 1), list = availableSpells(ctx.data, d.klass, 1, d);
      if (d.klass.spellcasting) {
        if (!p.supported) return 'Update this class pack: spell progression data is missing.';
        const err = validSpellPicks(d.cantrips || [], list.filter(s => !s.level), p.cantrips, 'class cantrips') || validSpellPicks(d.spells || [], list.filter(s => s.level === 1 && !classGrantedSpells(d.klass, 1).includes(s.name)), p.prepared, 'prepared spells');
        if (err) return err;
        if (d.klass.name === 'Wizard') {
          const bookErr = validSpellPicks(d.spellbook || [], list.filter(s => s.level === 1), 6, 'spellbook spells');
          if (bookErr) return bookErr;
          if (d.spells.some(s => !d.spellbook.includes(s))) return 'Every prepared spell must be in your spellbook.';
        }
      }
      for (const f of magicOrigins(d, ctx.data)) {
        const pick = d.initiate?.[f.name], fixedClass = f.name.split(';')[1]?.trim();
        if (!pick || !['Cleric', 'Druid', 'Wizard'].includes(pick.className) || (fixedClass && pick.className !== fixedClass) || !['int', 'wis', 'cha'].includes(pick.ability)) return `Choose the spell list and ability for ${f.name}.`;
        const list = availableSpells(ctx.data, { name: pick.className }, 1, d);
        if (validSpellPicks(pick.cantrips, list.filter(s => !s.level), 2, 'cantrips') || !list.some(s => s.level === 1 && s.name === pick.spell)) return `Choose two cantrips and one level-1 spell for ${f.name}.`;
      }
      return null;
    } },
    { key: 'review', title: 'Review & finish', render(d, ctx) {
      d.personality ??= {};
      return el('div', {}, el('div', { class: 'notice' }, 'Review the summary and revisit any step. Finish checks every choice again before creating one entry.'),
        field('Character name', input(d, 'name', 'Name required')),
        field('Alignment', chooseList(['Lawful Good', 'Neutral Good', 'Chaotic Good', 'Lawful Neutral', 'Neutral', 'Chaotic Neutral', 'Lawful Evil', 'Neutral Evil', 'Chaotic Evil'], d.alignment, v => { d.alignment = v; }, 'Leave blank')),
        ...['traits', 'ideals', 'bonds', 'flaws'].map(k => field(k[0].toUpperCase() + k.slice(1), input(d.personality, k))),
        field('Backstory / additional feature choices', el('textarea', { rows: 4, oninput: ev => { d.notes = ev.target.value; } }, d.notes || '')),
        el('p', { class: 'small muted' }, `Sources: ${unique([d.klass, d.species, d.background].map(sourceLabel)).join('; ')}`));
    }, validate: d => d.name?.trim() ? null : 'Give your character a name.' },
  ],
  finish(d, ctx) {
    for (const step of this.steps.filter(s => !s.when || s.when(d))) { const err = step.validate?.(d, ctx); if (err) throw new Error(`${step.title}: ${err}`); }
    d.innateSpells = magicOrigins(d, ctx.data).flatMap(f => { const p = d.initiate[f.name]; return [...p.cantrips.map(name => ({ name, level: 0, ability: p.ability, source: f.name })), { name: p.spell, level: 1, ability: p.ability, source: f.name, uses: 1 }]; });
    return buildCharacter(d, ctx.data);
  },
};
