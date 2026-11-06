import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdaterApp } from "./index.js";
import { DEFAULT_COMPOSE_FILE, resolveUpdaterConfig } from "./updater-logic.js";

const token = "fake-updater-recovery-token-0000000000";
const currentCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);
const oldTag = `local-${currentCommit}`;
const originalRemote = "https://github.com/example/previous-fork";
const nextRemote = "https://github.com/example/next-fork";
const originalEnv = `RAKAZO_IMAGE_TAG=${oldTag}\nRAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\nPOSTGRES_APP_PASSWORD=selected-runtime\n`;
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

type Failure =
  | "checkout"
  | "merge"
  | "recreate"
  | "restore-checkout"
  | "recover"
  | "read-head"
  | "stop"
  | "migrate"
  | "missing-script"
  | "migration-timeout"
  | "stop-migration"
  | "readiness";
interface Invocation {
  command: string;
  args: string[];
  commit: string;
  compose?: string;
  serviceEnv?: string;
  imageTag?: string;
  envFile?: string;
  migrationImage?: string;
}

// These executables use only fixture files. PATH contains no real git or Docker, and the
// updater's production execFile runner is used so command ordering is exercised end to end.
const fakeExecutable = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const stateFile = path.join(__dirname, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const call = { command, args, commit: state.commit };
const log = () => fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(call) + "\n");
const fail = (message) => { process.stderr.write(message); process.exit(1); };
const hasFailure = (name) => fixture.failures.includes(name);
const moveCheckout = (commit, branch, revision) => {
  state.commit = commit;
  state.branch = branch;
  fs.writeFileSync(fixture.composeFile, fixture[revision + "Compose"]);
  fs.writeFileSync(fixture.serviceEnv, "REVISION=" + revision + "\n");
};
if (command === "docker") {
  if (args[0] === "image" && args[1] === "inspect") {
    log(); process.stdout.write("sha256:" + "a".repeat(64));
  } else if (args[0] === "inspect") {
    log(); process.stdout.write(JSON.stringify({ image: "sha256:" + "a".repeat(64), running: state.migrationRunning === true, status: state.migrationRunning ? "running" : "exited", exitCode: fixture.failures.some(f => ["migrate", "missing-script", "migration-timeout"].includes(f)) ? 1 : 0, project: "fixture-stack", service: "migrate", oneoff: "False" }));
  } else if (args.includes("config") && args.includes("--quiet")) {
    log();
    const definition = JSON.parse(fs.readFileSync(args[args.indexOf("--file") + 1], "utf8"));
    const contents = fs.readFileSync(args[args.indexOf("--env-file") + 1], "utf8");
    const present = fixture.nativePasswordPresent ?? Boolean(require("node:util").parseEnv(contents).POSTGRES_APP_PASSWORD);
    if (definition.services.runtimeEnv.environment && !present) fail("COGINEBOT_RUNTIME_PASSWORD_REQUIRED");
  } else if (args.includes("config") && args.includes("--format")) {
    log();
    const selected = "postgres://runtime:fixture-secret@database/app";
    const old = state.commit === fixture.currentCommit;
    const environment = { DATABASE_URL: old && fixture.oldConfiguration === "different" ? "postgres://unverified:other-secret@database/app" : selected };
    if (old && fixture.oldConfiguration === "owner") environment.DATABASE_MIGRATION_URL = "postgres://owner:owner-secret@database/app";
    const services = {
      api: { environment, command: old && fixture.oldConfiguration === "admin-command" ? "pnpm --filter @rakazo/db prisma migrate deploy && pnpm start" : "pnpm start" },
      worker: { environment },
      web: old && fixture.oldConfiguration === "listener" ? { environment: { REALTIME_DATABASE_URL: "postgres://listener:other-secret@database/app" } } : {},
      ...(fixture.extraService ? { [fixture.extraService]: { environment } } : {}),
      migrate: { environment: { DATABASE_URL: selected } },
    };
    process.stdout.write(JSON.stringify({ services }));
  } else {
    call.compose = fs.readFileSync(args[args.indexOf("--file") + 1], "utf8");
    call.serviceEnv = fs.readFileSync(fixture.serviceEnv, "utf8");
    call.envFile = fs.readFileSync(args[args.indexOf("--env-file") + 1], "utf8");
    call.imageTag = process.env.RAKAZO_IMAGE_TAG;
    const overrideIndex = args.lastIndexOf("--file");
    if (overrideIndex !== args.indexOf("--file")) {
      call.migrationImage = JSON.parse(fs.readFileSync(args[overrideIndex + 1], "utf8")).services.migrate.image;
    }
    log();
    if (args.includes("build")) {
    } else if (args.includes("ps")) {
      process.stdout.write("b".repeat(64));
    } else if (args.includes("stop")) {
      if (fixture.extraService && args.includes(fixture.extraService)) {
        state.extraRunning = false; fs.writeFileSync(stateFile, JSON.stringify(state));
      }
      if (args.at(-1) === "migrate") {
        if (hasFailure("stop-migration")) fail("migration did not stop");
        state.migrationRunning = false; fs.writeFileSync(stateFile, JSON.stringify(state));
      } else if (hasFailure("stop") && !state.stopFailed) {
        state.stopFailed = true; fs.writeFileSync(stateFile, JSON.stringify(state)); fail("one old writer stopped before stop failed");
      }
    } else if (args.includes("run")) {
      if (args.slice(-7).join(" ") !== "migrate pnpm --filter @rakazo/api run db:row-security verify") fail("Unexpected verification command");
      if (hasFailure("readiness")) fail("database roles or policies are not ready");
    } else if (args.includes("--exit-code-from")) {
      if (fixture.extraService && state.extraRunning !== false) fail("old extra writer still running");
      if (hasFailure("migration-timeout")) { state.migrationRunning = true; fs.writeFileSync(stateFile, JSON.stringify(state)); fail("migration client timed out with a live service"); }
      if (hasFailure("missing-script")) fail("ERR_PNPM_NO_SCRIPT Missing script: db:migrate");
      if (hasFailure("migrate")) fail("migration failed");
    } else if (args.includes("up")) {
      if (state.commit === fixture.targetCommit && fixture.failures.length > 0) fail("new API unhealthy");
      if (state.commit !== fixture.targetCommit && hasFailure("recover")) fail("cached image unavailable");
    } else fail("Unexpected Docker command");
  }
} else if (command === "git") {
  log();
  const joined = args.join(" ");
  if (joined === "rev-parse HEAD") {
    if (hasFailure("read-head")) fail("HEAD unreadable");
    process.stdout.write(state.commit);
  } else if (joined === "rev-parse --abbrev-ref HEAD") {
    process.stdout.write(state.branch);
  } else if (joined === "remote get-url origin") {
    process.stdout.write(state.remote);
  } else if (args[0] === "ls-remote") {
    process.stdout.write(fixture.targetCommit + "\trefs/heads/main\n");
  } else if (args[0] === "remote" && args[1] === "set-url") {
    state.remote = args[3];
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } else if (args[0] === "checkout" || args[0] === "merge") {
    const restore = args.includes("-B") || args.includes("--detach");
    if (restore && hasFailure("restore-checkout")) fail("checkout restore blocked");
    if (restore) {
      moveCheckout(args.at(-1), args.includes("-B") ? args[2] : "HEAD", "old");
    } else {
      moveCheckout(fixture.targetCommit, "main", "new");
    }
    fs.writeFileSync(stateFile, JSON.stringify(state));
    if (!restore && hasFailure(args[0])) fail("checkout transition failed");
  } else if (args[0] !== "fetch" && !args.includes("status") && !args.includes("ls-files")) {
    fail("Unexpected Git command");
  }
} else {
  fail("Unexpected executable");
}
`;

async function deployment(options: {
  failures: Failure[];
  branch?: string;
  composePath?: string;
  env?: string;
  nativePasswordPresent?: boolean;
  extraService?: string;
  oldConfiguration?: "owner" | "different" | "admin-command" | "listener";
}) {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-fork-recovery-"));
  directories.push(deployDir);
  const bin = path.join(deployDir, "fake-bin");
  const composeFile = path.join(deployDir, options.composePath ?? DEFAULT_COMPOSE_FILE);
  const config = resolveUpdaterConfig({
    RAKAZO_DEPLOY_DIR: deployDir,
    RAKAZO_UPDATER_TOKEN: token,
    RAKAZO_COMPOSE_FILE: options.composePath,
    COMPOSE_PROJECT_NAME: "fixture-stack",
    RAKAZO_UPDATE_SERVICES: options.extraService,
  });
  const serviceEnv = path.join(path.dirname(composeFile), "service.env");
  const compose = (revision: string) =>
    `services:\n  api:\n    image: example/app:\${RAKAZO_IMAGE_TAG}\n    env_file: ./service.env\n    command: ${revision}\n`;
  await Promise.all([
    mkdir(bin),
    mkdir(path.join(deployDir, ".git")),
    mkdir(path.dirname(composeFile), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(config.envFile, options.env ?? originalEnv),
    writeFile(composeFile, compose("old")),
    writeFile(serviceEnv, "REVISION=old\n"),
    writeFile(
      path.join(bin, "fixture.json"),
      JSON.stringify({
        failures: options.failures,
        nativePasswordPresent: options.nativePasswordPresent,
        extraService: options.extraService,
        oldConfiguration: options.oldConfiguration,
        currentCommit,
        targetCommit,
        composeFile,
        serviceEnv,
        oldCompose: compose("old"),
        newCompose: compose("new"),
      }),
    ),
    writeFile(
      path.join(bin, "state.json"),
      JSON.stringify({
        commit: currentCommit,
        branch: options.branch ?? "deploy",
        remote: originalRemote,
      }),
    ),
    ...["git", "docker"].map((name) =>
      writeFile(path.join(bin, name), `#!${process.execPath}\n${fakeExecutable}`, { mode: 0o700 }),
    ),
  ]);
  vi.stubEnv("PATH", bin);
  const subject = createUpdaterApp(config);
  const response = await subject.request("/apply", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ repoUrl: nextRemote, branch: "main" }),
  });
  const calls = (await readFile(path.join(bin, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Invocation);
  return {
    response,
    subject,
    record: (await response.json()) as ServerUpdateRun,
    calls,
    config,
    composeFile,
    state: JSON.parse(await readFile(path.join(bin, "state.json"), "utf8")),
  };
}

describe.skipIf(process.platform === "win32")("fork recovery through fake executables", () => {
  it.each([
    { branch: "deploy", composePath: undefined },
    { branch: "HEAD", composePath: "ops/custom-compose.yml" },
  ])("restores $branch and its Compose configuration before recovery", async (options) => {
    const fixture = await deployment({ ...options, failures: ["recreate"] });
    expect(fixture.response.status).toBe(200);
    expect(fixture.record).toMatchObject({ ok: false, restart: "not-required" });
    const docker = fixture.calls.filter(
      (call) =>
        call.command === "docker" &&
        call.args.includes("up") &&
        !call.args.includes("--exit-code-from"),
    );
    expect(docker).toHaveLength(2);
    expect(docker[0]).toMatchObject({
      commit: targetCommit,
      compose: expect.stringContaining("command: new"),
      serviceEnv: "REVISION=new\n",
    });
    expect(docker.at(-1)).toMatchObject({
      commit: currentCommit,
      compose: expect.stringContaining("command: old"),
      serviceEnv: "REVISION=old\n",
      imageTag: oldTag,
      envFile: originalEnv,
    });
    expect(fixture.record.steps.map((step) => step.id)).toEqual([
      "remote",
      "fetch",
      "checkout",
      "merge",
      "build",
      "pin-migration",
      "stop",
      "migrate",
      "migration-container",
      "migration-state",
      "verify-forward",
      "recreate",
      "stop-writers",
      "stop-migration",
      "migration-container",
      "migration-state",
      "verify-recovery",
      "restore-checkout",
      "recover",
      "restore-remote",
    ]);
    expect(docker.at(-1)?.args).toEqual(
      expect.arrayContaining([
        "-p",
        "fixture-stack",
        "--file",
        fixture.composeFile,
        "--pull",
        "never",
        "--no-build",
      ]),
    );
    expect(fixture.state).toMatchObject({
      commit: currentCommit,
      branch: options.branch,
      remote: originalRemote,
    });
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it("skips Compose recovery when restoring the checkout fails", async () => {
    const fixture = await deployment({ failures: ["restore-checkout"] });
    expect(fixture.record).toMatchObject({
      ok: false,
      restart: "manual",
      error: "Recreate the services failed.",
    });
    expect(fixture.record.restartAdvice).toMatch(/skipped.*checkout could not be restored/);
    expect(
      fixture.calls.filter(
        (call) =>
          call.command === "docker" &&
          call.args.includes("up") &&
          !call.args.includes("--exit-code-from"),
      ),
    ).toHaveLength(1);
    expect(fixture.record.steps.filter((step) => step.id === "restore-checkout")).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
    expect(fixture.record.steps.at(-1)).toMatchObject({ id: "restore-remote", ok: true });
    expect(fixture.state.remote).toBe(originalRemote);
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it("reports failed Compose recovery while keeping the restored checkout and image pin", async () => {
    const fixture = await deployment({ failures: ["recover"] });
    expect(fixture.record).toMatchObject({
      ok: false,
      restart: "manual",
      error: "Recreate the services failed.",
    });
    expect(fixture.record.steps.find((step) => step.id === "recover")).toMatchObject({ ok: false });
    expect(
      fixture.calls
        .filter(
          (call) =>
            call.command === "docker" &&
            call.args.includes("up") &&
            !call.args.includes("--exit-code-from"),
        )
        .at(-1),
    ).toMatchObject({
      commit: currentCommit,
      serviceEnv: "REVISION=old\n",
      imageTag: oldTag,
    });
    expect(fixture.state).toMatchObject({
      commit: currentCommit,
      branch: "deploy",
      remote: originalRemote,
    });
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it.each(["checkout", "merge"] as const)(
    "restores a partially failed %s without invoking Compose",
    async (failure) => {
      const fixture = await deployment({ failures: [failure] });
      expect(fixture.record.ok).toBe(false);
      expect(fixture.record.steps.find((step) => step.id === "restore-checkout")).toMatchObject({
        ok: true,
      });
      expect(fixture.calls.every((call) => call.command === "git")).toBe(true);
      expect(fixture.state).toEqual({
        commit: currentCommit,
        branch: "deploy",
        remote: originalRemote,
      });
      expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
    },
  );

  it("refuses a fork update if its original commit cannot be read", async () => {
    const fixture = await deployment({ failures: ["read-head"] });
    expect(fixture.response.status).toBe(400);
    expect(fixture.record.error).toMatch(/commit.*before updating/);
    expect(
      fixture.calls.some(
        (call) =>
          call.args.includes("fetch") ||
          call.args.includes("checkout") ||
          call.command === "docker",
      ),
    ).toBe(false);
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it.each(["stop", "migrate", "missing-script", "migration-timeout"] as const)(
    "restores cached runtime after %s fails without rerunning migrations",
    async (failure) => {
      const fixture = await deployment({ failures: [failure] });
      expect(fixture.record).toMatchObject({ ok: false, restart: "not-required" });
      expect(fixture.record.steps.find((step) => step.id === "recover")).toMatchObject({
        ok: true,
      });
      const docker = fixture.calls.filter(
        (call) =>
          call.command === "docker" &&
          call.args.includes("up") &&
          !call.args.includes("--exit-code-from"),
      );
      expect(docker.at(-1)?.args).toEqual(
        expect.arrayContaining(["up", "--no-deps", "--no-build", "never"]),
      );
      expect(
        fixture.calls.filter(
          (call) => call.command === "docker" && call.args.includes("--exit-code-from"),
        ),
      ).toHaveLength(failure === "stop" ? 0 : 1);
      expect(fixture.record.steps.find((step) => step.id === "verify-recovery")).toMatchObject({
        ok: true,
      });
      const verification = fixture.calls.find(
        (call) => call.command === "docker" && call.args.includes("db:row-security"),
      );
      expect(verification?.migrationImage).toBe(`sha256:${"a".repeat(64)}`);
      expect(fixture.calls.at(-1)?.args).not.toContain("db:migrate");
      expect(docker.at(-1)?.commit).toBe(currentCommit);
      expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
    },
  );

  it.each(["stop-migration", "readiness"] as const)(
    "does not restart runtime when %s fails after migration timeout",
    async (failure) => {
      const fixture = await deployment({ failures: ["migration-timeout", failure] });
      expect(fixture.record).toMatchObject({ ok: false, restart: "manual" });
      expect(
        fixture.calls.some(
          (call) =>
            call.command === "docker" &&
            call.args.includes("up") &&
            !call.args.includes("--exit-code-from"),
        ),
      ).toBe(false);
      expect(fixture.record.steps.some((step) => step.id === "recover")).toBe(false);
      expect(fixture.record.restartAdvice).toContain("could not be verified");
    },
  );

  it("keeps a newly generated runtime password through failure and retry without changing other multiline secrets", async () => {
    const legacy =
      originalEnv.replace("POSTGRES_APP_PASSWORD=selected-runtime\n", "") +
      'POSTGRES_PASSWORD=selected-owner\nOTHER_SECRET="first line\nPOSTGRES_APP_PASSWORD=inside-another-secret\nlast line"\nPOSTGRES_APP_PASSWORD="" # empty\n';
    const fixture = await deployment({ failures: ["recreate"], env: legacy });
    const once = await readFile(fixture.config.envFile, "utf8");
    expect(once).toContain(
      'OTHER_SECRET="first line\nPOSTGRES_APP_PASSWORD=inside-another-secret\nlast line"',
    );
    expect(once).toContain("POSTGRES_PASSWORD=selected-owner");
    const password = once.match(/^POSTGRES_APP_PASSWORD=([a-f0-9]{32})$/m)?.[1];
    expect(password).toHaveLength(32);
    await fixture.subject.request("/apply", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: nextRemote, branch: "main" }),
    });
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(once);
  });

  it.each(["owner", "different", "admin-command", "listener"] as const)(
    "keeps writers stopped when the old configuration contains %s authority",
    async (oldConfiguration) => {
      const fixture = await deployment({ failures: ["recreate"], oldConfiguration });
      expect(fixture.record).toMatchObject({ ok: false, restart: "manual" });
      expect(fixture.record.restartAdvice).toContain("outside the verified credential inventory");
      expect(fixture.record.steps.some((step) => step.id === "recover")).toBe(false);
      expect(
        fixture.calls.filter(
          (call) => call.args.includes("up") && !call.args.includes("--exit-code-from"),
        ),
      ).toHaveLength(1);
      expect(fixture.record.steps.find((step) => step.id === "verify-recovery")?.ok).toBe(true);
      expect(JSON.stringify(fixture.record)).not.toMatch(
        /fixture-secret|owner-secret|other-secret/,
      );
    },
  );

  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation is the test input.
  it.each(["${UNSET}", "${EMPTY:-}"])(
    "fills a runtime password that Compose expands to empty (%s)",
    async (value) => {
      const original = originalEnv.replace(
        "POSTGRES_APP_PASSWORD=selected-runtime",
        `POSTGRES_APP_PASSWORD=${value}`,
      );
      const fixture = await deployment({
        failures: [],
        env: original,
        nativePasswordPresent: false,
      });
      expect(fixture.record.ok).toBe(true);
      expect(await readFile(fixture.config.envFile, "utf8")).toMatch(
        /^POSTGRES_APP_PASSWORD=[a-f0-9]{32}$/m,
      );
    },
  );

  it("preserves Compose's nonempty password when Node's dotenv parser reports it empty", async () => {
    const original = originalEnv.replace(
      "POSTGRES_APP_PASSWORD=selected-runtime",
      "POSTGRES_APP_PASSWORD= # empty",
    );
    const fixture = await deployment({ failures: [], env: original, nativePasswordPresent: true });
    const final = await readFile(fixture.config.envFile, "utf8");
    expect(final).toContain("POSTGRES_APP_PASSWORD= # empty");
    expect(final.match(/^POSTGRES_APP_PASSWORD=/gm)).toHaveLength(1);
    expect(fixture.record.ok).toBe(true);
  });

  it("stops a selected extra writer before administrator execution", async () => {
    const fixture = await deployment({ failures: [], extraService: "scheduler" });
    expect(fixture.record.ok).toBe(true);
    const calls = fixture.calls.filter((call) => call.command === "docker");
    const stop = calls.findIndex(
      (call) => call.args.includes("stop") && call.args.includes("scheduler"),
    );
    const admin = calls.findIndex((call) => call.args.includes("--exit-code-from"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(admin).toBeGreaterThan(stop);
    expect(fixture.state.extraRunning).toBe(false);
  });

  it("keeps the new checkout and image pin after a successful update", async () => {
    const fixture = await deployment({ failures: [] });
    expect(fixture.record).toMatchObject({ ok: true, restart: "recreated" });
    expect(
      fixture.record.steps.some((step) => step.id.startsWith("restore") || step.id === "recover"),
    ).toBe(false);
    expect(
      fixture.calls.filter(
        (call) =>
          call.command === "docker" &&
          call.args.includes("up") &&
          !call.args.includes("--exit-code-from"),
      ),
    ).toHaveLength(1);
    expect(fixture.state).toEqual({ commit: targetCommit, branch: "main", remote: nextRemote });
    expect(await readFile(fixture.config.envFile, "utf8")).toContain(
      `RAKAZO_IMAGE_TAG=local-${targetCommit}\n`,
    );
  });
});
