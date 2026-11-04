// The website's relay for publishers' free character sheets (docs/website.md).
//
// In the browser, the Official sheet dialog's "Get it from…" can't fetch a
// publisher's PDF itself: the publishers' servers don't let other websites
// read their files. This fetches one sheet from the fixed list below for a
// signed-in GM and passes it straight back. It keeps no copy, because the
// publishers allow their sheets for personal use only (AGENTS.md, Official
// sheets), and it fetches nothing else. SOURCES must match the urls in
// scripts/sheetdownload.js; tests/site.test.js compares them.
//
// A plain ES module with no imports (.mjs, since the repo's package.json makes
// .js CommonJS): index.js serves it on Deno, and tests/sheet-relay.test.js
// runs it in Node with a fake fetch.

export const SOURCES = [
  'https://media.dndbeyond.com/compendium-images/free-rules/ph/character-sheet.pdf',
  'https://downloads.chaosium.com/call-of-cthulhu/cha2300-investigator-sheets/CoC7_Investigator_Sheet_Standard_autocalc.pdf',
  'https://downloads.chaosium.com/call-of-cthulhu/cha2300-investigator-sheets/CoC7_Investigator_Sheet_Modern_autocalc.pdf',
];
// the website, and `npm run site` for local work
export const ORIGINS = ['https://rjani007.github.io', 'http://localhost:4895', 'http://127.0.0.1:4895'];
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * fetchImpl   the platform's fetch
 * supabaseUrl the project's own address, for the GM's sign-in and allowance
 */
export function createHandler({ fetchImpl = fetch, supabaseUrl }) {
  return async function handle(req) {
    const origin = req.headers.get('origin');
    const allowed = !origin || ORIGINS.includes(origin);
    const cors = origin && allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    } : { Vary: 'Origin' };
    // `error` reads inside "the sheet could not be downloaded (…)" in the app
    const refuse = (status, error, code) => new Response(JSON.stringify({ error, code }), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });

    if (!allowed) return refuse(403, 'this helper serves the MundusMaker website only', 'origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return refuse(405, 'use POST', 'method');

    let url;
    try {
      const text = await req.text();
      if (text.length > 4096) throw new Error('too long');
      url = JSON.parse(text).url;
    } catch {
      return refuse(400, 'the request was not understood', 'request');
    }
    if (!SOURCES.includes(url)) return refuse(400, 'MundusMaker cannot download that file', 'unknown-file');

    // the GM's own sign-in and daily allowance, in one call with their own credentials
    try {
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/sheet_relay_allow`, {
        method: 'POST',
        headers: {
          apikey: req.headers.get('apikey') || '',
          Authorization: req.headers.get('authorization') || '',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (res.status === 401 || res.status === 403) return refuse(401, 'your sign-in expired; sign in again', 'auth');
      if (!res.ok) return refuse(503, 'the download helper could not check your sign-in', 'check');
      if (await res.json() !== true) return refuse(429, 'you have downloaded publisher sheets many times today; try again tomorrow', 'limit');
    } catch {
      return refuse(503, 'the download helper could not check your sign-in', 'check');
    }

    // the publisher's own file: https on its own host only, a PDF of a sane size
    const home = new URL(url).host;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let target = url;
      let res;
      for (let hop = 0; ; hop++) {
        res = await fetchImpl(target, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/pdf' } });
        if (!REDIRECTS.includes(res.status)) break;
        let next = null;
        try { next = new URL(res.headers.get('location') || '', target); } catch { /* unusable */ }
        if (hop >= 3 || !next || next.protocol !== 'https:' || next.host !== home) return refuse(502, 'the file has moved', 'moved');
        target = next.href;
      }
      if (res.status !== 200) return refuse(502, `${home} answered ${res.status}`, 'publisher');
      if (Number(res.headers.get('content-length')) > MAX_BYTES) return refuse(502, 'the file is larger than a character sheet should be', 'size');
      const chunks = [];
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { controller.abort(); return refuse(502, 'the file is larger than a character sheet should be', 'size'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.length; }
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
      if (!head.includes('%PDF-')) return refuse(502, 'what came back is not a PDF', 'not-pdf');
      return new Response(bytes, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    } catch {
      return refuse(502, controller.signal.aborted ? 'it took too long' : 'the publisher’s site could not be reached', 'publisher');
    } finally {
      clearTimeout(timer);
    }
  };
}
