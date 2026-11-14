import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Executes the production Foundation-only predicate. This does not build the
// Expo/iOS module or exercise an iOS picker, grant, or provider.
it.skipIf(process.platform !== "darwin")(
  "anchors local Documents to the runtime app container root",
  () => {
    const temporary = mkdtempSync(join(tmpdir(), "backup-folder-boundary-"));
    try {
      const main = join(temporary, "main.swift");
      const binary = join(temporary, "boundary-test");
      const source = fileURLToPath(
        new URL("../modules/rakazo-backup-folder/ios/BackupFolderBoundary.swift", import.meta.url),
      );
      writeFileSync(
        main,
        `
import Foundation
let id = "11111111-1111-4111-8111-111111111111"
let other = "22222222-2222-4222-8222-222222222222"
let root = "/fixture/runtime/Containers/Data/Application"
let home = URL(fileURLWithPath: root + "/" + id, isDirectory: true)
let cases: [(String, Bool)] = [
  (root + "/" + id + "/Documents", true),
  (root + "/" + other + "/Documents/backup", true),
  (root + "/" + id + "/Library/backup", false),
  (root + "/" + id + "/Documents-copy/backup", false),
  (root + "/fake-id/Documents/backup", false),
  ("/fixture/runtime/Containers/Shared/group/Containers/Data/Application/" + other + "/Documents/backup", false),
  ("/arbitrary/Containers/Data/Application/" + other + "/Documents/backup", false),
  (root + "-other/" + other + "/Documents/backup", false),
  (root + "/" + id + "/Documents/../../../../Shared/group/backup", false),
  ("/fixture/runtime/Containers/Shared/group/backup", false)
]
for (path, expected) in cases {
  precondition(BackupFolderBoundary.isLocalDocuments(URL(fileURLWithPath: path), appHome: home) == expected)
}
precondition(!BackupFolderBoundary.isLocalDocuments(URL(string: "https://example.test/backup")!, appHome: home))
precondition(!BackupFolderBoundary.isLocalDocuments(URL(fileURLWithPath: root + "/" + id + "/Documents"), appHome: URL(fileURLWithPath: "/unexpected/home")))
print("12 boundary cases passed")
`,
      );
      const compiled = spawnSync("swiftc", [source, main, "-o", binary], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(compiled.status, compiled.stderr).toBe(0);
      const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout.trim()).toBe("12 boundary cases passed");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
