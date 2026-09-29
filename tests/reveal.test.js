'use strict';
// Reveal tracking and the pre-export safety check (1.9).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

let n = 0;
const makeId = () => `id${++n}`;

function world() {
  const session = { id: 's1', name: 'Session 1', type: 'session', blocks: [] };
  const vex = { id: 'lord-vex', name: 'Lord Vex', type: 'npc', gmOnly: true, image: 'vex.png', blocks: [{ id: 'v1', kind: 'text', text: 'Hidden plans ![plan](/assets/w/plan.png)' }] };
  const mara = { id: 'mara', name: 'Captain Mara', type: 'npc', blocks: [
    { id: 'b1', kind: 'text', text: 'Public.' },
    { id: 'b2', kind: 'text', secret: true, text: 'CANARY secret' },
  ], relations: [{ to: 'lord-vex', label: 'serves', secret: true }],
  map: { kind: 'town', markers: [{ id: 'm1', x: 0.1, y: 0.1, label: 'Hideout', secret: true }], stamps: [], paths: [], labels: [] } };
  return { session, vex, mara, byId: new Map([session, vex, mara].map((e) => [e.id, e])) };
}

test('a reveal flips one flag, logs references only, and undo restores it', async () => {
  const { applyReveal, undoReveal, revealStatus } = await load('revealcore.js');
  const { session, mara, byId } = world();
  const rec = applyReveal(mara, { kind: 'block', ref: 'b2' }, { session, makeId, now: new Date('2026-09-28T10:00:00Z') });
  assert.equal(mara.blocks[1].secret, false);
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'entity', 'id', 'kind', 'ref']);
  assert.ok(!JSON.stringify(session.reveals).includes('CANARY'), 'the log never copies text');
  assert.equal(revealStatus(rec, byId), 'shown');
  const undone = undoReveal(session, rec.id, byId);
  assert.equal(undone.ok, true);
  assert.equal(mara.blocks[1].secret, true);
  assert.equal(revealStatus(rec, byId), 'undone');
  assert.equal(undoReveal(session, rec.id, byId).ok, false, 'undo runs once');
});

test('undo refuses when the flag changed since, or the target is gone', async () => {
  const { applyReveal, undoReveal } = await load('revealcore.js');
  const { session, mara, vex, byId } = world();
  const block = applyReveal(mara, { kind: 'block', ref: 'b2' }, { session, makeId });
  mara.blocks[1].secret = true; // hidden again by hand
  assert.match(undoReveal(session, block.id, byId).reason, /hidden again/);
  const entry = applyReveal(vex, { kind: 'entry' }, { session, makeId });
  assert.equal(vex.gmOnly, false);
  byId.delete('lord-vex');
  assert.match(undoReveal(session, entry.id, byId).reason, /deleted/);
});

test('relations gain a stable id; overlays and entries reveal too', async () => {
  const { applyReveal, undoReveal } = await load('revealcore.js');
  const { session, mara, vex, byId } = world();
  const rel = mara.relations[0];
  const r = applyReveal(mara, { kind: 'relation', relation: rel }, { session, makeId });
  assert.equal(rel.secret, false);
  assert.equal(r.ref, rel.id);
  const o = applyReveal(mara, { kind: 'overlay', list: 'markers', ref: 'm1' }, { session, makeId });
  assert.equal(mara.map.markers[0].secret, false);
  assert.equal(o.list, 'markers');
  assert.throws(() => applyReveal(mara, { kind: 'overlay', list: 'markers', ref: 'm1' }, { session, makeId }), /already see/);
  applyReveal(vex, { kind: 'entry' }, { session, makeId });
  assert.equal(session.reveals.length, 3);
  for (const rec of [...session.reveals]) assert.equal(undoReveal(session, rec.id, byId).ok, true);
  assert.equal(rel.secret, true);
  assert.equal(mara.map.markers[0].secret, true);
  assert.equal(vex.gmOnly, true);
});

test('revealed content reaches the player projection, and the log never does', async () => {
  const { applyReveal, undoReveal } = await load('revealcore.js');
  const { projectPlayerWorld } = await load('projection.js');
  const { buildWikiSite } = await load('wiki/site.js');
  const { session, mara, vex, byId } = world();
  session.blocks = [{ id: 'sb', kind: 'text', text: 'We played.' }];
  const site = () => {
    const proj = projectPlayerWorld({ world: { name: 'W', types: {} }, worldId: 'w', entities: [...byId.values()] });
    return buildWikiSite(proj, {}).map((f) => f.text).join('\n');
  };
  assert.ok(!site().includes('CANARY'));
  const rec = applyReveal(mara, { kind: 'block', ref: 'b2' }, { session, makeId });
  applyReveal(vex, { kind: 'entry' }, { session, makeId });
  const shown = site();
  assert.ok(shown.includes('CANARY secret'));
  assert.ok(shown.includes('Lord Vex'));
  assert.ok(!/reveal|undone|"at"/i.test(shown.replace(/Revealed|revealed/g, '')), 'the reveal log is not exported');
  undoReveal(session, rec.id, byId);
  assert.ok(!site().includes('CANARY'));
});

test('the safety check finds every leak class and links to the fix', async () => {
  const { safetyCheck } = await load('safety.js');
  const vex = { id: 'lord-vex', name: 'Lord Vex', gmOnly: true, image: 'vex.png', blocks: [{ id: 'v', kind: 'text', text: 'x ![p](/assets/w/plan.png)' }] };
  const shared = { id: 'mara', name: 'Captain Mara', image: 'vex.png', fields: { Patron: 'lord vex' }, blocks: [
    { id: 'a', kind: 'text', text: 'She met Lord Vexington, then [[Lord Vex|the duke]].' },
    { id: 'b', kind: 'text', text: 'Rumor says lord vex is near. ![scrap](/assets/w/plan.png)' },
    { id: 'c', kind: 'text', secret: true, text: 'Lord Vex, in a secret block, is fine.' },
    { id: 'd', kind: 'table', table: { title: 'Rumors', rows: [{ weight: 1, text: 'Lord Vex hides.' }] } },
  ], map: { kind: 'town', labels: [{ id: 'l', text: 'Lord Vex' }], markers: [{ id: 'm', label: 'Lord Vex', secret: true }], stamps: [], paths: [], scaleLinks: { 'world:1:keep': 'lord-vex' } } };
  const letter = { id: 'letter', name: 'A letter', type: 'handout', handout: { kind: 'letter', sourceId: 'lord-vex' }, blocks: [] };
  const findings = safetyCheck({ worldId: 'w', entities: [vex, shared, letter] });
  const kinds = findings.map((f) => `${f.kind}:${f.where}`);
  assert.ok(kinds.includes('text:A text block'), 'a link to a hidden entry and its name in text');
  assert.ok(findings.some((f) => /Players see the link text “the duke”/.test(f.message)));
  assert.ok(kinds.includes('text:The quick fact “Patron”'));
  assert.ok(kinds.includes('text:The random table “Rumors”'));
  assert.ok(kinds.includes('image:The portrait'));
  assert.ok(kinds.includes('image:An image'));
  assert.ok(kinds.includes('label:The map label “Lord Vex”'));
  assert.ok(!kinds.some((k) => k.startsWith('label:The marker')), 'a secret marker is not player-visible');
  assert.ok(kinds.some((k) => k.startsWith('label:A place')));
  assert.ok(kinds.includes('handout:The handout source'));
  assert.ok(!findings.some((f) => /Vexington/.test(f.message)), 'whole phrases only');
  for (const f of findings) assert.match(f.href, /^#\/(e|map|handouts)\/[\w%-]+$/);
  assert.deepEqual(safetyCheck({ worldId: 'w', entities: [vex, { id: 'x', name: 'Plain', blocks: [{ id: 'q', kind: 'text', text: 'Nothing here.' }] }] }), []);
});
