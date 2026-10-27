import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { MAX_DESKTOP_DISPLAY } from "@rakazo/core/node/desktop-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import { LinuxDesktop } from "./linux-desktop.js";

// Bash passes its open descriptors to this short process. flock locks the shared open
// file description, so the owning shell retains the real kernel lock after Python exits.
const FLOCK = `import fcntl, os, sys, time
args = sys.argv[1:]
fd = int(args[-1])
if args[0] == '-u':
    fcntl.flock(fd, fcntl.LOCK_UN)
    sys.exit(0)
deadline = time.monotonic() + (float(args[1]) if args[0] == '-w' else 0)
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sys.exit(0)
    except BlockingIOError:
        if args[0] == '-n' or time.monotonic() >= deadline: sys.exit(1)
        time.sleep(0.01)
`;

const computer = {
  id: "computer-work",
  botId: "a",
  kind: "e2b",
  providerRef: "offline",
} as ComputerRef;
const context = {
  operationId: "work",
  traceId: "work",
  spaceId: "space-work",
  userId: "user-work",
  botId: "a",
  screenLeaseId: "run:1",
  signal: new AbortController().signal,
} as AdapterContext;

const fixtures: Array<{ root: string; jobs: Set<ChildProcess> }> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    for (const job of f.jobs) {
      try {
        if (job.pid) process.kill(-job.pid, "SIGKILL");
      } catch {
        // The command may already have exited.
      }
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "linux-work-"));
  const runtime = path.join(root, "runtime");
  const bin = path.join(root, "bin");
  mkdirSync(runtime);
  mkdirSync(bin);
  const record = path.join(root, "work-record");
  const held = path.join(root, "held");
  const gate = path.join(root, "gate");
  const flock = path.join(root, "flock.py");
  writeFileSync(flock, FLOCK);
  const executable = (name: string, body: string) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(file, 0o755);
  };
  executable(
    "xdotool",
    [
      'printf "%s\\n" "$*" >>"$WORK_RECORD"',
      'if [[ "$*" == *held-input* ]]; then',
      '  touch "$WORK_HELD"',
      '  while [ ! -f "$WORK_GATE" ]; do sleep 0.01; done',
      "fi",
      'if [ "$1" = getmouselocation ]; then printf "X=10\\nY=20\\n"; fi',
    ].join("\n"),
  );
  executable("scrot", 'printf scrot >>"$WORK_RECORD"; printf "image" >"$2"');
  executable(
    "base64",
    `python3 -c 'import base64,sys; sys.stdout.write(base64.b64encode(open(sys.argv[-1], "rb").read()).decode())' "$@"`,
  );
  const jobs = new Set<ChildProcess>();
  fixtures.push({ root, jobs });
  const env = {
    homeDir: root,
    workspaceDir: root,
    browserProfilesDir: path.join(root, "profiles"),
    displayStart: MAX_DESKTOP_DISPLAY,
  };
  const commands: Array<{ command: string; context: AdapterContext }> = [];
  const processEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    WORK_FLOCK: flock,
    WORK_RECORD: record,
    WORK_HELD: held,
    WORK_GATE: gate,
  };
  const execute = (command: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const script = [
        'flock() { python3 "$WORK_FLOCK" "$@"; }',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell expansion
        'bash() { if [ "${4:-}" = desktop ]; then return 0; else command bash "$@"; fi; }',
        "export -f flock bash",
        command.replaceAll("/tmp/rakazo", runtime),
      ].join("\n");
      const child = spawn("bash", ["-eu", "-c", script], {
        env: processEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      jobs.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        jobs.delete(child);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  let afterEnsure: ((current: AdapterContext) => Promise<void>) | undefined;
  let beforeWork: ((command: string, current: AdapterContext) => Promise<void>) | undefined;
  let afterWork: ((command: string) => void) | undefined;
  const desktop = new LinuxDesktop({
    environment: async () => env,
    run: async (_computer, command, current) => {
      commands.push({ command, context: current });
      const ensuring = command.includes("RAKAZO_DESKTOP=");
      if (!ensuring) await beforeWork?.(command, current);
      const result = await execute(command);
      if (ensuring && result.code === 0) await afterEnsure?.(current);
      if (!ensuring && result.code === 0) afterWork?.(command);
      return result;
    },
    screenUrl: async () => "http://screen.example",
  });
  const peer = { ...context, botId: "b", screenLeaseId: "peer:1" };
  const slot = (bot = "a") =>
    path.join(
      runtime,
      "desktop-assignments",
      `${createHash("sha256").update(bot).digest("hex").slice(0, 32)}.slot`,
    );
  const state = (bot = "a") => readFileSync(slot(bot), "utf8").split("\n");
  const watch = (current = context) =>
    desktop.connectScreen(computer, { view: "stream", interactive: false }, current);
  const idle = async () => {
    await watch();
    await desktop.releaseScreen(computer, context);
  };
  const recycle = async () => {
    await desktop.releaseScreen(computer, context);
    await watch(peer);
  };
  const entries = () => (existsSync(record) ? readFileSync(record, "utf8") : "");
  const lockFree = (file: string) =>
    spawnSync(
      "python3",
      [
        "-c",
        "import fcntl,sys; f=open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)",
        file,
      ],
      { encoding: "utf8" },
    ).status === 0;
  return {
    root,
    runtime,
    desktop,
    commands,
    held,
    gate,
    slot,
    state,
    watch,
    idle,
    recycle,
    peer,
    entries,
    lockFree,
    afterEnsure: (hook?: typeof afterEnsure) => {
      afterEnsure = hook;
    },
    beforeWork: (hook?: typeof beforeWork) => {
      beforeWork = hook;
    },
    afterWork: (hook?: typeof afterWork) => {
      afterWork = hook;
    },
  };
}

describe("LinuxDesktop finite work allocation", () => {
  it.each(["run:1", undefined])(
    "keeps an idle watch with lease %s reclaimable at the existing display ceiling",
    async (screenLeaseId) => {
      const f = fixture();
      await f.idle();
      const idleAt = f.state()[5];
      await f.watch({ ...context, screenLeaseId });
      expect(f.state()[4]).toBe("idle");
      expect(f.state()[5]).toBe(idleAt);
      expect(f.state()[2]).not.toBe("");
      await f.watch(f.peer);
      expect(existsSync(f.slot())).toBe(false);
      expect(f.state("b")[0]).toBe("0");
    },
  );

  it.each([
    { screenLeaseId: "run:2", legacy: false },
    { screenLeaseId: "next:2", legacy: false },
    { screenLeaseId: "next:2", legacy: true },
  ])(
    "protects a retained desktop claimed by $screenLeaseId (legacy=$legacy) until release",
    async ({ screenLeaseId, legacy }) => {
      const f = fixture();
      await f.idle();
      if (legacy) {
        const slot = f.state();
        slot[1] = "";
        writeFileSync(f.slot(), slot.join("\n"));
      }
      const current = { ...context, screenLeaseId };
      await f.watch(current);
      expect(f.state()[1]).toBe(screenLeaseId);
      expect(f.state()[4]).toBe("active");
      expect(f.state()[5]).toBe("");
      const claimed = readFileSync(f.slot(), "utf8");

      await expect(f.watch(f.peer)).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
      await expect(f.watch()).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
      await f.desktop.releaseScreen(computer, context);
      expect(readFileSync(f.slot(), "utf8")).toBe(claimed);
      expect(existsSync(f.slot("b"))).toBe(false);

      await f.desktop.sendInput(computer, { kind: "clipboard", text: "current-run" }, current);
      expect(f.entries()).toBe("type current-run\n");
      await f.desktop.releaseScreen(computer, current);
      expect(f.state()[4]).toBe("idle");
      await f.watch(f.peer);
      expect(existsSync(f.slot())).toBe(false);
      expect(f.state("b")[0]).toBe("0");
    },
  );

  it.each(["act", "input", "observe"])(
    "rejects cached %s after release and another bot reuses the display",
    async (operation) => {
      const f = fixture();
      await f.idle();
      let interleaved = false;
      f.afterEnsure(async (current) => {
        if (current.botId !== "a" || interleaved) return;
        interleaved = true;
        await f.recycle();
      });
      // Human input has no execution lease; allocation identity must still fence it.
      const human = { ...context, screenLeaseId: undefined };
      const work =
        operation === "act"
          ? f.desktop.act(
              computer,
              { actions: [{ kind: "clipboard", text: "stale" }], observe: false },
              human,
            )
          : operation === "input"
            ? f.desktop.sendInput(computer, { kind: "clipboard", text: "stale" }, human)
            : f.desktop.observe(computer, human);
      await expect(work).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
      expect(f.entries()).toBe("");
      expect(f.state("b")[0]).toBe("0");
    },
  );

  it("rejects a same-bot allocation ABA with a newly rotated view token", async () => {
    const f = fixture();
    await f.idle();
    let token = "";
    let once = false;
    f.afterEnsure(async (current) => {
      if (current.botId !== "a" || once) return;
      once = true;
      token = f.state()[2]!;
      await f.desktop.releaseScreen(computer, context);
      await f.watch();
    });
    await expect(
      f.desktop.sendInput(computer, { kind: "clipboard", text: "stale" }, context),
    ).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
    expect(f.state()[2]).not.toBe(token);
    expect(f.entries()).toBe("");
  });

  it("does not replay a completed action when the next action loses its allocation", async () => {
    const f = fixture();
    await f.idle();
    let once = false;
    f.beforeWork(async (command) => {
      if (!command.includes("input-second") || once) return;
      once = true;
      await f.recycle();
    });
    await expect(
      f.desktop.act(
        computer,
        {
          actions: [
            { kind: "clipboard", text: "input-first" },
            { kind: "clipboard", text: "input-second" },
          ],
          observe: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
    expect(f.entries()).toBe("type input-first\n");
  });

  it("holds the lifecycle lock only for actual input and releases the registry lock", async () => {
    const f = fixture();
    await f.idle();
    const work = f.desktop.sendInput(computer, { kind: "clipboard", text: "held-input" }, context);
    try {
      await vi.waitFor(() => expect(existsSync(f.held)).toBe(true));
      const lifecycle = f.slot().replace(/\.slot$/, ".lifecycle-lock");
      expect(f.lockFree(lifecycle)).toBe(false);
      expect(f.lockFree(path.join(f.runtime, "desktop-assignments", ".lock"))).toBe(true);
      await expect(f.watch(f.peer)).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
      expect(f.state()[4]).toBe("idle");
    } finally {
      writeFileSync(f.gate, "continue");
      await work;
    }
    expect(f.state()[4]).toBe("idle");
    await f.watch(f.peer);
    expect(f.state("b")[0]).toBe("0");
  });

  it("serializes ordinary release behind in-flight input before freeing its access", async () => {
    const f = fixture();
    await f.idle();
    const work = f.desktop.sendInput(computer, { kind: "clipboard", text: "held-input" }, context);
    let released = false;
    let release: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(f.held)).toBe(true));
      release = f.desktop.releaseScreen(computer, context).then(() => {
        released = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(released).toBe(false);
      expect(f.state()[2]).not.toBe("");
    } finally {
      writeFileSync(f.gate, "continue");
      await Promise.all([work, release]);
    }
    expect(f.state()[4]).toBe("idle");
    expect(f.state()[2]).toBe("");
  });

  it.each(["run:2", "next:2"])(
    "rejects old work after %s and preserves its current allocation",
    async (nextLease) => {
      const f = fixture();
      await f.idle();
      let once = false;
      f.afterEnsure(async (current) => {
        if (current.botId !== "a" || once) return;
        once = true;
        await f.watch({ ...context, screenLeaseId: nextLease });
      });
      await expect(
        f.desktop.sendInput(computer, { kind: "clipboard", text: "old-run" }, context),
      ).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
      const current = f.state();
      await f.desktop.releaseScreen(computer, context);
      expect(f.state()).toEqual(current);
      expect(current[1]).toBe(nextLease);
      expect(f.entries()).toBe("");
    },
  );

  it("does not retry a command whose remote completion was not acknowledged", async () => {
    const f = fixture();
    await f.idle();
    const unavailable = new Error("command result unavailable");
    f.afterWork((command) => {
      if (command.includes("uncertain-input")) throw unavailable;
    });
    await expect(
      f.desktop.sendInput(computer, { kind: "clipboard", text: "uncertain-input" }, context),
    ).rejects.toBe(unavailable);
    expect(f.entries()).toBe("type uncertain-input\n");
    expect(f.commands.filter(({ command }) => command.includes("uncertain-input"))).toHaveLength(1);
  });
});
