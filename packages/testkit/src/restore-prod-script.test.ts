import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const queueTables = [
  "_private_jobs",
  "_private_job_queues",
  "_private_tasks",
  "_private_known_crontabs",
];
const ordinaryToc = [
  "; Synthetic archive inventory",
  "20; 3256 22345 POLICY public messages messages_tenant fixture_owner",
  "21; 3256 22346 POLICY public messages messages_system fixture_owner",
  "30; 0 0 ROW SECURITY public messages fixture_owner",
  "31; 0 0 ROW SECURITY graphile_worker _private_jobs fixture_owner",
];
const archiveToc = `${[
  ...ordinaryToc,
  ...queueTables.map(
    (table, index) =>
      `${100 + index}; 3256 ${32345 + index} POLICY graphile_worker ${table} coginebot_app_queue fixture_owner`,
  ),
].join("\n")}\n`;
const restoreSql = "CREATE TABLE synthetic_restore(id integer);\n-- Synthetic payload: 合成 α\n";
const authoritySql = "DO $fixture_authority$ BEGIN NULL; END; $fixture_authority$;\n";
type Event = { kind: string; args: string[] };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function write(file: string, content: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture(supervisor = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "restore-prod-contract-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "checkout with spaces");
  const snapshot = path.join(root, "snapshot with spaces");
  const appdata = path.join(root, "volume", "data");
  const pgStage = path.join(root, "owned-pg-stage");
  const pgVirtual = "/tmp/coginebot-restore.hermetic-fixture";
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.jsonl");
  const evidence = path.join(root, "transport");
  const adminRunning = path.join(evidence, "administrator-running");
  for (const file of [
    "infra/compose/restore-prod.sh",
    "infra/compose/docker-compose.prod.yml",
    "scripts/restore-transfer-fence.sql",
  ])
    write(path.join(checkout, file), readFileSync(path.join(repoRoot, file)));
  write(path.join(checkout, ".env"), "POSTGRES_PASSWORD=synthetic-owner-password\n");
  write(path.join(checkout, "overlays", "supervisor.yml"), "services:\n  supervisor: {}\n");
  write(path.join(appdata, "home.txt"), "current home");
  write(path.join(appdata, "current-only.txt"), "retain until the restore is accepted");
  const archivedData = path.join(root, "archived-data");
  write(path.join(archivedData, "home.txt"), "restored home 合成 α");
  write(path.join(archivedData, "restored-only.txt"), "restored attachment");
  write(path.join(snapshot, "rakazo.dump"), Buffer.from("PGDMP\0synthetic transport payload"));
  execFileSync("tar", ["-czf", path.join(snapshot, "appdata.tgz"), "-C", archivedData, "."]);
  write(path.join(snapshot, "SOURCE_SIZE_KB"), "12\n");
  mkdirSync(evidence);
  const composeFiles = [path.join(checkout, "infra/compose/docker-compose.prod.yml")];
  if (supervisor) composeFiles.push(path.join(checkout, "overlays/supervisor.yml"));
  const docker = path.join(bin, "docker");
  // Docker transports argv and synthetic PG output only; host files, tar and checksums are real.
  write(
    docker,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const event = kind => fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({kind,args})+"\\n");
const die = message => { console.error(message); process.exit(90); };
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fail = stage => { if (process.env.FAIL_STAGE === stage) { console.error("Synthetic " + stage + " failure"); process.exit(17); } };
const pg = file => {
  const allowed = ["archive", "queue.toc", "restore.toc"];
  if (!allowed.some(name => file === process.env.PG_VIRTUAL + "/" + name)) die("Unowned PG stage path");
  return path.join(process.env.RESTORE_TEST_PG_STAGE, path.basename(file));
};
if (args[0] === "inspect") {
  if (args[1] !== "fixture-api-container" || !args.at(-1).endsWith("DATA_MOUNT_END")) die("Unexpected inspect");
  event("inspect");
  process.stdout.write(process.env.APPDATA + "\\nDATA_MOUNT_END\\n");
  process.exit(0);
}
if (args[0] !== "compose") die("Only the hermetic Compose transport is available");
let index = 1;
if (args[index++] !== "--env-file" || args[index++] !== process.env.ENV_FILE) die("Unexpected env file");
const files = [];
while (args[index] === "-f") { index++; files.push(args[index++]); }
if (!equal(files, JSON.parse(process.env.COMPOSE_FILES))) die("Unexpected Compose selection");
const command = args.slice(index);
if (equal(command,["config","--services"])) {
  event("services"); console.log("postgres\\nmigrate\\napi\\nworker\\nweb\\ncaddy" + (process.env.SUPERVISOR === "1" ? "\\nsupervisor" : ""));
} else if (equal(command,["stop","--timeout","120","migrate"])) {
  event("admin-stop");
  if (process.env.FAIL_ADMIN_STOP === "1") { console.error("Synthetic administrator stop failure"); process.exit(19); }
  fs.rmSync(process.env.RESTORE_TEST_ADMIN_RUNNING,{force:true});
} else if (command[0] === "stop") {
  const writers = ["api","worker",...(process.env.SUPERVISOR === "1" ? ["supervisor"] : [])];
  if (!equal(command.slice(1), writers) && !equal(command.slice(1), ["--timeout","120",...writers])) die("Unexpected writers");
  event("stop");
} else if (equal(command,["up","-d","postgres"])) event("postgres");
else if (equal(command,["up","--no-deps","--no-build","--pull","never","--abort-on-container-exit","--exit-code-from","migrate","migrate"])) {
  event("owner-migrate"); fs.writeFileSync(process.env.RESTORE_TEST_ADMIN_RUNNING,"running");
  fail("owner-migrate"); fs.unlinkSync(process.env.RESTORE_TEST_ADMIN_RUNNING);
}
else if (equal(command,["up","-d"])) event("runtime-start");
else if (equal(command,["ps","--all","-q","api"])) { event("api-id"); console.log("fixture-api-container"); }
else if (command[0] === "run") {
  const prefix = ["run","--rm","--no-deps","migrate"];
  if (!equal(command.slice(0,4), prefix)) die("Unexpected owner command");
  const rest = command.slice(4);
  if (!rest.length) die("Administrator migrations require the canonical service");
  else if (equal(rest,["pnpm","--filter","@rakazo/api","run","db:restore","prepare"])) { event("prepare"); fail("prepare"); }
  else if (equal(rest,["pnpm","--silent","--filter","@rakazo/api","run","db:restore","fence"])) { event("authority"); fail("authority"); process.stdout.write(process.env.AUTHORITY_SQL); }
  else if (equal(rest,["pnpm","--filter","@rakazo/api","run","db:restore","verify"])) { event("verify"); fail("verify"); }
  else die("Unexpected restore CLI");
} else if (equal(command.slice(0,3),["exec","-T","postgres"])) {
  const tool = command.slice(3);
  if (equal(tool,["mktemp","-d","/tmp/coginebot-restore.XXXXXX"])) {
    if (fs.existsSync(process.env.RESTORE_TEST_PG_STAGE)) die("PG stage already exists");
    fs.mkdirSync(process.env.RESTORE_TEST_PG_STAGE); event("pg-stage"); console.log(process.env.PG_VIRTUAL);
  } else if (equal(tool,["rm","-rf","--",process.env.PG_VIRTUAL])) {
    event("pg-cleanup"); fs.rmSync(process.env.RESTORE_TEST_PG_STAGE,{recursive:true,force:true});
  } else if (equal(tool.slice(0,4),["sh","-c",'cat > "$1"',"restore"]) && tool.length === 5) {
    const target = pg(tool[4]); const input = fs.readFileSync(0); fs.writeFileSync(target,input);
    fs.writeFileSync(path.join(process.env.EVIDENCE,path.basename(target)),input); event("copy-"+path.basename(target));
  } else if (tool[0] === "sh" && tool[2] === 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"') event("ready");
  else if (tool[0] === "sh" && tool[2].startsWith("exec psql ") && tool[3] === "restore" && tool.length === 5) {
    event("loader"); fs.writeFileSync(path.join(process.env.EVIDENCE,"loader.sql"),fs.readFileSync(0)); fail("loader");
  } else if (equal(tool,["pg_restore","--list",process.env.PG_VIRTUAL+"/archive"])) {
    fs.readFileSync(pg(tool.at(-1))); event("list"); process.stdout.write(process.env.ARCHIVE_TOC);
  } else if (tool[0] === "pg_restore" && equal(tool.slice(1,4),["--no-owner","--no-privileges","--use-list"]) && tool[5] === "--file=-" && tool.length === 7) {
    fs.readFileSync(pg(tool[6])); const list = fs.readFileSync(pg(tool[4]),"utf8");
    if (tool[4] === process.env.PG_VIRTUAL+"/queue.toc") {
      event("queue-sql");
      const selected = list.trim().split("\\n").map(line => {
        const fields = line.split(" ");
        if (fields[3] !== "POLICY" || fields[4] !== "graphile_worker" || fields[6] !== "coginebot_app_queue" || !JSON.parse(process.env.QUEUE_TABLES).includes(fields[5])) die("Unexpected managed queue TOC entry");
        return fields[5];
      });
      let sql = selected.map(table => "CREATE POLICY coginebot_app_queue ON graphile_worker."+table+" TO coginebot_app_16384 USING (true) WITH CHECK (true);").join("\\n")+"\\n";
      if (process.env.QUEUE_MODE === "extra-table") sql += "CREATE POLICY coginebot_app_queue ON graphile_worker._private_unrecognized TO coginebot_app_16384 USING (true) WITH CHECK (true);\\n";
      if (process.env.QUEUE_MODE === "predicate") sql = sql.replace("USING (true)","USING (false)");
      process.stdout.write(sql);
    } else if (tool[4] === process.env.PG_VIRTUAL+"/restore.toc") {
      event("producer"); process.stdout.write(process.env.RESTORE_SQL); fail("producer");
    } else die("Unexpected restore selection");
  } else die("Unexpected PG transport command");
} else die("Unexpected Compose transport command");
`,
  );
  chmodSync(docker, 0o755);
  function seal() {
    write(
      path.join(snapshot, "SHA256SUMS"),
      `${["rakazo.dump", "appdata.tgz", "SOURCE_SIZE_KB"]
        .map(
          (name) =>
            `${createHash("sha256")
              .update(readFileSync(path.join(snapshot, name)))
              .digest("hex")}  ${name}`,
        )
        .join("\n")}\n`,
    );
  }
  seal();
  return {
    root,
    checkout,
    snapshot,
    appdata,
    evidence,
    pgStage,
    adminRunning,
    composeFiles,
    seal,
    run(extra: Record<string, string> = {}) {
      return spawnSync("bash", [path.join(checkout, "infra/compose/restore-prod.sh"), snapshot], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RAKAZO_DEPLOY_DIR: checkout,
          RAKAZO_COMPOSE_FILE: supervisor
            ? "infra/compose/docker-compose.prod.yml|overlays/supervisor.yml"
            : undefined,
          COMPOSE_PATH_SEPARATOR: supervisor ? "|" : undefined,
          COMMAND_LOG: log,
          ENV_FILE: path.join(checkout, ".env"),
          COMPOSE_FILES: JSON.stringify(composeFiles),
          SUPERVISOR: supervisor ? "1" : "0",
          APPDATA: appdata,
          RESTORE_TEST_PG_STAGE: pgStage,
          RESTORE_TEST_ADMIN_RUNNING: adminRunning,
          PG_VIRTUAL: pgVirtual,
          EVIDENCE: evidence,
          ARCHIVE_TOC: archiveToc,
          QUEUE_TABLES: JSON.stringify(queueTables),
          RESTORE_SQL: restoreSql,
          AUTHORITY_SQL: authoritySql,
          ...extra,
        },
      });
    },
    events(): Event[] {
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    },
  };
}

function oldFilesRemain(f: ReturnType<typeof fixture>) {
  expect(readFileSync(path.join(f.appdata, "home.txt"), "utf8")).toBe("current home");
  expect(existsSync(path.join(f.appdata, "current-only.txt"))).toBe(true);
  expect(existsSync(path.join(f.appdata, "restored-only.txt"))).toBe(false);
  expect(readdirSync(path.dirname(f.appdata))).toEqual(["data"]);
  expect(f.events().some((event) => event.kind === "runtime-start")).toBe(false);
  expect(readdirSync(f.checkout).some((name) => name.startsWith(".restore."))).toBe(false);
  expect(existsSync(f.pgStage)).toBe(false);
}

/** Make a genuine gzip/ustar member whose path must be refused before extraction. */
function parentPathArchive() {
  const header = Buffer.alloc(512);
  const field = (start: number, length: number, value: string) =>
    header.write(value, start, length, "ascii");
  field(0, 100, "../outside-home");
  field(100, 8, "0000644\0");
  field(108, 8, "0000000\0");
  field(116, 8, "0000000\0");
  field(124, 12, "00000000001\0");
  field(136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  field(
    148,
    8,
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
  );
  return gzipSync(Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511 + 1024)]));
}

describe("production restore shell lifecycle", () => {
  it.each([false, true])(
    "restores and restarts the selected stack (supervisor=%s)",
    (supervisor) => {
      const f = fixture(supervisor);
      const result = f.run();
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const events = f.events();
      expect(events.map((event) => event.kind)).toEqual([
        "services",
        "stop",
        "postgres",
        "ready",
        "pg-stage",
        "copy-archive",
        "list",
        "copy-queue.toc",
        "queue-sql",
        "copy-restore.toc",
        "producer",
        "prepare",
        "authority",
        "loader",
        "owner-migrate",
        "verify",
        "api-id",
        "inspect",
        "runtime-start",
        "pg-cleanup",
      ]);
      expect(events.find((event) => event.kind === "owner-migrate")!.args.slice(-9)).toEqual([
        "up",
        "--no-deps",
        "--no-build",
        "--pull",
        "never",
        "--abort-on-container-exit",
        "--exit-code-from",
        "migrate",
        "migrate",
      ]);
      expect(existsSync(f.adminRunning)).toBe(false);
      const writers = ["api", "worker", ...(supervisor ? ["supervisor"] : [])];
      expect(
        events.find((event) => event.kind === "stop")!.args.slice(-writers.length - 3),
      ).toEqual(["stop", "--timeout", "120", ...writers]);
      for (const event of events.filter((event) => event.args[0] === "compose")) {
        expect(event.args.slice(0, 3)).toEqual([
          "compose",
          "--env-file",
          path.join(f.checkout, ".env"),
        ]);
        expect(event.args.filter((_, index) => event.args[index - 1] === "-f")).toEqual(
          f.composeFiles,
        );
      }
      expect(readFileSync(path.join(f.evidence, "restore.toc"), "utf8")).toBe(
        `${ordinaryToc.join("\n")}\n`,
      );
      expect(readFileSync(path.join(f.evidence, "queue.toc"), "utf8")).toBe(
        archiveToc.split("\n").slice(ordinaryToc.length).join("\n"),
      );
      expect(readFileSync(path.join(f.evidence, "loader.sql"), "utf8")).toBe(restoreSql);
      const loader = events.find((event) => event.kind === "loader")!;
      expect(loader.args.find((arg) => arg.startsWith("exec psql "))).toBe(
        'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" --set=ON_ERROR_STOP=on --single-transaction --file=- --command "$1"',
      );
      expect(loader.args.at(-1)).toBe(
        `${authoritySql.trimEnd()}\n${readFileSync(path.join(repoRoot, "scripts/restore-transfer-fence.sql"), "utf8").trimEnd()}`,
      );
      expect(readFileSync(path.join(f.appdata, "home.txt"), "utf8")).toBe("restored home 合成 α");
      expect(existsSync(path.join(f.appdata, "current-only.txt"))).toBe(false);
      const rollback = readdirSync(path.dirname(f.appdata)).filter((name) =>
        name.startsWith(".coginebot-rollback."),
      );
      expect(rollback).toHaveLength(1);
      expect(
        readFileSync(path.join(path.dirname(f.appdata), rollback[0]!, "data/home.txt"), "utf8"),
      ).toBe("current home");
      expect(existsSync(f.pgStage)).toBe(false);
      expect(result.stdout).toContain("Restore complete");
    },
  );

  it.each(["producer", "prepare", "authority", "loader", "owner-migrate", "verify"])(
    "keeps old files and writers stopped when %s fails",
    (stage) => {
      const f = fixture();
      const result = f.run({ FAIL_STAGE: stage });
      expect(result.status, result.stderr).toBe(17);
      const events = f.events();
      const kinds = events.map((event) => event.kind);
      const phases = [
        "producer",
        "prepare",
        "authority",
        "loader",
        "owner-migrate",
        "verify",
        "api-id",
        "inspect",
        "runtime-start",
      ];
      expect(kinds).toContain(stage);
      for (const later of phases.slice(phases.indexOf(stage) + 1))
        expect(kinds).not.toContain(later);
      expect(events.filter((event) => event.kind === "stop")).toHaveLength(2);
      expect(events.findLast((event) => event.kind === "stop")!.args.slice(-3)).toEqual([
        "stop",
        "api",
        "worker",
      ]);
      if (["owner-migrate", "verify"].includes(stage)) {
        const adminStops = events.filter((event) => event.kind === "admin-stop");
        expect(adminStops).toHaveLength(1);
        expect(adminStops[0]!.args.slice(-4)).toEqual(["stop", "--timeout", "120", "migrate"]);
        expect(kinds.indexOf("admin-stop")).toBeGreaterThan(kinds.lastIndexOf("stop"));
        expect(kinds.indexOf("admin-stop")).toBeLessThan(kinds.indexOf("pg-cleanup"));
        expect(existsSync(f.adminRunning)).toBe(false);
      } else expect(kinds).not.toContain("admin-stop");
      oldFilesRemain(f);
      expect(result.stdout).not.toContain("Restore complete");
    },
  );

  it("keeps writers stopped when stopping an interrupted administrator fails", () => {
    const f = fixture();
    const result = f.run({ FAIL_STAGE: "owner-migrate", FAIL_ADMIN_STOP: "1" });
    expect(result.status, result.stderr).toBe(17);
    expect(result.stderr).toContain("The administrator migration could not be stopped");
    const events = f.events();
    const kinds = events.map((event) => event.kind);
    expect(events.filter((event) => event.kind === "admin-stop")).toHaveLength(1);
    expect(kinds.indexOf("admin-stop")).toBeGreaterThan(kinds.lastIndexOf("stop"));
    expect(kinds.indexOf("admin-stop")).toBeLessThan(kinds.indexOf("pg-cleanup"));
    expect(readFileSync(f.adminRunning, "utf8")).toBe("running");
    expect(kinds).not.toContain("verify");
    expect(kinds).not.toContain("api-id");
    oldFilesRemain(f);
  });

  it.each(["extra-table", "predicate"])(
    "rejects unrecognized serialized queue policy SQL: %s",
    (mode) => {
      const f = fixture();
      const result = f.run({ QUEUE_MODE: mode });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("The archived managed queue policies are not recognized");
      expect(f.events().map((event) => event.kind)).not.toContain("producer");
      expect(f.events().map((event) => event.kind)).not.toContain("loader");
      oldFilesRemain(f);
    },
  );

  it.each(["checksum", "inventory", "parent-path", "corrupt-archive"])(
    "refuses invalid snapshot %s before stopping writers",
    (mode) => {
      const f = fixture();
      if (mode === "checksum") write(path.join(f.snapshot, "rakazo.dump"), "changed after sealing");
      if (mode === "inventory")
        write(path.join(f.snapshot, "SHA256SUMS"), `${"a".repeat(64)}  ../outside\n`);
      if (mode === "parent-path") {
        write(path.join(f.snapshot, "appdata.tgz"), parentPathArchive());
        f.seal();
      }
      if (mode === "corrupt-archive") {
        write(path.join(f.snapshot, "appdata.tgz"), "invalid gzip archive");
        f.seal();
      }
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(f.events().map((event) => event.kind)).toEqual(["services"]);
      oldFilesRemain(f);
    },
  );
});
