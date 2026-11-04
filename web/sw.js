/*
 * The website app's service worker (docs/website.md). It does for a browser
 * tab what the phone app's native host does for its WebView: the app's
 * requests to /api/ and /assets/ go to MundusMaker's engine, which runs in
 * the page that asked (boot.js relays them to engine.js), and everything
 * else comes from the website, kept for the next visit and for working
 * offline.
 *
 * Only this app's own pages reach the engine. Navigations are never relayed
 * (a link or form on another site must not drive the app), and the app's
 * pages are served with headers that keep other sites from framing them.
 */
'use strict';

const BUILD = 'dev'; // the publish step writes the release and a hash of the app's files here
const CACHE = `mundusmaker-app-${BUILD}`;
const SCOPE = new URL(self.registration.scope);
const ANSWER_MS = 15 * 60 * 1000; // the Library download is the slowest request the app makes
const DROP = new Set(['host', 'origin', 'referer', 'cookie', 'authorization']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('mundusmaker-app-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

/** The engine route for a request, or null: /api/ and /assets/, wherever the app put them. */
function engineRoute(url) {
  if (url.origin !== self.location.origin) return null;
  let p = url.pathname;
  if (p.startsWith(SCOPE.pathname)) p = `/${p.slice(SCOPE.pathname.length)}`;
  return p.startsWith('/api/') || p.startsWith('/assets/') ? p + url.search : null;
}

const json = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function relay(ev, req, route) {
  const client = ev.clientId ? await self.clients.get(ev.clientId) : null;
  if (!client || client.type !== 'window' || !client.url.startsWith(SCOPE.href)) return json(403, 'MundusMaker answers only its own pages.');
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
  // server.js's request guard sees what a native client sends: its own host name, no origin
  const headers = [['host', 'localhost']];
  for (const [k, v] of req.headers) if (!DROP.has(k) && !k.startsWith('sec-')) headers.push([k, v]);
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => { channel.port1.onmessage = (e) => resolve(e.data); });
  client.postMessage({ type: 'mm-request', method: req.method, url: route, headers, body }, body ? [channel.port2, body] : [channel.port2]);
  let timer;
  const res = await Promise.race([answer, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ANSWER_MS); })]);
  clearTimeout(timer);
  channel.port1.close();
  if (!res) return json(504, 'MundusMaker took too long to answer. Reload the page and try again.');
  const status = Number(res.meta.status) || 500;
  const out = new Headers();
  for (const [k, v] of res.meta.headers || []) if (k.toLowerCase() !== 'content-length') { try { out.append(k, v); } catch { /* a header a Response cannot carry */ } }
  const empty = req.method === 'HEAD' || status === 204 || status === 304;
  return new Response(empty ? null : res.body, { status, headers: out });
}

async function fromSite(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const kept = await cache.match(req, { ignoreSearch: true });
    if (kept) return kept;
    throw err;
  }
}

async function page(req) {
  let res;
  try {
    res = await fromSite(req);
  } catch {
    res = await (await caches.open(CACHE)).match(new URL('./', SCOPE).href);
    if (!res) return new Response('MundusMaker needs a connection the first time it opens.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (res.type !== 'basic' || res.redirected || !res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.origin === self.location.origin && url.pathname.startsWith(SCOPE.pathname) && req.method === 'GET') ev.respondWith(page(req));
    return;
  }
  const route = engineRoute(url);
  if (route) { ev.respondWith(relay(ev, req, route)); return; }
  if (req.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith(SCOPE.pathname)) ev.respondWith(fromSite(req));
  // anything else (the account's API, other sites) goes the browser's own way
});
