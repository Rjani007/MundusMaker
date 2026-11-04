/*
 * The browser's copy of the app's folders, in IndexedDB (docs/website.md).
 *
 * memfs.js holds the files the engine works on; this keeps them between
 * visits. Each account has a database of its own, so two people who share a
 * browser never see each other's worlds. One write is one transaction: the
 * files a request changed, and the sync state that goes with them, are kept
 * together or not at all.
 *
 * Small files are kept as bytes and loaded with everything else at start.
 * Big files, and everything in folders that are rarely read (the trash,
 * snapshots, history, library packs), are kept as Blobs, which stay on disk
 * until FileReaderSync reads them.
 */
(function (root) {
  'use strict';

  const VERSION = 1;
  const SMALL = 64 * 1024;
  const COLD = /^\/data\/(?:\.trash|\.snapshots|\.conflicts|\.restore-transactions|\.library|\.sheet-templates)(?:\/|$)|\/\.history(?:\/|$)/;

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // a failed put aborts the whole transaction, so nothing is half kept
  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('the browser stopped the save'));
  });
  const exact = (data) => (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer);

  /** Whether a file is kept on disk as a Blob rather than loaded at start. */
  const keepOnDisk = (path, size) => size > SMALL || COLD.test(path);

  async function openStore(name, { idb = root.indexedDB, readBlob } = {}) {
    if (!idb) throw new Error('this browser has no IndexedDB, so MundusMaker cannot keep your worlds here');
    const db = await new Promise((resolve, reject) => {
      const req = idb.open(name, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('sync')) d.createObjectStore('sync', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('the browser would not open its storage'));
      req.onblocked = () => reject(new Error('an older MundusMaker tab is still open; close it and reload this one'));
    });
    db.onversionchange = () => db.close();
    let blobsWork = true; // some browsers refuse Blobs in IndexedDB from a worker; then bytes it is

    function recordOf(path, node, useBlobs) {
      const rec = {
        path, type: node.type, size: node.size, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs,
        atimeMs: node.atimeMs, birthtimeMs: node.birthtimeMs, mode: node.mode,
      };
      if (node.type !== 'file') return { rec };
      if (useBlobs && keepOnDisk(path, node.size)) {
        if (node.blob) return { rec: { ...rec, blob: node.blob } };
        return { rec: { ...rec, blob: new Blob([node.data || new Uint8Array(0)]) }, adopt: node.ver };
      }
      const data = node.data || (node.blob ? new Uint8Array(readBlob(node.blob)) : new Uint8Array(0));
      return { rec: { ...rec, bytes: exact(data) } };
    }

    async function writeOnce(fileChanges, syncChanges, metaChanges, useBlobs) {
      const tx = db.transaction(['files', 'sync', 'meta'], 'readwrite', { durability: 'strict' });
      const done = finished(tx);
      const files = tx.objectStore('files');
      const adopt = [];
      for (const { path, node } of fileChanges) {
        if (!node) { files.delete(path); continue; }
        const { rec, adopt: ver } = recordOf(path, node, useBlobs);
        files.put(rec);
        if (ver !== undefined) adopt.push({ path, ver });
      }
      const sync = tx.objectStore('sync');
      for (const [path, base] of syncChanges) {
        if (base) sync.put({ path, ...base }); else sync.delete(path);
      }
      const meta = tx.objectStore('meta');
      for (const [key, value] of metaChanges) {
        if (value === undefined) meta.delete(key); else meta.put(value, key);
      }
      await done;
      return adopt;
    }

    return {
      name,
      /** Everything kept: { files: [records], sync: [bases], meta: {} }. */
      async loadAll() {
        const tx = db.transaction(['files', 'sync', 'meta'], 'readonly');
        const [files, sync, keys, values] = await Promise.all([
          request(tx.objectStore('files').getAll()),
          request(tx.objectStore('sync').getAll()),
          request(tx.objectStore('meta').getAllKeys()),
          request(tx.objectStore('meta').getAll()),
        ]);
        return { files, sync, meta: Object.fromEntries(keys.map((k, i) => [k, values[i]])) };
      },
      /**
       * Keep one batch: file changes from memfs.takeChanges(), sync bases
       * ([path, base|null]) and meta values ([key, value|undefined]). Resolves
       * once the browser has them; answers the files kept on disk as new Blobs,
       * which the caller may hand back to memfs (blobsFor) so their bytes leave memory.
       */
      async write(fileChanges, syncChanges = [], metaChanges = []) {
        if (blobsWork) {
          try { return await writeOnce(fileChanges, syncChanges, metaChanges, true); } catch (err) {
            if (!fileChanges.some(({ path, node }) => node && node.type === 'file' && keepOnDisk(path, node.size))) throw err;
            if (err && err.name === 'QuotaExceededError') throw err;
            blobsWork = false; // try once more without Blobs before giving up
            console.warn(`[mundusmaker] this browser would not keep files as Blobs (${err && err.message}); keeping bytes instead`);
          }
        }
        return writeOnce(fileChanges, syncChanges, metaChanges, false);
      },
      /** The on-disk Blobs of files just written, as [{ path, ver, blob }]. */
      async blobsFor(list) {
        if (!list.length) return [];
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const recs = await Promise.all(list.map((item) => request(store.get(item.path))));
        return list.map((item, i) => ({ ...item, blob: recs[i] && recs[i].blob })).filter((x) => x.blob);
      },
      close() { db.close(); },
    };
  }

  /** Remove an account's copy from this browser (after the engine has stopped). */
  function deleteStore(name, idb = root.indexedDB) {
    return new Promise((resolve, reject) => {
      const req = idb.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('MundusMaker is still open in another tab'));
    });
  }

  const api = { openStore, deleteStore, keepOnDisk };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MundusStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
