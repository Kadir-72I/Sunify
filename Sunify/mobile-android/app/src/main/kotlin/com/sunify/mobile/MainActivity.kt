package com.sunify.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("sunify_secure_auth", MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.parseColor("#0A0910")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        val app = application as SunifyApplication
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0A0910"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                useWideViewPort = true
                loadWithOverviewMode = true
            }
            addJavascriptInterface(SunifyAndroidBridge(), "SunifyAndroidBridge")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (url.startsWith("https://appassets.androidplatform.net/")) return false
                    if (url.startsWith("https://") || url.startsWith("http://")) {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        return true
                    }
                    return false
                }
            }
        }
        setContentView(webView)

        MediaPlaybackService.onMediaAction = { cmd ->
            runOnUiThread {
                webView.evaluateJavascript("window.__sunifyOnAndroidMediaAction && window.__sunifyOnAndroidMediaAction('${cmd}')", null)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    """
                    (() => {
                      const lyrics = document.getElementById('lyricsOverlay');
                      if (lyrics && lyrics.classList.contains('active')) { document.getElementById('closeLyricsBtn')?.click(); return 'handled'; }
                      const settings = document.getElementById('viewSettings');
                      if (settings && settings.classList.contains('active')) { document.getElementById('closeSettingsBtn')?.click(); return 'handled'; }
                      const queue = document.getElementById('queueDrawer');
                      if (queue && queue.classList.contains('open')) { document.getElementById('closeQueueBtn')?.click(); return 'handled'; }
                      const search = document.getElementById('inlineSearchOverlay');
                      if (search && search.classList.contains('active')) { document.getElementById('spotlightClearBtn')?.click(); return 'handled'; }
                      const homeBtn = document.getElementById('navHomeBtn');
                      if (homeBtn && !homeBtn.classList.contains('active')) { homeBtn.click(); return 'handled'; }
                      return 'exit';
                    })();
                    """.trimIndent()
                ) { result ->
                    if (result?.contains("exit") == true) {
                        moveTaskToBack(true)
                    }
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/assets/renderer/index.html?apiPort=${app.apiPort}&mobile=1")
    }

    inner class SunifyAndroidBridge {
        @JavascriptInterface
        fun getAppVersion(): String = "1.2.1"

        @JavascriptInterface
        fun getSecureAuthValue(key: String): String? = prefs.getString(key, null)

        @JavascriptInterface
        fun setSecureAuthValue(key: String, value: String): Boolean {
            prefs.edit().putString(key, value).apply()
            return true
        }

        @JavascriptInterface
        fun deleteSecureAuthValue(key: String) {
            prefs.edit().remove(key).apply()
        }

        @JavascriptInterface
        fun updatePlaybackNotification(stateJson: String) {
            val obj = runCatching { JSONObject(stateJson) }.getOrNull() ?: return
            val title = obj.optString("title", "Sunify").ifBlank { "Sunify" }
            val artist = obj.optString("artist", "Sunify").ifBlank { "Sunify" }
            val playing = obj.optBoolean("playing", false)
            val intent = Intent(this@MainActivity, MediaPlaybackService::class.java).apply {
                action = MediaPlaybackService.ACTION_UPDATE
                putExtra(MediaPlaybackService.EXTRA_TITLE, title)
                putExtra(MediaPlaybackService.EXTRA_ARTIST, artist)
                putExtra(MediaPlaybackService.EXTRA_PLAYING, playing)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(this@MainActivity, intent)
            } else {
                startService(intent)
            }
        }
    }
}
