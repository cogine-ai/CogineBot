import Foundation

/// The trusted anchor comes from this running app's OS-assigned home, never from
/// the selected URL. Security-scoped authorization is still checked separately.
enum BackupFolderBoundary {
  static func isLocalDocuments(_ candidate: URL, appHome: URL) -> Bool {
    guard candidate.isFileURL, appHome.isFileURL else { return false }
    let home = appHome.resolvingSymlinksInPath().standardizedFileURL
    // Fail closed if the running system does not have this container layout.
    guard UUID(uuidString: home.lastPathComponent) != nil else { return false }
    let containerRoot = home.deletingLastPathComponent().pathComponents
    guard containerRoot.suffix(3) == ["Containers", "Data", "Application"] else { return false }
    let parts = candidate.resolvingSymlinksInPath().standardizedFileURL.pathComponents
    let rootCount = containerRoot.count
    guard parts.count >= rootCount + 2,
      Array(parts.prefix(rootCount)) == containerRoot,
      UUID(uuidString: parts[rootCount]) != nil,
      parts[rootCount + 1] == "Documents" else { return false }
    return true
  }
}
