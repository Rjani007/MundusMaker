// Local, editable reference templates. Provenance identifies a copy; secrecy
// still comes exclusively from the ordinary entity/block flags.
export const REFERENCE_SYSTEMS = [
  { id: 'dnd2024', label: 'D&D 2024', short: 'D&D', note: 'SRD 5.2.1 reminders, including the 2024 conditions.' },
  { id: 'vtm5', label: 'Vampire: The Masquerade V5', short: 'V5', note: 'Original mechanical reminders for fifth edition; add your chronicle’s rulings to your copies.' },
  { id: 'coc7', label: 'Call of Cthulhu 7e', short: 'CoC', note: 'Original Keeper reminders for seventh edition; edit your copies for optional rules.' },
];
const SRD = 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf';
const V5 = 'https://roll20.net/compendium/vtm/';
const COC = 'https://cthulhuwiki.chaosium.com/rules/';
const notices = {
  dnd2024: 'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode. These reminders are condensed and reworded.',
  vtm5: 'Unofficial fan reference. Original summaries, not reproduced rulebook text. Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. For more information please visit worldofdarkness.com.',
  coc7: 'Unofficial fan reference. Call of Cthulhu is a trademark of Chaosium Inc. Original summaries, not reproduced rulebook text. This material is free; we are expressly prohibited from charging you to use or access this content.',
};
function ref(system, key, title, topic, description, text, source, sourceTitle) {
  return { id: `${system}-${key}`, version: 1, system, title, topic, description, text: text.trim(), source, sourceTitle, notice: notices[system] };
}
const dnd = (key, title, topic, description, text) => ref('dnd2024', key, title, topic, description, text, SRD, 'SRD 5.2.1');
const vampire = (key, title, topic, description, text, source) => ref('vtm5', key, title, topic, description, text, V5 + source, 'V5 Free Basic Rules');
const cthulhu = (key, title, topic, description, text, source) => ref('coc7', key, title, topic, description, text, COC + source, 'Chaosium’s Call of Cthulhu rules');

const conditions = [
  ['Blinded', 'Sight-dependent ability checks fail. Your attack rolls have Disadvantage; attacks against you have Advantage.'],
  ['Charmed', 'You cannot attack the charmer or target them with harmful abilities or magical effects. The charmer has Advantage on ability checks to interact socially with you. This does not grant control of your decisions.'],
  ['Deafened', 'You cannot hear; ability checks requiring hearing fail.'],
  ['Exhaustion', 'Track levels cumulatively. Subtract twice your Exhaustion level from every D20 Test. Reduce Speed by 5 feet per level. Level 6 causes death. A completed Long Rest removes one level. This is the 2024 rule.'],
  ['Frightened', 'Ability checks and attack rolls have Disadvantage while the source of fear is in sight. You cannot willingly move closer to that source.'],
  ['Grappled', 'Speed becomes 0 and cannot increase. Attack rolls against creatures other than your grappler have Disadvantage. The grappler can drag or carry you; moving costs them an extra foot per foot unless you are Tiny or at least two sizes smaller. Use the effect’s escape DC.'],
  ['Incapacitated', 'You cannot take actions, Bonus Actions or Reactions, cannot speak, and lose Concentration. If Incapacitated when rolling Initiative, roll with Disadvantage.'],
  ['Invisible', 'You have Advantage on Initiative. Effects requiring their target to be seen cannot target you, unless their creator can see you. Your attacks have Advantage and attacks against you have Disadvantage, except against a creature that can see you. Invisibility does not make you silent.'],
  ['Paralyzed', 'You are Incapacitated. Speed becomes 0 and cannot increase. Strength and Dexterity saves fail. Attacks against you have Advantage; any attack that hits from within 5 feet is a Critical Hit.'],
  ['Petrified', 'You and your nonmagical worn/carried objects become solid material; weight increases tenfold and aging stops. You are Incapacitated, unaware of your surroundings, and have Speed 0. Strength and Dexterity saves fail. Attacks against you have Advantage. You have Resistance to all damage and Immunity to Poison damage and the Poisoned condition.'],
  ['Poisoned', 'Attack rolls and ability checks have Disadvantage. Poisoned alone does not impose Disadvantage on saving throws.'],
  ['Prone', 'Movement is crawling, or spend half your Speed (round down) to stand. You cannot stand with Speed 0. Your attack rolls have Disadvantage. Attacks against you have Advantage from within 5 feet and Disadvantage from farther away.'],
  ['Restrained', 'Speed becomes 0 and cannot increase. Your attacks have Disadvantage; attacks against you have Advantage. Dexterity saves have Disadvantage.'],
  ['Stunned', 'You are Incapacitated. Strength and Dexterity saves fail. Attacks against you have Advantage. Stunned itself does not reduce Speed to 0 in the 2024 rules.'],
  ['Unconscious', 'You are Incapacitated, unaware of your surroundings, drop held objects, and fall Prone. Speed becomes 0 and cannot increase. Strength and Dexterity saves fail. Attacks against you have Advantage; hits from within 5 feet are Critical Hits.'],
];

export const DM_REFERENCES = [
  dnd('abilities', 'Abilities & skills', 'Checks', 'The six abilities, all eighteen skills, and proficiency.', `
**Strength:** Athletics — force, climbing and swimming.
**Dexterity:** Acrobatics, Sleight of Hand, Stealth — balance, precision and concealment.
**Constitution:** endurance; no associated skill.
**Intelligence:** Arcana, History, Investigation, Nature, Religion — knowledge and deduction.
**Wisdom:** Animal Handling, Insight, Medicine, Perception, Survival — awareness and judgment.
**Charisma:** Deception, Intimidation, Performance, Persuasion — influence and expression.

Ability modifier = floor((score − 10) / 2). Add proficiency once when trained; Expertise doubles that bonus. The GM can pair a skill with a different ability when the approach warrants it, such as Strength (Intimidation).`),
  dnd('tests', 'D20 tests & difficulty', 'Checks', 'DCs, advantage, passive perception and proficiency by level.', `
Roll a d20 + the relevant ability modifier + proficiency if applicable. Meet or exceed the DC (or AC for attacks).

**Typical DCs:** 5 very easy · 10 easy · 15 moderate · 20 hard · 25 very hard · 30 nearly impossible.
**Advantage / Disadvantage:** roll two d20s and keep the higher / lower. Multiple sources do not add dice. Any mixture cancels to one d20.
**Proficiency:** levels 1–4: +2; 5–8: +3; 9–12: +4; 13–16: +5; 17–20: +6.
**Passive Perception:** 10 + Wisdom (Perception) modifier; +5 with Advantage, −5 with Disadvantage.
**Natural 1 / 20:** attacks automatically miss / hit; a 20 is a Critical Hit. These are not automatic outcomes on ordinary ability checks or saves.`),
  dnd('turn', 'Turn & action options', 'Combat', 'Movement, actions, bonus actions, reactions and common choices.', `
On your turn: move up to your Speed and take one action. Split movement around actions or attacks. Take a Bonus Action only when an ability grants one. After using a Reaction, regain it at the start of your next turn.

**Attack:** attack with a weapon or Unarmed Strike.
**Dash:** gain extra movement equal to your Speed for this turn.
**Disengage:** your movement avoids Opportunity Attacks this turn.
**Dodge:** attacks from creatures you see have Disadvantage; Dexterity saves have Advantage until your next turn. Ends if Incapacitated or Speed is 0.
**Help:** assist an ability check using your proficiency, or distract a foe within 5 feet for an ally’s next attack before your next turn.
**Hide / Search / Study:** conceal yourself, notice something, or recall/deduce information.
**Influence:** try to alter a creature’s attitude or decision.
**Magic / Utilize:** cast/use magic, or use a nonmagical object.
**Ready:** specify a perceivable trigger and action or movement; spend your Reaction just after the trigger. Readying a spell takes Concentration and expends its slot when readied.`),
  dnd('attacks', 'Attacks, cover & movement', 'Combat', 'Critical damage, ranged attacks, cover and opportunity attacks.', `
**Critical Hit:** roll the attack’s damage dice twice; add fixed modifiers once.
**Cover:** half cover gives +2 AC and Dexterity saves; three-quarters gives +5. Total cover prevents direct targeting. Use the strongest applicable cover.
**Ranged attacks:** beyond normal range gives Disadvantage; beyond long range cannot hit. A visible, non-Incapacitated enemy within 5 feet imposes Disadvantage on your ranged attacks.
**Opportunity Attack:** when a creature you can see leaves your reach using its movement, action, Bonus Action or Reaction, you can spend your Reaction for one melee attack before it leaves. Teleportation and being moved without those costs do not provoke.
**Difficult terrain:** each foot costs an extra foot. Crawling, climbing and swimming also usually cost extra movement; an applicable climb/swim Speed avoids that activity’s extra cost.`),
  dnd('concentration', 'Spellcasting & concentration', 'Magic', 'Spell DCs, components, slots and concentration saves.', `
**Spell attack:** ability modifier + proficiency. **Spell save DC:** 8 + ability modifier + proficiency.
**Before casting:** check casting time, range, valid target, components and available slot. Only one spell slot can be expended to cast spells on a turn. A Reaction on another creature’s turn is a different turn.
**Components:** verbal requires speaking; somatic needs a hand; material needs the component or an allowed focus. A priced or consumed component must be supplied as specified.
**Concentration:** only one effect at a time. Starting another breaks the first. Each instance of damage calls for a Constitution save: DC 10 or half the damage (round down), whichever is higher, capped at 30. Incapacitation or death ends Concentration; you may also end it freely.
**Ritual:** an eligible prepared ritual spell takes 10 extra minutes and uses no slot. Follow any feature that grants a different ritual option.`),
  dnd('health', 'Damage, healing & death saves', 'Combat', 'Resistance, temporary HP, zero HP and stabilization.', `
**Resistance / Vulnerability:** halve / double the relevant damage; round down when dividing. Multiple copies of the same protection do not stack. Apply damage adjustments, then Resistance, then Vulnerability.
**Temporary HP:** absorb damage first, do not stack, and do not restore consciousness at 0 HP. Choose whether to keep existing temporary HP or a new grant.
**0 HP:** normally fall Unconscious and begin death saves. Leftover damage at least equal to your maximum HP kills outright.
**Death save:** at the start of your turn, an unmodified d20; 10+ succeeds. Three successes stabilize; three failures kill. A natural 1 adds two failures; a natural 20 restores 1 HP. Damage at 0 HP adds one failure, or two for a Critical Hit.
**Stabilize:** Help action + DC 10 Wisdom (Medicine), or a suitable feature/item. Stable creatures stop rolling, remain at 0 HP, and regain 1 HP after 1d4 hours if not healed sooner. Taking damage ends stability. Healing or becoming stable resets death-save counts.`),
  dnd('rest', 'Rests & recovery', 'Exploration', 'Short and long rests under the 2024 rules.', `
**Short Rest:** at least 1 hour of downtime; start with at least 1 HP. You may spend Hit Point Dice one at a time, rolling each + Constitution modifier (minimum 1 HP per die). Recover features that specify a Short Rest.
**Long Rest:** at least 8 hours, including at least 6 hours asleep and at most 2 hours of light activity, unless a feature changes this. Start with at least 1 HP. Regain all HP and all spent Hit Point Dice, restore reduced ability scores and HP maximum, and remove one Exhaustion level. Recover Long Rest features.
You cannot benefit from another Long Rest until 16 hours after finishing one. For interruptions, apply the Long Rest rules: a qualifying interruption may require another hour, and a rest already lasting at least an hour can provide Short Rest benefits.`),
  dnd('exploration', 'Light, travel & hazards', 'Exploration', 'Visibility, daily pace, falling and holding breath.', `
**Light:** dim light lightly obscures, imposing Disadvantage on sight-based Wisdom (Perception) checks. Darkness heavily obscures; seeing into it is treated as Blinded. Darkvision treats darkness as dim light within its range, without color.
**Travel per hour / day:** slow 2 / 18 miles, normal 3 / 24, fast 4 / 30. Slow pace helps Stealth; fast pace hinders Perception and Survival. Terrain can limit pace.
**Falling:** 1d6 Bludgeoning per 10 feet, maximum 20d6; land Prone unless you avoid all falling damage.
**Holding breath:** 1 + Constitution modifier minutes, minimum 30 seconds. After breath runs out, suffocation gives one Exhaustion level at each turn’s end. Breathing again removes Exhaustion gained this way.`),
  ...conditions.map(([name, text]) => dnd(`condition-${name.toLowerCase()}`, name, 'Conditions', `${name}: effects and reminders.`, `**${name} (2024)**\n\n${text}\n\nCheck the effect that applied this condition for its duration and how it ends.${name === 'Exhaustion' ? '' : ' Repeated instances of this condition do not stack; track their durations separately.'}`)),
  vampire('tests', 'Dice pools & successes', 'Tests', 'Build a pool, count successes, and judge the margin.', `
Agree on the goal and the Attribute + Skill before rolling. Use that many ten-sided dice, with Hunger dice replacing part of the pool where applicable.

Each die showing 6–10 contributes one success. Each pair of 10s contributes four successes in total. Meet the Storyteller’s Difficulty to succeed; successes beyond it are the margin.

An applicable specialty adds one die. Use the V5 sheet’s pool roller so successes and Hunger results are counted correctly; the Quick dice box adds die faces instead.`, 'Rules%3ABasic%20rolls?expansion=0'),
  vampire('hunger', 'Hunger & Rouse checks', 'Blood', 'Hunger replacement, blood costs and the one-die Rouse check.', `
Hunger runs from 0 to 5. In an affected pool, replace ordinary dice with Hunger dice equal to Hunger, limited by the pool’s size. Do not add extra dice to the pool.

For a Rouse check, roll one ordinary ten-sided die: 6+ leaves Hunger unchanged; 1–5 raises it by one. Failure does not cancel the power or action that required the check. At Hunger 5, use the rules for refusing voluntary Rouse checks and involuntary checks/frenzy rather than recording Hunger 6.

Rouse checks and Willpower/Humanity tracker pools do not include Hunger dice. Consult your character’s Blood Potency for applicable Blood Surge, mending and Rouse rerolls.`, 'Rules%3ARouse%20checks%20and%20using%20the%20Blood?expansion=0'),
  vampire('critical', 'Messy criticals & bestial failures', 'Tests', 'Spot when the Beast changes a roll’s outcome.', `
**Critical:** pairs of 10s count four successes per pair.
**Messy critical:** a successful critical includes a 10 on a Hunger die. Resolve the success and its bestial complication together.
**Bestial failure:** the test fails and at least one Hunger die shows 1. Apply the appropriate Beast-driven consequence.

A Hunger 1 on a successful ordinary test is not a bestial failure. A Hunger 10 without another 10 is not a critical. Decide consequences from the scene and your chronicle; do not confuse an ordinary failed Rouse check with either result.`, 'Rules%3AMessy%20criticals?expansion=0'),
  vampire('willpower', 'Willpower & rerolls', 'Tests', 'Reroll up to three ordinary dice without changing Hunger dice.', `
Spend one Willpower, marking one point of Superficial Willpower damage, to reroll up to three ordinary dice in a pool. Hunger dice cannot be selected. Keep the rerolled results.

Choose the dice after looking at the roll: changing an ordinary 10 can remove a messy critical; gaining enough successes can avoid a bestial failure. Track the cost even when the new result is worse.

Maximum Willpower is Composure + Resolve. Use your chronicle’s recovery rules between scenes and sessions; the free introductory scenario’s no-recovery restriction is not a general rule for campaigns.`, 'Willpower'),
  vampire('conflict', 'Conflict & damage', 'Conflict', 'Intent, opposed pools, margins and damage tracks.', `
Establish what each side wants and whether they are attacking or avoiding harm. Roll the appropriate opposed pools; the side with more successes wins, with the margin measuring the difference. Apply the attack’s weapon modifier when calculating damage.

Keep Health and Willpower damage separate. Mark Superficial damage with a slash and Aggravated damage with an X. Vampires halve Superficial damage before recording it, rounding up. Check the source of damage: fire and sunlight are especially dangerous to vampires.

When a track fills, check Impairment; further damage may convert Superficial damage to Aggravated. Use the specific healing and defeat rules for that track and creature.`, '00%20START%20HERE%3AFree%20Basic%20Rules?expansion=0'),
  vampire('attributes', 'Attributes & skills', 'Characters', 'Physical, social and mental pools at a glance.', `
**Physical attributes:** Strength, Dexterity, Stamina.
**Social attributes:** Charisma, Manipulation, Composure.
**Mental attributes:** Intelligence, Wits, Resolve.

**Physical skills:** Athletics, Brawl, Craft, Drive, Firearms, Larceny, Melee, Stealth, Survival.
**Social skills:** Animal Ken, Etiquette, Insight, Intimidation, Leadership, Performance, Persuasion, Streetwise, Subterfuge.
**Mental skills:** Academics, Awareness, Finance, Investigation, Medicine, Occult, Politics, Science, Technology.

Pick the Attribute for the approach, not just the skill’s column. Examples: a careful evidence search might use Intelligence + Investigation; noticing a sudden threat might use Wits + Awareness.

**Health:** Stamina + 3. **Willpower:** Composure + Resolve.`, 'Rules%3ABasic%20rolls?expansion=0'),
  cthulhu('tests', 'Percentile tests & opposed rolls', 'Tests', 'Regular, Hard and Extreme thresholds; pushed rolls.', `
Roll at or below the relevant value: full value for Regular, half (round down) for Hard, one-fifth (round down) for Extreme.

For opposed rolls, compare success levels first; a tie goes to the higher skill value. If those are equal, roll off, lowest winning. Combat has its own tie rules.

A pushed skill roll needs a changed or renewed approach and a stated consequence for failure. Agree the stakes before rerolling. Combat rolls cannot be pushed.`, 'game-system.html'),
  cthulhu('bonus', 'Bonus, penalty & Luck dice', 'Tests', 'Extra tens dice and reading 00 correctly.', `
Keep one units die; roll an extra tens die for each bonus or penalty die. A bonus chooses the lowest complete result; a penalty chooses the highest. Opposing bonus and penalty dice cancel.

00 tens + 0 units means 100, not zero. 00 tens + 7 units means 7.

A Luck test rolls at or below current Luck. For a group Luck test, use the lowest Luck among the investigators present. Optional Luck spending is a separate rule.`, 'game-system.html'),
  cthulhu('combat', 'Combat & defensive choices', 'Combat', 'DEX order, fighting back, dodging and firearms.', `
Act in descending DEX order. A readied firearm acts at DEX +50 for initiative. A round gives everyone a significant action; combat rolls cannot be pushed.

**Fight back:** compare Fighting success levels. The defender must do better; equal successful levels favor the attacker.
**Dodge:** the attacker must do better than the defender’s Dodge success level. A successful tied Dodge avoids the hit. If both sides fail, neither deals damage.
**Firearms:** use Firearms. Point-blank distance (DEX / 5 in feet) grants a bonus die. Diving for cover uses Dodge; success gives the shooter a penalty die, and the defender forfeits their next attack either way.

Extreme attacks can deal extra damage; fighting back deals ordinary damage. Check the weapon’s impaling and damage-bonus rules.`, 'combat.html'),
  cthulhu('wounds', 'Wounds & healing', 'Combat', 'Major wounds, zero HP, First Aid and Medicine.', `
Subtract damage from HP; do not record negative HP. A single injury of at least half maximum HP is a Major Wound: test CON to remain conscious. Damage from one injury at least equal to maximum HP kills outright.

At 0 HP, fall unconscious. With a Major Wound you are also dying: make CON checks from the end of the following round, then every round, until stabilized or dead.

First Aid restores 1 HP and can stabilize a dying investigator temporarily; Medicine is still needed. Medicine restores 1d3 HP and requires time and supplies. Without a Major Wound, ordinary recovery is 1 HP per day; a Major Wound uses weekly CON recovery checks.`, 'hit-points-wounds-and-healing.html'),
  cthulhu('sanity', 'Sanity checks & sudden losses', 'Horror', 'Read SAN loss notation and handle a five-point shock.', `
Roll against current SAN. In a loss written A/B, lose A on success and B on failure. Record the loss immediately. A failed check can also produce a brief involuntary reaction directed by the Keeper.

Losing 5 or more SAN from one check calls for INT: success means the investigator comprehends the horror and suffers temporary insanity for 1d10 hours, beginning with a bout of madness. A failed INT check avoids that immediate result.

Track cumulative daily losses too and consult the full rules for indefinite insanity. Agree how to portray horror with the player; SAN is a fictional horror mechanic, not a model of real mental illness.`, 'sanity.html'),
  cthulhu('development', 'Investigator development', 'Characters', 'Checked skills and improvement between adventures.', `
Mark skills successfully used during play, once per skill. At a Keeper-approved development phase, roll percentile dice for each eligible checked skill: a result above its current value allows a 1d10 increase. Then clear the check.

MundusMaker’s development editor also applies the full-rule 96+ improvement exception, skips Cthulhu Mythos, and caps skills at 99. Review the selected skills before applying development. Awards, recovery and backstory changes are separate decisions for the Keeper.`, 'rewards-of-success.html'),
  cthulhu('investigation', 'Investigation scene checklist', 'Prep', 'A ready-written Keeper workflow for clues and consequences.', `
**Frame the scene:** where are the investigators, what can they immediately perceive, and what is changing?
**Ask for an approach:** searching a desk, interviewing a witness and consulting records suggest different skills.
**Separate discovery from danger:** decide which clues follow from looking in the right place and which uncertain actions deserve a roll.
**Before a roll:** state the objective, required success level, time cost and consequences.
**Afterward:** describe what changed and offer a concrete lead, decision or complication. Keep a note of what the investigators know separately from what the antagonists know.

This is an editable preparation checklist, not an additional game rule.`, ''),
];

export function referenceMatches(reference, { system = '', topic = '', query = '' } = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [reference.title, reference.description, reference.topic, reference.text].join(' ').toLowerCase();
  return (!system || reference.system === system) && (!topic || reference.topic === topic) && terms.every(term => haystack.includes(term));
}

export function referenceCopy(reference, makeEntity, makeId) {
  if (!DM_REFERENCES.includes(reference)) throw new Error('Unknown reference');
  const system = REFERENCE_SYSTEMS.find(s => s.id === reference.system);
  const entry = makeEntity(`${system.short} · ${reference.title}`, 'note');
  entry.gmOnly = true;
  entry.tags = ['rules-reference', reference.system, reference.topic.toLowerCase()];
  entry.referenceTemplate = { id: reference.id, version: reference.version };
  entry.fields = { System: system.label, Topic: reference.topic };
  entry.blocks = [
    { id: makeId(), kind: 'text', text: reference.text, secret: false },
    { id: makeId(), kind: 'text', text: `[${reference.sourceTitle}](${reference.source})\n\n${reference.notice}`, secret: false },
  ];
  return entry;
}

export function existingReference(entries, referenceId, pins = []) {
  const copies = entries.filter(e => e.referenceTemplate?.id === referenceId);
  return copies.find(e => pins.includes(e.id)) || copies[0] || null;
}
