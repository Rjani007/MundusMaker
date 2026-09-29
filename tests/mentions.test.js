'use strict';
// Unlinked mentions (1.9): whole-name matches with case, plural and
// possessive handling; links and images are never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

test('mentions match the whole name in any case, and keep the words readers see', async () => {
  const { mentionMatcher } = await load('markdown.js');
  const m = mentionMatcher('Port Vellen');
  assert.equal(m.find('We sailed to Port Vellen at dawn.').count, 1);
  assert.equal(m.link('We sailed to Port Vellen at dawn.'), 'We sailed to [[Port Vellen]] at dawn.');
  assert.equal(m.link('the port vellen docks'), 'the [[Port Vellen|port vellen]] docks');
  assert.equal(m.link("Port Vellen's harbor"), "[[Port Vellen]]'s harbor");
  assert.equal(m.link('Port Vellen’s harbor'), '[[Port Vellen]]’s harbor');
  assert.equal(m.find('Port Vellenwick and Old Port Vellenia').count, 0, 'a longer word is not a mention');
});

test('plurals link to the entry with their own wording', async () => {
  const { mentionMatcher } = await load('markdown.js');
  assert.equal(mentionMatcher('Ghoul').link('Three ghouls and a Ghoul.'), 'Three [[Ghoul|ghouls]] and a [[Ghoul]].');
  assert.equal(mentionMatcher('Fox').link('The foxes ran.'), 'The [[Fox|foxes]] ran.');
});

test('existing links, aliases and images are left alone', async () => {
  const { mentionMatcher } = await load('markdown.js');
  const m = mentionMatcher('Mara');
  const text = 'Ask [[Mara]] or [[Captain Mara|the captain]]. ![Mara at sea](/assets/w/mara.png) Mara waved.';
  assert.equal(m.find(text).count, 1);
  assert.equal(m.link(text), 'Ask [[Mara]] or [[Captain Mara|the captain]]. ![Mara at sea](/assets/w/mara.png) [[Mara]] waved.');
  assert.match(m.find(text).snippet, /Mara waved/);
});

test('the party panel reads each system’s sheet as it is now', async () => {
  const { partyStats } = await load('partycore.js');
  const dnd = { blocks: [{ kind: 'sheet', system: 'dnd2024', data: { klass: { level: 5 }, abilities: { dex: 14, wis: 12 }, skills: [{ key: 'Perception', prof: 'prof' }], ac: 15, hp: { current: 21, max: 27, temp: 3 }, spellcasting: { dc: 15 } } }] };
  const stats = Object.fromEntries(partyStats(dnd).stats);
  assert.deepEqual([stats.AC, stats.HP, stats['Passive Perception'], stats['Spell save DC']], [15, '21/27 +3', 14, 15]);
  dnd.blocks[0].data.klass.level = 9; // a level-up raises the proficiency bonus
  assert.equal(Object.fromEntries(partyStats(dnd).stats)['Passive Perception'], 15);
  const v5 = { blocks: [{ kind: 'sheet', system: 'vtm5', data: { attributes: { stamina: 2, composure: 3, resolve: 2 }, health: { superficial: 2, aggravated: 1 }, willpower: { superficial: 1 }, hunger: 3, humanity: 6 } }] };
  assert.deepEqual(partyStats(v5).stats, [['Hunger', 3], ['Health', '2/5'], ['Willpower', '4/5'], ['Humanity', 6]]);
  const coc = { blocks: [{ kind: 'sheet', system: 'coc7', data: { hp: { current: 9, max: 11 }, san: { current: 57 }, mp: { current: 12, max: 12 }, luck: 55 } }] };
  assert.deepEqual(partyStats(coc).stats, [['HP', '9/11'], ['SAN', 57], ['MP', '12/12'], ['Luck', 55]]);
  assert.equal(partyStats({ blocks: [{ kind: 'text', text: 'x' }] }), null);
});

test('names with regex characters and very short names', async () => {
  const { mentionMatcher } = await load('markdown.js');
  assert.equal(mentionMatcher('Io'), null, 'two-letter names match too much ordinary text');
  assert.equal(mentionMatcher('Dr. (Ames)').link('Call Dr. (Ames) now'), 'Call [[Dr. (Ames)]] now');
  assert.equal(mentionMatcher('Élodie').link('élodie arrived'), '[[Élodie|élodie]] arrived');
});
