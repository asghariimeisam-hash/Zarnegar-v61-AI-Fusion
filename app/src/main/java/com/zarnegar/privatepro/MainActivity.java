package com.zarnegar.privatepro;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.*;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.os.Build;
import android.widget.Toast;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private WebView webView;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService aiIo = Executors.newSingleThreadExecutor();
    private SharedPreferences bridgePrefs;
    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingSaveText;
    private static final int REQ_OPEN_JSON = 6101;
    private static final int REQ_SAVE_JSON = 6102;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(Color.rgb(7,10,13));
        getWindow().setNavigationBarColor(Color.rgb(7,10,13));
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        bridgePrefs = getSharedPreferences("zarnegar_bridge_v58", MODE_PRIVATE);
        WebView.setWebContentsDebuggingEnabled(false);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(7,10,13));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            s.setAllowFileAccessFromFileURLs(false);
            s.setAllowUniversalAccessFromFileURLs(false);
        }

        CookieManager.getInstance().setAcceptCookie(false);
        webView.addJavascriptInterface(new NativeBridge(), "AndroidBridge");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                try { startActivityForResult(i, REQ_OPEN_JSON); }
                catch (Exception e) {
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this, "فایل‌خوان در دسترس نیست", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && "file".equalsIgnoreCase(u.getScheme())) return false;
                if (u != null && ("https".equalsIgnoreCase(u.getScheme()) || "http".equalsIgnoreCase(u.getScheme()))) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                return true;
            }

            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri u = Uri.parse(url);
                if ("file".equalsIgnoreCase(u.getScheme())) return false;
                if ("https".equalsIgnoreCase(u.getScheme()) || "http".equalsIgnoreCase(u.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                }
                return true;
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "خطا در بارگذاری زرنگار", Toast.LENGTH_SHORT).show();
                }
            }
        });

        setContentView(webView);
        webView.loadUrl("file:///android_asset/index-v61.html");
    }

    private boolean isPrivateIpv4(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.US);
        if (h.equals("localhost") || h.endsWith(".local")) return true;
        if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.")) return true;
        String[] p = h.split("\\.");
        if (p.length == 4) {
            try {
                int a = Integer.parseInt(p[0]);
                int b = Integer.parseInt(p[1]);
                if (a == 172 && b >= 16 && b <= 31) return true;
                // Tailscale / CGNAT private overlay range.
                if (a == 100 && b >= 64 && b <= 127) return true;
            } catch (NumberFormatException ignored) { }
        }
        return false;
    }

    private boolean validBridgeUrl(String raw) {
        try {
            URI u = URI.create(raw);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (host == null || scheme == null) return false;
            if ("https".equalsIgnoreCase(scheme)) return true;
            return "http".equalsIgnoreCase(scheme) && isPrivateIpv4(host);
        } catch (Exception e) {
            return false;
        }
    }

    private String bridgeBase() {
        String base = bridgePrefs.getString("base_url", "");
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base;
    }

    private String readAll(InputStream in) throws Exception {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder b = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) b.append(line);
        return b.toString();
    }

    private void sendJsReply(String kind, String payload) {
        if (webView == null) return;
        final String script = "window.Z&&window.Z.onNativeReply(" + JSONObject.quote(kind) + "," + JSONObject.quote(payload) + ");";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private void httpGetAsync(String kind, String pathAndQuery) {
        final String base = bridgeBase();
        if (!validBridgeUrl(base)) {
            sendJsReply(kind, "{\"ok\":false,\"error\":\"BRIDGE_NOT_CONFIGURED\"}");
            return;
        }
        io.submit(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new java.net.URL(base + pathAndQuery).openConnection();
                c.setRequestMethod("GET");
                c.setConnectTimeout(4500);
                c.setReadTimeout(5000);
                c.setUseCaches(false);
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("User-Agent", "Zarnegar-v61-Android");
                String token = bridgePrefs.getString("token", "");
                if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
                int code = c.getResponseCode();
                InputStream stream = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
                String body = stream != null ? readAll(stream) : "";
                if (code >= 200 && code < 300) {
                    sendJsReply(kind, body);
                } else {
                    JSONObject err = new JSONObject();
                    err.put("ok", false);
                    err.put("error", "HTTP_" + code);
                    err.put("detail", body.length() > 300 ? body.substring(0, 300) : body);
                    sendJsReply(kind, err.toString());
                }
            } catch (Exception e) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("ok", false);
                    err.put("error", "NETWORK_ERROR");
                    err.put("detail", e.getClass().getSimpleName());
                    sendJsReply(kind, err.toString());
                } catch (Exception ignored) { }
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    private void httpGetAiAsync(String kind, String pathAndQuery) {
        final String base = bridgeBase();
        if (!validBridgeUrl(base)) {
            sendJsReply(kind, "{\"ok\":false,\"error\":\"BRIDGE_NOT_CONFIGURED\"}");
            return;
        }
        aiIo.submit(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new java.net.URL(base + pathAndQuery).openConnection();
                c.setRequestMethod("GET");
                c.setConnectTimeout(5000);
                c.setReadTimeout(180000);
                c.setUseCaches(false);
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("User-Agent", "Zarnegar-v61-AI-Android");
                String token = bridgePrefs.getString("token", "");
                if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
                int code = c.getResponseCode();
                InputStream stream = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
                String body = stream != null ? readAll(stream) : "";
                if (code >= 200 && code < 300) {
                    sendJsReply(kind, body);
                } else {
                    JSONObject err = new JSONObject();
                    err.put("ok", false);
                    err.put("error", "HTTP_" + code);
                    err.put("detail", body.length() > 300 ? body.substring(0, 300) : body);
                    sendJsReply(kind, err.toString());
                }
            } catch (Exception e) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("ok", false);
                    err.put("error", "AI_NETWORK_ERROR");
                    err.put("detail", e.getClass().getSimpleName());
                    sendJsReply(kind, err.toString());
                } catch (Exception ignored) { }
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    public class NativeBridge {
        @JavascriptInterface public void stateChanged() { }

        @JavascriptInterface public void vibrate() {
            Vibrator v = (Vibrator)getSystemService(VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(35, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                //noinspection deprecation
                v.vibrate(35);
            }
        }

        @JavascriptInterface public void toast(final String text) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface public void share(final String text) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, "اشتراک‌گذاری زرنگار"));
            });
        }

        @JavascriptInterface public boolean isOnline() {
            try {
                ConnectivityManager cm = (ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
                if (cm == null) return false;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Network n = cm.getActiveNetwork();
                    NetworkCapabilities c = cm.getNetworkCapabilities(n);
                    return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                }
                //noinspection deprecation
                return cm.getActiveNetworkInfo() != null && cm.getActiveNetworkInfo().isConnected();
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface public String getAppVersion() { return "6.1.0"; }

        @JavascriptInterface public String getBridgeConfig() {
            try {
                JSONObject o = new JSONObject();
                o.put("baseUrl", bridgeBase());
                String token = bridgePrefs.getString("token", "");
                o.put("hasToken", token != null && !token.isEmpty());
                return o.toString();
            } catch (Exception e) {
                return "{\"baseUrl\":\"\",\"hasToken\":false}";
            }
        }

        @JavascriptInterface public boolean configureBridge(String baseUrl, String token) {
            if (baseUrl == null) return false;
            String base = baseUrl.trim();
            while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
            if (!validBridgeUrl(base)) return false;
            SharedPreferences.Editor e = bridgePrefs.edit().putString("base_url", base);
            if (token != null && !token.trim().isEmpty()) e.putString("token", token.trim());
            e.apply();
            return true;
        }

        @JavascriptInterface public void clearBridgeConfig() {
            bridgePrefs.edit().clear().apply();
        }

        @JavascriptInterface public void setKeepScreenOn(final boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface public void saveTextFile(final String filename, final String content) {
            if (content == null) return;
            runOnUiThread(() -> {
                pendingSaveText = content;
                String safeName = (filename == null || filename.trim().isEmpty()) ? "zarnegar-backup.json" : filename.replaceAll("[^A-Za-z0-9._-]", "_");
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_TITLE, safeName);
                try { startActivityForResult(i, REQ_SAVE_JSON); }
                catch (Exception e) {
                    pendingSaveText = null;
                    Toast.makeText(MainActivity.this, "ذخیره فایل در دسترس نیست", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface public void requestHealth() {
            httpGetAsync("health", "/v1/health");
        }

        @JavascriptInterface public void requestMarket(String symbol) {
            try {
                String s = URLEncoder.encode(symbol == null ? "XAUUSD" : symbol, "UTF-8");
                httpGetAsync("market", "/v1/market?symbol=" + s);
            } catch (Exception e) {
                sendJsReply("market", "{\"ok\":false,\"error\":\"BAD_SYMBOL\"}");
            }
        }

        @JavascriptInterface public void requestLiveQuote() {
            io.submit(() -> {
                String[] urls = new String[] {
                    "https://api.gold-api.com/price/XAU",
                    "https://data-asg.goldprice.org/dbXRates/USD"
                };
                for (String url : urls) {
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new java.net.URL(url).openConnection();
                        c.setRequestMethod("GET");
                        c.setConnectTimeout(5000);
                        c.setReadTimeout(6000);
                        c.setUseCaches(false);
                        c.setRequestProperty("Accept", "application/json");
                        c.setRequestProperty("User-Agent", "Zarnegar-v61-Android");
                        int code = c.getResponseCode();
                        InputStream stream = code >= 200 && code < 300 ? c.getInputStream() : null;
                        if (stream == null) continue;
                        String body = readAll(stream);
                        JSONObject j = new JSONObject(body);
                        double px = j.optDouble("price", Double.NaN);
                        if (Double.isNaN(px) && j.has("items")) {
                            px = j.getJSONArray("items").optJSONObject(0).optDouble("xauPrice", Double.NaN);
                        }
                        if (Double.isNaN(px) || px < 100) continue;
                        JSONObject out = new JSONObject();
                        out.put("ok", true);
                        out.put("symbol", "XAUUSD");
                        out.put("price", px);
                        out.put("bid", px - 0.09);
                        out.put("ask", px + 0.09);
                        out.put("spread", 0.18);
                        out.put("source", "ONLINE");
                        out.put("time_msc", System.currentTimeMillis());
                        sendJsReply("live", out.toString());
                        return;
                    } catch (Exception ignored) {
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                sendJsReply("live", "{\"ok\":false,\"error\":\"LIVE_QUOTE_FAIL\"}");
            });
        }

        @JavascriptInterface public void requestAi(String symbol) {
            try {
                String s = URLEncoder.encode(symbol == null ? "XAUUSD" : symbol, "UTF-8");
                httpGetAiAsync("ai", "/v1/ai?symbol=" + s);
            } catch (Exception e) {
                sendJsReply("ai", "{\"ok\":false,\"error\":\"BAD_SYMBOL\"}");
            }
        }

        @JavascriptInterface public void requestBars(String symbol, String timeframe, int count) {
            try {
                String s = URLEncoder.encode(symbol == null ? "XAUUSD" : symbol, "UTF-8");
                String tf = URLEncoder.encode(timeframe == null ? "M5" : timeframe, "UTF-8");
                int safeCount = Math.max(60, Math.min(500, count));
                httpGetAsync("bars:" + timeframe, "/v1/bars?symbol=" + s + "&timeframe=" + tf + "&count=" + safeCount);
            } catch (Exception e) {
                sendJsReply("bars:" + timeframe, "{\"ok\":false,\"error\":\"BAD_REQUEST\"}");
            }
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN_JSON) {
            ValueCallback<Uri[]> cb = fileChooserCallback;
            fileChooserCallback = null;
            if (cb == null) return;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) cb.onReceiveValue(new Uri[]{data.getData()});
            else cb.onReceiveValue(null);
            return;
        }
        if (requestCode == REQ_SAVE_JSON) {
            String text = pendingSaveText;
            pendingSaveText = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || text == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                if (out == null) throw new Exception("NO_OUTPUT_STREAM");
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.flush();
                Toast.makeText(this, "پشتیبان زرنگار ذخیره شد", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "ذخیره پشتیبان ناموفق بود", Toast.LENGTH_SHORT).show();
            }
        }
    }

    @Override protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        io.shutdownNow();
        aiIo.shutdownNow();
        if (fileChooserCallback != null) { fileChooserCallback.onReceiveValue(null); fileChooserCallback = null; }
        pendingSaveText = null;
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.loadUrl("about:blank");
            webView.clearHistory();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
