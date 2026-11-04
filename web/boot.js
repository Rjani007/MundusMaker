// MundusMaker on the website (docs/website.md): the page side.
//
// The app here is the same one the desktop download runs. Its server.js runs
// in this tab, in engine.js, and the service worker (sw.js) catches the
// app's requests and hands them here to pass on. Before the app starts,
// this page makes sure of four things: the service worker is in charge, the
// GM is signed in (the website's own sign-in, site/js/supa.js), no other tab
// is running the same account's worlds, and the engine has opened them.
// Then it loads the app's own main.js.

import * as supa from '../../js/supa.js';
import { config } from '../../config.js';

const here = (file) => new URL(file, import.meta.url).href;
const SITE = new URL('../../', import.meta.url).href;
const RELEASES = 'https://github.com/Rjani007/MundusMaker/releases/latest';

let engine = null;
let engineReady = false;
let lock = null;
let account = null;
let syncStatus = { state: 'idle', message: '', pending: 0, lastSync: null };
const statusListeners = new Set();
let usageWaiters = [];
let stoppedWaiters = [];

// ---------- a few DOM helpers (the app's own el() is not loaded yet) ----------

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
  return node;
}

const gate = h('div', { id: 'webGate', class: 'web-gate' });
const card = h('div', { class: 'web-gate-card', role: 'region', 'aria-label': 'MundusMaker' });
gate.append(card);

function show(...content) {
  if (!gate.isConnected) document.body.append(gate);
  card.replaceChildren(
    h('h1', { class: 'web-gate-brand' }, h('img', { src: here('../icons/icon-192.png'), alt: '', width: 40, height: 40 }), 'MundusMaker'),
    ...content,
    h('p', { class: 'web-gate-foot' },
      h('a', { href: SITE }, 'About MundusMaker'), ' · ',
      h('a', { href: RELEASES, target: '_blank', rel: 'noopener noreferrer' }, 'Desktop download'), ' · ',
      h('a', { href: 'https://ko-fi.com/catcae', target: '_blank', rel: 'noopener noreferrer' }, '☕ Buy me a coffee')));
}
const say = (text, cls = 'muted') => h('p', { class: cls, role: 'status' }, text);

// ---------- the bar under the top bar: changes from elsewhere, storage trouble ----------

let bar = null;
function showBar(kind, text, action) {
  if (!bar) {
    bar = h('div', { id: 'webBar', class: 'restart-bar web-bar', role: 'status' });
    const topbar = document.getElementById('topbar');
    if (topbar) topbar.after(bar); else document.body.prepend(bar);
  }
  bar.dataset.kind = kind;
  bar.replaceChildren(h('span', {}, text), action || '');
  bar.hidden = false;
}
const hideBar = (kind) => { if (bar && (!kind || bar.dataset.kind === kind)) bar.hidden = true; };

async function reloadSafely() {
  try { const { flushSaves } = await import(here('../js/state.js')); await flushSaves(); } catch { /* the app shows its own save errors */ }
  location.reload();
}

// ---------- what this browser can do ----------

function missingFeature() {
  if (window.top !== window.self) return 'MundusMaker has to be opened in a tab of its own, not inside another page.';
  if (!('serviceWorker' in navigator)) return 'This browser cannot run MundusMaker here. A private window may be the reason: open it in a normal window, or use a current Chrome, Edge, Firefox or Safari.';
  if (!window.indexedDB) return 'This browser has no storage MundusMaker can use. A private window may be the reason: open it in a normal window.';
  if (typeof Worker === 'undefined') return 'This browser cannot run MundusMaker’s engine.';
  return null;
}

async function serviceWorkerReady() {
  const reg = await navigator.serviceWorker.register(here('../sw.js'), { scope: here('../') });
  if (navigator.serviceWorker.controller) return reg;
  // the first visit: wait until the worker takes this page over (sw.js claims it)
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    setTimeout(resolve, 8000);
  });
  if (!navigator.serviceWorker.controller) {
    // some browsers hand a page to a new worker only on the next load
    if (!sessionStorage.getItem('mundusmaker.web.reloaded')) {
      sessionStorage.setItem('mundusmaker.web.reloaded', '1');
      location.reload();
      await new Promise(() => {});
    }
    throw new Error('MundusMaker could not start its helper in this browser. Reload the page; if that does not help, try another browser.');
  }
  return reg;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'another system';
  return `${browser} on ${os}`;
}

// ---------- signing in ----------

function signInForm(message) {
  let creating = false;
  const email = h('input', { type: 'email', id: 'webEmail', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', id: 'webPassword', autocomplete: 'current-password', required: true, minlength: '6' });
  const msg = h('p', { class: 'msg', role: 'status' }, message || '');
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  const toggle = h('button', { type: 'button', class: 'linkish' }, 'Create an account instead');
  const title = h('h2', {}, 'Sign in to open your worlds');
  toggle.addEventListener('click', () => {
    creating = !creating;
    title.textContent = creating ? 'Create your account' : 'Sign in to open your worlds';
    submit.textContent = creating ? 'Create account' : 'Sign in';
    toggle.textContent = creating ? 'I have an account' : 'Create an account instead';
    password.setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
    msg.textContent = '';
  });
  const form = h('form', { class: 'web-gate-form', novalidate: true },
    title,
    h('label', { for: 'webEmail' }, 'Email'), email,
    h('label', { for: 'webPassword' }, 'Password'), password,
    h('div', { class: 'row' }, submit, toggle),
    msg);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!email.value.trim() || password.value.length < 6) { msg.textContent = 'Enter your email and a password of at least 6 characters.'; return; }
    submit.disabled = true;
    msg.textContent = creating ? 'Creating your account…' : 'Signing in…';
    try {
      account = creating ? await supa.signUp(email.value.trim(), password.value) : await supa.signIn(email.value.trim(), password.value);
      // ask the browser to keep this site's storage when space runs low (some ask the GM first)
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      open();
    } catch (err) {
      msg.textContent = err.message;
      submit.disabled = false;
    }
  });
  show(
    h('p', { class: 'lead' }, 'The worldbuilding wiki for game masters, in your browser.'),
    form);
  setTimeout(() => email.focus(), 0);
}

// ---------- one tab at a time ----------

const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('mundusmaker-app') : null;
const lockName = () => `mundusmaker-engine:${account.id}`;

function takeLock(wait) {
  if (!navigator.locks) return Promise.resolve({ release() {} }); // an older browser: nothing to coordinate with
  return new Promise((resolve) => {
    navigator.locks.request(lockName(), wait ? {} : { ifAvailable: true }, (held) => {
      if (!held) { resolve(null); return undefined; }
      return new Promise((release) => resolve({ release }));
    });
  });
}

if (tabs) {
  tabs.addEventListener('message', async (ev) => {
    const m = ev.data || {};
    if (m.type !== 'release' || !account || m.account !== account.id || !lock) return;
    // another tab of this account asked for the worlds: save, stop, and say where they went
    await stopEngine();
    const held = lock;
    lock = null;
    show(h('h2', {}, 'MundusMaker moved to another tab'),
      say('You opened your worlds in another tab, so this one stopped to keep the two from overwriting each other.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => location.reload() }, 'Use them here instead')));
    document.body.classList.remove('mm-ready');
    held.release();
  });
}

async function holdWorlds() {
  lock = await takeLock(false);
  if (lock) return;
  await new Promise((resolve) => {
    show(h('h2', {}, 'MundusMaker is open in another tab'),
      say('Your worlds can be open in one tab at a time, so changes never overwrite each other.'),
      h('div', { class: 'row' }, h('button', {
        class: 'primary',
        onclick: async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = 'Asking the other tab…';
          tabs?.postMessage({ type: 'release', account: account.id });
          lock = await takeLock(true);
          resolve();
        },
      }, 'Use them in this tab')));
  });
}

// ---------- the engine ----------

function stopEngine() {
  if (!engine) return Promise.resolve();
  return new Promise((resolve) => {
    stoppedWaiters.push(resolve);
    engine.postMessage({ type: 'stop' });
    setTimeout(resolve, 5000);
  }).then(() => { if (engine) engine.terminate(); engine = null; engineReady = false; });
}

function setStatus(next) {
  syncStatus = next;
  for (const fn of statusListeners) { try { fn(syncStatus); } catch { /* a view that went away */ } }
}

async function onEngineMessage(ev) {
  const m = ev.data || {};
  if (m.type === 'progress') {
    if (!engineReady) show(say(m.message));
  } else if (m.type === 'ready') {
    engineReady = true;
    if (m.sync) setStatus(m.sync);
    loadApp();
  } else if (m.type === 'fatal') {
    show(h('h2', {}, 'MundusMaker could not open your worlds'), say(m.message, 'msg error'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => location.reload() }, 'Try again'),
        h('button', { onclick: () => signOut({ forget: false }) }, 'Sign out')));
  } else if (m.type === 'token-request') {
    try {
      const t = await supa.token({ refresh: !!m.refresh });
      engine?.postMessage({ type: 'token', token: t.access_token, expiresAt: t.expires_at, user: t.user });
    } catch (err) {
      engine?.postMessage({ type: 'token', token: null, message: err.message, offline: !err.status });
    }
  } else if (m.type === 'sync') {
    if (m.status) setStatus(m.status);
    if (m.event === 'changed' && m.count && engineReady) {
      showBar('changed', `Changes to your worlds arrived from another browser (${m.count} file${m.count === 1 ? '' : 's'}).`,
        h('button', { class: 'ghost small', onclick: reloadSafely }, 'Reload to see them'));
    }
  } else if (m.type === 'storage') {
    if (m.ok) hideBar('storage');
    else showBar('storage', m.message, h('a', { href: '#/settings', class: 'ghost small' }, 'Open Settings'));
  } else if (m.type === 'usage') {
    const list = usageWaiters;
    usageWaiters = [];
    list.forEach((fn) => fn(m.usage || null));
  } else if (m.type === 'stopped') {
    const list = stoppedWaiters;
    stoppedWaiters = [];
    list.forEach((fn) => fn());
  } else if (m.type === 'exit') {
    // server.js asked to stop; on the website that means starting again, unless it keeps happening
    const recent = JSON.parse(sessionStorage.getItem('mundusmaker.web.exits') || '[]').filter((t) => Date.now() - t < 60000);
    recent.push(Date.now());
    sessionStorage.setItem('mundusmaker.web.exits', JSON.stringify(recent));
    if (recent.length < 3) location.reload();
    else show(h('h2', {}, 'MundusMaker keeps stopping'), say('Your worlds are kept in this browser. Reload the page to try again, and if this goes on, download a backup from Settings first.', 'msg error'));
  }
}

function startEngine(manifest) {
  engine = new Worker(here('engine.js'));
  engine.addEventListener('message', onEngineMessage);
  engine.addEventListener('error', (ev) => {
    if (!engineReady) show(h('h2', {}, 'MundusMaker could not start'), say(ev.message || 'The engine did not load.', 'msg error'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => location.reload() }, 'Try again')));
  });
  engine.postMessage({
    type: 'start',
    config: {
      dbName: `mundusmaker:${account.id}`,
      bundleUrl: here('bundle/'),
      manifest,
      version: manifest.version,
      device: deviceLabel(),
      cloud: { url: config.url, key: config.key },
    },
  });
}

// The service worker's requests for the engine arrive here.
navigator.serviceWorker?.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type !== 'mm-request') return;
  const port = ev.ports[0];
  if (!port) return;
  if (!engine || !engineReady) {
    const body = new TextEncoder().encode(JSON.stringify({ error: 'MundusMaker is not running in this tab.' })).buffer;
    port.postMessage({ meta: { status: 503, headers: [['content-type', 'application/json; charset=utf-8']] }, body }, [body]);
    return;
  }
  engine.postMessage({ type: 'request', method: m.method, url: m.url, headers: m.headers, body: m.body }, m.body ? [port, m.body] : [port]);
});
navigator.serviceWorker?.startMessages?.();

// a newer release took over the service worker while this tab ran the old one
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (engineReady) showBar('update', 'A new version of MundusMaker is ready.', h('button', { class: 'ghost small', onclick: reloadSafely }, 'Reload to use it'));
});
document.addEventListener('visibilitychange', () => engine?.postMessage({ type: 'visible', visible: document.visibilityState === 'visible' }));
window.addEventListener('online', () => engine?.postMessage({ type: 'sync-now' }));

// ---------- what the app sees of all this (settings.js, main.js) ----------

async function signOut({ forget = false } = {}) {
  await stopEngine();
  await supa.signOut();
  if (forget && account) {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(`mundusmaker:${account.id}`);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
  if (lock) lock.release();
  lock = null;
  location.reload();
}

window.mundusWeb = {
  get user() { return account ? { email: account.email } : null; },
  device: deviceLabel(),
  status: () => syncStatus,
  onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
  syncNow() { engine?.postMessage({ type: 'sync-now' }); },
  usage() {
    return new Promise((resolve) => {
      usageWaiters.push(resolve);
      engine?.postMessage({ type: 'usage' });
      setTimeout(() => resolve(null), 15000);
    });
  },
  signOut,
  releases: RELEASES,
  // Whether this browser promised to keep its copy when space runs low
  // (persistent storage): true, false, or null when it can't say. Sign-in asks
  // once; Settings asks again on a click, which browsers that ask people need.
  storage: {
    persisted: () => (navigator.storage?.persisted ? navigator.storage.persisted().catch(() => null) : Promise.resolve(null)),
    persist: () => (navigator.storage?.persist ? navigator.storage.persist().catch(() => false) : Promise.resolve(false)),
  },
};

function loadApp() {
  hideBar();
  gate.remove();
  document.body.classList.add('mm-ready');
  if (document.querySelector('script[data-mundus-main]')) return;
  document.body.append(h('script', { type: 'module', src: here('../js/main.js'), 'data-mundus-main': '' }));
}

// ---------- start ----------

async function open() {
  try {
    await holdWorlds();
    show(say('Opening your worlds…'));
    const res = await fetch(here('bundle/manifest.json'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`the app’s files did not load (${res.status})`);
    startEngine(await res.json());
  } catch (err) {
    show(h('h2', {}, 'MundusMaker could not start'), say(err.message, 'msg error'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => location.reload() }, 'Try again')));
  }
}

(async () => {
  const problem = missingFeature();
  if (problem) { show(say(problem, 'msg error')); return; }
  show(say('Loading…'));
  try { await serviceWorkerReady(); } catch (err) { show(say(err.message, 'msg error')); return; }
  sessionStorage.removeItem('mundusmaker.web.reloaded');
  account = await supa.restore({ keepOffline: true });
  if (!account) { signInForm(); return; }
  open();
})();
