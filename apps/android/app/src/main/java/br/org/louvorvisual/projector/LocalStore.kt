package br.org.louvorvisual.projector

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.io.File

/** SQLite privado: todo dado é particionado pelo perfil, mesmo no MVP pessoal. */
internal class LocalStore(context: Context) : SQLiteOpenHelper(context, "louvorvisual.db", null, 1) {
    private val root = File(context.filesDir, "louvorvisual")
    val profileId = "personal"
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE documents(profile TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(profile,type,id))")
        db.execSQL("CREATE TABLE preferences(profile TEXT PRIMARY KEY,body TEXT NOT NULL)")
        db.execSQL("CREATE TABLE sessions(profile TEXT PRIMARY KEY,id TEXT NOT NULL,snapshot TEXT NOT NULL,checkpoint TEXT,context TEXT NOT NULL,saved_at TEXT)")
        db.execSQL("CREATE TABLE imports(profile TEXT NOT NULL,id TEXT NOT NULL,file TEXT NOT NULL,preview TEXT NOT NULL,PRIMARY KEY(profile,id))")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    fun prefs(): JSONObject = readableDatabase.rawQuery("SELECT body FROM preferences WHERE profile=?", arrayOf(profileId)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else JSONObject("{\"rotation\":0,\"safeAreaPercent\":0,\"recentSetlistId\":null}") }
    fun setPrefs(patch: JSONObject): JSONObject = synchronized(this) { val value=prefs(); patch.keys().forEach { value.put(it,patch.get(it)) }; writableDatabase.execSQL("INSERT OR REPLACE INTO preferences(profile,body) VALUES(?,?)",arrayOf(profileId,value.toString())); value }
    fun putDocument(type:String,id:String,body:String) = writableDatabase.execSQL("INSERT OR REPLACE INTO documents(profile,type,id,body) VALUES(?,?,?,?)",arrayOf(profileId,type,id,body))
    fun document(type:String,id:String):JSONObject? = readableDatabase.rawQuery("SELECT body FROM documents WHERE profile=? AND type=? AND id=?",arrayOf(profileId,type,id)).use { if(it.moveToFirst()) JSONObject(it.getString(0)) else null }
    fun list(type:String):List<JSONObject> = readableDatabase.rawQuery("SELECT body FROM documents WHERE profile=? AND type=? ORDER BY id",arrayOf(profileId,type)).use { c -> buildList { while(c.moveToNext()) add(JSONObject(c.getString(0))) } }
    fun createSession(id:String,snapshot:JSONObject,context:JSONObject) = writableDatabase.execSQL("INSERT OR REPLACE INTO sessions(profile,id,snapshot,checkpoint,context,saved_at) VALUES(?,?,?,?,?,NULL)",arrayOf(profileId,id,snapshot.toString(),null,context.toString()))
    fun checkpoint(id:String,checkpoint:JSONObject,now:String) = writableDatabase.execSQL("UPDATE sessions SET checkpoint=?,saved_at=? WHERE profile=? AND id=?",arrayOf(checkpoint.toString(),now,profileId,id))
    fun recoverable():JSONObject? = readableDatabase.rawQuery("SELECT id,snapshot,checkpoint,context,saved_at FROM sessions WHERE profile=?",arrayOf(profileId)).use { c -> if(!c.moveToFirst()) null else JSONObject().put("sessionId",c.getString(0)).put("snapshot",JSONObject(c.getString(1))).put("checkpoint",c.getString(2)?.let(::JSONObject)).put("context",JSONObject(c.getString(3))).put("savedAt",c.getString(4)) }
    fun endSession(id:String) = writableDatabase.execSQL("DELETE FROM sessions WHERE profile=? AND id=?",arrayOf(profileId,id))
    fun stagingFile(id:String)=File(root,"staging/$profileId/$id.zip").also { it.parentFile?.mkdirs() }
    fun importDocumentFile(importId:String,path:String)=File(root,"staging/$profileId/$importId/documents/$path").also { it.parentFile?.mkdirs() }
    fun mediaFile(sha:String)=File(root,"media/$profileId/$sha").also { it.parentFile?.mkdirs() }
    fun rememberImport(id:String,file:File,preview:JSONObject)=writableDatabase.execSQL("INSERT OR REPLACE INTO imports(profile,id,file,preview) VALUES(?,?,?,?)",arrayOf(profileId,id,file.absolutePath,preview.toString()))
    fun importFile(id:String):File?=readableDatabase.rawQuery("SELECT file FROM imports WHERE profile=? AND id=?",arrayOf(profileId,id)).use { if(it.moveToFirst()) File(it.getString(0)) else null }
    fun discardImport(id:String){ importFile(id)?.delete(); File(root,"staging/$profileId/$id").deleteRecursively(); writableDatabase.execSQL("DELETE FROM imports WHERE profile=? AND id=?",arrayOf(profileId,id)) }
}
