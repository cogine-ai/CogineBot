import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

private struct FolderFailure: Error {}
private struct FolderEntry: Equatable {
  let path: String
  let url: URL
  let size: Int
  let modified: Date
}
private final class FolderSession {
  let root: URL
  let entries: [FolderEntry]
  let limits: [String: Int]
  var consumed = 0
  init(root: URL, entries: [FolderEntry], limits: [String: Int]) {
    self.root = root
    self.entries = entries
    self.limits = limits
  }
  deinit { root.stopAccessingSecurityScopedResource() }
}
private final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  let finish: ([URL]?) -> Void
  init(finish: @escaping ([URL]?) -> Void) { self.finish = finish }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls) }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }
}

public class RakazoBackupFolderModule: Module {
  private let worker = DispatchQueue(label: "rakazo.backup-folder")
  private var sessions: [String: FolderSession] = [:]
  private var pickerDelegate: FolderPickerDelegate?

  public func definition() -> ModuleDefinition {
    Name("RakazoBackupFolder")
    AsyncFunction("pick") { (limits: [String: Int], promise: Promise) in
      guard self.pickerDelegate == nil,
        let controller = self.appContext?.utilities?.currentViewController(),
        ["entries", "fileBytes", "readBytes"].allSatisfy({ (limits[$0] ?? 0) > 0 })
      else { throw FolderFailure() }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
      picker.allowsMultipleSelection = false
      let delegate = FolderPickerDelegate { urls in
        guard self.pickerDelegate != nil else { return }
        self.pickerDelegate = nil
        guard let urls else { promise.resolve(nil as String?); return }
        self.worker.async {
          do {
            guard urls.count == 1, let root = urls.first,
              root.startAccessingSecurityScopedResource() else { throw FolderFailure() }
            var owned = false
            defer { if !owned { root.stopAccessingSecurityScopedResource() } }
            let entries = try self.inventory(root, limit: limits["entries"]!)
            let id = UUID().uuidString
            self.sessions[id] = FolderSession(root: root, entries: entries, limits: limits)
            owned = true
            promise.resolve(["session": id, "entries": entries.map { ["path": $0.path, "size": $0.size] }])
          } catch { promise.reject("folder_unreadable", "folder_unreadable") }
        }
      }
      self.pickerDelegate = delegate
      picker.delegate = delegate
      controller.present(picker, animated: true)
      picker.presentationController?.delegate = delegate
    }.runOnQueue(.main)

    AsyncFunction("read") { (id: String, path: String, maxBytes: Int) -> [UInt8] in
      guard let session = self.sessions[id], let entry = session.entries.first(where: { $0.path == path }),
        maxBytes > 0, maxBytes <= session.limits["fileBytes"]! + 1 else { throw FolderFailure() }
      return try self.coordinated(entry.url) { url in
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard values.isSymbolicLink == false, values.isRegularFile == true else { throw FolderFailure() }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while data.count < maxBytes {
          let chunk = try handle.read(upToCount: min(65536, maxBytes - data.count)) ?? Data()
          if chunk.isEmpty { break }
          session.consumed += chunk.count
          guard session.consumed <= session.limits["readBytes"]! else { throw FolderFailure() }
          data.append(chunk)
        }
        guard data.count == entry.size else { throw FolderFailure() }
        return Array(data)
      }
    }.runOnQueue(worker)

    AsyncFunction("verify") { (id: String) in
      guard let session = self.sessions[id],
        try self.inventory(session.root, limit: session.limits["entries"]!) == session.entries
      else { throw FolderFailure() }
      session.consumed = 0
    }.runOnQueue(worker)

    AsyncFunction("close") { (id: String) -> Void in self.sessions.removeValue(forKey: id) }
      .runOnQueue(worker)
    OnDestroy { self.worker.async { self.sessions.removeAll() } }
  }

  private func coordinated<T>(_ url: URL, read: (URL) throws -> T) throws -> T {
    var coordinationError: NSError?
    var result: Result<T, Error>?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { value in
      result = Result { try read(value) }
    }
    if let coordinationError { throw coordinationError }
    guard let result else { throw FolderFailure() }
    return try result.get()
  }

  private func isLocalDocuments(_ url: URL) -> Bool {
    let parts = url.standardizedFileURL.pathComponents
    guard let index = parts.firstIndex(of: "Application"), index >= 2,
      parts[index - 2] == "Containers", parts[index - 1] == "Data",
      parts.count > index + 2 else { return false }
    return parts[index + 2] == "Documents"
  }

  private func inventory(_ root: URL, limit: Int) throws -> [FolderEntry] {
    try coordinated(root) { directory in
      // Cloud/file-provider completeness is not certified by this adapter. Use an archive there.
      let rootValues = try directory.resourceValues(forKeys: [.volumeIsLocalKey, .isUbiquitousItemKey])
      guard rootValues.volumeIsLocal == true, rootValues.isUbiquitousItem != true,
        self.isLocalDocuments(directory) else { throw FolderFailure() }
      let rootKind = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard rootKind.isDirectory == true, rootKind.isSymbolicLink == false else { throw FolderFailure() }
      var entries: [FolderEntry] = []
      var count = 0
      var failed = false
      // Enumerate lazily: an oversized directory must not first allocate an unbounded URL array.
      // No hidden/package skips: the complete dependency inventory is required.
      guard let enumerator = FileManager.default.enumerator(
        at: directory, includingPropertiesForKeys: nil, options: [],
        errorHandler: { _, _ in failed = true; return false }
      ) else { throw FolderFailure() }
      while let url = enumerator.nextObject() as? URL {
        count += 1
        guard count <= limit, enumerator.level <= 64, !failed,
          url.path.hasPrefix(directory.path + "/") else { throw FolderFailure() }
        let values = try url.resourceValues(forKeys: [
          .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
          .contentModificationDateKey, .isUbiquitousItemKey,
        ])
        guard values.isSymbolicLink == false, values.isUbiquitousItem != true else { throw FolderFailure() }
        let path = directory.lastPathComponent + url.path.dropFirst(directory.path.count)
        guard !path.contains("\\"), !path.contains("\0") else { throw FolderFailure() }
        if values.isDirectory != true {
          guard values.isRegularFile == true, let size = values.fileSize, size >= 0,
            let modified = values.contentModificationDate else { throw FolderFailure() }
          entries.append(FolderEntry(path: path, url: url, size: size, modified: modified))
        }
      }
      guard !failed else { throw FolderFailure() }
      return entries.sorted { $0.path < $1.path }
    }
  }
}
