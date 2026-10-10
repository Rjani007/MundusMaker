package app.mundusmaker;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/**
 * Hands a file the page saved (cache/saves/<n>/<name>) to the app the GM picks
 * in the Share sheet, read-only and only for that share. A tiny stand-in for
 * AndroidX's FileProvider, so the app needs no libraries.
 * URIs look like content://app.mundusmaker.files/<n>/<name>.
 */
public final class ShareProvider extends ContentProvider {
    static final String AUTHORITY = "app.mundusmaker.files";

    static Uri uriFor(File file) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath(file.getParentFile().getName()).appendPath(file.getName()).build();
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 2 || !parts.get(0).matches("\\d+")) throw new FileNotFoundException("unknown file");
        File saves = new File(getContext().getCacheDir(), "saves");
        File file = new File(new File(saves, parts.get(0)), parts.get(1));
        try {
            if (!file.getCanonicalPath().startsWith(saves.getCanonicalPath() + File.separator) || !file.isFile()) throw new FileNotFoundException("unknown file");
        } catch (IOException e) {
            throw new FileNotFoundException("unknown file");
        }
        return file;
    }

    @Override
    public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read only");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try { file = fileFor(uri); } catch (FileNotFoundException e) { return null; }
        String[] columns = projection != null ? projection : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        int dot = name == null ? -1 : name.lastIndexOf('.');
        String type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("read only"); }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("read only"); }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("read only"); }
}
