// Zero-dependency releases: system tar extracts Node; ZIP metadata preserves
// executable permissions even when the release is assembled on Windows.
'use strict';
const fs = require('fs'), path = require('path'), https = require('https');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { writeZip } = require('./zip');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist'), CACHE = path.join(DIST, 'cache'), WORK = path.join(DIST, 'work');
const APP_VERSION = require('../package.json').version;
// Git-for-Windows tar cannot handle drive-letter paths.
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const TARGETS = {
  'windows-x64': { suffix: 'win-x64.zip', bin: 'node.exe', runtime: 'runtime/MundusMaker.exe' },
  'macos-arm64': { suffix: 'darwin-arm64.tar.gz', bin: 'bin/node', runtime: 'runtime/bin/node', mac: true },
  'macos-x64': { suffix: 'darwin-x64.tar.gz', bin: 'bin/node', runtime: 'runtime/bin/node', mac: true },
  'linux-x64': { suffix: 'linux-x64.tar.gz', bin: 'bin/node', runtime: 'runtime/bin/node' },
  'linux-arm64': { suffix: 'linux-arm64.tar.gz', bin: 'bin/node', runtime: 'runtime/bin/node' },
};
const APP_FILES = ['server.js', 'package.json', 'LICENSE', 'README.md', 'public', 'sample',
  'scripts/fetch-5etools.js', 'scripts/updates.js', 'scripts/sheetdownload.js', 'scripts/storage.js', 'scripts/restore.js', 'scripts/upgrade.js', 'scripts/folderbackup.js', 'scripts/unix-runtime.sh',
  'scripts/container.js', 'Dockerfile', 'compose.yaml', '.dockerignore'];
// docs/ is contributor material (plans, release notes, audits) and never ships.
// The few pages written for GMs go to the top of the download under plain names.
const GUIDES = { 'docs/distribution.html': 'README-FIRST.html', 'docs/docker.md': 'DOCKER.md', 'docs/data-safety.md': 'DATA-SAFETY.md' };
const WINDOWS_FILES = ['Start-MundusMaker.bat', 'MundusMaker-Console.bat', 'Install-MundusMaker.ps1', 'Install-MundusMaker.bat', 'MundusMaker-Tray.ps1'];
function includeInPackage(file) {
  return file.split(/[\\/]/).every(part => (!part.startsWith('.') || part === '.dockerignore')
    && !/^(agents|claude|gemini|skill)(?:[.-]|$)/i.test(part)
    && !/^(?:node_modules|data|secrets|tests?|tmp|dist|docs|coverage|__pycache__)$/i.test(part)
    && !/^(?:mundusmaker|tomeweaver|loreweave)\.config\.json$/i.test(part)
    && !/^(?:session_handoff|copilot-instructions)\./i.test(part));
}
// README.md is the repository's front page; in the download its links into
// docs/ point at the guides shipped beside it, and the rest become plain text.
function packagedReadme(text) {
  return text.replace(/\[([^\]]+)\]\((docs\/[^)\s]+)\)/g, (link, label, target) => GUIDES[target] ? `[${label}](${GUIDES[target]})` : label);
}
const sha256 = data => createHash('sha256').update(data).digest('hex');
function assertOwnedWork(dir) {
  const absolute = path.resolve(dir);
  if (path.dirname(absolute) !== WORK || ![...Object.keys(TARGETS), 'universal'].some(t => path.basename(absolute) === t || path.basename(absolute) === `stage-${t}`)) throw new Error('Refusing work cleanup outside a packaging target');
  for (const candidate of [DIST, WORK, absolute]) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Packaging path is a symlink: ' + candidate);
  return absolute;
}
function cleanWork(dir) { fs.rmSync(assertOwnedWork(dir), { recursive: true, force: true }); }
function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5 || new URL(url).protocol !== 'https:') return reject(new Error('Invalid download redirect'));
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(fetchBuffer(new URL(res.headers.location, url).href, redirects + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode} for ${url}`)); }
      let size = 0; const chunks = [];
      res.on('data', c => { size += c.length; if (size > 200 * 1024 * 1024) req.destroy(new Error('Download too large')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Download timed out'))); req.on('error', reject);
  });
}
async function checksums(version) {
  const file = path.join(CACHE, `SHASUMS256-${version}.txt`);
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, await fetchBuffer(`https://nodejs.org/dist/${version}/SHASUMS256.txt`));
  return new Map(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => { const [hash, name] = line.trim().split(/\s+/); return [name, hash]; }));
}
function copy(src, dest) {
  if (!includeInPackage(path.basename(src))) return;
  const info = fs.lstatSync(src);
  if (info.isSymbolicLink()) throw new Error('Refusing to package symlink: ' + src);
  if (info.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src).sort()) copy(path.join(src, name), path.join(dest, name));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest);
    if (/\.(?:sh|command)$/.test(src)) fs.writeFileSync(dest, fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n'));
    if (src === path.join(ROOT, 'README.md')) fs.writeFileSync(dest, packagedReadme(fs.readFileSync(dest, 'utf8')));
  }
}
function macBundle(outDir) {
  const contents = path.join(outDir, 'MundusMaker.app', 'Contents'), resources = path.join(contents, 'Resources');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(contents, 'MacOS', 'MundusMaker'), fs.readFileSync(path.join(ROOT, 'scripts/macos/MundusMaker'), 'utf8').replace(/\r\n/g, '\n'));
  copy(path.join(ROOT, 'scripts/macos/launcher.js'), path.join(resources, 'launcher.js'));
  fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
  const fields = { CFBundleName: 'MundusMaker', CFBundleDisplayName: 'MundusMaker', CFBundleIdentifier: 'org.mundusmaker.desktop', CFBundlePackageType: 'APPL', CFBundleExecutable: 'MundusMaker', CFBundleIconFile: 'MundusMaker.icns', CFBundleShortVersionString: APP_VERSION, CFBundleVersion: APP_VERSION, LSMinimumSystemVersion: '13.5' };
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' + Object.entries(fields).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('\n') + '\n<key>LSUIElement</key><true/>\n<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n');
  const chunks = [['ic08', 'icon-256.png'], ['ic09', 'icon-512.png']].map(([type, name]) => {
    const png = fs.readFileSync(path.join(ROOT, 'public/icons', name)), header = Buffer.alloc(8);
    header.write(type); header.writeUInt32BE(png.length + 8, 4); return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((n, b) => n + b.length, 0), 4);
  fs.writeFileSync(path.join(resources, 'MundusMaker.icns'), Buffer.concat([header, ...chunks]));
  return path.join(resources, 'app');
}
function archiveEntries(dir, prefix = path.basename(dir)) {
  const result = [{ name: prefix + '/', mode: 0o755 }];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!includeInPackage(name)) throw new Error('Contributor/private file reached stage: ' + name);
    const file = path.join(dir, name), relative = prefix + '/' + name, stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Symlink reached archive stage');
    if (stat.isDirectory()) result.push(...archiveEntries(file, relative));
    else result.push({ name: relative, file, mode: /(?:\/runtime\/(?:[a-z]+-(?:x64|arm64)\/)?bin\/node|\/Contents\/MacOS\/MundusMaker|\.sh|\.command)$/.test(relative) ? 0o755 : 0o644 });
  }
  return result;
}
async function stageRuntime(target, nodeVersion, hashes, appDir, runtime) {
  const spec = TARGETS[target], work = assertOwnedWork(path.join(WORK, target));
  const nodeName = `node-${nodeVersion}-${spec.suffix}`, cached = path.join(CACHE, nodeName), expected = hashes.get(nodeName);
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Official checksum missing: ' + nodeName);
  console.log(`${target}: verifying Node ${nodeVersion}`);
  if (!fs.existsSync(cached)) {
    const download = await fetchBuffer(`https://nodejs.org/dist/${nodeVersion}/${nodeName}`);
    if (sha256(download) !== expected) throw new Error('Runtime download checksum mismatch');
    fs.writeFileSync(cached, download);
  }
  if (sha256(fs.readFileSync(cached)) !== expected) throw new Error('Cached runtime checksum mismatch: ' + cached);
  cleanWork(work); fs.mkdirSync(work, { recursive: true });
  const extractedName = nodeName.replace(/\.(?:zip|tar\.gz)$/, '');
  try {
    execFileSync(TAR, ['-xf', cached, '-C', work, `${extractedName}/${spec.bin}`, `${extractedName}/LICENSE`]);
    copy(path.join(work, extractedName, spec.bin), path.join(appDir, runtime));
    const runtimeDir = path.posix.dirname(runtime.replace(/\/bin\/node$/, '/node'));
    copy(path.join(work, extractedName, 'LICENSE'), path.join(appDir, runtimeDir, 'LICENSE.txt'));
    const metadata = { appVersion: APP_VERSION, nodeVersion, target, source: `https://nodejs.org/dist/${nodeVersion}/${nodeName}`, sha256: expected };
    fs.writeFileSync(path.join(appDir, runtimeDir, 'version.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
  } finally { cleanWork(work); }
}
function finishArchive(outDir) {
  const outName = path.basename(outDir);
  const archive = path.join(DIST, `${outName}.zip`), partial = archive + '.partial', entries = archiveEntries(outDir);
  writeZip(partial, entries);
  const listing = execFileSync(TAR, ['-tf', partial], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (listing.length !== entries.length || listing.some(name => !includeInPackage(name.replace(/\/$/, '')))) throw new Error('Archive content validation failed');
  fs.renameSync(partial, archive);
  const hashLine = `${sha256(fs.readFileSync(archive))}  ${path.basename(archive)}\n`;
  fs.writeFileSync(archive + '.sha256', hashLine);
  console.log(`${path.basename(archive)}: ${(fs.statSync(archive).size / 1048576).toFixed(1)} MB, ${entries.length} checked entries`);
  return hashLine;
}
async function build(target, nodeVersion, hashes) {
  const universal = target === 'universal', spec = TARGETS[target];
  const stage = assertOwnedWork(path.join(WORK, `stage-${target}`));
  cleanWork(stage);
  const outName = `MundusMaker-${APP_VERSION}${universal ? '' : '-' + target}`, outDir = path.join(stage, outName);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const macDir = universal || spec.mac ? macBundle(outDir) : null;
    const appDir = !universal && spec.mac ? macDir : outDir;
    for (const dest of new Set([appDir, macDir].filter(Boolean))) for (const file of APP_FILES) copy(path.join(ROOT, file), path.join(dest, file));
    const launchers = universal ? [...WINDOWS_FILES, 'start-mundusmaker.sh', 'Start-MundusMaker.command'] : target.startsWith('windows') ? WINDOWS_FILES : spec.mac ? [] : ['start-mundusmaker.sh'];
    for (const file of launchers) copy(path.join(ROOT, file), path.join(outDir, file));
    for (const [from, to] of Object.entries(GUIDES)) copy(path.join(ROOT, from), path.join(outDir, to));
    const runtimes = [];
    for (const name of universal ? Object.keys(TARGETS) : [target]) {
      const entry = TARGETS[name], dest = entry.mac ? macDir : appDir;
      const runtime = universal && !name.startsWith('windows') ? `runtime/${name}/bin/node` : entry.runtime;
      runtimes.push(await stageRuntime(name, nodeVersion, hashes, dest, runtime));
    }
    if (universal) fs.writeFileSync(path.join(outDir, 'runtime/manifest.json'), JSON.stringify({ appVersion: APP_VERSION, nodeVersion, target, runtimes }, null, 2) + '\n');
    return finishArchive(outDir);
  } finally { cleanWork(stage); }
}
async function main(args = process.argv.slice(2)) {
  let version; const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--node') { version = args[++i]; if (!/^v\d+\.\d+\.\d+$/.test(version || '')) throw new Error('--node requires vX.Y.Z'); }
    else names.push(args[i]);
  }
  const targets = names.includes('all') ? Object.keys(TARGETS) : names.length ? [...new Set(names)] : ['universal'];
  for (const name of targets) if (name !== 'universal' && !TARGETS[name]) throw new Error('Unknown target: ' + name);
  assertOwnedWork(path.join(WORK, targets[0]));
  if (fs.existsSync(CACHE) && fs.lstatSync(CACHE).isSymbolicLink()) throw new Error('Cache must not be a symlink');
  if (!version) {
    const index = JSON.parse((await fetchBuffer('https://nodejs.org/dist/index.json')).toString('utf8'));
    version = index.find(v => v.lts)?.version;
    if (!/^v\d+\.\d+\.\d+$/.test(version || '')) throw new Error('No LTS version found');
  }
  console.log(`MundusMaker ${APP_VERSION}, runtime ${version}`);
  const hashes = await checksums(version), sums = [];
  for (const target of targets) sums.push(await build(target, version, hashes));
  fs.writeFileSync(path.join(DIST, `MundusMaker-${APP_VERSION}-SHA256SUMS.txt`), sums.join(''));
  console.log('Done. The release includes bundled runtimes and a README-FIRST.html startup guide.');
}
if (require.main === module) main().catch(err => { console.error('Packaging failed:', err.message || err.code || String(err)); process.exitCode = 1; });
module.exports = { TARGETS, APP_FILES, GUIDES, includeInPackage, packagedReadme, copy, assertOwnedWork, archiveEntries, macBundle, main };
