'use strict';
// Character files (sheets/charfile.js): one sheet out of a world and back in, the format
// Elysium (the online table) reads and writes too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

const SYSTEMS = { dnd2024: {}, vtm5: {}, coc7: {} };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a sheet goes out with its data untouched and nothing else from the entry', async () => {
  const { characterFile, readCharacterFile, CHARACTER_FILE } = await load('sheets/charfile.js');
  const block = { id: 'b1', kind: 'sheet', system: 'vtm5', data: { clan: 'Toreador', hunger: 2, attributes: { charisma: 4 }, stains: 1 }, secret: true };
  const entity = { id: 'celeste', name: 'Celeste', gmOnly: true, fields: { secret: 'x' }, relations: [{ to: 'prince', label: 'childe', secret: true }],
    blocks: [{ kind: 'text', text: 'GM notes: she is a spy', secret: true }, block] };
  const file = characterFile(entity, block, { app: 'MundusMaker 1.9.3', now: new Date('2026-11-03T12:00:00Z'), portrait: PNG });
  assert.equal(file.format, CHARACTER_FILE);
  assert.equal(file.version, 1);
  assert.equal(file.exported, '2026-11-03T12:00:00.000Z');
  assert.deepEqual(file.data, block.data);
  assert.equal(file.portrait, PNG);
  const text = JSON.stringify(file);
  for (const leak of ['she is a spy', 'prince', 'gmOnly', 'secret']) assert.ok(!text.includes(leak), `${leak} must not travel`);
  const back = readCharacterFile(JSON.parse(text), SYSTEMS);
  assert.deepEqual(back, { name: 'Celeste', system: 'vtm5', data: block.data, portrait: PNG });
});

test('unknown keys a table added (stains, rituals...) survive the round trip', async () => {
  const { characterFile, readCharacterFile } = await load('sheets/charfile.js');
  const data = { clan: 'Tremere', stains: 2, rituals: [{ name: 'Wake with Evening\'s Freshness', level: 1 }], healthMaxBonus: 1 };
  const back = readCharacterFile(JSON.parse(JSON.stringify(characterFile({ name: 'Mira' }, { system: 'vtm5', data }))), SYSTEMS);
  assert.deepEqual(back.data, data);
});

test('bad files are refused with a plain reason', async () => {
  const { readCharacterFile } = await load('sheets/charfile.js');
  const ok = { format: 'mundusmaker.character', version: 1, name: 'X', system: 'vtm5', data: {} };
  assert.throws(() => readCharacterFile({ ...ok, format: 'progeny' }, SYSTEMS), /not a MundusMaker character file/);
  assert.throws(() => readCharacterFile([], SYSTEMS), /not a MundusMaker character file/);
  assert.throws(() => readCharacterFile({ ...ok, version: 2 }, SYSTEMS), /newer version/);
  assert.throws(() => readCharacterFile({ ...ok, version: '1' }, SYSTEMS), /no version/);
  assert.throws(() => readCharacterFile({ ...ok, system: 'pathfinder' }, SYSTEMS), /doesn’t know \(pathfinder\)/);
  assert.throws(() => readCharacterFile({ ...ok, system: '__proto__' }, SYSTEMS), /doesn’t know/);
  assert.throws(() => readCharacterFile({ ...ok, data: null }, SYSTEMS), /no sheet/);
  assert.throws(() => readCharacterFile({ ...ok, data: [1] }, SYSTEMS), /no sheet/);
});

test('only raster data-URL portraits are accepted, never SVG or links', async () => {
  const { readCharacterFile, characterFile, portraitParts } = await load('sheets/charfile.js');
  const base = { format: 'mundusmaker.character', version: 1, name: 'X', system: 'vtm5', data: {} };
  assert.equal(readCharacterFile({ ...base, portrait: PNG }, SYSTEMS).portrait, PNG);
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', 'data:text/html;base64,PGI+', 'javascript:alert(1)']) {
    assert.equal(readCharacterFile({ ...base, portrait: bad }, SYSTEMS).portrait, null, bad);
    assert.equal(characterFile({ name: 'X' }, { system: 'vtm5', data: {} }, { portrait: bad }).portrait, undefined, bad);
  }
  assert.deepEqual(Object.keys(portraitParts(PNG)), ['type', 'ext', 'base64']);
  assert.equal(portraitParts(PNG).ext, 'png');
  assert.equal(portraitParts('data:image/svg+xml;base64,PHN2Zz4='), null);
});

test('file names are safe and readable', async () => {
  const { characterFileName } = await load('sheets/charfile.js');
  assert.equal(characterFileName('Céleste du Lac!'), 'Celeste-du-Lac.character.json');
  assert.equal(characterFileName('../../etc'), 'etc.character.json');
  assert.equal(characterFileName(''), 'character.character.json');
});
