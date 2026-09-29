import { ABILITIES, SKILLS, lower, unique, canonSkill, classSkills, mod, profBonus, spellProgression, availableSpells, armorClass, fmtMod, monkDamage, classGrantedSpells } from './dndrules.js';

export function expertiseCount(klass, level) {
  if (klass.name === 'Rogue' && [1, 6].includes(level)) return 2;
  if (klass.name === 'Bard' && [3, 9].includes(level)) return 2;
  if (klass.name === 'Ranger') return level === 2 ? 1 : level === 9 ? 2 : 0;
  return klass.name === 'Wizard' && level === 2 ? 1 : 0;
}

export function subclassSpells(subclass, level) {
  const names = [];
  for (const entry of subclass?.additionalSpells || []) {
    // Only fixed, always-prepared grants are automatic. Expanded spell lists
    // offer choices and must not become free prepared spells.
    for (const [at, spells] of Object.entries(entry.prepared || {})) {
      if (!/^\d+$/.test(at) || Number(at) > level || !Array.isArray(spells)) continue;
      for (const name of spells) if (typeof name === 'string') names.push(name.split('|')[0].replace(/#.*$/, ''));
    }
  }
  return unique(names);
}

export function advancementRequirements(data, klass, subclassName = data.klass.subclass) {
  const to = Number(data.klass.level) + 1;
  const features = (klass.features || []).filter(f => Number(f.level) === to);
  const subclassFeatures = (klass.subclasses || []).find(s => s.name === subclassName)?.features?.filter(f => Number(f.level) === to) || [];
  const loreSkills = klass.name === 'Bard' && subclassName === 'College of Lore' && to === 3;
  return { to, features, subclass: to >= 3 && !data.klass.subclass,
    fightingStyle: [...features, ...subclassFeatures].some(f => /fighting style/i.test(f.name)),
    abilityOrFeat: features.some(f => /ability score improvement|epic boon/i.test(f.name)),
    epic: features.some(f => /epic boon/i.test(f.name)), expertise: expertiseCount(klass, to),
    skill: loreSkills ? 3 : klass.name === 'Barbarian' && to === 3 ? 1 : 0,
    skillOptions: loreSkills ? SKILLS.map(([n]) => n) : classSkills(klass),
    spells: spellProgression(klass, to),
  };
}

export function eligibleFeat(feat, data, level) {
  if (!feat || feat.category === 'Fighting Style' || feat.name === 'Ability Score Improvement') return false;
  if (feat.category === 'Epic Boon' && level < 19) return false;
  if (!feat.repeatable && (data.features || []).some(f => lower(f.name) === lower(feat.name))) return false;
  let prerequisites = feat.prerequisite;
  if (!prerequisites && feat.prereq) { try { prerequisites = [JSON.parse(feat.prereq)]; } catch { /* full text is reviewed by the DM */ } }
  if (!prerequisites?.length) return true;
  return prerequisites.some(req => {
    if (Number(req.level?.level || req.level || 0) > level) return false;
    if (req.ability?.length && !req.ability.some(a => Object.entries(a).every(([k, v]) => Number(data.abilities?.[k] || 0) >= v))) return false;
    return true;
  });
}

function featBonuses(feat, selected = {}) {
  if (!feat?.ability?.length) return {};
  for (const option of feat.ability) {
    const out = Object.fromEntries(ABILITIES.filter(a => Number.isFinite(option[a])).map(a => [a, option[a]]));
    const choice = option.choose;
    if (!choice) { if (!Object.keys(selected).length) return out; continue; }
    const count = choice.count || 1, amount = choice.amount || 1;
    const picks = Object.entries(selected).filter(([, n]) => n > 0);
    if (picks.length !== count || picks.some(([a, n]) => !choice.from?.includes(a) || n !== amount)) continue;
    for (const [a, n] of picks) out[a] = (out[a] || 0) + n;
    return out;
  }
  throw new Error('Assign the ability increase allowed by your chosen feat.');
}

function requirePicks(picks, count, available, label, old = []) {
  if (!Array.isArray(picks) || picks.length !== count || unique(picks).length !== count) throw new Error(`Choose exactly ${count} ${label}.`);
  if (picks.some(name => !available.includes(name) && !old.includes(name))) throw new Error(`Review ${label}: a choice is not available at this level.`);
}

/** Pure preview: every validation completes before any existing sheet changes. */
export function planLevelUp(data, klass, choices, library) {
  if (!Number.isInteger(data?.klass?.level) || data.klass.level < 1 || data.klass.level >= 20) throw new Error('Choose a character from level 1 to 19.');
  if (!klass || lower(klass.name) !== lower(data.klass.name)) throw new Error('Matching class data is required.');
  const from = data.klass.level, to = from + 1, req = advancementRequirements(data, klass, choices.subclass || data.klass.subclass);
  const next = structuredClone(data), oldAbs = { ...data.abilities }, oldPb = profBonus(from), pb = profBonus(to);
  const die = Number(klass.hitDie || data.klass.hitDie);
  if (!Number.isInteger(die) || die < 4 || die > 20) throw new Error('This class needs a valid hit die.');
  const dieResult = choices.hpMethod === 'average' ? Math.floor(die / 2) + 1 : Number(choices.hpRoll);
  if (!Number.isInteger(dieResult) || dieResult < 1 || dieResult > die) throw new Error(`Enter a hit-die roll from 1 to ${die}. The Constitution modifier is added automatically.`);
  next.features ??= []; next.skills ??= []; next.abilities = { ...oldAbs };
  const added = [], add = f => {
    if (next.features.some(x => lower(x.name) === lower(f.name) && x.source === f.source)) return;
    next.features.push(f); added.push(f.name);
  };
  const selectedSubclass = choices.subclass || data.klass.subclass;
  if (choices.subclass && !data.klass.subclass && to < 3) throw new Error('Subclass features begin at level 3. Your planned subclass is saved for that level.');
  if (data.klass.subclass && choices.subclass && choices.subclass !== data.klass.subclass) throw new Error('Level-up cannot replace an existing subclass.');
  const sub = (klass.subclasses || []).find(s => s.name === selectedSubclass);
  if (data.klass.subclass && !sub) throw new Error('The current subclass is missing from Library. Restore its pack before advancing so its features are retained.');
  if (req.subclass && !sub) throw new Error('Choose a subclass before advancing.');
  if (choices.subclass && !sub) throw new Error('That subclass is not available for this class.');
  if (sub) next.klass.subclass = sub.name;
  if (req.fightingStyle) {
    const style = library.feats.find(f => f.category === 'Fighting Style' && f.name === choices.fightingStyle);
    if (!style || data.features?.some(f => f.name === style.name)) throw new Error('Choose a new Fighting Style.');
    add({ name: style.name, source: `Fighting Style · ${klass.name} ${to}`, text: style.text || '' });
  }
  let feat = null;
  if (req.abilityOrFeat) {
    if (choices.improvement === 'asi') {
      const increases = choices.abilityIncreases || {};
      if (Object.entries(increases).some(([a, n]) => !ABILITIES.includes(a) || !Number.isInteger(n) || n < 0 || n > 2)
        || Object.values(increases).reduce((a, b) => a + b, 0) !== 2) throw new Error('Assign +2 to one ability or +1 to two abilities.');
      for (const [a, n] of Object.entries(increases)) {
        if (next.abilities[a] + n > 20 && n) throw new Error('Ability Score Improvement cannot raise a score above 20.');
        next.abilities[a] += n;
      }
      add({ name: 'Ability increase', source: `${klass.name} ${to}`, text: Object.entries(increases).filter(([, n]) => n).map(([a, n]) => `${a.toUpperCase()} +${n}`).join(', ') });
    } else if (choices.improvement === 'feat') {
      feat = library.feats.find(f => f.name === choices.feat);
      if (!eligibleFeat(feat, data, to)) throw new Error('Choose an eligible feat you do not already have.');
      if (!choices.featReviewed) throw new Error('Review the feat prerequisites and any additional choices before applying.');
      const bonuses = featBonuses(feat, choices.featAbilities);
      for (const [a, n] of Object.entries(bonuses)) {
        const cap = Math.max(...(feat.ability || []).map(a => Number(a.max) || 20));
        if (next.abilities[a] + n > cap) throw new Error(`This feat cannot raise ${a.toUpperCase()} above ${cap}.`);
        next.abilities[a] += n;
      }
      add({ name: feat.name, source: `Feat · ${klass.name} ${to}`, text: [feat.text, choices.featNotes].filter(Boolean).join('\n\n') });
      if (/^magic initiate$/i.test(feat.name)) {
        const pick = choices.initiate;
        if (!pick || !['Cleric', 'Druid', 'Wizard'].includes(pick.className) || !['int', 'wis', 'cha'].includes(pick.ability)) throw new Error('Choose the Magic Initiate spell list and ability.');
        const list = availableSpells(library, { name: pick.className }, 1);
        requirePicks(pick.cantrips, 2, list.filter(s => s.level === 0).map(s => s.name), 'Magic Initiate cantrips');
        requirePicks([pick.spell], 1, list.filter(s => s.level === 1).map(s => s.name), 'Magic Initiate level-1 spell');
        const spells = [...pick.cantrips.map(name => ({ name, level: 0 })), { name: pick.spell, level: 1, uses: 1 }].map(s => ({ ...s, ability: pick.ability, source: `Magic Initiate · ${pick.className}` }));
        next.innateSpells = [...(next.innateSpells || []), ...spells];
        next.spellDetails = [...(next.spellDetails || []), ...list.filter(s => spells.some(p => p.name === s.name)).map(s => ({ ...s }))];
      }
    } else throw new Error('Choose an ability increase or a feat.');
  }
  // These capstone increases are fixed class math, not selectable ASIs.
  if (to === 20 && klass.name === 'Barbarian') for (const a of ['str', 'con']) next.abilities[a] = Math.min(25, next.abilities[a] + 4);
  if (to === 20 && klass.name === 'Monk') for (const a of ['dex', 'wis']) next.abilities[a] = Math.min(25, next.abilities[a] + 4);
  const gainedSkills = choices.skills || [];
  const skillCount = req.skill + (feat?.name === 'Skilled' ? 3 : 0);
  const allowedSkills = feat?.name === 'Skilled' ? SKILLS.map(([n]) => n) : req.skillOptions;
  requirePicks(gainedSkills, skillCount, allowedSkills.filter(n => !next.skills.some(s => s.key === n)), 'new skill proficiencies');
  next.skills.push(...gainedSkills.map(key => ({ key, prof: 'prof' })));
  const expertiseOptions = next.skills.filter(s => s.prof !== 'expert' && (klass.name !== 'Wizard' || ['Arcana', 'History', 'Investigation', 'Medicine', 'Nature', 'Religion'].includes(s.key))).map(s => s.key);
  requirePicks(choices.expertise || [], req.expertise, expertiseOptions, 'expertise skills');
  for (const name of choices.expertise || []) next.skills.find(s => s.key === name).prof = 'expert';
  for (const f of req.features) add({ name: f.name, source: `${klass.name} ${to}`, text: f.text || '' });
  if (sub) for (const f of sub.features || []) if (Number(f.level) <= to && (Number(f.level) > from || !data.klass.subclass)) add({ name: f.name, source: `${sub.name} ${f.level}`, text: f.text || '' });
  for (const [name, value] of Object.entries(choices.featureChoices || {})) if (String(value).trim()) add({ name, source: `Choice · ${klass.name} ${to}`, text: String(value).trim() });
  const choiceFeatures = [...req.features, ...(sub?.features || []).filter(f => f.level === to)].filter(f => /choose|choice/i.test(f.text || '') && !/ability score improvement|subclass|expertise|scholar|spellcasting/i.test(f.name));
  if (choiceFeatures.length && !choices.featuresReviewed) throw new Error('Review the new feature choices and record any selections before applying.');

  const conBefore = mod(oldAbs.con), conAfter = mod(next.abilities.con);
  const oldTough = (data.features || []).some(f => lower(f.name) === 'tough');
  const hasTough = next.features.some(f => lower(f.name) === 'tough');
  const retroactive = (conAfter - conBefore) * from + (hasTough && !oldTough ? from * 2 : 0);
  const hpGain = Math.max(1, dieResult + conAfter) + retroactive + (lower(data.species?.name) === 'dwarf' ? 1 : 0) + (hasTough ? 2 : 0);
  next.hp = { ...(next.hp || {}), max: Number(data.hp?.max || 0) + hpGain,
    current: Number(data.hp?.current || 0) + (choices.addToCurrent !== false ? hpGain : 0) };
  next.klass.level = to; next.klass.hitDie = die;
  if (next.defense?.automatic) next.ac = armorClass(next.abilities, next.klass, next.defense.armor, next.defense.shield, next.features);
  const hasAlert = next.features.some(f => lower(f.name) === 'alert');
  if (hasAlert) next.initiativeBonus = pb;
  for (const attack of next.attacks || []) {
    // Imported/manual attacks stay user-owned; only builder-generated attacks
    // carry the formula metadata needed to recalculate safely.
    if (!ABILITIES.includes(attack.ability) || !attack.baseDamage) continue;
    const delta = mod(next.abilities[attack.ability]) - mod(oldAbs[attack.ability]) + (attack.proficient ? pb - oldPb : 0);
    attack.bonus += delta + (choices.fightingStyle === 'Archery' && attack.ranged ? 2 : 0);
    const bonus = mod(next.abilities[attack.ability]);
    if (attack.monkWeapon && klass.name === 'Monk') attack.baseDamage = monkDamage(attack.weaponDamage || attack.baseDamage, to);
    attack.damage = attack.baseDamage.replace(/^(\d+d\d+)/i, `$1${bonus ? fmtMod(bonus) : ''}`);
  }
  if (klass.spellcasting) {
    const p = req.spells;
    if (!p.supported) throw new Error('This class pack lacks spell progression data. Update it in Library before advancing.');
    const old = data.spellcasting || {}, available = availableSpells(library, klass, p.maxLevel);
    const grants = unique([...classGrantedSpells(klass, to), ...subclassSpells(sub, to)]).map(n => library.spells.find(s => lower(s.name) === lower(n))?.name || n);
    const spellNames = available.filter(s => s.level > 0 && !grants.includes(s.name)).map(s => s.name);
    requirePicks(choices.cantrips || [], p.cantrips, available.filter(s => !s.level).map(s => s.name), 'class cantrips', old.cantrips || []);
    requirePicks(choices.prepared || [], p.prepared, spellNames, 'class prepared spells (always-prepared spells are extra)', (old.prepared || []).filter(n => !grants.includes(n)));
    let book = old.spellbook || old.prepared || [];
    if (klass.name === 'Wizard') {
      const newSpells = choices.newSpells || [];
      requirePicks(newSpells, 2, spellNames.filter(n => !book.includes(n)), 'new spellbook spells');
      book = unique([...book, ...newSpells]);
      if (choices.prepared.some(n => !book.includes(n))) throw new Error('Prepared Wizard spells must be in the spellbook, including the two newly learned spells.');
    }
    const ability = klass.spellcasting.ability;
    next.spellcasting = { ...old, ability, dc: 8 + pb + mod(next.abilities[ability]), attackBonus: pb + mod(next.abilities[ability]),
      cantrips: [...choices.cantrips], prepared: [...choices.prepared], alwaysPrepared: grants,
      ...(klass.name === 'Wizard' ? { spellbook: book } : {}),
      slots: Object.fromEntries(Object.entries(p.slots).map(([l, max]) => [l, { max, used: Math.min(
        klass.spellcasting.progression === 'pact' ? Object.values(old.slots || {}).reduce((n, s) => n + (Number(s.used) || 0), 0) : old.slots?.[l]?.used || 0, max) }])) };
    const names = unique([...choices.cantrips, ...choices.prepared, ...book, ...grants]);
    next.spellDetails = unique([...(next.spellDetails || []).map(s => s.name), ...names]).map(n => library.spells.find(s => s.name === n) || next.spellDetails?.find(s => s.name === n)).filter(Boolean).map(s => ({ ...s }));
  }
  next.advancement ??= { log: [] }; next.advancement.log ??= [];
  const changes = { from, to, hpGain, retroactive, proficiency: [oldPb, pb], features: added, subclass: next.klass.subclass,
    abilities: Object.fromEntries(ABILITIES.filter(a => next.abilities[a] !== oldAbs[a]).map(a => [a, [oldAbs[a], next.abilities[a]]])), spells: next.spellcasting?.slots || {} };
  next.advancement.log = [...next.advancement.log, { ...changes, at: new Date().toISOString(), choices: structuredClone(choices) }].slice(-40);
  return { data: next, changes };
}
