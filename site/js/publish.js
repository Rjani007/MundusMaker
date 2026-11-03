// The publish page: sign in, pick the ZIP from MundusMaker's Export player
// wiki, and get a link for the players. Pictures are shrunk here before they
// are uploaded (Supabase's free plan has 1 GB of storage for everyone).

import { restore, signIn, signUp, signOut, user, wikis, files } from './supa.js';
import { readZip } from './zip.js';
import { LIMITS, isImage, mb, newWikiId, pageTitle, planWiki, storedAs } from './wikifile.js';

const app = document.getElementById('app');
const siteRoot = new URL('../', location.href);
const linkFor = (id) => new URL(`wiki/?w=${id}`, siteRoot).href;
const MAX_SIDE = 2400;

let list = [], used = 0, prepared = null, target = null, note = null, busy = false;

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return node;
}

function render() {
  app.replaceChildren(user() ? signedIn() : signInForm());
}

function setNote(next) {
  note = next;
  render();
}

async function refresh() {
  if (!user()) return render();
  try {
    [list, used] = await Promise.all([wikis.list(), wikis.bytesUsed()]);
  } catch (err) {
    note = { error: err.message };
  }
  render();
}

// ---------- signing in ----------

function signInForm() {
  const email = el('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
  const password = el('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true, minlength: '6' });
  const msg = el('p', { class: 'msg', role: 'status' });
  const go = (action, waiting) => async (ev) => {
    ev.preventDefault();
    if (!email.value.trim() || !password.value) { msg.textContent = 'Enter your email and a password.'; return; }
    msg.textContent = waiting;
    try {
      await action(email.value.trim(), password.value);
      note = null;
      await refresh();
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  return el('form', { class: 'card', onsubmit: go(signIn, 'Signing in…') },
    el('h2', {}, 'Sign in'),
    el('label', { for: 'email' }, 'Email'), email,
    el('label', { for: 'password' }, 'Password'), password,
    el('div', { class: 'row' },
      el('button', { type: 'submit', class: 'primary' }, 'Sign in'),
      el('button', { type: 'button', onclick: go(signUp, 'Making your account…') }, 'Create an account')),
    msg);
}

// ---------- signed in ----------

function signedIn() {
  return el('div', {},
    el('p', { class: 'who' }, 'Signed in as ', el('b', {}, user().email || 'you'), ' ',
      el('button', { class: 'link', onclick: async () => { await signOut(); list = []; prepared = null; target = null; note = null; render(); } }, 'Sign out')),
    publishCard(),
    yourWikis());
}

function noteView() {
  if (!note) return null;
  if (note.error) return el('p', { class: 'msg error', role: 'alert' }, note.error);
  return el('div', { class: 'msg', role: 'status' }, note.text, note.link ? linkBox(note.link) : null);
}

function linkBox(link) {
  const field = el('input', { type: 'text', readonly: true, value: link, onfocus: (ev) => ev.target.select() });
  return el('div', { class: 'row linkbox' }, field, el('button', { class: 'primary', onclick: () => copy(link) }, 'Copy link'));
}

async function copy(link) {
  try {
    await navigator.clipboard.writeText(link);
    setNote({ text: 'Link copied. Paste it wherever your players will see it.', link });
  } catch {
    setNote({ text: 'Copy this link for your players:', link });
  }
}

function publishCard() {
  const full = !target && list.length >= LIMITS.wikis;
  const input = el('input', {
    type: 'file', accept: '.zip,application/zip', disabled: busy,
    onchange: () => { if (input.files[0]) prepare(input.files[0]); },
  });
  return el('section', { class: 'card' },
    el('h2', {}, target ? `Update “${target.title || 'wiki'}”` : 'Publish a player wiki'),
    target ? el('p', { class: 'muted' }, 'Pick the new ZIP. The link stays the same.') : null,
    full ? el('p', { class: 'muted' }, `You have ${LIMITS.wikis} wikis online, the most allowed. Unpublish one to add another.`)
      : prepared ? summary()
        : el('label', { class: 'file' }, input, el('span', { class: 'button' }, 'Pick the ZIP…')),
    noteView(),
    target && !prepared && !busy ? el('button', { onclick: () => { target = null; note = null; render(); } }, 'Cancel') : null);
}

function summary() {
  const p = prepared;
  const replacing = target ? Number(list.find((w) => w.id === target.id)?.bytes) || 0 : 0;
  const after = Math.max(0, used - replacing) + p.bytes;
  const over = after > LIMITS.bytes;
  return el('div', {},
    el('p', {}, el('b', {}, p.title), `: ${p.pages} pages, ${p.images} pictures, ${mb(p.bytes)}.`),
    over ? el('p', { class: 'msg error' }, `That would use ${mb(after)} of your ${mb(LIMITS.bytes)}. Unpublish a wiki, or leave some maps or handouts out when you export.`) : null,
    el('div', { class: 'row' },
      el('button', { class: 'primary', disabled: over || busy, onclick: publish }, target ? 'Update' : 'Publish'),
      el('button', { disabled: busy, onclick: () => { prepared = null; note = null; render(); } }, 'Cancel')));
}

// ---------- reading the ZIP ----------

/** Big pictures are scaled down, and WebP replaces PNG or JPEG when it is smaller. */
async function shrink(bytes, path) {
  const type = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const original = new Blob([bytes], { type });
  try {
    const bitmap = await createImageBitmap(original);
    const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const encode = (as, quality) => new Promise((resolve) => canvas.toBlob(resolve, as, quality));
    let out = await encode('image/webp', 0.85);
    // a browser without a WebP encoder hands back a PNG
    if (!out || out.type !== 'image/webp') out = k < 1 ? await encode(type, 0.85) : null;
    canvas.width = canvas.height = 1;
    if (out && (k < 1 || out.size < original.size)) return out;
  } catch { /* not a picture this browser can draw: keep it as it is */ }
  return original;
}

async function prepare(file) {
  setNote({ text: 'Reading the ZIP…' });
  try {
    if (file.size > 200 * 1024 * 1024) throw new Error('This file is too large to be a player wiki.');
    const plan = planWiki(await readZip(file));
    if (plan.problems.length) throw new Error(plan.problems[0]);
    const out = [];
    for (const [i, f] of plan.files.entries()) {
      if (i % 10 === 0) setNote({ text: `Preparing ${i + 1} of ${plan.files.length}…` });
      if (f.entry.size > 64 * 1024 * 1024) throw new Error(`${f.path} is too large.`);
      const bytes = await f.entry.bytes();
      const blob = isImage(f.path) ? await shrink(bytes, f.path) : new Blob([bytes], { type: storedAs(f.path).contentType });
      if (blob.size > LIMITS.fileBytes) throw new Error(`${f.path} is still larger than ${mb(LIMITS.fileBytes)} after shrinking.`);
      out.push({ path: f.path, blob });
    }
    const contents = out.find((f) => f.path === 'index.html');
    prepared = {
      title: (pageTitle(await contents.blob.text()) || file.name.replace(/\.zip$/i, '')).slice(0, 200),
      files: out,
      bytes: out.reduce((n, f) => n + f.blob.size, 0),
      pages: out.filter((f) => f.path.endsWith('.html')).length,
      images: out.filter((f) => isImage(f.path)).length,
    };
    setNote(null);
  } catch (err) {
    prepared = null;
    setNote({ error: err.message });
  }
}

// ---------- publishing ----------

/** What is stored for a wiki now: Map(path within the wiki → size). */
async function storedFiles(id) {
  const found = new Map();
  for (const [folder, prefix] of [[id, ''], [`${id}/assets`, 'assets/'], [`${id}/images`, 'images/']]) {
    for (let offset = 0; ; offset += 1000) {
      const page = (await files.list(folder, offset)) || [];
      for (const item of page) if (item.id) found.set(prefix + item.name, Number(item.metadata?.size) || 0);
      if (page.length < 1000) break;
    }
  }
  return found;
}

async function inParallel(items, lanes, work) {
  let next = 0, failed = null;
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (err) { failed = failed || err; }
    }
  }));
  if (failed) throw failed;
}

// pictures first, then the pages that show them, the contents page last
const rank = (path) => (isImage(path) ? 0 : path.startsWith('assets/') ? 1 : path === 'index.html' ? 3 : 2);

async function publish() {
  const p = prepared;
  if (!p || busy) return;
  busy = true;
  const id = target?.id || newWikiId();
  const row = { title: p.title, pages: p.pages, images: p.images, bytes: p.bytes, published_at: new Date().toISOString() };
  try {
    setNote({ text: 'Starting…' });
    if (target) await wikis.update(id, row);
    else await wikis.add({ id, ...row });
    const have = target ? await storedFiles(id) : new Map();
    // a picture's name is a hash of the original, so one already stored is the same picture
    const todo = p.files.filter((f) => !(isImage(f.path) && have.has(f.path))).sort((a, b) => rank(a.path) - rank(b.path));
    let done = 0;
    for (const step of [0, 1, 2, 3]) {
      await inParallel(todo.filter((f) => rank(f.path) === step), 4, async (f) => {
        await files.upload(`${id}/${f.path}`, f.blob, { ...storedAs(f.path), contentType: storedAs(f.path).contentType || f.blob.type });
        done++;
        if (done % 5 === 0 || done === todo.length) setNote({ text: `Uploading ${done} of ${todo.length}…` });
      });
    }
    const keep = new Set(p.files.map((f) => f.path));
    const stale = [...have.keys()].filter((path) => !keep.has(path)).map((path) => `${id}/${path}`);
    for (let i = 0; i < stale.length; i += 100) await files.remove(stale.slice(i, i + 100));
    prepared = null;
    target = null;
    note = { text: 'It\'s online. Send your players this link:', link: linkFor(id) };
  } catch (err) {
    note = { error: `Publishing stopped: ${err.message} Try again, or unpublish it below.` };
  }
  busy = false;
  await refresh();
}

async function unpublish(w) {
  if (!confirm(`Take “${w.title || 'this wiki'}” offline? The link will stop working for your players.`)) return;
  busy = true;
  setNote({ text: 'Taking it offline…' });
  try {
    const paths = [...(await storedFiles(w.id)).keys()].map((path) => `${w.id}/${path}`);
    for (let i = 0; i < paths.length; i += 100) await files.remove(paths.slice(i, i + 100));
    // the row goes last: without it, its files could no longer be removed
    await wikis.remove(w.id);
    if (target?.id === w.id) { target = null; prepared = null; }
    note = { text: `“${w.title || 'The wiki'}” is offline.` };
  } catch (err) {
    note = { error: err.message };
  }
  busy = false;
  await refresh();
}

function yourWikis() {
  if (!list.length) return el('p', { class: 'muted' }, 'You have no wikis online yet.');
  return el('section', { class: 'card' },
    el('h2', {}, 'Your wikis'),
    el('p', { class: 'muted' }, `Using ${mb(used)} of ${mb(LIMITS.bytes)}, and ${list.length} of ${LIMITS.wikis} wikis.`),
    el('ul', { class: 'wikis' }, list.map((w) => el('li', {},
      el('div', {}, el('b', {}, w.title || 'Untitled'),
        el('span', { class: 'muted' }, ` · ${new Date(w.published_at).toLocaleDateString()} · ${mb(Number(w.bytes) || 0)}`)),
      el('div', { class: 'row' },
        el('a', { class: 'button', href: linkFor(w.id), target: '_blank', rel: 'noopener' }, 'Open'),
        el('button', { onclick: () => copy(linkFor(w.id)) }, 'Copy link'),
        el('button', { disabled: busy, onclick: () => { target = w; prepared = null; note = null; render(); scrollTo(0, 0); } }, 'Update'),
        el('button', { class: 'danger', disabled: busy, onclick: () => unpublish(w) }, 'Unpublish'))))));
}

(async () => {
  await restore();
  await refresh();
})();
