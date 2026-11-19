import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const runnerMirror = "mirror+file:/etc/apt/apt-mirrors.txt";
const officialMirrors = [
  "https://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
  "https://archive.ubuntu.com/ubuntu/\tpriority:2",
  "https://security.ubuntu.com/ubuntu/\tpriority:3",
  "",
].join("\n");
const officialMirrorPattern =
  /^https?:\/\/(?:(?:(?:[a-z]{2}|azure)\.)?archive\.ubuntu\.com|security\.ubuntu\.com|[a-z]{2}(?:-[a-z]+)+-\d+\.ec2\.archive\.ubuntu\.com)\/ubuntu\/?$/;

/** Replace supported URI fields while preserving all other Deb822 bytes. */
function officialSources(contents, selection) {
  let found = false;
  let stanzaHasUri = false;
  let uriContinuation = false;
  const unsupported = (reason) => new Error(`Unsupported Ubuntu mirror configuration: ${reason}.`);
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
        if (uriContinuation) throw unsupported("continued URI");
      } else if (/^uris:/i.test(text)) {
        const uri = text.slice(text.indexOf(":") + 1).trim();
        if (stanzaHasUri) throw unsupported("duplicate URI field");
        if (uri !== runnerMirror && !officialMirrorPattern.test(uri))
          throw unsupported("unrecognized URI value");
        found = true;
        stanzaHasUri = true;
        uriContinuation = true;
        return line.replace(uri, selection);
      } else {
        uriContinuation = false;
      }
      return line;
    })
    .join("");
  if (!found) throw unsupported("no URI fields");
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
  officialSources(contents, runnerMirror);
  const directory = mkdtempSync(join(tmpdir(), "ci-fonts-"));
  try {
    const sourceFile = join(directory, "ubuntu.sources");
    const mirrorsFile = join(directory, "ubuntu-mirrors.txt");
    const sourceParts = join(directory, "empty-sourceparts");
    const sources = officialSources(contents, `mirror+${pathToFileURL(mirrorsFile).href}`);
    chmodSync(directory, 0o755);
    mkdirSync(sourceParts, { mode: 0o755 });
    writeFileSync(sourceFile, sources, { mode: 0o644 });
    writeFileSync(mirrorsFile, officialMirrors, { mode: 0o644 });
    chmodSync(sourceParts, 0o755);
    chmodSync(sourceFile, 0o644);
    chmodSync(mirrorsFile, 0o644);
    const options = [
      "-o",
      "Acquire::Retries=1",
      "-o",
      "Acquire::http::Timeout=15",
      "-o",
      "Acquire::https::Timeout=15",
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
