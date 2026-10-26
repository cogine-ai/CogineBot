import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserStoppedReleaseError } from "./computer-screens.js";
import { LinuxDesktop } from "./linux-desktop.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} as AdapterContext;

const computer = {
  id: "sandbox-1",
  botId: "team-workspace-1",
  kind: "e2b",
  providerRef: "sandbox-1",
} as ComputerRef;

function host(result: { code: number; stdout: string; stderr?: string }) {
  return {
    environment: async () => ({
      homeDir: "/home/rakazo",
      workspaceDir: "/home/rakazo",
      browserProfilesDir: "/home/rakazo/.browser-profiles",
      displayStart: 1,
    }),
    run: async () => result,
    screenUrl: async () => "http://screen.example",
  };
}

function shellHost() {
  const root = mkdtempSync(path.join(tmpdir(), "linux-publication-"));
  roots.push(root);
  return {
    root,
    slot: () => path.join(root, readdirSync(root).find((name) => name.endsWith(".slot"))!),
    host: {
      ...host({ code: 0, stdout: "" }),
      run: async (_computer: ComputerRef, command: string, _context: AdapterContext) => {
        if (command.includes("base64") && command.includes("CURSOR"))
          return { code: 0, stdout: "AQID\nCURSOR X=10 Y=20\n", stderr: "" };
        const result = spawnSync(
          "bash",
          [
            "-eu",
            "-c",
            [
              "flock() { :; }",
              "bash() { return 0; }",
              command
                .replaceAll("/tmp/rakazo/desktop-assignments", root)
                .replaceAll("/tmp/rakazo", root),
            ].join("\n"),
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    },
  };
}

describe("LinuxDesktop.releaseScreen", () => {
  it("drains captured pending cleanup after a successful ordinary release", async () => {
    const f = shellHost();
    let runs = 0;
    let urls = 0;
    const desktop = new LinuxDesktop({
      ...f.host,
      run: async (...args) => {
        if (++runs === 3) throw new Error("cleanup unavailable");
        return f.host.run(...args);
      },
      screenUrl: async () => {
        if (++urls === 1) throw new Error("publication failed");
        return "http://screen.example";
      },
    });
    const current = { ...context, screenLeaseId: "run:1" };
    await expect(
      desktop.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "human-a" },
        current,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    await desktop.releaseScreen(computer, current);
    const before = runs;
    await desktop.connectScreen(computer, { view: "stream", interactive: false }, current);
    expect(runs - before).toBe(1);
    expect(readFileSync(f.slot(), "utf8").split("\n")[3]).toBe("");
  });

  it.each(["computer", "screen"])("isolates pending cleanup by %s identity", async (identity) => {
    const first = shellHost();
    const other = shellHost();
    const commands: string[] = [];
    let urls = 0;
    const transport = new Error("first screen cleanup unavailable");
    const desktop = new LinuxDesktop({
      ...first.host,
      run: async (ref, command, current) => {
        if (ref.id === computer.id && current.botId === context.botId) {
          commands.push(command);
          if (commands.length >= 3) throw transport;
        }
        return (ref.id === computer.id ? first.host : other.host).run(ref, command, current);
      },
      screenUrl: async () => {
        if (++urls === 1) throw new Error("publication failed");
        return "http://screen.example";
      },
    });
    const current = { ...context, screenLeaseId: "run:1" };
    await expect(
      desktop.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "human-a" },
        current,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    const peer =
      identity === "computer"
        ? { ...computer, id: "other-computer", providerRef: "other" }
        : computer;
    const peerContext = identity === "screen" ? { ...current, botId: "other-bot" } : current;
    await desktop.connectScreen(peer, { view: "stream", interactive: false }, peerContext);
    await expect(
      desktop.connectScreen(computer, { view: "stream", interactive: false }, current),
    ).rejects.toBe(transport);
    expect(commands.at(-1)).not.toContain("RAKAZO_DESKTOP=");
  });

  it("retries an unconfirmed publication cleanup before a later ensure", async () => {
    const f = shellHost();
    let runs = 0;
    let urls = 0;
    const transport = new Error("cleanup transport failed before execution");
    const desktop = new LinuxDesktop({
      ...f.host,
      run: async (...args) => {
        runs += 1;
        if (runs === 3) throw transport;
        return f.host.run(...args);
      },
      screenUrl: async () => {
        if (++urls === 1) throw new Error("publication failed");
        return "http://screen.example";
      },
    });
    const current = { ...context, screenLeaseId: "run:1" };
    await expect(
      desktop.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "human-a" },
        current,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(readFileSync(f.slot(), "utf8").split("\n")[3]).toBe("human-a");
    await desktop.connectScreen(computer, { view: "stream", interactive: false }, current);
    expect(readFileSync(f.slot(), "utf8").split("\n")[3]).toBe("");
  });

  it("refuses ensure while publication cleanup is still unconfirmed", async () => {
    const f = shellHost();
    const commands: string[] = [];
    const transport = new Error("cleanup unavailable");
    const desktop = new LinuxDesktop({
      ...f.host,
      run: async (...args) => {
        commands.push(args[1]);
        if (commands.length >= 3) throw transport;
        return f.host.run(...args);
      },
      screenUrl: async () => {
        throw new Error("publication failed");
      },
    });
    const current = { ...context, screenLeaseId: "run:1" };
    await expect(
      desktop.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "human-a" },
        current,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(
      desktop.connectScreen(computer, { view: "stream", interactive: false }, current),
    ).rejects.toBe(transport);
    expect(commands[3]).not.toContain("RAKAZO_DESKTOP=");
    expect(readFileSync(f.slot(), "utf8").split("\n")[3]).toBe("human-a");
  });

  it.each(["human-a", "human-b"])(
    "does not clear replacement %s while retrying an old cleanup",
    async (replacement) => {
      const f = shellHost();
      let runs = 0;
      let urls = 0;
      const desktop = new LinuxDesktop({
        ...f.host,
        run: async (...args) => {
          if (++runs === 3) throw new Error("cleanup unavailable");
          return f.host.run(...args);
        },
        screenUrl: async () => {
          if (++urls === 1) throw new Error("publication failed");
          return "http://screen.example";
        },
      });
      const current = { ...context, screenLeaseId: "run:1" };
      await expect(
        desktop.connectScreen(
          computer,
          { view: "stream", interactive: true, controlToken: "human-a" },
          current,
        ),
      ).rejects.toBeInstanceOf(AggregateError);
      const next = { ...current, screenLeaseId: "next:2" };
      const otherCaller = new LinuxDesktop(f.host);
      await otherCaller.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: replacement },
        next,
      );
      const version = readFileSync(f.slot(), "utf8").split("\n")[7];
      await desktop.connectScreen(computer, { view: "stream", interactive: false }, next);
      const saved = readFileSync(f.slot(), "utf8").split("\n");
      expect(saved[3]).toBe(replacement);
      expect(saved[7]).toBe(version);
    },
  );

  it("cleans up a successful grant when publishing its screen URL fails", async () => {
    const f = shellHost();
    const failure = new Error("screen URL unavailable");
    const desktop = new LinuxDesktop({
      ...f.host,
      screenUrl: async () => {
        throw failure;
      },
    });
    const current = { ...context, screenLeaseId: "run:1" };
    await expect(
      desktop.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "human-a" },
        current,
      ),
    ).rejects.toBe(failure);
    expect(readFileSync(f.slot(), "utf8").split("\n")[3]).toBe("");
    await desktop.observe(computer, current);
    expect(readFileSync(f.slot(), "utf8").split("\n")[3]).toBe("");
  });

  it.each(["human-a", "human-b"])(
    "does not revoke replacement %s when an older screen publication fails",
    async (replacement) => {
      const f = shellHost();
      let reject!: (error: Error) => void;
      let started!: () => void;
      const publishing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<string>((_resolve, fail) => {
        reject = fail;
      });
      let calls = 0;
      const desktop = new LinuxDesktop({
        ...f.host,
        screenUrl: async () => {
          calls += 1;
          if (calls === 1) {
            started();
            return held;
          }
          return "http://screen.example";
        },
      });
      const current = { ...context, screenLeaseId: "run:1" };
      const failed = desktop
        .connectScreen(
          computer,
          { view: "stream", interactive: true, controlToken: "human-a" },
          current,
        )
        .catch((error: unknown) => error);
      await publishing;
      await desktop.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: replacement },
        current,
      );
      const version = readFileSync(f.slot(), "utf8").split("\n")[7];
      const failure = new Error("old URL failed");
      reject(failure);
      expect(await failed).toBe(failure);
      const saved = readFileSync(f.slot(), "utf8").split("\n");
      expect(saved[3]).toBe(replacement);
      expect(saved[7]).toBe(version);
    },
  );

  it("reports the browser stopped when slot cleanup fails after the release marker", async () => {
    const desktop = new LinuxDesktop(
      host({ code: 1, stdout: "RAKAZO_DESKTOP_RELEASED=0\n", stderr: "slot lock failed" }),
    );

    await expect(
      desktop.releaseScreen(computer, { ...context, cancelRunWork: true }),
    ).rejects.toBeInstanceOf(BrowserStoppedReleaseError);
  });

  it("keeps a release that never stops the browser as a failure", async () => {
    const desktop = new LinuxDesktop(
      host({ code: 1, stdout: "", stderr: "browser still running" }),
    );

    await expect(desktop.releaseScreen(computer, context)).rejects.toThrow("browser still running");
  });

  it.each(["e2b", "daytona", "box"] as const)(
    "retains an ordinary %s browser slot and fully releases it on cancel",
    async (kind) => {
      const root = mkdtempSync(path.join(tmpdir(), "linux-release-"));
      roots.push(root);
      const desktop = new LinuxDesktop({
        ...host({ code: 0, stdout: "" }),
        run: async (_computer, command) => {
          const result = spawnSync(
            "bash",
            [
              "-eu",
              "-c",
              [
                "flock() { :; }",
                "bash() { return 0; }",
                command
                  .replaceAll("/tmp/rakazo/desktop-assignments", root)
                  .replaceAll("/tmp/rakazo", root),
              ].join("\n"),
            ],
            { encoding: "utf8", timeout: 5_000 },
          );
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
      });
      const ref = { ...computer, kind };
      const current = { ...context, screenLeaseId: "run:1" };
      const before = await desktop.connectScreen(
        ref,
        { view: "stream", interactive: false },
        current,
      );
      await desktop.releaseScreen(ref, current);
      const slots = readdirSync(root).filter((name) => name.endsWith(".slot"));
      expect(slots).toHaveLength(1);
      expect(readFileSync(path.join(root, slots[0]!), "utf8").split("\n")[4]).toBe("idle");
      const after = await desktop.connectScreen(
        ref,
        { view: "stream", interactive: false },
        current,
      );
      expect(after.url).not.toBe(before.url);
      await desktop.releaseScreen(ref, { ...current, cancelRunWork: true });
      expect(readdirSync(root).filter((name) => name.endsWith(".slot"))).toEqual([]);
    },
  );
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
