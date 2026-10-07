package br.org.louvorvisual.projector

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

/** Host da origem embarcada: a interface nunca recebe arquivos, tokens ou uma API arbitrária. */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView; private lateinit var store: LocalStore; private lateinit var importer: PackageImporter; private lateinit var player: ExoPlayer; private lateinit var nativeSession: NativeSessionStore; private lateinit var api: NativeApi
    private val executor=Executors.newSingleThreadExecutor(); private val epoch=UUID.randomUUID().toString(); private var sequence=0L
    private var pickerReply: ((JSONObject)->Unit)?=null
    private val picker=registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val reply=pickerReply; pickerReply=null
        if(uri==null) { reply?.invoke(JSONObject().put("status","cancelled")); return@registerForActivityResult }
        executor.execute { try { val ready=importer.stage(contentResolver,uri,uri.lastPathSegment?:"pacote.zip"); reply?.invoke(JSONObject().put("status","ready").put("importId",ready.id).put("fileName",ready.name).put("preview",ready.preview)) } catch(e:Exception) { reply?.invoke(JSONObject().put("status","rejected").put("code", e.message?.takeIf { it in REJECTIONS } ?: "unreadable")) } }
    }

    @SuppressLint("SetJavaScriptEnabled") override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); store=LocalStore(this); importer=PackageImporter(store); nativeSession=NativeSessionStore(this); api=NativeApi(BuildConfig.API_BASE_URL)
        player=ExoPlayer.Builder(this).build().also { p -> p.addListener(object: Player.Listener { override fun onIsPlayingChanged(playing:Boolean)=audio( if(playing) "playing" else "paused", !playing ); override fun onPlaybackStateChanged(state:Int) { if(state==Player.STATE_ENDED) audio("ended",false) } }) }
        val assets=WebViewAssetLoader.Builder().addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView=WebView(this).apply { setBackgroundColor(Color.rgb(16,18,23)); isFocusableInTouchMode=true; settings.javaScriptEnabled=true; settings.allowFileAccess=false; settings.allowContentAccess=false; settings.blockNetworkLoads=true; settings.domStorageEnabled=false; webViewClient=LocalOnlyClient(assets); loadUrl(ENTRY) }
        WebViewCompat.addWebMessageListener(webView,GLOBAL,setOf(ORIGIN)) { _, msg, origin, frame, proxy -> if(origin.toString()==ORIGIN && frame && msg.type==WebMessageCompat.TYPE_STRING) executor.execute { handle(msg.data ?: return@execute,proxy) } }
        setContentView(webView); webView.post { webView.requestFocus() }
    }
    private fun handle(raw:String,proxy:JavaScriptReplyProxy) {
        val id=runCatching { JSONObject(raw).getLong("id") }.getOrDefault(1)
        try { val request=JSONObject(raw); require(fieldsOf(request)==setOf("v","kind","id","method","params")&&request.optInt("v")==1&&request.optString("kind")=="request"&&request.optLong("id")>0) { "invalid-request" }; val method=request.getString("method"); require(method in METHODS) { "unsupported" }; val p=request.optJSONObject("params") ?: throw IllegalArgumentException("invalid-request"); require(validParams(method,p)){"invalid-request"}; dispatch(method,p) { result -> proxy.postMessage(JSONObject().put("v",1).put("kind","response").put("id",id).put("ok",true).put("result",result).toString()) } }
        catch(e:Exception) { proxy.postMessage(JSONObject().put("v",1).put("kind","error").put("id",id).put("error",JSONObject().put("code",e.message?.takeIf { it in ERROR_CODES } ?: "invalid-request").put("message","Pedido recusado pelo host.")).toString()) }
    }
    private fun dispatch(method:String,p:JSONObject,ok:(JSONObject)->Unit) { when(method) {
        "host.info" -> ok(JSONObject().put("bridgeVersion",1).put("host","android").put("appVersion","0.1.0-e0").put("fontPackVersion","1"))
        "host.setKeepAwake" -> { runOnUiThread { if(p.optBoolean("on")) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }; ok(JSONObject()) }
        "host.exit" -> { runOnUiThread { moveTaskToBack(true) }; ok(JSONObject()) }
        "prefs.get" -> ok(JSONObject().put("prefs",store.prefs())); "prefs.set" -> ok(JSONObject().put("prefs",store.setPrefs(p.getJSONObject("prefs"))))
        "library.listSetlists" -> ok(page("setlist",p)); "library.listSongs" -> ok(page("song",p)); "library.getSetlist" -> ok(setlist(p.getString("setlistId"))); "library.getPresentable" -> ok(presentable(p.getString("arrangementId")))
        "session.create" -> { store.createSession(p.getString("sessionId"),p.getJSONObject("snapshot"),p.getJSONObject("context")); ok(JSONObject()) }
        "session.saveCheckpoint" -> { val now=Instant.now().toString(); store.checkpoint(p.getString("sessionId"),p.getJSONObject("checkpoint"),now); ok(JSONObject().put("savedAt",now)) }
        "session.findRecoverable" -> ok(JSONObject().put("session",store.recoverable())); "session.end" -> { store.endSession(p.getString("sessionId"));ok(JSONObject()) }
        "files.pickPackage" -> { pickerReply=ok; runOnUiThread { picker.launch(arrayOf("application/zip","application/octet-stream")) } }
        "files.applyImport" -> ok(JSONObject().put("setlistId",importer.apply(p.getString("importId")))); "files.discardImport" -> {store.discardImport(p.getString("importId"));ok(JSONObject())}
        "audio.load" -> { val f=store.mediaFile(p.getString("sha256")); if(!f.isFile) throw IllegalArgumentException("unavailable"); onPlayer { player.setMediaItem(MediaItem.fromUri(Uri.fromFile(f))); player.prepare(); player.addListener(object:Player.Listener { override fun onPlaybackStateChanged(state:Int) { if(state==Player.STATE_READY) { player.removeListener(this); ok(JSONObject().put("durationMs",player.duration.coerceAtLeast(0))) } else if(state==Player.STATE_IDLE) { player.removeListener(this); throw IllegalArgumentException("unavailable") } } }) } }
        "audio.play" -> onPlayer { player.play();ok(JSONObject()) }; "audio.pause" -> onPlayer { player.pause();ok(JSONObject().put("positionMs",player.currentPosition.coerceAtLeast(0))) }; "audio.seek" -> onPlayer { player.seekTo(p.getLong("positionMs"));ok(JSONObject().put("positionMs",player.currentPosition.coerceAtLeast(0))) }; "audio.setVolume" -> onPlayer { player.volume=p.getDouble("volume").toFloat();ok(JSONObject()) }; "audio.release" -> onPlayer { player.stop();player.clearMediaItems();ok(JSONObject()) }
        "account.status" -> ok(account()); "account.signIn" -> signIn(ok); "account.signOut" -> { nativeSession.clear(); emit("account.changed",account()); ok(JSONObject()) }; "account.syncNow" -> refreshNativeSession(ok)
    } }
    private fun page(type:String,p:JSONObject):JSONObject { val all=if(type=="song")store.list("arrangement") else store.list(type);val start=p.optString("cursor").toIntOrNull()?:0;val limit=p.optInt("limit",50).coerceIn(1,50);val items=JSONArray();all.drop(start).take(limit).forEach { d->items.put(if(type=="song") songSummary(store.document("song",d.getString("songId"))?:return@forEach,d) else JSONObject().put("setlistId",d.getString("id")).put("title",d.optString("title")).put("serviceDate",d.opt("serviceDate")).put("itemCount",d.optJSONArray("items")?.length()?:0)) };return JSONObject().put("items",items).put("nextCursor",if(start+limit<all.size)(start+limit).toString() else JSONObject.NULL) }
    private fun selectedAudio(arrangement:JSONObject):Pair<JSONObject?,JSONObject?> { val selected=arrangement.optString("selectedAudioBindingId");val bindings=arrangement.optJSONArray("audioBindings")?:return null to null; for(i in 0 until bindings.length()){val binding=bindings.getJSONObject(i);if(binding.optString("id")==selected){val asset=store.document("asset",binding.getString("assetId"));return binding to asset} };return null to null }
    private fun songSummary(song:JSONObject,arrangement:JSONObject):JSONObject { val (binding,asset)=selectedAudio(arrangement);val audio=when { binding==null->"none";asset==null||!store.mediaFile(asset.optString("sha256")).isFile->"missing";else->"ready" };return JSONObject().put("songId",song.getString("id")).put("arrangementId",arrangement.getString("id")).put("title",song.optString("title")).put("artist",song.opt("artist")).put("slideCount",arrangement.optJSONArray("occurrences")?.length()?:0).put("audio",audio) }
    private fun setlist(id:String):JSONObject { val s=store.document("setlist",id)?:throw IllegalArgumentException("not-found");val entries=JSONArray();val raw=s.optJSONArray("items")?:JSONArray();for(i in 0 until raw.length()){val item=raw.getJSONObject(i);val a=store.document("arrangement",item.getString("arrangementId"));val song=a?.let { store.document("song",it.getString("songId")) };if(song!=null&&a!=null)entries.put(songSummary(song,a).put("itemId",item.getString("id")))};return JSONObject().put("setlist",JSONObject().put("setlistId",id).put("title",s.optString("title")).put("serviceDate",s.opt("serviceDate")).put("itemCount",raw.length())).put("items",entries) }
    private fun presentable(id:String):JSONObject { val arrangement=store.document("arrangement",id)?:throw IllegalArgumentException("not-found");val song=store.document("song",arrangement.getString("songId"))?:throw IllegalArgumentException("not-found");val (binding,asset)=selectedAudio(arrangement);val available=asset!=null&&store.mediaFile(asset.optString("sha256")).isFile;val audio=if(binding!=null&&available)JSONObject().put("binding",binding).put("asset",asset) else JSONObject.NULL;return JSONObject().put("song",song).put("arrangement",arrangement).put("songGeneration",0).put("arrangementGeneration",0).put("audio",audio).put("audioMissing",binding!=null&&!available) }
    private fun account()=JSONObject().put("profile","personal").put("teamName",JSONObject.NULL).put("signedIn",nativeSession.tokens()!=null).put("online",false).put("sync",JSONObject().put("state","disabled").put("pending",0).put("conflicts",0).put("lastSyncedAt",JSONObject.NULL))
    private fun signIn(ok:(JSONObject)->Unit) {
        if(!api.configured()) { ok(JSONObject().put("status","offline")); return }
        runOnUiThread {
            val form=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; val padding=(24*resources.displayMetrics.density).toInt(); setPadding(padding,padding,padding,0) }
            val email=EditText(this).apply { hint="E-mail"; inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS }
            val password=EditText(this).apply { hint="Senha"; inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
            form.addView(email); form.addView(password)
            val dialog=AlertDialog.Builder(this).setTitle("Entrar na equipe").setView(form).setNegativeButton("Cancelar") { _,_ -> ok(JSONObject().put("status","cancelled")) }.setPositiveButton("Entrar",null).create()
            dialog.setOnShowListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val address=email.text.toString().trim(); val secret=password.text.toString()
                    if(address.isEmpty()||secret.length<12) { password.error="Informe e-mail e senha válidos"; return@setOnClickListener }
                    dialog.dismiss()
                    executor.execute {
                        val status=runCatching { val tokens=api.login(address,secret); nativeSession.save(tokens.access,tokens.refresh); "signed-in" }.getOrElse { if(it is java.io.IOException) "offline" else "failed" }
                        ok(JSONObject().put("status",status)); if(status=="signed-in") emit("account.changed",account())
                    }
                }
            }
            dialog.show()
        }
    }
    private fun refreshNativeSession(ok:(JSONObject)->Unit) { val tokens=nativeSession.tokens()?:throw IllegalArgumentException("auth-required"); if(!api.configured()){ok(JSONObject().put("started",false));return}; executor.execute { runCatching { api.refresh(tokens.refresh) }.onSuccess { nativeSession.save(it.access,it.refresh);emit("account.changed",account()) }.onFailure { if(it is IllegalStateException&&it.message=="auth-required") nativeSession.clear() }; ok(JSONObject().put("started",false)) } }
    /** Espelha os formatos da ponte no host: uma mensagem direta não contorna o cliente TypeScript. */
    private fun fieldsOf(value:JSONObject):Set<String> { val fields=mutableSetOf<String>(); val iterator=value.keys(); while(iterator.hasNext()) fields+=iterator.next(); return fields }
    private fun validParams(method:String,p:JSONObject):Boolean {
        fun fields(vararg names:String)=fieldsOf(p)==names.toSet()
        fun uuid(name:String)=p.optString(name).matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",RegexOption.IGNORE_CASE))
        fun page()=fields("cursor","limit")&&(p.isNull("cursor")||p.opt("cursor") is String)&&(p.optInt("limit",-1) in 1..50)
        fun opaque(name:String)=p.opt(name) is JSONObject
        return when(method) {
        "host.info","host.exit","prefs.get","session.findRecoverable","files.pickPackage","audio.play","audio.release","account.status","account.signIn","account.signOut","account.syncNow"->fields()
        "host.setKeepAwake"->fields("on")&&p.opt("on") is Boolean
        "prefs.set"->fields("prefs")&&p.opt("prefs") is JSONObject
        "library.listSetlists","library.listSongs"->page()
        "library.getSetlist"->fields("setlistId")&&uuid("setlistId")
        "library.getPresentable"->fields("arrangementId")&&uuid("arrangementId")
        "session.create"->fields("sessionId","snapshot","context")&&uuid("sessionId")&&opaque("snapshot")&&p.optJSONObject("context")?.let(::fieldsOf)==setOf("setlistId","itemId")
        "session.saveCheckpoint"->fields("sessionId","checkpoint")&&uuid("sessionId")&&opaque("checkpoint")
        "session.end"->fields("sessionId")&&uuid("sessionId")
        "files.applyImport","files.discardImport"->fields("importId")&&p.optString("importId").length in 1..64
        "audio.load"->fields("assetId","sha256")&&uuid("assetId")&&p.optString("sha256").matches(Regex("^[0-9a-f]{64}$"))
        "audio.pause"->fields()
        "audio.seek"->fields("positionMs")&&p.opt("positionMs") is Number&&p.optLong("positionMs",-1)>=0
        "audio.setVolume"->fields("volume")&&p.opt("volume") is Number&&p.optDouble("volume",-1.0) in 0.0..1.0
        else->false
    } }
    override fun dispatchKeyEvent(event:KeyEvent):Boolean { val command=RemoteCommandMapper.fromKeyCode(event.keyCode)?:return super.dispatchKeyEvent(event); emit("remote.key",JSONObject().put("epoch",epoch).put("seq",++sequence).put("key",command.wireName).put("action",if(event.action==KeyEvent.ACTION_DOWN)"down" else "up").put("repeat",event.repeatCount)); return true }
    override fun onPause(){super.onPause();player.pause();emit("host.lifecycle",JSONObject().put("state","background"))}; override fun onResume(){super.onResume();webView.post { webView.requestFocus() };emit("host.lifecycle",JSONObject().put("state","foreground"))}; override fun onDestroy(){player.release();executor.shutdown();webView.destroy();super.onDestroy()}
    private fun onPlayer(action:()->Unit){ runOnUiThread(action) }
    private fun audio(type:String,external:Boolean)=emit("audio.state",JSONObject().put("type",type).put("positionMs",player.currentPosition.coerceAtLeast(0)).put("external",external))
    private fun emit(event:String,payload:JSONObject){if(!::webView.isInitialized)return;val message=JSONObject().put("v",1).put("kind","event").put("event",event).put("payload",payload).toString();webView.post { webView.evaluateJavascript("window.$GLOBAL&&window.$GLOBAL.onmessage&&window.$GLOBAL.onmessage({data:${JSONObject.quote(message)}});",null) }}
    private class LocalOnlyClient(private val assets:WebViewAssetLoader):WebViewClient(){override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse?=assets.shouldInterceptRequest(request.url);override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest)=true}
    companion object { const val ORIGIN="https://appassets.androidplatform.net";const val ENTRY="$ORIGIN/assets/index.html";const val GLOBAL="louvorvisualHost";val METHODS=setOf("host.info","host.setKeepAwake","host.exit","prefs.get","prefs.set","library.listSetlists","library.getSetlist","library.listSongs","library.getPresentable","session.create","session.saveCheckpoint","session.findRecoverable","session.end","files.pickPackage","files.applyImport","files.discardImport","audio.load","audio.play","audio.pause","audio.seek","audio.setVolume","audio.release","account.status","account.signIn","account.signOut","account.syncNow");val ERROR_CODES=setOf("invalid-request","unsupported","not-found","unavailable","blocked","storage","quota","offline","auth-required","cancelled","failed");val REJECTIONS=setOf("not-a-package","too-large","unsafe-path","manifest-missing","manifest-invalid","format-too-new","schema-too-new","schema-unsupported","font-pack-incompatible","catalog-missing","unexpected-file","missing-file","hash-mismatch","document-invalid","reference-broken","unreadable","quota") }
}
