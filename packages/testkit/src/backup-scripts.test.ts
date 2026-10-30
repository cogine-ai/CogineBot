import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

type ScriptResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
const runningScripts = new Set<{ pid: number; result: Promise<ScriptResult> }>();

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Fixture writer did not reach its ready gate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const running of runningScripts) signalGroup(running.pid, "SIGKILL");
  for (const running of runningScripts) await running.result;
  runningScripts.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-backup-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "checkout with spaces");
  const snapshots = path.join(root, "snapshots");
  const bin = path.join(root, "bin");
  function nodeTool(name: string, body: string) {
    const file = path.join(bin, name);
    write(file, `#!/usr/bin/env -S node --\n${body}`);
    chmodSync(file, 0o755);
  }
  for (const script of [
    "scripts/backup.sh",
    "scripts/restore.sh",
    "infra/compose/backup-prod.sh",
  ]) {
    let source = readFileSync(path.join(repoRoot, script), "utf8");
    if (script.endsWith("backup-prod.sh")) {
      // Relocate only the fixed output directory: never write to real host backups.
      expect(source).toContain('BACKUP_ROOT="/var/backups/rakazo"');
      expect(source.split('BACKUP_ROOT="/var/backups/rakazo"')).toHaveLength(2);
      source = source.replace('BACKUP_ROOT="/var/backups/rakazo"', `BACKUP_ROOT="${snapshots}"`);
    }
    write(path.join(checkout, script), source);
  }
  write(path.join(checkout, ".env"), "EXAMPLE_SETTING=fake-value\n");
  write(path.join(root, "appdata/home.txt"), "example bot home");
  const docker = path.join(bin, "docker");
  write(
    docker,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
if (process.env.COMPOSE_PROJECT_NAME) fs.writeFileSync(process.env.PROVIDER_SCOPE, process.env.COMPOSE_PROJECT_NAME);
if (args[0] === "inspect") {
  const source = process.env.NO_MOUNT === "1" ? "" : (process.env.MOUNT_OUTPUT ?? process.env.FAKE_APPDATA);
  const output = source ? source + "\\n" : "";
  process.stdout.write(output + (args.at(-1).includes("DATA_MOUNT_END") ? "DATA_MOUNT_END\\n" : ""));
} else if (args[0] !== "compose") {
  process.exit(90);
} else if (args.includes("pg_dump")) {
  if (process.env.FAIL_DUMP === "1") process.exit(2);
  console.log("CREATE TABLE example (id integer);");
} else if (args.includes("sh")) {
  if (!args.at(-1).startsWith("pg_dump ")) process.exit(91);
  if (process.env.FAIL_DUMP === "1") process.exit(2);
  if (process.env.HOLD_DUMP === "1") {
    fs.writeFileSync(process.env.DUMP_READY, JSON.stringify({ pid: process.pid }));
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.DUMP_RELEASE)) Atomics.wait(wait, 0, 0, 10);
  }
  if (process.env.OVERSIZE_DUMP === "1") {
    fs.appendFileSync(process.env.WRITER_EVENTS, "dump\\n");
    if (fs.existsSync("/proc/self/limits")) fs.writeFileSync(process.env.DUMP_LIMITS, fs.readFileSync("/proc/self/limits"));
    let written = 0;
    while (written < 65536) written += fs.writeSync(1, Buffer.alloc(65536 - written));
  }
  console.log("fake custom-format dump");
} else if (args.includes("psql")) {
  fs.writeFileSync(process.env.SQL_INPUT, fs.readFileSync(0));
  if (process.env.FAIL_SQL === "1") {
    console.error("ERROR: relation example already exists");
    // psql normally exits successfully after SQL errors unless explicitly told to stop.
    process.exit(args.includes("--set=ON_ERROR_STOP=on") ? 3 : 0);
  }
} else if (args.includes("pg_restore")) {
  fs.readFileSync(0);
  if (process.env.FAIL_VERIFY === "1") process.exit(1);
} else if (args.includes("ps")) {
  console.log(process.env.NO_API === "1" ? "" : (process.env.API_OUTPUT ?? "example-api-container"));
} else if (!args.includes("up") && !args.includes("pg_isready")) {
  process.exit(92);
}
`,
  );
  chmodSync(docker, 0o755);
  const tar = path.join(bin, "tar");
  write(
    tar,
    `#!/bin/bash
set -eu
if [[ "$1" == "-tzf" && "\${FAIL_ARCHIVE_VERIFY:-0}" == 1 ]]; then exit 2; fi
if [[ "$1" == "-czf" && "\${OVERSIZE_ARCHIVE:-0}" == "1" ]]; then
  echo archive >> "$WRITER_EVENTS"
  if [[ -r /proc/self/limits ]]; then cat /proc/self/limits > "$ARCHIVE_LIMITS"; fi
  exec dd if=/dev/zero of="$2" bs=65536 count=1
fi
if [[ "$1" == "-czf" && "$*" == *" -C "* && -n "\${FAIL_TAR:-}" ]]; then
  echo "simulated archive read failure" >&2
  exit "$FAIL_TAR"
fi
/usr/bin/tar "$@"
if [[ "$1" == "-czf" && "\${CHANGED_TAR:-0}" == "1" ]]; then
  echo "file changed as we read it" >&2
  exit 1
fi
`,
  );
  chmodSync(tar, 0o755);
  const checksum = path.join(bin, "sha256sum");
  write(
    checksum,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const crypto = require("node:crypto");
if (process.env.FAIL_CHECKSUM === "1") process.exit(2);
for (const file of process.argv.slice(2)) {
  console.log(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") + "  " + file);
}
`,
  );
  chmodSync(checksum, 0o755);
  nodeTool(
    "df",
    `
const fs = require("node:fs");
const path = require("node:path");
let free = process.env.FREE_KB ?? "52428800";
const snapshots = process.env.SNAPSHOTS;
for (const name of fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []) {
  const current = path.join(snapshots, name);
  const pending = fs.existsSync(path.join(current, "SOURCE_SIZE_KB")) && !fs.existsSync(path.join(current, "SHA256SUMS"));
  if (pending && (process.env.LIMIT_OUTPUT === "dump" || (process.env.LIMIT_OUTPUT === "archive" && fs.existsSync(path.join(current, "rakazo.dump"))))) free = "1048584";
  if (process.env.LATE_PRESSURE === "1" && fs.existsSync(path.join(current, "SHA256SUMS.pending"))) free = "0";
}
fs.appendFileSync(process.env.METRIC_EVENTS, JSON.stringify({ tool: "df", freeKb: free }) + "\\n");
console.log("Filesystem 1024-blocks Used Available Capacity Mounted");
console.log("/dev/fake 104857600 0 " + free + " 0% /");
`,
  );
  nodeTool(
    "du",
    `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
fs.appendFileSync(process.env.DU_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const p = process.argv.at(-1);
const previous = process.env.PREVIOUS_DIR;
let size;
if (p === process.env.FAKE_APPDATA) size = process.env.FAKE_RAW_KB;
else if (p === previous) size = process.env.PREVIOUS_TOTAL_KB;
else if (p === previous + "/appdata.tgz") size = process.env.PREVIOUS_ARCHIVE_KB;
else if (p === previous + "/rakazo.dump") size = process.env.PREVIOUS_DUMP_KB;
if (size !== undefined) { fs.appendFileSync(process.env.METRIC_EVENTS, JSON.stringify({ tool: "du", path: p, sizeKb: size }) + "\\n"); console.log(size + " " + p); }
else { const result = spawnSync("/usr/bin/du", process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1); }
`,
  );
  nodeTool(
    "sync",
    `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const target = process.argv[3];
const stage = fs.statSync(target).isDirectory() ? "directory" : "files";
const snapshot = stage === "directory" ? target : path.dirname(target);
fs.appendFileSync(process.env.SYNC_EVENTS, JSON.stringify({ stage, complete: fs.existsSync(path.join(snapshot, "SHA256SUMS")), pending: fs.existsSync(path.join(snapshot, "SHA256SUMS.pending")) }) + "\\n");
if (process.env.FAIL_SYNC === stage) process.exit(1);
if (process.platform === "linux") { const result = spawnSync("/usr/bin/sync", process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1); }
`,
  );
  nodeTool("mountpoint", `process.exit(Number(process.env.MOUNT_STATUS ?? "1"));`);
  nodeTool(
    "stat",
    `
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const target = args.at(-1);
if ((args[0] === "-c" || args[0] === "-f") && args[1] === "%d" && (target === "/" || target === "/var/backups")) console.log(target === "/" ? (process.env.ROOT_DEVICE ?? "1") : (process.env.BACKUP_DEVICE ?? "1"));
else { const result = spawnSync("/usr/bin/stat", args, { stdio: "inherit" }); process.exit(result.status ?? 1); }
`,
  );
  for (const tool of ["chmod", "mv", "rm"])
    nodeTool(
      tool,
      `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const tool = ${JSON.stringify(tool)};
const args = process.argv.slice(2);
if (tool === "rm" && args.filter(arg => !arg.startsWith("-")).some(arg => { const absolute = path.resolve(arg); return absolute !== process.env.FIXTURE_ROOT && !absolute.startsWith(process.env.FIXTURE_ROOT + "/"); })) throw new Error("Deletion escaped owned fixture");
if (tool === "rm" && process.env.FAIL_HISTORY_REMOVE === "1" && args.some(arg => !arg.startsWith("-") && fs.existsSync(path.join(arg, "SHA256SUMS")))) process.exit(1);
if (tool === "chmod" && process.env.FAIL_CHMOD === "1") process.exit(1);
if (tool === "mv" && process.env.FAIL_MARKER_MOVE === "1" && path.basename(args.at(-1)) === "SHA256SUMS") process.exit(1);
const result = spawnSync("/bin/" + tool, args, { stdio: "inherit" }); process.exit(result.status ?? 1);
`,
    );
  if (process.platform === "darwin") {
    nodeTool(
      "find",
      `
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const index = args.indexOf("-regextype");
if (index !== -1) { if (args[index + 1] !== "posix-extended") process.exit(95); args.splice(index, 2); args.unshift("-E"); }
const result = spawnSync("/usr/bin/find", args, { stdio: "inherit" }); process.exit(result.status ?? 1);
`,
    );
    nodeTool(
      "flock",
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") !== "-n 8") process.exit(96);
const fd = fs.fstatSync(8), file = fs.statSync(process.env.SNAPSHOTS + "/.lock");
if (fd.dev !== file.dev || fd.ino !== file.ino) process.exit(97);
process.exit(process.env.LOCK_BUSY === "1" ? 1 : 0);
`,
    );
  }
  // No inherited deployment settings, credentials, or executable search paths.
  const env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    COMMAND_LOG: path.join(root, "commands.jsonl"),
    SQL_INPUT: path.join(root, "input.sql"),
    FAKE_APPDATA: path.join(root, "appdata"),
    FIXTURE_ROOT: root,
    SNAPSHOTS: snapshots,
    DUMP_READY: path.join(root, "dump-ready.json"),
    DUMP_RELEASE: path.join(root, "dump-release"),
    WRITER_EVENTS: path.join(root, "writers.txt"),
    DUMP_LIMITS: path.join(root, "dump-limits.txt"),
    ARCHIVE_LIMITS: path.join(root, "archive-limits.txt"),
    SYNC_EVENTS: path.join(root, "sync-events.jsonl"),
    DU_LOG: path.join(root, "du-events.jsonl"),
    PROVIDER_SCOPE: path.join(root, "provider-scope.txt"),
    METRIC_EVENTS: path.join(root, "metric-events.jsonl"),
  };
  return {
    root,
    checkout,
    snapshots,
    env,
    run(script: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
      const result = spawnSync("/bin/bash", [path.join(checkout, script), ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      const diagnostics = JSON.stringify({
        commands: existsSync(env.COMMAND_LOG)
          ? readFileSync(env.COMMAND_LOG, "utf8")
          : "not called",
        metrics: existsSync(env.METRIC_EVENTS)
          ? readFileSync(env.METRIC_EVENTS, "utf8")
          : "not measured",
      });
      return { ...result, diagnostics };
    },
    setStamp(stamp: string) {
      const date = path.join(bin, "date");
      write(
        date,
        `#!/bin/bash\nif [[ "$*" == '-u +%Y%m%dT%H%M%SZ' ]]; then echo '${stamp}'; else exec /bin/date "$@"; fi\n`,
      );
      chmodSync(date, 0o755);
    },
    start(overrides: NodeJS.ProcessEnv = {}) {
      const child = spawn("/bin/bash", [path.join(checkout, "infra/compose/backup-prod.sh")], {
        cwd: root,
        env: { ...env, ...overrides },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child.pid) throw new Error("Fixture process did not start");
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      const result = new Promise<ScriptResult>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => {
          resolve({ status, signal, stdout, stderr });
        });
      });
      const running = { pid: child.pid, result };
      runningScripts.add(running);
      return running;
    },
    commands(): string[][] {
      if (!existsSync(env.COMMAND_LOG)) return [];
      return readFileSync(env.COMMAND_LOG, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

/** Snapshot directories, without the backup lock file. */
function snapshotNames(root: string) {
  return existsSync(root) ? readdirSync(root).filter((name) => name !== ".lock") : [];
}

function nextStamp() {
  return new Date(Date.now() + 60_000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

const DAY = 24 * 60 * 60 * 1000;
function seedSnapshot(f: ReturnType<typeof fixture>, ageDays: number, complete = true) {
  const date = new Date(Date.now() - ageDays * DAY);
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const directory = path.join(f.snapshots, stamp);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  write(path.join(directory, "rakazo.dump"), "previous fake dump");
  execFileSync("/usr/bin/tar", [
    "-czf",
    path.join(directory, "appdata.tgz"),
    "-C",
    f.env.FAKE_APPDATA,
    ".",
  ]);
  if (complete) {
    const receipt = `${["rakazo.dump", "appdata.tgz"]
      .map(
        (name) =>
          createHash("sha256")
            .update(readFileSync(path.join(directory, name)))
            .digest("hex") +
          "  " +
          name,
      )
      .join("\n")}\n`;
    write(path.join(directory, "SHA256SUMS"), receipt);
  }
  utimesSync(directory, date, date);
  return directory;
}

function expectNewReceipt(snapshot: string) {
  const sums = readFileSync(path.join(snapshot, "SHA256SUMS"), "utf8").trim().split("\n");
  expect(sums).toHaveLength(3);
  for (const line of sums) {
    const match = /^([a-f0-9]{64}) {2}([^/]+)$/.exec(line);
    expect(match).not.toBeNull();
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(snapshot, match![2])))
        .digest("hex"),
    ).toBe(match![1]);
    expect(statSync(path.join(snapshot, match![2])).mode & 0o777).toBe(0o600);
  }
  expect(statSync(path.join(snapshot, "SHA256SUMS")).mode & 0o777).toBe(0o600);
  expect(statSync(snapshot).mode & 0o777).toBe(0o700);
}

function didDump(f: ReturnType<typeof fixture>) {
  return f.commands().some((args) => args.includes("sh") || args.includes("pg_dump"));
}

function contents(archive: string) {
  return execFileSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8" });
}

describe("development backup failures", () => {
  it.each([false, true])("archives data with a root env file present: %s", (hasEnv) => {
    const f = fixture();
    if (!hasEnv) rmSync(path.join(f.checkout, ".env"));
    write(path.join(f.checkout, "data/home.txt"), "example home");
    expect(f.run("scripts/backup.sh", ["example"]).status).toBe(0);
    const output = path.join(f.checkout, "backups/example");
    expect(readFileSync(path.join(output, "rakazo.sql"), "utf8")).toContain("CREATE TABLE");
    expect(contents(path.join(output, "homes.tgz"))).toContain("data/home.txt");
    expect(f.commands()[0].includes("--env-file")).toBe(hasEnv);
    if (hasEnv) expect(f.commands()[0]).toContain(path.join(f.checkout, ".env"));
  });

  it.each(["absent", "skipped"])("allows an empty archive when data is %s", (scenario) => {
    const f = fixture();
    if (scenario === "skipped") write(path.join(f.checkout, "data/home.txt"), "example home");
    const result = f.run("scripts/backup.sh", ["example"], {
      RAKAZO_BACKUP_SKIP_HOMES: scenario === "skipped" ? "1" : "0",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(contents(path.join(f.checkout, "backups/example/homes.tgz"))).toBe("");
  });

  it.each(["file", "broken link"])("rejects a data path that is a %s", (kind) => {
    const f = fixture();
    const data = path.join(f.checkout, "data");
    if (kind === "file") write(data, "not a directory");
    else symlinkSync(path.join(f.root, "missing"), data);
    const result = f.run("scripts/backup.sh", ["example"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Backup written");
  });

  it.each([1, 2])("propagates tar exit %s without replacing the failed archive", (code) => {
    const f = fixture();
    write(path.join(f.checkout, "data/home.txt"), "example home");
    const result = f.run("scripts/backup.sh", ["example"], { FAIL_TAR: String(code) });
    expect(result.status).toBe(code);
    expect(result.stderr).toContain("simulated archive read failure");
    expect(result.stdout).not.toContain("Backup written");
    expect(existsSync(path.join(f.checkout, "backups/example/homes.tgz"))).toBe(false);
  });

  it("does not archive files or report success after pg_dump fails", () => {
    const f = fixture();
    const result = f.run("scripts/backup.sh", ["example"], { FAIL_DUMP: "1" });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("Backup written");
    expect(existsSync(path.join(f.checkout, "backups/example/homes.tgz"))).toBe(false);
  });
});

describe("development restore failures", () => {
  function restoreFixture() {
    const f = fixture();
    write(path.join(f.checkout, "data/home.txt"), "backed-up home");
    expect(f.run("scripts/backup.sh", ["example"]).status).toBe(0);
    write(path.join(f.checkout, "data/home.txt"), "current home");
    return f;
  }

  it.each([false, true])(
    "restores files and starts services only after SQL succeeds: %s",
    (fail) => {
      const f = restoreFixture();
      const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
        FAIL_SQL: fail ? "1" : "0",
      });
      expect(result.status).toBe(fail ? 3 : 0);
      const command = f.commands().find((args) => args.includes("psql"));
      expect(command).toEqual(
        expect.arrayContaining([
          "-X",
          "--set=ON_ERROR_STOP=on",
          "--single-transaction",
          "--file=-",
        ]),
      );
      expect(readFileSync(f.env.SQL_INPUT, "utf8")).toContain("CREATE TABLE example");
      expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe(
        fail ? "current home" : "backed-up home",
      );
      expect(f.commands().some((args) => args.slice(-2).join(" ") === "up -d")).toBe(!fail);
      expect(result.stdout.includes("Restore complete")).toBe(!fail);
      if (fail) expect(result.stderr).toContain("already exists");
    },
  );

  it("fails rather than starting services after an invalid homes archive", () => {
    const f = restoreFixture();
    write(path.join(f.checkout, "backups/example/homes.tgz"), "invalid archive");
    const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Restore complete");
    expect(f.commands().some((args) => args.slice(-2).join(" ") === "up -d")).toBe(false);
  });
});

describe("production backup deployment and archive behavior", () => {
  it.each([false, true])("uses the configured deployment directory: %s", (custom) => {
    const f = fixture();
    const deployment = custom ? f.checkout : "/srv/rakazo";
    const result = f.run(
      "infra/compose/backup-prod.sh",
      [],
      custom ? { RAKAZO_DEPLOY_DIR: deployment } : {},
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified Rakazo backup");
    for (const command of f.commands().filter((args) => args[0] === "compose")) {
      expect(command.slice(0, 5)).toEqual([
        "compose",
        "--env-file",
        path.join(deployment, ".env"),
        "-f",
        path.join(deployment, "infra/compose/docker-compose.prod.yml"),
      ]);
    }
  });

  it("provides optional systemd configuration for installed copies", () => {
    const service = readFileSync(
      path.join(repoRoot, "infra/systemd/rakazo-backup.service"),
      "utf8",
    );
    expect(service).toContain("EnvironmentFile=-/etc/rakazo/backup.env");
  });

  it("rejects relative deployment paths before any backup commands", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_DEPLOY_DIR: "relative" });
    expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
    expect(result.stderr).toContain("absolute path");
    expect(f.commands()).toEqual([]);
    expect(existsSync(f.snapshots)).toBe(false);
  });

  it("preserves host archiving and the live-file warning allowance", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { CHANGED_TAR: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("file changed as we read it");
    expect(result.stdout).toContain("Verified Rakazo backup");
    const snapshot = result.stdout.trim().split("written to ")[1];
    expect(contents(path.join(snapshot, "appdata.tgz"))).toContain("home.txt");
    expect(existsSync(path.join(snapshot, "SHA256SUMS"))).toBe(true);
    expect(f.commands().some((args) => args[0] === "inspect")).toBe(true);
    expect(f.commands().some((args) => args.includes("tar"))).toBe(false);
  });

  it.each([{ FAIL_TAR: "2" }, { FAIL_DUMP: "1" }, { FAIL_VERIFY: "1" }])(
    "does not report a verified snapshot after failure: %j",
    (failure) => {
      const f = fixture();
      const result = f.run("infra/compose/backup-prod.sh", [], failure);
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
      // The partial snapshot is removed.
      expect(snapshotNames(f.snapshots)).toEqual([]);
    },
  );

  it("uses one selected Compose project and ignores an environment backup-root override", () => {
    const f = fixture(),
      outside = path.join(f.root, "outside");
    write(path.join(outside, "keep"), "preserve");
    const result = f.run("infra/compose/backup-prod.sh", [], {
      COMPOSE_PROJECT_NAME: "example-stack",
      BACKUP_ROOT: outside,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.env.PROVIDER_SCOPE, "utf8")).toBe("example-stack");
    expect(result.stdout).toContain(f.snapshots);
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("preserve");
    expect(
      f
        .commands()
        .filter((args) => args[0] === "inspect")
        .every((args) => args[1] === "example-api-container"),
    ).toBe(true);
  });

  it.each(["reserve", "budget"])(
    "uses the declared default %s until explicitly overridden",
    (setting) => {
      for (const overridden of [false, true]) {
        const f = fixture(),
          previous = seedSnapshot(f, 1);
        const inputs: NodeJS.ProcessEnv =
          setting === "reserve"
            ? { FREE_KB: "3145728", ...(overridden ? { RAKAZO_BACKUP_MIN_FREE_GB: "1" } : {}) }
            : {
                FREE_KB: "134217728",
                PREVIOUS_DIR: previous,
                PREVIOUS_TOTAL_KB: "62914560",
                ...(overridden ? { RAKAZO_BACKUP_MAX_GB: "100" } : {}),
              };
        const result = f.run("infra/compose/backup-prod.sh", [], inputs);
        expect(result.status, result.stderr).toBe(overridden ? 0 : 1);
        expect(existsSync(path.join(previous, "SHA256SUMS"))).toBe(true);
        if (!overridden) expect(didDump(f)).toBe(false);
      }
    },
  );

  it("rejects an overflowing estimate without deleting old data", () => {
    const f = fixture(),
      complete = seedSnapshot(f, 1),
      partial = seedSnapshot(f, 2, false);
    const result = f.run("infra/compose/backup-prod.sh", [], {
      FAKE_RAW_KB: "9223372036854775807",
    });
    expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
    expect(didDump(f)).toBe(false);
    expect(existsSync(complete)).toBe(true);
    expect(existsSync(partial)).toBe(true);
  });

  it.each([
    { free: "2098432", allowed: true },
    { free: "2098431", allowed: false },
  ])("enforces the exact reserve admission boundary: %j", ({ free, allowed }) => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], {
      FAKE_RAW_KB: "1024",
      RAKAZO_BACKUP_MIN_FREE_GB: "1",
      FREE_KB: free,
    });
    expect(result.status, result.stderr + result.diagnostics).toBe(allowed ? 0 : 1);
    if (allowed) expectNewReceipt(result.stdout.trim().split("written to ")[1]);
    else {
      expect(didDump(f)).toBe(false);
      expect(snapshotNames(f.snapshots)).toEqual([]);
    }
  });

  it.each(["", "0", "-1", "1.5", "no", "9223372036854775807"])(
    "rejects invalid space limits before provider calls: %s",
    (value) => {
      for (const name of ["RAKAZO_BACKUP_MIN_FREE_GB", "RAKAZO_BACKUP_MAX_GB"]) {
        const f = fixture();
        expect(f.run("infra/compose/backup-prod.sh", [], { [name]: value }).status).not.toBe(0);
        expect(f.commands()).toEqual([]);
        expect(existsSync(f.snapshots)).toBe(false);
      }
    },
  );

  it.each(["", "2", "yes", "-1"])("rejects an invalid volume requirement: %s", (value) => {
    const f = fixture();
    expect(
      f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_REQUIRE_VOLUME: value }).status,
    ).not.toBe(0);
    expect(f.commands()).toEqual([]);
  });

  it.each([
    { MOUNT_STATUS: "1", BACKUP_DEVICE: "2", ok: false },
    { MOUNT_STATUS: "0", BACKUP_DEVICE: "1", ok: false },
    { MOUNT_STATUS: "0", BACKUP_DEVICE: "2", ok: true },
  ])("requires a separate mounted volume: %j", ({ ok, ...overrides }) => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_REQUIRE_VOLUME: "1",
      ...overrides,
    });
    expect(result.status, result.stderr).toBe(ok ? 0 : 1);
    if (!ok) {
      expect(f.commands()).toEqual([]);
      expect(existsSync(f.snapshots)).toBe(false);
    }
  });

  it.each(["root-symlink", "root-file", "lock-symlink", "lock-directory"])(
    "rejects unsafe backup storage: %s",
    (kind) => {
      const f = fixture(),
        outside = path.join(f.root, "outside");
      mkdirSync(outside);
      write(path.join(outside, "keep"), "preserve");
      if (kind === "root-symlink") symlinkSync(outside, f.snapshots);
      else if (kind === "root-file") write(f.snapshots, "preserve root file");
      else {
        mkdirSync(f.snapshots);
        if (kind === "lock-symlink")
          symlinkSync(path.join(outside, "keep"), path.join(f.snapshots, ".lock"));
        else mkdirSync(path.join(f.snapshots, ".lock"));
      }
      const result = f.run("infra/compose/backup-prod.sh");
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(didDump(f)).toBe(false);
      expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("preserve");
      if (kind === "root-file")
        expect(readFileSync(f.snapshots, "utf8")).toBe("preserve root file");
    },
  );

  it.each([
    "missing-api",
    "multiple-api",
    "missing-mount",
    "relative-mount",
    "multiple-mount",
    "newline-mount",
    "file-mount",
  ])("rejects ambiguous or absent appdata before dumping: %s", (kind) => {
    const f = fixture();
    const file = path.join(f.root, "not-a-directory");
    write(file, "file");
    const inputs: Record<string, Record<string, string>> = {
      "missing-api": { NO_API: "1" },
      "multiple-api": { API_OUTPUT: "first\nsecond" },
      "missing-mount": { NO_MOUNT: "1" },
      "relative-mount": { MOUNT_OUTPUT: "relative" },
      "multiple-mount": { MOUNT_OUTPUT: `${f.env.FAKE_APPDATA}\n${f.env.FAKE_APPDATA}` },
      "newline-mount": { MOUNT_OUTPUT: `${f.env.FAKE_APPDATA}\n` },
      "file-mount": { MOUNT_OUTPUT: file },
    };
    const result = f.run("infra/compose/backup-prod.sh", [], inputs[kind]);
    expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
    expect(didDump(f)).toBe(false);
    expect(existsSync(f.snapshots)).toBe(false);
  });

  it("does not truncate an existing regular backup lock", () => {
    const f = fixture();
    mkdirSync(f.snapshots);
    write(path.join(f.snapshots, ".lock"), "preserve lock contents");
    const result = f.run("infra/compose/backup-prod.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(f.snapshots, ".lock"), "utf8")).toBe("preserve lock contents");
  });

  it("removes only legal partials and expired non-latest complete snapshots", () => {
    const f = fixture();
    const expired = seedSnapshot(f, 7 + 1 / 24);
    const inside = seedSnapshot(f, 7 - 1 / 24);
    const latest = seedSnapshot(f, 1);
    const partial = seedSnapshot(f, 2, false);
    write(path.join(f.snapshots, "notes/keep.txt"), "operator note");
    for (const invalid of ["20260230T000000Z", "20261001T240000Z", "00000000T000000Z"])
      write(path.join(f.snapshots, invalid, "keep"), "invalid stamp");
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    write(path.join(outside, "keep"), "preserve");
    symlinkSync(outside, path.join(f.snapshots, "20000101T000000Z"));
    const result = f.run("infra/compose/backup-prod.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(inside)).toBe(true);
    expect(existsSync(latest)).toBe(true);
    expect(readFileSync(path.join(f.snapshots, "notes/keep.txt"), "utf8")).toBe("operator note");
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("preserve");
    for (const invalid of ["20260230T000000Z", "20261001T240000Z", "00000000T000000Z"])
      expect(readFileSync(path.join(f.snapshots, invalid, "keep"), "utf8")).toBe("invalid stamp");
  });

  it("keeps multiple complete snapshots from the same day", () => {
    const f = fixture(),
      previous = [1, 1 + 1 / 24, 1 + 2 / 24, 1 + 3 / 24].map((age) => seedSnapshot(f, age));
    const result = f.run("infra/compose/backup-prod.sh");
    expect(result.status, result.stderr).toBe(0);
    for (const directory of previous)
      expect(existsSync(path.join(directory, "SHA256SUMS"))).toBe(true);
  });

  it.each([{ FREE_KB: "1" }, { RAKAZO_BACKUP_MAX_GB: "1" }])(
    "keeps all seven-day complete snapshots when admission fails: %j",
    (overrides) => {
      const f = fixture();
      const first = seedSnapshot(f, 6),
        latest = seedSnapshot(f, 1),
        expired = seedSnapshot(f, 9),
        partial = seedSnapshot(f, 2, false);
      const result = f.run("infra/compose/backup-prod.sh", [], overrides);
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(didDump(f)).toBe(false);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(latest)).toBe(true);
      expect(existsSync(expired)).toBe(false);
      expect(existsSync(partial)).toBe(false);
    },
  );

  it("keeps the latest complete snapshot even when expired and over budget", () => {
    const f = fixture();
    const latest = seedSnapshot(f, 15),
      older = seedSnapshot(f, 20);
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_MAX_GB: "1" });
    expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
    expect(existsSync(latest)).toBe(true);
    expect(existsSync(older)).toBe(false);
    expect(didDump(f)).toBe(false);
  });

  it.each([false, true])(
    "retires an expired latest receipt only after a newer backup completes: %s",
    (fail) => {
      const f = fixture(),
        old = seedSnapshot(f, 15);
      const result = f.run("infra/compose/backup-prod.sh", [], fail ? { FAIL_DUMP: "1" } : {});
      expect(result.status, result.stderr).toBe(fail ? 2 : 0);
      expect(existsSync(old)).toBe(fail);
      if (!fail) expectNewReceipt(result.stdout.trim().split("written to ")[1]);
    },
  );

  it("keeps the greatest receipt stamp when the clock moves backwards", () => {
    const f = fixture(),
      future = seedSnapshot(f, -1),
      expired = new Date(Date.now() - 15 * DAY);
    utimesSync(future, expired, expired);
    const result = f.run("infra/compose/backup-prod.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(future, "SHA256SUMS"))).toBe(true);
    expectNewReceipt(result.stdout.trim().split("written to ")[1]);
  });

  it("keeps a newly verified snapshot if later history cleanup fails", () => {
    const f = fixture(),
      old = seedSnapshot(f, 15);
    const result = f.run("infra/compose/backup-prod.sh", [], { FAIL_HISTORY_REMOVE: "1" });
    expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
    expect(result.stdout).not.toContain("Verified Rakazo backup");
    const current = snapshotNames(f.snapshots).filter((name) => name !== path.basename(old));
    expect(current).toHaveLength(1);
    expect(existsSync(old)).toBe(true);
    expectNewReceipt(path.join(f.snapshots, current[0]));
  });

  it.each(["symlink", "directory"])("does not treat a pending or %s marker as complete", (kind) => {
    const f = fixture(),
      latest = seedSnapshot(f, 15),
      bad = seedSnapshot(f, 1);
    const original = path.join(f.root, "marker-target");
    write(original, "preserve");
    rmSync(path.join(bad, "SHA256SUMS"));
    if (kind === "symlink") symlinkSync(original, path.join(bad, "SHA256SUMS"));
    else mkdirSync(path.join(bad, "SHA256SUMS"));
    const pending = seedSnapshot(f, 2, false);
    write(path.join(pending, "SHA256SUMS.pending"), "pending");
    const result = f.run("infra/compose/backup-prod.sh", [], { FREE_KB: "1" });
    expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
    expect(existsSync(latest)).toBe(true);
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(pending)).toBe(false);
    expect(readFileSync(original, "utf8")).toBe("preserve");
  });

  it.each(["missing", "symlink"])(
    "preserves a protected receipt with a %s archive and uses a conservative estimate",
    (kind) => {
      const f = fixture(),
        previous = seedSnapshot(f, 6),
        latest = seedSnapshot(f, 1);
      const archive = path.join(latest, "appdata.tgz"),
        outside = path.join(f.root, "archive-target");
      write(outside, "preserve");
      rmSync(archive);
      if (kind === "symlink") symlinkSync(outside, archive);
      write(path.join(latest, "SOURCE_SIZE_KB"), "10485760");
      const result = f.run("infra/compose/backup-prod.sh", [], {
        PREVIOUS_DIR: latest,
        FAKE_RAW_KB: "8388608",
        PREVIOUS_ARCHIVE_KB: "1",
        RAKAZO_BACKUP_MAX_GB: "3",
        RAKAZO_BACKUP_MIN_FREE_GB: "1",
      });
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(didDump(f)).toBe(false);
      expect(existsSync(path.join(previous, "SHA256SUMS"))).toBe(true);
      expect(existsSync(path.join(latest, "SHA256SUMS"))).toBe(true);
      const measured = readFileSync(f.env.DU_LOG, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(measured.some((args) => args.at(-1) === archive)).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe("preserve");
    },
  );

  it.each([undefined, "", "0", "invalid"])(
    "falls back safely for legacy size metadata: %s",
    (metadata) => {
      const f = fixture(),
        previous = seedSnapshot(f, 1);
      if (metadata !== undefined) write(path.join(previous, "SOURCE_SIZE_KB"), metadata);
      const result = f.run("infra/compose/backup-prod.sh", [], {
        FAKE_RAW_KB: "8388608",
        RAKAZO_BACKUP_MAX_GB: "3",
        RAKAZO_BACKUP_MIN_FREE_GB: "1",
      });
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(didDump(f)).toBe(false);
      expect(existsSync(path.join(previous, "SHA256SUMS"))).toBe(true);
    },
  );

  it.each(["", "not-a-number", "-1"])(
    "does not delete history after invalid storage metrics: %s",
    (value) => {
      for (const name of ["FREE_KB", "FAKE_RAW_KB"]) {
        const f = fixture(),
          latest = seedSnapshot(f, 1),
          expired = seedSnapshot(f, 15),
          partial = seedSnapshot(f, 2, false);
        const result = f.run("infra/compose/backup-prod.sh", [], { [name]: value });
        expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
        expect(didDump(f)).toBe(false);
        for (const directory of [latest, expired, partial])
          expect(existsSync(directory)).toBe(true);
      }
    },
  );

  it.each([false, true])("estimates compressed storage using source growth: %s", (grown) => {
    const f = fixture(),
      last = seedSnapshot(f, 1);
    write(path.join(last, "SOURCE_SIZE_KB"), "10485760\n");
    const result = f.run("infra/compose/backup-prod.sh", [], {
      PREVIOUS_DIR: last,
      PREVIOUS_TOTAL_KB: "1048576",
      PREVIOUS_ARCHIVE_KB: "1048576",
      PREVIOUS_DUMP_KB: "1",
      FAKE_RAW_KB: grown ? "20971520" : "10485760",
      RAKAZO_BACKUP_MAX_GB: "3",
      RAKAZO_BACKUP_MIN_FREE_GB: "1",
    });
    expect(result.status, result.stderr).toBe(grown ? 1 : 0);
    expect(existsSync(path.join(last, "SHA256SUMS"))).toBe(true);
  });

  it("does not multiply a large database dump by appdata growth", () => {
    const f = fixture(),
      last = seedSnapshot(f, 1);
    write(path.join(last, "SOURCE_SIZE_KB"), "102400");
    const result = f.run("infra/compose/backup-prod.sh", [], {
      PREVIOUS_DIR: last,
      FAKE_RAW_KB: "1048576",
      PREVIOUS_DUMP_KB: "10485760",
      PREVIOUS_ARCHIVE_KB: "102400",
      PREVIOUS_TOTAL_KB: "10588160",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    { FAIL_ARCHIVE_VERIFY: "1" },
    { FAIL_CHECKSUM: "1" },
    { FAIL_CHMOD: "1" },
    { FAIL_MARKER_MOVE: "1" },
    { FAIL_SYNC: "files" },
    { FAIL_SYNC: "directory" },
    { LATE_PRESSURE: "1" },
  ])(
    "does not publish or leave partial data after verification/publication failure: %j",
    (failure) => {
      const f = fixture(),
        previous = seedSnapshot(f, 15);
      const result = f.run("infra/compose/backup-prod.sh", [], failure);
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
      expect(snapshotNames(f.snapshots)).toEqual([path.basename(previous)]);
    },
  );

  it("publishes portable checksums after payload sync and before directory sync", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh");
    expect(result.status, result.stderr).toBe(0);
    const snapshot = result.stdout.trim().split("written to ")[1];
    const events = readFileSync(f.env.SYNC_EVENTS, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      { stage: "files", complete: false, pending: true },
      { stage: "directory", complete: true, pending: false },
    ]);
    expectNewReceipt(snapshot);
  });

  it("never overwrites a completed snapshot when a rerun has the same timestamp", () => {
    const f = fixture();
    const first = f.run("infra/compose/backup-prod.sh");
    expect(first.status, first.stderr).toBe(0);
    const snapshot = first.stdout.trim().split("written to ")[1],
      manifest = readFileSync(path.join(snapshot, "SHA256SUMS"), "utf8");
    f.setStamp(path.basename(snapshot));
    const before = f.commands().length,
      second = f.run("infra/compose/backup-prod.sh", [], { FAIL_DUMP: "1" });
    expect(second.status).not.toBe(0);
    expect(
      f
        .commands()
        .slice(before)
        .some((args) => args.includes("sh")),
    ).toBe(false);
    expect(readFileSync(path.join(snapshot, "SHA256SUMS"), "utf8")).toBe(manifest);
  });
});

describe.skipIf(process.platform !== "linux")(
  "production backup Linux process and storage boundaries",
  () => {
    it("rejects a FIFO lock before opening it", () => {
      const f = fixture();
      mkdirSync(f.snapshots);
      execFileSync("mkfifo", [path.join(f.snapshots, ".lock")]);
      const result = f.run("infra/compose/backup-prod.sh");
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(didDump(f)).toBe(false);
    });

    it("refuses an independently held filesystem lock", () => {
      const f = fixture();
      mkdirSync(f.snapshots);
      write(path.join(f.snapshots, ".lock"), "");
      const result = spawnSync(
        "flock",
        [
          path.join(f.snapshots, ".lock"),
          "/bin/bash",
          path.join(f.checkout, "infra/compose/backup-prod.sh"),
        ],
        { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Another Rakazo backup is running");
      expect(didDump(f)).toBe(false);
    });

    it.each(["dump", "archive"])("enforces the actual %s writer file-size limit", (output) => {
      const f = fixture(),
        last = seedSnapshot(f, 1);
      const result = f.run("infra/compose/backup-prod.sh", [], {
        RAKAZO_BACKUP_MIN_FREE_GB: "1",
        LIMIT_OUTPUT: output,
        ...(output === "dump" ? { OVERSIZE_DUMP: "1" } : { OVERSIZE_ARCHIVE: "1" }),
      });
      expect(result.status, result.stderr + result.diagnostics).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
      expect(snapshotNames(f.snapshots)).toEqual([path.basename(last)]);
      expect(readFileSync(f.env.WRITER_EVENTS, "utf8")).toContain(output);
      const limits = readFileSync(
        output === "dump" ? f.env.DUMP_LIMITS : f.env.ARCHIVE_LIMITS,
        "utf8",
      );
      expect(limits).toMatch(/Max file size\s+8192\s+/);
      expect(limits).toMatch(/Max core file size\s+0\s+/);
    });

    it("keeps a live writer's partial snapshot safe from a concurrent backup", async () => {
      const f = fixture();
      const first = f.start({ HOLD_DUMP: "1" });
      await waitForFile(f.env.DUMP_READY);
      const partials = snapshotNames(f.snapshots);
      expect(partials).toHaveLength(1);
      const second = f.start();
      const result = await second.result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Another Rakazo backup is running");
      expect(snapshotNames(f.snapshots)).toEqual(partials);
      write(f.env.DUMP_RELEASE, "release");
      const completed = await first.result;
      expect(completed.status, completed.stderr).toBe(0);
    });

    it.each(["SIGTERM", "SIGINT", "SIGKILL"] as const)(
      "settles its owned process group after %s",
      async (signal) => {
        const f = fixture(),
          old = seedSnapshot(f, 1);
        const current = f.start({ HOLD_DUMP: "1" });
        await waitForFile(f.env.DUMP_READY);
        signalGroup(current.pid, signal);
        const result = await current.result;
        expect(result.status === 0).toBe(false);
        expect(existsSync(old)).toBe(true);
        if (signal === "SIGKILL") {
          expect(snapshotNames(f.snapshots).length).toBeGreaterThan(1);
          f.setStamp(nextStamp());
          const next = f.run("infra/compose/backup-prod.sh", [], { FREE_KB: "1" });
          expect(next.status).not.toBe(0);
        }
        expect(snapshotNames(f.snapshots)).toEqual([path.basename(old)]);
      },
    );

    it("retains the lock while an orphaned writer still owns the descriptor", async () => {
      const f = fixture();
      const first = f.start({ HOLD_DUMP: "1" });
      await waitForFile(f.env.DUMP_READY);
      process.kill(first.pid, "SIGKILL");
      const second = f.start();
      const refused = await second.result;
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("Another Rakazo backup is running");
      write(f.env.DUMP_RELEASE, "release");
      await first.result;
      f.setStamp(nextStamp());
      const next = f.run("infra/compose/backup-prod.sh", [], { FREE_KB: "1" });
      expect(next.status).not.toBe(0);
      expect(snapshotNames(f.snapshots)).toEqual([]);
    });
  },
);
