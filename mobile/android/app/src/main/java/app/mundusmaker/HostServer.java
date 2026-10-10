package app.mundusmaker;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

/**
 * The native half of mobile/shared/PROTOCOL.md: one HTTP/1.1 server on
 * 127.0.0.1 that serves the app page (localhost, session cookie), relays its
 * API and asset requests to the runtime worker, and gives that worker files
 * and outbound requests (127.0.0.1, host key). mobile/shared/devhost.js is the
 * reference implementation; keep the two in step.
 */
final class HostServer {
    interface Shell {
        /** The page asked to save a file (a backup, a PDF...). Called off the UI thread. */
        void onSave(File file, String name, String mimeType);
        /** server.js called process.exit. Called off the UI thread. */
        void onRuntimeExit(int code);
    }

    static final String TAG = "MundusMaker";
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final long MAX_BODY_BYTES = 256L * 1024 * 1024;
    private static final long POLL_WAIT_MS = 25_000;
    private static final long NO_WORKER_MS = 20_000;
    private static final long ANSWER_MS = 15 * 60_000;
    private static final int IDLE_MS = 5 * 60_000; // a connection that sends nothing for this long is closed
    private static final int MAX_CONNECTIONS = 96; // the WebView uses a dozen or so
    private static final byte[] EMPTY = new byte[0];
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        // server.js's table, plus .txt so a linked licence file shows instead of downloading
        MIME.put(".html", "text/html; charset=utf-8");
        MIME.put(".js", "text/javascript; charset=utf-8");
        MIME.put(".mjs", "text/javascript; charset=utf-8");
        MIME.put(".css", "text/css; charset=utf-8");
        MIME.put(".json", "application/json; charset=utf-8");
        MIME.put(".png", "image/png");
        MIME.put(".jpg", "image/jpeg");
        MIME.put(".jpeg", "image/jpeg");
        MIME.put(".webp", "image/webp");
        MIME.put(".gif", "image/gif");
        MIME.put(".svg", "image/svg+xml");
        MIME.put(".ico", "image/x-icon");
        MIME.put(".webmanifest", "application/manifest+json");
        MIME.put(".woff2", "font/woff2");
        MIME.put(".txt", "text/plain; charset=utf-8");
    }

    final File bundleDir;
    final File dataDir;
    final File configDir;
    final File tmpDir;
    final File savesDir;
    final String sessionToken = randomHex(24);
    private final String hostKey = randomHex(24);
    private final String versionName;
    private final FsHost fs;
    private final Outbound outbound = new Outbound();
    private final Relay relay = new Relay();
    private final AtomicInteger saveCount = new AtomicInteger();
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(0, MAX_CONNECTIONS, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> {
        Thread t = new Thread(r, "mundus-http");
        t.setDaemon(true);
        return t;
    });
    private volatile Shell shell;
    /** Saves that arrived while no activity was attached (a relaunch); offered once one is. */
    private final List<Object[]> waitingSaves = new ArrayList<>();
    private ServerSocket server;
    private volatile int port;

    HostServer(File bundleDir, File dataDir, File configDir, File tmpDir, File savesDir, String versionName) {
        this.bundleDir = bundleDir;
        this.dataDir = dataDir;
        this.configDir = configDir;
        this.tmpDir = tmpDir;
        this.savesDir = savesDir;
        this.versionName = versionName;
        this.fs = new FsHost(bundleDir.getAbsolutePath(), new String[] {
                dataDir.getAbsolutePath(), configDir.getAbsolutePath(), tmpDir.getAbsolutePath() });
    }

    void setShell(Shell shell) {
        List<Object[]> waiting;
        synchronized (waitingSaves) {
            this.shell = shell;
            if (shell == null || waitingSaves.isEmpty()) return;
            waiting = new ArrayList<>(waitingSaves);
            waitingSaves.clear();
        }
        for (Object[] save : waiting) shell.onSave((File) save[0], (String) save[1], (String) save[2]);
    }

    int port() { return port; }

    /**
     * Listen on the port used last time when it is free, so the page origin
     * (and the browser storage tied to it) stays the same; otherwise on any port.
     */
    synchronized int start(int preferredPort) throws IOException {
        if (server != null) return port;
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        try {
            socket.bind(new InetSocketAddress(loopback, preferredPort), 64);
        } catch (IOException taken) {
            socket.close();
            socket = new ServerSocket();
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(loopback, 0), 64);
        }
        server = socket;
        port = socket.getLocalPort();
        final ServerSocket listening = socket;
        Thread accept = new Thread(() -> acceptLoop(listening), "mundus-accept");
        accept.setDaemon(true);
        accept.start();
        Log.i(TAG, "host listening on 127.0.0.1:" + port);
        return port;
    }

    private void acceptLoop(ServerSocket socket) {
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                client.setTcpNoDelay(true);
                client.setSoTimeout(IDLE_MS);
                try {
                    pool.execute(() -> serve(client));
                } catch (RejectedExecutionException busy) {
                    client.close(); // more connections than any page makes: not ours to serve
                }
            } catch (IOException e) {
                if (!socket.isClosed()) Log.w(TAG, "accept failed", e);
            }
        }
    }

    // ---------- HTTP/1.1 ----------

    static final class Request {
        String method;
        String target;
        String path;
        String query = "";
        final List<String[]> headers = new ArrayList<>();
        final Map<String, String> lookup = new HashMap<>();
        byte[] body = EMPTY;
        boolean keepAlive = true;

        String header(String name) { return lookup.get(name); }

        String param(String name) {
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                String key = eq < 0 ? pair : pair.substring(0, eq);
                if (key.equals(name)) return percentDecode(eq < 0 ? "" : pair.substring(eq + 1), true);
            }
            return null;
        }
    }

    static final class HttpError extends IOException {
        final int status;
        HttpError(int status, String message) { super(message); this.status = status; }
    }

    private void serve(Socket client) {
        try (Socket socket = client) {
            InputStream in = new BufferedInputStream(socket.getInputStream(), 16 * 1024);
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 16 * 1024);
            while (true) {
                Request req;
                try {
                    req = readHead(in);
                    if (req == null) return;
                    // who is asking is settled before a single body byte is read
                    readBody(in, req, admit(req));
                } catch (HttpError e) {
                    respond(out, e.status, textHeaders(), e.getMessage().getBytes(StandardCharsets.UTF_8), false, false);
                    out.flush();
                    return; // the body, if any, was never read: this connection is done
                }
                try {
                    handle(req, out, () -> !peerClosed(socket, in));
                } catch (HttpError e) {
                    respond(out, e.status, textHeaders(), e.getMessage().getBytes(StandardCharsets.UTF_8), "HEAD".equals(req.method), req.keepAlive);
                }
                out.flush();
                if (!req.keepAlive) return;
            }
        } catch (SocketException | EOFException closed) {
            // the WebView closed the connection
        } catch (IOException e) {
            Log.w(TAG, "connection failed: " + e);
        } catch (RuntimeException e) {
            Log.e(TAG, "request crashed", e);
        }
    }

    /**
     * Whether the client hung up. A worker waiting on a long-poll sends nothing
     * more on its connection, so a read that ends the stream means it is gone
     * (the page reloaded); one that merely times out means it is still there.
     */
    private static boolean peerClosed(Socket socket, InputStream in) {
        try {
            int timeout = socket.getSoTimeout();
            socket.setSoTimeout(1);
            try {
                in.mark(1);
                if (in.read() == -1) return true;
                in.reset();
                return false;
            } finally {
                socket.setSoTimeout(timeout);
            }
        } catch (SocketTimeoutException alive) {
            return false;
        } catch (IOException gone) {
            return true;
        }
    }

    private static String readLine(InputStream in, int[] budget) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(128);
        int b;
        boolean any = false;
        while ((b = in.read()) != -1) {
            any = true;
            if (--budget[0] < 0) throw new HttpError(431, "request headers too large");
            if (b == '\n') break;
            if (b != '\r') line.write(b);
        }
        if (!any) return null;
        return new String(line.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static Request readHead(InputStream in) throws IOException {
        int[] budget = { MAX_HEADER_BYTES };
        String start;
        do {
            start = readLine(in, budget);
            if (start == null) return null;
        } while (start.isEmpty());
        String[] parts = start.split(" ");
        if (parts.length != 3 || !parts[2].startsWith("HTTP/1.")) throw new HttpError(400, "bad request line");
        Request req = new Request();
        req.method = parts[0].toUpperCase(Locale.ROOT);
        req.target = parts[1];
        int q = req.target.indexOf('?');
        req.path = q < 0 ? req.target : req.target.substring(0, q);
        if (q >= 0) req.query = req.target.substring(q + 1);
        String line;
        while ((line = readLine(in, budget)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon <= 0) throw new HttpError(400, "bad header");
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            req.headers.add(new String[] { name, value });
            String seen = req.lookup.get(name);
            req.lookup.put(name, seen == null ? value : seen + ", " + value);
        }
        String connection = req.header("connection");
        req.keepAlive = parts[2].equals("HTTP/1.1")
                ? connection == null || !connection.toLowerCase(Locale.ROOT).contains("close")
                : connection != null && connection.toLowerCase(Locale.ROOT).contains("keep-alive");
        return req;
    }

    /**
     * Who may ask, and the largest body each route takes. Other apps can reach
     * this port, so the page needs its session cookie and the worker its key
     * (from its own origin) before anything else happens.
     */
    private long admit(Request req) throws HttpError {
        String host = req.header("host") == null ? "" : req.header("host").toLowerCase(Locale.ROOT);
        if (host.equals("127.0.0.1:" + port) && req.path.startsWith("/__host/")) {
            if (req.method.equals("OPTIONS")) return 0;
            if (!same(req.param("k"), hostKey)) throw new HttpError(403, "forbidden");
            String origin = req.header("origin");
            if (origin != null && !origin.equals("http://localhost:" + port)) throw new HttpError(403, "forbidden");
            relay.lastPoll = System.currentTimeMillis(); // a worker that calls at all is alive
            String route = req.path.substring("/__host/".length());
            if (route.equals("fs") || route.equals("respond")) return MAX_BODY_BYTES;
            return route.equals("fetch") || route.equals("log") ? 1024 * 1024 : 64 * 1024;
        }
        if (!host.equals("localhost:" + port)) throw new HttpError(403, "MundusMaker answers only at its own address.");
        if (!same(cookie(req, "mm_session"), sessionToken)) throw new HttpError(403, "Open MundusMaker from its app icon.");
        return MAX_BODY_BYTES; // backups and uploads; server.js applies its own per-route limits
    }

    private static void readBody(InputStream in, Request req, long cap) throws IOException {
        String chunked = req.header("transfer-encoding");
        try {
            if (chunked != null && chunked.toLowerCase(Locale.ROOT).contains("chunked")) {
                req.body = readChunked(in, cap);
            } else if (req.header("content-length") != null) {
                long length;
                try { length = Long.parseLong(req.header("content-length")); } catch (NumberFormatException e) { throw new HttpError(400, "bad content-length"); }
                if (length < 0) throw new HttpError(400, "bad content-length");
                if (length > cap) throw new HttpError(413, "request too large");
                req.body = readFully(in, (int) length);
            }
        } catch (OutOfMemoryError e) {
            throw new HttpError(413, "That is too large for this device's memory.");
        }
    }

    private static byte[] readFully(InputStream in, int length) throws IOException {
        byte[] body = new byte[length];
        int off = 0;
        while (off < length) {
            int n = in.read(body, off, length - off);
            if (n < 0) throw new EOFException("body cut short");
            off += n;
        }
        return body;
    }

    private static byte[] readChunked(InputStream in, long cap) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        int[] budget = { MAX_HEADER_BYTES };
        while (true) {
            String sizeLine = readLine(in, budget);
            if (sizeLine == null) throw new EOFException("chunk cut short");
            int semi = sizeLine.indexOf(';');
            int size = Integer.parseInt((semi < 0 ? sizeLine : sizeLine.substring(0, semi)).trim(), 16);
            if (size == 0) {
                String trailer;
                while ((trailer = readLine(in, budget)) != null && !trailer.isEmpty()) { /* skip trailers */ }
                return body.toByteArray();
            }
            if (body.size() + (long) size > cap) throw new HttpError(413, "request too large");
            body.write(readFully(in, size));
            readLine(in, budget);
        }
    }

    private static List<String[]> textHeaders() {
        List<String[]> h = new ArrayList<>();
        h.add(new String[] { "Content-Type", "text/plain; charset=utf-8" });
        return h;
    }

    private static void respond(OutputStream out, int status, List<String[]> headers, byte[] body, boolean head, boolean keepAlive) throws IOException {
        writeHead(out, status, headers, body.length, keepAlive);
        if (!head) out.write(body);
    }

    private static void writeHead(OutputStream out, int status, List<String[]> headers, long length, boolean keepAlive) throws IOException {
        StringBuilder sb = new StringBuilder(256);
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        for (String[] h : headers) {
            String name = h[0].toLowerCase(Locale.ROOT);
            if (name.equals("content-length") || name.equals("connection") || name.equals("transfer-encoding") || name.equals("keep-alive")) continue;
            // a header value may not break the response apart
            sb.append(h[0]).append(": ").append(h[1].replace('\r', ' ').replace('\n', ' ')).append("\r\n");
        }
        sb.append("Content-Length: ").append(length).append("\r\n");
        sb.append("Connection: ").append(keepAlive ? "keep-alive" : "close").append("\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 302: return "Found";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            case 415: return "Unsupported Media Type";
            case 428: return "Precondition Required";
            case 431: return "Request Header Fields Too Large";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            case 504: return "Gateway Timeout";
            default: return "Status";
        }
    }

    // ---------- routing ----------

    private void handle(Request req, OutputStream out, BooleanSupplier clientAlive) throws IOException {
        String host = req.header("host") == null ? "" : req.header("host").toLowerCase(Locale.ROOT);
        if (host.equals("127.0.0.1:" + port) && req.path.startsWith("/__host/")) {
            hostRoute(req, out, clientAlive);
            return;
        }
        if (!host.equals("localhost:" + port)) throw new HttpError(403, "MundusMaker answers only at its own address.");
        if (!same(cookie(req, "mm_session"), sessionToken)) throw new HttpError(403, "Open MundusMaker from its app icon.");
        String path;
        try {
            path = percentDecode(req.path, false);
        } catch (IllegalArgumentException e) {
            throw new HttpError(400, "That address is not valid.");
        }
        if (path.startsWith("/__shell/")) {
            shellRoute(req, path, out);
        } else if (path.startsWith("/api/") || path.startsWith("/assets/") || !(req.method.equals("GET") || req.method.equals("HEAD"))) {
            relay(req, out);
        } else {
            staticFile(req, path, out);
        }
    }

    private static String cookie(Request req, String name) {
        String header = req.header("cookie");
        if (header == null) return null;
        for (String part : header.split(";")) {
            String p = part.trim();
            if (p.startsWith(name + "=")) return p.substring(name.length() + 1);
        }
        return null;
    }

    private static boolean same(String given, String expected) {
        return given != null && MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8));
    }

    private void staticFile(Request req, String path, OutputStream out) throws IOException {
        File publicDir = new File(bundleDir, "public");
        String rel = path.equals("/") ? "/index.html" : path;
        if (rel.indexOf('\0') >= 0) throw new HttpError(400, "bad path");
        File file = new File(publicDir, rel);
        String base = publicDir.getCanonicalPath() + File.separator;
        if (!file.getCanonicalPath().startsWith(base)) throw new HttpError(403, "forbidden");
        if (!file.isFile()) throw new HttpError(404, "not found");
        List<String[]> headers = new ArrayList<>();
        headers.add(new String[] { "Content-Type", mimeOf(file.getName()) });
        headers.add(new String[] { "Cache-Control", "no-cache" });
        headers.add(new String[] { "X-Content-Type-Options", "nosniff" });
        boolean head = req.method.equals("HEAD");
        if (file.getName().equals("index.html") && file.getParentFile().getCanonicalPath().equals(publicDir.getCanonicalPath())) {
            byte[] html = injectBoot(new String(readFile(file), StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8);
            respond(out, 200, headers, html, head, req.keepAlive);
            return;
        }
        writeHead(out, 200, headers, file.length(), req.keepAlive);
        if (head) return;
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    static String injectBoot(String html) {
        String tag = "<script src=\"/__shell/boot.js\"></script>";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("<head[^>]*>", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
        if (!m.find()) return tag + html;
        return html.substring(0, m.end()) + "\n" + tag + html.substring(m.end());
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String type = dot < 0 ? null : MIME.get(name.substring(dot).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    private void shellRoute(Request req, String path, OutputStream out) throws IOException {
        if (path.equals("/__shell/config.js")) {
            // it holds the host key: for the app's own worker, never another site's <script>
            String site = req.header("sec-fetch-site");
            if (site != null && !site.equals("same-origin")) throw new HttpError(403, "forbidden");
            JSONObject config = new JSONObject();
            try {
                config.put("channel", "http://127.0.0.1:" + port);
                config.put("key", hostKey);
                config.put("appRoot", bundleDir.getAbsolutePath());
                config.put("dataDir", dataDir.getAbsolutePath());
                config.put("configDir", configDir.getAbsolutePath());
                config.put("tmpDir", tmpDir.getAbsolutePath());
                config.put("platform", "android");
                config.put("version", versionName);
                config.put("pid", android.os.Process.myPid());
            } catch (JSONException e) {
                throw new IOException(e);
            }
            List<String[]> headers = new ArrayList<>();
            headers.add(new String[] { "Content-Type", "text/javascript; charset=utf-8" });
            headers.add(new String[] { "Cache-Control", "no-store" });
            respond(out, 200, headers, ("self.MUNDUS_HOST = " + config + ";\n").getBytes(StandardCharsets.UTF_8), req.method.equals("HEAD"), req.keepAlive);
            return;
        }
        if (path.equals("/__shell/boot.js") || path.startsWith("/__shell/runtime/")) {
            String name = path.equals("/__shell/boot.js") ? "boot.js" : path.substring("/__shell/runtime/".length());
            File file = new File(new File(bundleDir, "runtime"), name);
            if (!name.matches("[a-z0-9-]+\\.js") || !file.isFile()) throw new HttpError(404, "not found");
            List<String[]> headers = new ArrayList<>();
            headers.add(new String[] { "Content-Type", "text/javascript; charset=utf-8" });
            headers.add(new String[] { "Cache-Control", "no-cache" });
            respond(out, 200, headers, readFile(file), req.method.equals("HEAD"), req.keepAlive);
            return;
        }
        if (path.equals("/__shell/save") && req.method.equals("POST")) {
            String origin = req.header("origin");
            if (origin != null && !origin.equals("http://localhost:" + port)) throw new HttpError(403, "forbidden");
            String name = safeFileName(req.param("name"));
            String type = req.header("content-type") == null ? "application/octet-stream" : req.header("content-type").split(";")[0].trim();
            if (!savesDir.isDirectory() && !savesDir.mkdirs()) throw new IOException("cannot create " + savesDir);
            File dir = new File(savesDir, String.valueOf(saveCount.incrementAndGet()));
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            File file = new File(dir, name);
            try (OutputStream fileOut = new FileOutputStream(file)) {
                fileOut.write(req.body);
            }
            Shell s;
            synchronized (waitingSaves) {
                s = shell;
                if (s == null) waitingSaves.add(new Object[] { file, name, type });
            }
            if (s != null) s.onSave(file, name, type);
            respondJson(out, 200, "{\"ok\":true}", null, req.keepAlive);
            return;
        }
        throw new HttpError(404, "not found");
    }

    static String safeFileName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", "_").replaceAll("^\\.+", "");
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n.isEmpty() ? "download" : n;
    }

    private void respondJson(OutputStream out, int status, String json, String cors, boolean keepAlive) throws IOException {
        List<String[]> headers = new ArrayList<>();
        headers.add(new String[] { "Content-Type", "application/json; charset=utf-8" });
        headers.add(new String[] { "Cache-Control", "no-store" });
        if (cors != null) headers.add(new String[] { "Access-Control-Allow-Origin", cors });
        respond(out, status, headers, json.getBytes(StandardCharsets.UTF_8), false, keepAlive);
    }

    // ---------- the relay ----------

    private static final class Pending {
        final String id;
        final byte[] frame;
        final boolean head;
        final boolean replayable;
        final long queuedAt = System.currentTimeMillis();
        volatile long handedAt;
        final CompletableFuture<byte[]> answer = new CompletableFuture<>();

        Pending(String id, byte[] frame, String method) {
            this.id = id;
            this.frame = frame;
            this.head = method.equals("HEAD");
            this.replayable = method.equals("GET") || method.equals("HEAD");
        }
    }

    private final class Relay {
        private final AtomicLong ids = new AtomicLong();
        private final LinkedBlockingDeque<Pending> queue = new LinkedBlockingDeque<>();
        private final ConcurrentHashMap<String, Pending> handed = new ConcurrentHashMap<>();
        private volatile long lastPoll = System.currentTimeMillis();
        private final AtomicInteger generation = new AtomicInteger();

        /** Blocks the page connection's thread until the worker answers. */
        byte[] submit(Pending p) {
            queue.add(p);
            while (true) {
                try {
                    return p.answer.get(2, TimeUnit.SECONDS);
                } catch (TimeoutException waiting) {
                    long now = System.currentTimeMillis();
                    if (p.handedAt == 0 && now - p.queuedAt > NO_WORKER_MS && now - lastPoll > NO_WORKER_MS && queue.remove(p)) {
                        return failure(503, "MundusMaker's engine is not running. Close the app and open it again.");
                    }
                    if (p.handedAt != 0 && now - p.handedAt > ANSWER_MS) {
                        handed.remove(p.id);
                        return failure(504, "MundusMaker took too long to answer.");
                    }
                } catch (Exception e) {
                    return failure(500, String.valueOf(e.getMessage()));
                }
            }
        }

        /**
         * The worker's long-poll. After a reload the old worker's poll can still
         * be parked here on a dead connection, so a poll gives back anything it
         * picks up once its worker has hung up, or once a new worker has said
         * hello, instead of losing the request on a closed socket.
         */
        Pending next(BooleanSupplier workerAlive) throws InterruptedException {
            int gen = generation.get();
            long until = System.currentTimeMillis() + POLL_WAIT_MS;
            lastPoll = System.currentTimeMillis();
            while (System.currentTimeMillis() < until) {
                Pending p = queue.poll(1, TimeUnit.SECONDS);
                // with hello() locked out, a request is handed only to the current worker
                synchronized (this) {
                    if (gen != generation.get() || !workerAlive.getAsBoolean()) {
                        if (p != null) queue.addFirst(p);
                        return null;
                    }
                    lastPoll = System.currentTimeMillis();
                    if (p != null) {
                        p.handedAt = System.currentTimeMillis();
                        handed.put(p.id, p);
                        return p;
                    }
                }
            }
            return null;
        }

        void giveBack(Pending p) {
            handed.remove(p.id);
            p.handedAt = 0;
            queue.addFirst(p);
        }

        void respond(String id, byte[] frame) {
            Pending p = id == null ? null : handed.remove(id);
            if (p != null) p.answer.complete(frame);
        }

        /**
         * A new worker started, so the old one will answer nothing it held.
         * Reads are safe to repeat and go to the new worker; a write may have
         * half-happened, so it fails and the page says so.
         */
        synchronized void hello() {
            generation.incrementAndGet();
            lastPoll = System.currentTimeMillis();
            for (Pending p : handed.values()) {
                handed.remove(p.id);
                if (p.replayable) {
                    p.handedAt = 0;
                    queue.addFirst(p);
                } else {
                    p.answer.complete(failure(503, "MundusMaker restarted its engine. Try again."));
                }
            }
        }

        private byte[] failure(int status, String message) {
            try {
                JSONObject meta = new JSONObject();
                JSONArray headers = new JSONArray();
                headers.put(new JSONArray().put("content-type").put("application/json; charset=utf-8"));
                meta.put("status", status);
                meta.put("headers", headers);
                return frame(meta.toString(), new JSONObject().put("error", message).toString().getBytes(StandardCharsets.UTF_8));
            } catch (JSONException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    private void relay(Request req, OutputStream out) throws IOException {
        String id = String.valueOf(relay.ids.incrementAndGet());
        byte[] frame;
        try {
            JSONObject meta = new JSONObject();
            meta.put("id", id);
            meta.put("method", req.method);
            meta.put("url", req.target);
            JSONArray headers = new JSONArray();
            for (String[] h : req.headers) headers.put(new JSONArray().put(h[0]).put(h[1]));
            meta.put("headers", headers);
            frame = frame(meta.toString(), req.body);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        byte[] answer = relay.submit(new Pending(id, frame, req.method));
        int nl = indexOf(answer, (byte) '\n');
        List<String[]> headers = new ArrayList<>();
        int status;
        try {
            JSONObject meta = new JSONObject(new String(answer, 0, nl, StandardCharsets.UTF_8));
            status = meta.optInt("status", 200);
            JSONArray list = meta.optJSONArray("headers");
            if (list != null) {
                for (int i = 0; i < list.length(); i++) {
                    JSONArray pair = list.getJSONArray(i);
                    headers.add(new String[] { pair.getString(0), pair.getString(1) });
                }
            }
        } catch (JSONException | RuntimeException e) {
            throw new HttpError(502, "MundusMaker sent a malformed answer.");
        }
        int bodyLength = answer.length - nl - 1;
        writeHead(out, status, headers, req.method.equals("HEAD") ? 0 : bodyLength, req.keepAlive);
        if (!req.method.equals("HEAD")) out.write(answer, nl + 1, bodyLength);
    }

    // ---------- the worker's channel ----------

    private void hostRoute(Request req, OutputStream out, BooleanSupplier workerAlive) throws IOException {
        String cors = "http://localhost:" + port;
        if (req.method.equals("OPTIONS")) {
            List<String[]> headers = new ArrayList<>();
            headers.add(new String[] { "Access-Control-Allow-Origin", cors });
            headers.add(new String[] { "Access-Control-Allow-Methods", "GET, POST" });
            headers.add(new String[] { "Access-Control-Max-Age", "600" });
            respond(out, 204, headers, EMPTY, false, req.keepAlive);
            return;
        }
        if (!same(req.param("k"), hostKey)) {
            respondJson(out, 403, "{\"error\":\"forbidden\"}", cors, req.keepAlive);
            return;
        }
        String route = req.path.substring("/__host/".length());
        switch (route) {
            case "next": {
                Pending p;
                try {
                    p = relay.next(workerAlive);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (p == null) {
                    List<String[]> headers = new ArrayList<>();
                    headers.add(new String[] { "Access-Control-Allow-Origin", cors });
                    headers.add(new String[] { "Cache-Control", "no-store" });
                    respond(out, 204, headers, EMPTY, false, req.keepAlive);
                    return;
                }
                try {
                    respondFrame(out, p.frame, cors, req.keepAlive);
                    out.flush();
                } catch (IOException gone) {
                    relay.giveBack(p); // that worker went away mid-handoff
                    throw gone;
                }
                return;
            }
            case "hello":
                relay.hello();
                respondJson(out, 200, "{}", cors, req.keepAlive);
                return;
            case "respond":
                relay.respond(req.param("id"), req.body);
                respondJson(out, 200, "{}", cors, req.keepAlive);
                return;
            case "fs": {
                int nl = indexOf(req.body, (byte) '\n');
                if (nl < 0) {
                    respondJson(out, 400, "{\"code\":\"EINVAL\",\"message\":\"malformed frame\"}", cors, req.keepAlive);
                    return;
                }
                String op = req.param("op");
                try {
                    JSONObject args = new JSONObject(new String(req.body, 0, nl, StandardCharsets.UTF_8));
                    byte[] data = new byte[req.body.length - nl - 1];
                    System.arraycopy(req.body, nl + 1, data, 0, data.length);
                    Object result = fs.call(op == null ? "" : op, args, data);
                    if (result instanceof byte[]) {
                        List<String[]> headers = new ArrayList<>();
                        headers.add(new String[] { "Content-Type", "application/octet-stream" });
                        headers.add(new String[] { "Cache-Control", "no-store" });
                        headers.add(new String[] { "Access-Control-Allow-Origin", cors });
                        respond(out, 200, headers, (byte[]) result, false, req.keepAlive);
                    } else {
                        respondJson(out, 200, result == null ? "null" : result.toString(), cors, req.keepAlive);
                    }
                } catch (FsHost.FsError e) {
                    int status = e.code.equals("ENOENT") ? 404 : e.code.equals("EACCES") || e.code.equals("EROFS") ? 403 : 409;
                    respondJson(out, status, errorJson(e.code, e.getMessage()), cors, req.keepAlive);
                } catch (JSONException e) {
                    respondJson(out, 400, errorJson("EINVAL", "malformed arguments"), cors, req.keepAlive);
                }
                return;
            }
            case "fetch": {
                int nl = indexOf(req.body, (byte) '\n');
                try {
                    if (nl < 0) throw new IOException("malformed frame");
                    JSONObject meta = new JSONObject(new String(req.body, 0, nl, StandardCharsets.UTF_8));
                    byte[] payload = new byte[req.body.length - nl - 1];
                    System.arraycopy(req.body, nl + 1, payload, 0, payload.length);
                    Outbound.Answer answer = outbound.request(meta, payload);
                    respondFrame(out, frame(answer.meta.toString(), answer.body), cors, req.keepAlive);
                } catch (Outbound.Refused e) {
                    respondJson(out, 502, errorJson("EACCES", e.getMessage()), cors, req.keepAlive);
                } catch (IOException | JSONException e) {
                    respondJson(out, 502, errorJson("ECONNREFUSED", String.valueOf(e.getMessage())), cors, req.keepAlive);
                }
                return;
            }
            case "log": {
                for (String line : new String(req.body, StandardCharsets.UTF_8).split("\n")) {
                    if (line.isEmpty()) continue;
                    int space = line.indexOf(' ');
                    String level = space < 0 ? "log" : line.substring(0, space);
                    String text = space < 0 ? line : line.substring(space + 1);
                    if (level.equals("error")) Log.e(TAG, text);
                    else if (level.equals("warn")) Log.w(TAG, text);
                    else Log.i(TAG, text);
                }
                respondJson(out, 200, "{}", cors, req.keepAlive);
                return;
            }
            case "exit": {
                int code;
                try { code = Integer.parseInt(String.valueOf(req.param("code"))); } catch (NumberFormatException e) { code = 0; }
                respondJson(out, 200, "{}", cors, req.keepAlive);
                Shell s = shell;
                if (s != null) s.onRuntimeExit(code);
                return;
            }
            default:
                respondJson(out, 404, "{\"error\":\"unknown host route\"}", cors, req.keepAlive);
        }
    }

    private static String errorJson(String code, String message) {
        try {
            return new JSONObject().put("code", code).put("message", message == null ? code : message).toString();
        } catch (JSONException e) {
            return "{\"code\":\"EIO\"}";
        }
    }

    private static void respondFrame(OutputStream out, byte[] frame, String cors, boolean keepAlive) throws IOException {
        List<String[]> headers = new ArrayList<>();
        headers.add(new String[] { "Content-Type", "application/octet-stream" });
        headers.add(new String[] { "Cache-Control", "no-store" });
        headers.add(new String[] { "Access-Control-Allow-Origin", cors });
        respond(out, 200, headers, frame, false, keepAlive);
    }

    // ---------- helpers ----------

    static byte[] frame(String metaJson, byte[] body) {
        byte[] head = (metaJson + "\n").getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[head.length + body.length];
        System.arraycopy(head, 0, out, 0, head.length);
        System.arraycopy(body, 0, out, head.length, body.length);
        return out;
    }

    static int indexOf(byte[] bytes, byte b) {
        for (int i = 0; i < bytes.length; i++) if (bytes[i] == b) return i;
        return -1;
    }

    static byte[] readFile(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(1024, file.length()));
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /** Percent-decoding as decodeURI does it (UTF-8); `plus` also turns + into a space (query strings). */
    static String percentDecode(String s, boolean plus) {
        if (s.indexOf('%') < 0 && !(plus && s.indexOf('+') >= 0)) return s;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) throw new IllegalArgumentException("bad escape");
                int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) throw new IllegalArgumentException("bad escape");
                bytes.write((hi << 4) | lo);
                i += 2;
            } else if (plus && c == '+') {
                bytes.write(' ');
            } else {
                byte[] b = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                bytes.write(b, 0, b.length);
            }
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    static String randomHex(int bytes) {
        byte[] b = new byte[bytes];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder(bytes * 2);
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return sb.toString();
    }
}
