package br.org.louvorvisual.projector

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class PhoneServerTest {
    private lateinit var server: PhoneServer
    private var calls = 0
    private var time = 1000000L
    private val sessionId = "11111111-1111-4111-8111-111111111111"
    @Before fun setup() {
        System.setProperty("sun.net.http.allowRestrictedHeaders", "true")
        server = PhoneServer("<html>controle</html>", "console.log('controle')", { listOf("127.0.0.1") },
            { _, _, offset -> JSONObject().put("items", org.json.JSONArray()).put("nextCursor", if (offset == 0) "50" else JSONObject.NULL) },
            { id, _ -> calls++; server.acknowledge(id, true, "") }, { time })
        server.start(2000, true)
    }
    @After fun close() { server.stop() }
    private fun request(path: String, body: JSONObject? = null, token: String? = null, origin: String? = null): Pair<Int, String> {
        val url = "http://127.0.0.1:" + server.listeningPort
        val connection = URL(url + path).openConnection() as HttpURLConnection
        connection.connectTimeout = 3000; connection.readTimeout = 12000
        if (token != null) connection.setRequestProperty("X-LouvorVisual-Token", token)
        if (body != null) {
            connection.requestMethod = "POST"; connection.doOutput = true
            connection.setRequestProperty("Origin", origin ?: url)
            connection.setRequestProperty("Content-Type", "application/json")
            val bytes = body.toString().toByteArray()
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
        }
        val status = connection.responseCode
        val text = (if (status >= 400) connection.errorStream else connection.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
        connection.disconnect()
        return status to text
    }
    private fun pair(): String {
        val result = request("/pair", JSONObject().put("code", server.connection().getString("code")))
        assertEquals(200, result.first)
        return JSONObject(result.second).getString("token")
    }
    private fun next(id: String = UUID.randomUUID().toString()) = JSONObject().put("id", id).put("command", JSONObject().put("type", "next").put("sessionId", sessionId))
    @Test fun pairingGuardsLibraryAndCommands() {
        assertEquals(200, request("/").first)
        assertEquals(401, request("/library?kind=songs").first)
        assertEquals(401, request("/command", next()).first)
        assertEquals(401, request("/pair", JSONObject().put("code", "invalid")).first)
        val token = pair()
        assertEquals(200, request("/library?kind=songs", token = token).first)
        assertEquals(200, request("/command", next(), token).first)
        assertEquals(1, calls)
        assertTrue(server.connection().getBoolean("connected"))
    }
    @Test fun foreignOriginsAndUnsupportedPayloadsAreRejected() {
        val token = pair()
        assertEquals(403, request("/command", next(), token, "https://example.com").first)
        val invalid = next().apply { getJSONObject("command").put("type", "files.read") }
        assertEquals(400, request("/command", invalid, token).first)
        assertEquals(0, calls)
        assertEquals(404, request("/assets/audio.mp3", token = token).first)
    }
    @Test fun retriesWithTheSameIdDoNotAdvanceTwice() {
        val token = pair(); val command = next()
        assertEquals(200, request("/command", command, token).first)
        assertEquals(200, request("/command", command, token).first)
        assertEquals(1, calls)
        command.getJSONObject("command").put("type", "previous")
        assertEquals(400, request("/command", command, token).first)
    }
    @Test fun backgroundDoesNotAcceptCommands() {
        val token = pair(); server.foreground = false
        assertEquals(409, request("/command", next(), token).first)
        assertFalse(JSONObject(request("/status", token = token).second).getBoolean("foreground"))
        assertEquals(0, calls)
    }
    @Test fun codeExpires() {
        time += 600001
        assertEquals(403, request("/pair", JSONObject().put("code", "123456")).first)
    }
    @Test fun guessingCodeIsRateLimited() {
        repeat(5) { assertEquals(401, request("/pair", JSONObject().put("code", "bad")).first) }
        assertEquals(429, request("/pair", JSONObject().put("code", "bad")).first)
        time += 60001
        assertEquals(401, request("/pair", JSONObject().put("code", "bad")).first)
    }
    @Test fun publishesOnlyTheExplicitPresentationFields() {
        val token = pair()
        val state = JSONObject(PhoneServer.IDLE).put("sessionId", sessionId).put("phase", "running").put("title", "Louvor").put("text", "Letra").put("total", 2)
        assertTrue(PhoneServer.validPresentation(state))
        server.publish(state)
        val received = JSONObject(request("/status", token = token).second).getJSONObject("presentation")
        assertEquals("Letra", received.getString("text"))
        assertFalse(PhoneServer.validPresentation(state.put("notes", "privado")))
    }
}
