package app.mundusmaker;

import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The file operations of mobile/shared/PROTOCOL.md on the device's own
 * filesystem. They go through android.system.Os, i.e. the same POSIX calls
 * Node makes on Linux, so server.js sees the error codes it expects (ENOENT,
 * EEXIST, ENOTEMPTY...). mobile/shared/fsops.js is the reference.
 *
 * Every path must sit inside the bundle (read only) or one of the writable
 * roots (data, config, temporary folders).
 */
final class FsHost {
    static final class FsError extends Exception {
        final String code;
        FsError(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final String ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    private final String readOnlyRoot;
    private final String[] writableRoots;
    private final SecureRandom random = new SecureRandom();

    FsHost(String readOnlyRoot, String[] writableRoots) {
        this.readOnlyRoot = normalize(readOnlyRoot);
        this.writableRoots = new String[writableRoots.length];
        for (int i = 0; i < writableRoots.length; i++) this.writableRoots[i] = normalize(writableRoots[i]);
    }

    /** One operation: a JSONObject result, null, or the bytes for "read". */
    Object call(String op, JSONObject args, byte[] data) throws FsError, JSONException {
        switch (op) {
            case "stat": return stat(check(args.getString("path"), false), args.optBoolean("follow", true), args.optBoolean("quiet", false));
            case "readdir": return readdir(check(args.getString("path"), false));
            case "read": return read(check(args.getString("path"), false));
            case "readmany": return readMany(args.getJSONArray("paths"));
            case "write": return write(check(args.getString("path"), true), args.optString("flag", "w"), args.optBoolean("fsync", false), data);
            case "mkdir": return mkdir(check(args.getString("path"), true), args.optBoolean("recursive", false));
            case "rename": {
                String from = checkInside(args.getString("from")), to = checkInside(args.getString("to"));
                try { Os.rename(from, to); } catch (ErrnoException e) { throw errno(e); }
                return new JSONObject();
            }
            case "rm": return rm(checkInside(args.getString("path")), args.optBoolean("recursive", false), args.optBoolean("force", false));
            case "rmdir": {
                String p = checkInside(args.getString("path"));
                if (!typeOf(lstat(p)).equals("dir")) throw new FsError("ENOTDIR", "not a directory");
                remove(p);
                return new JSONObject();
            }
            case "unlink": {
                String p = checkInside(args.getString("path"));
                if (typeOf(lstat(p)).equals("dir")) throw new FsError("EISDIR", "illegal operation on a directory");
                remove(p);
                return new JSONObject();
            }
            case "copy": return copy(check(args.getString("from"), false), check(args.getString("to"), true), args.optBoolean("excl", false));
            case "mkdtemp": {
                // as in Node: "dir/" makes a folder inside dir; "dir/name-" appends to the name.
                // Either way the new folder lands inside a root, never beside it.
                String prefix = args.getString("prefix");
                return mkdtemp(prefix.endsWith("/") ? check(prefix, true) + "/" : checkInside(prefix));
            }
            case "realpath": {
                String p = check(args.getString("path"), false);
                lstat(p); // missing paths are ENOENT, as in Node
                String real;
                try { real = new File(p).getCanonicalPath(); } catch (IOException e) { throw new FsError("EIO", String.valueOf(e.getMessage())); }
                return new JSONObject().put("path", check(unalias(real), false));
            }
            default: throw new FsError("EINVAL", "unknown operation " + op);
        }
    }

    // ---------- the sandbox ----------

    /**
     * Android's /data/user/0 is a link to /data/data, so a canonical path can
     * name a root by its other spelling; give it back in the roots' own terms.
     */
    private String unalias(String real) {
        List<String> roots = new ArrayList<>(Arrays.asList(writableRoots));
        roots.add(readOnlyRoot);
        for (String root : roots) {
            String canonical;
            try { canonical = new File(root).getCanonicalPath(); } catch (IOException e) { continue; }
            if (inside(real, canonical)) return root + real.substring(canonical.length());
        }
        return real;
    }

    static String normalize(String path) {
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) { if (!parts.isEmpty()) parts.remove(parts.size() - 1); }
            else parts.add(part);
        }
        StringBuilder sb = new StringBuilder();
        for (String part : parts) sb.append('/').append(part);
        return sb.length() == 0 ? "/" : sb.toString();
    }

    private static boolean inside(String path, String root) {
        return path.equals(root) || path.startsWith(root + "/");
    }

    private String check(String path, boolean write) throws FsError {
        // POSIX paths only, as every host takes them (PROTOCOL.md)
        if (path == null || !path.startsWith("/") || path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0) throw new FsError("EACCES", "paths must be absolute");
        String p = normalize(path);
        for (String root : writableRoots) if (inside(p, root)) return p;
        if (inside(p, readOnlyRoot)) {
            if (write) throw new FsError("EROFS", "read-only file system");
            return p;
        }
        throw new FsError("EACCES", "outside the app's folders");
    }

    /** Mutating ops work inside a root, never on the root folder itself. */
    private String checkInside(String path) throws FsError {
        String p = check(path, true);
        for (String root : writableRoots) if (p.equals(root)) throw new FsError("EACCES", "the app's own folders cannot be moved or removed");
        return p;
    }

    // ---------- operations ----------

    private static FsError errno(ErrnoException e) {
        String name = OsConstants.errnoName(e.errno);
        return new FsError(name == null ? "EIO" : name, Os.strerror(e.errno).toLowerCase(java.util.Locale.ROOT));
    }

    private static StructStat lstat(String p) throws FsError {
        try { return Os.lstat(p); } catch (ErrnoException e) { throw errno(e); }
    }

    private static String typeOf(StructStat st) {
        int mode = st.st_mode;
        if (OsConstants.S_ISLNK(mode)) return "symlink";
        if (OsConstants.S_ISREG(mode)) return "file";
        if (OsConstants.S_ISDIR(mode)) return "dir";
        return "other";
    }

    private static double millis(StructStat st, int which) {
        if (Build.VERSION.SDK_INT >= 27) {
            android.system.StructTimespec t = which == 0 ? st.st_mtim : which == 1 ? st.st_ctim : st.st_atim;
            return t.tv_sec * 1000.0 + Math.floor(t.tv_nsec / 1e6);
        }
        long sec = which == 0 ? st.st_mtime : which == 1 ? st.st_ctime : st.st_atime;
        return sec * 1000.0;
    }

    private static Object stat(String p, boolean follow, boolean quiet) throws FsError, JSONException {
        StructStat st;
        try {
            st = follow ? Os.stat(p) : Os.lstat(p);
        } catch (ErrnoException e) {
            if (quiet && (e.errno == OsConstants.ENOENT || e.errno == OsConstants.ENOTDIR)) return JSONObject.NULL;
            throw errno(e);
        }
        double mtime = millis(st, 0), ctime = millis(st, 1);
        return new JSONObject()
                .put("type", typeOf(st))
                .put("size", st.st_size)
                .put("mtimeMs", mtime)
                .put("ctimeMs", ctime)
                .put("atimeMs", millis(st, 2))
                .put("birthtimeMs", Math.min(mtime, ctime))
                .put("mode", st.st_mode);
    }

    private static JSONObject readdir(String p) throws FsError, JSONException {
        StructStat st = lstat(p);
        if (!OsConstants.S_ISDIR(st.st_mode)) throw new FsError("ENOTDIR", "not a directory");
        String[] names = new File(p).list();
        if (names == null) throw new FsError("EACCES", "permission denied");
        Arrays.sort(names, (a, b) -> compareBytes(a, b));
        JSONArray entries = new JSONArray();
        for (String name : names) {
            StructStat entry;
            try { entry = Os.lstat(p + "/" + name); } catch (ErrnoException gone) { continue; } // removed meanwhile
            entries.put(new JSONObject().put("name", name).put("type", typeOf(entry)).put("size", entry.st_size).put("mtimeMs", millis(entry, 0)));
        }
        return new JSONObject().put("entries", entries);
    }

    /** Sort by UTF-8 bytes, the order the reference host (and a byte-wise sort) gives. */
    private static int compareBytes(String a, String b) {
        byte[] x = a.getBytes(java.nio.charset.StandardCharsets.UTF_8), y = b.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (int i = 0; i < Math.min(x.length, y.length); i++) {
            int c = (x[i] & 0xff) - (y[i] & 0xff);
            if (c != 0) return c;
        }
        return x.length - y.length;
    }

    private static byte[] read(String p) throws FsError {
        FileDescriptor fd;
        try { fd = Os.open(p, OsConstants.O_RDONLY, 0); } catch (ErrnoException e) { throw errno(e); }
        try (InputStream in = new FileInputStream(fd)) {
            StructStat st = Os.fstat(fd);
            if (OsConstants.S_ISDIR(st.st_mode)) throw new FsError("EISDIR", "illegal operation on a directory");
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(Math.max(st.st_size, 1024), Integer.MAX_VALUE - 8));
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (ErrnoException e) {
            throw errno(e);
        } catch (IOException e) {
            throw new FsError("EIO", String.valueOf(e.getMessage()));
        } finally {
            closeQuietly(fd);
        }
    }

    /**
     * Several files in one answer, so listing a folder of entries is not one
     * round trip per file: { "sizes": [...] } and a newline, then the bytes back
     * to back. A file that cannot be read is size -1; the runtime then reads
     * it on its own and reports why.
     */
    private byte[] readMany(JSONArray paths) throws FsError, JSONException {
        if (paths.length() > 4096) throw new FsError("EINVAL", "too many paths");
        JSONArray sizes = new JSONArray();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (int i = 0; i < paths.length(); i++) {
            try {
                byte[] bytes = read(check(paths.getString(i), false));
                body.write(bytes, 0, bytes.length);
                sizes.put(bytes.length);
            } catch (FsError e) {
                sizes.put(-1);
            }
        }
        byte[] head = (new JSONObject().put("sizes", sizes).toString() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] all = new byte[head.length + body.size()];
        System.arraycopy(head, 0, all, 0, head.length);
        System.arraycopy(body.toByteArray(), 0, all, head.length, body.size());
        return all;
    }

    private static JSONObject write(String p, String flag, boolean fsync, byte[] data) throws FsError {
        int flags = OsConstants.O_WRONLY | OsConstants.O_CREAT;
        if (flag.equals("wx")) flags |= OsConstants.O_EXCL;
        else if (flag.equals("a")) flags |= OsConstants.O_APPEND;
        else flags |= OsConstants.O_TRUNC;
        FileDescriptor fd;
        try { fd = Os.open(p, flags, 0600); } catch (ErrnoException e) { throw errno(e); }
        try {
            int off = 0;
            while (off < data.length) off += Os.write(fd, data, off, data.length - off);
            if (fsync) Os.fsync(fd);
        } catch (ErrnoException e) {
            throw errno(e);
        } catch (java.io.InterruptedIOException e) {
            throw new FsError("EINTR", "interrupted");
        } finally {
            closeQuietly(fd);
        }
        return new JSONObject();
    }

    private static Object mkdir(String p, boolean recursive) throws FsError, JSONException {
        if (!recursive) {
            try { Os.mkdir(p, 0700); } catch (ErrnoException e) { throw errno(e); }
            return new JSONObject().put("first", JSONObject.NULL);
        }
        // Node: an existing folder is fine (nothing created), anything else in the way is EEXIST
        List<String> missing = new ArrayList<>();
        String at = p;
        while (true) {
            StructStat st;
            try {
                st = Os.stat(at);
            } catch (ErrnoException e) {
                if (e.errno != OsConstants.ENOENT) throw errno(e);
                missing.add(0, at);
                int slash = at.lastIndexOf('/');
                at = slash <= 0 ? "/" : at.substring(0, slash);
                continue;
            }
            if (!OsConstants.S_ISDIR(st.st_mode)) throw new FsError(at.equals(p) ? "EEXIST" : "ENOTDIR", at.equals(p) ? "file already exists" : "not a directory");
            break;
        }
        for (String dir : missing) {
            try { Os.mkdir(dir, 0700); } catch (ErrnoException e) { if (e.errno != OsConstants.EEXIST) throw errno(e); }
        }
        return new JSONObject().put("first", missing.isEmpty() ? JSONObject.NULL : missing.get(0));
    }

    private static void remove(String p) throws FsError {
        try { Os.remove(p); } catch (ErrnoException e) { throw errno(e); }
    }

    private static JSONObject rm(String p, boolean recursive, boolean force) throws FsError {
        StructStat st;
        try {
            st = Os.lstat(p);
        } catch (ErrnoException e) {
            if (force && e.errno == OsConstants.ENOENT) return new JSONObject();
            throw errno(e);
        }
        if (OsConstants.S_ISDIR(st.st_mode)) {
            if (!recursive) throw new FsError("EISDIR", "path is a directory");
            removeTree(p);
        } else {
            remove(p);
        }
        return new JSONObject();
    }

    /** Depth first, never following a symbolic link out of the tree. */
    private static void removeTree(String dir) throws FsError {
        String[] names = new File(dir).list();
        if (names != null) {
            for (String name : names) {
                String child = dir + "/" + name;
                StructStat st;
                try { st = Os.lstat(child); } catch (ErrnoException e) { continue; }
                if (OsConstants.S_ISDIR(st.st_mode)) removeTree(child);
                else remove(child);
            }
        }
        remove(dir);
    }

    private static JSONObject copy(String from, String to, boolean excl) throws FsError {
        FileDescriptor in;
        try { in = Os.open(from, OsConstants.O_RDONLY, 0); } catch (ErrnoException e) { throw errno(e); }
        try {
            if (OsConstants.S_ISDIR(Os.fstat(in).st_mode)) throw new FsError("EISDIR", "illegal operation on a directory");
            int flags = OsConstants.O_WRONLY | OsConstants.O_CREAT | (excl ? OsConstants.O_EXCL : OsConstants.O_TRUNC);
            FileDescriptor out;
            try { out = Os.open(to, flags, 0600); } catch (ErrnoException e) { throw errno(e); }
            try (InputStream src = new FileInputStream(in); OutputStream dst = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = src.read(buf)) > 0) dst.write(buf, 0, n);
            } catch (IOException e) {
                throw new FsError("EIO", String.valueOf(e.getMessage()));
            } finally {
                closeQuietly(out);
            }
        } catch (ErrnoException e) {
            throw errno(e);
        } finally {
            closeQuietly(in);
        }
        return new JSONObject();
    }

    private JSONObject mkdtemp(String prefix) throws FsError, JSONException {
        for (int attempt = 0; attempt < 20; attempt++) {
            StringBuilder p = new StringBuilder(prefix);
            for (int i = 0; i < 6; i++) p.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
            try {
                Os.mkdir(p.toString(), 0700);
                return new JSONObject().put("path", p.toString());
            } catch (ErrnoException e) {
                if (e.errno != OsConstants.EEXIST) throw errno(e);
            }
        }
        throw new FsError("EEXIST", "could not find a free temporary name");
    }

    private static void closeQuietly(FileDescriptor fd) {
        try { if (fd != null && fd.valid()) Os.close(fd); } catch (ErrnoException ignored) { /* already closed */ }
    }
}
