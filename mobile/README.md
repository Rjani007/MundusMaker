# MundusMaker on phones and tablets

This folder holds the mobile apps. Android is here now; iOS comes next on the
same design. They are the same MundusMaker as the desktop download: the same
`public/` frontend and the same `server.js`, with the same worlds, secrets and
data folder layout. Everything stays on the device.

```
mobile/
  shared/
    PROTOCOL.md      the contract between the runtime and a native host
    runtime/         node.js (the Node compatibility layer), worker.js (runs
                     server.js in a Web Worker), boot.js (loaded by the page)
    fsops.js         reference file operations (Node)
    devhost.js       reference host: the whole mobile stack in a desktop browser
  android/           the Android app (Java, no libraries)
  scripts/
    stage-bundle.js  packs the shared app + runtime into the APK's bundle.zip
    runtime-check.js the runtime in headless Edge/Chrome
    android-check.js the app on a device or emulator
```

The design and the reasons behind it are in `docs/android-plan.md`.

## How it works

server.js is plain synchronous Node. A WebView has no Node, so
`runtime/node.js` supplies the parts server.js uses (Buffer, fs, path, crypto,
http, process, timers, a CommonJS loader). They run in a Web Worker started by
`boot.js`. File calls become synchronous XHRs to the native host, and only a
worker may make those, so the page never waits on the disk. The host is a small
HTTP server on `127.0.0.1`. It serves the page and static files, relays every
`/api` and `/assets` request to the worker, and does the file operations and the
three outbound downloads the GM can start. The page loads
`http://localhost:<port>/` exactly as a desktop browser would, so the frontend
needs no special paths.

Other apps can reach a loopback port, so nothing is served without the
per-launch session cookie (page) or host key (worker). See PROTOCOL.md.

## Building the Android app

You need JDK 17 or newer, the Android SDK (platform 36, build-tools 36) and
Node (the build stages the shared app with it). Gradle comes through the
wrapper.

1. Point the build at your SDK. Either set `ANDROID_HOME`, or create
   `mobile/android/local.properties` with `sdk.dir=D:/Android/sdk` (forward
   slashes; the file is git-ignored).
2. Build from `mobile/android`:

   ```
   ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
   ./gradlew assembleRelease      # unsigned; sign it with your own key
   ./gradlew bundleRelease        # an AAB for Google Play
   ```

Every build re-stages `public/`, `server.js`, the server scripts, `sample/` and
the runtime from the repository (`stageBundle`). Nothing is copied into this
folder by hand. The staged file list is the desktop download's `APP_FILES`
minus the launchers and Docker files. The app unpacks the bundle on first start
and again only when its checksum changes.

The APK contains no third-party code. AGP 9 would add the Kotlin standard
library on its own; `android.builtInKotlin=false` in `gradle.properties` stops
that.

Release signing is deliberately not configured. Create your own upload key and
add a `signingConfigs` block (or sign with `apksigner`). Keep the key out of the
repository; `*.jks` and `*.keystore` are git-ignored.

## Testing

```
npm run test:mobile          # runtime tests (in npm test too) + the runtime in headless Chromium
npm run android:check -- --install mobile/android/app/build/outputs/apk/debug/app-debug.apk --fresh
node mobile/shared/devhost.js [dataDir]   # use the mobile stack in your own browser
```

- `tests/mobile-runtime.test.js` boots the real server.js on the compatibility
  layer, with the reference file host, and drives the API. A server change that
  needs a Node feature the layer lacks fails here, in `npm test`.
- `runtime-check.js` runs the worker, the relay and the synchronous file calls
  in real Chromium, the engine the Android WebView uses.
- `android-check.js` drives the installed debug app over the WebView's DevTools
  protocol. It checks saves and revisions, data on the device, images, the
  renderer's memory over many requests, typing into a long text block, Save
  and Share, Back, reload and restart persistence, and that other apps get
  403. It needs `adb`: set `ADB` or `ANDROID_HOME`, or have it on `PATH`.

The emulator renders in software unless told otherwise, which makes its own
System UI time out and steal key presses from the app. Start it with
`-gpu host`.

An emulator with a hardware keyboard (the default Pixel profiles) never shows
the on-screen keyboard, so typing there is nothing like typing on a phone. Turn
it on before testing anything you type into:

```
adb shell settings put secure show_ime_with_hard_keyboard 1
```

## On the device

- Worlds live in the app's private storage (`files/data`, a normal MundusMaker
  data folder). To move a world between a computer and the device, use
  Settings → Download backup on one, then Import → Restore a backup on the
  other.
- Cloud backup is off. MundusMaker sends nothing to any cloud on its own, and
  Android's backup would upload the worlds to Google. Moving to a new phone by
  cable or Quick Share (device-to-device transfer) still carries them. The
  uninstaller offers to keep the data.
- Downloads (backups, PDFs, wiki ZIPs, map PNGs) open a Save / Share dialog.
- Quit, auto-stop, the data-folder move, second-folder backups and the
  old-install scan are desktop tools. On the device they are hidden or explain
  why they are off (`deployment: 'mobile'` in `/api/status`).

## Not yet

- Folder sync through the Storage Access Framework (Syncthing, Drive folders).
- iOS: a Swift host implementing PROTOCOL.md (WKWebView plus a loopback
  listener). The runtime and frontend are reused unchanged.
- Store listing, signing and release automation.
