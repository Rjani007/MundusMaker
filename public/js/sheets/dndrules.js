// Pure D&D character math shared by creation, advancement and print.
export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const SKILLS = [
  ['Acrobatics', 'dex'], ['Animal Handling', 'wis'], ['Arcana', 'int'], ['Athletics', 'str'],
  ['Deception', 'cha'], ['History', 'int'], ['Insight', 'wis'], ['Intimidation', 'cha'],
  ['Investigation', 'int'], ['Medicine', 'wis'], ['Nature', 'int'], ['Perception', 'wis'],
  ['Performance', 'cha'], ['Persuasion', 'cha'], ['Religion', 'int'], ['Sleight of Hand', 'dex'],
  ['Stealth', 'dex'], ['Survival', 'wis'],
];
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const mod = (score) => Math.floor((score ?? 10) / 2) - 5;
export const fmtMod = (m) => (m >= 0 ? `+${m}` : String(m));
export const profBonus = (level) => 2 + Math.floor(((level || 1) - 1) / 4);
export function passivePerception(d, pb) {
  return 10 + skillBonus(d, 'Perception', pb);
}

export function skillBonus(d, name, pb = profBonus(d.klass?.level)) {
  const ability = SKILLS.find(([n]) => n === name)?.[1];
  const entry = (d.skills || []).find(s => s.key === name);
  const half = !entry && (d.features || []).some(f => String(f.name).toLowerCase() === 'jack of all trades');
  return mod(d.abilities?.[ability]) + (entry ? pb * (entry.prof === 'expert' ? 2 : 1) : half ? Math.floor(pb / 2) : 0);
}

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
    deathSaves: { success: 0, failure: 0 },
    attacks: [], equipment: [], coins: { gp: 0, sp: 0, cp: 0 },
    spellcasting: null,
    features: [], personality: { traits: '', ideals: '', bonds: '', flaws: '' },
    advancement: { log: [] },
    notes: '',
  };
}

export const lower = s => String(s || '').trim().toLowerCase();
export const canonSkill = s => SKILLS.find(([n]) => lower(n) === lower(s))?.[0] || String(s);
export const unique = values => [...new Set(values || [])];
export const trainingName = s => ({ anyGamingSet: 'Gaming set of your choice', anyMusicalInstrument: 'Musical instrument of your choice', anyArtisansTool: "Artisan’s tools of your choice" })[s] || String(s).replace(/([a-z])([A-Z])/g, '$1 $2');
export const sourceLabel = item => [item?._pack || 'SRD 5.2', item?._source].filter(Boolean).join(' · ');
export const isAvailable = (item, draft) => !(draft.excludedSources || []).includes(item?._pack || 'SRD 5.2');

export function finalAbilities(draft) {
  const out = Object.fromEntries(ABILITIES.map(a => [a, Number(draft.abilities?.[a] ?? 8)]));
  const bonus = draft.bgBonus;
  if (bonus?.mode === '1+1+1') for (const a of unique(bonus.three)) { if (ABILITIES.includes(a)) out[a]++; }
  else if (bonus) {
    if (ABILITIES.includes(bonus.two)) out[bonus.two] += 2;
    if (ABILITIES.includes(bonus.one)) out[bonus.one]++;
  }
  return out;
}

export function recommendedAbilities(klass) {
  const primary = klass?.primaryAbility || [klass?.spellcasting?.ability || 'str'];
  const order = unique([...primary, 'con', 'dex', 'wis', ...ABILITIES]).filter(a => ABILITIES.includes(a));
  return Object.fromEntries(order.map((a, i) => [a, STANDARD_ARRAY[i]]));
}

export function validateAbilities(draft) {
  const vals = ABILITIES.map(a => draft.abilities?.[a]);
  if (vals.some(n => !Number.isInteger(n))) return 'Enter a whole number for every ability.';
  if (draft.abilityMethod === 'standard' && !STANDARD_ARRAY.every(n => vals.includes(n))) return 'Use each standard-array score exactly once.';
  if (draft.abilityMethod === 'pointbuy') {
    if (vals.some(n => POINT_BUY_COST[n] == null)) return 'Point-buy scores must be whole numbers from 8 to 15.';
    const spent = vals.reduce((n, v) => n + POINT_BUY_COST[v], 0);
    if (spent !== 27) return `Spend exactly 27 points (${spent} spent).`;
  }
  if (!['standard', 'pointbuy', 'roll', 'manual'].includes(draft.abilityMethod)) return 'Choose an ability method.';
  if (vals.some(n => n < 3 || n > 18)) return 'Starting ability scores must be between 3 and 18 before bonuses.';
  return null;
}

export function validateBackground(draft) {
  if (!draft.background) return 'Choose a background.';
  const allowed = draft.background.abilities?.length ? draft.background.abilities : ABILITIES;
  const b = draft.bgBonus;
  if (!b) return 'Assign your background ability increases.';
  if (b.mode === '2+1') {
    if (b.two === b.one || !allowed.includes(b.two) || !allowed.includes(b.one)) return 'Assign +2 and +1 to two different allowed abilities.';
  } else if (b.mode === '1+1+1') {
    if (unique(b.three).length !== 3 || b.three.some(a => !allowed.includes(a))) return 'Choose three different allowed abilities for +1 each.';
  } else return 'Choose an ability increase method.';
  if (Object.values(finalAbilities(draft)).some(n => n > 20)) return 'Background increases cannot raise an ability above 20.';
  return null;
}

export function classSkills(klass) {
  return unique((klass?.skills?.from?.length ? klass.skills.from : SKILLS.map(([n]) => n)).map(canonSkill));
}

// Metadata is copied from SRD-filtered class tables or the user's local packs.
// Unknown imported progression stays explicit; never guess a full-caster table.
export function spellProgression(klass, level) {
  const p = klass?.progression || klass || {};
  const row = Math.max(0, Math.min(19, level - 1));
  const tables = p.classTableGroups || [];
  let slots = null;
  for (const table of tables) {
    const counts = table.rowsSpellProgression?.[row];
    if (counts) slots = Object.fromEntries(counts.map((n, i) => [i + 1, Number(n) || 0]).filter(([, n]) => n > 0));
    const labels = (table.colLabels || []).map(lower);
    const slotCol = labels.indexOf('spell slots'), levelCol = labels.indexOf('slot level');
    if (slotCol >= 0 && levelCol >= 0 && table.rows?.[row]) {
      const values = table.rows[row]; slots = { [Number(values[levelCol])]: Number(values[slotCol]) };
    }
  }
  const casting = Boolean(klass?.spellcasting || p.casterProgression);
  if (!casting) return { cantrips: 0, prepared: 0, slots: {}, maxLevel: 0, supported: true };
  const cantrips = p.cantripProgression?.[row] ?? 0;
  const prepared = p.preparedSpellsProgression?.[row] ?? p.spellsKnownProgression?.[row];
  return { cantrips: Number(cantrips), prepared: prepared == null ? null : Number(prepared), slots,
    maxLevel: slots ? Math.max(0, ...Object.keys(slots).map(Number)) : 0, supported: slots !== null && prepared != null };
}

export function availableSpells(data, klass, maxLevel, draft = {}) {
  return (data.spells || []).filter(s => isAvailable(s, draft) && s.level <= maxLevel &&
    ((s.classes || []).some(c => lower(c) === lower(klass?.name)) || (!s.classes?.length && s._pack)));
}

export function classGrantedSpells(klass, level) {
  if (klass.name === 'Ranger' && level >= 1) return ["Hunter's Mark"];
  if (klass.name === 'Paladin' && level >= 5) return ['Find Steed'];
  return [];
}

export function equipmentChoices(text) {
  const value = String(text || '').replace(/^.*?Equipment:\.?\s*/i, '').trim();
  const matches = [...value.matchAll(/\(([A-Z])\)\s*([\s\S]*?)(?=\([A-Z]\)|$)/g)];
  if (!matches.length) return value ? [{ key: 'A', text: value }] : [];
  return matches.map(m => ({ key: m[1], text: m[2].replace(/(?:;?\s*(?:or|and)\s*)?;?\s*$/i, '').trim() }));
}

export function parseEquipment(text, catalog = []) {
  let gp = 0;
  const items = String(text || '').split(/\n|,(?![^()]*\))|;/).map(s => s.replace(/^\s*(?:and\s+|[-•])?\s*/i, '').trim()).filter(Boolean).flatMap(s => {
    if (/^\d+\s*gp$/i.test(s)) { gp += Number(s.match(/^\d+/)[0]); return []; }
    const match = s.match(/^(\d+)\s+(.+)$/), qty = match ? Number(match[1]) : 1;
    const name = match ? match[2] : s;
    const item = catalog.find(e => lower(e.name) === lower(name)) || catalog.find(e =>
      [lower(e.name) + 's', lower(e.name).replace(/y$/, 'ies')].includes(lower(name)));
    return [{ ...(item || {}), name: item?.name || name, qty }];
  });
  return { items, gp };
}

export function armorClass(abilities, klass, armor, shield = false, features = []) {
  const dex = mod(abilities.dex);
  let ac = 10 + dex;
  if (!armor) {
    if (lower(klass?.name) === 'barbarian') ac += mod(abilities.con);
    if (lower(klass?.name) === 'monk' && !shield) ac += mod(abilities.wis);
  } else {
    const kind = lower(armor.kind || armor.category);
    const heavy = kind.includes('heavy') || /^(ring mail|chain mail|splint|plate)$/i.test(armor.name);
    const medium = kind.includes('medium') || /^(hide armor|hide|chain shirt|scale mail|breastplate|half plate armor|half plate)$/i.test(armor.name);
    ac = Number(armor.ac) + (heavy ? 0 : medium ? Math.min(2, dex) : dex);
    if (features.some(f => lower(f.name) === 'defense')) ac++;
  }
  return ac + (shield ? 2 : 0);
}

export function weaponAttack(item, abilities, klass, level = 1, features = []) {
  if (!item.damage) return null;
  const props = (item.properties || []).map(p => String(p).split('|')[0]);
  const ranged = /ranged|bow|crossbow|sling|blowgun|^dart$/i.test(`${item.kind || item.category} ${item.name}`) || lower(item.name) === 'dart';
  const finesse = props.includes('F');
  const category = lower(item.weaponCategory || item.kind || item.category);
  const monkWeapon = lower(klass.name) === 'monk' && klass.martialArts !== false && !ranged && (category.includes('simple') || props.includes('L'));
  const useDex = (ranged && !finesse) || ((finesse || monkWeapon) && mod(abilities.dex) > mod(abilities.str));
  const ability = useDex ? 'dex' : 'str';
  const trained = (klass.weapons || []).some(w => {
    const proficiency = lower(w);
    if (proficiency.includes('that have')) return category.includes('martial') && ((proficiency.includes('finesse') && finesse) || (proficiency.includes('light') && props.includes('L')));
    return category.includes(proficiency.replace(/ weapons?$/, '')) || lower(item.name).includes(proficiency);
  });
  const abilityBonus = mod(abilities[ability]);
  const bonus = abilityBonus + (trained ? profBonus(level) : 0) + (ranged && features.some(f => lower(f.name) === 'archery') ? 2 : 0);
  const baseDamage = monkWeapon ? monkDamage(item.damage, level) : item.damage;
  const damage = baseDamage.replace(/^(\d+d\d+)/i, `$1${abilityBonus ? fmtMod(abilityBonus) : ''}`);
  return { name: item.name, bonus, damage, notes: [props.join(', '), (item.mastery || []).join(', ')].filter(Boolean).join(' · '),
    ability, proficient: trained, ranged, baseDamage, ...(monkWeapon ? { monkWeapon: true, weaponDamage: item.damage } : {}) };
}

export function monkDamage(damage, level) {
  const die = level >= 17 ? 12 : level >= 11 ? 10 : level >= 5 ? 8 : 6;
  return String(damage).replace(/^1d(\d+)/i, (_, sides) => `1d${Math.max(die, Number(sides))}`);
}

export function draftSkills(draft) {
  return unique([...(draft.background?.skills || []), ...(draft.backgroundSkillPicks || []), ...(draft.skillPicks || []), ...(draft.bonusSkills || [])].map(canonSkill));
}

export function originFeats(draft, data) {
  const names = [draft.background?.feat || draft.originFeat, draft.humanFeat].filter(Boolean);
  return names.map(name => {
    const feat = (data.feats || []).find(f => lower(f.name) === lower(name.split(/[;(]/)[0]));
    return { ...(feat || {}), name, source: 'Origin feat' };
  });
}

export function buildCharacter(draft, data) {
  const d = defaults(), abs = finalAbilities(draft), c = draft.klass;
  d.species = { name: draft.species.name, size: draft.size || draft.species.size, speed: draft.species.speed };
  d.klass = { name: c.name, level: 1, hitDie: c.hitDie, subclass: '', plannedSubclass: draft.subclassPick || '', source: sourceLabel(c) };
  d.background = { name: draft.background.name, feat: draft.background.feat || draft.originFeat || '' };
  d.abilities = abs; d.abilityMethod = draft.abilityMethod; d.saves = [...c.saves];
  d.skills = draftSkills(draft).map(key => ({ key, prof: (draft.expertise || []).includes(key) ? 'expert' : 'prof' }));
  d.languages = unique(['Common', ...(draft.languages || [])]);
  d.proficiencies = { armor: c.armor || [], weapons: c.weapons || [], tools: unique([...(c.tools || []), ...String(draft.background.tool || '').split(',')].map(s => s.trim()).filter(Boolean).map(trainingName)) };
  d.features = [
    ...(draft.species.traits || []).map(t => ({ ...t, source: draft.species.name })),
    ...(c.features || []).filter(f => f.level === 1).map(f => ({ name: f.name, text: f.text || '', source: `${c.name} 1` })),
    ...originFeats(draft, data),
    ...(draft.fightingStyle ? [data.feats.find(f => f.name === draft.fightingStyle)].filter(Boolean).map(f => ({ ...f, source: 'Fighting Style' })) : []),
  ];
  for (const [name, choice] of Object.entries(draft.featureChoices || {})) if (String(choice).trim()) d.features.push({ name, source: 'Character choice', text: String(choice).trim() });
  const gear = parseEquipment(draft.equipmentText, data.equipment);
  d.equipment = gear.items; d.coins.gp = Number(draft.gold ?? gear.gp);
  const armor = d.equipment.find(e => e.name === draft.armor);
  d.ac = draft.acOverride == null || draft.acOverride === '' ? armorClass(abs, c, armor, draft.shield, d.features) : Number(draft.acOverride);
  d.defense = { armor: armor ? { name: armor.name, ac: armor.ac, kind: armor.kind || armor.category } : null, shield: !!draft.shield, automatic: draft.acOverride == null || draft.acOverride === '' };
  const martialArts = !armor && !draft.shield;
  d.attacks = d.equipment.map(e => weaponAttack(e, abs, { ...c, martialArts }, 1, d.features)).filter(Boolean);
  if (c.name === 'Monk' && martialArts) d.attacks.push(weaponAttack({ name: 'Unarmed Strike', category: 'simple weapon', damage: '1d6 bludgeoning' }, abs, c));
  const hp = Math.max(1, c.hitDie + mod(abs.con)) + (lower(d.species.name) === 'dwarf' ? 1 : 0) + (d.features.some(f => lower(f.name) === 'tough') ? 2 : 0);
  d.hp = { max: hp, current: hp, temp: 0 }; d.speed = draft.species.speed;
  d.initiativeBonus = d.features.some(f => lower(f.name) === 'alert') ? 2 : 0;
  if (c.spellcasting) {
    const progression = spellProgression(c, 1), ability = c.spellcasting.ability;
    const slots = progression.slots || draft.customSlots || {};
    d.spellcasting = { ability, dc: 10 + mod(abs[ability]), attackBonus: 2 + mod(abs[ability]),
      slots: Object.fromEntries(Object.entries(slots).map(([l, max]) => [l, { max, used: 0 }])),
      cantrips: [...(draft.cantrips || [])], prepared: [...(draft.spells || [])], spellbook: [...(draft.spellbook || [])], alwaysPrepared: classGrantedSpells(c, 1) };
  }
  d.innateSpells = (draft.innateSpells || []).map(s => ({ ...s }));
  const spellNames = unique([...(d.spellcasting?.cantrips || []), ...(d.spellcasting?.prepared || []), ...(d.spellcasting?.spellbook || []), ...(d.spellcasting?.alwaysPrepared || []), ...d.innateSpells.map(s => s.name)]);
  d.spellDetails = data.spells.filter(s => spellNames.includes(s.name)).map(s => ({ ...s }));
  d.personality = { ...d.personality, ...(draft.personality || {}) };
  d.alignment = draft.alignment || ''; d.notes = draft.notes || '';
  d.creation = { version: 2, sources: unique([draft.species, c, draft.background].map(sourceLabel)), baseAbilities: { ...draft.abilities }, backgroundBonus: structuredClone(draft.bgBonus) };
  return { name: draft.name.trim(), fields: { Role: draft.role || 'PC', Species: d.species.name, Status: 'Alive' }, data: d,
    tags: [lower(c.name), lower(draft.role || 'PC')] };
}
