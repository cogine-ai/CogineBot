import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  browserLauncherPath,
  browserProfilePathForScreen,
  DEFAULT_DESKTOP_ENV,
  desktopControlCommand,
  desktopTerminalCommand,
  ensureScreenCommand,
  interactiveScreenCommand,
  managedDesktopCommand,
  releaseDesktopCommand,
  resetDesktopRuntimeCommand,
  screenPorts,
  shellQuote,
  stopExtraScreenCommand,
  stopScreenTransportsCommand,
  terminalCommand,
} from "@rakazo/core/node/desktop-runtime";
import { expect, it } from "vitest";

const enabled = process.env.VERIFY_DOCKER_TEAM_SCREENS === "1";
const image = process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local";
const controlToken = "fixture-only-token";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 150_000 });

function verifyImageBytes(name: string) {
  for (const [source, target] of [
    ["start.sh", "/usr/local/bin/rakazo-computer"],
    ["control.py", "/usr/local/bin/rakazo-computer-control"],
    ["rakazo-page-browser", "/usr/local/bin/rakazo-page-browser"],
  ] as const) {
    const expected = createHash("sha256")
      .update(readFileSync(new URL(`../../computer/${source}`, import.meta.url)))
      .digest("hex");
    expect(docker("exec", name, "sha256sum", target).split(" ")[0]).toBe(expected);
  }
}

function start(name: string) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--shm-size=512m",
    "--env",
    `RAKAZO_COMPUTER_CONTROL_TOKEN=${controlToken}`,
    image,
  );
  verifyImageBytes(name);
}

function cleanup(name: string) {
  try {
    docker("rm", "-f", name);
  } catch {
    /* Do not hide the original failure. */
  }
}

// Real processes and loopback pages inside an isolated image; no provider account or network.
it.skipIf(!enabled).each([false, true])(
  "retains live browser state and revokes access across recovery (managed=%s)",
  (managed) => {
    const name = `rakazo-browser-retention-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "browser-retention-"));
    const env = managed
      ? { ...DEFAULT_DESKTOP_ENV, displayStart: 20, portStart: 6100, preservePrimaryDisplay: false }
      : DEFAULT_DESKTOP_ENV;
    const commands: Record<string, string> = {
      reset: resetDesktopRuntimeCommand(),
      viewPort: screenPorts(0, env).viewPort,
      controlPort: screenPorts(0, env).controlPort,
      controlToken,
      managed: String(managed),
    };
    for (const [bot, index] of [
      ["a", 0],
      ["b", 1],
    ] as const) {
      const key = `bot-${bot}`;
      const lease = `run-${bot}:1`;
      commands[`ensure${bot}`] = managed
        ? managedDesktopCommand(key, lease, env, `view-${bot}`)
        : ensureScreenCommand(index, key, `view-${bot}`, env);
      commands[`debug${bot}`] = String(screenPorts(index, env).debugPort);
      commands[`profile${bot}`] = browserProfilePathForScreen(key, env);
      commands[`display${bot}`] = String(screenPorts(index, env).displayNumber);
      commands[`cancel${bot}`] = managed
        ? releaseDesktopCommand(key, lease, env)
        : stopExtraScreenCommand(index, key, env);
    }
    commands.grant = managed
      ? desktopControlCommand("bot-a", "run-a:1", env, true, "control-a")
      : interactiveScreenCommand(true, "control-a", screenPorts(0, env));
    commands.recover = managed
      ? commands.ensurea!
      : `bash -eu -c ${shellQuote(commands.ensurea!)}\nbash -eu -c ${shellQuote(commands.grant)}`;
    commands.retain = managed
      ? releaseDesktopCommand("bot-a", "run-a:1", env, true)
      : `set -eu\n${stopScreenTransportsCommand(0, env)}`;
    commands.next = managed
      ? managedDesktopCommand("bot-a", "run-a:1", env, "view-a-next")
      : ensureScreenCommand(0, "bot-a", "view-a-next", env);
    commands.nextgrant = managed
      ? desktopControlCommand("bot-a", "run-a:1", env, true, "control-a-next")
      : interactiveScreenCommand(true, "control-a-next", screenPorts(0, env));
    commands.terminal = managed
      ? desktopTerminalCommand("bot-a", "run-a:1", env, "control-a", "terminal-a", env.homeDir)
      : terminalCommand("control-a", "terminal-a", env.homeDir, env, screenPorts(0, env));
    commands.openfile = `${shellQuote(browserLauncherPath(screenPorts(0, env).displayNumber))} ${shellQuote(pathToFileURL(`${env.homeDir}/retained # %.html`, { windows: false }).href)}`;
    commands.focus = `env DISPLAY=:${screenPorts(0, env).displayNumber} sh -c 'window=$(xdotool search --onlyvisible --name "^a1" | tail -n 1); [ -n "$window" ] && xdotool windowactivate --sync "$window"'`;
    try {
      start(name);
      const commandFile = path.join(directory, "commands.json");
      writeFileSync(commandFile, JSON.stringify(commands));
      docker("cp", commandFile, `${name}:/tmp/browser-retention-commands.json`);
      docker(
        "cp",
        fileURLToPath(new URL("../../computer/test_browser_retention.py", import.meta.url)),
        `${name}:/tmp/test_browser_retention.py`,
      );
      const result = docker(
        "exec",
        name,
        "python3",
        "/tmp/test_browser_retention.py",
        "/tmp/browser-retention-commands.json",
      );
      expect(result).toContain("PASS: retained browser state");
      process.stdout.write(result);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      )
        process.stderr.write(error.stdout);
      try {
        process.stderr.write(docker("logs", "--tail", "40", name));
      } catch {
        /* Preserve the test failure. */
      }
      throw error;
    } finally {
      cleanup(name);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

it.skipIf(!enabled).each([
  [false, "empty"],
  [false, "missing"],
  [false, "mismatched"],
  [true, "empty"],
  [true, "missing"],
  [true, "mismatched"],
] as const)(
  "repairs healthy control route (managed=%s) after %s target corruption",
  (managed, corruption) => {
    const name = `rakazo-browser-retention-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "browser-route-recovery-"));
    const env = managed
      ? { ...DEFAULT_DESKTOP_ENV, displayStart: 20, portStart: 6100, preservePrimaryDisplay: false }
      : DEFAULT_DESKTOP_ENV;
    const commands: Record<string, string> = {
      reset: resetDesktopRuntimeCommand(),
      viewPort: screenPorts(0, env).viewPort,
      controlPort: screenPorts(0, env).controlPort,
      routeCorruption: corruption,
      managed: String(managed),
    };
    for (const [bot, index] of [
      ["a", 0],
      ["b", 1],
    ] as const) {
      commands[`ensure${bot}`] = managed
        ? managedDesktopCommand(`bot-${bot}`, `run-${bot}:1`, env, `view-${bot}`)
        : ensureScreenCommand(index, `bot-${bot}`, `view-${bot}`, env);
      commands[`debug${bot}`] = String(screenPorts(index, env).debugPort);
      commands[`profile${bot}`] = browserProfilePathForScreen(`bot-${bot}`, env);
    }
    commands.displaya = String(screenPorts(0, env).displayNumber);
    commands.grant = managed
      ? desktopControlCommand("bot-a", "run-a:1", env, true, "control-a")
      : interactiveScreenCommand(true, "control-a", screenPorts(0, env));
    commands.recover = managed
      ? commands.ensurea!
      : `bash -eu -c ${shellQuote(commands.ensurea!)}\nbash -eu -c ${shellQuote(commands.grant)}`;
    commands.focus = `env DISPLAY=:${screenPorts(0, env).displayNumber} sh -c 'window=$(xdotool search --onlyvisible --name "^a1" | tail -n 1); [ -n "$window" ] && xdotool windowactivate --sync "$window"'`;
    try {
      start(name);
      const commandFile = path.join(directory, "commands.json");
      writeFileSync(commandFile, JSON.stringify(commands));
      docker("cp", commandFile, `${name}:/tmp/browser-retention-commands.json`);
      docker(
        "cp",
        fileURLToPath(new URL("../../computer/test_browser_retention.py", import.meta.url)),
        `${name}:/tmp/test_browser_retention.py`,
      );
      const result = docker(
        "exec",
        name,
        "python3",
        "/tmp/test_browser_retention.py",
        "/tmp/browser-retention-commands.json",
      );
      expect(result).toContain("PASS: healthy control route repaired");
      process.stdout.write(result);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      )
        process.stderr.write(error.stdout);
      try {
        process.stderr.write(docker("logs", "--tail", "40", name));
      } catch {
        /* Preserve the test failure. */
      }
      throw error;
    } finally {
      cleanup(name);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

it.skipIf(!enabled).each([
  ["TERM", false],
  ["TERM", true],
  ["INT", false],
  ["INT", true],
] as const)(
  "stops PID1 promptly on %s during control restart backoff=%s",
  (signal, backoff) => {
    const name = `rakazo-control-shutdown-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "control-shutdown-"));
    try {
      start(name);
      if (backoff) {
        // Hold only the control loop's one-second backoff so signal delivery cannot race host latency.
        const wrapper = path.join(directory, "sleep");
        writeFileSync(
          wrapper,
          '#!/bin/sh\nif [ "$1" = 1 ] && [ -e /tmp/hold-control-backoff ]; then\n : >/tmp/control-in-backoff\n while [ -e /tmp/hold-control-backoff ]; do /bin/sleep 0.05; done\nfi\nexec /bin/sleep "$@"\n',
          { mode: 0o755 },
        );
        docker("cp", wrapper, `${name}:/home/rakazo/.local/bin/sleep`);
      }
      const prepare = `import os, pathlib, signal, time
deadline=time.monotonic()+8
def control_pids():
 result=[]
 for proc in pathlib.Path('/proc').iterdir():
  if not proc.name.isdigit(): continue
  try: argv=(proc/'cmdline').read_bytes().split(b'\\0')
  except OSError: continue
  if len(argv)>1 and argv[1]==b'/usr/local/bin/rakazo-computer-control': result.append(int(proc.name))
 return result
while not control_pids():
 assert time.monotonic()<deadline, 'control daemon did not start'
 time.sleep(0.03)
if ${backoff ? "True" : "False"}:
 pathlib.Path('/tmp/hold-control-backoff').touch()
 for pid in control_pids(): os.kill(pid,signal.SIGKILL)
 while not pathlib.Path('/tmp/control-in-backoff').exists():
  assert time.monotonic()<deadline, 'control loop did not enter held backoff'
  time.sleep(0.03)
 assert not control_pids(), 'daemon restarted during held backoff'
print('shutdown phase ready')`;
      expect(docker("exec", name, "python3", "-c", prepare)).toContain("shutdown phase ready");
      const started = Date.now();
      docker("kill", `--signal=${signal}`, name);
      expect(docker("wait", name).trim()).toBe("0");
      expect(Date.now() - started).toBeLessThan(5_000);
      const state = JSON.parse(docker("inspect", "--format", "{{json .State}}", name));
      expect(state.Running).toBe(false);
      expect(state.OOMKilled).toBe(false);
      expect(docker("inspect", "--format", "{{.RestartCount}}", name).trim()).toBe("0");
    } finally {
      cleanup(name);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
