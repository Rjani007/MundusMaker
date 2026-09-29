'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
// Git Bash exercises POSIX launch logic on a Windows packaging host; it does
// not substitute for launching the actual Mac/Linux binaries on those systems.
const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
test('Unix runtime selection covers both Mac and Linux CPUs, spaces and legacy layouts', t => {
  if (!fs.existsSync(shell)) return t.skip('A POSIX shell is required for launcher checks');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker launchers '));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker launchers ')); fs.rmSync(tmp, { recursive: true, force: true }); });
  function script(file, text) {
    const dest = path.join(tmp, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text.replace(/\r\n/g, '\n'), { mode: 0o755 }); return dest;
  }
  script('scripts/unix-runtime.sh', fs.readFileSync(path.join(ROOT, 'scripts/unix-runtime.sh'), 'utf8'));
  script('select.sh', '. ./scripts/unix-runtime.sh\nmundusmaker_runtime "./runtime folder" "$1" "$2"\n');
  const targets = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'];
  for (const target of targets) script(`runtime folder/${target}/bin/node`, '#!/bin/sh\nexit 0\n');
  const options = { cwd: tmp, encoding: 'utf8', windowsHide: true };
  for (const [system, cpu, target] of [['Linux', 'x86_64', 'linux-x64'], ['Linux', 'aarch64', 'linux-arm64'], ['Linux', 'arm64', 'linux-arm64'], ['Darwin', 'x86_64', 'macos-x64'], ['Darwin', 'arm64', 'macos-arm64']]) {
    assert.equal(execFileSync(shell, ['select.sh', system, cpu], options).trim(), `./runtime folder/${target}/bin/node`);
  }
  assert.equal(spawnSync(shell, ['select.sh', 'Linux', 'armv7l'], options).status, 1);
  assert.equal(spawnSync(shell, ['select.sh', 'FreeBSD', 'x86_64'], options).status, 1);
  fs.unlinkSync(path.join(tmp, 'runtime folder/linux-x64/bin/node'));
  assert.equal(spawnSync(shell, ['select.sh', 'Linux', 'x86_64'], options).status, 1, 'Never select another CPU or OS');
  script('runtime folder/bin/node', '#!/bin/sh\nexit 0\n');
  assert.equal(execFileSync(shell, ['select.sh', 'Linux', 'x86_64'], options).trim(), './runtime folder/bin/node');
  assert.equal(execFileSync(shell, ['select.sh', 'Darwin', 'arm64'], options).trim(), './runtime folder/macos-arm64/bin/node', 'Specific runtime wins over legacy');
});
test('Linux launcher executes the selected bundled runtime from a folder containing spaces', t => {
  if (!fs.existsSync(shell)) return t.skip('A POSIX shell is required for launcher checks');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker startup '));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker startup ')); fs.rmSync(tmp, { recursive: true, force: true }); });
  function script(file, text) {
    const dest = path.join(tmp, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text.replace(/\r\n/g, '\n'), { mode: 0o755 });
  }
  for (const file of ['start-mundusmaker.sh', 'scripts/unix-runtime.sh']) script(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  script('bin/uname', '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n" ;; -m) printf "%s\\n" "$MM_TEST_CPU" ;; esac\n');
  for (const target of ['linux-x64', 'linux-arm64']) script(`runtime/${target}/bin/node`, `#!/bin/sh\nprintf '${target}:%s\\n' "$1"\nexit 17\n`);
  script('launch.sh', 'PATH="$PWD/bin:$PATH"\nexport PATH\ncd /\nexec sh "$1/start-mundusmaker.sh" --foreground\n');
  for (const [cpu, target] of [['x86_64', 'linux-x64'], ['aarch64', 'linux-arm64']]) {
    const result = spawnSync(shell, ['-c', 'sh launch.sh "$PWD"'], { cwd: tmp, env: { ...process.env, MM_TEST_CPU: cpu }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 17, result.stderr); assert.match(result.stdout, new RegExp(`${target}:server\\.js`));
  }
  for (const file of ['start-mundusmaker.sh', 'Start-MundusMaker.command', 'scripts/macos/MundusMaker']) execFileSync(shell, ['-n', path.join(ROOT, file)], { windowsHide: true });
});
test('Linux launcher starts MundusMaker in the background and reports why it did not start', t => {
  if (!fs.existsSync(shell)) return t.skip('A POSIX shell is required for launcher checks');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker background '));
  t.after(() => { assert.ok(path.basename(tmp).startsWith('mundusmaker background ')); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  function script(file, text) {
    const dest = path.join(tmp, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text.replace(/\r\n/g, '\n'), { mode: 0o755 });
  }
  for (const file of ['start-mundusmaker.sh', 'scripts/unix-runtime.sh']) script(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  script('bin/uname', '#!/bin/sh\ncase "$1" in -s) printf "Linux\n" ;; -m) printf "x86_64\n" ;; esac\n');
  const run = (runtime, args = '') => {
    // a fake runtime stands in for the server: it writes the log lines the real one would
    script('runtime/linux-x64/bin/node', `#!/bin/sh\n[ "$2" = "--log" ] || exit 9\nmkdir -p logs\n${runtime}\n`);
    return spawnSync(shell, ['-c', `PATH="$PWD/bin:$PATH" sh start-mundusmaker.sh ${args}`], { cwd: tmp, encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: tmp, XDG_DATA_HOME: '' } });
  };
  let result = run('echo "2026-01-01T00:00:00Z [mundusmaker] serving on http://localhost:4870" >> logs/mundusmaker.log');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running in the background/);
  result = run('echo "2026-01-01T00:00:00Z [mundusmaker] Port 4870 is being used by another program, so MundusMaker could not start." >> logs/mundusmaker.log\nexit 4');
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout, /did not start\. Port 4870 is being used by another program/);
  assert.doesNotMatch(result.stdout, /serving on/, 'lines from an earlier start do not count');
  result = run('exit 0');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /already running/);
  result = spawnSync(shell, ['-c', 'sh start-mundusmaker.sh --install-desktop'], { cwd: tmp, encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: tmp, XDG_DATA_HOME: '' } });
  assert.equal(result.status, 0, result.stderr);
  const entry = fs.readFileSync(path.join(tmp, '.local/share/applications/mundusmaker.desktop'), 'utf8');
  assert.match(entry, /^Exec=sh ".*start-mundusmaker\.sh"$/m);
  assert.match(entry, /^Terminal=false$/m);
});
