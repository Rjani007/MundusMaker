'use strict';

// The reference implementation of the host's file operations (PROTOCOL.md,
// "File operations"), in Node. devhost.js serves it over HTTP and
// tests/mobile-runtime.test.js calls it directly; the Android host
// (FsHost.java) must behave the same.
//
// The runtime sees POSIX paths under a few mounts (`/app`, `/data`, ...), so
// this works on Windows too. Every path is resolved against a mount; anything
// outside is EACCES, and a write to a read-only mount is EROFS.

const fs = require('fs');
const path = require('path');

const fail = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * mounts: { '/app': { dir, writable: false, only: ['server.js', 'public'] }, '/data': { dir, writable: true }, ... }
 * `only` limits a mount to the named top-level entries (devhost mounts the
 * repo as the app bundle and must not expose data/ or tmp/ through it).
 */
function createFsOps(mounts) {
  const table = Object.entries(mounts).map(([at, m]) => ({ at: at.replace(/\/+$/, ''), dir: path.resolve(m.dir), writable: !!m.writable, only: m.only ? new Set(m.only) : null }))
    .sort((a, b) => b.at.length - a.at.length);

  function locate(p, write) {
    // Runtime paths are POSIX. A backslash or a drive colon would mean
    // something else to the Windows path functions below ("..\" climbs out of
    // a mount the POSIX check thinks it is inside), so they are refused.
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\\') || p.includes('\u0000') || (process.platform === 'win32' && p.includes(':'))) {
      throw fail('EACCES', 'paths must be absolute POSIX paths');
    }
    const norm = path.posix.normalize(p).replace(/\/+$/, '') || '/';
    const mount = table.find((m) => norm === m.at || norm.startsWith(`${m.at}/`));
    if (!mount) throw fail('EACCES', 'outside the app\'s folders');
    const rest = norm.slice(mount.at.length).replace(/^\//, '');
    const real = rest ? path.join(mount.dir, ...rest.split('/')) : mount.dir;
    // and check what the platform made of it, not only what was asked for
    const rel = path.relative(mount.dir, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail('EACCES', 'outside the app\'s folders');
    if (mount.only && rel && !mount.only.has(rel.split(path.sep)[0])) throw fail('EACCES', 'outside the app\'s folders');
    if (write && !mount.writable) throw fail('EROFS', 'read-only file system');
    return { real, mount, root: !rel };
  }

  /** Mutating ops may work inside a root, never on the root folder itself. */
  function inside(p) {
    const at = locate(p, true);
    if (at.root) throw fail('EACCES', 'the app\'s own folders cannot be moved or removed');
    return at;
  }

  const virtual = (real, mount) => {
    // Windows may answer with a \\?\ long-path prefix (mkdirSync recursive does)
    const rel = path.relative(mount.dir, real.replace(/^\\\\\?\\/, ''));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail('EACCES', 'outside the app\'s folders');
    return rel ? `${mount.at}/${rel.split(path.sep).join('/')}` : mount.at;
  };

  const typeOf = (s) => (s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other');

  const ops = {
    stat({ path: p, follow, quiet }) {
      const { real } = locate(p, false);
      let s;
      try { s = follow ? fs.statSync(real) : fs.lstatSync(real); } catch (err) {
        if (quiet && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
        throw err;
      }
      return { type: typeOf(s), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, atimeMs: s.atimeMs, birthtimeMs: s.birthtimeMs, mode: s.mode };
    },
    readdir({ path: p }) {
      const { real, mount } = locate(p, false);
      let items = fs.readdirSync(real, { withFileTypes: true });
      if (mount.only && real === mount.dir) items = items.filter((d) => mount.only.has(d.name));
      const entries = items.map((d) => {
        const entry = { name: d.name, type: d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other' };
        try { const s = fs.lstatSync(path.join(real, d.name)); entry.size = s.size; entry.mtimeMs = s.mtimeMs; } catch { /* removed meanwhile */ }
        return entry;
      });
      // by UTF-8 bytes, as the native hosts sort
      return { entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) };
    },
    read({ path: p }) {
      const { real } = locate(p, false);
      return fs.readFileSync(real);
    },
    // several files in one answer: { sizes } then their bytes back to back;
    // a file that cannot be read is size -1 (the runtime then reads it alone)
    readmany({ paths }) {
      if (!Array.isArray(paths) || paths.length > 4096) throw fail('EINVAL', 'paths must be a list');
      const parts = [];
      const sizes = paths.map((p) => {
        try {
          const bytes = fs.readFileSync(locate(p, false).real);
          parts.push(bytes);
          return bytes.length;
        } catch { return -1; }
      });
      return Buffer.concat([Buffer.from(`${JSON.stringify({ sizes })}\n`), ...parts]);
    },
    write({ path: p, flag, fsync }, data) {
      const { real } = locate(p, true);
      const fd = fs.openSync(real, flag === 'wx' ? 'wx' : flag === 'a' ? 'a' : 'w');
      try {
        let off = 0;
        while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
        if (fsync) fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {};
    },
    mkdir({ path: p, recursive }) {
      const { real, mount } = locate(p, true);
      const first = fs.mkdirSync(real, { recursive: !!recursive });
      return { first: first ? virtual(first, mount) : null };
    },
    rename({ from, to }) {
      const a = inside(from), b = inside(to);
      fs.renameSync(a.real, b.real);
      return {};
    },
    rm({ path: p, recursive, force }) {
      const { real } = inside(p);
      fs.rmSync(real, { recursive: !!recursive, force: !!force });
      return {};
    },
    rmdir({ path: p }) {
      const { real } = inside(p);
      fs.rmdirSync(real);
      return {};
    },
    unlink({ path: p }) {
      const { real } = inside(p);
      fs.unlinkSync(real);
      return {};
    },
    copy({ from, to, excl }) {
      const a = locate(from, false), b = locate(to, true);
      fs.copyFileSync(a.real, b.real, excl ? fs.constants.COPYFILE_EXCL : 0);
      return {};
    },
    // as in Node, a prefix ending in "/" makes a folder inside it; otherwise the
    // random part is appended to the prefix's last name. Either way the new
    // folder must land inside a root, never beside it.
    mkdtemp({ prefix }) {
      if (typeof prefix !== 'string') throw fail('EINVAL', 'prefix must be a string');
      const intoFolder = prefix.endsWith('/');
      const parent = locate(intoFolder ? prefix : path.posix.dirname(prefix), true);
      const real = intoFolder ? parent.real + path.sep : path.join(parent.real, path.posix.basename(prefix));
      if (!intoFolder) inside(prefix);
      return { path: virtual(fs.mkdtempSync(real), parent.mount) };
    },
    realpath({ path: p }) {
      const { real, mount } = locate(p, false);
      return { path: virtual(fs.realpathSync(real), mount) };
    },
  };

  /** One operation; throws Error with a POSIX `code` like the host's 4xx answers. */
  function call(op, args, data) {
    if (!Object.prototype.hasOwnProperty.call(ops, op)) throw fail('EINVAL', `unknown operation ${op}`);
    try {
      return ops[op](args || {}, data || Buffer.alloc(0));
    } catch (err) {
      throw fail(err.code || 'EIO', err.code ? describe(err.code) : err.message);
    }
  }

  return { call, locate };
}

const DESCRIPTIONS = {
  ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty', EACCES: 'permission denied',
  EPERM: 'operation not permitted', EROFS: 'read-only file system', EXDEV: 'cross-device link not permitted',
  EBUSY: 'resource busy or locked', EINVAL: 'invalid argument', EIO: 'i/o error', ENOSPC: 'no space left on device',
};
const describe = (code) => DESCRIPTIONS[code] || code.toLowerCase();

module.exports = { createFsOps };
