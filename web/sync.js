/*
 * Keeps a GM's worlds the same in every browser they sign in to (docs/website.md).
 *
 * The engine's files (memfs.js) are the working copy. What travels is each
 * world's world.json, entries and pictures; history, exports, the trash,
 * snapshots and library packs stay in the browser that made them, as they
 * stay on the desktop when a folder-sync tool carries the worlds folder.
 *
 * The account keeps one row per file (path, SHA-256, size, deleted) with a
 * revision number, and the bytes as content-addressed objects. A change is
 * sent with the revision it was based on, and the account refuses it if the
 * file moved on since (supabase/migrations, sync_commit). Then this side
 * pulls first, and when both sides changed an entry, both versions are kept:
 * the other one as a "MundusMaker sync copy" beside it, which the app shows
 * like any folder-sync conflict and lets the GM compare and adopt. Nothing
 * is ever deleted outright: a file removed on another device goes to this
 * browser's trash, where Settings → Recover can bring it back.
 *
 * Plain JavaScript with no imports; the cloud, the hash and the clock are
 * passed in, so tests/web-sync.test.js runs two "devices" against a fake
 * account in Node.
 */
(function (root) {
  'use strict';

  // keep in step with sync_path_ok() and sync_limits() in the migration (tests/site.test.js)
  const PATH_RE = /^worlds\/[a-z0-9][a-z0-9-]{0,127}\/(?:world\.json|entities\/[^/.][^/]*\.json|assets\/[^/.][^/]*)$/;
  const LIMITS = { bytes: 100 * 1024 * 1024, fileBytes: 20 * 1024 * 1024, files: 20000 };
  const DATA = '/data/';
  const PAGE = 1000;
  const COMMIT_BATCH = 200;
  const PARALLEL = 4;

  const inScope = (rel) => typeof rel === 'string' && rel.length <= 450 && PATH_RE.test(rel) && !rel.split('/').some((s) => s === '..');
  const worldOf = (rel) => rel.split('/')[1];

  async function inBatches(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    });
    await Promise.all(workers);
  }

  function stamp(t) {
    const d = new Date(t);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;
  }

  /**
   * fs       memfs.js instance (the engine's files)
   * cloud    { changes(after, limit), upload(sha, bytes), download(sha), commit(items, device), usage(), orphans(), remove(shas) }
   * digest   async (bytes) -> lowercase hex SHA-256
   * device   a label for this browser, e.g. "Chrome on Windows"
   * onEvent  ({ type: 'status' | 'changed', ... }) for the page
   */
  function createSync({ fs, cloud, digest, device = 'another device', now = () => Date.now(), onEvent = () => {} }) {
    const bases = new Map(); // rel -> { rev, sha (null = deleted), size, mtimeMs }
    const baseChanges = new Map(); // rel -> base | null, for the store
    const metaChanges = new Map();
    const dirty = new Set();
    const uploaded = new Set(); // shas the account already has, this session
    let head = 0;
    let busy = null;
    let again = false;
    let status = { state: 'idle', lastSync: null, message: '', pending: 0 };
    let lastTidy = 0;
    let note = ''; // something this sync run wants the GM to know, kept in its final status
    const tell = (message) => { note = message; report({ message }); };

    function setBase(rel, base) { bases.set(rel, base); baseChanges.set(rel, base); }
    function setHead(rev) { if (rev > head) { head = rev; metaChanges.set('syncHead', head); } }
    function report(next) {
      status = { ...status, ...next, pending: dirty.size };
      onEvent({ type: 'status', status });
    }

    /** This browser's file, as { exists, sha, size, mtimeMs, ver }; the hash is skipped when nothing changed since the last sync. */
    async function local(rel) {
      const node = fs.node(DATA + rel);
      if (!node || node.type !== 'file') return { exists: false, sha: null };
      const base = bases.get(rel);
      const fingerprint = { exists: true, size: node.size, mtimeMs: node.mtimeMs, ver: node.ver };
      if (base && base.sha && base.size === node.size && base.mtimeMs === node.mtimeMs) return { ...fingerprint, sha: base.sha };
      const bytes = fs.bytes(DATA + rel);
      return { ...fingerprint, sha: await digest(bytes), bytes };
    }
    const unchangedSince = (rel, seen) => {
      const node = fs.node(DATA + rel);
      if (!seen.exists) return !node;
      return !!node && node.type === 'file' && node.ver === seen.ver && node.mtimeMs === seen.mtimeMs;
    };

    function ensureFolder(abs) {
      fs.call('mkdir', { path: abs.slice(0, abs.lastIndexOf('/')), recursive: true });
    }
    function writeFile(rel, bytes) {
      const abs = DATA + rel;
      ensureFolder(abs);
      fs.call('write', { path: abs, flag: 'w' }, bytes);
    }
    // Into the trash the app's Recover screen reads, in its own formats where one fits.
    function trash(rel, wholeWorld) {
      const t = now();
      const abs = DATA + rel;
      let dest;
      if (wholeWorld) {
        dest = `${DATA}.trash/${worldOf(rel)}-${t}`;
        fs.call('mkdir', { path: `${DATA}.trash`, recursive: true });
        fs.call('rename', { from: `${DATA}worlds/${worldOf(rel)}`, to: dest });
        return;
      }
      const entry = /^worlds\/([a-z0-9-]+)\/entities\/([a-z0-9-]{1,240})\.json$/.exec(rel);
      dest = entry ? `${DATA}.trash/${entry[1]}--${entry[2]}--${t}.json` : `${DATA}.trash/sync-${t}/${rel}`;
      ensureFolder(dest);
      fs.call('rename', { from: abs, to: dest });
    }
    // the other browser's version, named after it, beside this one's
    function keepConflict(rel, bytes, from) {
      const when = stamp(now());
      const entry = /^(worlds\/[a-z0-9-]+\/entities\/)(.+)\.json$/.exec(rel);
      if (entry) {
        const label = String(from || 'another device').replace(/[^\w ,.-]+/g, '').slice(0, 60) || 'another device';
        const name = `${entry[1]}${entry[2]} (MundusMaker sync copy from ${label} ${when}).json`;
        writeFile(name, bytes);
        return;
      }
      const name = `.conflicts/sync-${when.replace(/[ .]/g, '-')}-${rel.replace(/\//g, '~')}`;
      ensureFolder(DATA + name);
      fs.call('write', { path: DATA + name, flag: 'w' }, bytes);
    }
    const worldHasLocalChanges = (wid) => fs.files(`${DATA}worlds/${wid}`).some(([abs, node]) => {
      const rel = abs.slice(DATA.length);
      if (!inScope(rel)) return false;
      const base = bases.get(rel);
      return !base || !base.sha || base.size !== node.size || base.mtimeMs !== node.mtimeMs || dirty.has(rel);
    });

    // ---------- pull: the account's changes into this browser ----------

    async function pull() {
      let changed = 0;
      for (;;) {
        const rows = await cloud.changes(head, PAGE);
        if (!rows.length) break;
        const plan = [];
        for (const row of rows) {
          const base = inScope(row.path) && bases.get(row.path);
          // out of bounds, or a version this browser already has (its own, sent earlier)
          if (!inScope(row.path) || (base && row.rev <= base.rev)) { plan.push({ row, skip: true }); continue; }
          plan.push({ row, seen: await local(row.path) });
        }
        // the bytes a row may need: when this side takes the account's version, or keeps it beside its own
        await inBatches(plan.filter((p) => !p.skip && !p.row.deleted && p.seen.sha !== p.row.sha256), PARALLEL, async (p) => {
          let bytes;
          try { bytes = await cloud.download(p.row.sha256); } catch (err) {
            if (err && err.kind === 'missing') { p.lost = true; return; }
            throw err;
          }
          if (await digest(bytes) !== p.row.sha256) throw Object.assign(new Error('a file arrived damaged; it will be fetched again'), { kind: 'server' });
          p.bytes = bytes;
        });
        let settled = 0;
        for (const p of plan) {
          const { row } = p;
          if (!p.skip) {
            const outcome = apply(row, p);
            if (outcome === 'later') break;
            if (outcome === 'changed') changed++;
          }
          setHead(row.rev);
          settled++;
        }
        if (settled < plan.length || rows.length < PAGE) break;
      }
      if (changed) onEvent({ type: 'changed', count: changed });
      return changed;
    }

    /** Settle one of the account's rows against this browser; 'later' leaves it for the next pull. */
    function apply(row, p) {
      const rel = row.path;
      const base = bases.get(rel);
      const remoteSha = row.deleted ? null : row.sha256;
      const baseSha = base ? base.sha : null;
      const record = (sha) => {
        const node = fs.node(DATA + rel);
        setBase(rel, { rev: row.rev, sha, size: node && node.type === 'file' ? node.size : 0, mtimeMs: node && node.type === 'file' ? node.mtimeMs : 0 });
      };
      // the file changed while its row was being fetched: it is this side's edit now
      const moved = !unchangedSince(rel, p.seen);
      const localSha = moved ? '(edited)' : p.seen.sha;
      if (p.lost) {
        // the account has the row but not its bytes: send this browser's copy, if it has one, in its place
        setBase(rel, { rev: row.rev, sha: null, size: -1, mtimeMs: -1 });
        if (localSha !== null) dirty.add(rel);
        tell(`${rel.split('/').pop()} could not be fetched from your account; this browser's copy was kept.`);
        return 'kept';
      }

      if (localSha === remoteSha) { record(remoteSha); return 'same'; }
      if (localSha === baseSha) {
        if (remoteSha === null) {
          const wholeWorld = /^worlds\/[^/]+\/world\.json$/.test(rel);
          if (wholeWorld && worldHasLocalChanges(worldOf(rel))) {
            // deleted there but changed here: keep the world, and send it back
            setBase(rel, { rev: row.rev, sha: null, size: 0, mtimeMs: 0 });
            for (const [abs] of fs.files(`${DATA}worlds/${worldOf(rel)}`)) { const r = abs.slice(DATA.length); if (inScope(r)) dirty.add(r); }
            return 'kept';
          }
          trash(rel, wholeWorld);
          setBase(rel, { rev: row.rev, sha: null, size: 0, mtimeMs: 0 });
          return 'changed';
        }
        if (!p.bytes) return 'later';
        writeFile(rel, p.bytes);
        record(remoteSha);
        return 'changed';
      }
      // changed on both sides
      if (remoteSha === null) {
        setBase(rel, { rev: row.rev, sha: null, size: 0, mtimeMs: 0 });
        dirty.add(rel); // the edit outlives the deletion and goes back up
        return 'kept';
      }
      if (!p.bytes) return 'later';
      if (localSha === null) { // deleted here, edited there: the edit wins
        writeFile(rel, p.bytes);
        record(remoteSha);
        return 'changed';
      }
      keepConflict(rel, p.bytes, row.device);
      setBase(rel, { rev: row.rev, sha: remoteSha, size: -1, mtimeMs: -1 });
      dirty.add(rel); // this side's version becomes the main file everywhere, the other stays beside it
      return 'changed';
    }

    // ---------- push: this browser's changes to the account ----------

    async function push() {
      const items = [];
      for (const rel of [...dirty]) {
        dirty.delete(rel);
        if (!inScope(rel)) continue;
        const base = bases.get(rel);
        const seen = await local(rel);
        if (seen.exists) {
          if (base && base.sha === seen.sha) {
            if (base.size !== seen.size || base.mtimeMs !== seen.mtimeMs) setBase(rel, { ...base, size: seen.size, mtimeMs: seen.mtimeMs });
            continue;
          }
          if (seen.size > LIMITS.fileBytes) {
            tell(`${rel.split('/').pop()} is larger than ${LIMITS.fileBytes / 1048576} MB, so it stays in this browser only.`);
            continue;
          }
          items.push({ rel, sha: seen.sha, size: seen.size, bytes: seen.bytes || fs.bytes(DATA + rel), base: base ? base.rev : 0, seen });
        } else if (base && base.sha) {
          items.push({ rel, sha: null, size: 0, base: base.rev, seen });
        }
      }
      if (!items.length) return { conflicts: 0 };
      // a deleted world's world.json goes first, so other browsers trash the world in one piece
      items.sort((a, b) => (a.sha === null && /\/world\.json$/.test(a.rel) ? 0 : 1) - (b.sha === null && /\/world\.json$/.test(b.rel) ? 0 : 1));

      const sending = items.filter((it) => it.sha && !uploaded.has(it.sha));
      try {
        await inBatches(sending, PARALLEL, async (it) => { await cloud.upload(it.sha, it.bytes); uploaded.add(it.sha); });
      } catch (err) {
        for (const it of items) dirty.add(it.rel);
        throw err;
      }

      let conflicts = 0;
      let full = false;
      for (let i = 0; i < items.length; i += COMMIT_BATCH) {
        const batch = items.slice(i, i + COMMIT_BATCH);
        let answer;
        try {
          answer = await cloud.commit(batch.map((it) => ({ path: it.rel, sha256: it.sha, size: it.size, base: it.base })), device);
        } catch (err) {
          for (const it of items.slice(i)) dirty.add(it.rel);
          throw err;
        }
        const results = new Map((answer.results || []).map((r) => [r.path, r]));
        for (const it of batch) {
          const r = results.get(it.rel);
          // the head only moves by pulling, so other devices' changes in between are never skipped
          if (r && typeof r.rev === 'number' && !r.conflict && !r.missing && !r.refused) {
            setBase(it.rel, { rev: r.rev, sha: it.sha, size: it.seen.exists ? it.seen.size : 0, mtimeMs: it.seen.exists ? it.seen.mtimeMs : 0 });
          } else if (r && r.refused) {
            // not sent again until it changes again
            if (r.refused === 'full') full = true;
            else console.warn(`[mundusmaker] the account refused ${it.rel} (${r.refused})`);
          } else {
            if (r && r.missing) uploaded.delete(it.sha);
            if (r && r.conflict) conflicts++;
            dirty.add(it.rel);
          }
        }
      }
      if (full) throw Object.assign(new Error('the account holds as many files as it allows'), { kind: 'full' });
      return { conflicts };
    }

    // ---------- the loop ----------

    function classify(err) {
      if (err && err.kind) return err.kind;
      if (err && /quota|row-level security|storage.*full/i.test(err.message || '')) return 'full';
      return 'offline';
    }

    async function runOnce() {
      note = '';
      report({ state: 'syncing', message: '' });
      try {
        await pull();
        for (let round = 0; round < 4; round++) {
          const { conflicts } = await push();
          if (!conflicts) break;
          await pull();
        }
        report({ state: dirty.size ? 'pending' : 'idle', lastSync: now(), message: note });
        if (now() - lastTidy > 3600 * 1000) { lastTidy = now(); tidy().catch(() => {}); }
      } catch (err) {
        const kind = classify(err);
        const messages = {
          offline: 'Can’t reach your account right now. Your changes are kept in this browser and sync when the connection is back.',
          auth: 'Your sign-in expired. Sign in again to keep syncing; your changes are kept in this browser.',
          full: `Your account’s storage is full (${LIMITS.bytes / 1048576} MB). New changes stay in this browser until you make room.`,
          server: `Syncing stopped: ${err.message}`,
          refused: `Syncing stopped: ${err.message}`,
        };
        report({ state: kind, message: messages[kind] || messages.server });
        throw err;
      }
    }

    /** One sync now, or one more right after the one running. */
    function syncNow() {
      if (busy) { again = true; return busy; }
      busy = (async () => {
        try {
          do { again = false; await runOnce(); } while (again);
        } finally { busy = null; }
      })();
      return busy;
    }

    // Unreferenced pictures and old versions, an hour after they stopped being used.
    async function tidy() {
      const shas = await cloud.orphans();
      if (shas.length) await cloud.remove(shas);
    }

    return {
      /** Restore what the store kept: bases ([{ path, rev, sha, size, mtimeMs }]) and meta. */
      load({ sync = [], meta = {} } = {}) {
        for (const b of sync) if (b && inScope(b.path)) bases.set(b.path, { rev: Number(b.rev) || 0, sha: b.sha || null, size: Number(b.size) || 0, mtimeMs: Number(b.mtimeMs) || 0 });
        head = Number(meta.syncHead) || 0;
      },
      /** memfs reports every changed path; the ones that travel are sent at the next sync. */
      noteChange(abs) {
        if (!abs.startsWith(DATA)) return false;
        const rel = abs.slice(DATA.length);
        if (!inScope(rel)) return false;
        dirty.add(rel);
        return true;
      },
      /** Everything changed while syncing was off (an earlier visit, offline work). */
      scanAll() {
        for (const [abs, node] of fs.files(`${DATA}worlds`)) {
          const rel = abs.slice(DATA.length);
          if (!inScope(rel)) continue;
          const base = bases.get(rel);
          if (!base || !base.sha || base.size !== node.size || base.mtimeMs !== node.mtimeMs) dirty.add(rel);
        }
        for (const [rel, base] of bases) if (base.sha && !fs.node(DATA + rel)) dirty.add(rel);
        return dirty.size;
      },
      syncNow,
      pull: () => pull(),
      takeChanges() {
        const out = { bases: [...baseChanges], meta: [...metaChanges] };
        baseChanges.clear();
        metaChanges.clear();
        return out;
      },
      hasChanges: () => baseChanges.size > 0 || metaChanges.size > 0,
      /** The store could not keep a batch: report it again, unless something newer replaced it. */
      requeue({ bases: b = [], meta = [] }) {
        for (const [k, v] of b) if (!baseChanges.has(k)) baseChanges.set(k, v);
        for (const [k, v] of meta) if (!metaChanges.has(k)) metaChanges.set(k, v);
      },
      status: () => ({ ...status, pending: dirty.size }),
      get head() { return head; },
      get pending() { return dirty.size; },
    };
  }

  const api = { createSync, inScope, LIMITS, PATH_RE };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MundusSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
