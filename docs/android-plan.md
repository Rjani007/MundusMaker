# MundusMaker for Android: plan

Status: first cut built and verified on an Android 16 (API 36) emulator,
2026-10-04. iOS follows on the same design. How to build and test:
`mobile/README.md`; the rules to keep: AGENTS.md → Phone apps.

## Goal

A standalone Android app that is the same MundusMaker: the same worlds,
features, secrecy rules and data folder layout, fully local on the phone or
tablet, with no accounts and no cloud. The desktop app must not change shape
to make this happen, and the Android code lives in its own folder (`mobile/`).

## Decision: run the real server.js inside the app

MundusMaker is one Node server (`server.js`, plain synchronous `fs`, one
`http` server) and a vanilla frontend. Three ways to put that on a phone were
considered:

| Option | Verdict |
| --- | --- |
| Embed a Node runtime (nodejs-mobile) | Rejected. Last release October 2024, still Node 18 (end of life April 2025). Needs the NDK and a native bridge, and adds 30-60 MB per ABI. |
| Rewrite the server in Kotlin/Java (and later Swift) | Rejected. Two or three copies of every data-safety rule (revisions, history, trash, atomic writes, restore transactions) drift apart, and every server feature would have to be ported twice. |
| **Run server.js in the WebView's own JavaScript engine, on a small Node compatibility layer, with a native host for files and HTTP** | **Chosen.** One server codebase, zero third-party code, the system WebView's always-updated V8, and the same layer serves iOS. |

### How it fits together

```
 UI WebView  ── http://localhost:<port>/ (session cookie) ──┐
   index.html (unchanged; the shell adds one <script>)       │
   └─ Web Worker: mobile runtime                             ▼
        Node compatibility layer          ┌────── native host (Java) ──────┐
        (Buffer, fs, path, crypto,        │ HTTP/1.1 server on 127.0.0.1    │
         http, process, timers, require)  │  • static files from the bundle │
        └─ server.js, unchanged ◄─────────┤  • /api, /assets → the worker   │
             fs calls: sync XHR ─────────►│  • file operations (sandboxed)  │
             fetch: proxied ─────────────►│  • outbound fetch for the three │
                                          │    user-started downloads       │
                                          │  • Save / Share for downloads   │
                                          └─────────────────────────────────┘
```

- The WebView loads `http://localhost:<port>/` like a desktop browser, so the
  frontend, `api.js`, `<img src="/assets/...">`, the request guard and the
  revision headers all work unchanged.
- The native host relays `/api/*` and `/assets/*` requests to the worker
  (the worker long-polls for them) and writes the worker's responses back.
- server.js's synchronous `fs` calls become synchronous XHRs from the worker
  to the host's file channel. Only a worker may block like that, which is why
  the server runs in a worker: the UI thread never waits on the disk.
- The worker talks to the host at `127.0.0.1` while the page uses
  `localhost`. They are separate connection groups, so the page's six
  connections can never starve the worker's file calls (that would deadlock).
- Static files come straight from the extracted bundle; only API and asset
  requests take the relay.

The wire protocol is in `mobile/shared/PROTOCOL.md`. Each native shell
(Android now, iOS next) implements it; the runtime is shared.

### Security on a phone

Android sandboxes apps from each other, but any app may connect to a
`127.0.0.1` port. So the host requires a per-launch random session cookie on
every page request (set in the WebView's own cookie store) and a separate
random key on the worker's channel. Other apps and other browsers on the
device get 403. The file channel only reaches the app's own bundle (read
only), data, config and cache folders. server.js's own request guard still
runs on everything relayed to it.

## Changes to the shared app (small, generic)

- `server.js`: a `mobile` deployment (from `MUNDUSMAKER_DEPLOYMENT=mobile`,
  set only by the runtime), shaped like the container mode. `/api/status`
  reports it, and Quit, auto-stop, the data-folder move, folder backups and
  the old-install scan say plainly why they are off.
- Frontend: Settings, the top bar and the Import page hide the desktop-only
  pieces for `deployment: 'mobile'`; `downloadBlob` hands files to the shell
  (`window.mundusShell.save`) because a WebView cannot follow `blob:`
  downloads; pending saves flush when the page is hidden (useful on desktop
  too, and the moment Android may freeze or kill the app).
- A phone-width layout: an off-canvas sidebar drawer, a scrolling nav strip
  and full-width pages below 700 px. Narrow desktop windows benefit as well.

## The Android shell (`mobile/android/`)

- Java, minSdk 26, targetSdk 36, **no AndroidX, no Kotlin stdlib, no
  third-party libraries**: the APK holds our classes, the bundle and icons.
  Gradle/AGP are build tools only.
- `MainActivity`: the WebView (edge-to-edge insets, back navigation, JS
  dialogs, file chooser for imports and portraits, Save/Share sheet for
  downloads, renderer-crash recovery, external links open in the browser).
- `HostServer`: the HTTP server, the relay and the shell routes.
- `FsHost`: file operations on `android.system.Os`, so errors carry the same
  POSIX codes (`ENOENT`, `EEXIST`...) server.js already expects from Node.
- `BundleInstaller`: unpacks the app bundle (public/, server.js, the server
  scripts, sample/, the runtime) on first launch and after each update.
- Storage: the data folder is `files/data` (internal, private). Moving worlds
  between devices uses the existing JSON backups: Settings → Back up on one
  device, Import → Restore on the other. Cloud backup is off; device-to-device
  transfer is allowed; the uninstaller offers to keep the data
  (`hasFragileUserData`).
- The Gradle build stages the bundle with `mobile/scripts/stage-bundle.js`,
  which reuses `scripts/package.js`'s `APP_FILES`, so Android ships exactly
  what the desktop download ships (minus launchers and Docker files).

## Verification

1. `tests/mobile-runtime.test.js` (in `npm test`): boots the real server.js
   inside the compatibility layer with the reference file host, then checks
   status, seeding, entity saves with revisions and conflicts, history,
   assets, backups and restore.
2. `mobile/shared/devhost.js`: a Node implementation of the host protocol, so
   the whole mobile stack runs in any desktop browser.
   `node mobile/scripts/runtime-check.js` drives it in headless Edge (real
   Chromium, as on Android).
3. The APK in the Android emulator, driven over the WebView's DevTools
   protocol (debug builds): boot, sample world, edit and save, upload,
   backup download, reload persistence.
4. The desktop gates still pass: `npm test`, `npm run test:render`.

### What was verified (2026-10-04)

- `npm test` (158, then the added mobile tests), `npm run test:render` (60/60),
  `npm run test:wiki`, `node mobile/scripts/runtime-check.js` in headless Edge.
- On the emulator (Pixel 7 profile, API 36, WebView 133), with
  `android-check.js`: first start from a fresh install, the sample world, a
  save with its revision and a stale one refused, the file on the device, an
  uploaded image, Save → native Save / Share dialog, Back closing the drawer,
  a reload and a full restart keeping edits and browser storage (same origin),
  and 403 for another app calling the API, the file channel or the page.
- By hand on the emulator: Save to device through the system picker (the file
  landed in Downloads), Share sheet, and a full restore: the file picker, the
  typed-name prompt, the pre-restore snapshot and the restored entry.
- Found and fixed on the way: Android relaunches the activity when the WebView
  provider loads (now survived without a reload); a reload could hand the new
  page's first request to the dead worker (polls now check their connection,
  and reads are replayed); one round trip per file made listing slow (folder
  read-ahead: 26 entries went from about 430 ms to about 130 ms on the
  emulator).

## Later (not in the first cut)

- Folder sync through the Storage Access Framework (Syncthing, Drive).
- iOS: a Swift host implementing PROTOCOL.md (WKWebView, Network.framework
  listener); the runtime and frontend are reused as they are.
- Play Store release: signing config, AAB, store listing.
