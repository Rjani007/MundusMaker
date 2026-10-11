/*
 * Loaded first by the phone app's page (the native host inserts it into
 * index.html). It starts the server worker and gives the app the one thing a
 * WebView lacks: saving a downloaded file (util.js downloadBlob calls
 * window.mundusShell.save). See ../PROTOCOL.md.
 */
(function () {
  'use strict';

  const worker = new Worker('/__shell/runtime/worker.js');

  function showProblem(message) {
    const show = () => {
      const bar = document.createElement('div');
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:12px 16px;background:#5a1f24;color:#fff;font:14px/1.4 system-ui,sans-serif';
      bar.textContent = `MundusMaker could not start its engine: ${message} Close the app and open it again; your worlds are not affected.`;
      document.body.append(bar);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  worker.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'fatal') showProblem(ev.data.message);
  });
  worker.addEventListener('error', (ev) => {
    // errors inside a running server are logged there; this is a worker that never loaded
    if (ev.message && /importScripts|NetworkError|Failed to load/i.test(ev.message)) showProblem(ev.message);
  });

  window.mundusShell = {
    /**
     * The phone's Back button asks here first: true means the page closed
     * something (the entries drawer, a dialog) and the shell should stop there.
     */
    back() {
      const toggle = document.getElementById('sidebarToggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      }
      const overlays = document.querySelectorAll('.overlay');
      const top = overlays[overlays.length - 1];
      if (!top) return false;
      // dialogs close on a tap outside them; one that insists on a button stays open
      top.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (top.isConnected) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    },

    /** Offer Save / Share for a file the page made (backups, PDFs, ZIPs, PNGs). */
    save(blob, filename) {
      return fetch(`/__shell/save?name=${encodeURIComponent(filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      }).then((res) => {
        if (res.body) res.body.cancel().catch(() => {}); // an unread body stays in memory (worker.js)
        if (!res.ok) throw new Error(`the app answered ${res.status}`);
      }).catch((err) => {
        console.error(`[mundusmaker] could not hand ${filename} to the app: ${err.message}`);
      });
    },
  };
}());
