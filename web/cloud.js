/*
 * The account side of sync.js: the GM's file rows and stored objects on the
 * website's Supabase project (supabase/migrations/20261104120000_world_sync.sql),
 * over the same REST API supabase-js speaks, with fetch, so the site still
 * loads no third-party code.
 *
 * getToken(refresh) asks the page for the GM's access token (the page keeps
 * the sign-in, site/js/supa.js); a 401 asks once more with refresh set.
 * Failures carry a `kind` that sync.js turns into what Settings says:
 * offline, auth, full, missing, refused or server.
 */
(function (root) {
  'use strict';

  const fail = (kind, message, status) => Object.assign(new Error(message), { kind, status });

  function kindOf(status, text) {
    if (status === 401) return 'auth';
    if (/row-level security|violates row-level/i.test(text)) return 'full'; // the upload policy refuses only over the allowance
    if (/not.?found/i.test(text) || status === 404) return 'missing';
    if (status === 413 || /too large|maximum allowed size/i.test(text)) return 'refused';
    if (status === 429 || status >= 500) return 'server';
    return 'refused';
  }

  function createCloud({ url, key, getToken, fetchImpl }) {
    const send = fetchImpl || root.fetch.bind(root);

    async function call(path, { method = 'GET', json, body, headers = {}, bytes = false } = {}) {
      for (let attempt = 0; ; attempt++) {
        const { token } = await getToken(attempt > 0);
        const h = { apikey: key, Authorization: `Bearer ${token}`, ...headers };
        let payload = body;
        if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
        let res;
        try {
          res = await send(url + path, { method, headers: h, body: payload, credentials: 'omit', cache: 'no-store' });
        } catch {
          throw fail('offline', 'could not reach your account');
        }
        if (res.status === 401 && attempt === 0) { try { await res.arrayBuffer(); } catch { /* drained */ } continue; }
        if (res.ok && bytes) return new Uint8Array(await res.arrayBuffer());
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
        if (!res.ok) {
          const message = String((data && (data.message || data.msg || data.error_description || data.error)) || `the account answered ${res.status}`);
          // an object that is already stored is as good as one stored now
          if (method === 'POST' && path.startsWith('/storage/') && (res.status === 409 || /duplicate|already exists/i.test(`${message} ${data && data.error}`))) return null;
          throw fail(kindOf(res.status, `${message} ${data && data.error ? data.error : ''}`), message, res.status);
        }
        return data;
      }
    }

    const me = async () => {
      const { user } = await getToken(false);
      if (!user || !/^[0-9a-f-]{36}$/.test(user.id || '')) throw fail('auth', 'not signed in');
      return user.id;
    };
    const object = async (sha) => `${await me()}/${sha}`;

    return {
      /** Rows changed after a revision, oldest first. */
      changes: (after, limit) => call(`/rest/v1/sync_files?select=path,sha256,size,deleted,rev,device&rev=gt.${Number(after) || 0}&order=rev.asc&limit=${limit}`),
      async upload(sha, bytes) {
        await call(`/storage/v1/object/sync/${await object(sha)}`, {
          method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'cache-control': 'max-age=31536000' },
        });
      },
      async download(sha) {
        return call(`/storage/v1/object/authenticated/sync/${await object(sha)}`, { bytes: true });
      },
      commit: (changes, device) => call('/rest/v1/rpc/sync_commit', { method: 'POST', json: { changes, device } }),
      usage: () => call('/rest/v1/rpc/sync_usage', { method: 'POST', json: {} }),
      orphans: async () => (await call('/rest/v1/rpc/sync_orphans', { method: 'POST', json: {} })) || [],
      async remove(shas) {
        const id = await me();
        for (let i = 0; i < shas.length; i += 500) {
          await call('/storage/v1/object/sync', { method: 'DELETE', json: { prefixes: shas.slice(i, i + 500).map((s) => `${id}/${s}`) } });
        }
      },
    };
  }

  const api = { createCloud };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MundusCloud = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
