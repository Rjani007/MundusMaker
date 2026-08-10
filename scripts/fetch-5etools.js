#!/usr/bin/env node
'use strict';

// Explicit, opt-in 5etools downloader. The app never calls this automatically:
// the Library button (or this CLI) is the user action that permits network use.
// Data is fetched from the public 5etools source mirror and then passed through
// MundusMaker's server-side PACK_KEEP whitelist before it reaches .library.

const fs = require('fs');
const path = require('path');

const REPO = 'https://raw.githubusercontent.com/5etools-mirror-3/5etools-src';
const ARRAY_KINDS = ['monster', 'spell', 'item', 'class', 'classFeature', 'subclass', 'subclassFeature'];
const VALID_CATEGORIES = new Set(['bestiary', 'spells', 'items', 'classes']);
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 300;
const MAX_ROWS = 250000;

function inputError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanList(value) {
  if (Array.isArray(value)) return value.map(String).map((x) => x.trim()).filter(Boolean);
  return String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function optionsOf(opts = {}) {
  const requestedCategories = Object.prototype.hasOwnProperty.call(opts, 'categories')
    ? opts.categories : ['bestiary', 'spells', 'items', 'classes'];
  const categories = cleanList(requestedCategories)
    .map((x) => x.toLowerCase()).filter((x) => VALID_CATEGORIES.has(x));
  if (!categories.length) throw inputError('choose at least one category: bestiary, spells, items, or classes');
  const ref = String(opts.ref || 'main').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw inputError('invalid 5etools ref');
  const sources = new Set(cleanList(opts.sources).map((x) => x.toUpperCase()));
  return { categories, ref, sources };
}

async function responseText(res, rel, controller, consumeBytes) {
  // Real fetch responses expose a byte stream. Read it ourselves so a missing
  // or dishonest Content-Length cannot make res.text() buffer an unlimited
  // body. Test doubles and older implementations fall back to text().
  if (!res.body?.getReader) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_FILE_BYTES) throw Object.assign(new Error(`${rel} is larger than the 48 MB safety limit`), { status: 413 });
    consumeBytes?.(bytes, rel);
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) {
      controller.abort();
      throw Object.assign(new Error(`${rel} is larger than the 48 MB safety limit`), { status: 413 });
    }
    consumeBytes?.(chunk.length, rel);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function fetchJson(rel, { ref, fetchImpl = globalThis.fetch, consumeBytes, controllers }) {
  if (typeof fetchImpl !== 'function') throw new Error('Node 18 or newer is required (global fetch is missing)');
  const controller = new AbortController();
  controllers?.add(controller);
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetchImpl(`${REPO}/${encodeURIComponent(ref)}/data/${rel}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MundusMaker-5etools-importer' },
    });
    if (!res.ok) throw new Error(`5etools ${rel}: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw Object.assign(new Error(`${rel} is larger than the 48 MB safety limit`), { status: 413 });
    const text = await responseText(res, rel, controller, consumeBytes);
    try { return JSON.parse(text); }
    catch (err) { throw new Error(`5etools ${rel} is not valid JSON: ${err.message}`); }
  } finally {
    clearTimeout(timer);
    controllers?.delete(controller);
  }
}

function selectedArrays(data, sources, filterRows = false) {
  const batches = [];
  for (const kind of ARRAY_KINDS) {
    let rows = Array.isArray(data?.[kind]) ? data[kind] : [];
    if (filterRows && sources.size) rows = rows.filter((row) => sources.has(String(row?.source || '').toUpperCase()));
    if (rows.length) batches.push([kind, rows]);
  }
  let baseItems = Array.isArray(data?.baseitem) ? data.baseitem : [];
  if (filterRows && sources.size) baseItems = baseItems.filter((row) => sources.has(String(row?.source || '').toUpperCase()));
  if (baseItems.length) batches.push(['item', baseItems]);
  return batches;
}

function mergeArrays(into, batches) {
  for (const [kind, rows] of batches) {
    const target = (into[kind] ??= []);
    // Avoid Function.prototype argument limits on large, valid source files.
    for (const row of rows) target.push(row);
  }
}

async function mapLimit(items, limit, work, onError) {
  const out = new Array(items.length);
  let next = 0;
  let firstError = null;
  async function worker() {
    while (!firstError && next < items.length) {
      const i = next++;
      try { out[i] = await work(items[i], i); }
      catch (err) {
        if (!firstError) {
          firstError = err;
          onError?.(err);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
  return out;
}

async function indexedFiles(folder, ctx) {
  const index = await fetchJson(`${folder}/index.json`, ctx);
  return Object.entries(index)
    .filter(([source]) => !ctx.sources.size || ctx.sources.has(String(source).toUpperCase()))
    .map(([source, file]) => ({ source, rel: `${folder}/${file}` }));
}

/** Resolve source codes to the per-class files that can actually contain them. */
async function classFiles(ctx) {
  const index = await fetchJson('class/index.json', ctx);
  const entries = Object.entries(index);
  if (!ctx.sources.size) return entries.map(([className, file]) => ({ source: className, rel: `class/${file}` }));

  // 5etools' class index is keyed by class name, not source. Its generated
  // subclass lookup maps both the class source and each nested subclass source
  // to those class names, letting a focused request avoid unrelated files.
  const lookup = await fetchJson('generated/gendata-subclass-lookup.json', ctx);
  const wantedClasses = new Set();
  for (const [classSource, classes] of Object.entries(lookup || {})) {
    for (const [className, subclassSources] of Object.entries(classes || {})) {
      if (ctx.sources.has(String(classSource).toUpperCase())
          || Object.keys(subclassSources || {}).some((source) => ctx.sources.has(String(source).toUpperCase()))) {
        wantedClasses.add(className.toLowerCase());
      }
    }
  }
  return entries
    .filter(([className]) => wantedClasses.has(String(className).toLowerCase()))
    .map(([className, file]) => ({ source: className, rel: `class/${file}` }));
}

/** Download selected 5etools data and return one importable raw pack object. */
async function download5etools(opts = {}) {
  const chosen = optionsOf(opts);
  let totalBytes = 0;
  const controllers = new Set();
  const ctx = {
    ...chosen,
    fetchImpl: opts.fetchImpl,
    controllers,
    consumeBytes(bytes, rel) {
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw Object.assign(new Error(`the selected 5etools files exceed the 256 MB download limit (last file: ${rel}); choose source codes to narrow the pack`), { status: 413 });
      }
    },
  };
  const out = { _download: { provider: '5etools', repo: REPO, ref: chosen.ref, fetched: new Date().toISOString() } };
  const jobs = [];

  if (chosen.categories.includes('bestiary')) jobs.push(...await indexedFiles('bestiary', ctx));
  if (chosen.categories.includes('spells')) jobs.push(...await indexedFiles('spells', ctx));
  if (chosen.categories.includes('items')) jobs.push(
    { rel: 'items.json', filterRows: true },
    { rel: 'items-base.json', filterRows: true });
  if (chosen.categories.includes('classes')) {
    const files = await classFiles(ctx);
    jobs.push(...files.map((job) => ({ ...job, filterRows: true })));
  }
  if (!jobs.length) throw inputError('no 5etools files matched those source codes');
  if (jobs.length > MAX_FILES) {
    throw Object.assign(new Error(`that selection expands to ${jobs.length} files; the safety limit is ${MAX_FILES}. Add source codes to make a focused pack.`), { status: 413 });
  }

  let done = 0;
  let totalRows = 0;
  await mapLimit(jobs, 5, async (job) => {
    const data = await fetchJson(job.rel, ctx);
    const batches = selectedArrays(data, chosen.sources, !!job.filterRows);
    const addedRows = batches.reduce((count, [, rows]) => count + rows.length, 0);
    if (totalRows + addedRows > MAX_ROWS) {
      throw Object.assign(new Error(`the selected pack exceeds the ${MAX_ROWS.toLocaleString()}-row safety limit; choose source codes to narrow it`), { status: 413 });
    }
    totalRows += addedRows;
    mergeArrays(out, batches);
    done++;
    opts.onProgress?.({ done, total: jobs.length, file: job.rel });
  }, () => {
    for (const controller of controllers) controller.abort();
  });
  out._download.categories = chosen.categories;
  out._download.sources = [...chosen.sources];
  out._download.files = jobs.length;
  out._download.bytes = totalBytes;
  return out;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--categories') opts.categories = argv[++i];
    else if (arg === '--sources') opts.sources = argv[++i];
    else if (arg === '--ref') opts.ref = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/fetch-5etools.js [--categories bestiary,spells,items,classes] [--sources XPHB,XMM] [--ref main] [--out 5etools-pack.json]');
    console.log('Only download material you own or are otherwise allowed to use. Blank --sources means every source in the selected categories.');
    return;
  }
  const data = await download5etools({ ...opts, onProgress: ({ done, total, file }) => console.log(`[${done}/${total}] ${file}`) });
  const target = path.resolve(opts.out || '5etools-pack.json');
  fs.writeFileSync(target, JSON.stringify(data));
  const counts = ARRAY_KINDS.filter((k) => data[k]?.length).map((k) => `${data[k].length} ${k}`).join(', ');
  console.log(`Saved ${counts} to ${target}`);
  console.log('Import it from MundusMaker → Library → Content packs, or use the in-app downloader there.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}

module.exports = {
  ARRAY_KINDS, REPO, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES, MAX_ROWS,
  download5etools, optionsOf,
};
