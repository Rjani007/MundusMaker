'use strict';
// The publisher-sheet relay's allowance (supabase/migrations/
// 20261104150000_sheet_relay.sql) against the local Supabase stack: only
// signed-in GMs, at most 20 sheets a day each. Not part of npm test (it needs
// Docker): `npx supabase start`, then `npm run test:site-db`.
// tests/sheet-relay.test.js covers the Edge Function itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const API = process.env.SUPABASE_URL || 'http://127.0.0.1:56421';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

async function call(path, { method = 'GET', token, json } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { status: res.status, data };
}

async function newGm() {
  const r = await call('/auth/v1/signup', { method: 'POST', json: { email: `gm-${randomBytes(6).toString('hex')}@example.test`, password: 'a long test password' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.access_token;
}

test('only signed-in GMs may use the relay, twenty sheets a day each', async () => {
  const anon = await call('/rest/v1/rpc/sheet_relay_allow', { method: 'POST', json: {} });
  assert.notEqual(anon.data, true, 'nobody signed in is allowed');
  const a = await newGm(), b = await newGm();
  for (let i = 0; i < 20; i++) assert.equal((await call('/rest/v1/rpc/sheet_relay_allow', { method: 'POST', token: a, json: {} })).data, true, `download ${i + 1}`);
  assert.equal((await call('/rest/v1/rpc/sheet_relay_allow', { method: 'POST', token: a, json: {} })).data, false, 'the 21st is refused');
  assert.equal((await call('/rest/v1/rpc/sheet_relay_allow', { method: 'POST', token: b, json: {} })).data, true, 'each GM has their own allowance');
  const log = await call('/rest/v1/sheet_relay_log?select=*', { token: a });
  assert.ok(log.status >= 400 || (Array.isArray(log.data) && log.data.length === 0), 'nobody reads the log directly');
});
