'use strict';
// Check for updates: no request without a configured feed, one GET to GitHub's
// API when there is one, nothing but github.com links shown, and the server's
// own modules always shipped. Hermetic: every "fetch" here is a fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { feedFor, compareVersions, summarizeRelease, checkForUpdates } = require('../scripts/updates');

const ROOT = path.resolve(__dirname, '..');

function fakeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => text, body: null };
}

test('the feed comes only from a GitHub repository in package.json', () => {
  assert.equal(feedFor({}), null);
  assert.equal(feedFor({ repository: '' }), null);
  assert.equal(feedFor({ repository: 'https://gitlab.com/a/b' }), null);
  const api = 'https://api.github.com/repos/someone/mundusmaker/releases/latest';
  assert.equal(feedFor({ repository: 'github:someone/mundusmaker' }), api);
  assert.equal(feedFor({ repository: { type: 'git', url: 'git+https://github.com/someone/mundusmaker.git' } }), api);
  assert.equal(feedFor({ repository: 'https://github.com/someone/mundusmaker' }), api);
  assert.equal(feedFor({ repository: 'git@github.com:someone/mundusmaker.git' }), api);
});

test('versions compare numerically and releases outrank pre-releases', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('v2.0.0', '1.99.0') > 0);
  assert.equal(compareVersions('2.0.0', 'v2.0.0'), 0);
  assert.ok(compareVersions('2.0.0', '2.0.0-beta.2') > 0);
  assert.ok(compareVersions('2.0.0-beta.10', '2.0.0-beta.2') > 0);
  assert.equal(compareVersions('nonsense', '1.0.0'), 0);
});

test('without a configured feed the check makes no request', async () => {
  let calls = 0;
  const result = await checkForUpdates({ pkg: { version: '1.8.2' }, current: '1.8.2', fetchImpl: async () => { calls++; } });
  assert.deepEqual(result, { configured: false, current: '1.8.2' });
  assert.equal(calls, 0);
});

test('a newer release is reported with only a github.com link', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return fakeResponse(200, { tag_name: 'v2.0.0', name: 'MundusMaker 2.0', html_url: 'https://github.com/someone/mundusmaker/releases/tag/v2.0.0', published_at: '2027-01-01T00:00:00Z', body: 'Notes' });
  };
  const result = await checkForUpdates({ pkg: { repository: 'github:someone/mundusmaker' }, current: '1.8.2', fetchImpl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.github.com/repos/someone/mundusmaker/releases/latest');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.match(seen[0].init.headers['User-Agent'], /^MundusMaker\/1\.8\.2$/);
  assert.equal(result.newer, true);
  assert.equal(result.latest, '2.0.0');
  assert.equal(result.release.url, 'https://github.com/someone/mundusmaker/releases/tag/v2.0.0');

  const same = await checkForUpdates({ pkg: { repository: 'github:someone/mundusmaker' }, current: '2.0.0', fetchImpl });
  assert.equal(same.newer, false);
});

test('release pages outside github.com are never offered as links', () => {
  assert.equal(summarizeRelease({ tag_name: '2.0.0', html_url: 'javascript:alert(1)' }).url, null);
  assert.equal(summarizeRelease({ tag_name: '2.0.0', html_url: 'https://evil.example/release' }).url, null);
  assert.equal(summarizeRelease({ tag_name: '2.0.0', html_url: 'http://github.com/a/b' }).url, null);
  assert.throws(() => summarizeRelease({ tag_name: 'latest' }), /version number/);
});

test('redirects stay on api.github.com, and failures read plainly', async () => {
  const pkg = { repository: 'github:someone/mundusmaker' };
  const away = async () => fakeResponse(301, '', { location: 'https://elsewhere.example/feed' });
  await assert.rejects(checkForUpdates({ pkg, current: '1.0.0', fetchImpl: away }), /redirected somewhere/);
  let hops = 0;
  const moved = async (url) => (hops++ === 0
    ? fakeResponse(301, '', { location: 'https://api.github.com/repositories/42/releases/latest' })
    : fakeResponse(200, { tag_name: '1.0.1', html_url: 'https://github.com/x/y/releases/tag/1.0.1' }));
  assert.equal((await checkForUpdates({ pkg, current: '1.0.0', fetchImpl: moved })).latest, '1.0.1');
  assert.equal((await checkForUpdates({ pkg, current: '1.0.0', fetchImpl: async () => fakeResponse(404, {}) })).latest, null);
  await assert.rejects(checkForUpdates({ pkg, current: '1.0.0', fetchImpl: async () => fakeResponse(403, {}) }), /limiting requests/);
  await assert.rejects(checkForUpdates({ pkg, current: '1.0.0', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), /Could not reach/);
  await assert.rejects(checkForUpdates({ pkg, current: '1.0.0', fetchImpl: async () => fakeResponse(200, 'x'.repeat(600 * 1024)) }), /more data/);
  const slow = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(checkForUpdates({ pkg, current: '1.0.0', fetchImpl: slow, timeoutMs: 20 }), /did not answer in time/);
});

test('every script server.js requires ships in the ZIP and the Docker image', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const required = [...server.matchAll(/require\('\.\/(scripts\/[\w-]+)'\)/g)].map((m) => `${m[1]}.js`);
  assert.ok(required.includes('scripts/updates.js'));
  const packageJs = fs.readFileSync(path.join(ROOT, 'scripts/package.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/);
  for (const file of required) {
    assert.ok(packageJs.includes(`'${file}'`), `${file} is in APP_FILES`);
    assert.ok(dockerfile.includes(file), `${file} is copied by the Dockerfile`);
    assert.ok(dockerignore.includes(`!${file}`), `${file} is allowed by .dockerignore`);
  }
});
