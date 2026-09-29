#!/usr/bin/env node
'use strict';
/*
 * Player wiki check: exports the sample world's player wiki through the app
 * itself (the same code path as the Export page), unzips it, and opens it from
 * file:// in headless Edge or Chrome with networking switched off.
 *
 *   node scripts/wiki-check.js               run the check
 *   node scripts/wiki-check.js --png out/    also save screenshots to out/
 *
 * It fails when a page makes any request that is not a local file, when a
 * link or image points at a missing file, when search finds nothing, or when
 * a GM-only name, a secret block's text, an entry id or an uploaded file name
 * appears in any file or file name. The server runs on a temporary data
 * folder seeded from sample/, never the owner's data/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const zlib = require('zlib');
const { EnvironmentError, startSession } = require('./browser-harness');

const argv = process.argv.slice(2);
const pngDir = argv.includes('--png') ? argv[argv.indexOf('--png') + 1] : null;

/** Read the ZIP that handouts/output.js writes (stored or deflated entries). */
function unzip(buf, dest) {
  const names = [];
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    if (method !== 0 && method !== 8) throw new Error(`Unexpected ZIP method ${method}.`);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    if (name.includes('..') || path.isAbsolute(name)) throw new Error(`Unsafe ZIP path: ${name}`);
    const out = path.join(dest, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const data = buf.subarray(start, start + size);
    fs.writeFileSync(out, method === 8 ? zlib.inflateRawSync(data) : data);
    names.push(name);
    at = start + size;
  }
  return names;
}

/** Strings from the sample world that must never reach the wiki. */
function sampleSecrets(dataDir) {
  const worlds = path.join(dataDir, 'worlds');
  const wid = fs.readdirSync(worlds)[0];
  const dir = path.join(worlds, wid, 'entities');
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const probes = new Set();
  for (const e of entries) {
    if (e.gmOnly) probes.add(e.name);
    if (e.id.includes('-')) probes.add(e.id); // ids can embed an earlier name
    if (e.image) probes.add(e.image);
    for (const b of e.blocks || []) {
      if (!b.secret || !b.text) continue;
      const plain = b.text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, d) => d || t).replace(/[*_`>#-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain.length >= 16) probes.add(plain.slice(0, 32));
    }
  }
  probes.add(wid);
  probes.add('/assets/');
  return { wid, probes: [...probes] };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-wiki-'));
  const dataDir = path.join(temp, 'data');
  let session;
  const problems = [];
  try {
    session = await startSession(temp, dataDir);
    const { evaluate, send, navigate, client, sessionId } = session;

    // 1. Export through the app, which also saves a copy in the exports folder.
    const exported = await evaluate(`(async () => {
      const state = await import('/js/state.js');
      for (let i = 0; i < 100 && !state.state.loaded; i++) await new Promise((r) => setTimeout(r, 100));
      const { buildPlayerWiki } = await import('/js/wiki/export.js');
      const { api } = await import('/js/api.js');
      const result = await buildPlayerWiki({ include: {} });
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const saved = await api.exportFile(result.name, btoa(bin));
      return { path: saved.path, stats: result.stats };
    })()`);
    console.log(`exported  ${exported.stats.entries} entries, ${exported.stats.images} images`);

    const siteDir = path.join(temp, 'wiki');
    const names = unzip(fs.readFileSync(exported.path), siteDir);
    const root = path.join(siteDir, names[0].split('/')[0]);

    // 2. Static checks: secrets, ids and file names; links and images resolve.
    const { probes } = sampleSecrets(dataDir);
    const files = names.map((n) => path.join(siteDir, n));
    for (const file of files) {
      const rel = path.relative(root, file);
      const text = /\.(png|jpe?g)$/.test(file) ? '' : fs.readFileSync(file, 'utf8');
      for (const probe of probes) {
        if (rel.includes(probe) || text.includes(probe)) problems.push(`${rel} contains "${probe}"`);
      }
      if (!file.endsWith('.html')) continue;
      for (const [, attr, target] of text.matchAll(/\s(href|src)="([^"]*)"/g)) {
        if (/^[a-z]+:/i.test(target) || target.startsWith('//')) problems.push(`${rel}: ${attr} points off this folder: ${target}`);
        else if (target && !target.startsWith('#') && !fs.existsSync(path.join(root, target))) problems.push(`${rel}: missing ${target}`);
      }
    }
    console.log(`static    ${files.length} files, ${probes.length} secret probes`);

    // 3. Offline, from file://: nothing but local files may load.
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const remote = [];
    const off = client.on((msg) => {
      if (msg.sessionId === sessionId && msg.method === 'Network.requestWillBeSent' && !msg.params.request.url.startsWith('file:')) {
        remote.push(msg.params.request.url);
      }
    });
    const shot = async (name) => {
      if (!pngDir) return;
      fs.mkdirSync(pngDir, { recursive: true });
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(pngDir, `${name}.png`), Buffer.from(data, 'base64'));
    };
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

    const pages = names.filter((n) => n.endsWith('.html')).map((n) => path.join(siteDir, n));
    for (const page of pages) {
      await navigate(pathToFileURL(page).href);
      const state = await evaluate(`(async () => {
        await Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
        return {
          styled: getComputedStyle(document.querySelector('.top')).position === 'sticky',
          indexed: Array.isArray(window.MUNDUS_WIKI_INDEX) && window.MUNDUS_WIKI_INDEX.length,
          broken: [...document.images].filter((img) => !img.naturalWidth).map((img) => img.getAttribute('src')),
          edition: /Player edition · exported \\d{4}-\\d{2}-\\d{2}/.test(document.querySelector('footer')?.textContent || ''),
        };
      })()`);
      const rel = path.relative(root, page);
      if (!state.styled) problems.push(`${rel}: the stylesheet did not load from file://`);
      if (!state.indexed) problems.push(`${rel}: the search index did not load from file://`);
      if (!state.edition) problems.push(`${rel}: no edition and export date in the footer`);
      for (const src of state.broken) problems.push(`${rel}: image did not load: ${src}`);
    }
    console.log(`offline   ${pages.length} pages opened from file://`);

    // 4. Search works offline and lands on a page.
    await navigate(pathToFileURL(path.join(root, 'index.html')).href);
    await shot('wiki-index');
    const search = await evaluate(`(async () => {
      const input = document.getElementById('wiki-search');
      input.value = 'lantern';
      input.dispatchEvent(new Event('input'));
      const links = [...document.querySelectorAll('#wiki-results a')];
      return { count: links.length, first: links[0]?.getAttribute('href'), title: links[0]?.firstChild?.textContent };
    })()`);
    await shot('wiki-search');
    if (!search.count) problems.push('search for "lantern" found nothing');
    else {
      await navigate(pathToFileURL(path.join(root, search.first)).href);
      const h1 = await evaluate(`document.querySelector('h1')?.textContent`);
      if (h1 !== search.title) problems.push(`the first search result opened "${h1}", expected "${search.title}"`);
      await shot('wiki-entry');
    }
    console.log(`search    "lantern": ${search.count} results`);
    const withMap = pages.find((p) => fs.readFileSync(p, 'utf8').includes('<h2>Map</h2>'));
    if (withMap) { await navigate(pathToFileURL(withMap).href); await shot('wiki-map'); }
    off();
    for (const url of remote) problems.push(`a page requested ${url}`);

    for (const p of problems) console.log(`PROBLEM  ${p}`);
    console.log(problems.length ? `\n${problems.length} problem(s) found.` : '\nThe player wiki works offline and carries no secrets.');
    return problems.length ? 1 : 0;
  } finally {
    if (session) await session.close();
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a browser file may still be locked */ }
  }
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(err instanceof EnvironmentError ? err.message : err);
  process.exitCode = err instanceof EnvironmentError ? 2 : 1;
});
