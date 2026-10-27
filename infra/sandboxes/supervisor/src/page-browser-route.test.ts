import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn(), stdin: [] as string[] }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.stdin.length = 0;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    // Docker's hijacked exec stream is duplex: stdin is written, output is read.
    start: async () =>
      Duplex.from({
        readable: Readable.from([
          Buffer.from(
            options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
              ? JSON.stringify({
                  ok: true,
                  url: "https://example.test",
                  title: "Fixture",
                  tree: "",
                  elements: [],
                })
              : "",
          ),
        ]),
        writable: new Writable({
          write(chunk, _encoding, callback) {
            mock.stdin.push(String(chunk));
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
});

async function snapshot(id: string, screen: string, lease: string, home = "home") {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": home,
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screen,
      "x-rakazo-screen-lease-id": lease,
    },
    body: JSON.stringify({ command: "snapshot" }),
  });
}

const browserCommands = ["navigate", "act", "snapshot"] as const;

async function browserRequest(id: string, command: (typeof browserCommands)[number]) {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:1",
    },
    body: JSON.stringify(
      command === "navigate"
        ? { command, url: "https://example.test/next" }
        : command === "act"
          ? { command, actions: [{ kind: "click", ref: "current-ref" }] }
          : { command },
    ),
  });
}

it.each(
  browserCommands.flatMap((command) =>
    (["nonzero", "killed", "malformed", "transport", "null", "array", "empty"] as const).map(
      (failure) => ({
        command,
        failure,
      }),
    ),
  ),
)("preserves unknown $command outcomes after helper $failure", async ({ command, failure }) => {
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return defaultExec(options);
    return {
      start: async () => {
        if (failure === "transport") throw new Error("Fixture helper transport disconnected");
        return Duplex.from({
          readable: Readable.from([
            failure === "malformed"
              ? '{"ok":'
              : failure === "null"
                ? "null"
                : failure === "array"
                  ? "[]"
                  : failure === "empty"
                    ? "{}"
                    : "",
          ]),
          writable: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        });
      },
      inspect: async () => ({
        ExitCode: failure === "killed" ? 137 : failure === "nonzero" ? 1 : 0,
      }),
    };
  });

  const response = await browserRequest(`computer-helper-${command}-${failure}`, command);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: false,
    fallback: "computer_act",
    uncertain: command !== "snapshot",
  });
  expect(
    mock.exec.mock.calls.filter(([options]) =>
      options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
    ),
  ).toHaveLength(1);
});

it.each(browserCommands)("preserves the helper's acknowledged %s failure", async (command) => {
  const payload = {
    ok: false,
    uncertain: false,
    timedOut: true,
    ...(command === "navigate" ? { navigationOutcomeKnown: true } : {}),
    ...(command === "act" ? { completed: 1 } : {}),
    url: "https://example.test/current",
    title: "Current page",
    tree: "Current page",
    elements: [],
    error: "Navigation wait exhausted",
    fallback: "computer_act",
  };
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return defaultExec(options);
    return {
      start: async () =>
        Duplex.from({
          readable: Readable.from([JSON.stringify(payload)]),
          writable: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        }),
      inspect: async () => ({ ExitCode: 0 }),
    };
  });

  const response = await browserRequest(`computer-helper-acknowledged-${command}`, command);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(payload);
});

it("resolves the owned display and refuses an older fence before running the helper", async () => {
  expect(await (await snapshot("computer-lease", "first", "run:2")).json()).toMatchObject({
    ok: true,
  });
  expect(await (await snapshot("computer-lease", "second", "other:2")).json()).toMatchObject({
    ok: true,
  });
  expect(mock.exec.mock.calls.at(-1)?.[0]).toMatchObject({
    Env: [
      "DISPLAY=:2",
      "RAKAZO_CDP_PORT=9223",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "RAKAZO_BROWSER_WATCH_STDIN=1",
      "RAKAZO_BROWSER_ARGS_STDIN=1",
    ],
  });
  mock.exec.mockClear();
  expect(await (await snapshot("computer-lease", "first", "run:1")).json()).toMatchObject({
    ok: false,
  });
  expect(mock.exec).not.toHaveBeenCalled();
});

it("rejects another computer identity before any command executes", async () => {
  expect(
    await (await snapshot("computer-identity", "first", "run:1", "foreign-home")).json(),
  ).toMatchObject({ ok: false });
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each(["http", "https"])(
  "rejects %s URL credentials before executing any command",
  async (scheme) => {
    const response = await supervisorApp.request("/computers/computer-credentials/browser", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "navigate",
        url: `${scheme}://example:fake-password@example.test`,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

it("closes helper stdin when the request is cancelled", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[]; AttachStdin?: boolean }) => {
    if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return defaultExec(options);
    expect(options.AttachStdin).toBe(true);
    return {
      start: async (options: { stdin: boolean }) => {
        expect(options.stdin).toBe(true);
        started();
        return stream;
      },
      inspect: async () => ({ ExitCode: 130 }),
    };
  });
  const response = supervisorApp.request("/computers/computer-cancel/browser", {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({ command: "act", actions: [{ kind: "click", ref: "test-ref" }] }),
  });
  await ready;
  controller.abort();
  expect(await (await response).json()).toMatchObject({ ok: false, uncertain: true });
  expect(stream.destroyed).toBe(true);
});

it("sends a saved-login fill only over stdin, never in the helper's arguments", async () => {
  const actions = [
    { kind: "fill", ref: "e1", text: "fake-password-1", origin: "https://login.example.test" },
  ];
  const response = await supervisorApp.request("/computers/computer-login/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:9",
    },
    body: JSON.stringify({ command: "act", actions }),
  });
  expect(await response.json()).toMatchObject({ ok: true });
  const helperCall = mock.exec.mock.calls.find(([options]) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
  )!;
  expect(JSON.stringify(helperCall[0].Cmd)).not.toContain("fake-password-1");
  expect(helperCall[0].Env).toContain("RAKAZO_BROWSER_ARGS_STDIN=1");
  expect(mock.stdin.join("")).toBe(`${JSON.stringify({ command: "act", actions })}\n`);
});
