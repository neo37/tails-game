package business.spacecode.tails;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;

import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import androidx.webkit.WebViewAssetLoader;

/** «Хвосты»: игра из assets/www по https://appassets.androidplatform.net (localStorage и модули работают как на сайте). */
public class MainActivity extends Activity {
    private static final int REQ_MIC = 71;
    private android.webkit.PermissionRequest pendingMic;

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != REQ_MIC || pendingMic == null) return;
        if (res.length > 0 && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED)
            pendingMic.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else pendingMic.deny();
        pendingMic = null;
    }

    private static final String HOME = "https://appassets.androidplatform.net/www/index.html";
    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Обработчик отрезает свой префикс от пути, поэтому он на "/": /www/index.html → assets/www/index.html.
        // С префиксом "/www/" искался assets/index.html, и страница открывалась пустой.
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost()) && !u.getPath().startsWith("/www/")) {
                    // страницы игры ссылаются на корень (/src/…) — перенаправляем в www/
                    return loader.shouldInterceptRequest(u.buildUpon().path("/www" + u.getPath()).build());
                }
                return loader.shouldInterceptRequest(u);
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                // процесс страницы упал (например, не хватило памяти): без этого система закрывает всё приложение
                recreate();
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        // без WebChromeClient WebView молча отвечает «нет» на confirm() и не показывает alert(): покупки в мастерской не проходили
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            // 🎤 в командной гонке: страница просит микрофон — спрашиваем разрешение Android и только тогда даём
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest req) {
                boolean audio = false;
                for (String r : req.getResources()) if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                if (!audio) { req.deny(); return; }
                runOnUiThread(() -> {
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        req.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingMic = req;
                        requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }
        });
        web.addJavascriptInterface(new AdsBridge(), "TailsAds");
        setContentView(web);
        immersive();
        startAds();
        if (state != null) web.restoreState(state);
        else web.loadUrl(HOME);
    }

    /* ── реклама с наградой: ⭐ за досмотренный ролик. Сначала согласие (UMP, ЕС), потом загрузка ролика ── */
    private RewardedAd rewarded;
    private boolean adsReady, adLoading;
    private int adRetry;

    private void startAds() {
        ConsentInformation ci = UserMessagingPlatform.getConsentInformation(this);
        ci.requestConsentInfoUpdate(this, new ConsentRequestParameters.Builder().setTagForUnderAgeOfConsent(false).build(),
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(this, err -> { if (ci.canRequestAds()) initAds(); }),
            err -> { if (ci.canRequestAds()) initAds(); });
        if (ci.canRequestAds()) initAds();     // согласие уже было в прошлый раз
    }

    private void initAds() {
        if (adsReady) return;
        adsReady = true;
        // в игру играют дети: только ролики с рейтингом G (для всех возрастов)
        MobileAds.setRequestConfiguration(new com.google.android.gms.ads.RequestConfiguration.Builder()
            .setMaxAdContentRating(com.google.android.gms.ads.RequestConfiguration.MAX_AD_CONTENT_RATING_G).build());
        MobileAds.initialize(this, st -> loadAd());
    }

    private void loadAd() {
        if (adLoading || rewarded != null) return;
        adLoading = true;
        RewardedAd.load(this, BuildConfig.REWARDED_ID, new AdRequest.Builder().build(), new RewardedAdLoadCallback() {
            @Override public void onAdLoaded(RewardedAd ad) { rewarded = ad; adLoading = false; adRetry = 0; }
            @Override public void onAdFailedToLoad(LoadAdError e) {
                // нет ролика (новый блок, нет показов в регионе, нет сети) — пробуем снова: 30 с, 1, 2, 4… до 10 мин
                rewarded = null; adLoading = false;
                long wait = Math.min(600_000L, 30_000L << Math.min(adRetry++, 5));
                web.postDelayed(MainActivity.this::loadAd, wait);
            }
        });
    }

    private void toPage(String js) { web.post(() -> web.evaluateJavascript(js, null)); }

    /** window.TailsAds в странице: ready() — ролик загружен; show() — показать, по окончании вызывается window.__adDone(true/false). */
    class AdsBridge {
        @JavascriptInterface public boolean ready() { return rewarded != null; }
        @JavascriptInterface public void show() {
            runOnUiThread(() -> {
                RewardedAd ad = rewarded;
                if (ad == null) { toPage("window.__adDone && window.__adDone(false)"); loadAd(); return; }
                rewarded = null;
                final boolean[] earned = { false };
                ad.setFullScreenContentCallback(new com.google.android.gms.ads.FullScreenContentCallback() {
                    @Override public void onAdDismissedFullScreenContent() { toPage("window.__adDone && window.__adDone(" + earned[0] + ")"); immersive(); loadAd(); }
                    @Override public void onAdFailedToShowFullScreenContent(com.google.android.gms.ads.AdError e) { toPage("window.__adDone && window.__adDone(false)"); loadAd(); }
                });
                ad.show(MainActivity.this, reward -> earned[0] = true);
            });
        }
    }

    private void immersive() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean f) {
        super.onWindowFocusChanged(f);
        if (f) immersive();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
