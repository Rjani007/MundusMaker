'use strict';
// Player wiki canaries: the text layer (page text, search index, file names,
// relation labels) must never carry a hidden name, a secret, an entity id, a
// world id or an uploaded file name. Map pixels are inspected visually.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

const WID = 'wid-oldworldname';
const CANARIES = [
  'SECRETBLOCKCANARY', 'SECRETRELLABEL', 'SECRETRELHARBOR', 'GMONLYBODY', 'Lord Vex', 'lord-vex',
  'hidden-alias', 'secretfilename', 'leaked-asset-name', 'secret-only', 'oldworldname', 'SECRETMARKER',
  'traitor', 'vexportrait', 'SECRETSTAT', 'SECRETTABLE', 'SECRETFACT',
];

function canaryWorld() {
  const world = {
    name: 'Canary Coast', description: 'A quiet shore.', era: 'AR',
    types: {
      npc: { label: 'NPC', plural: 'NPCs', color: '#d9913f', fields: ['Role'] },
      location: { label: 'Location', plural: 'Locations', color: '#5a8f5a', fields: [] },
      handout: { label: 'Handout', plural: 'Handouts', color: '#bbaa78', fields: [] },
    },
    calendar: { months: ['Frost', 'Thaw'], ages: [{ name: 'Age of Hidden Things', startYear: 2000 }], today: '3 Thaw 1021 AR' },
  };
  const entities = [
    { id: 'captain-hidden-alias', name: 'Captain Mara', type: 'npc', image: 'secretfilename-portrait.png',
      fields: { Role: 'Harbor master' }, tags: ['ally'],
      blocks: [
        { id: 'b1', kind: 'text', text: 'Mara runs the [[Harbor]]. ![a sketch](/assets/wid-oldworldname/leaked-asset-name.png)' },
        { id: 'b2', kind: 'text', secret: true, text: 'SECRETBLOCKCANARY she reports to [[Lord Vex]] ![x](/assets/wid-oldworldname/secret-only.png)' },
        { id: 'b3', kind: 'statblock', secret: true, stat: { name: 'SECRETSTAT' } },
        { id: 'b4', kind: 'table', secret: true, table: { title: 'SECRETTABLE', rows: [{ weight: 1, text: 'x' }] } },
        { id: 'b5', kind: 'heading', text: 'An empty section' },
        { id: 'b6', kind: 'heading', secret: true, text: 'Secret section' },
        { id: 'b7', kind: 'text', secret: true, text: 'Only under the secret heading.' },
      ],
      relations: [
        { to: 'harbor', label: 'works at' },
        { to: 'lord-vex', label: 'SECRETRELLABEL', secret: true },
        { to: 'harbor', label: 'SECRETRELHARBOR', secret: true },
        { to: 'lord-vex', label: 'serves' },
      ] },
    { id: 'lord-vex', name: 'Lord Vex', type: 'npc', gmOnly: true, image: 'vexportrait.png',
      fields: { Role: 'SECRETFACT' }, date: { year: 2005, month: 1 },
      blocks: [{ id: 'v1', kind: 'text', text: 'GMONLYBODY [[Captain Mara]]' }],
      relations: [{ to: 'harbor', label: 'SECRETRELLABEL' }] },
    { id: 'harbor', name: 'Harbor', type: 'location', date: { year: 1020, month: 2, day: 4 },
      blocks: [
        { id: 'h1', kind: 'text', text: 'Home of [[captain mara]]. Rumors about [[Lord Vex|the duke]] and [[Nowhere Yet]].' },
        { id: 'h2', kind: 'encounter', enc: { partySize: 4, partyLevel: 3, rows: [{ to: 'lord-vex', name: 'Thug', count: 2, cr: '1' }] } },
      ],
      map: { kind: 'town', seed: 's', params: {}, strokes: [], labels: [], paths: [], stamps: [],
        markers: [
          { id: 'm1', x: 0.5, y: 0.5, label: 'SECRETMARKER', secret: true },
          { id: 'm2', x: 0.2, y: 0.2, label: 'Dock' },
          { id: 'm3', x: 0.3, y: 0.3, label: '', to: 'lord-vex' },
          { id: 'm4', x: 0.4, y: 0.4, label: '', to: 'captain-hidden-alias' },
        ] } },
    { id: 'the-traitor-duke', name: 'Duke Aldo', type: 'npc', blocks: [{ id: 'd1', kind: 'text', text: 'A loyal duke.' }],
      date: { month: 1, day: 1, recurs: 'annual' } },
    { id: 'letter', name: 'A letter', type: 'handout', handout: { kind: 'letter', sourceId: 'lord-vex', sourceImage: true },
      blocks: [{ id: 'l1', kind: 'text', text: 'Dear friend, come to the harbor.' }] },
  ];
  return { world, entities };
}

async function buildSite(opts = {}) {
  const { projectPlayerWorld } = await load('projection.js');
  const { buildWikiSite } = await load('wiki/site.js');
  const { world, entities } = canaryWorld();
  const proj = projectPlayerWorld({ world, worldId: WID, entities, ...opts });
  // stand-in for the exporter: one generated file per requested image
  const images = new Map([...proj.needs.keys()].map((key, i) => [key, [{ file: `images/${String(i).padStart(24, 'a')}.png`, width: 10, height: 10 }]]));
  const files = buildWikiSite(proj, { images, exportedAt: new Date('2026-09-28T12:00:00Z') });
  return { proj, files, text: (name) => files.find((f) => f.name === name)?.text };
}

const pageFor = (files, title) => files.find((f) => f.name.startsWith('entry-') && f.text.includes(`<h1>${title}</h1>`));

test('no canary reaches any file or file name', async () => {
  const { files } = await buildSite();
  assert.ok(files.length > 5);
  for (const f of files) {
    for (const canary of CANARIES) {
      assert.ok(!f.name.toLowerCase().includes(canary.toLowerCase()), `${canary} in file name ${f.name}`);
      assert.ok(!f.text.toLowerCase().includes(canary.toLowerCase()), `${canary} in ${f.name}`);
    }
    assert.doesNotMatch(f.text, /\/assets\//, `asset path in ${f.name}`);
    assert.doesNotMatch(f.text, /(src|href)="(https?:)?\/\//, `remote reference in ${f.name}`);
    assert.doesNotMatch(f.name, /captain|harbor|letter|aldo/i, 'page names are generated');
  }
});

test('pages link, backlink and fall back to plain text like the app', async () => {
  const { files } = await buildSite();
  const mara = pageFor(files, 'Captain Mara'), harbor = pageFor(files, 'Harbor');
  assert.ok(mara && harbor);
  assert.match(mara.text, new RegExp(`<a class="wl" href="${harbor.name}">Harbor</a>`));
  assert.match(harbor.text, new RegExp(`<a class="wl" href="${mara.name}">captain mara</a>`), 'links resolve case-insensitively');
  assert.match(harbor.text, /Rumors about the duke and Nowhere Yet\./, 'hidden and missing targets are plain text');
  assert.match(mara.text, /<span class="rel">works at<\/span> <a href="entry-/);
  assert.doesNotMatch(mara.text, /serves/, 'a relation to a hidden entry is dropped');
  assert.match(harbor.text, /Linked from<\/h2><ul class="backlinks"><li><a href="entry-\d+\.html">Captain Mara<\/a>/);
  assert.match(mara.text, /Linked from/, 'the mention in Harbor backlinks to Mara');
  assert.doesNotMatch(mara.text, /An empty section|Secret section|Only under the secret heading/i);
  assert.match(mara.text, /<dt>Role<\/dt><dd>Harbor master<\/dd>/);
  assert.match(harbor.text, /2 × Thug · CR 1/, 'a hidden creature in an encounter shows its typed name');
  assert.match(harbor.text, /<li value="1">Dock<\/li>/, 'the key numbers what players see');
  assert.match(harbor.text, new RegExp(`<li value="2"><a href="${mara.name}">Captain Mara</a></li>`), 'an unnamed marker takes its linked entry name');
});

test('images are requested only for projected content', async () => {
  const { proj } = await buildSite();
  const specs = [...proj.needs.values()];
  const urls = specs.filter((s) => s.kind === 'asset').map((s) => s.url);
  assert.deepEqual(urls.sort(), ['/assets/wid-oldworldname/leaked-asset-name.png', '/assets/wid-oldworldname/secretfilename-portrait.png']);
  const map = specs.find((s) => s.kind === 'map');
  assert.equal(map.ref, 'harbor');
  assert.ok(map.hiddenLinkIds.has('lord-vex'));
  assert.ok(specs.some((s) => s.kind === 'handout' && s.ref === 'letter'));
});

test('the search index holds projected text only', async () => {
  const { text } = await buildSite();
  const src = text('assets/search-index.js');
  const index = JSON.parse(src.replace(/^window\.MUNDUS_WIKI_INDEX = /, '').replace(/;\n$/, ''));
  assert.equal(index.length, 4);
  const mara = index.find((e) => e.t === 'Captain Mara');
  assert.match(mara.x, /Harbor master/);
  assert.match(mara.x, /works at Harbor/);
  assert.match(mara.u, /^entry-\d+\.html$/);
});

test('the timeline matches the kernel and never announces a hidden age', async () => {
  const { text } = await buildSite();
  const tl = text('timeline.html');
  assert.match(tl, /4 Thaw 1020 AR/);
  assert.match(tl, /Every year/);
  assert.match(tl, /Current date: 3 Thaw 1021 AR/);
  // ages are public calendar data; only a band for an age holding nothing
  // players can see would leak (Lord Vex is dated in it)
  assert.match(tl, /Before the Age of Hidden Things/);
  assert.doesNotMatch(tl, /<h2 class="band">Age of Hidden Things/);
});

test('unticked categories leave the wiki and their links turn to text', async () => {
  const { files } = await buildSite({ typeKeys: new Set(['npc', 'handout']) });
  assert.equal(pageFor(files, 'Harbor'), undefined);
  const mara = pageFor(files, 'Captain Mara');
  assert.match(mara.text, /Mara runs the Harbor\./);
  assert.doesNotMatch(mara.text, /works at/);
});

test('every page states the edition and export date', async () => {
  const { files } = await buildSite();
  for (const f of files.filter((f) => f.name.endsWith('.html'))) {
    assert.match(f.text, /Player edition · exported 2026-09-28/, f.name);
    assert.match(f.text, /<script src="assets\/search-index\.js"><\/script>/, f.name);
  }
});

test('the PDF and the wiki share one block, relation and key filter', async () => {
  const { printableBlocks, visibleRelations, mapKeyRows } = await load('projection.js');
  const { entities } = canaryWorld();
  const byId = new Map(entities.map((e) => [e.id, e]));
  const [mara, , harbor] = entities;
  assert.deepEqual(printableBlocks(mara, false).map((b) => b.id), ['b1']);
  assert.deepEqual(printableBlocks(mara, true).map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b6', 'b7']);
  const rels = visibleRelations(mara, { gm: false, byId, included: (e) => !e.gmOnly });
  assert.deepEqual(rels.map(({ r }) => r.label), ['works at']);
  const key = mapKeyRows(harbor.map, { gm: false, entities, byId });
  assert.deepEqual(key.rows.map((r) => [r.n, r.label]), [[1, 'Dock'], [2, 'Captain Mara']]);
  const gmKey = mapKeyRows(harbor.map, { gm: true, entities, byId });
  assert.deepEqual(gmKey.rows.map((r) => r.label), ['SECRETMARKER', 'Dock', 'Lord Vex', 'Captain Mara']);
});
