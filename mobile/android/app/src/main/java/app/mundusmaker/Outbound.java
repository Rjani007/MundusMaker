package app.mundusmaker;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Outbound requests for the runtime (PROTOCOL.md, "Outbound requests"):
 * https only, at most 64 MB back. server.js makes them only when the GM
 * presses a button (Check for updates, the Library downloader, Get it from…),
 * and with redirect "manual" it checks every hop itself, so redirects are
 * returned as they are rather than followed here.
 */
final class Outbound {
    static final class Refused extends IOException {
        Refused(String message) { super(message); }
    }

    static final class Answer {
        final JSONObject meta;
        final byte[] body;
        Answer(JSONObject meta, byte[] body) { this.meta = meta; this.body = body; }
    }

    private static final long MAX_BYTES = 64L * 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;

    Answer request(JSONObject meta, byte[] body) throws IOException, JSONException {
        String url = meta.getString("url");
        String method = meta.optString("method", "GET").toUpperCase(Locale.ROOT);
        boolean follow = "follow".equals(meta.optString("redirect", "follow"));
        int timeout = (int) Math.min(Math.max(meta.optLong("timeoutMs", 120000), 1000), 300000);
        JSONArray headers = meta.optJSONArray("headers");
        for (int hop = 0; ; hop++) {
            URL target = new URL(url);
            if (!"https".equalsIgnoreCase(target.getProtocol())) throw new Refused("only https requests are allowed");
            HttpURLConnection conn = (HttpURLConnection) target.openConnection();
            try {
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(Math.min(timeout, 30000));
                conn.setReadTimeout(timeout);
                conn.setRequestMethod(method);
                conn.setUseCaches(false);
                if (headers != null) {
                    for (int i = 0; i < headers.length(); i++) {
                        JSONArray pair = headers.getJSONArray(i);
                        String name = pair.getString(0);
                        if (name.equalsIgnoreCase("host") || name.equalsIgnoreCase("content-length") || name.equalsIgnoreCase("connection")) continue;
                        conn.addRequestProperty(name, pair.getString(1));
                    }
                }
                if (body.length > 0 && !method.equals("GET") && !method.equals("HEAD")) {
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(body.length);
                    try (OutputStream out = conn.getOutputStream()) { out.write(body); }
                }
                int status = conn.getResponseCode();
                String location = conn.getHeaderField("Location");
                if (follow && status >= 300 && status < 400 && location != null) {
                    // as fetch() does: give up past the limit, and a POST that is redirected becomes a GET
                    if (hop >= MAX_REDIRECTS) throw new IOException("too many redirects");
                    url = new URL(target, location).toString();
                    if (status == 303 || ((status == 301 || status == 302) && method.equals("POST"))) {
                        method = "GET";
                        body = new byte[0];
                    }
                    continue;
                }
                JSONArray outHeaders = new JSONArray();
                for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                    if (h.getKey() == null) continue; // the status line
                    for (String value : h.getValue()) outHeaders.put(new JSONArray().put(h.getKey().toLowerCase(Locale.ROOT)).put(value));
                }
                byte[] data = readCapped(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
                JSONObject answer = new JSONObject()
                        .put("status", status)
                        .put("statusText", conn.getResponseMessage() == null ? "" : conn.getResponseMessage())
                        .put("url", url)
                        .put("headers", outHeaders);
                return new Answer(answer, data);
            } finally {
                conn.disconnect();
            }
        }
    }

    private static byte[] readCapped(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = stream.read(buf)) > 0) {
                if (out.size() + (long) n > MAX_BYTES) throw new Refused("the answer is larger than 64 MB");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }
}
