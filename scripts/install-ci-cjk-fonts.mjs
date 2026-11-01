import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runnerMirror = "mirror+file:/etc/apt/apt-mirrors.txt";
const officialArchive = "https://archive.ubuntu.com/ubuntu";

/** Replace supported URI fields while preserving all other Deb822 bytes. */
function officialSources(contents) {
  let found = false;
  let stanzaHasUri = false;
  let uriContinuation = false;
  const unsupported = () => new Error("Unsupported Ubuntu mirror configuration.");
  const rewritten = contents
    .split(/(?<=\n)/)
    .map((line) => {
      const text = line.replace(/[\r\n]+$/, "");
      if (/^\s*$/.test(text)) {
        stanzaHasUri = false;
        uriContinuation = false;
      } else if (text.startsWith("#")) {
        // Comments do not end a field's continuation context.
      } else if (/^[ \t]/.test(text)) {
        if (uriContinuation) throw unsupported();
      } else if (/^uris:/i.test(text)) {
        if (stanzaHasUri || text.slice(text.indexOf(":") + 1).trim() !== runnerMirror) {
          throw unsupported();
        }
        found = true;
        stanzaHasUri = true;
        uriContinuation = true;
        return line.replace(runnerMirror, officialArchive);
      } else {
        uriContinuation = false;
      }
      return line;
    })
    .join("");
  if (!found) throw unsupported();
  return rewritten;
}

/** Install fonts through a temporary source selection, then remove that configuration. */
function main() {
  if (process.argv.length !== 3) throw new Error("Expected one readable Ubuntu sources file.");
  let contents;
  try {
    contents = readFileSync(process.argv[2], "utf8");
  } catch {
    throw new Error("Expected one readable Ubuntu sources file.");
  }
  // Validate the complete input before creating configuration or calling APT.
  const sources = officialSources(contents);
  const directory = mkdtempSync(join(tmpdir(), "ci-fonts-"));
  try {
    const sourceFile = join(directory, "ubuntu.sources");
    const sourceParts = join(directory, "empty-sourceparts");
    chmodSync(directory, 0o755);
    mkdirSync(sourceParts, { mode: 0o755 });
    writeFileSync(sourceFile, sources, { mode: 0o644 });
    chmodSync(sourceParts, 0o755);
    chmodSync(sourceFile, 0o644);
    const options = [
      "-o",
      "Acquire::Retries=2",
      "-o",
      "Acquire::http::Timeout=20",
      "-o",
      "Acquire::https::Timeout=20",
      "-o",
      "APT::Get::List-Cleanup=0",
      "-o",
      "Dir::Etc::sourcelist=" + sourceFile,
      "-o",
      "Dir::Etc::sourceparts=" + sourceParts,
    ];
    for (const command of [
      ["update"],
      ["install", "--yes", "--no-install-recommends", "fonts-noto-cjk"],
    ]) {
      const result = spawnSync("sudo", ["apt-get", ...options, ...command], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
