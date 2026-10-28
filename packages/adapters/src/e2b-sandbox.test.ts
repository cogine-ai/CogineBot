import { createServer } from "node:http";
import { FileNotFoundError, Sandbox, SandboxNotFoundError, TimeoutError } from "@e2b/desktop";
import { describe, expect, it, vi } from "vitest";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider, isSandboxGoneError, keepingAwake } from "./e2b-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";

const context = {
  operationId: "e2b-test",
  traceId: "e2b-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("E2B computer backend", () => {
  it.each<[string, boolean]>([
    ["success", false],
    ["transport", false],
    ["gone", false],
    ["success", true],
    ["transport", true],
    ["gone", true],
  ])("ignores stopped cold renewal %s with successor attendance %s", async (outcome, next) => {
    let complete!: () => void;
    let reject!: (error: unknown) => void;
    const renewal = new Promise<void>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    let renewing!: () => void;
    const started = new Promise<void>((resolve) => {
      renewing = resolve;
    });
    const old = {
      sandboxId: "existing",
      setTimeout: vi.fn(() => {
        renewing();
        return renewal;
      }),
    } as unknown as Sandbox;
    let attach!: (desktop: Sandbox) => void;
    const attachment = new Promise<Sandbox>((resolve) => {
      attach = resolve;
    });
    const current = {
      sandboxId: "existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(),
      connect: vi.fn(),
      pause: vi.fn().mockResolvedValue(undefined),
      attachRunning: vi.fn().mockResolvedValueOnce(old).mockReturnValue(attachment),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const registry = Reflect.get(provider, "computerOperations") as Map<
      string,
      { pending: number }
    >;
    const touched = Reflect.get(provider, "lastTouchedAt") as Map<string, number>;
    const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
    const stopped = provider.keepAlive(ref, { onlyIfRunning: true });
    await started;
    await provider.stop(ref, context);
    expect(registry.size).toBe(0);
    const successor = next ? provider.keepAlive(ref, { onlyIfRunning: true }) : undefined;
    const successorSlot = registry.get(ref.id);
    if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
    else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
    else complete();
    await stopped;
    expect(touched.has(ref.id)).toBe(false);
    expect(registry.size).toBe(next ? 1 : 0);
    if (successor) {
      expect(registry.get(ref.id)).toBe(successorSlot);
      expect(successorSlot?.pending).toBe(1);
      attach(current);
      await successor;
      expect(current.setTimeout).toHaveBeenCalledOnce();
    }
    expect(registry.size).toBe(0);
    expect(old.setTimeout).toHaveBeenCalledOnce();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("lets two concurrent attendance viewers finish independently and releases their registry", async () => {
    let first!: (desktop: Sandbox) => void;
    let second!: (desktop: Sandbox) => void;
    const firstAttach = new Promise<Sandbox>((resolve) => {
      first = resolve;
    });
    const secondAttach = new Promise<Sandbox>((resolve) => {
      second = resolve;
    });
    const a = { sandboxId: "existing", setTimeout: vi.fn().mockResolvedValue(undefined) };
    const b = { sandboxId: "existing", setTimeout: vi.fn().mockResolvedValue(undefined) };
    const sdk: E2BSandboxSdk = {
      create: vi.fn(),
      connect: vi.fn(),
      pause: vi.fn(),
      attachRunning: vi.fn().mockReturnValueOnce(firstAttach).mockReturnValueOnce(secondAttach),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const registry = Reflect.get(provider, "computerOperations") as Map<
      string,
      { pending: number }
    >;
    const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
    const one = provider.keepAlive(ref, { onlyIfRunning: true });
    const two = provider.keepAlive(ref, { onlyIfRunning: true });
    expect(registry.size).toBe(1);
    expect(registry.get(ref.id)?.pending).toBe(2);
    first(a as unknown as Sandbox);
    await one;
    expect(a.setTimeout).toHaveBeenCalledOnce();
    expect(registry.size).toBe(1);
    expect(registry.get(ref.id)?.pending).toBe(1);
    second(b as unknown as Sandbox);
    await two;
    expect(b.setTimeout).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each(["missing", "transport", "gone"])(
    "releases attendance registry after a current %s attachment result",
    async (outcome) => {
      const error =
        outcome === "gone"
          ? new SandboxNotFoundError("Synthetic sandbox unavailable")
          : new Error("Synthetic transport unavailable");
      const attach = vi.fn();
      if (outcome === "missing") attach.mockResolvedValueOnce(undefined);
      else attach.mockRejectedValueOnce(error);
      const desktop = { sandboxId: "existing", setTimeout: vi.fn().mockResolvedValue(undefined) };
      attach.mockResolvedValue(desktop);
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi.fn(),
        pause: vi.fn(),
        attachRunning: attach,
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const registry = Reflect.get(provider, "computerOperations") as Map<string, unknown>;
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const attendance = provider.keepAlive(ref, { onlyIfRunning: true });
      if (outcome === "missing") await expect(attendance).resolves.toBeUndefined();
      else await expect(attendance).rejects.toBe(error);
      expect(registry.size).toBe(0);
      await provider.keepAlive(ref, { onlyIfRunning: true });
      expect(desktop.setTimeout).toHaveBeenCalledOnce();
      expect(registry.size).toBe(0);
      expect(sdk.connect).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "transport", "gone"])(
    "does not renew a cold attendance attachment completing with %s after stop",
    async (outcome) => {
      let attach!: (desktop: Sandbox) => void;
      let reject!: (error: unknown) => void;
      const attachment = new Promise<Sandbox>((resolve, fail) => {
        attach = resolve;
        reject = fail;
      });
      const desktop = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi.fn(),
        pause: vi.fn().mockResolvedValue(undefined),
        attachRunning: vi.fn().mockReturnValue(attachment),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const attendance = provider.keepAlive(ref, { onlyIfRunning: true });
      await provider.stop(ref, context);
      if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
      else attach(desktop);
      await expect(attendance).resolves.toBeUndefined();
      expect(desktop.setTimeout).not.toHaveBeenCalled();
      expect((Reflect.get(provider, "computerOperations") as Map<string, unknown>).size).toBe(0);
      expect(sdk.connect).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("refreshes unchanged attendance with cached computer %s", async (warm) => {
    const cached = {
      sandboxId: "existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
      files: { read: vi.fn().mockResolvedValue(new Uint8Array([1])) },
    } as unknown as Sandbox;
    const attached = {
      sandboxId: "existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue(cached),
      connect: vi.fn(),
      pause: vi.fn(),
      attachRunning: vi.fn().mockResolvedValue(attached),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
    if (warm) await provider.provision({ botId: "bot", homePath: "/unused" }, context);
    vi.setSystemTime(Date.now() + 61_000);
    try {
      await provider.keepAlive(ref, { onlyIfRunning: true });
      expect(attached.setTimeout).toHaveBeenCalledOnce();
      if (warm) {
        await expect(provider.readFile(ref, "saved.bin", context)).resolves.toEqual(
          new Uint8Array([1]),
        );
      }
      expect(cached.setTimeout).not.toHaveBeenCalled();
      expect(sdk.connect).not.toHaveBeenCalled();
      expect(sdk.create).toHaveBeenCalledTimes(warm ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    new Error("Synthetic transport unavailable"),
    new SandboxNotFoundError("Synthetic sandbox unavailable"),
  ])("preserves a current attendance attachment error %s", async (error) => {
    const sdk: E2BSandboxSdk = {
      create: vi.fn(),
      connect: vi.fn(),
      pause: vi.fn(),
      attachRunning: vi.fn().mockRejectedValue(error),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    await expect(
      provider.keepAlive(
        { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" },
        { onlyIfRunning: true },
      ),
    ).rejects.toBe(error);
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each(["success", "transport", "gone"])(
    "ignores an old attendance attachment completing with %s after a successor starts",
    async (outcome) => {
      let attach!: (desktop: Sandbox) => void;
      let reject!: (error: unknown) => void;
      const attachment = new Promise<Sandbox>((resolve, fail) => {
        attach = resolve;
        reject = fail;
      });
      let connect!: (desktop: Sandbox) => void;
      const connection = new Promise<Sandbox>((resolve) => {
        connect = resolve;
      });
      const stale = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const current = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi.fn().mockReturnValue(connection),
        pause: vi.fn().mockResolvedValue(undefined),
        attachRunning: vi.fn().mockReturnValue(attachment),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = { id: "existing", providerRef: "existing", kind: "e2b" as const, botId: "bot" };
      const attendance = provider.keepAlive(ref, { onlyIfRunning: true });
      expect(sdk.connect).not.toHaveBeenCalled();
      await provider.stop(ref, context);
      const successor = provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: ref.id, providerKind: ref.kind },
        context,
      );
      if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
      else attach(stale);
      await expect(attendance).resolves.toBeUndefined();
      expect(stale.setTimeout).not.toHaveBeenCalled();
      connect(current);
      await expect(successor).resolves.toMatchObject({ fresh: false, providerRef: ref.id });
      await provider.keepAlive(ref);
      expect(current.setTimeout).toHaveBeenCalledOnce();
      expect(sdk.connect).toHaveBeenCalledOnce();
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "transport", "gone"])(
    "ignores an old attendance renewal completing with %s after replacement",
    async (outcome) => {
      let complete!: () => void;
      let reject!: (error: unknown) => void;
      const renewal = new Promise<void>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      });
      let renewing!: () => void;
      const started = new Promise<void>((resolve) => {
        renewing = resolve;
      });
      const cached = {
        sandboxId: "existing",
        pause: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const attached = {
        sandboxId: "existing",
        setTimeout: vi.fn(() => {
          renewing();
          return renewal;
        }),
      } as unknown as Sandbox;
      const read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      const current = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
        files: { read },
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        create: vi.fn().mockResolvedValue(cached),
        connect: vi.fn().mockResolvedValue(current),
        pause: vi.fn().mockResolvedValue(undefined),
        attachRunning: vi.fn().mockResolvedValue(attached),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
      const attendance = provider.keepAlive(ref, { onlyIfRunning: true });
      await started;
      expect(attached.setTimeout).toHaveBeenCalledOnce();
      await provider.stop(ref, context);
      await provider.provision(
        {
          botId: "bot",
          homePath: "/unused",
          providerRef: ref.providerRef,
          providerKind: "e2b",
        },
        context,
      );
      vi.setSystemTime(Date.now() + 61_000);
      try {
        if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
        else complete();
        await attendance;
        await expect(provider.readFile(ref, "saved.bin", context)).resolves.toEqual(
          new Uint8Array([1, 2, 3]),
        );
        expect(sdk.connect).toHaveBeenCalledOnce();
        expect(sdk.create).toHaveBeenCalledOnce();
        expect(current.setTimeout).toHaveBeenCalledOnce();
        expect(sdk.attachRunning).toHaveBeenCalledExactlyOnceWith("existing", {
          apiKey: "test-key",
          signal: expect.any(AbortSignal),
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("extends attendance through only a running-state GET and timeout update", async () => {
    await withRetainedE2BServer({}, async (requests, backend) => {
      await backend.keepAlive(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
        { onlyIfRunning: true },
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /sandboxes/existing",
        "POST /sandboxes/existing/timeout",
      ]);
    });
  });

  it.each(["paused", "gone"])("does not resume %s computers for attendance", async (state) => {
    await withRetainedE2BServer({ state }, async (requests, backend) => {
      await backend.keepAlive(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
        { onlyIfRunning: true },
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /sandboxes/existing",
      ]);
    });
  });

  it("does not use connect when no safe attendance lookup is available", async () => {
    const sdk = { connect: vi.fn(), create: vi.fn(), pause: vi.fn() };
    const backend = new E2BSandboxProvider("test-key", sdk as unknown as E2BSandboxSdk);
    await expect(
      backend.keepAlive(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
        { onlyIfRunning: true },
      ),
    ).rejects.toThrow(/without resuming/);
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each([true, undefined])(
    "does not use an unverified auto-resume policy (%s) for attendance",
    async (autoResume) => {
      await withRetainedE2BServer({ autoResume }, async (requests, backend) => {
        await expect(
          backend.keepAlive(
            { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
            { onlyIfRunning: true },
          ),
        ).rejects.toThrow(/auto-resume to be disabled/);
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "GET /sandboxes/existing",
        ]);
      });
    },
  );

  it("rechecks attendance state instead of using a cached active handle", async () => {
    const setTimeout = vi.fn();
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue({ sandboxId: "existing", setTimeout }),
      connect: vi.fn(),
      pause: vi.fn(),
      attachRunning: vi.fn().mockResolvedValue(undefined),
    };
    const backend = new E2BSandboxProvider("test-key", sdk);
    const computer = await backend.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await backend.keepAlive(computer, { onlyIfRunning: true });
    expect(sdk.attachRunning).toHaveBeenCalledOnce();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("releases a cold worker's screen through only the SDK state GET and envd command", async () => {
    await withRetainedE2BServer({}, async (requests, backend) => {
      await backend.releaseScreen(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
        { ...context, botId: "bot-a", screenLeaseId: "run-a:2" },
        { onlyIfRunning: true },
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /sandboxes/existing",
        "POST /process.Process/Start",
      ]);
      expect(requests[1]?.token).toBe("test-envd-token");
      expect(requests[1]?.body).toContain("run-a:2");
    });
  });

  it.each(["paused", "gone"])(
    "does not issue envd traffic or resume an existing %s sandbox for cleanup",
    async (state) => {
      await withRetainedE2BServer({ state }, async (requests, backend) => {
        await backend.releaseScreen(
          { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
          context,
          { onlyIfRunning: true },
        );
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "GET /sandboxes/existing",
        ]);
      });
    },
  );

  it.each([true, undefined])(
    "rejects retained cleanup when the auto-resume policy is %s",
    async (autoResume) => {
      await withRetainedE2BServer({ autoResume }, async (requests, backend) => {
        await expect(
          backend.releaseScreen(
            { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
            context,
            { onlyIfRunning: true },
          ),
        ).rejects.toThrow("requires auto-resume to be disabled");
        expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "GET /sandboxes/existing",
        ]);
      });
    },
  );

  it("does not guess how to resume a sandbox with an unknown cleanup state", async () => {
    await withRetainedE2BServer({ state: "unknown" }, async (requests, backend) => {
      await expect(
        backend.releaseScreen(
          { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
          context,
          { onlyIfRunning: true },
        ),
      ).rejects.toThrow("retained-screen state is unknown");
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /sandboxes/existing",
      ]);
    });
  });

  it("does not reconnect or extend the timeout when a sandbox pauses before cleanup exec", async () => {
    await withRetainedE2BServer({ execFails: true }, async (requests, backend) => {
      await expect(
        backend.releaseScreen(
          { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
          context,
          { onlyIfRunning: true },
        ),
      ).rejects.toThrow();
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /sandboxes/existing",
        "POST /process.Process/Start",
      ]);
    });
  });

  it("uses only a running-handle lookup for retained-screen cleanup in a cold worker", async () => {
    const command = vi.fn(async (_value: string) => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sdk = {
      attachRunning: vi.fn(async () => ({ sandboxId: "existing", commands: { run: command } })),
      connect: vi.fn(async () => ({ sandboxId: "existing", commands: { run: command } })),
      create: vi.fn(),
      pause: vi.fn(),
    };
    const backend = new E2BSandboxProvider("test-key", sdk as unknown as E2BSandboxSdk);
    await backend.releaseScreen(
      { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
      { ...context, botId: "bot-a", screenLeaseId: "run-a:2" },
      { onlyIfRunning: true },
    );
    expect(sdk.attachRunning).toHaveBeenCalledOnce();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0]).toContain("run-a:2");
  });

  it("checks retained cleanup state again instead of using a cached active handle", async () => {
    const command = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue({ sandboxId: "existing", commands: { run: command } }),
      connect: vi.fn(),
      pause: vi.fn(),
      attachRunning: vi.fn().mockResolvedValue(undefined),
    };
    const backend = new E2BSandboxProvider("test-key", sdk);
    const computer = await backend.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await backend.releaseScreen(computer, context, { onlyIfRunning: true });
    expect(sdk.attachRunning).toHaveBeenCalledOnce();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it.each([429, 503])("does not retry a failed retained-state GET (%s)", async (lookupStatus) => {
    await withRetainedE2BServer({ lookupStatus }, async (requests, backend) => {
      await expect(
        backend.releaseScreen(
          { id: "existing", providerRef: "existing", kind: "e2b", botId: "home" },
          context,
          { onlyIfRunning: true },
        ),
      ).rejects.toThrow(`state lookup failed (${lookupStatus})`);
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /sandboxes/existing",
      ]);
    });
  });

  it("removes inherited variables after the command environment overlay", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const provider = new E2BSandboxProvider("test-key", {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        commands: { run },
      })),
    } as unknown as E2BSandboxSdk);
    const events = [];
    for await (const event of provider.execute(
      { id: "existing", providerRef: "existing", kind: "e2b", botId: "bot" },
      { argv: ["true"], env: { FAILED: "fake-space" }, unsetEnv: ["FAILED"] },
      context,
    ))
      events.push(event);
    expect(events).toEqual([{ type: "exit", code: 0 }]);
    expect(run).toHaveBeenCalledWith(
      "'env' '-u' 'FAILED' '--' 'true'",
      expect.objectContaining({ envs: { FAILED: "fake-space" } }),
    );
  });

  it("revokes an extra display's control without starting or waiting for its view", async () => {
    const command = vi.fn(async (value: string) => {
      if (value.includes("RAKAZO_SCREEN_INDEX=")) {
        return { stdout: "RAKAZO_SCREEN_INDEX=1\n", stderr: "", exitCode: 0 };
      }
      if (value.includes("RAKAZO_SCREEN_PASSWORD=") || value.includes("flock 8")) {
        throw new Error("extra view is unavailable");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const provider = new E2BSandboxProvider("test-key", {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        display: ":0",
        commands: { run: command },
      })),
    } as unknown as E2BSandboxSdk);

    await expect(
      provider.setScreenControl(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "bot" },
        false,
        { ...context, botId: "bot" },
        "expired-control-token",
      ),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("expired-control-token"),
      expect.objectContaining({ signal: context.signal }),
    );
  });

  it("reconnects concurrent primary viewers without using the SDK's global VNC lifecycle", async () => {
    const command = vi.fn(async (_value: string) => ({
      stdout: "RAKAZO_DESKTOP=0:savedkey\n",
      stderr: "",
      exitCode: 0,
    }));
    const globalStream = vi.fn(async () => {
      throw new Error("Stream is already running");
    });
    const sdk = {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        display: ":0",
        getHost: (port: number) => `${port}-desktop.test`,
        commands: { run: command },
        stream: { start: globalStream, stop: globalStream },
      })),
    } as unknown as E2BSandboxSdk;
    const computer = {
      id: "existing",
      providerRef: "existing",
      kind: "e2b" as const,
      botId: "bot",
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const [first, second] = await Promise.all([
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.provision({ ...computer, providerKind: "e2b", homePath: "/unused" }, context),
    ]);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(first.url).toBe(second.url);
    expect(new URL(first.url!).searchParams.get("path")).toBe("websockify?token=savedkey");

    const restarted = new E2BSandboxProvider("test-key", sdk);
    const restored = await restarted.connectScreen(computer, { view: "stream" }, context);
    expect(restored.url).toBe(first.url);
    const commandsBeforeClose = command.mock.calls.length;
    await first.close();
    expect(command).toHaveBeenCalledTimes(commandsBeforeClose);
    expect(globalStream).not.toHaveBeenCalled();
  });

  it("only filters transient cache files inside portable browser profiles", () => {
    expect(shouldSkipPortableWorkspaceFile("project/Cache/important.txt")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile("project/lock")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/Cache/data")).toBe(true);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/SingletonLock")).toBe(true);
  });

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    undefined,
  ])("preserves an existing sandbox after a %s transport failure", async (code) => {
    const desktop = { sandboxId: "fresh-e2b-box" } as unknown as Sandbox;
    const failure = new Error("fetch failed", {
      cause: Object.assign(new Error("transport unavailable"), { code }),
    });
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ sandboxId: "existing" }),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);

    const request = {
      botId: "bot-1",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "e2b" as const,
    };
    await expect(provider.provision(request, context)).rejects.toBe(failure);
    expect(sdk.create).not.toHaveBeenCalled();
    await expect(provider.provision(request, context)).resolves.toMatchObject({
      providerRef: "existing",
      fresh: false,
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("creates a replacement when the provider confirms the sandbox no longer exists", async () => {
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue({ sandboxId: "replacement" }),
      connect: vi.fn().mockRejectedValue(
        Object.assign(new Error("Sandbox not found"), {
          name: "SandboxNotFoundError",
        }),
      ),
      pause: vi.fn(),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    await expect(
      provider.provision(
        {
          botId: "bot-1",
          homePath: "/unused",
          providerRef: "missing",
          providerKind: "e2b",
        },
        context,
      ),
    ).resolves.toMatchObject({ providerRef: "replacement", fresh: true });
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it.each([404, 503])(
    "uses SDK deletion semantics for a cached handle receiving %s",
    async (status) => {
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: status, message: "sandbox unavailable" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test server address");
        const desktop = new Sandbox({
          sandboxId: "expired",
          envdVersion: "0.1.0",
          apiKey: "test-key",
          validateApiKey: false,
          debug: false,
          proxy: "",
          apiUrl: `http://127.0.0.1:${address.port}`,
        });
        const sdk: E2BSandboxSdk = {
          create: vi.fn().mockResolvedValue(desktop),
          connect: vi.fn(),
          pause: vi.fn(),
        };
        const provider = new E2BSandboxProvider("test-key", sdk);
        const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
        if (status === 404) {
          await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
        } else {
          await expect(provider.destroy(computer, context)).rejects.toThrow();
        }
        expect(requests).toEqual(["DELETE /sandboxes/expired"]);
        expect(sdk.connect).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("gives screen setup commands a real timeout and surfaces a failed one as unavailable", async () => {
    const run = vi.fn(async (_command: string, opts?: { timeoutMs?: number }) => {
      // The SDK throws on a non-zero exit rather than returning the result, and caps the
      // command at 60s unless a timeout is passed.
      if ((opts?.timeoutMs ?? 60_000) <= 60_000) {
        throw Object.assign(new Error("signal: terminated"), {
          name: "CommandExitError",
          result: { exitCode: -1, stdout: "", stderr: "", error: "signal: terminated" },
        });
      }
      throw Object.assign(new Error("boom"), {
        name: "CommandExitError",
        result: { exitCode: 1, stdout: "", stderr: "boom", error: "boom" },
      });
    });
    const desktop = {
      sandboxId: "screen-e2b-box",
      display: ":0",
      commands: { run },
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "screen-e2b-box",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "screen-e2b-box",
      fresh: false,
    };

    await expect(provider.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
      Error,
    );
    expect(run.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(60_000);
  });

  it("surfaces a setup timeout without treating it as a missing sandbox", async () => {
    const run = vi.fn(async () => {
      throw new TimeoutError("the operation timed out");
    });
    const desktop = {
      sandboxId: "timeout-e2b-box",
      display: ":0",
      commands: { run },
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "timeout-e2b-box",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "timeout-e2b-box",
      fresh: false,
    };

    await expect(provider.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
      Error,
    );
  });

  it("prepares a reused computer idempotently", async () => {
    let profilesConfigured = false;
    const command = vi.fn(async (value: string) => {
      if (value.startsWith('test "$(readlink') && !profilesConfigured) {
        throw new Error("profiles are not configured");
      }
      if (value.includes("ln -s")) profilesConfigured = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const desktop = {
      sandboxId: "reused-e2b-box",
      commands: { run: command },
      launch: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision(
      {
        botId: "bot-1",
        homePath: "/unused",
        providerRef: "reused-e2b-box",
        providerKind: "e2b",
      },
      context,
    );

    await provider.prepare(computer, context);
    await provider.prepare(computer, context);

    expect(command.mock.calls.every(([value]) => value.includes("apt-get"))).toBe(true);
    expect(desktop.launch).not.toHaveBeenCalled();
  });

  it("opens http(s) URLs through the named browser launcher", async () => {
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const launch = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    const desktop = {
      sandboxId: "e2b-open-url-box",
      display: ":0",
      commands: { run: command },
      files: { makeDir: vi.fn(async () => undefined) },
      launch,
      open,
    } as unknown as Sandbox;
    const provider = new E2BSandboxProvider("test-key", {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    });
    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/unused", providerKind: "e2b" },
      context,
    );

    await provider.act(
      computer,
      { actions: [{ kind: "open", path: "https://example.com/docs" }], observe: false },
      context,
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("browser-launch-20"),
      expect.anything(),
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("https://example.com/docs"),
      expect.anything(),
    );
    expect(launch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    await provider.act(
      computer,
      { actions: [{ kind: "open", path: "notes/readme.md" }], observe: false },
      context,
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home/notes/readme.md"),
      expect.anything(),
    );
  });

  it("opens a terminal in the workspace root or the Team bot folder", async () => {
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const desktop = {
      sandboxId: "e2b-terminal-box",
      display: ":0",
      commands: { run: command },
      files: { makeDir: vi.fn(async () => undefined) },
      getHost: (port: number) => `${port}-e2b-terminal-box.e2b.test`,
    } as unknown as Sandbox;
    const provider = new E2BSandboxProvider("test-key", {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    });
    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/unused", providerKind: "e2b" },
      context,
    );

    const root = await provider.connectTerminal(computer, { controlToken: "lease-1" }, context);
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home"),
      expect.anything(),
    );
    const socket = new URL(root.url).searchParams.get("path");
    expect(new URL(root.url).host).toBe("6100-e2b-terminal-box.e2b.test");
    expect(socket).toMatch(/^websockify\?token=[0-9a-f-]{36}$/);

    await provider.connectTerminal(
      computer,
      { controlToken: "lease-1", cwd: "bots/bot-1" },
      context,
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home/bots/bot-1"),
      expect.anything(),
    );
  });

  it("controls the desktop and exposes a portable workspace", async () => {
    const files = new Map<string, Uint8Array>();
    const leftClick = vi.fn(async () => undefined);
    const typeText = vi.fn(async () => undefined);
    const respond = desktopCommandResponder();
    const command = vi.fn(async (value: string, _options?: Record<string, unknown>) => {
      const response = respond(value);
      if (response) return response;
      if (value.includes("hang")) {
        throw new TimeoutError("command timed out");
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        disconnect: async () => undefined,
      };
    });
    const getStreamUrl = vi.fn(() => "https://desktop.test/vnc.html");
    const streamStart = vi.fn(async () => undefined);
    const streamStop = vi.fn(async () => undefined);
    const desktop = {
      sandboxId: "e2b-test-box",
      display: ":0",
      getHost: (port: number) => `${port}-desktop.test`,
      commands: { run: command },
      files: {
        makeDir: vi.fn(async () => undefined),
        write: vi.fn(async (entries: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of entries) files.set(entry.path, new Uint8Array(entry.data));
        }),
        read: vi.fn(async (filePath: string) => {
          const content = files.get(filePath);
          if (!content) throw new Error("missing file");
          return content;
        }),
        list: vi.fn(async (directory: string) => {
          const prefix = `${directory.replace(/\/$/, "")}/`;
          return [...files.entries()]
            .filter(([filePath]) => filePath.startsWith(prefix))
            .map(([filePath, content]) => ({
              name: filePath.slice(prefix.length),
              type: "file" as const,
              size: content.byteLength,
              mode: 0o600,
            }));
        }),
      },
      stream: {
        start: streamStart,
        stop: streamStop,
        getAuthKey: () => "screen-key",
        getUrl: getStreamUrl,
      },
      launch: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      getScreenSize: vi.fn(async () => ({ width: 1280, height: 800 })),
      getCursorPosition: vi.fn(async () => ({ x: 10, y: 20 })),
      getCurrentWindowId: vi.fn(async () => "42"),
      getWindowTitle: vi.fn(async () => "Browser"),
      leftClick,
      rightClick: vi.fn(async () => undefined),
      moveMouse: vi.fn(async () => undefined),
      mousePress: vi.fn(async () => undefined),
      mouseRelease: vi.fn(async () => undefined),
      write: typeText,
      press: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
      setTimeout: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision(
      {
        botId: "bot-1",
        homePath: "/unused",
        providerRef: "foreign-provider-machine",
        providerKind: "docker",
      },
      context,
    );
    expect(sdk.connect).not.toHaveBeenCalled();
    await provider.prepare(computer, context);
    await provider.importWorkspace(
      computer,
      (async function* () {
        // Empty durable home on first boot.
      })(),
      context,
    );

    const timeoutEvents = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["hang"], timeoutMs: 42 },
      context,
    )) {
      timeoutEvents.push(event);
    }
    expect(timeoutEvents).toEqual([
      { type: "stderr", data: "command timed out after 42 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(command).toHaveBeenCalledWith(
      "'hang'",
      expect.objectContaining({ timeoutMs: 42, signal: context.signal }),
    );

    await provider.writeFile(
      computer,
      {
        path: "notes/result.txt",
        content: new TextEncoder().encode("portable"),
      },
      context,
    );
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", context)),
    ).toBe("portable");
    expect(await provider.listFiles(computer, "notes", context)).toEqual([
      { path: "notes/result.txt", kind: "file", size: 8 },
    ]);

    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "click", x: 100, y: 120 },
          { kind: "clipboard", text: "hello" },
        ],
        observe: true,
      },
      context,
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("xdotool mousemove 100 120 click 1"),
      expect.anything(),
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("xdotool type"),
      expect.anything(),
    );
    expect(result.observation).toMatchObject({ width: 1280, height: 800 });
    expect(command.mock.calls.some(([value]) => String(value).includes(".browser-profiles"))).toBe(
      true,
    );
    expect(command.mock.calls.some(([value]) => String(value).includes("cp -a"))).toBe(false);
    const [screen] = await Promise.all([
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.connectScreen(computer, { view: "stream" }, context),
    ]);
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      context,
    );
    expect(control.url).toContain("6100-desktop.test");
    expect(new URL(control.url!).searchParams.get("path")).toBe("websockify?token=lease-1");
    await provider.setScreenControl(computer, false, context, "lease-1");
    await screen.close();
    expect(streamStop).not.toHaveBeenCalled();
    await provider.stop(computer, context);
    expect(desktop.pause).toHaveBeenCalled();
  });

  it("gives Team bots distinct E2B screens and shared files", async () => {
    const files = new Map<string, Uint8Array>();
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const desktop = {
      sandboxId: "e2b-shared",
      display: ":0",
      getHost: (port: number) => `${port}-desktop.test`,
      commands: { run: command },
      files: {
        makeDir: vi.fn(async () => undefined),
        write: vi.fn(async (entries: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of entries) files.set(entry.path, new Uint8Array(entry.data));
        }),
        read: vi.fn(async (filePath: string) => {
          const content = files.get(filePath);
          if (!content) throw new Error("missing file");
          return content;
        }),
        list: vi.fn(async (directory: string) => {
          const prefix = `${directory.replace(/\/$/, "")}/`;
          return [...files.entries()]
            .filter(([filePath]) => filePath.startsWith(prefix))
            .map(([filePath, content]) => ({
              name: filePath.slice(prefix.length),
              type: "file" as const,
              size: content.byteLength,
              mode: 0o600,
            }));
        }),
      },
      stream: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getAuthKey: () => "key",
        getUrl: () => "https://6100-desktop.test/vnc.html",
      },
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      getScreenSize: vi.fn(async () => ({ width: 1280, height: 800 })),
      getCursorPosition: vi.fn(async () => ({ x: 1, y: 1 })),
      getCurrentWindowId: vi.fn(async () => "1"),
      getWindowTitle: vi.fn(async () => "Desk"),
      leftClick: vi.fn(async () => undefined),
      moveMouse: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("e2b_test", {
      create: vi.fn(async () => desktop as never),
      connect: vi.fn(),
      pause: vi.fn(),
    } as unknown as E2BSandboxSdk);
    const computer = await provider.provision({ botId: "team-home", homePath: "/tmp" }, context);
    const writer = { ...context, botId: "writer" };
    const researcher = { ...context, botId: "researcher" };

    await provider.observe(computer, writer);
    await provider.observe(computer, researcher);
    const writerView = await provider.connectScreen(computer, { view: "stream" }, writer);
    const researcherView = await provider.connectScreen(computer, { view: "stream" }, researcher);
    expect(writerView.url).toContain("6100-desktop.test");
    expect(researcherView.url).not.toBe(writerView.url);
    expect(researcherView.url).toContain("6100-desktop.test");
    expect(new URL(researcherView.url!).searchParams.get("path")).toMatch(
      /^websockify\?token=view-/,
    );
    expect(writerView.url).not.toBe(researcherView.url);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
      command.mock.calls.some(([value]) => String(value).includes("Xvfb :${desktop_display}")),
    ).toBe(true);
    expect(command.mock.calls.some(([value]) => String(value).includes("pkill -x x11vnc"))).toBe(
      false,
    );

    await provider.act(
      computer,
      {
        actions: [{ kind: "pointer", type: "click", x: 1, y: 2 }],
        observe: false,
      },
      researcher,
    );
    expect(
      command.mock.calls.some(([value]) => String(value).includes("DISPLAY=:21 xdotool")),
    ).toBe(true);
    expect(desktop.moveMouse).not.toHaveBeenCalled();

    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      researcher,
    );
    expect(control.url).toContain("6100-desktop.test");
    expect(new URL(control.url!).searchParams.get("path")).toBe("websockify?token=lease-1");

    await provider.writeFile(
      computer,
      { path: "shared/note.txt", content: new TextEncoder().encode("office") },
      researcher,
    );
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "shared/note.txt", writer)),
    ).toBe("office");

    await provider.releaseScreen(computer, writer);
    await expect(provider.observe(computer, researcher)).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
    expect(provider.describe().capabilities.multiScreen).toBe(true);

    for (let index = 0; index < 100; index += 1) {
      await provider.observe(computer, {
        ...context,
        botId: `bot-${index + 2}`,
      });
    }
    await expect(
      provider.observe(computer, { ...context, botId: "bot-102" }),
    ).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
  });
});

interface RetainedE2BRequest {
  method: string;
  path: string;
  body: string;
  token?: string;
}

async function withRetainedE2BServer(
  options: { state?: string; autoResume?: boolean; execFails?: boolean; lookupStatus?: number },
  check: (requests: RetainedE2BRequest[], backend: E2BSandboxProvider) => Promise<void>,
): Promise<void> {
  const requests: RetainedE2BRequest[] = [];
  const autoResume = Object.hasOwn(options, "autoResume") ? options.autoResume : false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        token:
          typeof request.headers["x-access-token"] === "string"
            ? request.headers["x-access-token"]
            : undefined,
      });
      if (request.method === "GET" && request.url === "/sandboxes/existing") {
        response.writeHead(options.lookupStatus ?? (options.state === "gone" ? 404 : 200), {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(
          JSON.stringify(
            options.state === "gone"
              ? { code: 404 }
              : {
                  sandboxID: "existing",
                  state: options.state ?? "running",
                  envdVersion: "0.3.0",
                  envdAccessToken: "test-envd-token",
                  lifecycle:
                    autoResume === undefined ? undefined : { autoResume, onTimeout: "pause" },
                },
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/process.Process/Start") {
        if (options.execFails) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "failed_precondition", message: "sandbox paused" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/connect+json" });
        const envelope = (data: unknown, flag = 0) => {
          const body = Buffer.from(JSON.stringify(data));
          const header = Buffer.alloc(5);
          header[0] = flag;
          header.writeUInt32BE(body.length, 1);
          return Buffer.concat([header, body]);
        };
        response.end(
          Buffer.concat([
            envelope({ event: { start: { pid: 42 } } }),
            envelope({ event: { end: { exitCode: 0, exited: true } } }),
            envelope({}, 2),
          ]),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes/existing/timeout") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "unexpected test request" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("E2B_API_URL", baseUrl);
    vi.stubEnv("E2B_SANDBOX_URL", baseUrl);
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    await check(requests, new E2BSandboxProvider("test-key"));
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("workspace export activity", () => {
  it("renews the captured active export handle without reconnecting and preserves file bytes", async () => {
    vi.useFakeTimers();
    let list!: (entries: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => {
      list = resolve;
    });
    const bytes = new Uint8Array([0, 255, 1, 128]);
    const desktop = {
      sandboxId: "active-export",
      setTimeout: vi.fn().mockResolvedValue(undefined),
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) },
      files: { list: vi.fn(() => pending), read: vi.fn().mockResolvedValue(bytes) },
    };
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue(desktop),
      connect: vi.fn(),
      pause: vi.fn(),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
    const iterator = provider.exportWorkspace(computer, context)[Symbol.asyncIterator]();
    try {
      const reading = iterator.next();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(desktop.setTimeout).toHaveBeenCalledTimes(4);
      expect(sdk.connect).not.toHaveBeenCalled();
      expect(sdk.create).toHaveBeenCalledOnce();
      list([{ name: "binary.dat", type: "file", mode: 0o700 }]);
      await expect(reading).resolves.toMatchObject({
        done: false,
        value: { path: "binary.dat", content: bytes, executable: true },
      });
      await iterator.return?.();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      list([]);
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it("clears renewal on export failure and preserves the reader error", async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error("Synthetic export failed");
      const desktop = { setTimeout: vi.fn().mockRejectedValue(new Error("Renewal unavailable")) };
      const items = (async function* () {
        yield await Promise.reject(failure);
      })();
      await expect(
        (async () => {
          for await (const _ of keepingAwake(desktop, items)) {
            /* drain */
          }
        })(),
      ).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let best-effort renewal failure replace a successful export", async () => {
    vi.useFakeTimers();
    try {
      const desktop = { setTimeout: vi.fn().mockRejectedValue(new Error("Renewal unavailable")) };
      const items = (async function* () {
        yield "saved";
      })();
      const result = [];
      for await (const value of keepingAwake(desktop, items)) result.push(value);
      expect(result).toEqual(["saved"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a cancelled export or create a timer after cancellation during its first renewal", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const extension = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const desktop = { setTimeout: vi.fn(() => extension) };
    const read = vi.fn();
    try {
      const itemStream = () =>
        (async function* () {
          read();
          yield "saved";
        })();
      const iterator = keepingAwake(desktop, itemStream(), controller.signal)[
        Symbol.asyncIterator
      ]();
      const pending = iterator.next();
      controller.abort(new Error("Export cancelled"));
      finish();
      await expect(pending).rejects.toThrow("Export cancelled");
      const alreadyCancelled = keepingAwake(desktop, itemStream(), controller.signal)[
        Symbol.asyncIterator
      ]();
      await expect(alreadyCancelled.next()).rejects.toThrow("Export cancelled");
      expect(read).not.toHaveBeenCalled();
      expect(desktop.setTimeout).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      vi.useRealTimers();
    }
  });

  it("keeps concurrent exports independent and uses half of a short idle lease", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SANDBOX_IDLE_MS", "30000");
    const a = { setTimeout: vi.fn().mockResolvedValue(undefined) };
    const b = { setTimeout: vi.fn().mockResolvedValue(undefined) };
    const controller = new AbortController();
    const items = () =>
      (async function* () {
        yield "saved";
      })();
    const first = keepingAwake(a, items(), controller.signal)[Symbol.asyncIterator]();
    const second = keepingAwake(b, items())[Symbol.asyncIterator]();
    try {
      await first.next();
      await second.next();
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(a.setTimeout).toHaveBeenCalledTimes(1);
      expect(b.setTimeout).toHaveBeenCalledTimes(2);
      expect(b.setTimeout).toHaveBeenLastCalledWith(30_000);
    } finally {
      await first.return?.();
      await second.return?.();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("stops renewing immediately on cancellation even while the reader is paused", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const desktop = { setTimeout: vi.fn(async () => undefined) };
    const items = (async function* () {
      yield "first";
      yield "last";
    })();
    const iterator = keepingAwake(desktop, items, controller.signal)[Symbol.asyncIterator]();
    try {
      await iterator.next();
      controller.abort(new Error("Export cancelled"));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(desktop.setTimeout).toHaveBeenCalledTimes(1);
      await expect(iterator.next()).rejects.toThrow("Export cancelled");
    } finally {
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it("does not pile up lease extensions when a renewal is slower than its interval", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const desktop = {
      setTimeout: vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(pending),
    };
    const iterator = keepingAwake(
      desktop,
      (async function* () {
        yield "first";
      })(),
    )[Symbol.asyncIterator]();
    try {
      await iterator.next();
      await vi.advanceTimersByTimeAsync(240_000);
      expect(desktop.setTimeout).toHaveBeenCalledTimes(2);
      finish();
      await iterator.return?.();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it("finishes the first timeout extension before reading and clears its timer on return", async () => {
    vi.useFakeTimers();
    try {
      let extended!: () => void;
      const extension = new Promise<void>((resolve) => {
        extended = resolve;
      });
      const desktop = { setTimeout: vi.fn(() => extension) };
      const read = vi.fn();
      const items = (async function* () {
        read();
        yield "saved";
      })();
      const iterator = keepingAwake(desktop, items)[Symbol.asyncIterator]();
      const first = iterator.next();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).not.toHaveBeenCalled();
      extended();
      await expect(first).resolves.toEqual({ value: "saved", done: false });
      await iterator.return?.();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(desktop.setTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sandbox-gone detection", () => {
  it.each(["stop", "abort"] as const)(
    "returns an already dispatched replacement for caller cleanup after %s",
    async (teardown) => {
      let create!: (sandbox: Sandbox) => void;
      const replacement = new Promise<Sandbox>((resolve) => {
        create = resolve;
      });
      let creating!: () => void;
      const started = new Promise<void>((resolve) => {
        creating = resolve;
      });
      const sdk: E2BSandboxSdk = {
        connect: vi
          .fn()
          .mockRejectedValueOnce(new SandboxNotFoundError("Synthetic sandbox missing")),
        create: vi.fn(() => {
          creating();
          return replacement;
        }),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const controller = new AbortController();
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const recovering = provider.provision(
        { botId: ref.botId, homePath: "/unused", providerRef: ref.id, providerKind: ref.kind },
        { ...context, signal: controller.signal },
      );
      await started;
      if (teardown === "stop") await provider.stop(ref, context);
      else controller.abort();
      const kill = vi.fn().mockResolvedValue(undefined);
      create({ sandboxId: "replacement", kill } as unknown as Sandbox);
      const fresh = await recovering;
      expect(fresh).toMatchObject({ providerRef: "replacement", fresh: true });
      await provider.destroy(fresh, context);
      expect(kill).toHaveBeenCalledOnce();
      expect(sdk.create).toHaveBeenCalledOnce();
      expect((Reflect.get(provider, "computerOperations") as Map<string, unknown>).size).toBe(0);
    },
  );

  it("returns an already connected handle for caller settlement after cancellation", async () => {
    let connect!: (sandbox: Sandbox) => void;
    const connection = new Promise<Sandbox>((resolve) => {
      connect = resolve;
    });
    const sdk: E2BSandboxSdk = {
      connect: vi.fn(() => connection),
      create: vi.fn(),
      pause: vi.fn(),
    };
    const controller = new AbortController();
    const provider = new E2BSandboxProvider("test-key", sdk);
    const connecting = provider.provision(
      { botId: "bot", homePath: "/unused", providerRef: "existing", providerKind: "e2b" },
      { ...context, signal: controller.signal },
    );
    controller.abort();
    connect({ sandboxId: "existing" } as Sandbox);
    await expect(connecting).resolves.toMatchObject({ providerRef: "existing", fresh: false });
    expect(sdk.create).not.toHaveBeenCalled();
    expect((Reflect.get(provider, "computerOperations") as Map<string, unknown>).size).toBe(0);
  });

  it("does not create a replacement after the existing-resource request is cancelled", async () => {
    let reject!: (error: unknown) => void;
    const connection = new Promise<Sandbox>((_resolve, fail) => {
      reject = fail;
    });
    const sdk: E2BSandboxSdk = {
      connect: vi.fn().mockReturnValueOnce(connection),
      create: vi.fn().mockResolvedValue({ sandboxId: "unexpected" }),
      pause: vi.fn(),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const controller = new AbortController();
    const cancelled = new Error("Synthetic request cancelled");
    const recovering = provider
      .provision(
        { botId: "bot", homePath: "/unused", providerRef: "existing", providerKind: "e2b" },
        { ...context, signal: controller.signal },
      )
      .catch((error: unknown) => error);
    controller.abort(cancelled);
    reject(new SandboxNotFoundError("Synthetic sandbox missing"));
    await expect(recovering).resolves.toBe(cancelled);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each([
    ["sandbox settings.json not found", false],
    ["sandbox settings.json not found", true],
    ["sandbox 菜单😀.json not found", false],
    ["sandbox 菜单😀.json not found", true],
    ["sandbox settings.json does not exist", false],
    ["sandbox settings.json does not exist", true],
  ] as const)("preserves a typed missing file %s with wrapper %s", (message, wrapped) => {
    const missing = new FileNotFoundError(message);
    const error = wrapped ? new Error("sandbox not found", { cause: missing }) : missing;
    expect(isSandboxGoneError(error)).toBe(false);
  });

  it.each(["stop", "destroy"] as const)(
    "rejects Gone handed from box to provision after explicit %s",
    async (teardown) => {
      let reject!: (error: unknown) => void;
      const connection = new Promise<Sandbox>((_resolve, fail) => {
        reject = fail;
      });
      const sdk: E2BSandboxSdk = {
        connect: vi
          .fn()
          .mockReturnValueOnce(connection)
          .mockResolvedValue({
            sandboxId: "existing",
            kill: vi.fn().mockResolvedValue(undefined),
          }),
        create: vi.fn().mockResolvedValue({ sandboxId: "unexpected" }),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const recovering = provider
        .provision(
          { botId: ref.botId, homePath: "/unused", providerRef: ref.id, providerKind: ref.kind },
          context,
        )
        .catch((error: unknown) => error);
      let stopped: Promise<void> | undefined;
      const schedule = (remaining: number) =>
        queueMicrotask(() => {
          if (remaining) return schedule(remaining - 1);
          stopped = provider[teardown](ref, context);
        });
      reject(new SandboxNotFoundError("Synthetic sandbox missing"));
      // Reach the later handoff after box's own rejection/finally checks have run.
      schedule(4);
      try {
        await expect(recovering).resolves.toMatchObject({
          message: "computer connection stopped during teardown",
        });
        expect(sdk.create).not.toHaveBeenCalled();
      } finally {
        await stopped;
      }
    },
  );

  it.each<["stop" | "destroy", boolean]>([
    ["stop", false],
    ["destroy", false],
    ["stop", true],
    ["destroy", true],
  ])(
    "rejects Gone after %s in the connection-finally microtask window with successor %s",
    async (teardown, next) => {
      let reject!: (error: unknown) => void;
      const initial = new Promise<Sandbox>((_resolve, fail) => {
        reject = fail;
      });
      let connect!: (desktop: Sandbox) => void;
      const connection = new Promise<Sandbox>((resolve) => {
        connect = resolve;
      });
      const kill = vi.fn().mockResolvedValue(undefined);
      const sdk: E2BSandboxSdk = {
        create: vi.fn().mockResolvedValue({ sandboxId: "unexpected" }),
        connect: vi.fn().mockReturnValueOnce(initial),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      if (teardown === "destroy") {
        vi.mocked(sdk.connect).mockResolvedValueOnce({
          sandboxId: "existing",
          kill,
        } as unknown as Sandbox);
      }
      vi.mocked(sdk.connect).mockReturnValueOnce(connection);
      const provider = new E2BSandboxProvider("test-key", sdk);
      const request = {
        botId: "bot",
        homePath: "/unused",
        providerRef: "existing",
        providerKind: "e2b" as const,
      };
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const first = provider.provision(request, context).catch((error: unknown) => error);
      const second = provider.provision(request, context).catch((error: unknown) => error);
      let stopped: Promise<void> | undefined;
      let successor: Promise<unknown> | undefined;
      const registry = Reflect.get(provider, "computerOperations") as Map<string, unknown>;
      let slot: unknown;
      reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      queueMicrotask(() => {
        stopped = provider[teardown](ref, context);
        if (next) {
          successor = provider.provision(request, context);
          slot = registry.get(ref.id);
        }
      });
      await expect(first).resolves.toMatchObject({
        message: "computer connection stopped during teardown",
      });
      await expect(second).resolves.toMatchObject({
        message: "computer connection stopped during teardown",
      });
      await stopped;
      expect(sdk.create).not.toHaveBeenCalled();
      expect(registry.size).toBe(next ? 1 : 0);
      if (next) {
        expect(registry.get(ref.id)).toBe(slot);
        connect({ sandboxId: "existing" } as Sandbox);
        await expect(successor).resolves.toMatchObject({ providerRef: "existing", fresh: false });
        await expect(provider.provision(request, context)).resolves.toMatchObject({
          providerRef: "existing",
          fresh: false,
        });
      }
      expect(sdk.connect).toHaveBeenCalledTimes((teardown === "destroy" ? 2 : 1) + (next ? 1 : 0));
      expect(registry.size).toBe(0);
    },
  );

  it.each<["stop" | "destroy", "success" | "gone"]>([
    ["stop", "success"],
    ["stop", "gone"],
    ["destroy", "success"],
    ["destroy", "gone"],
  ])(
    "rejects a joined recovery when explicit %s begins before its %s result",
    async (teardown, outcome) => {
      let reject!: (error: unknown) => void;
      const probe = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const old = { sandboxId: "existing", setTimeout: vi.fn().mockReturnValue(probe) };
      const current = {
        sandboxId: "existing",
        kill: vi.fn().mockResolvedValue(undefined),
      };
      let connect!: (desktop: Sandbox) => void;
      let rejectConnection!: (error: unknown) => void;
      const connection = new Promise<Sandbox>((resolve, fail) => {
        connect = resolve;
        rejectConnection = fail;
      });
      let connecting!: () => void;
      const started = new Promise<void>((resolve) => {
        connecting = resolve;
      });
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi
          .fn()
          .mockResolvedValueOnce(old)
          .mockImplementation(() => {
            connecting();
            return connection;
          }),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const request = {
        botId: "bot",
        homePath: "/unused",
        providerRef: "existing",
        providerKind: "e2b" as const,
      };
      const ref = await provider.provision(request, context);
      vi.mocked(sdk.connect).mockClear();
      vi.setSystemTime(Date.now() + 61_000);
      try {
        const first = provider.provision(request, context).catch((error: unknown) => error);
        const second = provider
          .readFile(ref, "saved.bin", context)
          .catch((error: unknown) => error);
        reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        await started;
        await Promise.resolve();
        await Promise.resolve();
        const stopped = provider[teardown](ref, context);
        if (outcome === "gone") {
          rejectConnection(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        } else connect(current as unknown as Sandbox);
        await stopped;
        await expect(first).resolves.toMatchObject({
          message: "computer connection stopped during teardown",
        });
        await expect(second).resolves.toMatchObject({
          message: "computer connection stopped during teardown",
        });
        expect(sdk.create).not.toHaveBeenCalled();
        expect((Reflect.get(provider, "computerOperations") as Map<string, unknown>).size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["stop", "destroy"] as const)(
    "keeps a successor connection when old recovery and %s finish later",
    async (teardown) => {
      let finishOld!: (desktop: Sandbox) => void;
      let finishLookup!: (desktop: Sandbox) => void;
      let finishCurrent!: (desktop: Sandbox) => void;
      const old = new Promise<Sandbox>((resolve) => {
        finishOld = resolve;
      });
      const lookup = new Promise<Sandbox>((resolve) => {
        finishLookup = resolve;
      });
      const connection = new Promise<Sandbox>((resolve) => {
        finishCurrent = resolve;
      });
      let finishPause!: () => void;
      const pause = new Promise<void>((resolve) => {
        finishPause = resolve;
      });
      const read = vi.fn().mockResolvedValue(new Uint8Array([1]));
      const current = { sandboxId: "existing", files: { read } } as unknown as Sandbox;
      const kill = vi.fn().mockResolvedValue(undefined);
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi.fn().mockReturnValueOnce(old),
        pause: vi.fn().mockReturnValue(pause),
      };
      if (teardown === "destroy") vi.mocked(sdk.connect).mockReturnValueOnce(lookup);
      vi.mocked(sdk.connect).mockReturnValueOnce(connection);
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const obsolete = provider
        .readFile(ref, "saved.bin", context)
        .catch((error: unknown) => error);
      const stopped = provider[teardown](ref, context);
      const successor = provider.readFile(ref, "saved.bin", context);
      const registry = Reflect.get(provider, "computerOperations") as Map<string, unknown>;
      const slot = registry.get(ref.id);
      finishOld({ sandboxId: "existing" } as Sandbox);
      await expect(obsolete).resolves.toMatchObject({
        message: "computer connection stopped during teardown",
      });
      expect(registry.get(ref.id)).toBe(slot);
      if (teardown === "destroy")
        finishLookup({ sandboxId: "existing", kill } as unknown as Sandbox);
      else finishPause();
      await stopped;
      expect(registry.get(ref.id)).toBe(slot);
      finishCurrent(current);
      await expect(successor).resolves.toEqual(new Uint8Array([1]));
      await expect(provider.readFile(ref, "saved.bin", context)).resolves.toEqual(
        new Uint8Array([1]),
      );
      expect(sdk.connect).toHaveBeenCalledTimes(teardown === "destroy" ? 3 : 2);
      expect(read).toHaveBeenCalledTimes(2);
      expect(sdk.create).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledTimes(teardown === "destroy" ? 1 : 0);
      expect(registry.size).toBe(0);
    },
  );

  it.each(["success", "transport", "gone"])(
    "does not renew a cold attendance attachment completing with %s after destroy",
    async (outcome) => {
      let attach!: (desktop: Sandbox) => void;
      let reject!: (error: unknown) => void;
      const attachment = new Promise<Sandbox>((resolve, fail) => {
        attach = resolve;
        reject = fail;
      });
      const desktop = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const kill = vi.fn().mockResolvedValue(undefined);
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi.fn().mockResolvedValue({ sandboxId: "existing", kill }),
        pause: vi.fn(),
        attachRunning: vi.fn().mockReturnValue(attachment),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
      const attendance = provider.keepAlive(ref, { onlyIfRunning: true });
      await provider.destroy(ref, context);
      if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
      else attach(desktop);
      await expect(attendance).resolves.toBeUndefined();
      expect(desktop.setTimeout).not.toHaveBeenCalled();
      expect((Reflect.get(provider, "computerOperations") as Map<string, unknown>).size).toBe(0);
      expect(sdk.connect).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledOnce();
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );

  it.each(["stop", "destroy"] as const)(
    "rejects concurrent stale probes after explicit %s instead of joining a new generation",
    async (teardown) => {
      let reject!: (error: unknown) => void;
      const probe = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const old = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockReturnValue(probe),
        pause: vi.fn().mockResolvedValue(undefined),
        kill: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        create: vi.fn(),
        connect: vi.fn().mockResolvedValue(old),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const request = {
        botId: "bot",
        homePath: "/unused",
        providerRef: "existing",
        providerKind: "e2b" as const,
      };
      const ref = await provider.provision(request, context);
      vi.mocked(sdk.connect).mockClear();
      vi.setSystemTime(Date.now() + 61_000);
      try {
        const first = provider.provision(request, context).catch((error: unknown) => error);
        const second = provider.provision(request, context).catch((error: unknown) => error);
        expect(old.setTimeout).toHaveBeenCalledTimes(2);
        await provider[teardown](ref, context);
        reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        await expect(first).resolves.toMatchObject({
          message: "computer connection stopped during teardown",
        });
        await expect(second).resolves.toMatchObject({
          message: "computer connection stopped during teardown",
        });
        expect(sdk.connect).not.toHaveBeenCalled();
        expect(sdk.create).not.toHaveBeenCalled();
        expect((Reflect.get(provider, "computerOperations") as Map<string, unknown>).size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each<[string, string]>([
    ["gone", "pending"],
    ["success", "pending"],
    ["transport", "pending"],
    ["gone", "cached"],
    ["success", "cached"],
    ["transport", "cached"],
  ])("joins concurrent recovery after stale probe %s with successor %s", async (outcome, state) => {
    let firstGone!: (error: unknown) => void;
    const firstProbe = new Promise<void>((_resolve, reject) => {
      firstGone = reject;
    });
    let finish!: () => void;
    let reject!: (error: unknown) => void;
    const secondProbe = new Promise<void>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    const old = {
      sandboxId: "existing",
      setTimeout: vi.fn().mockReturnValueOnce(firstProbe).mockReturnValueOnce(secondProbe),
    } as unknown as Sandbox;
    const current = { sandboxId: "existing", setTimeout: vi.fn().mockResolvedValue(undefined) };
    let connect!: (desktop: Sandbox) => void;
    const connection = new Promise<Sandbox>((resolve) => {
      connect = resolve;
    });
    let connecting!: () => void;
    const started = new Promise<void>((resolve) => {
      connecting = resolve;
    });
    const sdk: E2BSandboxSdk = {
      create: vi.fn(),
      connect: vi
        .fn()
        .mockResolvedValueOnce(old)
        .mockImplementation(() => {
          connecting();
          return connection;
        }),
      pause: vi.fn(),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const request = {
      botId: "bot",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "e2b" as const,
    };
    await provider.provision(request, context);
    vi.mocked(sdk.connect).mockClear();
    vi.setSystemTime(Date.now() + 61_000);
    try {
      const first = provider.provision(request, context).catch((error: unknown) => error);
      const second = provider.provision(request, context).catch((error: unknown) => error);
      expect(old.setTimeout).toHaveBeenCalledTimes(2);
      firstGone(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      await started;
      if (state === "cached") {
        connect(current as unknown as Sandbox);
        await expect(first).resolves.toMatchObject({ providerRef: "existing", fresh: false });
      }
      if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
      else finish();
      if (state === "pending") {
        await Promise.resolve();
        await Promise.resolve();
        connect(current as unknown as Sandbox);
      }
      await expect(first).resolves.toMatchObject({ providerRef: "existing", fresh: false });
      await expect(second).resolves.toMatchObject({ providerRef: "existing", fresh: false });
      expect(sdk.connect).toHaveBeenCalledOnce();
      expect(sdk.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["pending", "connected"])(
    "does not recover an old Gone after its successor connection is %s",
    async (state) => {
      let reject!: (error: unknown) => void;
      const old = new Promise<Sandbox>((_resolve, fail) => {
        reject = fail;
      });
      let connect!: (desktop: Sandbox) => void;
      const next = new Promise<Sandbox>((resolve) => {
        connect = resolve;
      });
      const current = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        connect: vi.fn().mockReturnValueOnce(old).mockReturnValue(next),
        create: vi.fn().mockResolvedValue({ sandboxId: "unexpected" }),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const request = {
        botId: "bot",
        homePath: "/unused",
        providerKind: "e2b" as const,
        providerRef: "existing",
      };
      const superseded = provider.provision(request, context).catch((error: unknown) => error);
      reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
      // Let the SDK rejection handler and connection cleanup run before its successor.
      await Promise.resolve();
      await Promise.resolve();
      const successor = provider.provision(request, context).catch((error: unknown) => error);
      expect(sdk.connect).toHaveBeenCalledTimes(2);
      if (state === "connected") connect(current);
      await expect(superseded).resolves.toMatchObject({
        message: "computer connection stopped during teardown",
      });
      if (state === "pending") connect(current);
      await expect(successor).resolves.toMatchObject({ providerRef: "existing", fresh: false });
      await provider.keepAlive({
        id: "existing",
        providerRef: "existing",
        botId: "bot",
        kind: "e2b",
      });
      expect(current.setTimeout).toHaveBeenCalledOnce();
      expect(sdk.connect).toHaveBeenCalledTimes(2);
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "transport", "gone"])(
    "does not let a cached heartbeat completing with %s affect its replacement",
    async (outcome) => {
      let complete!: () => void;
      let reject!: (error: unknown) => void;
      const renewal = new Promise<void>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      });
      const old = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockReturnValue(renewal),
        pause: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      const current = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
        files: { read },
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        create: vi.fn().mockResolvedValue(old),
        connect: vi.fn().mockResolvedValue(current),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
      const heartbeat = provider.keepAlive(ref);
      await vi.waitFor(() => expect(old.setTimeout).toHaveBeenCalledOnce());
      await provider.stop(ref, context);
      await provider.provision(
        {
          botId: "bot",
          homePath: "/unused",
          providerRef: ref.providerRef,
          providerKind: "e2b",
        },
        context,
      );
      vi.setSystemTime(Date.now() + 61_000);
      try {
        if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
        else complete();
        await heartbeat;
        await expect(provider.readFile(ref, "saved.bin", context)).resolves.toEqual(
          new Uint8Array([1, 2, 3]),
        );
        expect(sdk.connect).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledOnce();
        expect(current.setTimeout).toHaveBeenCalledOnce();
        expect(sdk.create).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["success", "transport", "gone"])(
    "rejects a cached handle probe completing with %s after teardown",
    async (outcome) => {
      let complete!: () => void;
      let reject!: (error: unknown) => void;
      const probe = new Promise<void>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      });
      const old = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockReturnValue(probe),
        pause: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const current = {
        sandboxId: "existing",
        setTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Sandbox;
      const sdk: E2BSandboxSdk = {
        create: vi.fn().mockResolvedValue(old),
        connect: vi.fn().mockResolvedValue(current),
        pause: vi.fn().mockResolvedValue(undefined),
      };
      const provider = new E2BSandboxProvider("test-key", sdk);
      const ref = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
      vi.setSystemTime(Date.now() + 61_000);
      try {
        const request = {
          botId: "bot",
          homePath: "/unused",
          providerKind: "e2b" as const,
          providerRef: ref.providerRef,
        };
        const superseded = provider.provision(request, context).catch((error: unknown) => error);
        expect(old.setTimeout).toHaveBeenCalledOnce();
        await provider.stop(ref, context);
        await provider.provision(request, context);
        if (outcome === "gone") reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        else if (outcome === "transport") reject(new Error("Synthetic transport unavailable"));
        else complete();
        await expect(superseded).resolves.toMatchObject({
          message: "computer connection stopped during teardown",
        });
        await provider.keepAlive(ref);
        expect(sdk.connect).toHaveBeenCalledOnce();
        expect(sdk.create).toHaveBeenCalledOnce();
        expect(current.setTimeout).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects a late lost connection after teardown without replacing the current computer", async () => {
    let reject!: (error: unknown) => void;
    const old = new Promise<Sandbox>((_resolve, fail) => {
      reject = fail;
    });
    const current = {
      sandboxId: "existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      connect: vi.fn().mockReturnValueOnce(old).mockResolvedValue(current),
      create: vi.fn().mockResolvedValue({ sandboxId: "unexpected" }),
      pause: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const request = {
      botId: "bot",
      homePath: "/unused",
      providerKind: "e2b" as const,
      providerRef: "existing",
    };
    const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
    const superseded = provider.provision(request, context).catch((error: unknown) => error);
    await provider.stop(ref, context);
    await provider.provision(request, context);
    reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
    await expect(superseded).resolves.toMatchObject({
      message: "computer connection stopped during teardown",
    });
    await provider.keepAlive(ref);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
    expect(current.setTimeout).toHaveBeenCalledOnce();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("preserves a newer cached handle when an older provision is invalidated by teardown", async () => {
    let release!: (desktop: Sandbox) => void;
    const old = new Promise<Sandbox>((resolve) => {
      release = resolve;
    });
    const current = {
      sandboxId: "existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      connect: vi.fn().mockReturnValueOnce(old).mockResolvedValue(current),
      create: vi.fn(),
      pause: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const request = {
      botId: "bot",
      homePath: "/unused",
      providerKind: "e2b" as const,
      providerRef: "existing",
    };
    const ref = { id: "existing", providerRef: "existing", botId: "bot", kind: "e2b" as const };
    const superseded = provider.provision(request, context).catch((error: unknown) => error);
    await provider.stop(ref, context);
    await provider.provision(request, context);
    release({ sandboxId: "existing" } as Sandbox);
    await expect(superseded).resolves.toBeInstanceOf(Error);
    await provider.keepAlive(ref);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
    expect(current.setTimeout).toHaveBeenCalledOnce();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  // Wordings verified against @e2b/desktop 2.4.0 (e2b 2.49.1 dist).
  const gone = [
    new TimeoutError(
      "502: This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
    ),
    new SandboxNotFoundError("Sandbox is probably not running anymore"),
    new TimeoutError(
      "stream reset: The sandbox was killed or reached its end of life while the request was in flight.",
    ),
    new SandboxNotFoundError("Paused sandbox sandbox-ref-1 not found"),
    // The SDK error class must also identify loss when the API supplies a different message.
    new SandboxNotFoundError("Unavailable"),
  ];
  const alive = [
    new Error("bash: x11vnc: command not found"),
    new Error("Path /home/user/rakazo-home/notes.md not found"),
    new Error("tar: /home/user/x: No such file or directory"),
    new TimeoutError(
      "canceled: This error is likely due to exceeding 'requestTimeoutMs'. You can pass the request timeout value as an option when making the request.",
    ),
    Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
  ];

  it("recognises every sandbox-gone wording", () => {
    for (const error of gone) {
      expect(isSandboxGoneError(error), error.message).toBe(true);
    }
  });

  it("never reads a live sandbox as gone", () => {
    for (const error of alive) {
      expect(isSandboxGoneError(error), error.message).toBe(false);
    }
  });

  it("does not interpret a transport failure as sandbox loss", () => {
    expect(isSandboxGoneError(new Error("fetch failed"))).toBe(false);
  });

  it("terminates on a cyclic error cause instead of treating a transport failure as Gone", () => {
    const error = new Error("fetch failed");
    error.cause = error;
    let visits = 0;
    Object.defineProperty(error, "name", {
      get: () => {
        if (++visits > 5) throw new Error("Cause traversal did not terminate");
        return "Error";
      },
    });
    expect(isSandboxGoneError(error)).toBe(false);
  });

  it.each(gone)("drops a cached handle and reconnects after %s", async (error) => {
    const dead = {
      sandboxId: "box-1",
      setTimeout: vi.fn(async () => {
        throw error;
      }),
    } as unknown as Sandbox;
    const revived = { sandboxId: "box-1", setTimeout: vi.fn(async () => undefined) };
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => dead),
      connect: vi.fn(async () => revived as unknown as Sandbox),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const ref = await provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
    expect(ref.providerRef).toBe("box-1");

    vi.setSystemTime(Date.now() + 61_000);
    try {
      await provider.keepAlive?.(ref);
    } finally {
      vi.useRealTimers();
    }
    expect(dead.setTimeout).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });

  it("forgets a dead handle on keepAlive before the 60s probe threshold", async () => {
    const dead = {
      sandboxId: "box-1",
      setTimeout: vi.fn(async () => {
        throw new TimeoutError("502: This error is likely due to sandbox timeout.");
      }),
    } as unknown as Sandbox;
    const revived = { sandboxId: "box-1", setTimeout: vi.fn(async () => undefined) };
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => dead),
      connect: vi.fn(async () => revived as unknown as Sandbox),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const ref = await provider.provision({ botId: "bot-1", homePath: "/unused" }, context);

    // Still inside box()'s 60s cache window — keepAlive must not refresh lastTouchedAt
    // on a gone sandbox, or subsequent heartbeats would keep serving the dead handle.
    await provider.keepAlive?.(ref);
    expect(dead.setTimeout).toHaveBeenCalledTimes(1);
    expect(sdk.connect).not.toHaveBeenCalled();

    await provider.keepAlive?.(ref);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(revived.setTimeout).toHaveBeenCalledTimes(1);
  });
});

function _unwrapSetupCommand(command: string): string {
  return command.startsWith("bash -c '") ? command.slice(9, -1).replaceAll(`'"'"'`, "'") : command;
}
