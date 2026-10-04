'use strict';
/*
 * Check for updates. This is the second deliberate exception to "the server
 * never fetches" (the 5etools downloader is the first): it runs only when the
 * user presses Check for updates in Settings, sends one GET to a public
 * release feed, and reports what it found. It never downloads or installs
 * anything, and nothing about the user's worlds is sent; the request carries
 * only a MundusMaker User-Agent.
 *
 * The feed comes from package.json: `repository` pointing at a GitHub
 * repository gives its latest-release API. Until that field exists the check
 * reports `configured: false` and makes no request at all.
 */

const FEED_HOSTS = new Set(['api.github.com']);
const RELEASE_HOSTS = new Set(['github.com']);
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

/** The latest-release API for a package.json, or null when no GitHub repository is named. */
function feedFor(pkg) {
  const repo = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  if (!repo) return null;
  const m = String(repo).trim().match(/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest` : null;
}

/** "v1.10.0-beta.2" -> { parts: [1, 10, 0], pre: 'beta.2' }, or null. */
function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || '' };
}

/** Negative when a < b, positive when a > b, 0 when equal or unparseable. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // a release outranks its own pre-releases
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

function httpsUrl(value, hosts) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && hosts.has(url.hostname) ? url.href : null;
  } catch { return null; }
}

async function readCapped(res) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('The release feed answered with more data than expected.');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('The release feed answered with more data than expected.');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error('The release feed answered with more data than expected.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The release fields the app shows, from GitHub's release JSON. Untrusted input. */
function summarizeRelease(json) {
  if (!json || typeof json !== 'object') throw new Error('The release feed answered with something that is not a release.');
  const version = parseVersion(json.tag_name) ? String(json.tag_name).trim().replace(/^v/, '') : null;
  if (!version) throw new Error('The latest release has no version number MundusMaker can read.');
  return {
    version,
    name: String(json.name || '').slice(0, 200),
    // only ever a github.com page: the app shows it as a link
    url: httpsUrl(json.html_url, RELEASE_HOSTS),
    publishedAt: typeof json.published_at === 'string' ? json.published_at.slice(0, 40) : null,
    notes: String(json.body || '').slice(0, 4000),
  };
}

/**
 * Ask the feed for the latest release. `fetchImpl` is injectable for tests.
 * Returns { configured:false } without any request when no feed is set.
 */
async function checkForUpdates({ pkg, current, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const feed = feedFor(pkg);
  if (!feed) return { configured: false, current };
  if (typeof fetchImpl !== 'function') throw new Error('This Node runtime cannot make the request (fetch is missing).');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = feed;
    for (let hop = 0; ; hop++) {
      if (!httpsUrl(url, FEED_HOSTS)) throw new Error('The release feed redirected somewhere MundusMaker does not ask.');
      let res;
      try {
        res = await fetchImpl(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MundusMaker/${current}` },
        });
      } catch (err) {
        throw new Error(controller.signal.aborted ? 'The release feed did not answer in time. Check your connection and try again.' : 'Could not reach the release feed. Check your connection and try again.');
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) throw new Error('The release feed redirected too many times.');
        url = new URL(res.headers.get('location'), url).href;
        continue;
      }
      if (res.status === 404) return { configured: true, current, latest: null, newer: false, note: 'No release has been published yet.' };
      if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests from this network right now. Try again in an hour.');
      if (!res.ok) throw new Error(`The release feed answered with an error (${res.status}).`);
      let json;
      try { json = JSON.parse(await readCapped(res)); } catch (err) { throw new Error(err.message.startsWith('The release feed') ? err.message : 'The release feed answered with something that is not a release.'); }
      const release = summarizeRelease(json);
      return { configured: true, current, latest: release.version, newer: compareVersions(release.version, current) > 0, release };
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { feedFor, parseVersion, compareVersions, summarizeRelease, checkForUpdates, MAX_BYTES };
