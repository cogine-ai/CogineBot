package com.rakazo.backupfolder

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.toCodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executors

private const val PICK_FOLDER = 9156
private val columns = arrayOf(
  DocumentsContract.Document.COLUMN_DOCUMENT_ID,
  DocumentsContract.Document.COLUMN_DISPLAY_NAME,
  DocumentsContract.Document.COLUMN_MIME_TYPE,
  DocumentsContract.Document.COLUMN_SIZE,
  DocumentsContract.Document.COLUMN_LAST_MODIFIED,
  DocumentsContract.Document.COLUMN_FLAGS,
)
private data class Entry(val path: String, val id: String, val size: Long, val modified: Long)
private data class Session(
  val root: Uri, val entries: List<Entry>, val limit: Int, val fileBytes: Int, val readBytes: Int,
  var consumed: Long = 0,
)

class RakazoBackupFolderModule : Module() {
  private val worker = Executors.newSingleThreadExecutor()
  private val sessions = mutableMapOf<String, Session>()
  private var pending: Promise? = null
  private var limits = listOf(0, 0, 0)
  private val resolver get() = requireNotNull(appContext.reactContext).contentResolver

  override fun definition() = ModuleDefinition {
    Name("RakazoBackupFolder")
    AsyncFunction("pick") { options: Map<String, Int>, promise: Promise ->
      check(pending == null) { "folder_busy" }
      limits = listOf(options.getValue("entries"), options.getValue("fileBytes"), options.getValue("readBytes"))
      require(limits.all { it > 0 })
      pending = promise
      try {
        appContext.throwingActivity.startActivityForResult(
          Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
          PICK_FOLDER,
        )
      } catch (error: Exception) {
        pending = null
        throw error
      }
    }
    OnActivityResult { _, (requestCode, resultCode, intent) ->
      if (requestCode == PICK_FOLDER) {
        val promise = pending
        val selectedLimits = limits
        pending = null
        if (promise != null) {
          if (resultCode == Activity.RESULT_CANCELED) promise.resolve(null)
          else execute(promise) {
            check(resultCode == Activity.RESULT_OK) { "folder_unreadable" }
            val selection = requireNotNull(intent)
            val root = requireNotNull(selection.data)
            // Other providers can return paginated/filtered inventories without a completeness contract.
            check(root.authority == "com.android.externalstorage.documents") { "folder_provider_unsupported" }
            check((selection.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) { "folder_permission" }
            val entries = inventory(root, selectedLimits[0])
            val id = UUID.randomUUID().toString()
            sessions[id] = Session(root, entries, selectedLimits[0], selectedLimits[1], selectedLimits[2])
            mapOf("session" to id, "entries" to entries.map { mapOf("path" to it.path, "size" to it.size) })
          }
        }
      }
    }
    AsyncFunction("read") { id: String, path: String, maxBytes: Int, promise: Promise ->
      execute(promise) {
        val session = requireNotNull(sessions[id])
        val entry = session.entries.single { it.path == path }
        require(maxBytes > 0 && maxBytes <= session.fileBytes + 1)
        val uri = DocumentsContract.buildDocumentUriUsingTree(session.root, entry.id)
        val bytes = resolver.openInputStream(uri).use { stream ->
          requireNotNull(stream)
          val output = ByteArrayOutputStream()
          val buffer = ByteArray(minOf(65536, maxBytes))
          while (output.size() < maxBytes) {
            val count = stream.read(buffer, 0, minOf(buffer.size, maxBytes - output.size()))
            if (count < 0) break
            check(count > 0) { "folder_unreadable" }
            session.consumed += count
            check(session.consumed <= session.readBytes) { "folder_too_large" }
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        }
        check(bytes.size.toLong() == entry.size) { "folder_changed" }
        bytes.map { it.toInt() and 255 }
      }
    }
    AsyncFunction("verify") { id: String, promise: Promise ->
      execute(promise) {
        val session = requireNotNull(sessions[id])
        check(inventory(session.root, session.limit) == session.entries) { "folder_changed" }
        // A new shared read operation (e.g. explicit credential opt-in) has its own byte budget.
        session.consumed = 0
        null
      }
    }
    AsyncFunction("close") { id: String, promise: Promise ->
      execute(promise) { sessions.remove(id); null }
    }
    OnDestroy {
      worker.execute { sessions.clear() }
      worker.shutdown()
    }
  }

  private fun execute(promise: Promise, action: () -> Any?) {
    worker.execute {
      try { promise.resolve(action()) } catch (error: Exception) { promise.reject(error.toCodedException()) }
    }
  }

  private fun inventory(root: Uri, limit: Int): List<Entry> {
    val rootId = DocumentsContract.getTreeDocumentId(root)
    val rootUri = DocumentsContract.buildDocumentUriUsingTree(root, rootId)
    val rootName = resolver.query(rootUri, columns, null, null, null).use { cursor ->
      check(cursor != null && cursor.moveToFirst()) { "folder_unreadable" }
      check(cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR)
      cursor.getString(1)
    }
    fun validName(name: String) = name.isNotEmpty() && name != "." && name != ".." &&
      !name.contains('/') && !name.contains('\\') && !name.contains('\u0000')
    check(validName(rootName))
    val result = mutableListOf<Entry>()
    val seen = mutableSetOf(rootId)
    var count = 0
    fun walk(id: String, path: String, depth: Int) {
      check(depth <= 64) { "folder_too_deep" }
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(root, id)
      resolver.query(children, columns, null, null, null).use { cursor ->
        check(cursor != null) { "folder_unreadable" }
        check(!cursor.extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) { "folder_incomplete" }
        check(cursor.extras.getString(DocumentsContract.EXTRA_ERROR) == null) { "folder_incomplete" }
        while (cursor.moveToNext()) {
          check(++count <= limit) { "folder_too_large" }
          val childId = cursor.getString(0)
          val name = cursor.getString(1)
          check(validName(name) && seen.add(childId)) { "folder_ambiguous" }
          val childPath = "$path/$name"
          if (cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) walk(childId, childPath, depth + 1)
          else {
            check(!cursor.isNull(3) && !cursor.isNull(4)) { "folder_incomplete" }
            check((cursor.getInt(5) and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) == 0) { "folder_unreadable" }
            val size = cursor.getLong(3)
            check(size >= 0)
            result.add(Entry(childPath, childId, size, cursor.getLong(4)))
          }
        }
        check(!cursor.extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) { "folder_incomplete" }
        check(cursor.extras.getString(DocumentsContract.EXTRA_ERROR) == null) { "folder_incomplete" }
      }
    }
    walk(rootId, rootName, 0)
    return result.sortedBy { it.path }
  }
}
