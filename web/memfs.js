/*
 * The file host for MundusMaker on the website (docs/website.md).
 *
 * server.js runs in the browser on the phone runtime
 * (mobile/shared/runtime/node.js), which asks a host for every file
 * operation (mobile/shared/PROTOCOL.md, "File operations"). A web page has no
 * file system it can use synchronously, so this host keeps the app's folders
 * in memory. store.js keeps them in IndexedDB as well: they are loaded before
 * server.js starts, and the engine writes every change back before the page
 * hears that a request succeeded. Big and rarely read files stay on disk as
 * Blobs and are read with FileReaderSync when asked for.
 *
 * It answers like the reference host (mobile/shared/fsops.js): the same
 * operations, results and POSIX error codes, which tests/web-memfs.test.js
 * checks side by side. Plain JavaScript with no imports, so the engine
 * worker loads it with importScripts and the tests with require.
 */
(function (root) {
  'use strict';

  const EMPTY = new Uint8Array(0);
  const encoder = new TextEncoder();
  const DESCRIPTIONS = {
    ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty', EACCES: 'permission denied',
    EPERM: 'operation not permitted', EROFS: 'read-only file system', EXDEV: 'cross-device link not permitted',
    EBUSY: 'resource busy or locked', EINVAL: 'invalid argument', EIO: 'i/o error', ENOSPC: 'no space left on device',
  };
  const fail = (code) => Object.assign(new Error(DESCRIPTIONS[code] || code.toLowerCase()), { code });
  const FILE_MODE = 0o100644;
  const DIR_MODE = 0o40755;

  /** An absolute POSIX path with `.`, `..` and repeated slashes resolved, as fsops.locate does. */
  function normalize(p) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\\') || p.includes('\u0000')) throw fail('EACCES');
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return `/${out.join('/')}`;
  }

  const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);

  // the native hosts sort a listing by the names' UTF-8 bytes
  function byUtf8Name(a, b) {
    const x = encoder.encode(a.name), y = encoder.encode(b.name);
    for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  }

  function toBytes(data) {
    if (data == null) return EMPTY;
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw fail('EINVAL');
  }

  /**
   * options:
   *   writable   folders the app may change, e.g. ['/data', '/config', '/tmp']
   *   persisted  the ones whose changes are kept, e.g. ['/data', '/config']
   *   readonly   { '/app': bundle }, a bundle answering stat(rel), list(rel)
   *              and read(rel) for the app's own files
   *   readBlob   (blob) -> Uint8Array, for files kept on disk
   *   onChange   (path) called for every changed path in a persisted folder
   *   now, random
   */
  function createMemFs(options = {}) {
    const writable = (options.writable || ['/data', '/config', '/tmp']).map(normalize);
    const persisted = (options.persisted || ['/data', '/config']).map(normalize);
    const mounts = Object.entries(options.readonly || {}).map(([at, bundle]) => ({ at: normalize(at), bundle }));
    const readBlob = options.readBlob || (() => { throw fail('EIO'); });
    const now = options.now || (() => Date.now());
    const random = options.random || Math.random;

    const nodes = new Map(); // path -> { type, size, mtimeMs, ctimeMs, atimeMs, birthtimeMs, mode, data, blob, ver }
    const kids = new Map(); // folder path -> Set of names
    const changes = new Map(); // persisted paths changed since takeChanges()
    let onChange = options.onChange || null;

    const isPersisted = (p) => persisted.some((r) => under(p, r));
    function touch(p) {
      if (!isPersisted(p)) return;
      changes.set(p, true);
      if (onChange) onChange(p);
    }

    function dirNode(t) { return { type: 'dir', size: 0, mtimeMs: t, ctimeMs: t, atimeMs: t, birthtimeMs: t, mode: DIR_MODE, data: null, blob: null, ver: 0 }; }
    function fileNode(data, t) { return { type: 'file', size: data.length, mtimeMs: t, ctimeMs: t, atimeMs: t, birthtimeMs: t, mode: FILE_MODE, data, blob: null, ver: 1 }; }
    for (const r of writable) { nodes.set(r, dirNode(now())); kids.set(r, new Set()); }

    function locate(p, write) {
      const norm = normalize(p);
      const rootDir = writable.find((r) => under(norm, r));
      if (rootDir) return { path: norm, root: rootDir, isRoot: norm === rootDir };
      const mount = mounts.find((m) => under(norm, m.at));
      if (!mount) throw fail('EACCES');
      if (write) throw fail('EROFS');
      return { path: norm, root: mount.at, bundle: mount.bundle, rel: norm.slice(mount.at.length + 1), isRoot: norm === mount.at };
    }

    /** Mutating ops may work inside a root, never on the root folder itself. */
    function inside(p) {
      const at = locate(p, true);
      if (at.isRoot) throw fail('EACCES');
      return at;
    }

    // POSIX: a file where a folder was expected is ENOTDIR, a missing one ENOENT
    function brokenChain(p, rootDir) {
      for (let a = parentOf(p); under(a, rootDir); a = parentOf(a)) {
        const n = nodes.get(a);
        if (n) return n.type === 'dir' ? fail('ENOENT') : fail('ENOTDIR');
        if (a === rootDir) break;
      }
      return fail('ENOENT');
    }
    function existing(at) {
      const node = nodes.get(at.path);
      if (!node) throw brokenChain(at.path, at.root);
      return node;
    }
    function parentFolder(at) {
      const parent = parentOf(at.path);
      const node = nodes.get(parent);
      if (!node) throw brokenChain(parent, at.root);
      if (node.type !== 'dir') throw fail('ENOTDIR');
      return node;
    }

    function folderChanged(dir, t) {
      const node = nodes.get(dir);
      if (!node) return;
      node.mtimeMs = t; node.ctimeMs = t;
      touch(dir);
    }
    function link(p, node) {
      nodes.set(p, node);
      if (node.type === 'dir' && !kids.has(p)) kids.set(p, new Set());
      const parent = parentOf(p);
      kids.get(parent).add(p.slice(parent.length + 1));
      touch(p);
    }
    function unlinkOne(p) {
      nodes.delete(p);
      kids.delete(p);
      const parent = parentOf(p);
      const set = kids.get(parent);
      if (set) set.delete(p.slice(parent.length + 1));
      touch(p);
    }
    /** Every path in a subtree, the folder first. */
    function subtree(p) {
      const out = [p];
      for (let i = 0; i < out.length; i++) {
        const set = kids.get(out[i]);
        if (set) for (const name of set) out.push(`${out[i]}/${name}`);
      }
      return out;
    }

    function contentOf(node) {
      if (node.data) return node.data;
      if (node.blob) return toBytes(readBlob(node.blob));
      return EMPTY;
    }

    function statOf(n) {
      return { type: n.type, size: n.size, mtimeMs: n.mtimeMs, ctimeMs: n.ctimeMs, atimeMs: n.atimeMs, birthtimeMs: n.birthtimeMs, mode: n.mode };
    }

    function bundleStat(at) {
      const s = at.isRoot ? { type: 'dir', size: 0, mtimeMs: 0 } : at.bundle.stat(at.rel);
      if (!s) throw fail('ENOENT');
      const t = s.mtimeMs || 0;
      return { type: s.type, size: s.size || 0, mtimeMs: t, ctimeMs: t, atimeMs: t, birthtimeMs: t, mode: s.type === 'dir' ? 0o40555 : 0o100444 };
    }

    function readAt(at) {
      if (at.bundle) {
        const s = bundleStat(at);
        if (s.type === 'dir') throw fail('EISDIR');
        return toBytes(at.bundle.read(at.rel));
      }
      const node = existing(at);
      if (node.type === 'dir') throw fail('EISDIR');
      return contentOf(node);
    }

    const ops = {
      stat({ path: p, quiet }) {
        const at = locate(p, false);
        try {
          return at.bundle ? bundleStat(at) : statOf(existing(at));
        } catch (err) {
          if (quiet && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
          throw err;
        }
      },
      readdir({ path: p }) {
        const at = locate(p, false);
        let entries;
        if (at.bundle) {
          if (bundleStat(at).type !== 'dir') throw fail('ENOTDIR');
          entries = at.bundle.list(at.rel).map((e) => ({ name: e.name, type: e.type, size: e.size || 0, mtimeMs: e.mtimeMs || 0 }));
        } else {
          const node = existing(at);
          if (node.type !== 'dir') throw fail('ENOTDIR');
          entries = [...kids.get(at.path)].map((name) => {
            const n = nodes.get(`${at.path}/${name}`);
            return { name, type: n.type, size: n.size, mtimeMs: n.mtimeMs };
          });
        }
        return { entries: entries.sort(byUtf8Name) };
      },
      // a copy: what the runtime hands server.js may be changed in place
      read({ path: p }) { return new Uint8Array(readAt(locate(p, false))); },
      readmany({ paths }) {
        if (!Array.isArray(paths) || paths.length > 4096) throw fail('EINVAL');
        const parts = [];
        const sizes = paths.map((p) => {
          try {
            const bytes = readAt(locate(p, false));
            parts.push(bytes);
            return bytes.length;
          } catch { return -1; }
        });
        const head = encoder.encode(`${JSON.stringify({ sizes })}\n`);
        const out = new Uint8Array(parts.reduce((n, b) => n + b.length, head.length));
        out.set(head);
        let at = head.length;
        for (const b of parts) { out.set(b, at); at += b.length; }
        return out;
      },
      write({ path: p, flag }, data) {
        const at = locate(p, true);
        const old = nodes.get(at.path);
        if (old && old.type === 'dir') throw fail('EISDIR');
        if (old && flag === 'wx') throw fail('EEXIST');
        if (!old) parentFolder(at);
        const bytes = toBytes(data);
        let content;
        if (flag === 'a' && old) {
          const before = contentOf(old);
          content = new Uint8Array(before.length + bytes.length);
          content.set(before);
          content.set(bytes, before.length);
        } else {
          content = new Uint8Array(bytes); // a copy: never keep the caller's buffer, which may change later
        }
        const t = now();
        if (old) {
          old.data = content; old.blob = null; old.size = content.length;
          old.mtimeMs = t; old.ctimeMs = t; old.ver++;
          touch(at.path);
        } else {
          link(at.path, fileNode(content, t));
          folderChanged(parentOf(at.path), t);
        }
        return {};
      },
      mkdir({ path: p, recursive }) {
        const at = locate(p, true);
        const old = nodes.get(at.path);
        if (!recursive) {
          if (old) throw fail('EEXIST');
          parentFolder(at);
          const t = now();
          link(at.path, dirNode(t));
          folderChanged(parentOf(at.path), t);
          return { first: null };
        }
        if (old) {
          if (old.type !== 'dir') throw fail('EEXIST');
          return { first: null };
        }
        let first = null;
        let cur = at.root;
        for (const part of at.path.slice(at.root.length + 1).split('/')) {
          cur = `${cur}/${part}`;
          const n = nodes.get(cur);
          if (n) {
            if (n.type !== 'dir') throw fail('ENOTDIR');
            continue;
          }
          const t = now();
          link(cur, dirNode(t));
          folderChanged(parentOf(cur), t);
          if (!first) first = cur;
        }
        return { first };
      },
      rename({ from, to }) {
        const a = inside(from), b = inside(to);
        const src = existing(a);
        if (a.path === b.path) return {};
        parentFolder(b);
        const dest = nodes.get(b.path);
        if (src.type === 'dir') {
          if (b.path.startsWith(`${a.path}/`)) throw fail('EINVAL');
          if (dest && dest.type !== 'dir') throw fail('ENOTDIR');
          if (dest && kids.get(b.path).size) throw fail('ENOTEMPTY');
        } else if (dest && dest.type === 'dir') {
          throw fail('EISDIR');
        }
        if (dest) unlinkOne(b.path);
        const moved = subtree(a.path).map((p) => [p, nodes.get(p)]);
        for (const [p] of moved.slice().reverse()) unlinkOne(p);
        for (const [p, node] of moved) link(b.path + p.slice(a.path.length), node);
        const t = now();
        folderChanged(parentOf(a.path), t);
        folderChanged(parentOf(b.path), t);
        return {};
      },
      rm({ path: p, recursive, force }) {
        const at = inside(p);
        let node;
        try { node = existing(at); } catch (err) {
          if (force && err.code === 'ENOENT') return {};
          throw err;
        }
        if (node.type === 'dir' && !recursive) throw Object.assign(new Error('err_fs_eisdir'), { code: 'ERR_FS_EISDIR' });
        for (const q of subtree(at.path).reverse()) unlinkOne(q);
        folderChanged(parentOf(at.path), now());
        return {};
      },
      rmdir({ path: p }) {
        const at = inside(p);
        const node = existing(at);
        if (node.type !== 'dir') throw fail('ENOTDIR');
        if (kids.get(at.path).size) throw fail('ENOTEMPTY');
        unlinkOne(at.path);
        folderChanged(parentOf(at.path), now());
        return {};
      },
      unlink({ path: p }) {
        const at = inside(p);
        if (existing(at).type === 'dir') throw fail('EISDIR');
        unlinkOne(at.path);
        folderChanged(parentOf(at.path), now());
        return {};
      },
      copy({ from, to, excl }) {
        const a = locate(from, false), b = locate(to, true);
        if (b.isRoot) throw fail('EISDIR');
        // a file's bytes never change in place (write replaces them), so a copy can share them
        const srcNode = a.bundle ? null : existing(a);
        if (srcNode && srcNode.type === 'dir') throw fail('EISDIR');
        const bytes = srcNode ? srcNode.data : readAt(a);
        const blob = srcNode ? srcNode.blob : null;
        const dest = nodes.get(b.path);
        if (dest && dest.type === 'dir') throw fail('EISDIR');
        if (dest && excl) throw fail('EEXIST');
        if (!dest) parentFolder(b);
        const t = now();
        const size = srcNode ? srcNode.size : bytes.length;
        if (dest) {
          Object.assign(dest, { data: bytes, blob, size, mtimeMs: t, ctimeMs: t });
          dest.ver++;
          touch(b.path);
        } else {
          const node = fileNode(bytes || EMPTY, t);
          Object.assign(node, { data: bytes, blob, size });
          link(b.path, node);
          folderChanged(parentOf(b.path), t);
        }
        return {};
      },
      // as in Node, a prefix ending in "/" makes a folder inside it; otherwise the
      // random part extends the prefix's last name
      mkdtemp({ prefix }) {
        if (typeof prefix !== 'string') throw fail('EINVAL');
        const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        if (!prefix.endsWith('/')) inside(prefix);
        for (let attempt = 0; attempt < 100; attempt++) {
          let name = prefix;
          for (let i = 0; i < 6; i++) name += letters[Math.floor(random() * letters.length)];
          const at = inside(name);
          if (nodes.has(at.path)) continue;
          parentFolder(at);
          const t = now();
          link(at.path, dirNode(t));
          folderChanged(parentOf(at.path), t);
          return { path: at.path };
        }
        throw fail('EEXIST');
      },
      realpath({ path: p }) {
        const at = locate(p, false);
        if (at.bundle) bundleStat(at); else existing(at);
        return { path: at.path };
      },
    };

    /** One operation, as host.fs(op, args, data); throws an Error with a POSIX `code`. */
    function call(op, args, data) {
      if (!Object.prototype.hasOwnProperty.call(ops, op)) throw fail('EINVAL');
      return ops[op](args || {}, data);
    }

    /**
     * Fill the folders from saved records: { path, type, size, mtimeMs,
     * ctimeMs, atimeMs, birthtimeMs, mode, bytes?, blob? }. Folders a record
     * needs but the store lacks are made (and reported as changes).
     */
    function load(records) {
      const sorted = records.filter((r) => r && typeof r.path === 'string')
        .map((r) => ({ ...r, path: normalize(r.path) }))
        .filter((r) => persisted.some((p) => under(r.path, p)))
        .sort((x, y) => x.path.length - y.path.length);
      for (const r of sorted) {
        const rootDir = writable.find((w) => under(r.path, w));
        if (!rootDir) continue;
        if (r.path === rootDir) {
          if (r.type === 'dir') Object.assign(nodes.get(rootDir), { mtimeMs: r.mtimeMs, ctimeMs: r.ctimeMs, birthtimeMs: r.birthtimeMs });
          continue;
        }
        // make missing parent folders first (a store damaged by hand, or an old one)
        let cur = rootDir;
        let broken = false;
        for (const part of r.path.slice(rootDir.length + 1).split('/').slice(0, -1)) {
          cur = `${cur}/${part}`;
          const n = nodes.get(cur);
          if (n && n.type !== 'dir') { broken = true; break; }
          if (!n) link(cur, dirNode(r.mtimeMs || now()));
        }
        if (broken || nodes.has(r.path)) continue;
        const t = r.mtimeMs || now();
        const node = r.type === 'dir' ? dirNode(t) : fileNode(r.bytes ? toBytes(r.bytes) : EMPTY, t);
        Object.assign(node, {
          size: r.type === 'dir' ? 0 : Number(r.size) || (r.bytes ? r.bytes.byteLength : 0),
          ctimeMs: r.ctimeMs || t, atimeMs: r.atimeMs || t, birthtimeMs: r.birthtimeMs || t,
        });
        if (r.type !== 'dir' && !r.bytes) { node.data = null; node.blob = r.blob || null; }
        nodes.set(r.path, node);
        if (node.type === 'dir') kids.set(r.path, kids.get(r.path) || new Set());
        const parent = parentOf(r.path);
        kids.get(parent).add(r.path.slice(parent.length + 1));
      }
    }

    /** What changed since the last call, for the store: { path, node } or { path, node: null } when removed. */
    function takeChanges() {
      const out = [];
      for (const p of changes.keys()) out.push({ path: p, node: nodes.get(p) || null });
      changes.clear();
      return out;
    }

    return {
      call,
      load,
      takeChanges,
      hasChanges: () => changes.size > 0,
      /** Report paths again, after the store failed to keep them. */
      markChanged(paths) { for (const p of paths) if (isPersisted(p)) changes.set(p, true); },
      /** The store kept a file's bytes on disk: forget them here unless the file changed since. */
      adoptBlob(p, ver, blob) {
        const node = nodes.get(p);
        if (node && node.type === 'file' && node.ver === ver && blob) { node.blob = blob; node.data = null; }
      },
      /** A file or folder in a writable folder, or null. Callers must not change it. */
      node: (p) => nodes.get(normalize(p)) || null,
      /** A file's bytes. Callers must not change them. */
      bytes(p) {
        const node = nodes.get(normalize(p));
        if (!node || node.type !== 'file') throw fail('ENOENT');
        return contentOf(node);
      },
      /** Every file under a folder, as [path, node]. */
      files(dir) {
        const start = normalize(dir);
        if (!nodes.has(start)) return [];
        return subtree(start).map((p) => [p, nodes.get(p)]).filter(([, n]) => n.type === 'file');
      },
      set onChange(fn) { onChange = fn; },
    };
  }

  const api = { createMemFs, normalize };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MundusMemFs = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
