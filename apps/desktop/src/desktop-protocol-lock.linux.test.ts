import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopDevelopmentId } from "./desktop-environment.js";
import {
  linuxProtocolPaths,
  registerLinuxProtocol,
  runProtocolCommand,
  unregisterLinuxProtocol,
} from "./desktop-protocol.js";

const roots: string[] = [];
const install = {
  scheme: "coginebot-dev" as const,
  name: "CogineBot Dev",
  appId: desktopDevelopmentId("/workspace/one"),
  executable: "/workspace/one/coginebot-dev",
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-protocol-lock-"));
  roots.push(root);
  const env = {
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  const paths = linuxProtocolPaths(install, env);
  await mkdir(path.dirname(paths.lockFile), { recursive: true });
  return { env, paths };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("Linux protocol kernel locking", () => {
  it("keeps a running writer's exclusion after the controller descriptor closes", async () => {
    const f = await fixture();
    const ready = path.join(path.dirname(f.paths.lockFile), "writer-ready");
    const release = path.join(path.dirname(f.paths.lockFile), "writer-release");
    const lock = await open(f.paths.lockFile, "a", 0o600);
    expect(
      spawnSync("flock", ["-xn", "3"], { stdio: ["ignore", "ignore", "pipe", lock.fd] }).status,
    ).toBe(0);
    const script = `
      const fs = require('node:fs'), path = require('node:path');
      const [ready, release] = process.argv.slice(1);
      fs.watch(path.dirname(release), () => { if (fs.existsSync(release)) process.exit(0); });
      fs.writeFileSync(ready, 'ready');
      if (fs.existsSync(release)) process.exit(0);
    `;
    let markReady!: () => void;
    const readySignal = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const monitor = watch(path.dirname(ready), () => {
      if (existsSync(ready)) markReady();
    });
    const writer = runProtocolCommand(
      process.execPath,
      ["-e", script, ready, release],
      process.env,
      lock.fd,
    );
    let closed = false;
    try {
      await readySignal;
      await lock.close();
      closed = true;
      expect(spawnSync("flock", ["-n", f.paths.lockFile, "true"]).status).toBe(1);
    } finally {
      monitor.close();
      if (!closed) await lock.close();
      await writeFile(release, "release");
      await writer;
    }
    expect(spawnSync("flock", ["-n", f.paths.lockFile, "true"]).status).toBe(0);
  });

  it("holds a cross-process lock across awaited writes and fences both schemes and removal", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (_command: string, args: string[]) => {
      if (args[0] === "query") {
        entered();
        await gate;
      }
      return "";
    };
    const pending = registerLinuxProtocol(install, { env: f.env, explicit: true, run });
    await holding;
    try {
      expect(spawnSync("flock", ["-n", f.paths.lockFile, "true"]).status).toBe(1);
      await expect(unregisterLinuxProtocol(install, f.env)).rejects.toThrow("registration is busy");
      const production = {
        ...install,
        scheme: "coginebot" as const,
        appId: "ai.cogine.coginebot.desktop",
      };
      await expect(
        registerLinuxProtocol(production, { env: f.env, explicit: false, run: async () => "" }),
      ).rejects.toThrow("registration is busy");
    } finally {
      release();
      await pending;
    }
    expect(spawnSync("flock", ["-n", f.paths.lockFile, "true"]).status).toBe(0);
    const newer = {
      ...install,
      appId: desktopDevelopmentId("/workspace/two"),
      executable: "/workspace/two/coginebot-dev",
    };
    await registerLinuxProtocol(newer, { env: f.env, explicit: true, run: async () => "" });
    const current = await readFile(f.paths.file, "utf8");
    expect(await unregisterLinuxProtocol(install, f.env)).toBe(false);
    expect(await readFile(f.paths.file, "utf8")).toBe(current);
  });

  it("releases a terminated holder without deleting or reclaiming a stale lock file", async () => {
    const f = await fixture();
    const script = `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const fd = fs.openSync(process.argv[1], 'a', 0o600);
      const result = cp.spawnSync('flock', ['-xn', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
      if (result.status !== 0) process.exit(1);
      process.stdout.write('locked\\n');
      process.stdin.resume();
    `;
    const child = spawn(process.execPath, ["-e", script, f.paths.lockFile], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      await once(child.stdout!, "data");
      await expect(unregisterLinuxProtocol(install, f.env)).rejects.toThrow("registration is busy");
      child.kill("SIGKILL");
      await exited;
      await registerLinuxProtocol(install, { env: f.env, explicit: true, run: async () => "" });
      expect(await readFile(f.paths.file, "utf8")).toContain(install.executable);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
});
