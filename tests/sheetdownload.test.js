'use strict';
// "Get it from the publisher": only sheets from the fixed table, only from the
// publisher's own host, capped, and only a PDF is kept. Hermetic: every
// "fetch" here is a fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SOURCES, listSources, downloadSheet } = require('../scripts/sheetdownload');

const PDF = Buffer.from('%PDF-1.7\n% a sheet\n');
function fakeResponse(status, chunks = [], headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, body: (async function* () { yield* chunks; })() };
}
const fetchOnce = (...responses) => {
  const calls = [];
  const impl = async (url, opts) => { calls.push({ url, opts }); return responses.shift(); };
  return { calls, impl };
};

test('the dialog learns which sheets exist, never their URLs', () => {
  const listed = listSources();
  assert.deepEqual(listed.map((s) => s.id), Object.keys(SOURCES));
  for (const s of listed) {
    assert.equal(s.url, undefined);
    assert.ok(['media.dndbeyond.com', 'downloads.chaosium.com'].includes(s.host), s.host);
  }
  assert.equal(listed.some((s) => s.system === 'vtm5'), false, 'Renegade hands out V5 through a store checkout');
});

test('a sheet downloads from the publisher and must be a PDF', async () => {
  const ok = fetchOnce(fakeResponse(200, [PDF.subarray(0, 5), PDF.subarray(5)], { 'content-length': PDF.length }));
  const got = await downloadSheet('coc7-chaosium-modern', { fetchImpl: ok.impl, version: '9.9.9' });
  assert.deepEqual(got.bytes, PDF);
  assert.equal(got.fileName, 'CoC7_Investigator_Sheet_Modern_autocalc.pdf');
  assert.equal(got.source.system, 'coc7');
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, SOURCES['coc7-chaosium-modern'].url);
  assert.equal(ok.calls[0].opts.redirect, 'manual');
  assert.equal(ok.calls[0].opts.headers['User-Agent'], 'MundusMaker/9.9.9');

  const html = fetchOnce(fakeResponse(200, [Buffer.from('<html>moved</html>')]));
  await assert.rejects(downloadSheet('dnd2024-wotc', { fetchImpl: html.impl }), /not a PDF/);
  const missing = fetchOnce(fakeResponse(404));
  await assert.rejects(downloadSheet('dnd2024-wotc', { fetchImpl: missing.impl }), /answered 404.*add the PDF/);
});

test('unknown sheets, other hosts and oversized files are refused', async () => {
  const none = fetchOnce();
  for (const id of ['vtm5-renegade', 'https://example.com/x.pdf', '__proto__', 'constructor']) {
    await assert.rejects(downloadSheet(id, { fetchImpl: none.impl }), (err) => err.status === 400, id);
  }
  assert.equal(none.calls.length, 0, 'nothing is fetched for a sheet outside the table');

  const away = fetchOnce(fakeResponse(302, [], { location: 'https://evil.example/sheet.pdf' }));
  await assert.rejects(downloadSheet('dnd2024-wotc', { fetchImpl: away.impl }), /has moved/);
  assert.equal(away.calls.length, 1, 'a redirect off the publisher host is not followed');
  const plain = fetchOnce(fakeResponse(301, [], { location: 'http://media.dndbeyond.com/x.pdf' }));
  await assert.rejects(downloadSheet('dnd2024-wotc', { fetchImpl: plain.impl }), /has moved/);
  const home = fetchOnce(fakeResponse(302, [], { location: '/compendium-images/new/sheet.pdf' }), fakeResponse(200, [PDF]));
  const moved = await downloadSheet('dnd2024-wotc', { fetchImpl: home.impl });
  assert.equal(home.calls[1].url, 'https://media.dndbeyond.com/compendium-images/new/sheet.pdf');
  assert.equal(moved.fileName, 'sheet.pdf');

  const declared = fetchOnce(fakeResponse(200, [PDF], { 'content-length': 999 }));
  await assert.rejects(downloadSheet('dnd2024-wotc', { fetchImpl: declared.impl, maxBytes: 100 }), /larger/);
  const streamed = fetchOnce(fakeResponse(200, [PDF, Buffer.alloc(200)]));
  await assert.rejects(downloadSheet('dnd2024-wotc', { fetchImpl: streamed.impl, maxBytes: 100 }), /larger/);
});

test('a publisher that never answers times out with a plain message', async () => {
  const hang = (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(downloadSheet('coc7-chaosium-1920s', { fetchImpl: hang, timeoutMs: 50 }), /took too long/);
});

test('a refusal from the website relay says why, and a lost connection says so', async () => {
  // web/engine.js rejects with `why` when the website's relay refuses a sheet
  const refused = async () => { throw Object.assign(new Error('the download helper: limit'), { why: 'you have downloaded publisher sheets many times today; try again tomorrow' }); };
  await assert.rejects(downloadSheet('coc7-chaosium-1920s', { fetchImpl: refused }),
    /Chaosium's sheet could not be downloaded \(you have downloaded publisher sheets many times today; try again tomorrow\)\./);
  const offline = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(downloadSheet('coc7-chaosium-1920s', { fetchImpl: offline }), /\(no connection\)/);
});
