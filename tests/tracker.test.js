'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/js/trackercore.js')).toString('base64'));

test('opening a session does not initialize or rewrite its tracker', async () => {
  const { trackerFor, activeIndex, trackerRound } = await core;
  const empty = { id: 'session' };
  assert.deepEqual(trackerFor(empty), { rows: [], round: 1, active: 0 });
  assert.deepEqual(empty, { id: 'session' });
  const legacy = { sessionTracker: { rows: [{ name: 'Hero', hp: '0', extra: 'keep' }], active: 99, round: 0, extra: true } };
  const before = structuredClone(legacy);
  assert.equal(trackerFor(legacy), legacy.sessionTracker);
  assert.equal(activeIndex(legacy.sessionTracker), 0);
  assert.equal(trackerRound(legacy.sessionTracker), 1);
  assert.deepEqual(legacy, before);
});

test('turns wrap across rounds in both directions and stop before round one', async () => {
  const { stepTurn } = await core;
  const tracker = { round: 1, active: 0, rows: [{ name: 'A' }, { name: 'B' }] };
  assert.equal(stepTurn(tracker, -1), false);
  stepTurn(tracker); assert.equal(tracker.active, 1); assert.equal(tracker.round, 1);
  stepTurn(tracker); assert.equal(tracker.active, 0); assert.equal(tracker.round, 2);
  stepTurn(tracker, -1); assert.equal(tracker.active, 1); assert.equal(tracker.round, 1);
  assert.equal(stepTurn({ rows: [] }), false);
});

test('initiative sorting retains the active combatant, stable ties, and unknown rolls last', async () => {
  const { sortInitiative } = await core;
  const tracker = { active: 1, round: 3, rows: [
    { name: 'Unknown', initiative: '' }, { name: 'Active', initiative: 12 },
    { name: 'High', initiative: '20' }, { name: 'Tie', initiative: 12 },
    { name: 'Negative', initiative: -2 }, { name: 'Unrolled' },
  ] };
  sortInitiative(tracker);
  assert.deepEqual(tracker.rows.map((r) => r.name), ['High', 'Active', 'Tie', 'Negative', 'Unknown', 'Unrolled']);
  assert.equal(tracker.rows[tracker.active].name, 'Active');
  assert.equal(tracker.round, 3);
});

test('removing combatants retains the current turn or advances to the next survivor', async () => {
  const { removeCombatant } = await core;
  const tracker = { active: 1, rows: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] };
  removeCombatant(tracker, 0);
  assert.equal(tracker.rows[tracker.active].name, 'B');
  removeCombatant(tracker, 0);
  assert.equal(tracker.rows[tracker.active].name, 'C');
  removeCombatant(tracker, 0);
  assert.deepEqual(tracker.rows, []); assert.equal(tracker.active, 0);
  assert.equal(removeCombatant(tracker, 0), false);
  const last = { active: 1, rows: [{ name: 'A' }, { name: 'B' }] };
  removeCombatant(last, 1); assert.equal(last.active, 0);
});

test('damage and healing preserve unknown HP and reject invalid arithmetic', async () => {
  const { adjustHp } = await core;
  for (const hp of ['', null, undefined, 'unknown']) {
    const row = { hp }; assert.equal(adjustHp(row, -3), false); assert.equal(row.hp, hp);
  }
  const row = { hp: '12', maxHp: 12 };
  assert.equal(adjustHp(row, -5), true); assert.equal(row.hp, 7);
  assert.equal(adjustHp(row, 2), true); assert.equal(row.hp, 9);
  assert.equal(adjustHp(row, -12), true); assert.equal(row.hp, -3);
  assert.equal(row.maxHp, 12);
  assert.equal(adjustHp(row, NaN), false); assert.equal(adjustHp(row, 1.5), false);
  assert.equal(adjustHp({ hp: Number.MAX_SAFE_INTEGER }, 1), false);
});

test('statblocks seed separate combatants without changing their source', async () => {
  const { combatantFromEntity, adjustHp } = await core;
  const source = { id: 'guard', name: 'Guard', blocks: [{ kind: 'statblock', stat: { hp: '18 (4d8)' } }] };
  const before = structuredClone(source);
  const row = combatantFromEntity(source, 'row-1');
  assert.equal(row.hp, 18); assert.equal(row.maxHp, 18); assert.equal(row.to, 'guard');
  adjustHp(row, -7); assert.equal(row.hp, 11); assert.deepEqual(source, before);
  assert.equal(combatantFromEntity({ blocks: [{ kind: 'statblock', stat: { hp: '4d8' } }] }, 'row-2').hp, '');
});

test('D&D sheets preserve zero current HP and other systems stay editable with unknown HP', async () => {
  const { combatantFromEntity } = await core;
  const entity = { id: 'hero', name: 'Hero', blocks: [{ kind: 'sheet', system: 'dnd2024', data: { hp: { max: 24, current: 0, temp: 5 } } }] };
  const row = combatantFromEntity(entity, 'row-3');
  assert.equal(row.hp, 0); assert.equal(row.maxHp, 24);
  row.hp = 12; assert.equal(entity.blocks[0].data.hp.current, 0);
  assert.equal(combatantFromEntity({ blocks: [{ kind: 'sheet', system: 'vtm5', data: {} }] }, 'row-4').hp, '');
  assert.equal(combatantFromEntity(null, 'row-5').name, '');
});
