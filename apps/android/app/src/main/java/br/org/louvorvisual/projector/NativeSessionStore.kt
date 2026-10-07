package br.org.louvorvisual.projector

import android.content.Context
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Tokens ficam cifrados com chave Android Keystore e nunca entram na ponte WebView. */
internal class NativeSessionStore(context: Context) {
    private val preferences=context.getSharedPreferences("native-session",Context.MODE_PRIVATE)
    private val alias="louvorvisual-session-v1"
    data class Tokens(val access:String,val refresh:String)

    fun tokens():Tokens? { val access=read("access")?:return null; val refresh=read("refresh")?:return null; return Tokens(access,refresh) }
    fun save(access:String,refresh:String) { preferences.edit().putString("access",encrypt(access)).putString("refresh",encrypt(refresh)).apply() }
    fun clear() { preferences.edit().clear().apply() }

    private fun key():SecretKey { val keys=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }; (keys.getKey(alias,null) as? SecretKey)?.let { return it }; return KeyGenerator.getInstance("AES","AndroidKeyStore").apply { init(android.security.keystore.KeyGenParameterSpec.Builder(alias,android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).build()) }.generateKey() }
    private fun encrypt(value:String):String { val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());return Base64.encodeToString(cipher.iv,Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8)),Base64.NO_WRAP) }
    private fun read(name:String):String? { val encoded=preferences.getString(name,null)?:return null; val parts=encoded.split(':',limit=2); if(parts.size!=2)return null; return runCatching { val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8) }.getOrNull() }
}
