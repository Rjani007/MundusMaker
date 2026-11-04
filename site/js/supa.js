// A small Supabase client for the website: email sign-in, the wikis table and
// the wikis bucket. It speaks the same REST API that supabase-js does, with
// fetch, so the site loads no third-party code.

import { config } from '../config.js';

// rjani007.github.io also serves Elysium, so the session key names this site
const KEY = 'mundusmaker-site.session';
let session = null;

function friendly(status, info) {
  const text = String(info.msg || info.message || info.error_description || info.error || '');
  if (/invalid login credentials/i.test(text)) return 'Wrong email or password.';
  if (/already registered|already exists/i.test(text) && status !== 409) return 'That email already has an account. Sign in instead.';
  if (/password/i.test(text) && /at least|characters|weak/i.test(text)) return 'Choose a password of at least 6 characters.';
  if (/email/i.test(text) && /invalid/i.test(text)) return 'That email address doesn\'t look right.';
  if (/signups not allowed|signup.*disabled/i.test(text)) return 'New accounts are switched off. Ask the site owner.';
  if (/row-level security|violates row-level/i.test(text)) return 'The site refused this file. You may have reached your storage allowance.';
  if (/payload too large|maximum allowed size|entity too large/i.test(text) || status === 413) return 'A file is too large.';
  if (/mime type|content type/i.test(text)) return 'A file has a type the site doesn\'t accept.';
  if (/jwt expired|invalid jwt|not authenticated/i.test(text) || status === 401) return 'Your sign-in expired. Please sign in again.';
  if (/rate limit/i.test(text) || status === 429) return 'Too many tries. Wait a minute and try again.';
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : `The server answered ${status}.`;
}

async function request(path, { method = 'GET', json, body, headers = {}, signedIn = true } = {}) {
  const h = { apikey: config.key, ...headers };
  if (signedIn && session) h.Authorization = `Bearer ${session.access_token}`;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try {
    res = await fetch(config.url + path, { method, headers: h, body });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) throw Object.assign(new Error(friendly(res.status, data || {})), { status: res.status });
  return data;
}

function keep(next) {
  session = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch { /* private window: the sign-in lasts for this page only */ }
}

function fromToken(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    user: { id: data.user?.id, email: data.user?.email },
  };
}

async function refresh() {
  const data = await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', json: { refresh_token: session.refresh_token }, signedIn: false,
  });
  keep(fromToken(data));
}

/** A fresh token before every signed-in call: they last an hour. */
async function fresh() {
  if (!session) throw new Error('Please sign in first.');
  if (session.expires_at - 60 < Date.now() / 1000) {
    // unreachable is not signed out: only the account refusing the refresh ends the sign-in
    try { await refresh(); } catch (err) { if (err.status) keep(null); throw err; }
  }
}

const authed = async (path, options) => { await fresh(); return request(path, options); };

export const user = () => session?.user || null;

/**
 * The saved sign-in, if it can still be used. With keepOffline, a refresh
 * that fails only because the account can't be reached keeps the sign-in:
 * the app in the browser works offline on the worlds this browser has.
 */
export async function restore({ keepOffline = false } = {}) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* none */ }
  if (!saved?.refresh_token) return null;
  session = saved;
  try { await fresh(); return user(); } catch (err) {
    if (keepOffline && !err.status && session) return user();
    keep(null);
    return null;
  }
}

/** A current access token for the app's engine (web/engine.js), refreshed when asked or near expiry. */
export async function token({ refresh: force = false } = {}) {
  if (!session) throw Object.assign(new Error('Please sign in first.'), { status: 401 });
  if (force) {
    try { await refresh(); } catch (err) { if (err.status) keep(null); throw err; }
  } else {
    await fresh();
  }
  return { access_token: session.access_token, expires_at: session.expires_at, user: session.user };
}

export async function signIn(email, password) {
  keep(fromToken(await request('/auth/v1/token?grant_type=password', { method: 'POST', json: { email, password }, signedIn: false })));
  return user();
}

export async function signUp(email, password) {
  const data = await request('/auth/v1/signup', { method: 'POST', json: { email, password }, signedIn: false });
  // with email confirmation on, there is no session until the GM clicks the link
  if (!data?.access_token) throw new Error('Check your email for a link to confirm the account, then sign in.');
  keep(fromToken(data));
  return user();
}

export async function signOut() {
  try { await fresh(); await request('/auth/v1/logout', { method: 'POST' }); } catch { /* signed out anyway */ }
  keep(null);
}

// ---------- the wikis table ----------

export const wikis = {
  list: () => authed('/rest/v1/wikis?select=*&order=published_at.desc'),
  add: (row) => authed('/rest/v1/wikis', { method: 'POST', json: row, headers: { Prefer: 'return=minimal' } }),
  update: (id, row) => authed(`/rest/v1/wikis?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', json: row, headers: { Prefer: 'return=minimal' } }),
  remove: (id) => authed(`/rest/v1/wikis?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  bytesUsed: () => authed('/rest/v1/rpc/wiki_bytes_used', { method: 'POST', json: {} }),
};

// ---------- the wikis bucket ----------

const objectPath = (path) => path.split('/').map(encodeURIComponent).join('/');

export const files = {
  publicUrl: (path) => `${config.url}/storage/v1/object/public/wikis/${objectPath(path)}`,
  /** One folder's files: [{ name, metadata: { size } }]; sub-folders come back with id null. */
  list: (folder, offset = 0) => authed('/storage/v1/object/list/wikis', {
    method: 'POST', json: { prefix: folder, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } },
  }),
  // Saving never sends the file back, so nothing is downloaded twice.
  upload: (path, blob, { contentType, cacheSeconds }) => authed(`/storage/v1/object/wikis/${objectPath(path)}`, {
    method: 'POST', body: blob,
    headers: { 'Content-Type': contentType || blob.type, 'cache-control': `max-age=${cacheSeconds}`, 'x-upsert': 'true' },
  }),
  remove: (paths) => authed('/storage/v1/object/wikis', { method: 'DELETE', json: { prefixes: paths } }),
};
