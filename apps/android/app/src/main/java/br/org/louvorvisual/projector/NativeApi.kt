package br.org.louvorvisual.projector

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

internal class NativeApi(private val baseUrl:String) {
    data class Tokens(val access:String,val refresh:String)
    private fun endpoint(path:String)=URL(baseUrl.trimEnd('/')+path)
    fun configured()=baseUrl.startsWith("https://")||baseUrl.startsWith("http://")
    fun login(email:String,password:String):Tokens { val connection=(endpoint("/api/v1/auth/login").openConnection() as HttpURLConnection).apply { requestMethod="POST";connectTimeout=15_000;readTimeout=15_000;doOutput=true;setRequestProperty("Content-Type","application/json");setRequestProperty("X-LouvorVisual-Client-Version","0.1.0");outputStream.use { it.write(JSONObject().put("email",email).put("password",password).toString().toByteArray(StandardCharsets.UTF_8)) } }; return connection.useResponse { body -> val access=JSONObject(body).getJSONObject("data").getString("accessToken"); val refresh=connection.headerFields.entries.flatMap { it.value ?: emptyList() }.firstNotNullOfOrNull { Regex("(?:^|;)\\s*lv_refresh=([^;]+)").find(it)?.groupValues?.get(1) }?.let { URLDecoder.decode(it,"UTF-8") } ?: throw IllegalStateException("auth-required"); Tokens(access,refresh) } }
    fun refresh(refresh:String):Tokens { val connection=(endpoint("/api/v1/auth/refresh").openConnection() as HttpURLConnection).apply { requestMethod="POST";connectTimeout=15_000;readTimeout=15_000;doOutput=true;setRequestProperty("Content-Type","application/json");setRequestProperty("X-LouvorVisual-Client-Version","0.1.0");outputStream.use { it.write(JSONObject().put("refreshToken",refresh).toString().toByteArray(StandardCharsets.UTF_8)) } }; return connection.useResponse { body -> val access=JSONObject(body).getJSONObject("data").getString("accessToken"); val next=connection.headerFields.entries.flatMap { it.value ?: emptyList() }.firstNotNullOfOrNull { Regex("(?:^|;)\\s*lv_refresh=([^;]+)").find(it)?.groupValues?.get(1) }?.let { URLDecoder.decode(it,"UTF-8") } ?: refresh; Tokens(access,next) } }
    private fun <T> HttpURLConnection.useResponse(read:(String)->T):T { return try { val stream=if(responseCode in 200..299) inputStream else errorStream; val body=stream?.bufferedReader()?.use { it.readText() } ?: ""; if(responseCode !in 200..299) throw IllegalStateException(if(responseCode==401)"auth-required" else "failed"); read(body) } finally { disconnect() } }
}
