'use strict';
// The website's backend (supabase/migrations) against the local Supabase stack.
// Not part of npm test, because it needs Docker: start the stack with
// `npx supabase start`, then run `npm run test:site-db`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const API = process.env.SUPABASE_URL || 'http://127.0.0.1:56421';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const MB = 1024 * 1024;

async function call(path, { method = 'GET', token, json, body, headers = {} } = {}) {
  const h = { apikey: KEY, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(API + path, { method, headers: h, body });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { status: res.status, data, headers: res.headers };
}

async function newGm() {
  const email = `gm-${randomBytes(6).toString('hex')}@example.test`;
  const r = await call('/auth/v1/signup', { method: 'POST', json: { email, password: 'a long test password' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { token: r.data.access_token };
}

const wikiId = () => Array.from(randomBytes(12), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const addWiki = (gm, id) => call('/rest/v1/wikis', { method: 'POST', token: gm.token, json: { id, title: 'Test wiki' }, headers: { Prefer: 'return=minimal' } });
const upload = (gm, path, body, type, cache = 60) => call(`/storage/v1/object/wikis/${path}`, {
  method: 'POST', token: gm?.token, body, headers: { 'Content-Type': type, 'cache-control': `max-age=${cache}`, 'x-upsert': 'true' },
});
const publicGet = (path) => fetch(`${API}/storage/v1/object/public/wikis/${path}`);
const ok = (r) => r.status >= 200 && r.status < 300;
const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(64)]);
const imageName = () => `images/${randomBytes(12).toString('hex')}.png`;

test('a GM publishes, players read without an account, and nobody else can change it', async () => {
  const a = await newGm(), b = await newGm();
  const id = wikiId();
  assert.equal((await addWiki(a, id)).status, 201);

  const page = '<!doctype html><title>Test wiki</title><p>Hello</p>';
  assert.ok(ok(await upload(a, `${id}/index.html`, page, 'text/plain')), 'pages are stored as text');
  const picture = imageName();
  assert.ok(ok(await upload(a, `${id}/${picture}`, png(), 'image/png', 31536000)));
  assert.ok(ok(await upload(a, `${id}/assets/wiki.css`, 'body{}', 'text/css')));

  // players need no account
  const read = await publicGet(`${id}/index.html`);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), page);
  assert.match(read.headers.get('content-type'), /^text\/plain/);
  assert.match(read.headers.get('cache-control') || '', /max-age=60/);
  assert.match((await publicGet(`${id}/${picture}`)).headers.get('cache-control') || '', /max-age=31536000/);

  // only the shapes a player wiki has, and only the types the viewer reads
  assert.ok(!ok(await upload(a, `${id}/phishing.html`, page, 'text/plain')), 'other names are refused');
  assert.ok(!ok(await upload(a, `${id}/images/${randomBytes(12).toString('hex')}.svg`, '<svg/>', 'image/svg+xml')));
  assert.ok(!ok(await upload(a, `${id}/entry-0001.html`, page, 'text/html')), 'text/html is refused');
  assert.ok(!ok(await upload(a, `${wikiId()}/index.html`, page, 'text/plain')), 'a folder without a wiki row is refused');

  // another GM, or nobody at all, can't write, list or see it
  assert.ok(!ok(await upload(b, `${id}/index.html`, 'taken over', 'text/plain')));
  assert.ok(!ok(await upload(null, `${id}/index.html`, 'taken over', 'text/plain')));
  assert.equal(await (await publicGet(`${id}/index.html`)).text(), page);
  const listed = await call('/storage/v1/object/list/wikis', { method: 'POST', json: { prefix: id } });
  assert.ok(!ok(listed) || (Array.isArray(listed.data) && listed.data.length === 0), 'nobody can list the bucket');
  assert.deepEqual((await call(`/rest/v1/wikis?id=eq.${id}`, { token: b.token })).data, []);
  const anonRows = await call('/rest/v1/wikis');
  assert.ok(!ok(anonRows) || anonRows.data.length === 0);
  const removed = await call('/storage/v1/object/wikis', { method: 'DELETE', token: b.token, json: { prefixes: [`${id}/index.html`] } });
  assert.ok(!ok(removed) || removed.data.length === 0, 'another GM removes nothing');
  assert.equal((await publicGet(`${id}/index.html`)).status, 200);

  // the owner sees their own files and how much they use
  const mine = await call('/storage/v1/object/list/wikis', { method: 'POST', token: a.token, json: { prefix: id } });
  assert.ok(mine.data.some((f) => f.name === 'index.html'));
  assert.ok((await call('/rest/v1/rpc/wiki_bytes_used', { method: 'POST', token: a.token, json: {} })).data > 0);

  // taking it down: files first, then the row
  const gone = await call('/storage/v1/object/wikis', { method: 'DELETE', token: a.token, json: { prefixes: [`${id}/index.html`, `${id}/${picture}`, `${id}/assets/wiki.css`] } });
  assert.equal(gone.data.length, 3);
  assert.equal((await call(`/rest/v1/wikis?id=eq.${id}`, { method: 'DELETE', token: a.token, headers: { Prefer: 'return=minimal' } })).status, 204);
  assert.ok([400, 404].includes((await publicGet(`${id}/index.html`)).status));
});

test('each GM gets three wikis, 3 MB per file and 20 MB in all', async () => {
  const gm = await newGm();
  const ids = [wikiId(), wikiId(), wikiId()];
  for (const id of ids) assert.equal((await addWiki(gm, id)).status, 201);
  assert.ok(!ok(await addWiki(gm, wikiId())), 'a fourth wiki is refused');

  assert.ok(!ok(await upload(gm, `${ids[0]}/${imageName()}`, Buffer.alloc(3 * MB + 1), 'image/png')), 'a file over 3 MB is refused');
  let stored = 0, refused = false;
  for (let i = 0; i < 9 && !refused; i++) {
    const r = await upload(gm, `${ids[i % 3]}/${imageName()}`, Buffer.alloc(3 * MB), 'image/png');
    if (ok(r)) stored += 3 * MB; else refused = true;
  }
  assert.ok(refused, 'uploads stop at the allowance');
  assert.ok(stored >= 20 * MB && stored <= 23 * MB, `stored ${stored / MB} MB before the refusal`);
});
