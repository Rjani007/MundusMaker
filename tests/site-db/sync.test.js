'use strict';
// The account side of MundusMaker in the browser (supabase/migrations/
// 20261104120000_world_sync.sql) against the local Supabase stack. Not part of
// npm test, because it needs Docker: `npx supabase start`, then
// `npm run test:site-db`. tests/web-sync.test.js runs the browser side.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { createCloud } = require('../../web/cloud');

const API = process.env.SUPABASE_URL || 'http://127.0.0.1:56421';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function call(path, { method = 'GET', token, json, body, headers = {} } = {}) {
  const h = { apikey: KEY, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(API + path, { method, headers: h, body });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { status: res.status, data };
}

async function newGm() {
  const email = `gm-${randomBytes(6).toString('hex')}@example.test`;
  const r = await call('/auth/v1/signup', { method: 'POST', json: { email, password: 'a long test password' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const gm = { token: r.data.access_token, id: r.data.user.id };
  gm.cloud = createCloud({ url: API, key: KEY, getToken: async () => ({ token: gm.token, user: { id: gm.id } }) });
  return gm;
}
const ok = (r) => r.status >= 200 && r.status < 300;

test('a GM keeps world files, only their own, and the revisions refuse a stale change', async () => {
  const a = await newGm(), b = await newGm();
  const v1 = Buffer.from('{"id":"king","name":"The King"}');
  const v2 = Buffer.from('{"id":"king","name":"King Aldric"}');
  await a.cloud.upload(sha(v1), v1);
  await a.cloud.upload(sha(v1), v1); // already stored is fine

  const first = await a.cloud.commit([{ path: 'worlds/vale/entities/king.json', sha256: sha(v1), size: v1.length, base: 0 }], 'Chrome on Windows');
  const rev1 = first.results[0].rev;
  assert.ok(rev1 > 0, JSON.stringify(first));

  // a change based on an old revision is refused, and says where the file is now
  await a.cloud.upload(sha(v2), v2);
  const stale = await a.cloud.commit([{ path: 'worlds/vale/entities/king.json', sha256: sha(v2), size: v2.length, base: 0 }], 'Firefox on Linux');
  assert.deepEqual(stale.results[0], { path: 'worlds/vale/entities/king.json', conflict: true, rev: rev1 });
  const second = await a.cloud.commit([{ path: 'worlds/vale/entities/king.json', sha256: sha(v2), size: v2.length, base: rev1 }], 'Firefox on Linux');
  assert.ok(second.results[0].rev > rev1);

  // bytes never stored, paths that never travel, files of the wrong shape
  const missing = await a.cloud.commit([{ path: 'worlds/vale/world.json', sha256: 'f'.repeat(64), size: 3, base: 0 }], 'x');
  assert.deepEqual(missing.results[0], { path: 'worlds/vale/world.json', missing: true });
  const refused = await a.cloud.commit([
    { path: 'worlds/vale/.history/king/1.json', sha256: sha(v1), size: 3, base: 0 },
    { path: '../config/x.json', sha256: sha(v1), size: 3, base: 0 },
    { path: 'worlds/vale/entities/x.json', sha256: 'not a hash', size: 3, base: 0 },
  ], 'x');
  assert.deepEqual(refused.results.map((r) => r.refused), ['path', 'path', 'file']);

  // rows come back in revision order, with the device that made them
  const rows = await a.cloud.changes(0, 100);
  assert.deepEqual(rows.map((r) => [r.path, r.sha256, r.deleted, r.device]), [['worlds/vale/entities/king.json', sha(v2), false, 'Firefox on Linux']]);
  assert.deepEqual(Buffer.from(await a.cloud.download(sha(v2))), v2);

  // a deletion is a row too, so other browsers hear of it
  const del = await a.cloud.commit([{ path: 'worlds/vale/entities/king.json', sha256: null, size: 0, base: second.results[0].rev }], 'Edge on Windows');
  const after = await a.cloud.changes(second.results[0].rev, 100);
  assert.deepEqual(after.map((r) => [r.rev, r.deleted, r.sha256]), [[del.results[0].rev, true, null]]);

  // another GM sees none of it and can touch none of it
  assert.deepEqual(await b.cloud.changes(0, 100), []);
  await assert.rejects(b.cloud.download(sha(v2)), (err) => err.kind === 'missing');
  const intoA = await call(`/storage/v1/object/sync/${a.id}/${sha(v1)}`, { method: 'POST', token: b.token, body: v1, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.ok(!ok(intoA), 'nobody stores into another GM’s folder');
  const takeover = await b.cloud.commit([{ path: 'worlds/vale/entities/king.json', sha256: sha(v1), size: v1.length, base: 0 }], 'x');
  assert.equal(takeover.results[0].missing, true, 'B cannot point a row at A’s bytes');
  assert.deepEqual(await a.cloud.changes(del.results[0].rev, 100), [], 'A’s rows are untouched');
  const direct = await call('/rest/v1/sync_files', { method: 'POST', token: b.token, json: { path: 'worlds/x/world.json', sha256: sha(v1), size: 1, rev: 1 } });
  assert.ok(!ok(direct), 'rows change only through sync_commit');
  const badName = await call(`/storage/v1/object/sync/${b.id}/not-a-hash`, { method: 'POST', token: b.token, body: v1, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.ok(!ok(badName), 'objects are named by their hash');
  const anon = await call('/rest/v1/sync_files');
  assert.ok(!ok(anon) || anon.data.length === 0);
  assert.ok(!ok(await call('/rest/v1/rpc/sync_commit', { method: 'POST', json: { changes: [], device: '' } })), 'not signed in, no commit');

  // what the Settings page shows, and nothing to tidy yet (objects are kept for a day)
  const usage = await a.cloud.usage();
  assert.equal(usage.files, 0);
  assert.equal(usage.bytes, v1.length + v2.length);
  assert.equal(usage.limits.bytes, 100 * 1024 * 1024);
  assert.deepEqual(await a.cloud.orphans(), []);
});
