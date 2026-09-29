#!/usr/bin/env node
'use strict';
/*
 * Map render check: renders every hash fixture in a headless Chromium browser
 * (Edge or Chrome, driven over the DevTools protocol with Node's built-in
 * WebSocket, so no dependencies) and compares PNG hashes with the baselines.
 *
 *   node scripts/render-check.js                 verify every baseline set
 *   node scripts/render-check.js --only town     verify fixtures whose name contains "town"
 *   node scripts/render-check.js --png out/      also write each render to out/<name>.png
 *   node scripts/render-check.js --record 1.8    add baselines for 1.8 fixtures that have none
 *
 * Recording only fills in fixtures that have no baseline yet. It never rewrites
 * an existing hash unless --overwrite is also given, and never touches the
 * legacy set: re-baselining is a deliberate decision, not a way to get a pass.
 * The server runs on a temporary data folder, never the owner's data/.
 * Set MUNDUSMAKER_BROWSER to use a specific browser executable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const SETS = {
  legacy: { baselines: path.join(TESTS, 'map-baselines.json') },
  '1.8': { baselines: path.join(TESTS, 'map-baselines-18.json'), fixtures: path.join(TESTS, 'map-fixtures-18.json') },
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = value('--only');
const pngDir = value('--png');
const recordSet = value('--record');
const overwrite = flag('--overwrite');

const { EnvironmentError, startSession } = require('./browser-harness');

// Runs inside the page. Builds recipe fixtures the way the app itself creates
// maps (newMap + overrides, or the editor's world-to-region drill), renders
// each one and returns its PNG hash.
async function renderInPage({ fixtures, wantMaps, wantPng }) {
  const core = await import('/js/maps/mapcore.js');
  const cross = await import('/js/maps/crossscale.js');
  const fromRecipe = (r) => {
    const map = core.newMap(r.newMap);
    map.seed = r.seed;
    Object.assign(map.params, r.params || {});
    return Object.assign(map, structuredClone(r.extra || {}));
  };
  const drill = (r) => {
    const world = fromRecipe(r);
    const kind = core.MAP_KINDS.world;
    const model = kind.buildModel(world);
    const [w, h] = kind.size(world);
    const site = cross.regionSites(world, model, [w, h])[r.site || 0];
    if (!site) throw new Error('The drill recipe found no region site');
    const region = core.newMap('region');
    region.seed = cross.regionSeedForSite(world, site);
    const carve = cross.extractCarve(model, site, kind.drillContext ? kind.drillContext(world, model) : {});
    if (carve) region.carve = carve;
    Object.assign(region.params, cross.regionParamsForSite(model, site, carve));
    const inherited = cross.inheritedRegionSites(world, model, site, carve);
    if (inherited.length) {
      region.sites = inherited;
      const target = region.params.settlements ?? 4;
      region.params.settlements = Math.max(1, Math.min(9, target - inherited.length));
    }
    return region;
  };
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const rows = [];
  for (const f of fixtures) {
    const map = f.map || (f.drill ? drill(f.drill) : fromRecipe(f));
    const start = performance.now();
    const canvas = core.renderMap(document.createElement('canvas'), structuredClone(map), f.opts || { gm: true });
    const ms = Math.round(performance.now() - start);
    const b64 = canvas.toDataURL('image/png').split(',')[1];
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    rows.push({
      name: f.name,
      hash: hex(await crypto.subtle.digest('SHA-256', bytes)),
      ms,
      ...(wantMaps ? { map } : {}),
      ...(wantPng ? { png: b64 } : {}),
    });
  }
  return rows;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

async function main() {
  if (recordSet && !SETS[recordSet]?.fixtures) throw new EnvironmentError(`Only these sets can be recorded: ${Object.keys(SETS).filter((k) => SETS[k].fixtures).join(', ')}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-render-'));
  let session;
  try {
    session = await startSession(temp, path.join(temp, 'data'));
    const { client, sessionId } = session;

    // One fixture per call: a whole set's PNGs and carves in one reply is more
    // than the DevTools connection will carry.
    const run = async (fixtures, wantMaps) => {
      const rows = [];
      if (pngDir) fs.mkdirSync(pngDir, { recursive: true });
      for (const fixture of fixtures) {
        const expression = `(${renderInPage.toString()})(${JSON.stringify({ fixtures: [fixture], wantMaps, wantPng: !!pngDir })})`;
        const reply = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (reply.exceptionDetails) {
          throw new Error(`${fixture.name}: ${reply.exceptionDetails.exception?.description || reply.exceptionDetails.text}`);
        }
        const [row] = reply.result.value;
        if (pngDir) fs.writeFileSync(path.join(pngDir, `${row.name}.png`), Buffer.from(row.png, 'base64'));
        delete row.png;
        rows.push(row);
      }
      return rows;
    };
    const selected = (list) => list.filter((f) => !only || f.name.includes(only));

    if (recordSet) {
      const set = SETS[recordSet];
      const existing = readJson(set.baselines, []);
      const known = new Map(existing.map((b) => [b.name, b]));
      const fixtures = selected(readJson(set.fixtures));
      const todo = fixtures.filter((f) => overwrite || !known.has(f.name));
      const rows = todo.length ? await run(todo, true) : [];
      for (const row of rows) {
        const fixture = todo.find((f) => f.name === row.name);
        known.set(row.name, { name: row.name, map: row.map, ...(fixture.opts ? { opts: fixture.opts } : {}), hash: row.hash, ms: row.ms });
        console.log(`recorded  ${row.name}  ${row.ms} ms`);
      }
      const order = readJson(set.fixtures).map((f) => f.name);
      const merged = [...known.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      fs.writeFileSync(set.baselines, JSON.stringify(merged, null, 2) + '\n');
      console.log(`${rows.length} recorded, ${fixtures.length - todo.length} already had baselines (${path.relative(ROOT, set.baselines)}).`);
      return 0;
    }

    let failures = 0, total = 0, missingCount = 0;
    for (const [setName, set] of Object.entries(SETS)) {
      const baselines = selected(readJson(set.baselines, []));
      const rows = baselines.length ? await run(baselines.map(({ name, map, opts }) => ({ name, map, opts })), false) : [];
      for (const row of rows) {
        total++;
        const expected = baselines.find((b) => b.name === row.name).hash;
        const ok = expected === row.hash;
        if (!ok) failures++;
        console.log(`${ok ? 'match  ' : 'CHANGED'}  ${setName.padEnd(6)}  ${row.name}  ${row.ms} ms`);
      }
      if (set.fixtures) {
        const missing = selected(readJson(set.fixtures)).filter((f) => !baselines.some((b) => b.name === f.name));
        for (const f of missing) { missingCount++; console.log(`MISSING  ${setName.padEnd(6)}  ${f.name} has no baseline (record it deliberately with --record ${setName})`); }
      }
    }
    if (!failures && !missingCount) console.log(`\nAll ${total} map renders match their baselines.`);
    else console.log(`\n${failures} of ${total} map renders changed; ${missingCount} fixture(s) have no baseline.`);
    return failures || missingCount ? 1 : 0;
  } finally {
    if (session) await session.close();
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a browser file may still be locked */ }
  }
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(err instanceof EnvironmentError ? err.message : err);
  process.exitCode = err instanceof EnvironmentError ? 2 : 1;
});
