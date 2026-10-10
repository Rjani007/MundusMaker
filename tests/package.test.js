'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { writeZip, crc32 } = require('../scripts/zip');
const { APP_FILES, GUIDES, includeInPackage, packagedReadme, copy, assertOwnedWork, macBundle, archiveEntries } = require('../scripts/package');
test('distributions reject nested contributor instructions and private/development folders', () => {
  for (const p of ['AGENTS.md', 'public/a/ClAuDe.MD', 'sample/agents.local.md', 'public/AGENTS.md.bak', '.git/config', 'public/.env', 'data/worlds/a/world.json', 'tests/fixture.json', 'public/.codex/SKILL.md', 'CLAUDE.md', 'public/mundusmaker.config.json', 'secrets/mundusmaker-password.txt', '.env', 'public/Secrets/password.txt', 'docs/data-safety.md', 'docs/1.9.0-plan.md', 'docs/audits/x.md', '.git/HEAD', '.github/workflows/ci.yml']) assert.equal(includeInPackage(p), false, p);
  for (const p of ['public/js/sheets/dndrules.js', 'sample/world.json', 'DATA-SAFETY.md', 'DOCKER.md', 'README-FIRST.html', 'MundusMaker.app/Contents/MacOS/MundusMaker', '.dockerignore', 'Dockerfile', 'compose.yaml', 'scripts/container.js']) assert.equal(includeInPackage(p), true, p);
  assert.throws(() => assertOwnedWork(path.resolve(__dirname, '../data')), /cleanup/);
  assert.throws(() => assertOwnedWork(path.resolve(__dirname, '../dist/work')), /cleanup/);
  assert.equal(assertOwnedWork(path.resolve(__dirname, '../dist/work/stage-universal')), path.resolve(__dirname, '../dist/work/stage-universal'));
});
test('ZIPs are independently readable and carry Unix startup modes and UTF-8 filenames', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-zip-'));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker-zip-')); fs.rmSync(tmp, { recursive: true, force: true }); });
  const zip = path.join(tmp, 'app.zip');
  const payload = Buffer.from('#!/bin/sh\nprintf "MundusMaker"\n');
  writeZip(zip, [{ name: 'app/', mode: 0o755 }, { name: 'app/start.sh', data: payload, mode: 0o755 }, { name: 'app/règles.txt', data: Buffer.from('Local notes'), mode: 0o644 }]);
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
  assert.match(execFileSync(tar, ['-tf', zip], { encoding: 'utf8' }), /start.sh/);
  assert.deepEqual(execFileSync(tar, ['-xOf', zip, 'app/start.sh']), payload);
  const buf = fs.readFileSync(zip), end = buf.length - 22;
  let cursor = buf.readUInt32LE(end + 16), checked = 0;
  while (buf.readUInt32LE(cursor) === 0x02014b50) {
    const len = buf.readUInt16LE(cursor + 28), name = buf.subarray(cursor + 46, cursor + 46 + len).toString('utf8');
    assert.equal(buf.readUInt16LE(cursor + 4) >> 8, 3);
    assert.ok(buf.readUInt16LE(cursor + 8) & 0x800);
    assert.equal(buf.readUInt32LE(cursor + 38) >>> 16 & 0o777, name.endsWith('.txt') ? 0o644 : 0o755);
    if (name.endsWith('.sh')) {
      const local = buf.readUInt32LE(cursor + 42), start = local + 30 + buf.readUInt16LE(local + 26);
      assert.deepEqual(zlib.inflateRawSync(buf.subarray(start, start + buf.readUInt32LE(cursor + 20))), payload);
      assert.equal(buf.readUInt32LE(cursor + 16), crc32(payload));
    }
    checked++; cursor += 46 + len + buf.readUInt16LE(cursor + 30) + buf.readUInt16LE(cursor + 32);
  }
  assert.equal(checked, 3); assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => writeZip(path.join(tmp, 'bad.zip'), [{ name: '../data/a', data: payload }]), /Unsafe/);
});
test('Mac bundle includes Finder metadata, a valid icon container and an executable LF launcher', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-bundle-'));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker-bundle-')); fs.rmSync(tmp, { recursive: true, force: true }); });
  assert.match(macBundle(tmp), /Resources[\\/]app$/);
  const contents = path.join(tmp, 'MundusMaker.app/Contents');
  const plist = fs.readFileSync(path.join(contents, 'Info.plist'), 'utf8');
  assert.match(plist, /CFBundleExecutable<\/key><string>MundusMaker/); assert.match(plist, /LSUIElement<\/key><true/);
  const icon = fs.readFileSync(path.join(contents, 'Resources/MundusMaker.icns'));
  assert.equal(icon.toString('ascii', 0, 4), 'icns'); assert.equal(icon.readUInt32BE(4), icon.length);
  const entries = archiveEntries(tmp); const launcher = entries.find(e => e.name.endsWith('/MacOS/MundusMaker'));
  assert.equal(launcher.mode, 0o755); assert.ok(!fs.readFileSync(launcher.file).includes(13));
  assert.match(fs.readFileSync(launcher.file, 'utf8'), /exec \/usr\/bin\/osascript/);
});
test('universal archives mark every Unix runtime executable', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-modes-'));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker-modes-')); fs.rmSync(tmp, { recursive: true, force: true }); });
  const files = ['runtime/bin/node', 'runtime/linux-x64/bin/node', 'runtime/linux-arm64/bin/node',
    'MundusMaker.app/Contents/Resources/app/runtime/macos-arm64/bin/node',
    'MundusMaker.app/Contents/Resources/app/runtime/macos-x64/bin/node', 'Start-MundusMaker.command', 'start-mundusmaker.sh', 'runtime/LICENSE.txt'];
  for (const file of files) { const dest = path.join(tmp, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'fixture'); }
  for (const entry of archiveEntries(tmp).filter(e => e.file)) assert.equal(entry.mode, entry.name.endsWith('LICENSE.txt') ? 0o644 : 0o755, entry.name);
});
test('the staged app carries no contributor notes, docs folder or git history, and its links resolve', t => {
  const ROOT = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-stage-'));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker-stage-')); fs.rmSync(tmp, { recursive: true, force: true }); });
  const out = path.join(tmp, 'MundusMaker');
  for (const file of APP_FILES) copy(path.join(ROOT, file), path.join(out, file));
  for (const [from, to] of Object.entries(GUIDES)) copy(path.join(ROOT, from), path.join(out, to));
  const names = archiveEntries(out).map((e) => e.name);
  assert.ok(names.length > 100);
  for (const name of names) {
    assert.doesNotMatch(name, /(^|\/)(docs|\.git|tests|tmp|data)(\/|$)/i, name);
    assert.doesNotMatch(name, /(^|\/)(agents|claude)\.md$/i, name);
    assert.doesNotMatch(name, /^MundusMaker\/mobile\//i, name); // the phone apps build from the repo, not the download
  }
  for (const guide of Object.values(GUIDES)) assert.ok(names.includes(`MundusMaker/${guide}`), guide);
  // every relative link in the shipped README and README-FIRST points at a shipped file
  for (const page of ['README.md', 'README-FIRST.html']) {
    const text = fs.readFileSync(path.join(out, page), 'utf8');
    const links = [...text.matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"/g)].map((m) => m[1] || m[2]).filter((l) => !/^(https?:|mailto:|#)/.test(l));
    for (const link of links) assert.ok(fs.existsSync(path.join(out, link.split('#')[0])), `${page} links to missing ${link}`);
  }
  assert.equal(packagedReadme('[guide](docs/docker.md), [notes](docs/1.9.0-release.md)'), '[guide](DOCKER.md), notes');
});
