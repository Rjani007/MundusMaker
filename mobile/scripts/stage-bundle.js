#!/usr/bin/env node
'use strict';
/*
 * Stages what the phone app carries: the shared app (exactly the desktop
 * download's APP_FILES from scripts/package.js, minus the launchers and Docker
 * files) plus the mobile runtime, as one bundle.zip with a bundle.json beside
 * it. The Android build runs this (app/build.gradle, stageBundle); the app
 * unpacks the zip on first start and whenever its checksum changes
 * (BundleInstaller.java).
 *
 *   node mobile/scripts/stage-bundle.js <outDir>
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { APP_FILES, includeInPackage } = require('../../scripts/package.js');
const { writeZip } = require('../../scripts/zip.js');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'mobile', 'shared', 'runtime');
// desktop-only entries of APP_FILES: the README describes the desktop download,
// and the rest start or host the desktop server
const DESKTOP_ONLY = new Set(['README.md', 'scripts/unix-runtime.sh', 'scripts/container.js', 'Dockerfile', 'compose.yaml', '.dockerignore']);

function walk(rel, entries) {
  const abs = path.join(ROOT, rel);
  if (!includeInPackage(rel)) throw new Error(`Contributor or private file reached the phone bundle: ${rel}`);
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) throw new Error(`Symlink reached the phone bundle: ${rel}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(`${rel}/${name}`, entries);
  } else {
    entries.push({ name: rel, file: abs });
  }
}

function stage(outDir) {
  const entries = [];
  for (const rel of APP_FILES) if (!DESKTOP_ONLY.has(rel)) walk(rel, entries);
  for (const name of fs.readdirSync(RUNTIME).sort()) {
    if (name.endsWith('.js')) entries.push({ name: `runtime/${name}`, file: path.join(RUNTIME, name) });
  }
  for (const required of ['server.js', 'package.json', 'public/index.html', 'sample/world.json', 'runtime/worker.js', 'runtime/node.js', 'runtime/boot.js']) {
    if (!entries.some((e) => e.name === required)) throw new Error(`The phone bundle is missing ${required}`);
  }
  // the checksum covers names and bytes, so the app re-unpacks only when something changed
  const hash = crypto.createHash('sha256');
  for (const e of entries) hash.update(`${e.name}\0`).update(fs.readFileSync(e.file)).update('\0');
  const sha256 = hash.digest('hex');
  fs.mkdirSync(outDir, { recursive: true });
  const zip = path.join(outDir, 'bundle.zip');
  writeZip(`${zip}.partial`, entries);
  fs.renameSync(`${zip}.partial`, zip);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(outDir, 'bundle.json'), `${JSON.stringify({ version, files: entries.length, sha256 }, null, 2)}\n`);
  return { files: entries.length, names: entries.map((e) => e.name), sha256, bytes: fs.statSync(zip).size };
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: node mobile/scripts/stage-bundle.js <outDir>');
    process.exit(2);
  }
  const result = stage(path.resolve(outDir));
  console.log(`staged ${result.files} files (${(result.bytes / 1048576).toFixed(1)} MB, ${result.sha256.slice(0, 12)}) into ${outDir}`);
}

module.exports = { stage, DESKTOP_ONLY };
