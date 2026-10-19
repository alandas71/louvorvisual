package br.org.louvorvisual.projector

import android.annotation.SuppressLint
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Receptor do projetor: uma única tela, sem biblioteca nem menus. Abre a página
 * /receptor do PWA, que mostra o código de pareamento e depois só o que o
 * celular apresenta (letra e som). Tudo o que é interface fica no celular.
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val receiverUrl = BuildConfig.API_BASE_URL.trimEnd('/') + "/receptor?receiver=apk"
    private val reload = Runnable { if (::webView.isInitialized) webView.loadUrl(receiverUrl) }

    @SuppressLint("SetJavaScriptEnabled") override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // As teclas de volume do controle agem sobre a faixa, não sobre o toque.
        volumeControlStream = AudioManager.STREAM_MUSIC
        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK); isFocusableInTouchMode = true
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false
            // A faixa começa pelo comando do celular, sem toque nesta tela.
            settings.mediaPlaybackRequiresUserGesture = false
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = ReceiverClient()
        }
        setContentView(webView); hideSystemBars()
        webView.loadUrl(receiverUrl); webView.post { webView.requestFocus() }
    }

    /** Projetores costumam abrir o aplicativo antes de o Wi-Fi conectar: a tela avisa e tenta de novo sozinha. */
    private fun retryLater(message: String) {
        handler.removeCallbacks(reload)
        webView.loadDataWithBaseURL(null, WAITING_PAGE.replace("{message}", message), "text/html", "utf-8", null)
        handler.postDelayed(reload, RETRY_MS)
    }

    private inner class ReceiverClient : WebViewClient() {
        private val allowedHost = Uri.parse(BuildConfig.API_BASE_URL).host
        /** O aplicativo fica preso ao receptor: nenhum link leva a outra página. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val uri = request.url
            return uri.scheme != "https" || uri.host != allowedHost || uri.path?.trimEnd('/') != "/receptor"
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) retryLater("Sem conexão com o servidor. Verifique a internet do projetor.")
        }
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame) retryLater("O servidor do LouvorVisual não respondeu (erro ${response.statusCode}).")
        }
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // O sistema encerrou o processo da página (pouca memória): recomeça em vez de fechar o aplicativo.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) recreate()
            return true
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, webView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::webView.isInitialized) hideSystemBars()
    }
    override fun onResume() { super.onResume(); webView.onResume(); webView.post { webView.requestFocus() } }
    // Fora da tela, a página fica oculta e o receptor pausa a faixa (ver useReceiverAudio).
    override fun onPause() { webView.onPause(); super.onPause() }
    override fun onDestroy() { handler.removeCallbacks(reload); webView.destroy(); super.onDestroy() }

    companion object {
        private const val RETRY_MS = 4000L
        private const val WAITING_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{height:100%;margin:0;background:#05060a;color:#fff;font-family:sans-serif}body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}h1{font-size:4vh;font-weight:400;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.6);margin:0 0 4vh}p{font-size:3.4vh;color:#ffe1a2;margin:0 8vw}small{font-size:2.4vh;color:rgba(255,255,255,.5);margin-top:3vh}</style></head><body><h1>LouvorVisual</h1><p>{message}</p><small>Tentando de novo…</small></body></html>"
    }
}
