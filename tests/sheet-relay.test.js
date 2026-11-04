'use strict';

// The website's relay for publishers' free character sheets
// (supabase/functions/sheet-download/relay.mjs). The app in the browser can't
// fetch a publisher's PDF itself, so this Edge Function does, for a signed-in
// GM, from a fixed list, keeping no copy. Hermetic: the publisher and the
// account are fakes; tests/site-db/relay.test.js runs the real allowance.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const relay = () => import(pathToFileURL(path.join(ROOT, 'supabase/functions/sheet-download/relay.mjs')).href);
const SITE = 'https://rjani007.github.io';
const COC = 'https://downloads.chaosium.com/call-of-cthulhu/cha2300-investigator-sheets/CoC7_Investigator_Sheet_Standard_autocalc.pdf';
const PDF = new TextEncoder().encode('%PDF-1.7\n% an investigator sheet\n');

function fakes({ allow = true, allowStatus = 200, publisher = () => new Response(PDF, { status: 200 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/rest/v1/rpc/sheet_relay_allow')) return new Response(JSON.stringify(allow), { status: allowStatus });
    return publisher(String(url), opts);
  };
  return { calls, fetchImpl };
}
const ask = (handle, { origin = SITE, method = 'POST', body = { url: COC }, headers = {} } = {}) => handle(new Request('https://project.supabase.co/functions/v1/sheet-download', {
  method,
  headers: { ...(origin ? { origin } : {}), apikey: 'publishable', authorization: 'Bearer user-token', 'content-type': 'application/json', ...headers },
  body: method === 'POST' ? JSON.stringify(body) : undefined,
}));

test('a signed-in GM on the website gets the publisher’s own PDF, passed straight through', async () => {
  const { createHandler } = await relay();
  const f = fakes();
  const handle = createHandler({ fetchImpl: f.fetchImpl, supabaseUrl: 'https://project.supabase.co' });
  const res = await ask(handle);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF);
  // the allowance is asked with the GM's own credentials, then the publisher's file is fetched
  assert.equal(f.calls[0].url, 'https://project.supabase.co/rest/v1/rpc/sheet_relay_allow');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer user-token');
  assert.equal(f.calls[0].opts.headers.apikey, 'publishable');
  assert.equal(f.calls[1].url, COC);
  assert.equal(f.calls[1].opts.redirect, 'manual');

  const pre = await ask(handle, { method: 'OPTIONS' });
  assert.equal(pre.status, 204, 'the browser’s preflight passes');
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
});

test('it fetches only its own list, only for this website, only for signed-in GMs within their allowance', async () => {
  const { createHandler } = await relay();
  const run = async (opts, fake = fakes()) => {
    const res = await ask(createHandler({ fetchImpl: fake.fetchImpl, supabaseUrl: 'https://p.supabase.co' }), opts);
    return { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : null, calls: fake.calls };
  };
  const other = await run({ body: { url: 'https://example.com/anything.pdf' } });
  assert.deepEqual([other.status, other.body.code, other.calls.length], [400, 'unknown-file', 0], 'never an open proxy');
  const foreign = await run({ origin: 'https://evil.example' });
  assert.deepEqual([foreign.status, foreign.calls.length], [403, 0]);
  assert.equal((await run({ method: 'GET' })).status, 405);
  assert.equal((await run({ body: 'x'.repeat(5000) })).status, 400);
  const expired = await run({}, fakes({ allowStatus: 401, allow: { message: 'JWT expired' } }));
  assert.deepEqual([expired.status, expired.body.code, expired.calls.length], [401, 'auth', 1]);
  const limit = await run({}, fakes({ allow: false }));
  assert.deepEqual([limit.status, limit.body.code, limit.calls.length], [429, 'limit', 1], 'the publisher is not asked');
  assert.match(limit.body.error, /many times today/);
});

test('the publisher’s answer is checked as the desktop app checks it', async () => {
  const { createHandler } = await relay();
  const run = async (publisher) => {
    const res = await ask(createHandler({ fetchImpl: fakes({ publisher }).fetchImpl, supabaseUrl: 'https://p.supabase.co' }));
    return { status: res.status, error: res.status === 200 ? null : (await res.json()).error };
  };
  assert.deepEqual(await run(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.pdf' } })), { status: 502, error: 'the file has moved' });
  let hops = 0;
  const moved = await run((url) => (hops++ === 0 ? new Response(null, { status: 301, headers: { location: '/new/sheet.pdf' } }) : new Response(PDF, { status: 200 })));
  assert.equal(moved.status, 200, 'a move on the publisher’s own host is followed');
  assert.deepEqual(await run(() => new Response('<html>', { status: 200 })), { status: 502, error: 'what came back is not a PDF' });
  assert.deepEqual(await run(() => new Response('gone', { status: 404 })), { status: 502, error: 'downloads.chaosium.com answered 404' });
  assert.equal((await run(() => new Response(PDF, { status: 200, headers: { 'content-length': String(30 * 1024 * 1024) } }))).error, 'the file is larger than a character sheet should be');
  assert.equal((await run(() => { throw new TypeError('network'); })).error, 'the publisher’s site could not be reached');
});

test('the relay fetches exactly the sheets the app offers', async () => {
  const { SOURCES, ORIGINS } = await relay();
  const app = require('../scripts/sheetdownload').SOURCES;
  assert.deepEqual([...SOURCES].sort(), Object.values(app).map((s) => s.url).sort());
  assert.ok(ORIGINS.includes(SITE));
});
