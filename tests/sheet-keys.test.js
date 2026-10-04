'use strict';
// Keyboard and screen-reader access for character sheets: every clickable
// rating or track is one slider-like stop with a name and a value, and the
// arrow keys change it the way clicks do. Fake DOM nodes keep this in Node.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

// the bits of an element handleSheetKey reads, parsed from rendered markup
function widgetFrom(html) {
  const open = html.match(/^<(?:span|g)([^>]*)>/)[1];
  const attrs = Object.fromEntries([...open.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const dataset = {};
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5)] = v;
  const node = { dataset, getAttribute: (k) => attrs[k] ?? null, closest: () => node };
  return node;
}
const press = (lib, block, html, key, shiftKey = false) => lib.handleSheetKey(block, widgetFrom(html), { key, shiftKey });

test('ratings and tracks are named sliders with their value', async () => {
  const lib = await load('sheets/sheetlib.js');
  const dots = lib.dotsHtml(3, 5, { edit: true, path: 'attributes.wits', label: 'Wits' });
  assert.match(dots, /role="slider"/);
  assert.match(dots, /tabindex="0"/);
  assert.match(dots, /aria-label="Wits"/);
  assert.match(dots, /aria-valuenow="3"/);
  assert.match(dots, /aria-valuemax="5"/);
  assert.match(dots, /aria-valuetext="3 of 5"/);
  const readOnly = lib.dotsHtml(2, 5, { label: 'Presence' });
  assert.match(readOnly, /role="img" aria-label="Presence: 2 of 5"/);
  assert.doesNotMatch(readOnly, /tabindex/);
  assert.match(lib.trackHtml(5, 2, 1, 'health', 'Health'), /aria-valuetext="2 superficial, 1 aggravated, of 5"/);
  assert.match(lib.boxesHtml(4, 1, 'spellcasting.slots.1.used', 'Level 1 spell slots'), /aria-valuetext="1 of 4 used"/);
});

test('arrow keys change ratings within their bounds', async () => {
  const lib = await load('sheets/sheetlib.js');
  const block = { data: { attributes: { wits: 3 } } };
  const html = () => lib.dotsHtml(block.data.attributes.wits, 5, { edit: true, path: 'attributes.wits', label: 'Wits' });
  assert.equal(press(lib, block, html(), 'ArrowRight'), true);
  assert.equal(block.data.attributes.wits, 4);
  assert.equal(press(lib, block, html(), 'End'), true);
  assert.equal(block.data.attributes.wits, 5);
  assert.equal(press(lib, block, html(), 'ArrowUp'), false, 'at the top nothing changes, but the key is handled');
  assert.equal(press(lib, block, html(), 'Home'), true);
  assert.equal(block.data.attributes.wits, 0);
  assert.equal(press(lib, block, html(), 'a'), null, 'other keys are left alone');
  const slots = { data: { spellcasting: { slots: { 1: { max: 4, used: 3 } } } } };
  assert.equal(press(lib, slots, lib.boxesHtml(4, 3, 'spellcasting.slots.1.used', 'L1'), 'PageDown'), true);
  assert.equal(slots.data.spellcasting.slots[1].used, 0);
});

test('damage tracks take, convert and heal damage like the rules', async () => {
  const lib = await load('sheets/sheetlib.js');
  const block = { data: { health: { superficial: 0, aggravated: 0 } } };
  const html = () => lib.trackHtml(3, block.data.health.superficial, block.data.health.aggravated, 'health', 'Health');
  const state = () => `${block.data.health.superficial}/${block.data.health.aggravated}`;
  press(lib, block, html(), 'ArrowRight'); press(lib, block, html(), 'ArrowRight');
  assert.equal(state(), '2/0');
  press(lib, block, html(), 'ArrowRight', true);
  assert.equal(state(), '2/1', 'Shift marks aggravated');
  press(lib, block, html(), 'ArrowRight');
  assert.equal(state(), '1/2', 'superficial on a full track becomes aggravated');
  press(lib, block, html(), 'ArrowLeft');
  assert.equal(state(), '0/2', 'left heals superficial first');
  press(lib, block, html(), 'ArrowLeft', true);
  assert.equal(state(), '0/1', 'Shift heals aggravated');
  press(lib, block, html(), 'Home');
  assert.equal(state(), '0/0');
});

test('the familiar SVG sheets expose the same stops, with a focus ring', async () => {
  const { familiarHtml } = await load('sheets/familiar.js');
  const lib = await load('sheets/sheetlib.js');
  const vtm = familiarHtml('vtm5', { attributes: { strength: 2 }, health: { superficial: 1 }, hunger: 2 }, { name: 'T' });
  assert.match(vtm, /<svg class="fam-svg"[^>]*role="group"/);
  assert.doesNotMatch(vtm, /<svg[^>]*role="img"/, 'an img role would hide the controls');
  assert.match(vtm, /data-dots="attributes\.strength" tabindex="0" role="slider" aria-label="Strength"/);
  assert.match(vtm, /data-track="health" tabindex="0" role="slider" aria-label="Health"/);
  assert.match(vtm, /aria-label="Hunger"[^>]*aria-valuenow="2"/);
  assert.match(vtm, /class="fam-focus"/);
  const coc = familiarHtml('coc7', { hp: { max: 11, current: 9 }, san: { max: 80, current: 57 } }, { name: 'T' });
  const hp = coc.match(/<g class="track" data-track="hp\.current"[^>]*>/)[0];
  assert.match(hp, /aria-valuemax="11"/);
  const block = { data: { hp: { max: 11, current: 11 } } };
  assert.equal(lib.handleSheetKey(block, widgetFrom(hp), { key: 'ArrowUp' }), false, 'hit points stop at the maximum');
  assert.equal(lib.handleSheetKey(block, widgetFrom(hp), { key: 'PageDown' }), true);
  assert.equal(block.data.hp.current, 6);
  const dnd = familiarHtml('dnd2024', { deathSaves: { success: 1 }, spellcasting: { slots: { 1: { max: 4, used: 1 } } } }, { name: 'T' });
  assert.match(dnd, /data-dots="deathSaves\.success" tabindex="0" role="slider" aria-label="Death save successes"/);
  assert.match(dnd, /data-track="spellcasting\.slots\.1\.used" data-mode="fill" tabindex="0" role="slider" aria-label="Level 1 spell slots expended"/);
});
