import type * as NodeHttp from "node:http";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getContainer: vi.fn(), httpGet: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer = mocks.getContainer;
  },
}));
vi.mock("node:http", async (original) => {
  const http = await original<typeof NodeHttp>();
  return {
    ...http,
    default: {
      ...http,
      get: mocks.httpGet,
    },
  };
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.httpGet.mockReset().mockImplementation((_options, callback) => {
    callback({ statusCode: 200, resume() {} });
    return {
      once() {
        return this;
      },
      destroy() {},
    };
  });
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_SCREEN_HOST", "127.0.0.1");
  vi.stubEnv("SANDBOX_TEAM_SCREEN_LIMIT", "2");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function failedPublication() {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let enteredResolve!: () => void;
  let completeResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const complete = new Promise<void>((resolve) => {
    completeResolve = resolve;
  });
  mocks.httpGet.mockImplementationOnce((_options, callback) => {
    enteredResolve();
    void complete.then(() => {
      now += 46_000;
      callback({ statusCode: 503, resume() {} });
    });
    return {
      once() {
        return this;
      },
      destroy() {},
    };
  });
  return { entered, complete: completeResolve };
}

async function fixture() {
  const { supervisorApp } = await import("./index.js");
  const commands: string[] = [];
  let boot = "boot-1";
  const currentTokens = new Map<string, string>();
  let fail: (command: string) => boolean = () => false;
  let workGate:
    | {
        matches: (command: string) => boolean;
        enter: () => void;
        wait: Promise<void>;
        entered: boolean;
      }
    | undefined;
  const container = {
    inspect: vi.fn(async () => ({
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "owner", "rakazo.spaceId": "space" },
      },
      State: { Running: true, StartedAt: boot },
      HostConfig: { NetworkMode: "bridge" },
      NetworkSettings: { Ports: { "6080/tcp": [{ HostPort: "16080" }] } },
    })),
    exec: vi.fn(async (options: { Cmd: string[] }) => {
      const command = options.Cmd[2] ?? options.Cmd.join(" ");
      commands.push(command);
      if (workGate && !workGate.entered && workGate.matches(options.Cmd.join(" "))) {
        workGate.entered = true;
        workGate.enter();
        await workGate.wait;
      }
      const failed = fail(command);
      let stdout = options.Cmd[0]?.endsWith("rakazo-page-browser")
        ? "{}"
        : command.includes("GEOM")
          ? "GEOM 1 1\nIMAGE AQID\n"
          : "";
      if (!failed) {
        const display = command.match(/control-token-(\d+)/)?.[1];
        const grant = command.match(/printf %s '([^']+)' >\/tmp\/rakazo\/control-token-/)?.[1];
        if (grant && display) currentTokens.set(display, grant);
        else if (command.includes("RAKAZO_CONTROL_RELEASED")) {
          const expected =
            command.match(/\] = '([^']+)'/)?.[1] ?? command.match(/ = '([^']+)' \]/)?.[1];
          if (display && expected === currentTokens.get(display)) {
            currentTokens.delete(display);
            stdout = "RAKAZO_CONTROL_RELEASED\n";
          }
        } else if (display && command.includes("rm -f /tmp/rakazo/control-token-"))
          currentTokens.delete(display);
      }
      return {
        start: async () => Readable.from([stdout]),
        inspect: async () => ({ ExitCode: failed ? 1 : 0 }),
      };
    }),
  };
  mocks.getContainer.mockReturnValue(container);
  const work = (
    kind: "actions" | "input" | "observe" | "browser",
    lease: string | undefined,
    screen = "a",
    signal?: AbortSignal,
  ) =>
    supervisorApp.request(`/computers/computer/${kind}`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "owner",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": screen,
        ...(lease ? { "x-rakazo-screen-lease-id": lease } : {}),
      },
      body: JSON.stringify(
        kind === "actions"
          ? { actions: [{ kind: "key", key: "a" }], observe: false }
          : kind === "input"
            ? { input: { kind: "key", key: "a" } }
            : kind === "browser"
              ? { command: "snapshot" }
              : {},
      ),
    });
  const hold = (kind: "actions" | "input" | "observe" | "browser") => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    workGate = {
      matches: (command) =>
        command.includes(
          kind === "browser" ? "rakazo-page-browser" : kind === "observe" ? "GEOM" : "xdotool",
        ),
      enter,
      wait,
      entered: false,
    };
    return { entered, release };
  };
  const request = (screen: string, lease: string, body?: object, cancel = false) =>
    supervisorApp.request(`/computers/computer/screen${body ? "-mode" : ""}`, {
      method: body ? "POST" : "DELETE",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "owner",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": screen,
        "x-rakazo-screen-lease-id": lease,
        ...(cancel ? { "x-rakazo-cancel-run-work": "1" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const watch = (screen = "a", lease = "run-a:1") =>
    request(screen, lease, { interactive: false, revokeControl: false });
  const grant = (token: string, lease = "run-a:1") =>
    request("a", lease, { interactive: true, controlToken: token });
  const revoke = (token: string, lease = "run-a:1") =>
    request("a", lease, { interactive: false, controlToken: token });
  return {
    work,
    hold,
    commands,
    container,
    watch,
    grant,
    revoke,
    release: (screen = "a", lease = "run-a:1", cancel = false) =>
      request(screen, lease, undefined, cancel),
    setBoot: (value: string) => {
      boot = value;
    },
    fail: (value: typeof fail) => {
      fail = value;
    },
    token: () => currentTokens.get("1"),
  };
}

const grants = (commands: string[]) =>
  commands.filter(
    (command) => command.includes("printf %s '") && command.includes("x11vnc-control-"),
  );

describe("screen retention through supervisor routes", () => {
  it("retains the browser on ordinary release and rotates the view capability on reuse", async () => {
    const f = await fixture();
    const before = (await (await f.watch()).json()) as { screenUrl: string };
    const start = f.commands.length;
    expect((await f.release()).status).toBe(200);
    expect(f.commands.slice(start).join("\n")).not.toContain("Browser.close");
    expect(f.commands.slice(start).join("\n")).toContain("desktop-targets/terminal-1");
    const after = (await (await f.watch()).json()) as { screenUrl: string };
    expect(after.screenUrl).not.toBe(before.screenUrl);
  });

  it("fully stops only the cancelled screen and rejects a late old execution release", async () => {
    const f = await fixture();
    await f.watch();
    await f.watch("b", "run-b:2");
    await f.watch("a", "new-a:3");
    const start = f.commands.length;
    expect((await f.release()).status).toBe(200);
    expect(f.commands).toHaveLength(start);
    expect((await f.release("a", "new-a:3", true)).status).toBe(200);
    expect(f.commands.slice(start).join("\n")).toContain("Browser.close");
    expect((await f.watch("c", "run-c:4")).status).toBe(200);
  });

  it("clears restore authority on ordinary release", async () => {
    const f = await fixture();
    await f.grant("control-a");
    expect(f.token()).toBe("control-a");
    await f.release();
    const start = f.commands.length;
    await f.watch();
    expect(grants(f.commands.slice(start))).toEqual([]);
    expect(f.token()).toBeUndefined();
  });

  it("restores an active human token across a same-Run execution reclaim", async () => {
    const f = await fixture();
    await f.grant("control-a");
    const start = f.commands.length;
    expect((await f.watch("a", "run-a:2")).status).toBe(200);
    expect(grants(f.commands.slice(start))).toHaveLength(1);
    expect(f.token()).toBe("control-a");
  });

  it("does not restore before revocation and never clears a replacement token on old revoke", async () => {
    const f = await fixture();
    await f.grant("control-a");
    await f.grant("control-b");
    let start = f.commands.length;
    expect((await f.revoke("control-a")).status).toBe(200);
    expect(grants(f.commands.slice(start))).toEqual([]);
    expect(f.token()).toBe("control-b");
    start = f.commands.length;
    await f.watch();
    expect(grants(f.commands.slice(start)).join("\n")).toContain("control-b");
    start = f.commands.length;
    expect((await f.revoke("control-b")).status).toBe(200);
    expect(grants(f.commands.slice(start))).toEqual([]);
    expect(f.token()).toBeUndefined();
    start = f.commands.length;
    await f.watch();
    expect(grants(f.commands.slice(start))).toEqual([]);
  });

  it("does not restore a failed grant or revive the preceding token", async () => {
    const f = await fixture();
    await f.grant("control-a");
    f.fail((command) => command.includes("printf %s 'control-b'"));
    expect((await f.grant("control-b")).status).toBe(400);
    f.fail(() => false);
    const start = f.commands.length;
    await f.watch();
    expect(grants(f.commands.slice(start))).toEqual([]);
  });

  it("fails closed when active control restoration fails", async () => {
    const f = await fixture();
    await f.grant("control-a");
    f.fail((command) => command.includes("printf %s 'control-a'"));
    expect((await f.watch()).status).toBe(400);
    f.fail(() => false);
    const start = f.commands.length;
    await f.watch();
    expect(grants(f.commands.slice(start))).toEqual([]);
  });

  it("falls back to full teardown when revoking retained access fails", async () => {
    const f = await fixture();
    await f.grant("control-a");
    f.fail(
      (command) =>
        command.includes("desktop-targets/view-1") &&
        !command.includes("Browser.close") &&
        !command.includes("desktop_view_token="),
    );
    const start = f.commands.length;
    expect((await f.release()).status).toBe(200);
    expect(f.commands.slice(start).some((command) => command.includes("Browser.close"))).toBe(true);
    f.fail(() => false);
    const next = f.commands.length;
    await f.watch();
    expect(grants(f.commands.slice(next))).toEqual([]);
  });

  it("retains a failed teardown reservation and permits an explicit release retry", async () => {
    const f = await fixture();
    await f.watch();
    f.fail(() => true);
    expect((await f.release()).status).toBe(500);
    f.fail(() => false);
    expect((await f.release()).status).toBe(200);
    expect((await f.watch()).status).toBe(200);
  });

  it("reclaims only eligible idle screens at the existing limit", async () => {
    const f = await fixture();
    await f.grant("control-a");
    await f.watch("b", "run-b:2");
    expect((await f.watch("c", "run-c:3")).status).toBe(400);
    await f.release("b", "run-b:2");
    const start = f.commands.length;
    expect((await f.watch("c", "run-c:3")).status).toBe(200);
    const stopped = f.commands.slice(start).filter((command) => command.includes("Browser.close"));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain("control-token-2");
    expect(f.token()).toBe("control-a");
  });

  it("does not recycle a slot after failed idle eviction", async () => {
    const f = await fixture();
    await f.watch();
    await f.watch("b", "run-b:2");
    await f.release();
    f.fail((command) => command.includes("Browser.close"));
    expect((await f.watch("c", "run-c:3")).status).toBe(400);
    expect((await f.watch("d", "run-d:4")).status).toBe(400);
  });

  it("does not evict a retained slot after a new execution has reclaimed it", async () => {
    const f = await fixture();
    await f.watch();
    await f.release();
    await f.watch("a", "run-a:2");
    await f.watch("b", "run-b:3");
    const start = f.commands.length;
    expect((await f.watch("c", "run-c:4")).status).toBe(400);
    expect(f.commands.slice(start).some((command) => command.includes("Browser.close"))).toBe(
      false,
    );
  });

  it("uses the display index as the deterministic tie-break for equally old idle slots", async () => {
    const f = await fixture();
    await f.watch();
    await f.watch("b", "run-b:2");
    vi.spyOn(Date, "now").mockReturnValue(1000);
    await f.release("b", "run-b:2");
    await f.release();
    const start = f.commands.length;
    expect((await f.watch("c", "run-c:3")).status).toBe(200);
    const stop = f.commands.slice(start).find((command) => command.includes("Browser.close"));
    expect(stop).toContain("control-token-1");
    const after = f.commands.length;
    await f.release();
    expect(f.commands).toHaveLength(after);
  });

  it("drops prior control receipt when the container boot changes", async () => {
    const f = await fixture();
    await f.grant("control-a");
    f.setBoot("boot-2");
    const start = f.commands.length;
    expect((await f.watch()).status).toBe(200);
    expect(grants(f.commands.slice(start))).toEqual([]);
  });

  it("revokes a successful grant when its screen publication fails", async () => {
    const f = await fixture();
    const failure = failedPublication();
    const pending = f.grant("control-a");
    await failure.entered;
    failure.complete();
    expect((await pending).status).toBe(400);
    const start = f.commands.length;
    expect((await f.watch()).status).toBe(200);
    expect(grants(f.commands.slice(start))).toEqual([]);
    expect(f.token()).toBeUndefined();
  });

  it.each(["control-a", "control-b"])(
    "does not revoke a newer %s grant after earlier publication fails",
    async (replacement) => {
      const f = await fixture();
      const failure = failedPublication();
      const pending = f.grant("control-a");
      await failure.entered;
      expect((await f.grant(replacement)).status).toBe(200);
      failure.complete();
      expect((await pending).status).toBe(400);
      expect(f.token()).toBe(replacement);
      const start = f.commands.length;
      await f.watch();
      expect(grants(f.commands.slice(start)).join("\n")).toContain(replacement);
    },
  );
});

describe("finite screen work and retained admission", () => {
  it("does not start queued work after its request was aborted", async () => {
    const f = await fixture();
    await f.watch();
    await f.release();
    const gate = f.hold("actions");
    const pending = f.work("actions", "run-a:1");
    await gate.entered;
    const controller = new AbortController();
    const queued = f.work("input", "run-a:1", "a", controller.signal);
    controller.abort();
    const start = f.commands.length;
    gate.release();
    expect((await pending).status).toBe(200);
    expect((await queued).status).toBe(500);
    expect(f.commands.slice(start)).toEqual([]);
  });

  it("waits for finite work before changing control on the same screen", async () => {
    const f = await fixture();
    await f.watch();
    await f.release();
    await f.watch("b", "run-b:2");
    const gate = f.hold("input");
    const pending = f.work("input", undefined);
    await gate.entered;
    const start = f.commands.length;
    const granting = f.grant("control-a");
    try {
      expect((await f.watch("c", "run-c:3")).status).toBe(400);
      expect(grants(f.commands.slice(start))).toEqual([]);
    } finally {
      gate.release();
    }
    expect((await pending).status).toBe(200);
    expect((await granting).status).toBe(200);
    expect(f.token()).toBe("control-a");
    expect((await f.watch("c", "run-c:3")).status).toBe(400);
  });

  it.each(["actions", "input", "observe", "browser"] as const)(
    "pins %s only while the request is using its display",
    async (kind) => {
      const f = await fixture();
      await f.watch();
      await f.release();
      await f.watch("b", "run-b:2");
      const gate = f.hold(kind);
      const pending = f.work(kind, "run-a:1");
      await gate.entered;
      try {
        expect((await f.watch("c", "run-c:3")).status).toBe(400);
      } finally {
        gate.release();
      }
      expect((await pending).status).toBe(200);
      expect((await f.watch("c", "run-c:3")).status).toBe(200);
    },
  );

  it.each(["actions", "input"] as const)(
    "protects human %s with no execution lease and leaves peer screens concurrent",
    async (kind) => {
      const f = await fixture();
      await f.watch();
      await f.release();
      await f.watch("b", "run-b:2");
      const gate = f.hold(kind);
      const pending = f.work(kind, undefined);
      await gate.entered;
      try {
        expect((await f.work("input", "run-b:2", "b")).status).toBe(200);
        expect((await f.watch("c", "run-c:3")).status).toBe(400);
      } finally {
        gate.release();
      }
      expect((await pending).status).toBe(200);
      expect((await f.watch("c", "run-c:3")).status).toBe(200);
    },
  );

  it("releases the pin on errors and does not permanently activate repeated passive watches", async () => {
    const f = await fixture();
    await f.watch();
    await f.release();
    await f.watch();
    await f.watch();
    await f.watch("b", "run-b:2");
    f.fail((command) => command.includes("xdotool"));
    expect((await f.work("input", undefined)).status).toBe(500);
    f.fail(() => false);
    expect((await f.watch("c", "run-c:3")).status).toBe(200);
  });

  it.each([false, true])(
    "finishes old work before release (cancel=%s) can recycle its display",
    async (cancel) => {
      const f = await fixture();
      await f.watch();
      await f.release();
      await f.watch("b", "run-b:2");
      const gate = f.hold("actions");
      const pending = f.work("actions", "run-a:1");
      await gate.entered;
      const start = f.commands.length;
      const releasing = f.release("a", "run-a:1", cancel);
      try {
        expect((await f.watch("c", "run-c:3")).status).toBe(400);
        expect(f.commands.slice(start).some((command) => command.includes("Browser.close"))).toBe(
          false,
        );
      } finally {
        gate.release();
      }
      expect((await pending).status).toBe(200);
      expect((await releasing).status).toBe(200);
      expect((await f.watch("c", "run-c:3")).status).toBe(200);
    },
  );
});
