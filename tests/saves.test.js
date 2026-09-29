'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
let sequence = 0;
const pause = () => new Promise((resolve) => setImmediate(resolve));

async function client(t) {
  const key = '__mundusmakerSaveTest' + sequence++;
  const writes = [];
  let fail = false, gate = null;
  const entity = { id: 'entry', name: 'Original', type: 'note', blocks: [], tags: [], relations: [] };
  const api = {
    setWorld() {},
    listWorlds: async () => [{ id: 'one' }, { id: 'two' }],
    acceptWorldSnapshot() {},
    readWorldSnapshot: async () => ({ world: { name: 'World', types: { npc: {}, session: {}, spell: {}, handout: {} } }, entities: [structuredClone(entity)], issues: [] }),
    putEntity: async (draft, wid) => {
      writes.push({ wid, draft: structuredClone(draft) });
      if (gate) await gate;
      if (fail) throw new Error('disk full');
      return { entity: { ...draft, updated: 'server-stamp' } };
    },
    putWorld: async (draft, wid) => {
      writes.push({ wid, world: structuredClone(draft) });
      if (gate) await gate;
      if (fail) throw new Error('disk full');
    },
    deleteEntity: async (id, wid) => writes.push({ wid, deleted: id }),
  };
  globalThis[key] = { api };
  const src = fs.readFileSync(path.join(__dirname, '../public/js/state.js'), 'utf8')
    .replace("import { api } from './api.js';", `const { api } = globalThis.${key};`)
    .replace("import { slugify, uid, readSetting, writeSetting } from './util.js';", "const slugify = (s) => s.toLowerCase(), uid = () => 'test-id', readSetting = () => null, writeSetting = () => {};");
  const state = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  await state.init();
  t.after(async () => { fail = false; gate = null; await state.flushSaves(); delete globalThis[key]; });
  return { ...state, writes, api, fail: (value) => { fail = value; }, delay: () => { let release; gate = new Promise((resolve) => { release = resolve; }); return () => { gate = null; release(); }; } };
}

test('world switch refuses a failed save and retains the original world and draft', async (t) => {
  const c = await client(t);
  const entry = c.getEntity('entry');
  entry.name = 'Unsaved'; c.scheduleSave(entry); c.fail(true);
  await assert.rejects(c.selectWorld('two'), /disk full/);
  assert.equal(c.state.worldId, 'one');
  assert.equal(c.saveState(), 'error');
  assert.equal(c.unsavedDraft().entries[0].entity.name, 'Unsaved');
  c.fail(false); await c.selectWorld('two');
  assert.equal(c.state.worldId, 'two');
  assert.ok(c.writes.every((write) => write.wid === 'one'));
});

test('flush and switch await in-flight writes even when nothing else is dirty', async (t) => {
  const c = await client(t);
  const release = c.delay();
  c.scheduleSave(c.getEntity('entry'));
  const first = c.flushSaves();
  await pause();
  assert.equal(c.flushSaves(), first);
  const switching = c.selectWorld('two');
  await pause();
  assert.equal(c.state.worldId, 'one');
  release(); await switching;
  assert.equal(c.state.worldId, 'two');
  assert.equal(c.writes.length, 1);
});

test('typing during a delayed response keeps editor identity and saves the newest text', async (t) => {
  const c = await client(t);
  const entry = c.getEntity('entry');
  const release = c.delay();
  entry.name = 'First'; c.scheduleSave(entry);
  const flush = c.flushSaves(); await pause();
  entry.name = 'Newest'; c.scheduleSave(entry);
  release(); await flush;
  assert.equal(c.getEntity('entry'), entry);
  assert.deepEqual(c.writes.map((write) => write.draft.name), ['First', 'Newest']);
  assert.equal(c.getEntity('entry').name, 'Newest');
  assert.equal(c.saveState(), 'saved');
});

test('world edits made during a save are drained before switching', async (t) => {
  const c = await client(t);
  const release = c.delay();
  c.state.world.name = 'First'; c.scheduleWorldSave();
  const flushing = c.flushSaves(); await pause();
  c.state.world.name = 'Newest'; c.scheduleWorldSave();
  release(); await flushing;
  assert.deepEqual(c.writes.map((write) => write.world.name), ['First', 'Newest']);
  assert.equal(c.saveState(), 'saved');
});

test('a delayed operation holding an old entity cannot save it into the new world', async (t) => {
  const c = await client(t);
  const oldEntry = c.getEntity('entry');
  await c.selectWorld('two');
  oldEntry.name = 'Late old-world edit';
  await c.saveEntity(oldEntry);
  assert.equal(c.writes[0].wid, 'one');
  assert.equal(c.getEntity('entry').name, 'Original');
});

test('deletion waits for pending edits and cannot be resurrected by the save timer', async (t) => {
  const c = await client(t);
  const release = c.delay();
  c.scheduleSave(c.getEntity('entry'));
  const deletion = c.deleteEntity('entry'); await pause();
  assert.equal(c.writes.length, 1);
  release(); await deletion; await c.flushSaves();
  assert.deepEqual(c.writes.map((write) => write.deleted || write.draft.id), ['entry', 'entry']);
  assert.equal(c.writes[1].deleted, 'entry');
  assert.equal(c.getEntity('entry'), null);
});

test('failed direct saves retain a downloadable draft and player mode refuses the download', async (t) => {
  const c = await client(t);
  c.fail(true);
  await assert.rejects(c.saveEntity({ id: 'new', name: 'Secret new draft', type: 'note' }), /disk full/);
  assert.equal(c.unsavedDraft().entries[0].entity.name, 'Secret new draft');
  c.setGm(false);
  assert.throws(() => c.unsavedDraft(), /GM view/);
});

test('a failed later write does not requeue an already successful entry', async (t) => {
  const c = await client(t);
  const original = c.api.putEntity;
  c.api.putEntity = async (draft, wid) => {
    if (draft.id === 'second') throw new Error('second failed');
    return original(draft, wid);
  };
  c.scheduleSave(c.getEntity('entry'));
  c.scheduleSave({ id: 'second', name: 'Second', type: 'note' });
  assert.equal(await c.flushSaves(), false);
  assert.deepEqual(c.unsavedDraft().entries.map((row) => row.entity.id), ['second']);
  c.api.putEntity = original;
  assert.equal(await c.flushSaves(), true);
  assert.deepEqual(c.writes.map((write) => write.draft.id), ['entry', 'second']);
});
