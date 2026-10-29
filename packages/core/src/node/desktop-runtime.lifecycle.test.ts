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
import type { Server } from "node:net";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopEnvironment } from "./desktop-runtime.js";
import {
  browserProfilePathForScreen,
  desktopControlCommand,
  desktopTerminalCommand,
  managedDesktopCommand,
  releaseDesktopCommand,
  shellQuote,
} from "./desktop-runtime.js";

// The generated shell owns real locks, processes and sockets. These small daemons replace
// X11/Chromium/websockify protocols; the separate computer-image smoke covers those programs.
const DAEMON = `import http.server, json, os, socket, sys
with open(os.environ['TEST_PIDS'], 'a') as record: record.write(str(os.getpid()) + '\\n')
mode = sys.argv[1]
if mode == 'browser':
    port = int(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--remote-debugging-port=')))
    profile = next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--user-data-dir='))
    os.makedirs(profile, exist_ok=True)
    with open(profile + '/memory', 'w') as state: state.write('retained process state')
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            if self.path == '/json/version':
                data = json.dumps({'webSocketDebuggerUrl': 'ws://127.0.0.1:' + str(port) + '/close'}).encode()
                self.send_response(200); self.end_headers(); self.wfile.write(data)
            else:
                self.send_response(101); self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade'); self.end_headers()
                self.connection.recv(4096); self.connection.sendall(b'\\x88\\x00'); os._exit(0)
    http.server.HTTPServer.allow_reuse_address = True
    http.server.HTTPServer(('127.0.0.1', port), Handler).serve_forever()
elif mode == 'vnc':
    target = sys.argv[sys.argv.index('-unixsock') + 1]
    if '/control-' in target and os.path.exists(os.environ['TEST_ROOT'] + '/fail-control'): sys.exit(1)
    try: os.unlink(target)
    except FileNotFoundError: pass
    server = socket.socket(socket.AF_UNIX); server.bind(target); server.listen(8)
    with open(target + '.pid', 'w') as record: record.write(str(os.getpid()))
    clients = []
    while True: clients.append(server.accept()[0])
else:
    port = int(sys.argv[-1].rsplit(':', 1)[1])
    server = socket.socket(); server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port)); server.listen(8)
    while True: server.accept()[0].close()
`;

async function freeDesktopPorts(servers: [Server, Server] = [createServer(), createServer()]) {
  const ports: number[] = [];
  try {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test port");
      ports.push(address.port);
    }
    return [ports[0]!, ports[1]!] as const;
  } finally {
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  }
}

it("holds both desktop port reservations until both ports have been selected", async () => {
  const first = createServer(),
    second = createServer();
  let firstHeldWhenSecondStarted = false;
  second.once("listening", () => {
    firstHeldWhenSecondStarted = first.listening;
  });
  const [debugPort, gatewayPort] = await freeDesktopPorts([first, second]);
  expect(firstHeldWhenSecondStarted).toBe(true);
  expect(debugPort).not.toBe(gatewayPort);
  expect(first.listening).toBe(false);
  expect(second.listening).toBe(false);
});

const fixtures: Array<{
  root: string;
  env: DesktopEnvironment;
  run: (command: string, prelude?: string) => unknown;
  jobs: ChildProcess[];
}> = [];
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-lifecycle-"));
  const runtime = path.join(root, "runtime");
  const bin = path.join(root, "bin");
  for (const directory of [runtime, bin, path.join(root, "web"), path.join(root, "home")])
    mkdirSync(directory, { recursive: true });
  const program = path.join(root, "daemon.py");
  const proxy = path.join(root, "websockify.py");
  writeFileSync(program, DAEMON);
  writeFileSync(proxy, DAEMON);
  for (const [name, body] of Object.entries({
    xdpyinfo: "exit 0",
    "rakazo-browser": 'exec -a chromium python3 "$TEST_PROGRAM" browser "$@"',
    x11vnc: 'exec -a x11vnc python3 "$TEST_PROGRAM" vnc "$@"',
    websockify: 'exec -a python3 python3 "$TEST_PROXY" gateway "$@"',
  })) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  const [debug, gateway] = await freeDesktopPorts();
  if (debug <= 9221) throw new Error("test debugger port is outside the display range");
  const env = {
    homeDir: path.join(root, "home"),
    workspaceDir: root,
    browserProfilesDir: path.join(root, "profiles"),
    displayStart: debug - 9221,
    portStart: gateway,
    preservePrimaryDisplay: true,
  };
  const processEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    TEST_ROOT: root,
    TEST_PIDS: path.join(root, "pids"),
    TEST_PROGRAM: program,
    TEST_PROXY: proxy,
    SHELL: "/bin/bash",
  };
  const script = (command: string) =>
    command
      .replaceAll("/tmp/rakazo", runtime)
      .replaceAll("/usr/share/novnc", path.join(root, "web"));
  const run = (command: string, prelude = "") =>
    spawnSync("bash", ["-eu", "-c", `${prelude}\n${script(command)}`], {
      env: processEnv,
      encoding: "utf8",
      timeout: 25_000,
    });
  const jobs: ChildProcess[] = [];
  const start = (command: string, prelude = "") => {
    const child = spawn("bash", ["-eu", "-c", `${prelude}\n${script(command)}`], {
      env: processEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    jobs.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
      child.once("exit", (status) => resolve({ status, stdout, stderr })),
    );
    return { child, done };
  };
  const key = (bot: string) => createHash("sha256").update(bot).digest("hex").slice(0, 32);
  const slot = (bot = "a") => path.join(runtime, "desktop-assignments", `${key(bot)}.slot`);
  const state = (bot = "a") => readFileSync(slot(bot), "utf8").split("\n");
  const pid = (bot = "a") =>
    Number(readFileSync(path.join(runtime, `browser-pid-${key(bot)}`), "utf8"));
  const ensure = (lease = "run:1", view = "view-a") =>
    run(managedDesktopCommand("a", lease, env, view));
  const fixture = {
    root,
    runtime,
    env,
    processEnv,
    run,
    start,
    jobs,
    key,
    slot,
    state,
    pid,
    ensure,
  };
  fixtures.push(fixture);
  return fixture;
}

function alive(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false;
  }
}

function targetSocket(f: Awaited<ReturnType<typeof fixture>>, kind: string) {
  const target = readFileSync(
    path.join(f.runtime, "desktop-targets", `${kind}-${f.env.displayStart}`),
    "utf8",
  );
  return target.trim().split("unix_socket:")[1]!;
}

async function connect(socket: string) {
  const client = createConnection(socket);
  client.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  client.resume();
  return { client, closed };
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    for (const job of f.jobs) {
      if (job.pid) {
        try {
          process.kill(-job.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    }
    f.run(releaseDesktopCommand("a", undefined, f.env));
    const pids = existsSync(path.join(f.root, "pids"))
      ? readFileSync(path.join(f.root, "pids"), "utf8").trim().split("\n")
      : [];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")("generated desktop lifecycle processes", () => {
  it("retains the browser while retiring old view, control and terminal connections", async () => {
    const f = await fixture();
    expect(f.ensure().status).toBe(0);
    const browser = f.pid();
    const memory = path.join(browserProfilePathForScreen("a", f.env), "memory");
    writeFileSync(memory, "page state kept");
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1")).status,
    ).toBe(0);
    expect(
      f.run(desktopTerminalCommand("a", "run:1", f.env, "human-a", "terminal-a", f.root)).status,
    ).toBe(0);
    const view = await connect(targetSocket(f, "view"));
    const control = await connect(targetSocket(f, "control"));
    const terminal = await connect(targetSocket(f, "terminal"));
    terminal.client.resume();
    const command = Buffer.from(
      `printf ready >${shellQuote(path.join(f.root, "terminal-wrote"))}\n`,
    );
    const frame = Buffer.alloc(5 + command.length);
    frame.writeUInt32BE(command.length, 1);
    command.copy(frame, 5);
    terminal.client.write(frame);
    await vi.waitFor(() => expect(existsSync(path.join(f.root, "terminal-wrote"))).toBe(true));
    const released = f.run(releaseDesktopCommand("a", "run:1", f.env, true));
    expect(released.status, released.stderr).toBe(0);
    await Promise.all([view.closed, control.closed, terminal.closed]);
    for (const kind of ["view", "control", "terminal"])
      expect(
        readFileSync(
          path.join(f.runtime, "desktop-targets", `${kind}-${f.env.displayStart}`),
          "utf8",
        ),
      ).toBe("");
    expect(f.state()[4]).toBe("idle");
    expect(alive(browser)).toBe(true);
    expect(f.ensure("run:2", "new-view").stdout).toContain("RAKAZO_DESKTOP=0:new-view");
    expect(f.pid()).toBe(browser);
    expect(readFileSync(memory, "utf8")).toBe("page state kept");
    expect(f.state()[3]).toBe("");
    expect(
      readFileSync(
        path.join(f.runtime, "desktop-targets", `control-${f.env.displayStart}`),
        "utf8",
      ),
    ).toBe("");
    expect(f.run(releaseDesktopCommand("a", "run:2", f.env)).status).toBe(0);
    expect(alive(browser)).toBe(false);
    expect(existsSync(f.slot())).toBe(false);
  });

  it("repairs the current control transport across a same-Run fence without reviving revoked input", async () => {
    const f = await fixture();
    expect(f.ensure().status).toBe(0);
    const browser = f.pid();
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1")).status,
    ).toBe(0);
    const socket = targetSocket(f, "control");
    const prior = Number(readFileSync(`${socket}.pid`, "utf8"));
    process.kill(prior, "SIGKILL");
    await vi.waitFor(() => expect(alive(prior)).toBe(false));
    const repaired = f.ensure("run:2");
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(f.pid()).toBe(browser);
    expect(f.state()[3]).toBe("human-a");
    expect(f.state()[7]).toBe("grant-1");
    expect(Number(readFileSync(`${targetSocket(f, "control")}.pid`, "utf8"))).not.toBe(prior);
    expect(f.run(desktopControlCommand("a", "run:2", f.env, false, "human-a")).status).toBe(0);
    expect(f.ensure("run:3").status).toBe(0);
    expect(f.state()[3]).toBe("");
    expect(
      readFileSync(
        path.join(f.runtime, "desktop-targets", `control-${f.env.displayStart}`),
        "utf8",
      ),
    ).toBe("");
  });

  it.each(["missing", "empty", "mismatched"])(
    "repairs a %s control route without restarting its healthy input process",
    async (damage) => {
      const f = await fixture();
      expect(f.ensure().status).toBe(0);
      const browser = f.pid();
      expect(
        f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1")).status,
      ).toBe(0);
      const socket = targetSocket(f, "control");
      const input = Number(readFileSync(`${socket}.pid`, "utf8"));
      const target = path.join(f.runtime, "desktop-targets", `control-${f.env.displayStart}`);
      const expected = readFileSync(target, "utf8");
      if (damage === "missing") rmSync(target);
      else writeFileSync(target, damage === "empty" ? "" : "old: unix_socket:/old\n");
      const repaired = f.ensure("run:2");
      expect(repaired.status, repaired.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe(expected);
      expect(Number(readFileSync(`${socket}.pid`, "utf8"))).toBe(input);
      expect(alive(input)).toBe(true);
      expect(f.pid()).toBe(browser);
      expect(f.state()[3]).toBe("human-a");
      expect(f.state()[7]).toBe("grant-1");
    },
  );

  it("does not let old token or same-token publication cleanup revoke a replacement grant", async () => {
    const f = await fixture();
    expect(f.ensure().status).toBe(0);
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1")).status,
    ).toBe(0);
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-2")).status,
    ).toBe(0);
    const socket = targetSocket(f, "control");
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, false, "human-a", "grant-1")).status,
    ).toBe(0);
    expect(targetSocket(f, "control")).toBe(socket);
    expect(f.state()[7]).toBe("grant-2");
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-b", "grant-3")).status,
    ).toBe(0);
    expect(f.run(desktopControlCommand("a", "run:1", f.env, false, "human-a")).status).toBe(0);
    expect(f.state()[3]).toBe("human-b");
    expect(f.ensure("run:2").status).toBe(0);
    const current = f.state().join("\n");
    expect(f.run(releaseDesktopCommand("a", "run:1", f.env, true)).status).toBe(75);
    expect(f.state().join("\n")).toBe(current);
  });

  it("reserves a failed grant until matching cleanup and prevents automatic restoration", async () => {
    const f = await fixture();
    const initial = f.ensure();
    expect(
      initial.status,
      JSON.stringify({
        debugPort: f.env.displayStart + 9221,
        gatewayPort: f.env.portStart,
        stderr: initial.stderr,
      }),
    ).toBe(0);
    writeFileSync(path.join(f.root, "fail-control"), "1");
    const failed = f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1"));
    expect(failed.status).not.toBe(0);
    expect(f.state()[3]).toBe("");
    expect(f.state()[4]).toBe("blocked");
    expect(f.ensure().status).toBe(75);
    rmSync(path.join(f.root, "fail-control"));
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, false, "human-a", "grant-1")).status,
    ).toBe(0);
    expect(f.ensure().status).toBe(0);
    expect(f.state()[3]).toBe("");
  });

  it("does not retain restore authority after repairing the control transport fails", async () => {
    const f = await fixture();
    expect(f.ensure().status).toBe(0);
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1")).status,
    ).toBe(0);
    const socket = targetSocket(f, "control");
    const prior = Number(readFileSync(`${socket}.pid`, "utf8"));
    process.kill(prior, "SIGKILL");
    await vi.waitFor(() => expect(alive(prior)).toBe(false));
    writeFileSync(path.join(f.root, "fail-control"), "1");
    const failed = f.ensure("run:2");
    expect(failed.status).not.toBe(0);
    expect(f.state()[1]).toBe("run:2");
    expect(f.state()[3]).toBe("");
    expect(f.state()[4]).toBe("blocked");
    expect(f.state()[6]).toBe("human-a");
    expect(f.ensure("run:2").status).toBe(75);
    rmSync(path.join(f.root, "fail-control"));
    expect(
      f.run(desktopControlCommand("a", "run:2", f.env, false, "human-a", "grant-1")).status,
    ).toBe(0);
    expect(f.ensure("run:2").status).toBe(0);
    expect(f.state()[3]).toBe("");
  });

  it("keeps a failed revoke reserved until its live process can actually stop", async () => {
    const f = await fixture();
    expect(f.ensure().status).toBe(0);
    expect(
      f.run(desktopControlCommand("a", "run:1", f.env, true, "human-a", "grant-1")).status,
    ).toBe(0);
    const socket = targetSocket(f, "control");
    const pid = Number(readFileSync(`${socket}.pid`, "utf8"));
    const failed = f.run(
      desktopControlCommand("a", "run:1", f.env, false, "human-a"),
      [
        "pkill() {",
        '  case "$*" in *sockets/control-*) return 1 ;; esac',
        '  command pkill "$@"',
        "}",
        "export -f pkill",
      ].join("\n"),
    );
    expect(failed.status).not.toBe(0);
    expect(alive(pid)).toBe(true);
    expect(f.state()[3]).toBe("");
    expect(f.state()[4]).toBe("blocked");
    expect(f.state()[6]).toBe("human-a");
    expect(f.ensure().status).toBe(75);
    expect(
      readFileSync(
        path.join(f.runtime, "desktop-targets", `control-${f.env.displayStart}`),
        "utf8",
      ),
    ).toBe("");
    expect(f.run(desktopControlCommand("a", "run:1", f.env, false, "human-a")).status).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(f.state()[4]).toBe("active");
    expect(f.state()[6]).toBe("");
  });

  it("serializes release and a newer ensure while releasing the shared registry lock", async () => {
    const f = await fixture();
    expect(f.ensure().status).toBe(0);
    const held = path.join(f.root, "held");
    const proceed = path.join(f.root, "proceed");
    const releasing = f.start(
      releaseDesktopCommand("a", "run:1", f.env, true),
      [
        "pkill() {",
        `  touch ${shellQuote(held)}`,
        `  while [ ! -f ${shellQuote(proceed)} ]; do sleep 0.02; done`,
        '  command pkill "$@"',
        "}",
        "export -f pkill",
      ].join("\n"),
    );
    await vi.waitFor(() => expect(existsSync(held)).toBe(true));
    const ensuring = f.start(managedDesktopCommand("a", "run:2", f.env, "next-view"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ensuring.child.exitCode).toBeNull();
    const lock = path.join(f.runtime, "desktop-assignments", ".lock");
    expect(spawnSync("flock", ["-n", lock, "true"]).status).toBe(0);
    writeFileSync(proceed, "1");
    const released = await releasing.done;
    const ensured = await ensuring.done;
    expect(released.status, released.stderr).toBe(0);
    expect(ensured.status, ensured.stderr).toBe(0);
    expect(f.state()[1]).toBe("run:2");
  });
});
