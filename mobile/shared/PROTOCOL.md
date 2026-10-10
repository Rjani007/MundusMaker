# Mobile host protocol

The phone apps run MundusMaker's own `server.js` inside the WebView, in a Web
Worker, on the Node compatibility layer in `runtime/node.js`. A small native
host gives that worker what a browser cannot: files, an HTTP front door and
outbound requests. Android (`mobile/android`) implements this document in
Java; `devhost.js` is the reference implementation in Node, and iOS will be a
third. Change all of them together.

## One HTTP server, two names

The host listens on `127.0.0.1:<port>` (loopback only) and answers under two
host names. Any other `Host` header gets 403.

| Address | Who uses it | Authentication |
| --- | --- | --- |
| `http://localhost:<port>` | the app page in the WebView | cookie `mm_session=<session token>` on every request |
| `http://127.0.0.1:<port>` | the runtime worker only, paths `/__host/*` | query parameter `k=<host key>` on every request |

Both secrets are random per launch (at least 128 bits) and are compared in
constant time. Other apps on the device can connect to the port, so nothing
is served without them. The page never sees the host key: the worker reads it
from `/__shell/config.js`, which needs the session cookie and is refused to any
request whose `Sec-Fetch-Site` is present and not `same-origin` (another site's
`<script>` tag must never get it). A `/__host/*` request that carries an
`Origin` other than `http://localhost:<port>` is refused too.

The host decides who is asking from the request line and headers alone, before
it reads a byte of the body. Unauthenticated requests are answered 403 and the
connection closed. Bodies are capped per route: 256 MB for relayed requests,
`/__shell/save`, `fs` and `respond`; 1 MB for `fetch` and `log`; 64 KB for the
rest. Connections that send nothing for 5 minutes are closed, and the number of
connections is bounded.

The worker uses `127.0.0.1` on purpose. Browsers allow six connections per
host name; with the page's requests waiting on the worker and the worker's
file calls queued behind them on the same name, the two would deadlock.
Cross-origin answers on `127.0.0.1` carry
`Access-Control-Allow-Origin: http://localhost:<port>`. The worker only sends
CORS-simple requests (GET, or POST with no custom headers), so there are no
preflights; `OPTIONS` is still answered for safety.

Ports: the host prefers the port it used last time, so the page origin (and
with it the browser storage that keeps the active world, the GM toggle and
onboarding) stays the same between launches. It falls back to another port
only when that one is taken.

## Page routes (`localhost`)

- `GET /` and every other `GET` outside the routes below: a file from the
  bundle's `public/` folder, with the same MIME types as server.js
  (`serveStatic`) and `Cache-Control: no-cache`. `/` is `index.html`, into
  which the host inserts `<script src="/__shell/boot.js"></script>` right
  after `<head>`. Paths are normalised and may not leave `public/` (403);
  missing files are 404.
- `/api/*` (any method), `/assets/*` (any method), and any request that is
  not `GET`/`HEAD` outside `/__shell/`: relayed to the runtime, see below.
- `GET /__shell/boot.js`, `GET /__shell/runtime/<file>`: the shared runtime
  files from the bundle's `runtime/` folder.
- `GET /__shell/config.js`: JavaScript that sets
  `self.MUNDUS_HOST = { channel, key, appRoot, dataDir, configDir, tmpDir,
  platform, version, pid }`. `channel` is `http://127.0.0.1:<port>`; the
  folders are absolute paths on the device.
- `POST /__shell/save?name=<file name>`: the body is a file the page wants to
  save (a backup, a PDF, a ZIP). The host offers Save and Share and answers
  `{"ok":true}` at once; the page does not wait for the choice. The
  `Content-Type` header is the file's type. A file that arrives while no
  window is attached (the app is being relaunched) is offered as soon as one
  is.

## Relaying page requests to the runtime

The host gives every relayed request an id and queues it. The worker pulls:

- `GET /__host/next?k=…` waits up to 25 s for a request. It answers 204 when
  nothing came, or 200 with a frame: the request's meta, then its body.
  Meta: `{ "id": "17", "method": "PUT", "url": "/api/w/x/entities/y",
  "headers": [["host","localhost:4870"], ["content-type","application/json"],
  …] }`. Header names are lower-case; repeats are separate pairs.
- `POST /__host/respond?k=…&id=17` with a frame: meta `{ "status": 200,
  "headers": [["content-type","application/json; charset=utf-8"], …] }`, then
  the response body. The host writes it to the waiting connection with its
  own `Content-Length` and `Connection` headers, and no body for `HEAD`.
  Answers `{}`.
- `POST /__host/hello?k=…` is the worker's first call after it starts. An
  earlier worker is gone (for example after a reload), so whatever it held is
  settled: `GET` and `HEAD` requests are queued again for the new worker, and
  any other request fails with 503, because a write may have half-happened.
  Queued requests are kept for the new worker.
- A long-poll checks that its worker is still connected before handing out a
  request, and puts the request back otherwise (a reload can leave the old
  worker's poll parked on a dead connection). Handing out and `hello` are
  serialised, so a request never goes to a worker that has been replaced.

The host answers 503 with a JSON `{ "error": … }` when a request has waited
20 s and no worker has called the host for 20 s. Any authenticated
`/__host/*` call counts, because a long bootstrap or restore makes file calls
without polling, and the host's own start counts as one. It answers 504 when a
handed-out request gets no answer within 15 minutes (the Library download is
the slowest legitimate request). Requests wait while the runtime starts; the
first page load needs no retry logic.

## Frames

A frame is UTF-8 JSON (no raw newlines), one `\n` byte, then raw bytes:

    {"status":200,"headers":[["content-type","text/plain"]]}\n<body bytes>

## File operations

`POST /__host/fs?k=…&op=<op>` with a frame: the arguments as meta, then the
data bytes for `write`. Sent as a synchronous XHR from the worker, which is
how server.js keeps its synchronous `fs` calls.

Success is 200: raw file bytes for `read`, JSON for every other op. Failure is
a 4xx/5xx with `{ "code": "ENOENT", "message": "no such file or directory" }`.
Codes are POSIX errno names as Node reports them (`ENOENT`, `EEXIST`,
`ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EACCES`, `EROFS`, `EXDEV`, `EIO`…).

Every path must be an absolute POSIX path (no `\`, no NUL byte), contain no
`..` segment after normalisation, and lie inside one of the roots the host
owns: the app bundle (read-only, writes fail with `EROFS`), the data folder,
the config folder or the temporary folder. Anything else fails with `EACCES`.
`rename`, `rm`, `rmdir` and `unlink` may not touch a root folder itself
(`EACCES`).

| op | arguments | result |
| --- | --- | --- |
| `stat` | `path`, `follow` (true = stat, false = lstat), `quiet` | `{ type, size, mtimeMs, ctimeMs, atimeMs, birthtimeMs, mode }`, type `file`, `dir`, `symlink` or `other`; with `quiet`, a missing path is `null` instead of `ENOENT` |
| `readdir` | `path` | `{ entries: [{ name, type, size, mtimeMs }] }` sorted by the names' UTF-8 bytes (types as for lstat) |
| `read` | `path` | the bytes |
| `readmany` | `paths` (at most 4096) | `{ sizes }`, a newline, then each file's bytes back to back; a file that cannot be read is size -1 (the runtime then reads it alone and reports why) |
| `write` | `path`, `flag` (`w` truncate, `wx` create only, `a` append), `fsync` + data | `{}` (creates the file; the folder must exist) |
| `mkdir` | `path`, `recursive` | `{ first }`: the first folder created, or null |
| `rename` | `from`, `to` | `{}`: POSIX `rename(2)`, replacing a file at `to` |
| `rm` | `path`, `recursive`, `force` | `{}`: Node's `rmSync`; never follows symbolic links |
| `rmdir` | `path` | `{}` (empty folders only) |
| `unlink` | `path` | `{}` (files and links only) |
| `copy` | `from`, `to`, `excl` | `{}`: copies a file's bytes, replacing `to` unless `excl` |
| `mkdtemp` | `prefix` | `{ path }`: the prefix plus six random characters, created. As in Node, `dir/` makes a folder inside `dir`; otherwise the characters extend the last name. The folder must land inside a root |
| `realpath` | `path` | `{ path }` |

## Outbound requests

`POST /__host/fetch?k=…` with a frame: meta `{ url, method, headers,
redirect, timeoutMs }`, then the request body. Only `https:` URLs. With
`redirect: "manual"` the host returns 3xx answers as they are (with their
`location`), which server.js needs to check where a download is sent; with
`"follow"` it follows up to five redirects. The answer is a frame: meta
`{ status, statusText, url, headers }` (the final URL), then the body, at most
64 MB. Network failures are 502 with `{ code, message }`.

server.js asks for these only when the GM presses a button (Check for
updates, the Library downloader, Get it from… for an official sheet), exactly
as on the desktop.

## Logs and exit

- `POST /__host/log?k=…`, body: UTF-8 lines, each `level text`. The host
  writes them to the platform log (Android: logcat tag `MundusMaker`).
- `POST /__host/exit?k=…&code=<n>`: server.js called `process.exit`. The host
  restarts the runtime by reloading the page, unless that keeps happening
  (three times in a minute), when it shows what went wrong instead.
