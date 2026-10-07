package br.org.louvorvisual.projector

import android.content.ContentResolver
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipInputStream

/** O ZIP já fica em staging privado. Mídia é sempre conferida e copiada em blocos de 64 KiB. */
internal class PackageImporter(private val store: LocalStore) {
    data class Ready(val id:String,val name:String,val preview:JSONObject)
    private data class Document(val type:String,val id:String,val json:JSONObject)
    private data class Hash(val size:Long,val sha:String)
    private val maxPackage=2L*1024*1024*1024; private val maxEntries=1000; private val maxDocument=1024L*1024; private val maxAsset=100L*1024*1024

    fun stage(resolver:ContentResolver,uri:Uri,name:String):Ready {
        val id=UUID.randomUUID().toString(); val target=store.stagingFile(id); var total=0L
        try { resolver.openInputStream(uri)?.use { input -> target.outputStream().use { output -> val b=ByteArray(65536); while(true){ val n=input.read(b); if(n<0)break; total+=n; require(total<=maxPackage){"too-large"}; output.write(b,0,n) } } } ?: error("unreadable")
            val preview=verify(target); store.rememberImport(id,target,preview); return Ready(id,name.take(255),preview)
        } catch(error:Exception) { target.delete(); throw error }
    }

    private fun manifest(file:File):JSONObject {
        ZipInputStream(file.inputStream().buffered()).use { zip -> while(true) { val entry=zip.nextEntry?:break; require(entry.name.safe()){"unsafe-path"}; if(entry.name=="manifest.json") return JSONObject(String(zip.readBytesLimited(maxDocument))) } }
        error("manifest-missing")
    }

    private fun verify(file:File):JSONObject {
        val manifest=manifest(file); validateManifest(manifest)
        val listed=manifest.getJSONArray("entries"); val expected=HashMap<String,JSONObject>(); for(i in 0 until listed.length()) { val item=listed.getJSONObject(i); val path=item.getString("path"); require(path.safe()&&expected.put(path,item)==null){"manifest-invalid"}; canonical(item,path) }
        val documents=ArrayList<Document>(); val seen=HashSet<String>(); var count=0; var media=0L
        ZipInputStream(file.inputStream().buffered()).use { zip -> while(true) { val entry=zip.nextEntry?:break; count++; require(count<=maxEntries){"too-large"}; require(entry.name.safe()&&seen.add(entry.name)){"unsafe-path"}; if(entry.name=="manifest.json") { zip.readAndHash(maxDocument); continue }
            val item=expected[entry.name]?:error("unexpected-file"); val limit=if(item.getString("kind")=="media") maxAsset else maxDocument; val content=if(item.getString("kind")=="document") zip.readBytesLimited(limit) else null
            val checked=if(content!=null) Hash(content.size.toLong(),sha(content)) else zip.readAndHash(limit)
            require(checked.size==item.getLong("byteSize")&&checked.sha.equals(item.getString("sha256"),true)){"hash-mismatch"}
            if(item.getString("kind")=="document") documents += validateDocument(item,content!!) else media+=checked.size
        } }
        require(seen.contains("manifest.json")&&expected.keys.all(seen::contains)){"missing-file"}; validateReferences(manifest,documents)
        return JSONObject().put("title",manifest.getJSONObject("scope").optString("title")).put("sameWorkspace",false).put("songs",documents.count { it.type=="song" }).put("newDocuments",documents.size).put("existingDocuments",0).put("copiedDocuments",0).put("mediaBytes",media).put("newMediaBytes",media).put("omittedMedia",manifest.optJSONArray("omittedMedia")?.length()?:0)
    }

    fun apply(id:String):String {
        val input=store.importFile(id)?:error("not-found"); val docs=ArrayList<Pair<String,File>>(); val media=ArrayList<Pair<File,File>>(); var setlist:String?=null
        try { ZipInputStream(input.inputStream().buffered()).use { zip -> while(true) { val entry=zip.nextEntry?:break; when { entry.name.startsWith("documents/") -> { val target=store.importDocumentFile(id,entry.name); zip.copyAndHash(target,maxDocument); val json=JSONObject(target.readText()); val type=entry.name.split('/').getOrNull(1)?:error("document-invalid"); require(json.getString("id")==entry.name.substringAfterLast('/').removeSuffix(".json")){"document-invalid"}; docs += type to target; if(type=="setlist") setlist=json.getString("id") }
                    entry.name.startsWith("media/") -> { val hash=entry.name.removePrefix("media/"); val final=store.mediaFile(hash); val temporary=File(final.parentFile,".$hash.${UUID.randomUUID()}.part"); val checked=zip.copyAndHash(temporary,maxAsset); require(checked.sha.equals(hash,true)){"hash-mismatch"}; media += temporary to final }
                } } }
            media.forEach { (temporary,final) -> if(!final.isFile) require(temporary.renameTo(final)){"storage"} else temporary.delete() }
            val db=store.writableDatabase; db.beginTransaction(); try { docs.forEach { (type,file) -> val json=file.readText(); store.putDocument(type,JSONObject(json).getString("id"),json) }; db.setTransactionSuccessful() } finally { db.endTransaction() }
            store.discardImport(id); return setlist?:error("reference-broken")
        } catch(error:Exception) { media.forEach { (temporary,_)->temporary.delete() }; throw error }
        finally { docs.forEach { (_,file)->file.delete() } }
    }

    private fun validateManifest(manifest:JSONObject) {
        require(manifest.optString("format")=="louvorvisual-package"){"manifest-invalid"}; require(manifest.optInt("formatVersion")==1&&manifest.optInt("minReaderVersion")<=1){"format-too-new"}; require(manifest.has("schemaVersion")){"manifest-invalid"}; val schemaVersion=manifest.optInt("schemaVersion"); when { schemaVersion==1->Unit; schemaVersion>1->error("schema-too-new"); else->error("schema-unsupported") }; require(manifest.optString("fontPackVersion")=="1"){"font-pack-incompatible"}; require(manifest.optJSONObject("scope")?.optString("kind")=="setlist"&&manifest.optJSONObject("origin")?.has("workspaceId")==true){"manifest-invalid"}
    }
    private fun canonical(item:JSONObject,path:String) { when(item.optString("kind")){ "document" -> require(path=="documents/${item.getString("entityType")}/${item.getString("entityId")}.json"){"manifest-invalid"}; "media" -> require(path=="media/${item.getString("sha256")}"){"manifest-invalid"}; else->error("manifest-invalid") } }
    private fun validateDocument(entry:JSONObject,bytes:ByteArray):Document { val json=try { JSONObject(String(bytes)) } catch(_:Exception) { throw IllegalArgumentException("document-invalid") }; val type=entry.getString("entityType"); require(json.optString("id")==entry.getString("entityId")&&json.has("workspaceId")&&json.optInt("schemaVersion")==1){"document-invalid"}; return Document(type,json.getString("id"),json) }
    private fun validateReferences(manifest:JSONObject,documents:List<Document>) { val byType=documents.groupBy { it.type }; val songs=byType["song"]?.map { it.id }?.toSet().orEmpty(); val arrangements=byType["arrangement"]?.associateBy { it.id }.orEmpty(); val assets=byType["asset"]?.associateBy { it.id }.orEmpty(); val themes=byType["theme"]?.map { it.id }?.toSet().orEmpty(); val setlists=byType["setlist"].orEmpty(); require(setlists.size==1&&setlists[0].id==manifest.getJSONObject("scope").getString("setlistId")){"reference-broken"}; arrangements.values.forEach { arrangement -> require(songs.contains(arrangement.json.optString("songId"))){"reference-broken"}; val bindings=arrangement.json.optJSONArray("audioBindings")?:JSONArray(); for(i in 0 until bindings.length()) require(assets.containsKey(bindings.getJSONObject(i).optString("assetId"))){"reference-broken"}; val theme=arrangement.json.optJSONObject("themeRef"); if(theme?.optString("kind")=="workspace") require(themes.contains(theme.optString("themeId"))){"reference-broken"} }; val items=setlists[0].json.optJSONArray("items")?:JSONArray(); for(i in 0 until items.length()) require(arrangements.containsKey(items.getJSONObject(i).optString("arrangementId"))){"reference-broken"} }
    private fun ZipInputStream.readAndHash(limit:Long):Hash { val digest=MessageDigest.getInstance("SHA-256"); val buffer=ByteArray(65536); var size=0L; while(true){val n=read(buffer);if(n<0)break;size+=n;require(size<=limit){"too-large"};digest.update(buffer,0,n)};return Hash(size,digest.digest().hex()) }
    private fun ZipInputStream.copyAndHash(target:File,limit:Long):Hash { target.parentFile?.mkdirs(); target.outputStream().use { output -> val digest=MessageDigest.getInstance("SHA-256");val buffer=ByteArray(65536);var size=0L;while(true){val n=read(buffer);if(n<0)break;size+=n;require(size<=limit){"too-large"};digest.update(buffer,0,n);output.write(buffer,0,n)};return Hash(size,digest.digest().hex()) } }
    private fun ZipInputStream.readBytesLimited(limit:Long):ByteArray { val out=ByteArrayOutputStream(); val buffer=ByteArray(65536);var size=0L;while(true){val n=read(buffer);if(n<0)break;size+=n;require(size<=limit){"too-large"};out.write(buffer,0,n)};return out.toByteArray() }
    private fun String.safe()=isNotBlank()&&!startsWith('/')&&!contains('\\')&&!endsWith('/')&&matches(Regex("[A-Za-z0-9._/-]{1,255}"))&&split('/').none{it==".."||it.isEmpty()}
    private fun sha(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).hex()
    private fun ByteArray.hex()=joinToString(""){"%02x".format(it)}
}
