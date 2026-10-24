'use strict';
// The editors only ever store numbers in a sheet's AC, hit points, ratings and
// the like, but a backup, a synced folder or a copied install can carry any
// JSON. Every value a rendered sheet shows must arrive as text, never markup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

// the sheet modules remember settings (layout choice) through localStorage
const store = new Map();
globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const P = '<b data-planted>x</b>';
function clean(html) {
  assert.doesNotMatch(html, /<b data-planted/i, 'a stored value was rendered as markup');
  assert.match(html, /&lt;b data-planted&gt;/i, 'the planted values were rendered, as text');
}

test('D&D sheets show stored values as text', async () => {
  const dnd = await load('sheets/dnd2024.js');
  const d = dnd.defaults();
  Object.assign(d, {
    ac: P, speed: P, initiativeBonus: P,
    hp: { current: P, max: P, temp: P },
    klass: { ...d.klass, hitDie: P },
    abilities: { ...d.abilities, str: P },
    coins: { gp: P, sp: P, cp: P },
    equipment: [{ name: 'Rope', qty: 2 }],
    innateSpells: [{ name: "Tasha's Hideous Laughter", source: 'Feat', ability: 'cha', uses: P }],
    spellcasting: { ability: P, dc: P, attackBonus: P, slots: {}, cantrips: [], prepared: [] },
  });
  const html = dnd.html(d);
  clean(html);
  assert.match(html, /Tasha&#39;s Hideous Laughter/, 'names are escaped once, not twice');
  assert.match(dnd.html(dnd.defaults()), /Sleight of Hand \+\d/, 'roll labels read as before');
});

test('Call of Cthulhu sheets show stored values as text', async () => {
  const coc = await load('sheets/coc7.js');
  const d = coc.defaults();
  Object.assign(d, {
    characteristics: { ...d.characteristics, STR: P },
    skills: [{ name: 'Spot Hidden', value: P, improve: true }],
    weapons: [{ name: 'Knife', skill: P, damage: '1d4' }],
    hp: { current: P, max: P }, mp: { current: P, max: P },
    luck: P, dodge: P, build: P, move: P,
    san: { current: P, start: P, max: P },
    development: { log: [{ results: [{ name: 'Spot Hidden', roll: P, before: P, improved: true, gain: P, after: P }] }] },
  });
  clean(coc.html(d));
  assert.match(coc.html({ ...coc.defaults(), skills: [{ name: 'Spot Hidden', value: 45 }] }), /Spot Hidden 45%/);
});

test('V5 sheets show stored values as text and link only web addresses', async () => {
  const v5 = await load('sheets/vtm5.js');
  const d = v5.defaults();
  Object.assign(d, {
    attributes: { ...d.attributes, stamina: P, composure: P },
    skills: { ...d.skills, Athletics: P },
    hunger: P,
    disciplines: [{ name: 'Auspex', rating: 1, powers: [
      { name: 'Heightened Senses', level: P, wikiUrl: 'javascript:alert(1)' },
      { name: 'Sense the Unseen', level: 1, wikiUrl: 'https://example.org/sense' },
    ] }],
    xp: { total: P, spent: P, ledger: [{ label: 'Auspex 2', cost: P }] },
  });
  const html = v5.html(d);
  clean(html);
  assert.doesNotMatch(html, /href="\s*javascript:/i);
  assert.match(html, /href="https:\/\/example\.org\/sense"/);
});
