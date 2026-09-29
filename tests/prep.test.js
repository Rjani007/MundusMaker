'use strict';
// Populate and the journey planner (1.9): deterministic, never touching
// generator streams, and exact about days and dates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

function town() {
  const districts = [
    { use: 'market', name: 'Old Market', cx: 100, cy: 100 },
    { use: 'harbor', name: 'Salt Quay', cx: 300, cy: 500 },
  ];
  const buildings = [];
  for (let i = 0; i < 12; i++) buildings.push({ x: 90 + i * 3, y: 100 + (i % 4) * 5, use: 'market', landmark: i === 0 ? 'Weigh House' : null });
  for (let i = 0; i < 8; i++) buildings.push({ x: 300 + i * 4, y: 500, use: 'harbor', landmark: null });
  return { map: { kind: 'town', seed: 'canary-town' }, model: { districts, buildings, generation: '1.8' } };
}

test('populate suggestions are deterministic, per role, and skip filled roles', async () => {
  const { populateSuggestions, canPopulate } = await load('maps/populate.js');
  const { map, model } = town();
  assert.equal(canPopulate(model), true);
  assert.equal(canPopulate({ districts: [] }), false);
  const a = populateSuggestions(map, model, [900, 640]);
  const b = populateSuggestions(map, model, [900, 640]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 6);
  assert.deepEqual(a.map((s) => s.key), ['market:merchant', 'market:tavern', 'market:moneylender', 'harbor:harbormaster', 'harbor:fishmarket', 'harbor:smuggler']);
  for (const s of a) {
    assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1);
    assert.ok(s.name.trim());
  }
  const rest = populateSuggestions(map, model, [900, 640], (key) => key === 'market:tavern');
  assert.equal(rest.length, 5);
  assert.deepEqual(rest.find((s) => s.key === 'harbor:smuggler'), a.find((s) => s.key === 'harbor:smuggler'), 'filling one role leaves the others unchanged');
  assert.ok(!populateSuggestions(map, model, [900, 640]).some((s) => s.x * 900 === 90 && s.y * 640 === 100), 'landmark buildings are not reused');
});

test('populate reads the model only', async () => {
  const { populateSuggestions } = await load('maps/populate.js');
  const { map, model } = town();
  const before = JSON.stringify({ map, model });
  populateSuggestions(map, model, [900, 640]);
  assert.equal(JSON.stringify({ map, model }), before);
});

function network() {
  const sites = [
    { key: 'region:0:a', name: 'Ashford', x: 0, y: 0 },
    { key: 'region:1:b', name: 'Brindle', x: 100, y: 0 },
    { key: 'region:2:c', name: 'Cove', x: 100, y: 100 },
    { key: 'region:3:d', name: 'Dunmere', x: 300, y: 100 },
    { key: 'region:4:e', name: 'Eyot', x: 600, y: 600 },
  ];
  const roads = [
    [[1, 1], [50, 0], [99, 1]],
    [[100, 2], [100, 98]],
    [[0, 2], [100, 99]],
  ];
  const ferries = [[[100, 100], [300, 100]]];
  return { sites, roads, ferries };
}

test('journeys take the shortest route over roads and ferries', async () => {
  const { travelGraph, planJourney } = await load('maps/journey.js');
  const { sites, roads, ferries } = network();
  const graph = travelGraph(sites, roads, ferries);
  assert.equal(graph.edges.length, 4);
  const route = planJourney(graph, 'region:0:a', 'region:3:d');
  assert.deepEqual(route.legs.map((l) => [l.from.name, l.to.name, l.mode]), [['Ashford', 'Cove', 'road'], ['Cove', 'Dunmere', 'ferry']]);
  assert.deepEqual(route.legs[0].pts[0], [0, 2], 'legs run in travel order');
  const back = planJourney(graph, 'region:3:d', 'region:0:a');
  assert.deepEqual(back.legs.map((l) => l.to.name), ['Cove', 'Ashford']);
  assert.equal(planJourney(graph, 'region:0:a', 'region:4:e'), null, 'an unconnected place has no route');
  assert.equal(planJourney(graph, 'region:0:a', 'region:0:a'), null);
});

test('equal routes resolve by site key, whatever the input order', async () => {
  const { travelGraph, planJourney } = await load('maps/journey.js');
  const sites = [
    { key: 'k:0:start', name: 'Start', x: 0, y: 0 }, { key: 'k:2:zeta', name: 'Zeta', x: 50, y: 50 },
    { key: 'k:1:alpha', name: 'Alpha', x: 50, y: -50 }, { key: 'k:3:end', name: 'End', x: 100, y: 0 },
  ];
  const roads = [[[0, 0], [50, 50]], [[50, 50], [100, 0]], [[0, 0], [50, -50]], [[50, -50], [100, 0]]];
  for (const order of [roads, [...roads].reverse()]) {
    const route = planJourney(travelGraph(sites, order, []), 'k:0:start', 'k:3:end');
    assert.deepEqual(route.legs.map((l) => l.to.name), ['Alpha', 'End']);
  }
});

test('travel days follow the scale, units and paces', async () => {
  const { travelGraph, planJourney, journeyTime } = await load('maps/journey.js');
  const { sites, roads, ferries } = network();
  const route = planJourney(travelGraph(sites, roads, ferries), 'region:0:a', 'region:3:d');
  assert.equal(journeyTime(route, { distance: 0, width: 960 }, 30, 120), null, 'no scale, no days');
  const time = journeyTime(route, { distance: 960, units: 'km', width: 960 }, 30, 120);
  const road = Math.hypot(100, 97);
  assert.ok(Math.abs(time.length - (road + 200)) < 1e-6);
  assert.equal(time.days, Math.ceil(road / 30 + 200 / 120));
  const miles = journeyTime(route, { distance: 960, units: 'mi', width: 960 }, 30, 120);
  assert.ok(miles.exactDays > time.exactDays, 'a mile is longer than a kilometer');
});

test('modern towns are deterministic, keyed and populated from their own model', async () => {
  const { buildModernTown, MODERN_LAYOUTS } = await load('maps/moderntown.js');
  const { townKeys } = await load('maps/mapkeys.js');
  const { populateSuggestions, canPopulate } = await load('maps/populate.js');
  const plain = (m) => JSON.stringify(m, (k, v) => (typeof v === 'function' ? undefined : v));
  for (const layout of Object.keys(MODERN_LAYOUTS).filter((k) => k !== 'auto')) {
    const map = { kind: 'town', seed: 'harlan', params: { era: 'modern', modernLayout: layout, size: 3 } };
    const model = buildModernTown(map);
    assert.equal(plain(model), plain(buildModernTown(structuredClone(map))), `${layout} is deterministic`);
    assert.equal(model.era, 'modern');
    assert.ok(model.buildings.length > 100, `${layout} has buildings`);
    assert.ok(new Set(model.roads.map((r) => r.cls)).size >= 3, `${layout} has street classes`);
    assert.ok(model.districts.some((d) => d.use === 'suburban' || d.use === 'residential'));
    const places = townKeys.places(map, model, 0, [900, 640]);
    assert.ok(places.length >= 5 && places.every((p) => /^landmark:\d+:/.test(p.anchor)));
    assert.equal(canPopulate(model), true);
    assert.ok(populateSuggestions(map, model, [900, 640]).length >= 6);
  }
  // renames never move a key's anchor
  const map = { kind: 'town', seed: 'harlan', params: { era: 'modern', modernLayout: 'grid', size: 3 } };
  const before = townKeys.places(map, buildModernTown(map), 0, [900, 640]);
  map.placeNames = { 0: 'Town Hall of Harlan' };
  const after = townKeys.places(map, buildModernTown(map), 0, [900, 640]);
  assert.deepEqual(after.map((p) => p.anchor), before.map((p) => p.anchor));
  assert.equal(after[0].label, 'Town Hall of Harlan');
});

test('a drilled town takes its map’s era, else the world default', async () => {
  const { drilledTownEra } = await load('maps/crossscale.js');
  const region = (townEra) => ({ kind: 'region', params: townEra === undefined ? {} : { townEra } });
  assert.equal(drilledTownEra(region(), {}), 'historical', 'nothing set: historical');
  assert.equal(drilledTownEra(region(), { townEra: 'modern' }), 'modern', 'the world default applies');
  assert.equal(drilledTownEra(region(''), { townEra: 'modern' }), 'modern', '“World default” defers to the world');
  assert.equal(drilledTownEra(region('historical'), { townEra: 'modern' }), 'historical', 'a map can keep its towns historical');
  assert.equal(drilledTownEra(region('modern'), {}), 'modern', 'a map can make its towns modern');
  assert.equal(drilledTownEra(region('steampunk'), {}), 'historical', 'unknown values fall back');
  assert.equal(drilledTownEra(null, null), 'historical');
});

test('advancing the clock crosses months and special days, and declines invalid dates', async () => {
  const { advanceDate } = await load('calendar.js');
  const cal = { months: ['Frost', 'Thaw'], monthDays: [30, 30], intercalary: [{ id: 'midwinter', name: 'Midwinter', after: 1, days: 1 }] };
  assert.deepEqual(advanceDate({ year: 1026, month: 1, day: 29 }, cal, 2), { year: 1026, special: 'midwinter', day: 1 });
  assert.deepEqual(advanceDate({ year: 1026, month: 1, day: 29 }, cal, 3), { year: 1026, month: 2, day: 1 });
  assert.deepEqual(advanceDate({ year: 1026, month: 2, day: 30 }, cal, 1), { year: 1027, month: 1, day: 1 });
  assert.equal(advanceDate({ year: 1026, month: 1, day: 41 }, cal, 1), null, 'the no-clamp rule: invalid dates are declined');
});
