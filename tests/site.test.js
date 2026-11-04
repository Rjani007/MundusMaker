'use strict';
// The website (site/): reading player wiki ZIPs, deciding what may be
// published, and the rules the viewer and the storage policy share.
// tests/site-db/ covers the Supabase side against a local stack.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const load = require('./module-loader');

const ROOT = path.resolve(__dirname, '..');
const site = (file) => load(path.join('../../site/js', file));
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261103200000_player_wikis.sql'), 'utf8');

const wikiNames = [
  'index.html', 'timeline.html', 'maps.html', 'handouts.html', 'entry-0001.html', 'entry-0025.html', 'category-01.html',
  'assets/wiki.css', 'assets/wiki.js', 'assets/search-index.js', 'README.txt', `images/${'ab12'.repeat(6)}.png`, `images/${'cd34'.repeat(6)}.jpg`,
];
const entriesOf = (names, root = 'the-sundered-reach-player-wiki/') => names.map((n) => ({ name: root + n, size: 100, dir: false }));

test('a ZIP written by MundusMaker reads back byte for byte', async () => {
  const { zipFilesCompressed } = await load('handouts/output.js');
  const { readZip } = await site('zip.js');
  const text = new TextEncoder().encode('<!doctype html>'.repeat(200)); // long enough to be deflated
  const image = new Uint8Array(500).map((_, i) => (i * 37) % 256); // stored as it is
  const blob = await zipFilesCompressed([['wiki/index.html', text], ['wiki/images/a.png', image], ['wiki/assets/wiki.css', new TextEncoder().encode('a{}')]]);
  const entries = await readZip(blob);
  assert.deepEqual(entries.map((e) => [e.name, e.size]), [['wiki/index.html', text.length], ['wiki/images/a.png', 500], ['wiki/assets/wiki.css', 3]]);
  assert.deepEqual(await entries[0].bytes(), text);
  assert.deepEqual(await entries[1].bytes(), image);
  await assert.rejects(readZip(new Blob(['not a zip at all, just some text'])), /not a ZIP/);
});

test('only a player wiki is published, without its offline-only files', async () => {
  const { planWiki } = await site('wikifile.js');
  const plan = planWiki(entriesOf(wikiNames));
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.files.map((f) => f.path).sort(), wikiNames.filter((n) => !['assets/wiki.js', 'README.txt'].includes(n)).sort());
  // the same files at the top of the ZIP work too
  assert.deepEqual(planWiki(entriesOf(wikiNames, '')).problems, []);

  assert.match(planWiki(entriesOf(['photo.jpg', 'notes.txt'])).problems[0], /not a MundusMaker player wiki/);
  assert.match(planWiki(entriesOf([...wikiNames, 'login.html'])).problems[0], /files a player wiki doesn't, such as login\.html/);
  assert.match(planWiki(entriesOf([...wikiNames, 'images/evil.svg'])).problems[0], /images\/evil\.svg/);
  const big = entriesOf(wikiNames).map((e) => (e.name.endsWith('index.html') ? { ...e, size: 4 * 1024 * 1024 } : e));
  assert.match(planWiki(big).problems[0], /index\.html is larger than 3\.0 MB/);
});

test('the storage policy accepts exactly the names and limits the site uses', async () => {
  const { LIMITS, planWiki } = await site('wikifile.js');
  const sql = /name ~ '([^']+)'/.exec(MIGRATION)[1];
  const policy = new RegExp(sql);
  const id = 'abcdefghij12';
  for (const f of planWiki(entriesOf(wikiNames)).files) assert.ok(policy.test(`${id}/${f.path}`), f.path);
  for (const bad of ['index.htm', 'login.html', 'assets/wiki.js', 'images/x.svg', 'README.txt', '../index.html']) assert.ok(!policy.test(`${id}/${bad}`), bad);
  assert.ok(!policy.test('ABCDEFGHIJ12/index.html') && !policy.test('short/index.html'));
  const limits = /jsonb_build_object\('wikis', (\d+), 'bytes', (\d+) \* 1024 \* 1024, 'fileBytes', (\d+) \* 1024 \* 1024\)/.exec(MIGRATION);
  assert.deepEqual([LIMITS.wikis, LIMITS.bytes, LIMITS.fileBytes], [Number(limits[1]), limits[2] * 1048576, limits[3] * 1048576]);
  assert.match(MIGRATION, new RegExp(`file_size_limit, allowed_mime_types\\)\\s+values \\('wikis', 'wikis', true, ${LIMITS.fileBytes},`));
});

test('the search index is read as data, and pages and pictures keep their types', async () => {
  const { parseSearchIndex, storedAs, pageTitle } = await site('wikifile.js');
  const entries = [{ u: 'entry-0001.html', t: 'Port Vellen', c: 'Location', s: 'A port', x: 'harbor <b>' }, { u: 'https://evil.example/', t: 'x' }, 'junk'];
  const text = `window.MUNDUS_WIKI_INDEX = ${JSON.stringify(entries).replace(/</g, '\\u003c')};\n`;
  assert.deepEqual(parseSearchIndex(text), [{ u: 'entry-0001.html', t: 'Port Vellen', c: 'Location', s: 'A port', x: 'harbor <b>' }]);
  assert.deepEqual(parseSearchIndex('alert(1)'), []);
  assert.deepEqual(parseSearchIndex('window.MUNDUS_WIKI_INDEX = (function(){ return [] })();'), []);

  assert.deepEqual(storedAs('entry-0001.html'), { contentType: 'text/plain', cacheSeconds: 60 });
  assert.deepEqual(storedAs('assets/search-index.js'), { contentType: 'text/plain', cacheSeconds: 60 });
  assert.deepEqual(storedAs('assets/wiki.css'), { contentType: 'text/css', cacheSeconds: 60 });
  assert.equal(storedAs(`images/${'a'.repeat(24)}.png`).cacheSeconds, 31536000);
  assert.equal(pageTitle('<title>Tom &amp; Jerry&#39;s</title>'), "Tom & Jerry's");
});

test('the viewer only follows wiki pages and relative addresses', async () => {
  const { pageFromHash, safeUrl, isWikiId, newWikiId } = await site('wikifile.js');
  assert.deepEqual(pageFromHash('#entry-0003.html#people'), { page: 'entry-0003.html', anchor: 'people' });
  assert.deepEqual(pageFromHash('#entry-0003.html#<img>'), { page: 'entry-0003.html', anchor: '' });
  assert.deepEqual(pageFromHash('#../../evil.html'), { page: 'index.html', anchor: '' });
  assert.deepEqual(pageFromHash(''), { page: 'index.html', anchor: '' });
  for (const good of ['entry-0001.html', '#top', 'images/ab.png', 'assets/wiki.css']) assert.ok(safeUrl(good), good);
  for (const bad of ['javascript:alert(1)', ' JavaScript:x', 'data:text/html,x', 'https://evil.example', '//evil.example', '\\\\evil.example', 'java\nscript:x']) assert.ok(!safeUrl(bad), bad);
  const ids = new Set(Array.from({ length: 200 }, newWikiId));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every(isWikiId));
});

test('the offline search follows links by clicking them, so the online viewer can catch it', () => {
  const search = fs.readFileSync(path.join(ROOT, 'public/wiki/wiki.js'), 'utf8');
  assert.doesNotMatch(search, /location\s*(\.href)?\s*=/);
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8'), /cp public\/wiki\/wiki\.js site\/wiki\/search\.js/);
});

test('the app in the browser and the account agree on which files travel and how much fits', () => {
  const { PATH_RE, LIMITS } = require('../web/sync.js');
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261104120000_world_sync.sql'), 'utf8');
  const pattern = /p ~ '([^']+)'/.exec(sql)[1];
  assert.equal(new RegExp(pattern).source, PATH_RE.source, 'sync_path_ok() and web/sync.js PATH_RE');
  const limits = /jsonb_build_object\('bytes', (\d+) \* 1024 \* 1024, 'fileBytes', (\d+) \* 1024 \* 1024, 'files', (\d+)\)/.exec(sql);
  assert.deepEqual([LIMITS.bytes, LIMITS.fileBytes, LIMITS.files], [limits[1] * 1048576, limits[2] * 1048576, Number(limits[3])]);
  assert.ok(sql.includes(`values ('sync', 'sync', false, ${LIMITS.fileBytes},`), 'the bucket takes files as large as the app sends');
  const policy = new RegExp(pattern);
  for (const good of ['worlds/vale/world.json', 'worlds/vale/entities/king.json', 'worlds/vale/entities/king (MundusMaker sync copy from Chrome on Windows 2026-11-04 15.32).json', 'worlds/vale/assets/1a2b-map.png']) {
    assert.ok(policy.test(good), good);
  }
  for (const bad of ['worlds/vale/.history/king/1.json', 'worlds/vale/exports/book.pdf', 'worlds/vale/entities/.king.json-1.tmp', 'worlds/../config.json', 'worlds/Vale/world.json', '.trash/x.json', 'worlds/vale/entities/a/b.json']) {
    assert.ok(!policy.test(bad), bad);
  }
  // the website publishes the app with the workflow that tests it
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  assert.match(workflow, /node scripts\/stage-web\.js site\/app/);
  assert.match(workflow, /tests\/web-sync\.test\.js/);
});

test('every Ko-fi button points at the same page, as a plain link', () => {
  const places = ['public/index.html', 'site/index.html', 'site/publish/index.html', 'web/boot.js'];
  const links = places.map((f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/https:\/\/ko-fi\.com\/[\w-]*/g)].map((m) => m[0]));
  assert.deepEqual(links.map((l) => l.length), [1, 1, 1, 1], 'one link in each place');
  assert.equal(new Set(links.flat()).size, 1, links.flat().join(', '));
  assert.match(links[0][0], /^https:\/\/ko-fi\.com\/[\w-]+$/, 'a real page, not the placeholder');
  // nothing may load from Ko-fi before a click: no widget script, no remote image
  for (const f of places) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /<script[^>]+ko-fi|storage\.ko-fi\.com|ko-fi\.com\/widget/i, f);
});
