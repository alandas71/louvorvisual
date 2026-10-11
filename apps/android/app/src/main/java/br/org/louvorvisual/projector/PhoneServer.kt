package br.org.louvorvisual.projector

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Controle somente da biblioteca local. Não serve arquivos, áudio nem APIs de conta. */
internal class PhoneServer(
    private val controllerHtml: String,
    private val controllerJs: String,
    private val addresses: () -> List<String>,
    private val library: (String, String?, Int) -> JSONObject,
    private val onCommand: (String, JSONObject) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) : NanoHTTPD(0) {
    private val random = SecureRandom()
    /** Código curto, suficiente apenas para o pareamento local temporário. */
    private val code = random.nextInt(10000).toString().padStart(4, '0')
    private val expires = now() + 10 * 60 * 1000
    @Volatile private var token: String? = null
    @Volatile private var seenAt = 0L
    @Volatile var foreground = true
    @Volatile private var presentation = JSONObject(IDLE)
    private var failedAttempts = 0
    private var attemptWindow = now()
    private val busy = AtomicBoolean(false)
    private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val completed = LinkedHashMap<String, Pair<String, JSONObject>>()

    fun connection(): JSONObject = JSONObject().put("enabled", isAlive).put("connected", token != null && now() - seenAt < 5000)
        .put("urls", org.json.JSONArray(addresses().map { "http://$it:$listeningPort" }))
        .put("code", if (token == null && now() < expires) code else JSONObject.NULL)
        .put("expiresAt", if (token == null && now() < expires) Instant.ofEpochMilli(expires).toString() else JSONObject.NULL)

    fun publish(value: JSONObject) { presentation = JSONObject(value.toString()) }
    fun acknowledge(id: String, ok: Boolean, message: String) {
        pending[id]?.complete(JSONObject().put("ok", ok).put("message", message.take(1000)))
    }
    override fun stop() {
        foreground = false
        token = null
        pending.values.forEach { it.complete(JSONObject().put("ok", false).put("message", "O controle foi desligado no projetor.")) }
        super.stop()
    }

    override fun serve(session: IHTTPSession): Response {
        return try {
            val host = session.headers["host"] ?: ""
            if (host !in addresses().map { "$it:$listeningPort" }) return json(Response.Status.FORBIDDEN, "Endereço não autorizado.")
            val origin = session.headers["origin"]
            if (origin != null && origin != "http://$host") return json(Response.Status.FORBIDDEN, "Origem não autorizada.")
            if (session.method == Method.GET && session.uri == "/") return response(Response.Status.OK, "text/html; charset=utf-8", controllerHtml)
            if (session.method == Method.GET && session.uri == "/controller.js") return response(Response.Status.OK, "text/javascript; charset=utf-8", controllerJs)
            if (session.method == Method.POST && origin != "http://$host") return json(Response.Status.FORBIDDEN, "Abra o controle no endereço do projetor.")
            if (session.uri == "/pair" && session.method == Method.POST) return pair(body(session))
            val supplied = session.headers["x-louvorvisual-token"] ?: ""
            val expected = token ?: return json(Response.Status.UNAUTHORIZED, "Digite o código mostrado no projetor.")
            if (!MessageDigest.isEqual(supplied.toByteArray(), expected.toByteArray())) return json(Response.Status.UNAUTHORIZED, "O pareamento expirou. Conecte novamente.")
            seenAt = now()
            when {
                session.method == Method.GET && session.uri == "/status" -> response(Response.Status.OK, MIME_JSON, JSONObject().put("foreground", foreground).put("presentation", JSONObject(presentation.toString())).toString())
                session.method == Method.GET && session.uri == "/library" -> {
                    val kind = session.parameters["kind"]?.firstOrNull() ?: "songs"
                    require(kind in setOf("songs", "setlists", "setlist"))
                    val cursor = session.parameters["cursor"]?.firstOrNull()
                    val offset = cursor?.toIntOrNull() ?: 0
                    require(cursor == null || offset >= 0 && cursor.toIntOrNull() != null)
                    val id = session.parameters["id"]?.firstOrNull()
                    if (kind == "setlist") require(id != null && UUID_PATTERN.matches(id))
                    response(Response.Status.OK, MIME_JSON, library(kind, id, offset).toString())
                }
                session.method == Method.POST && session.uri == "/command" -> command(body(session))
                else -> json(Response.Status.NOT_FOUND, "Página não encontrada.")
            }
        } catch (_: IllegalArgumentException) {
            json(Response.Status.BAD_REQUEST, "Pedido inválido.")
        } catch (_: Exception) {
            json(Response.Status.INTERNAL_ERROR, "Não foi possível atender. Confira a conexão do projetor.")
        }
    }

    @Synchronized private fun pair(value: JSONObject): Response {
        if (now() - attemptWindow >= 60000) { attemptWindow = now(); failedAttempts = 0 }
        if (failedAttempts >= 5) return json(Response.Status.TOO_MANY_REQUESTS, "Aguarde um minuto antes de tentar novamente.")
        require(fields(value) == setOf("code"))
        if (now() >= expires || token != null) return json(Response.Status.FORBIDDEN, "Gere um novo código no projetor.")
        if (value.opt("code") !is String || value.getString("code") != code) {
            failedAttempts++
            return json(Response.Status.UNAUTHORIZED, "Código incorreto. Confira a tela do projetor.")
        }
        token = ByteArray(32).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        seenAt = now()
        return response(Response.Status.OK, MIME_JSON, JSONObject().put("token", token).toString())
    }

    private fun body(session: IHTTPSession): JSONObject {
        require(session.headers["content-type"]?.substringBefore(';')?.trim() == MIME_JSON)
        require(session.headers["transfer-encoding"] == null)
        val length = session.headers["content-length"]?.toIntOrNull() ?: throw IllegalArgumentException()
        require(length in 1..4096)
        val bytes = ByteArray(length)
        var offset = 0
        while (offset < length) { val read = session.inputStream.read(bytes, offset, length - offset); require(read > 0); offset += read }
        return try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { throw IllegalArgumentException() }
    }

    private fun command(value: JSONObject): Response {
        require(fields(value) == setOf("id", "command"))
        val id = value.optString("id")
        require(UUID_PATTERN.matches(id))
        val command = value.optJSONObject("command") ?: throw IllegalArgumentException()
        require(validCommand(command))
        synchronized(completed) {
            completed[id]?.let { (original, result) ->
                require(original == command.toString())
                return response(Response.Status.OK, MIME_JSON, result.toString())
            }
        }
        if (!foreground) return json(Response.Status.CONFLICT, "Abra o LouvorVisual no projetor para continuar.")
        if (!busy.compareAndSet(false, true)) return json(Response.Status.CONFLICT, "Aguarde o comando anterior.")
        val result = CompletableFuture<JSONObject>()
        pending[id] = result
        try {
            onCommand(id, command)
            val answer = try { result.get(10, TimeUnit.SECONDS) } catch (_: Exception) { JSONObject().put("ok", false).put("message", "O projetor não confirmou o comando. Confira a prévia antes de tentar novamente.") }
            synchronized(completed) {
                completed[id] = command.toString() to answer
                while (completed.size > 100) completed.remove(completed.keys.first())
            }
            return response(Response.Status.OK, MIME_JSON, answer.toString())
        } finally { pending.remove(id); busy.set(false) }
    }

    companion object {
        const val MIME_JSON = "application/json"
        const val IDLE = "{\"sessionId\":null,\"phase\":\"idle\",\"title\":\"\",\"text\":\"\",\"index\":0,\"total\":0,\"visualMode\":\"normal\",\"transport\":false,\"message\":\"\"}"
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
        fun fields(value: JSONObject): Set<String> = value.keys().asSequence().toSet()
        fun validCommand(command: JSONObject): Boolean = when (command.optString("type")) {
            "select" -> fields(command) == setOf("type", "arrangementId", "setlistId", "itemId") && UUID_PATTERN.matches(command.optString("arrangementId")) &&
                listOf("setlistId", "itemId").all { command.isNull(it) || command.opt(it) is String && UUID_PATTERN.matches(command.getString(it)) } && command.isNull("setlistId") == command.isNull("itemId")
            "start", "next", "previous", "toggle", "black", "normal", "end" -> fields(command) == setOf("type", "sessionId") && UUID_PATTERN.matches(command.optString("sessionId"))
            else -> false
        }
        fun validPresentation(value: JSONObject): Boolean = fields(value) == setOf("sessionId", "phase", "title", "text", "index", "total", "visualMode", "transport", "message") &&
            (value.isNull("sessionId") || UUID_PATTERN.matches(value.optString("sessionId"))) && value.optString("phase") in setOf("idle", "loading", "ready", "running", "paused", "finished", "error") &&
            listOf("title", "text", "message").all { value.opt(it) is String && value.getString(it).length <= if (it == "text") 50000 else 1000 } &&
            listOf("index", "total").all { value.opt(it) is Number && value.optDouble(it) >= 0 && value.optDouble(it) == value.optInt(it).toDouble() } &&
            value.optString("visualMode") in setOf("normal", "black", "lyricsHidden") && value.opt("transport") is Boolean
        private fun json(status: Response.Status, message: String) = response(status, MIME_JSON, JSONObject().put("message", message).toString())
        private fun response(status: Response.Status, mime: String, body: String): Response = NanoHTTPD.newFixedLengthResponse(status, mime, body).apply {
            addHeader("Cache-Control", "no-store")
            addHeader("X-Content-Type-Options", "nosniff")
            addHeader("X-Frame-Options", "DENY")
            addHeader("Referrer-Policy", "no-referrer")
            addHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        }
    }
}
