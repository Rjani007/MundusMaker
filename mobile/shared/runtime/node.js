/*
 * The Node compatibility layer the phone apps run server.js on.
 *
 * server.js is plain CommonJS with synchronous fs calls and one http server.
 * This file supplies exactly the Node it uses (Buffer, fs, path, crypto,
 * http, events, util, os, url, child_process, process and timers with
 * unref), backed by a native host (see ../PROTOCOL.md):
 *
 *   host.fs(op, args, data)      synchronous file operation -> JSON result,
 *                                or the bytes for 'read'; throws { code }
 *   host.fetch(meta, body)       outbound request -> Promise<{ meta, body }>
 *   host.respond(id, meta, body) the answer to a relayed page request
 *   host.exit(code)              process.exit
 *
 * It runs in a browser Web Worker (worker.js) and, for the tests, in a Node
 * vm context (tests/mobile-runtime.test.js), so it uses nothing but the web
 * platform. Anything server.js does not use is deliberately left out: a
 * require() of a module that is not here fails loudly, as it would in Node.
 */
(function (root) {
  'use strict';

  const utf8Encoder = new TextEncoder();
  const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true }); // Node keeps a BOM
  const EMPTY = new Uint8Array(0);

  // ---------- SHA-256 (crypto.createHash) ----------

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(bytes) {
    const len = bytes.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    view.setUint32(padded.length - 4, (len << 3) >>> 0);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => outView.setUint32(i * 4, v));
    return out;
  }

  // ---------- Buffer ----------

  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

  function normEncoding(enc) {
    const e = String(enc || 'utf8').toLowerCase();
    if (e === 'utf8' || e === 'utf-8') return 'utf8';
    if (e === 'latin1' || e === 'binary') return 'latin1';
    if (e === 'ucs2' || e === 'ucs-2' || e === 'utf16le' || e === 'utf-16le') return 'utf16le';
    if (['ascii', 'base64', 'base64url', 'hex'].includes(e)) return e;
    throw new TypeError(`Unknown encoding: ${enc}`);
  }

  function latin1String(bytes, mask) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      const chunk = bytes.subarray(i, i + 8192);
      out += String.fromCharCode.apply(null, mask ? Array.from(chunk, (b) => b & 0x7f) : chunk);
    }
    return out;
  }

  function latin1Bytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function base64Bytes(str) {
    // Node is lenient: url-safe letters, whitespace and missing padding all decode
    let clean = String(str).replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')).replace(/[^A-Za-z0-9+/]/g, '');
    if (clean.length % 4 === 1) clean = clean.slice(0, -1);
    while (clean.length % 4) clean += '=';
    return latin1Bytes(atob(clean));
  }

  function bytesFromString(str, enc) {
    switch (normEncoding(enc)) {
      case 'utf8': return utf8Encoder.encode(str);
      case 'latin1': case 'ascii': return latin1Bytes(str);
      case 'base64': case 'base64url': return base64Bytes(str);
      case 'hex': {
        const n = Math.floor(str.length / 2);
        const out = new Uint8Array(n);
        let i = 0;
        for (; i < n; i++) {
          const v = parseInt(str.substr(i * 2, 2), 16);
          if (Number.isNaN(v)) break;
          out[i] = v;
        }
        return out.subarray(0, i);
      }
      case 'utf16le': {
        const out = new Uint8Array(str.length * 2);
        for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; }
        return out;
      }
    }
    return EMPTY;
  }

  class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') return Buffer.view(bytesFromString(value, encodingOrOffset));
      if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
        const offset = Number(encodingOrOffset) || 0;
        return new Buffer(value, offset, length === undefined ? value.byteLength - offset : length);
      }
      if (ArrayBuffer.isView(value)) {
        const copy = new Buffer(value.byteLength);
        copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        return copy;
      }
      if (Array.isArray(value)) return Buffer.view(Uint8Array.from(value, (v) => v & 0xff));
      if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
      if (value && typeof value.valueOf === 'function' && value.valueOf() !== value) return Buffer.from(value.valueOf(), encodingOrOffset, length);
      throw new TypeError('The first argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.');
    }

    /** A Buffer sharing the bytes of a Uint8Array, without copying. */
    static view(u8) {
      return u8 instanceof Buffer ? u8 : new Buffer(u8.buffer, u8.byteOffset, u8.byteLength);
    }

    static alloc(size, fill, encoding) {
      const b = new Buffer(size);
      if (fill !== undefined && fill !== 0) b.fill(typeof fill === 'string' ? bytesFromString(fill, encoding)[0] : fill);
      return b;
    }

    static allocUnsafe(size) { return new Buffer(size); }

    static isBuffer(value) { return value instanceof Buffer; }

    static isEncoding(enc) { try { normEncoding(enc); return true; } catch { return false; } }

    static byteLength(value, enc) {
      if (typeof value !== 'string') return value.byteLength;
      return normEncoding(enc) === 'utf8' ? utf8Encoder.encode(value).length : bytesFromString(value, enc).length;
    }

    static concat(list, totalLength) {
      const total = totalLength === undefined ? list.reduce((n, b) => n + b.length, 0) : totalLength;
      const out = new Buffer(total);
      let offset = 0;
      for (const item of list) {
        if (offset >= total) break;
        const bytes = item.length + offset > total ? item.subarray(0, total - offset) : item;
        out.set(bytes, offset);
        offset += bytes.length;
      }
      return out;
    }

    static compare(a, b) { return Buffer.view(a).compare(b); }

    toString(encoding, start, end) {
      const s = start === undefined ? 0 : Math.max(0, start | 0);
      const e = end === undefined ? this.length : Math.min(this.length, end | 0);
      const bytes = s === 0 && e === this.length ? this : this.subarray(s, e);
      switch (normEncoding(encoding)) {
        case 'utf8': return utf8Decoder.decode(bytes);
        case 'latin1': return latin1String(bytes, false);
        case 'ascii': return latin1String(bytes, true);
        case 'base64': return btoa(latin1String(bytes, false));
        case 'base64url': return btoa(latin1String(bytes, false)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        case 'hex': { let out = ''; for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]]; return out; }
        case 'utf16le': return new TextDecoder('utf-16le').decode(bytes);
      }
      return '';
    }

    toLocaleString(encoding, start, end) { return this.toString(encoding, start, end); }

    // Node's slice shares memory, unlike Uint8Array's
    slice(start, end) { return this.subarray(start, end); }

    equals(other) {
      if (!ArrayBuffer.isView(other)) throw new TypeError('The "otherBuffer" argument must be a Buffer or Uint8Array');
      if (other.byteLength !== this.length) return false;
      const o = new Uint8Array(other.buffer, other.byteOffset, other.byteLength);
      for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false;
      return true;
    }

    compare(other) {
      const o = new Uint8Array(other.buffer, other.byteOffset, other.byteLength);
      const n = Math.min(this.length, o.length);
      for (let i = 0; i < n; i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1;
      return this.length === o.length ? 0 : this.length < o.length ? -1 : 1;
    }

    indexOf(value, byteOffset = 0, encoding) {
      if (typeof value === 'number') return super.indexOf(value & 0xff, byteOffset);
      const needle = typeof value === 'string' ? bytesFromString(value, encoding) : value;
      if (!needle.length) return Math.min(byteOffset, this.length);
      outer: for (let i = Math.max(0, byteOffset); i <= this.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
        return i;
      }
      return -1;
    }

    includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }

    write(string, offset = 0, length, encoding) {
      if (typeof offset === 'string') { encoding = offset; offset = 0; length = undefined; }
      else if (typeof length === 'string') { encoding = length; length = undefined; }
      const bytes = bytesFromString(String(string), encoding);
      const n = Math.min(bytes.length, this.length - offset, length === undefined ? Infinity : length);
      this.set(bytes.subarray(0, n), offset);
      return n;
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      const bytes = this.subarray(sourceStart, sourceEnd).subarray(0, Math.max(0, target.length - targetStart));
      target.set(bytes, targetStart);
      return bytes.length;
    }

    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  }

  /** Bytes of anything Node would accept as data, without copying views. */
  function toBytes(data, encoding) {
    if (typeof data === 'string') return bytesFromString(data, encoding);
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data == null) return EMPTY;
    return utf8Encoder.encode(String(data));
  }

  // ---------- events ----------

  class EventEmitter {
    constructor() { this._events = Object.create(null); }
    _list(name) { if (!this._events) this._events = Object.create(null); return this._events[name] || (this._events[name] = []); }
    on(name, fn) { this._list(name).push(fn); if (this._onListener) this._onListener(name); return this; }
    addListener(name, fn) { return this.on(name, fn); }
    prependListener(name, fn) { this._list(name).unshift(fn); if (this._onListener) this._onListener(name); return this; }
    once(name, fn) {
      const wrapped = (...args) => { this.off(name, wrapped); fn.apply(this, args); };
      wrapped.listener = fn;
      return this.on(name, wrapped);
    }
    off(name, fn) {
      const list = this._events && this._events[name];
      if (list) {
        const i = list.findIndex((l) => l === fn || l.listener === fn);
        if (i !== -1) list.splice(i, 1);
      }
      return this;
    }
    removeListener(name, fn) { return this.off(name, fn); }
    removeAllListeners(name) { if (name === undefined) this._events = Object.create(null); else if (this._events) delete this._events[name]; return this; }
    emit(name, ...args) {
      const list = this._events && this._events[name];
      if (!list || !list.length) {
        if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error: ${args[0]}`);
        return false;
      }
      for (const fn of [...list]) fn.apply(this, args);
      return true;
    }
    listeners(name) { return [...((this._events && this._events[name]) || [])].map((l) => l.listener || l); }
    listenerCount(name) { return ((this._events && this._events[name]) || []).length; }
    eventNames() { return Object.keys(this._events || {}); }
    setMaxListeners() { return this; }
    getMaxListeners() { return 10; }
  }
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.defaultMaxListeners = 10;

  // ---------- path (POSIX) ----------

  function makePath(cwd) {
    const str = (p) => {
      if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
      return p;
    };
    const normalizeParts = (parts, allowAboveRoot) => {
      const out = [];
      for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
          if (out.length && out[out.length - 1] !== '..') out.pop();
          else if (allowAboveRoot) out.push('..');
        } else out.push(part);
      }
      return out;
    };
    const posix = {
      sep: '/',
      delimiter: ':',
      isAbsolute: (p) => str(p).startsWith('/'),
      normalize(p) {
        str(p);
        if (!p) return '.';
        const abs = p.startsWith('/');
        let s = normalizeParts(p.split('/'), !abs).join('/');
        if (!s && !abs) s = '.';
        if (s && p.endsWith('/')) s += '/';
        return (abs ? '/' : '') + s;
      },
      join(...parts) {
        const kept = parts.filter((p) => str(p) !== '');
        return kept.length ? posix.normalize(kept.join('/')) : '.';
      },
      resolve(...parts) {
        let resolved = '', abs = false;
        for (let i = parts.length - 1; i >= -1 && !abs; i--) {
          const p = i >= 0 ? str(parts[i]) : cwd();
          if (!p) continue;
          resolved = `${p}/${resolved}`;
          abs = p.startsWith('/');
        }
        const s = normalizeParts(resolved.split('/'), !abs).join('/');
        return ((abs ? '/' : '') + s) || '.';
      },
      dirname(p) {
        // Node's own scan, quirks included: cut at the last slash that follows a non-slash
        str(p);
        if (!p) return '.';
        const hasRoot = p[0] === '/';
        let end = -1, matchedSlash = true;
        for (let i = p.length - 1; i >= 1; i--) {
          if (p[i] === '/') { if (!matchedSlash) { end = i; break; } } else matchedSlash = false;
        }
        if (end === -1) return hasRoot ? '/' : '.';
        if (hasRoot && end === 1) return '//';
        return p.slice(0, end);
      },
      basename(p, ext) {
        str(p);
        if (ext && ext === p) return ''; // Node's quirk
        let end = p.length;
        while (end > 0 && p[end - 1] === '/') end--;
        if (!end) return '';
        let base = p.slice(p.lastIndexOf('/', end - 1) + 1, end);
        if (ext && base !== ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
        return base;
      },
      extname(p) {
        const base = posix.basename(p);
        const i = base.lastIndexOf('.');
        return i <= 0 || base === '..' ? '' : base.slice(i);
      },
      relative(from, to) {
        const f = posix.resolve(from).split('/').filter(Boolean);
        const t = posix.resolve(to).split('/').filter(Boolean);
        let i = 0;
        while (i < f.length && i < t.length && f[i] === t[i]) i++;
        return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
      },
      parse(p) {
        str(p);
        const base = posix.basename(p);
        const ext = posix.extname(p);
        const dir = p.includes('/') ? posix.dirname(p) : '';
        return { root: p.startsWith('/') ? '/' : '', dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
      },
      format(o) {
        const dir = o.dir || o.root || '';
        const base = o.base || `${o.name || ''}${o.ext || ''}`;
        return !dir ? base : dir === o.root ? dir + base : `${dir}/${base}`;
      },
      toNamespacedPath: (p) => p,
    };
    posix.posix = posix;
    posix.win32 = posix; // nothing here runs on Windows paths
    return posix;
  }

  // ---------- util ----------

  function inspect(value) {
    if (typeof value === 'string') return `'${value}'`;
    if (value instanceof Error) return value.stack || String(value);
    if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
    if (value === null || typeof value !== 'object') return String(value);
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (k, v) => {
        if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); }
        if (typeof v === 'bigint') return `${v}n`;
        return v;
      });
    } catch { return Object.prototype.toString.call(value); }
  }

  function format(fmt, ...args) {
    if (typeof fmt !== 'string') return [fmt, ...args].map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
    let i = 0;
    let out = fmt.replace(/%[sdifjoOc%]/g, (m) => {
      if (m === '%%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case '%s': return typeof a === 'string' ? a : typeof a === 'object' && a !== null ? inspect(a) : String(a);
        case '%d': return typeof a === 'object' && a !== null ? 'NaN' : String(Number(a));
        case '%i': return String(parseInt(a, 10));
        case '%f': return String(parseFloat(a));
        case '%j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
        case '%c': return '';
        default: return inspect(a);
      }
    });
    for (; i < args.length; i++) out += ` ${typeof args[i] === 'string' ? args[i] : inspect(args[i])}`;
    return out;
  }

  const util = {
    format,
    inspect,
    promisify(fn) {
      return (...args) => new Promise((resolve, reject) => fn(...args, (err, value) => (err ? reject(err) : resolve(value))));
    },
    deprecate: (fn) => fn,
    inherits(ctor, superCtor) { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); Object.setPrototypeOf(ctor, superCtor); },
    isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    types: { isUint8Array: (v) => v instanceof Uint8Array, isPromise: (v) => v instanceof Promise },
    TextEncoder,
    TextDecoder,
  };

  // ---------- the runtime ----------

  const ERRNO = {
    EPERM: -1, ENOENT: -2, EIO: -5, EBADF: -9, EACCES: -13, EEXIST: -17, EXDEV: -18, ENOTDIR: -20,
    EISDIR: -21, EINVAL: -22, EMFILE: -24, ENOSPC: -28, EROFS: -30, ENAMETOOLONG: -36, ENOTEMPTY: -39, ELOOP: -40,
  };
  const DESCRIPTIONS = {
    EPERM: 'operation not permitted', ENOENT: 'no such file or directory', EIO: 'i/o error', EBADF: 'bad file descriptor',
    EACCES: 'permission denied', EEXIST: 'file already exists', EXDEV: 'cross-device link not permitted', ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory', EINVAL: 'invalid argument', ENOSPC: 'no space left on device',
    EROFS: 'read-only file system', ENOTEMPTY: 'directory not empty', ELOOP: 'too many symbolic links encountered',
  };

  function create(options) {
    const {
      host, appRoot, argv = [], env = {}, platform = 'android', pid = 1, tmpDir = '/tmp',
      homeDir = appRoot, version = 'v22.0.0', arch = '',
    } = options;
    if (!host || typeof host.fs !== 'function') throw new TypeError('create() needs a host with fs()');
    const runtime = { exited: false, server: null, onListen: null };
    const native = {
      setTimeout: root.setTimeout.bind(root), clearTimeout: root.clearTimeout.bind(root),
      setInterval: root.setInterval.bind(root), clearInterval: root.clearInterval.bind(root),
    };
    const now = () => (root.performance ? root.performance.now() : Date.now());
    const started = now();
    const path = makePath(() => appRoot);

    // ----- timers: Node's handles have ref/unref, the browser's are numbers -----
    class Timeout {
      constructor(fn, ms, args, repeat) {
        this._fn = fn; this._ms = ms; this._args = args; this._repeat = repeat; this._ref = true;
        this._start();
      }
      _start() {
        this._id = (this._repeat ? native.setInterval : native.setTimeout)(this._fn, this._ms, ...this._args);
        if (!this._ref && this._id && typeof this._id.unref === 'function') this._id.unref();
      }
      _clear() { (this._repeat ? native.clearInterval : native.clearTimeout)(this._id); }
      // a browser has no event loop to keep alive; under Node (the tests) pass it on
      ref() { this._ref = true; if (this._id && typeof this._id.ref === 'function') this._id.ref(); return this; }
      unref() { this._ref = false; if (this._id && typeof this._id.unref === 'function') this._id.unref(); return this; }
      hasRef() { return this._ref; }
      refresh() { this._clear(); this._start(); return this; }
      close() { this._clear(); return this; }
      [Symbol.toPrimitive]() { return this._id; }
    }
    const clearAny = (t) => { if (t instanceof Timeout) t._clear(); else if (t != null) { native.clearTimeout(t); native.clearInterval(t); } };
    const timers = {
      setTimeout: (fn, ms, ...args) => new Timeout(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => new Timeout(fn, ms, args, true),
      setImmediate: (fn, ...args) => new Timeout(fn, 0, args, false),
      clearTimeout: clearAny,
      clearInterval: clearAny,
      clearImmediate: clearAny,
    };

    // ----- process -----
    const proc = new EventEmitter();
    const out = (level) => ({ write(chunk) { console[level](String(chunk).replace(/\n$/, '')); return true; }, isTTY: false, columns: 80 });
    Object.assign(proc, {
      argv: ['/system/bin/node', path.join(appRoot, 'server.js'), ...argv],
      argv0: 'node',
      execArgv: [],
      execPath: '/system/bin/node',
      env: { ...env },
      platform,
      arch,
      pid,
      ppid: 0,
      title: 'mundusmaker',
      version,
      versions: { node: version.replace(/^v/, ''), mundusmaker_runtime: '1' },
      release: { name: 'node' },
      exitCode: undefined,
      connected: false,
      stdout: out('log'),
      stderr: out('error'),
      cwd: () => appRoot,
      chdir() { throw new Error('process.chdir() is not supported in the phone app'); },
      umask: () => 0o22,
      uptime: () => (now() - started) / 1000,
      hrtime: Object.assign((prev) => {
        const t = now(), s = Math.floor(t / 1000), n = Math.floor((t % 1000) * 1e6);
        if (!prev) return [s, n];
        let ds = s - prev[0], dn = n - prev[1];
        if (dn < 0) { ds--; dn += 1e9; }
        return [ds, dn];
      }, { bigint: () => BigInt(Math.floor(now() * 1e6)) }),
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      emitWarning: (warning) => console.warn(`(node) ${warning && warning.message ? warning.message : warning}`),
      exit(code) {
        if (runtime.exited) return;
        runtime.exited = true;
        const status = code === undefined ? (proc.exitCode || 0) : code;
        try { proc.emit('exit', status); } finally { host.exit(status); }
      },
    });

    // ----- fs -----
    const fsError = (err, syscall, p, dest) => {
      const code = (err && err.code) || 'EIO';
      const detail = (err && err.message) || DESCRIPTIONS[code] || 'i/o error';
      const message = `${code}: ${detail}, ${syscall} '${p}'${dest ? ` -> '${dest}'` : ''}`;
      return Object.assign(new Error(message), { errno: ERRNO[code] === undefined ? -5 : ERRNO[code], code, syscall, path: p }, dest ? { dest } : {});
    };
    // Every file call is a round trip to the host, so after a folder is
    // listed the first read in it fetches its small sibling files in one
    // 'readmany' (server.js lists entries, then reads each). What is fetched
    // lives only until the current synchronous run ends, and any change
    // clears it at once: this worker is the only writer of the app's folders,
    // so a read can never return bytes older than the last write.
    const READ_AHEAD_FILE = 512 * 1024;
    const READ_AHEAD_TOTAL = 8 * 1024 * 1024;
    const listings = new Map(); // dir -> entries from readdir
    const readAhead = new Map(); // path -> bytes
    let forgetQueued = false;
    const forget = () => { listings.clear(); readAhead.clear(); };
    const forgetSoon = () => {
      if (forgetQueued) return;
      forgetQueued = true;
      queueMicrotask(() => { forgetQueued = false; forget(); });
    };
    const MUTATING = new Set(['write', 'mkdir', 'rename', 'rm', 'rmdir', 'unlink', 'copy', 'mkdtemp']);
    const call = (op, args, data, syscall, p, dest) => {
      if (MUTATING.has(op)) forget();
      try { return host.fs(op, args, data); } catch (err) { throw fsError(err, syscall, p, dest); }
    };
    function readAheadFor(abs) {
      if (readAhead.has(abs)) return readAhead.get(abs);
      const dir = path.dirname(abs);
      const entries = listings.get(dir);
      if (!entries) return null;
      const name = abs.slice(dir.length + 1);
      const ext = path.extname(name);
      const self = entries.find((e) => e.name === name);
      if (!self || self.type !== 'file' || !(self.size <= READ_AHEAD_FILE)) return null;
      const paths = [abs];
      let total = self.size;
      for (const e of entries) {
        if (e.name === name || e.type !== 'file' || !(e.size <= READ_AHEAD_FILE) || path.extname(e.name) !== ext) continue;
        const p = path.join(dir, e.name);
        if (readAhead.has(p) || total + e.size > READ_AHEAD_TOTAL) continue;
        total += e.size;
        paths.push(p);
      }
      if (paths.length < 2) return null;
      let bytes;
      try { bytes = host.fs('readmany', { paths }, null); } catch { return null; } // an older host: read one by one
      const nl = bytes.indexOf(10);
      const { sizes } = JSON.parse(utf8Decoder.decode(bytes.subarray(0, nl)));
      let at = nl + 1;
      paths.forEach((p, i) => {
        if (sizes[i] < 0) return; // gone or unreadable: the single read reports why
        readAhead.set(p, Buffer.view(bytes.subarray(at, at + sizes[i])));
        at += sizes[i];
      });
      forgetSoon();
      return readAhead.has(abs) ? readAhead.get(abs) : null;
    }
    const toPath = (p) => {
      if (typeof p === 'string') return path.resolve(p);
      if (p instanceof Uint8Array) return path.resolve(Buffer.view(p).toString());
      if (p && typeof p === 'object' && p.href && p.protocol === 'file:') return path.resolve(decodeURIComponent(p.pathname));
      throw new TypeError(`The "path" argument must be of type string, Buffer or URL. Received ${typeof p}`);
    };
    const encodingOf = (opts) => (typeof opts === 'string' ? opts : opts && opts.encoding) || null;
    const writeFlag = (flag) => {
      const f = String(flag || 'w');
      if (f.includes('x')) return 'wx';
      if (f.startsWith('a')) return 'a';
      return 'w';
    };

    class Stats {
      constructor(s) {
        this._type = s.type;
        this.size = s.size;
        this.mode = s.mode || 0;
        this.atimeMs = s.atimeMs; this.mtimeMs = s.mtimeMs; this.ctimeMs = s.ctimeMs; this.birthtimeMs = s.birthtimeMs;
        this.atime = new Date(s.atimeMs); this.mtime = new Date(s.mtimeMs); this.ctime = new Date(s.ctimeMs); this.birthtime = new Date(s.birthtimeMs);
        this.dev = 0; this.ino = 0; this.nlink = 1; this.uid = 0; this.gid = 0; this.rdev = 0; this.blksize = 4096; this.blocks = Math.ceil(s.size / 512);
      }
      isFile() { return this._type === 'file'; }
      isDirectory() { return this._type === 'dir'; }
      isSymbolicLink() { return this._type === 'symlink'; }
      isFIFO() { return false; }
      isSocket() { return false; }
      isBlockDevice() { return false; }
      isCharacterDevice() { return false; }
    }

    class Dirent {
      constructor(name, type, dir) { this.name = name; this._type = type; this.parentPath = dir; this.path = dir; }
      isFile() { return this._type === 'file'; }
      isDirectory() { return this._type === 'dir'; }
      isSymbolicLink() { return this._type === 'symlink'; }
      isFIFO() { return false; }
      isSocket() { return false; }
      isBlockDevice() { return false; }
      isCharacterDevice() { return false; }
    }

    // file descriptors: only what atomicWrite needs (open, write, fsync, close)
    const fds = new Map();
    let nextFd = 100;
    const fdEntry = (fd, syscall) => {
      const entry = fds.get(fd);
      if (!entry) throw fsError({ code: 'EBADF' }, syscall, String(fd));
      return entry;
    };
    // Writes to a descriptor are held until fsync or close (one round trip,
    // not one per call). Node reports a failed write at the write; here it
    // surfaces at that flush, once: the descriptor is then spent, so the
    // closeSync in atomicWrite's finally releases it without failing again,
    // and the temporary file is still cleaned up.
    const flushFd = (entry, fsync, syscall) => {
      if (entry.failed || (!entry.dirty && !fsync)) return;
      const data = entry.chunks.length === 1 ? entry.chunks[0] : Buffer.concat(entry.chunks);
      try {
        call('write', { path: entry.path, flag: entry.append ? 'a' : 'w', fsync: !!fsync }, entry.append && !entry.dirty ? EMPTY : data, syscall, entry.path);
      } catch (err) {
        entry.failed = true;
        entry.chunks = [];
        throw err;
      }
      if (entry.append) entry.chunks = [];
      entry.dirty = false;
    };

    const stat = (p, follow, opts) => {
      const abs = toPath(p);
      const quiet = opts && opts.throwIfNoEntry === false;
      const s = call('stat', { path: abs, follow, quiet }, null, follow ? 'stat' : 'lstat', abs);
      return s ? new Stats(s) : undefined;
    };

    const fs = {
      constants: {
        F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
        O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
      },
      Stats,
      Dirent,
      existsSync(p) {
        try { return call('stat', { path: toPath(p), follow: true, quiet: true }, null, 'stat', p) !== null; } catch { return false; }
      },
      statSync: (p, opts) => stat(p, true, opts),
      lstatSync: (p, opts) => stat(p, false, opts),
      fstatSync: (fd) => stat(fdEntry(fd, 'fstat').path, true),
      accessSync(p) { stat(p, true); },
      readFileSync(p, opts) {
        const abs = typeof p === 'number' ? fdEntry(p, 'read').path : toPath(p);
        const ahead = readAheadFor(abs);
        if (ahead) readAhead.delete(abs); // each prefetched file is handed out once
        const buf = ahead || Buffer.view(call('read', { path: abs }, null, 'open', abs));
        const enc = encodingOf(opts);
        return enc ? buf.toString(enc) : buf;
      },
      writeFileSync(p, data, opts) {
        const enc = encodingOf(opts) || 'utf8';
        const bytes = toBytes(data, enc);
        if (typeof p === 'number') {
          const entry = fdEntry(p, 'write');
          entry.chunks.push(bytes);
          entry.dirty = true;
          return;
        }
        const abs = toPath(p);
        call('write', { path: abs, flag: writeFlag(opts && opts.flag), fsync: false }, bytes, 'open', abs);
      },
      appendFileSync(p, data, opts) {
        const abs = toPath(p);
        call('write', { path: abs, flag: 'a', fsync: false }, toBytes(data, encodingOf(opts) || 'utf8'), 'open', abs);
      },
      writeSync(fd, data, a, b) {
        const entry = fdEntry(fd, 'write');
        const bytes = typeof data === 'string' ? bytesFromString(data, typeof b === 'string' ? b : 'utf8')
          : toBytes(data).subarray(a || 0, b === undefined ? undefined : (a || 0) + b);
        entry.chunks.push(bytes);
        entry.dirty = true;
        return bytes.length;
      },
      openSync(p, flags = 'r') {
        const abs = toPath(p);
        const f = String(flags);
        if (f.startsWith('r')) stat(abs, true);
        else call('write', { path: abs, flag: f.includes('x') ? 'wx' : f.startsWith('a') ? 'a' : 'w', fsync: false }, EMPTY, 'open', abs);
        const fd = nextFd++;
        fds.set(fd, { path: abs, append: f.startsWith('a'), chunks: [], dirty: false });
        return fd;
      },
      fsyncSync(fd) { flushFd(fdEntry(fd, 'fsync'), true, 'fsync'); },
      fdatasyncSync(fd) { flushFd(fdEntry(fd, 'fdatasync'), true, 'fdatasync'); },
      closeSync(fd) {
        const entry = fdEntry(fd, 'close');
        try { flushFd(entry, false, 'close'); } finally { fds.delete(fd); }
      },
      readdirSync(p, opts) {
        const abs = toPath(p);
        const { entries } = call('readdir', { path: abs }, null, 'scandir', abs);
        if (opts && typeof opts === 'object' && opts.recursive) throw new Error('readdirSync({ recursive }) is not supported in the phone app');
        listings.set(abs, entries);
        forgetSoon();
        return opts && typeof opts === 'object' && opts.withFileTypes
          ? entries.map((e) => new Dirent(e.name, e.type, abs))
          : entries.map((e) => e.name);
      },
      mkdirSync(p, opts) {
        const abs = toPath(p);
        const recursive = !!(opts && typeof opts === 'object' && opts.recursive);
        const { first } = call('mkdir', { path: abs, recursive }, null, 'mkdir', abs);
        return recursive ? (first || undefined) : undefined;
      },
      mkdtempSync(prefix) {
        // resolve() drops a trailing slash, which in Node means "inside this folder"
        const abs = toPath(prefix) + (/\/$/.test(String(prefix)) ? '/' : '');
        return call('mkdtemp', { prefix: abs }, null, 'mkdtemp', `${abs}XXXXXX`).path;
      },
      renameSync(from, to) {
        const a = toPath(from), b = toPath(to);
        call('rename', { from: a, to: b }, null, 'rename', a, b);
      },
      copyFileSync(from, to, mode = 0) {
        const a = toPath(from), b = toPath(to);
        call('copy', { from: a, to: b, excl: (mode & 1) === 1 }, null, 'copyfile', a, b);
      },
      rmSync(p, opts = {}) {
        const abs = toPath(p);
        try {
          call('rm', { path: abs, recursive: !!opts.recursive, force: !!opts.force }, null, 'rm', abs);
        } catch (err) {
          // Node's own error for a folder without { recursive }
          if (err.code === 'EISDIR') throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${abs}`), { code: 'ERR_FS_EISDIR', errno: 21, syscall: 'rm', path: abs });
          throw err;
        }
      },
      rmdirSync(p, opts = {}) {
        const abs = toPath(p);
        if (opts.recursive) call('rm', { path: abs, recursive: true, force: false }, null, 'rmdir', abs);
        else call('rmdir', { path: abs }, null, 'rmdir', abs);
      },
      unlinkSync(p) {
        const abs = toPath(p);
        call('unlink', { path: abs }, null, 'unlink', abs);
      },
      realpathSync: Object.assign((p) => {
        const abs = toPath(p);
        return call('realpath', { path: abs }, null, 'realpath', abs).path;
      }, { native: (p) => fs.realpathSync(p) }),
      createReadStream() { throw new Error('fs streams are not supported in the phone app'); },
      createWriteStream() { throw new Error('fs streams are not supported in the phone app'); },
      watch() { throw new Error('fs.watch is not supported in the phone app'); },
    };
    // callback and promise forms, on top of the synchronous calls
    const asyncNames = ['readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'readdir', 'mkdir', 'rename', 'copyFile', 'rm', 'rmdir', 'unlink', 'access', 'mkdtemp', 'realpath'];
    fs.promises = {};
    for (const name of asyncNames) {
      const sync = fs[`${name}Sync`];
      fs[name] = (...args) => {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        native.setTimeout(() => {
          let value;
          try { value = sync(...args); } catch (err) { if (cb) cb(err); return; }
          if (cb) cb(null, value);
        }, 0);
      };
      fs.promises[name] = (...args) => new Promise((resolve, reject) => {
        native.setTimeout(() => { try { resolve(sync(...args)); } catch (err) { reject(err); } }, 0);
      });
    }
    fs.exists = (p, cb) => native.setTimeout(() => cb(fs.existsSync(p)), 0);

    // ----- crypto -----
    const webcrypto = root.crypto;
    const crypto = {
      webcrypto,
      getRandomValues: (array) => webcrypto.getRandomValues(array),
      randomBytes(size, cb) {
        const b = new Buffer(size);
        for (let i = 0; i < size; i += 65536) webcrypto.getRandomValues(b.subarray(i, Math.min(size, i + 65536)));
        if (cb) { native.setTimeout(() => cb(null, b), 0); return undefined; }
        return b;
      },
      randomUUID() {
        if (typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
        const b = webcrypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, (x) => HEX[x]).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      },
      createHash(algorithm) {
        if (String(algorithm).toLowerCase() !== 'sha256') throw new Error(`Digest method not supported: ${algorithm} (the phone app has sha256 only)`);
        const chunks = [];
        const hash = {
          update(data, encoding) { chunks.push(toBytes(data, encoding || 'utf8')); return hash; },
          digest(encoding) {
            const total = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            const digest = Buffer.view(sha256(total));
            return encoding ? digest.toString(encoding) : digest;
          },
        };
        return hash;
      },
      timingSafeEqual(a, b) {
        if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length');
        let diff = 0;
        for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
        return diff === 0;
      },
    };

    // ----- http: one server, fed the page requests the host relays -----
    class IncomingMessage extends EventEmitter {
      constructor(meta, body) {
        super();
        this.method = String(meta.method || 'GET').toUpperCase();
        this.url = meta.url || '/';
        this.httpVersion = '1.1';
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;
        this.headers = Object.create(null);
        this.rawHeaders = [];
        for (const [name, value] of meta.headers || []) {
          const key = String(name).toLowerCase();
          this.rawHeaders.push(name, value);
          this.headers[key] = key in this.headers ? `${this.headers[key]}, ${value}` : String(value);
        }
        this.socket = { remoteAddress: '127.0.0.1', remotePort: 0, encrypted: false, setTimeout() {}, destroy() {}, on() {} };
        this.connection = this.socket;
        this.complete = false;
        this.destroyed = false;
        this._body = Buffer.view(body || EMPTY);
        this._flowing = false;
        this._encoding = null;
        // like a Node stream: the body flows once someone listens for 'data'
        this._onListener = (name) => { if (name === 'data') this.resume(); };
      }
      setEncoding(enc) { this._encoding = enc; return this; }
      setTimeout() { return this; }
      pause() { return this; }
      resume() {
        if (this._flowing) return this;
        this._flowing = true;
        native.setTimeout(() => {
          if (this.destroyed) return;
          if (this._body.length) this.emit('data', this._encoding ? this._body.toString(this._encoding) : this._body);
          if (this.destroyed) return; // a handler refused the body (too large)
          this.complete = true;
          this.emit('end');
          this.emit('close');
        }, 0);
        return this;
      }
      destroy(err) {
        this.destroyed = true;
        if (err) native.setTimeout(() => this.emit('error', err), 0);
        return this;
      }
      async *[Symbol.asyncIterator]() {
        this._flowing = true;
        if (this._body.length) yield this._body;
        this.complete = true;
      }
    }

    class ServerResponse extends EventEmitter {
      constructor(id, req) {
        super();
        this._id = id;
        this._req = req;
        this._headers = new Map(); // lower-case name -> [name, value]
        this._chunks = [];
        this.statusCode = 200;
        this.statusMessage = '';
        this.headersSent = false;
        this.writableEnded = false;
        this.finished = false;
        this.sendDate = true;
      }
      setHeader(name, value) { this._headers.set(String(name).toLowerCase(), [String(name), value]); return this; }
      getHeader(name) { const h = this._headers.get(String(name).toLowerCase()); return h ? h[1] : undefined; }
      getHeaders() { const o = {}; for (const [k, [, v]] of this._headers) o[k] = v; return o; }
      getHeaderNames() { return [...this._headers.keys()]; }
      hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }
      removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
      writeHead(status, message, headers) {
        if (typeof message !== 'string') { headers = message; message = ''; }
        this.statusCode = status;
        this.statusMessage = message || '';
        if (Array.isArray(headers)) {
          const pairs = Array.isArray(headers[0]) ? headers : headers.reduce((acc, v, i) => (i % 2 ? acc : [...acc, [v, headers[i + 1]]]), []);
          for (const [k, v] of pairs) this.setHeader(k, v);
        } else if (headers) {
          for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
        }
        this.headersSent = true;
        return this;
      }
      flushHeaders() { this.headersSent = true; }
      setTimeout() { return this; }
      write(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (chunk != null) this._chunks.push(toBytes(chunk, encoding || 'utf8'));
        this.headersSent = true;
        if (cb) native.setTimeout(cb, 0);
        return true;
      }
      end(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (this.writableEnded) return this;
        if (chunk != null) this._chunks.push(toBytes(chunk, encoding || 'utf8'));
        this.headersSent = true;
        this.writableEnded = true;
        this.finished = true;
        const headers = [];
        for (const [, [name, value]] of this._headers) {
          for (const v of Array.isArray(value) ? value : [value]) headers.push([name, String(v)]);
        }
        const body = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
        host.respond(this._id, { status: this.statusCode, statusText: this.statusMessage, headers }, body);
        native.setTimeout(() => {
          this.emit('finish');
          this.emit('close');
          if (cb) cb();
        }, 0);
        return this;
      }
      destroy() {
        if (!this.writableEnded) this.end();
        return this;
      }
    }

    class Server extends EventEmitter {
      constructor(handler) {
        super();
        this.listening = false;
        if (handler) this.on('request', handler);
      }
      listen(...args) {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        this._port = typeof args[0] === 'object' && args[0] ? args[0].port : args[0];
        runtime.server = this;
        queueMicrotask(() => {
          this.listening = true;
          this.emit('listening');
          if (cb) cb();
          if (runtime.onListen) runtime.onListen();
        });
        return this;
      }
      close(cb) {
        this.listening = false;
        if (runtime.server === this) runtime.server = null;
        if (cb) native.setTimeout(cb, 0);
        return this;
      }
      address() { return { port: Number(this._port) || 0, address: '127.0.0.1', family: 'IPv4' }; }
      closeAllConnections() {}
      closeIdleConnections() {}
      setTimeout() { return this; }
      ref() { return this; }
      unref() { return this; }
    }

    // the app makes no outgoing http requests on a phone (port probes, the
    // upgrade quit call); report the same refusal Node would for an empty port
    const refusedRequest = () => {
      const req = new EventEmitter();
      Object.assign(req, { setTimeout() { return req; }, destroy() { return req; }, end() { return req; }, write() { return true; } });
      native.setTimeout(() => req.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' })), 0);
      return req;
    };

    const http = {
      createServer(opts, handler) { return new Server(typeof opts === 'function' ? opts : handler); },
      Server,
      IncomingMessage,
      ServerResponse,
      get: refusedRequest,
      request: refusedRequest,
      STATUS_CODES: { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 428: 'Precondition Required', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' },
    };

    // ----- fetch: the three user-started downloads go through the host -----
    function headerPairs(headers) {
      if (!headers) return [];
      if (typeof headers.forEach === 'function' && !Array.isArray(headers)) { const pairs = []; headers.forEach((v, k) => pairs.push([k, v])); return pairs; }
      if (Array.isArray(headers)) return headers.map(([k, v]) => [String(k), String(v)]);
      return Object.entries(headers).map(([k, v]) => [k, String(v)]);
    }
    function makeHeaders(pairs) {
      const map = new Map();
      for (const [k, v] of pairs) {
        const key = String(k).toLowerCase();
        map.set(key, map.has(key) ? `${map.get(key)}, ${v}` : String(v));
      }
      return {
        get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null),
        has: (name) => map.has(String(name).toLowerCase()),
        forEach: (fn) => map.forEach((v, k) => fn(v, k)),
        entries: () => map.entries(),
        keys: () => map.keys(),
        values: () => map.values(),
        [Symbol.iterator]: () => map.entries(),
      };
    }
    function abortError() {
      try { return new DOMException('This operation was aborted', 'AbortError'); } catch { return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); }
    }
    async function nodeFetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input && (input.href || input.url) ? String(input.href || input.url) : String(input);
      const signal = init.signal;
      if (signal && signal.aborted) throw abortError();
      const meta = {
        url,
        method: String(init.method || 'GET').toUpperCase(),
        headers: headerPairs(init.headers),
        redirect: init.redirect || 'follow',
        timeoutMs: 120000,
      };
      const request = host.fetch(meta, init.body == null ? EMPTY : toBytes(init.body));
      const answer = await (signal ? Promise.race([request, new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))]) : request);
      const body = Buffer.view(answer.body || EMPTY);
      let used = false;
      const take = () => { if (used) throw new TypeError('Body is unusable: Body has already been read'); used = true; return body; };
      return {
        status: answer.meta.status,
        statusText: answer.meta.statusText || '',
        ok: answer.meta.status >= 200 && answer.meta.status < 300,
        url: answer.meta.url || url,
        redirected: !!answer.meta.url && answer.meta.url !== url,
        type: 'basic',
        headers: makeHeaders(answer.meta.headers || []),
        get bodyUsed() { return used; },
        body: {
          async *[Symbol.asyncIterator]() {
            const bytes = take();
            for (let i = 0; i < bytes.length; i += 65536) {
              if (signal && signal.aborted) throw abortError();
              yield bytes.subarray(i, i + 65536);
            }
          },
        },
        async arrayBuffer() { const b = take(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        async text() { return take().toString('utf8'); },
        async json() { return JSON.parse(take().toString('utf8')); },
      };
    }

    // ----- the rest of Node server.js touches -----
    const os = {
      EOL: '\n',
      platform: () => platform,
      type: () => 'Linux',
      release: () => '',
      arch: () => arch,
      tmpdir: () => tmpDir,
      homedir: () => homeDir,
      hostname: () => 'localhost',
      cpus: () => [],
      totalmem: () => 0,
      freemem: () => 0,
      uptime: () => proc.uptime(),
      networkInterfaces: () => ({}),
      userInfo: () => ({ username: 'mundusmaker', homedir: homeDir, shell: null, uid: -1, gid: -1 }),
    };
    const url = {
      URL: root.URL,
      URLSearchParams: root.URLSearchParams,
      fileURLToPath: (u) => decodeURIComponent(new root.URL(String(u)).pathname),
      pathToFileURL: (p) => new root.URL(`file://${encodeURI(path.resolve(p))}`),
    };
    const childProcess = {
      exec(cmd, opts, cb) {
        const done = typeof opts === 'function' ? opts : cb;
        native.setTimeout(() => done && done(new Error('child processes are not available in the phone app'), '', ''), 0);
        return new EventEmitter();
      },
      execSync() { throw new Error('child processes are not available in the phone app'); },
      spawn() { throw new Error('child processes are not available in the phone app'); },
      fork() { throw new Error('child processes are not available in the phone app'); },
    };

    const builtins = {
      fs,
      path,
      crypto,
      http,
      events: EventEmitter,
      util,
      os,
      url,
      buffer: { Buffer },
      timers: timers,
      child_process: childProcess,
      process: proc,
    };

    // ----- require: CommonJS over the host's files -----
    const cache = Object.create(null);
    let mainModule = null;

    class Module {
      constructor(filename, parent) {
        this.id = filename;
        this.filename = filename;
        this.path = path.dirname(filename);
        this.exports = {};
        this.parent = parent || null;
        this.children = [];
        this.loaded = false;
        this.paths = [];
      }
    }

    const isFile = (p) => {
      try { const s = call('stat', { path: p, follow: true, quiet: true }, null, 'stat', p); return !!s && s.type === 'file'; } catch { return false; }
    };
    const notFound = (request, from) => Object.assign(new Error(`Cannot find module '${request}'${from ? `\nRequire stack:\n- ${from}` : ''}`), { code: 'MODULE_NOT_FOUND' });

    function resolveFilename(request, parent) {
      const name = String(request).replace(/^node:/, '');
      if (Object.prototype.hasOwnProperty.call(builtins, name)) return `node:${name}`;
      if (!/^(\.{1,2}(\/|$)|\/)/.test(name)) throw notFound(request, parent && parent.filename);
      const base = path.resolve(parent ? parent.path : appRoot, name);
      for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
        if (isFile(candidate)) return candidate;
      }
      throw notFound(request, parent && parent.filename);
    }

    function compile(source, filename) {
      let src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
      if (src.startsWith('#!')) src = `//${src.slice(2)}`;
      const sourceUrl = `app:///${path.relative(appRoot, filename)}`;
      // eslint-disable-next-line no-new-func
      return new Function('exports', 'require', 'module', '__filename', '__dirname', `${src}\n//# sourceURL=${sourceUrl}`);
    }

    function makeRequire(mod) {
      const req = (request) => loadModule(resolveFilename(request, mod), mod);
      req.resolve = (request) => resolveFilename(request, mod);
      req.cache = cache;
      Object.defineProperty(req, 'main', { get: () => mainModule, enumerable: true });
      return req;
    }

    function loadModule(filename, parent) {
      if (filename.startsWith('node:')) return builtins[filename.slice(5)];
      if (cache[filename]) return cache[filename].exports;
      const mod = new Module(filename, parent);
      if (parent) parent.children.push(mod);
      cache[filename] = mod;
      try {
        const source = fs.readFileSync(filename, 'utf8');
        if (filename.endsWith('.json')) mod.exports = JSON.parse(source.replace(/^﻿/, ''));
        else compile(source, filename).call(mod.exports, mod.exports, makeRequire(mod), mod, filename, mod.path);
        mod.loaded = true;
      } catch (err) {
        delete cache[filename];
        throw err;
      }
      return mod.exports;
    }

    /** Run a file as the main module, the way `node <file>` does. */
    function runMain(file) {
      const filename = path.resolve(file);
      proc.argv[1] = filename;
      mainModule = new Module(filename, null);
      cache[filename] = mainModule;
      try {
        const source = fs.readFileSync(filename, 'utf8');
        compile(source, filename).call(mainModule.exports, mainModule.exports, makeRequire(mainModule), mainModule, filename, mainModule.path);
        mainModule.loaded = true;
      } catch (err) {
        delete cache[filename];
        throw err;
      }
      return mainModule.exports;
    }

    /** Hand one relayed page request to the running server. */
    function dispatch(meta, body) {
      const server = runtime.server;
      if (!server || !server.listening) {
        host.respond(meta.id, { status: 503, headers: [['content-type', 'application/json; charset=utf-8']] },
          utf8Encoder.encode(JSON.stringify({ error: 'MundusMaker is still starting. Try again in a moment.' })));
        return;
      }
      const req = new IncomingMessage(meta, body);
      const res = new ServerResponse(meta.id, req);
      server.emit('request', req, res);
    }

    /** Make the Node globals server.js expects exist in a scope (the worker's). */
    function installGlobals(scope) {
      scope.global = scope;
      scope.process = proc;
      scope.Buffer = Buffer;
      Object.assign(scope, timers);
      scope.fetch = nodeFetch;
    }

    return Object.assign(runtime, {
      require: makeRequire(null),
      runMain,
      dispatch,
      installGlobals,
      process: proc,
      Buffer,
      fetch: nodeFetch,
      timers,
      builtins,
    });
  }

  const api = { create, Buffer, sha256, EventEmitter, makePath, format };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MundusNode = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
