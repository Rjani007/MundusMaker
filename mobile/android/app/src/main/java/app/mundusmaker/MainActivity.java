package app.mundusmaker;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.Locale;

/**
 * MundusMaker on Android: one WebView showing the same app as the desktop,
 * served by HostServer from the bundle, with server.js running in the page's
 * worker (mobile/shared/runtime). This class adds what a browser tab gets
 * from its browser: back navigation, dialogs, picking files, saving and
 * sharing downloads, and recovering if the WebView's renderer dies.
 */
public final class MainActivity extends Activity implements HostServer.Shell {
    private static final int BACKGROUND = 0xFF201B2C;
    private static final int REQ_CHOOSE = 1;
    private static final int REQ_SAVE = 2;
    private static final String BACK_SCRIPT = "(function(){try{return !!(window.mundusShell&&window.mundusShell.back&&window.mundusShell.back())}catch(e){return false}})()";

    /*
     * Android relaunches the activity when the WebView provider's resources
     * first load (an "assets paths" change no manifest flag can opt out of),
     * and may do so again later. So the host starts once per process, and the
     * WebView outlives the activity: it is built on a MutableContextWrapper and
     * moved into each new activity, so a relaunch never reloads the page or
     * drops a save in flight.
     */
    private static final Object START_LOCK = new Object();
    // a static WebView is the point (see above); its context is reset to the
    // application on every activity's destroy, so no activity is kept alive
    @SuppressLint("StaticFieldLeak")
    private static HostServer host;
    private static boolean bundleChanged;
    private static WebView web;
    @SuppressLint("StaticFieldLeak")
    private static MutableContextWrapper webContext;
    private static ValueCallback<Uri[]> chooserCallback;
    private static File pendingSave;
    private static final ArrayDeque<Long> runtimeExits = new ArrayDeque<>();

    private FrameLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) Api30.edgeToEdge(this, root);
        if (Build.VERSION.SDK_INT >= 33) Api33.handleBack(this);
        if (host != null) {
            attach();
            return;
        }
        Context app = getApplicationContext();
        new Thread(() -> {
            try {
                ensureHost(app);
                runOnUiThread(this::attach);
            } catch (IOException | RuntimeException e) {
                Log.e(HostServer.TAG, "MundusMaker could not start", e);
                runOnUiThread(() -> showProblem(getString(R.string.start_failed, String.valueOf(e.getMessage()))));
            }
        }, "mundus-start").start();
    }

    private static void ensureHost(Context context) throws IOException {
        synchronized (START_LOCK) {
            if (host != null) return;
            startHost(context);
        }
    }

    private static void startHost(Context context) throws IOException {
        File files = context.getFilesDir();
        File app = new File(files, "app");
        File data = new File(files, "data");
        File config = new File(files, "config");
        File tmp = new File(context.getCacheDir(), "tmp");
        File saves = new File(context.getCacheDir(), "saves");
        BundleInstaller.deleteTree(saves); // files offered to Save/Share by an earlier run
        BundleInstaller.deleteTree(tmp);
        for (File dir : new File[] { data, config, tmp }) {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        }
        boolean changed = BundleInstaller.ensure(context, app);
        HostServer server = new HostServer(app, data, config, tmp, saves, versionName(context));
        SharedPreferences prefs = context.getSharedPreferences("host", MODE_PRIVATE);
        int port = server.start(prefs.getInt("port", 4870));
        prefs.edit().putInt("port", port).apply();
        synchronized (MainActivity.class) {
            bundleChanged |= changed;
            host = server;
        }
    }

    private static String versionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    private static String origin() { return "http://localhost:" + host.port(); }

    private void attach() {
        if (isDestroyed()) return;
        host.setShell(this);
        if (web != null) {
            adoptWebView();
            return;
        }
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(origin(), "mm_session=" + host.sessionToken + "; Path=/; HttpOnly; SameSite=Strict", ok -> {
            cookies.flush();
            if (isDestroyed()) return; // relaunched meanwhile: the new activity takes over
            if (web != null) {
                adoptWebView();
                return;
            }
            createWebView();
            web.loadUrl(origin() + "/");
        });
    }

    /** Move the page that is already running into this (relaunched) activity. */
    private void adoptWebView() {
        webContext.setBaseContext(this);
        if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    @SuppressLint("SetJavaScriptEnabled") // the app is JavaScript, and only its own origin loads here
    private void createWebView() {
        destroyWebView();
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        webContext = new MutableContextWrapper(this);
        web = new WebView(webContext);
        web.setBackgroundColor(BACKGROUND);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " MundusMakerAndroid/" + versionName(this));
        synchronized (MainActivity.class) {
            if (bundleChanged) {
                web.clearCache(true); // the pages changed with the app
                bundleChanged = false;
            }
        }
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, disposition, mimeType, length) ->
                Log.w(HostServer.TAG, "ignored a direct download of " + url + " (" + mimeType + ")"));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private static void destroyWebView() {
        if (web == null) return;
        if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        web = null;
    }

    private void showProblem(String message) {
        destroyWebView();
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(0xFFE8E2F0);
        text.setTextSize(16);
        text.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        text.setPadding(pad, pad, pad, pad);
        root.removeAllViews();
        root.addView(text, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ---------- back ----------

    // Android 12 and older; 13+ goes through the OnBackInvokedCallback (Api33)
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        handleBack();
    }

    /** Close the page's open dialog or drawer first, then go back in its history, then leave. */
    void handleBack() {
        if (web == null) {
            moveTaskToBack(true);
            return;
        }
        web.evaluateJavascript(BACK_SCRIPT, handled -> {
            if ("true".equals(handled) || web == null) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    // ---------- lifecycle ----------

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        // JavaScript keeps running, so a save started just before this still lands
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (host != null) host.setShell(null);
        if (web != null && web.getParent() == root) {
            if (isFinishing()) destroyWebView();
            else {
                root.removeView(web); // a relaunch: the next activity adopts it
                webContext.setBaseContext(getApplicationContext());
            }
        }
        super.onDestroy();
    }

    // ---------- HostServer.Shell ----------

    @Override
    public void onSave(File file, String name, String mimeType) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            String type = mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle(name)
                    .setMessage(R.string.save_message)
                    .setPositiveButton(R.string.save_to_device, (d, w) -> {
                        pendingSave = file;
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                                .addCategory(Intent.CATEGORY_OPENABLE)
                                .setType(type)
                                .putExtra(Intent.EXTRA_TITLE, name);
                        try {
                            startActivityForResult(intent, REQ_SAVE);
                        } catch (ActivityNotFoundException e) {
                            Toast.makeText(this, R.string.no_file_app, Toast.LENGTH_LONG).show();
                        }
                    })
                    .setNeutralButton(R.string.share, (d, w) -> share(file, name, type))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        });
    }

    private void share(File file, String name, String type) {
        Uri uri = ShareProvider.uriFor(file);
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType(type)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(name, uri));
        try {
            startActivity(Intent.createChooser(send, getString(R.string.share_title, name)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_share_app, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRuntimeExit(int code) {
        runOnUiThread(() -> {
            long now = SystemClock.elapsedRealtime();
            runtimeExits.addLast(now);
            while (!runtimeExits.isEmpty() && now - runtimeExits.peekFirst() > 60_000) runtimeExits.removeFirst();
            if (runtimeExits.size() >= 3) showProblem(getString(R.string.runtime_keeps_stopping, code));
            else if (web != null) web.reload();
        });
    }

    // ---------- activity results: picked files, saved files ----------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CHOOSE) {
            ValueCallback<Uri[]> callback = chooserCallback;
            chooserCallback = null;
            if (callback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[] { data.getData() };
                }
            }
            callback.onReceiveValue(result);
        } else if (requestCode == REQ_SAVE) {
            File file = pendingSave;
            pendingSave = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || file == null) return;
            Uri target = data.getData();
            new Thread(() -> {
                boolean ok;
                try (InputStream in = new FileInputStream(file); OutputStream out = getContentResolver().openOutputStream(target, "w")) {
                    if (out == null) throw new IOException("no output stream");
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    ok = true;
                } catch (IOException | SecurityException e) {
                    Log.w(HostServer.TAG, "save failed", e);
                    ok = false;
                }
                boolean saved = ok;
                runOnUiThread(() -> Toast.makeText(this, saved ? getString(R.string.saved, file.getName()) : getString(R.string.save_failed), Toast.LENGTH_LONG).show());
            }, "mundus-save").start();
        }
    }

    // ---------- the WebView's clients ----------

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("http".equals(url.getScheme()) && "localhost".equals(url.getHost()) && url.getPort() == host.port()) return false;
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto")) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, R.string.no_browser, Toast.LENGTH_LONG).show();
                }
            }
            return true; // nothing but MundusMaker itself loads in here
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(HostServer.TAG, "the WebView renderer stopped (crashed: " + detail.didCrash() + "); reloading");
            if (view == web) {
                createWebView();
                web.loadUrl(origin() + "/");
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        private AlertDialog.Builder dialog() {
            return new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Dialog_Alert).setTitle(R.string.app_name);
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            dialog().setMessage(message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.confirm())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            dialog().setMessage(message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
            EditText input = new EditText(MainActivity.this);
            input.setText(defaultValue == null ? "" : defaultValue);
            input.setSingleLine(true);
            FrameLayout wrap = new FrameLayout(MainActivity.this);
            int pad = (int) (20 * getResources().getDisplayMetrics().density);
            wrap.setPadding(pad, 0, pad, 0);
            wrap.addView(input);
            dialog().setMessage(message).setView(wrap)
                    .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm(input.getText().toString()))
                    .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
            dialog().setMessage(R.string.leave_unsaved)
                    .setPositiveButton(R.string.leave, (d, w) -> result.confirm())
                    .setNegativeButton(R.string.stay, (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooserCallback != null) chooserCallback.onReceiveValue(null);
            chooserCallback = callback;
            boolean images = params.getAcceptTypes().length > 0;
            for (String type : params.getAcceptTypes()) {
                String t = type.trim().toLowerCase(Locale.ROOT);
                if (!(t.startsWith("image/") || t.matches("\\.(png|jpe?g|webp|gif)"))) images = false;
            }
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(images ? "image/*" : "*/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, REQ_CHOOSE);
                return true;
            } catch (ActivityNotFoundException e) {
                chooserCallback = null;
                Toast.makeText(MainActivity.this, R.string.no_file_app, Toast.LENGTH_LONG).show();
                return false;
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            // the runtime worker's lines already reach the log through the host
            if (message.sourceId() != null && message.sourceId().contains("/__shell/runtime/")) return true;
            Log.d(HostServer.TAG, "[page] " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
            return true;
        }
    }

    // ---------- newer platform APIs, kept apart so older devices never load them ----------

    @TargetApi(30)
    private static final class Api30 {
        static void edgeToEdge(Activity activity, View root) {
            activity.getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = activity.getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
    }

    @TargetApi(33)
    private static final class Api33 {
        static void handleBack(MainActivity activity) {
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, activity::handleBack);
        }
    }
}
