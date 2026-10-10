package app.mundusmaker;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Unpacks the app bundle (public/, server.js, the server scripts, sample/ and
 * the mobile runtime; staged by mobile/scripts/stage-bundle.js) from the APK
 * into files/app, whenever its checksum differs from the copy already there.
 * A new copy is unpacked beside the old one and swapped in whole, so an
 * interrupted update never leaves half a bundle. The data folder is separate
 * and never touched.
 */
final class BundleInstaller {
    private BundleInstaller() {}

    /** Returns true when a new bundle was unpacked (the WebView cache is then stale). */
    static boolean ensure(Context context, File appDir) throws IOException {
        String wanted;
        try (InputStream in = context.getAssets().open("bundle.json")) {
            wanted = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)).getString("sha256");
        } catch (org.json.JSONException e) {
            throw new IOException("bundle.json is damaged", e);
        }
        File marker = new File(appDir, ".bundle");
        if (marker.isFile() && wanted.equals(new String(HostServer.readFile(marker), StandardCharsets.UTF_8).trim())
                && new File(appDir, "server.js").isFile()) {
            return false;
        }
        File parent = appDir.getParentFile();
        File fresh = new File(parent, appDir.getName() + ".new");
        File old = new File(parent, appDir.getName() + ".old");
        deleteTree(fresh);
        deleteTree(old);
        if (!fresh.mkdirs()) throw new IOException("cannot create " + fresh);
        String base = fresh.getCanonicalPath() + File.separator;
        int count = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open("bundle.zip"), 64 * 1024))) {
            ZipEntry entry;
            byte[] buf = new byte[64 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(fresh, entry.getName());
                if (!out.getCanonicalPath().startsWith(base)) throw new IOException("unsafe path in bundle: " + entry.getName());
                if (entry.isDirectory()) {
                    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("cannot create " + out);
                    continue;
                }
                File dir = out.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) os.write(buf, 0, n);
                }
                count++;
            }
        }
        try (OutputStream os = new FileOutputStream(new File(fresh, ".bundle"))) {
            os.write(wanted.getBytes(StandardCharsets.UTF_8));
        }
        if (appDir.exists() && !appDir.renameTo(old)) throw new IOException("cannot move the old bundle aside");
        if (!fresh.renameTo(appDir)) throw new IOException("cannot move the new bundle into place");
        deleteTree(old);
        Log.i(HostServer.TAG, "unpacked " + count + " bundle files (" + wanted.substring(0, 12) + ")");
        return true;
    }

    static void deleteTree(File file) {
        if (!file.exists()) return;
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete()) Log.w(HostServer.TAG, "could not delete " + file);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
