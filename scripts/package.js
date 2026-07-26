// Builds one-click distributables: the app + a bundled Node runtime, so GMs
// don't have to install anything. Zero dependencies; uses the system `tar`
// (present on Windows 10+, macOS and Linux) for extracting and archiving.
//
//   node scripts/package.js                  → windows-x64 zip
//   node scripts/package.js macos-arm64      → tar.gz (build on macOS/Linux to keep the exec bit)
//   node scripts/package.js all              → every target
//
// Output lands in dist/.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, 'cache');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const TARGETS = {
  'windows-x64': { nodeSuffix: 'win-x64.zip', nodeBin: 'node.exe', runtimePath: ['runtime', 'node.exe'], archive: 'zip' },
  'macos-arm64': { nodeSuffix: 'darwin-arm64.tar.gz', nodeBin: 'bin/node', runtimePath: ['runtime', 'bin', 'node'], archive: 'tar.gz' },
  'macos-x64': { nodeSuffix: 'darwin-x64.tar.gz', nodeBin: 'bin/node', runtimePath: ['runtime', 'bin', 'node'], archive: 'tar.gz' },
  'linux-x64': { nodeSuffix: 'linux-x64.tar.gz', nodeBin: 'bin/node', runtimePath: ['runtime', 'bin', 'node'], archive: 'tar.gz' },
};

// files shipped to end users (data/, dist/, node_modules/ etc. stay behind)
const APP_FILES = [
  'server.js', 'package.json', 'LICENSE', 'README.md',
  'Start-TomeWeaver.bat', 'Start-TomeWeaver.command', 'start-tomeweaver.sh',
  'public', 'sample',
];

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function latestLtsVersion() {
  const index = JSON.parse((await fetchBuffer('https://nodejs.org/dist/index.json')).toString('utf8'));
  const lts = index.find((v) => v.lts); // list is newest-first
  if (!lts) throw new Error('could not find an LTS release in the Node index');
  return lts.version; // e.g. "v22.14.0"
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function build(target, nodeVersion) {
  const spec = TARGETS[target];
  console.log(`\n=== ${target} (app v${APP_VERSION}, node ${nodeVersion}) ===`);

  // 1. download the official Node build (cached)
  const nodeName = `node-${nodeVersion}-${spec.nodeSuffix}`;
  const cached = path.join(CACHE, nodeName);
  if (!fs.existsSync(cached)) {
    console.log(`downloading ${nodeName}…`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(cached, await fetchBuffer(`https://nodejs.org/dist/${nodeVersion}/${nodeName}`));
  } else {
    console.log(`using cached ${nodeName}`);
  }

  // 2. extract just the node binary
  const work = path.join(DIST, 'work', target);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xf', cached, '-C', work]);
  const extractedRoot = path.join(work, fs.readdirSync(work)[0]);
  const nodeBinary = path.join(extractedRoot, ...spec.nodeBin.split('/'));
  if (!fs.existsSync(nodeBinary)) throw new Error(`node binary not found at ${nodeBinary}`);

  // 3. assemble the app folder — staged under work/ so it never collides with
  //    an extracted copy someone is browsing or running out of dist/
  const outName = `TomeWeaver-${APP_VERSION}-${target}`;
  const stageRoot = path.join(DIST, 'work', `stage-${target}`);
  const outDir = path.join(stageRoot, outName);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (fs.statSync(src).isDirectory()) copyDirSync(src, path.join(outDir, f));
    else fs.copyFileSync(src, path.join(outDir, f));
  }
  const runtimeDest = path.join(outDir, ...spec.runtimePath);
  fs.mkdirSync(path.dirname(runtimeDest), { recursive: true });
  fs.copyFileSync(nodeBinary, runtimeDest);
  if (process.platform !== 'win32') fs.chmodSync(runtimeDest, 0o755);

  // 4. archive
  let archive;
  if (spec.archive === 'zip') {
    archive = path.join(DIST, `${outName}.zip`);
    fs.rmSync(archive, { force: true });
    execFileSync('tar', ['-a', '-cf', archive, '-C', stageRoot, outName]);
  } else {
    archive = path.join(DIST, `${outName}.tar.gz`);
    fs.rmSync(archive, { force: true });
    execFileSync('tar', ['-czf', archive, '-C', stageRoot, outName]);
    if (process.platform === 'win32') {
      console.log('note: building a unix target on Windows cannot preserve the exec bit;');
      console.log('      users may need to run  chmod +x runtime/bin/node  once.');
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(stageRoot, { recursive: true, force: true });
  const mb = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${archive} (${mb} MB)`);
  return archive;
}

(async () => {
  const arg = process.argv[2] || 'windows-x64';
  const targets = arg === 'all' ? Object.keys(TARGETS) : [arg];
  for (const t of targets) {
    if (!TARGETS[t]) {
      console.error(`unknown target "${t}" — use one of: ${Object.keys(TARGETS).join(', ')}, all`);
      process.exit(1);
    }
  }
  const nodeVersion = await latestLtsVersion();
  for (const t of targets) await build(t, nodeVersion);
  console.log('\nDone. Share the archive — unzip, double-click the Start-TomeWeaver launcher, play.');
})().catch((err) => {
  console.error('packaging failed:', err.message);
  process.exit(1);
});
