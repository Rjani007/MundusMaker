'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const catalog = import('data:text/javascript;base64,' + fs.readFileSync(require('node:path').join(__dirname, '../public/js/dmreferences.js')).toString('base64'));
test('references cover all systems and every 2024 condition with searchable text and attribution', async () => {
  const { DM_REFERENCES: refs, REFERENCE_SYSTEMS: systems, referenceMatches } = await catalog;
  assert.equal(new Set(refs.map(r => r.id)).size, refs.length);
  for (const system of systems) assert.ok(refs.filter(r => r.system === system.id).length >= 6);
  assert.equal(refs.filter(r => r.system === 'dnd2024' && r.topic === 'Conditions').length, 15);
  for (const r of refs) { assert.ok(r.text.length > 40); assert.match(r.source, /^https:\/\//); assert.ok(r.notice); }
  assert.equal(refs.filter(r => referenceMatches(r, { system: 'dnd2024', topic: 'Conditions', query: 'exhaustion 2024' }))[0].title, 'Exhaustion');
  assert.equal(refs.filter(r => referenceMatches(r, { system: 'coc7', query: 'concentration' })).length, 0);
});
test('pin templates become independent GM-only notes with ordinary secrecy flags', async () => {
  const { DM_REFERENCES: refs, referenceCopy } = await catalog;
  let id = 0;
  for (const r of refs) {
    const before = JSON.stringify(r);
    const copy = referenceCopy(r, (name, type) => ({ id: 'reference', name, type, gmOnly: false, fields: {}, blocks: [], tags: [] }), () => String(++id));
    assert.equal(copy.type, 'note'); assert.equal(copy.gmOnly, true);
    assert.equal(copy.referenceTemplate.id, r.id); assert.ok(copy.tags.includes('rules-reference'));
    assert.equal(copy.blocks[0].secret, false); assert.match(copy.blocks[1].text, /https:\/\//);
    copy.blocks[0].text = 'My ruling'; copy.fields.System = 'Home game'; copy.referenceTemplate.version = 90;
    assert.equal(JSON.stringify(r), before);
  }
});
test('re-pinning chooses the saved copy by provenance, preserving edited names and text', async () => {
  const { existingReference } = await catalog;
  const saved = { id: 'a', name: 'House rule', blocks: [{ text: 'Edited' }], referenceTemplate: { id: 'dnd2024-tests' } };
  const alreadyPinned = { ...saved, id: 'b' };
  const misleading = { id: 'c', name: 'D&D · D20 tests & difficulty' };
  assert.equal(existingReference([misleading, saved], 'dnd2024-tests'), saved);
  assert.equal(existingReference([saved, alreadyPinned], 'dnd2024-tests', ['b']), alreadyPinned);
  assert.equal(existingReference([misleading], 'dnd2024-tests'), null);
  assert.equal(saved.blocks[0].text, 'Edited');
});
