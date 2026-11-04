#!/usr/bin/env node
'use strict';
/*
 * Stages MundusMaker for the website (docs/website.md): the app's public/
 * files as they are, the page shell from web/, the phone runtime, and a
 * read-only bundle of what server.js needs (the desktop download's APP_FILES,
 * minus what only the desktop uses). Copying only, no build: the files the
 * browser gets are the ones in the repository. The Pages workflow stages into
 * site/app/; `npm run site` serves the same entries straight from the repo.
 *
 *   node scripts/stage-web.js <outDir>
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { APP_FILES, includeInPackage } = require('./package.js');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const PUBLIC = path.join(ROOT, 'public');
const RUNTIME = path.join(ROOT, 'mobile', 'shared', 'runtime', 'node.js');
const SHELL = ['boot.js', 'engine.js', 'memfs.js', 'store.js', 'sync.js', 'cloud.js', 'web.css'];
// server.js and what it reads; launchers, Docker files and the README stay with the desktop download
const BUNDLE = APP_FILES.filter((f) => !['public', 'LICENSE', 'README.md', 'scripts/unix-runtime.sh', 'scripts/container.js', 'Dockerfile', 'compose.yaml', '.dockerignore'].includes(f));
// the website's own project (site/config.js); the page may talk to nothing else
const CONNECT = ["'self'", 'https://zrophtozeecslvsecndo.supabase.co', 'http://127.0.0.1:56421'];
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  `connect-src ${CONNECT.join(' ')}`, "worker-src 'self'", "font-src 'self' data:", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

function walk(abs, rel, out) {
  if (!includeInPackage(rel)) throw new Error(`Contributor or private file reached the website: ${rel}`);
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) throw new Error(`Symlink reached the website: ${rel}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), `${rel}/${name}`, out);
  } else {
    out.push({ rel, file: abs, size: stat.size });
  }
}

/** The app's index.html for the website: the shell's stylesheet and boot script in place of main.js, and a CSP. */
function webIndex(html) {
  const out = html
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
    .replace('<link rel="stylesheet" href="css/app.css">', '<link rel="stylesheet" href="css/app.css">\n<link rel="stylesheet" href="web/web.css">')
    .replace('<script type="module" src="js/main.js"></script>', '<script type="module" src="web/boot.js"></script>');
  if (!out.includes('web/boot.js') || !out.includes('web/web.css') || !out.includes('Content-Security-Policy')) {
    throw new Error('public/index.html changed shape: update webIndex() in scripts/stage-web.js');
  }
  return out;
}

/**
 * The installable app's identity on the website. The desktop's id "/" means
 * the site's whole origin there, which Elysium shares, so the website's copy
 * has none and the browser uses its start address, the app's own folder.
 */
function webManifest(text) {
  const manifest = JSON.parse(text);
  delete manifest.id;
  manifest.description = 'The worldbuilding wiki for game masters, in your browser: typed entries, secrets, maps, timelines and player-safe exports.';
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Every file the website serves under app/, as { path, file } (copied) or
 * { path, data } (written). `build` names the service worker's cache: the
 * version and a hash of every file, so a new release replaces the old cache.
 */
function webEntries({ build } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pub = [];
  walk(PUBLIC, 'public', pub);
  const bundle = [];
  for (const rel of BUNDLE) walk(path.join(ROOT, rel), rel, bundle);
  for (const required of ['server.js', 'package.json', 'sample/world.json', 'scripts/storage.js']) {
    if (!bundle.some((e) => e.rel === required)) throw new Error(`The website bundle is missing ${required}`);
  }
  const entries = [];
  for (const e of pub) {
    const at = e.rel.slice('public/'.length);
    if (at === 'index.html') entries.push({ path: at, data: Buffer.from(webIndex(fs.readFileSync(e.file, 'utf8'))) });
    else if (at === 'manifest.webmanifest') entries.push({ path: at, data: Buffer.from(webManifest(fs.readFileSync(e.file, 'utf8'))) });
    else entries.push({ path: at, file: e.file });
  }
  for (const name of SHELL) entries.push({ path: `web/${name}`, file: path.join(WEB, name) });
  entries.push({ path: 'web/node.js', file: RUNTIME });
  for (const e of bundle) entries.push({ path: `web/bundle/${e.rel}`, file: e.file });
  const manifest = { version: pkg.version, built: Date.now(), files: Object.fromEntries(bundle.map((e) => [e.rel, e.size])) };
  entries.push({ path: 'web/bundle/manifest.json', data: Buffer.from(`${JSON.stringify(manifest)}\n`) });

  let tag = build;
  if (!tag) {
    const hash = crypto.createHash('sha256');
    for (const e of entries.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (e.path === 'web/bundle/manifest.json') continue; // its build time changes on every run
      hash.update(`${e.path}\0`).update(e.data || fs.readFileSync(e.file)).update('\0');
    }
    hash.update(fs.readFileSync(path.join(WEB, 'sw.js')));
    tag = `${pkg.version}-${hash.digest('hex').slice(0, 12)}`;
  }
  const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  if (!/const BUILD = 'dev';/.test(sw)) throw new Error('web/sw.js lost its BUILD line: update webEntries() in scripts/stage-web.js');
  entries.push({ path: 'sw.js', data: Buffer.from(sw.replace("const BUILD = 'dev';", `const BUILD = '${tag}';`)) });
  return entries;
}

function stage(outDir) {
  const entries = webEntries();
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const e of entries) {
    const dest = path.join(outDir, ...e.path.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (e.data) fs.writeFileSync(dest, e.data); else fs.copyFileSync(e.file, dest);
  }
  return { files: entries.length, bytes: entries.reduce((n, e) => n + (e.data ? e.data.length : fs.statSync(e.file).size), 0) };
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: node scripts/stage-web.js <outDir>');
    process.exit(2);
  }
  const result = stage(path.resolve(outDir));
  console.log(`staged ${result.files} files (${(result.bytes / 1048576).toFixed(1)} MB) into ${outDir}`);
}

module.exports = { stage, webEntries, webIndex, BUNDLE, CSP };
