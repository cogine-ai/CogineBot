import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSpaceSelection,
  createSpaceRpc,
  currentRpcSessionGeneration,
  currentSpaceSelectionGeneration,
  rememberImplicitRpcSpace,
  rpc,
  rpcForSpace,
  selectedSpaceId,
  selectSpace,
  subscribeSubscriptionRequired,
  synchronizeRpcSession,
} from "./rpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("space selection storage", () => {
  it("reports localStorage write failures without throwing", () => {
    const localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(false);
    expect(() => clearSpaceSelection()).not.toThrow();
    expect(selectedSpaceId()).toBeNull();
  });

  it("treats an already-persisted selection as success when writes fail", () => {
    const localStorage = {
      getItem: (key: string) => (key === "rakazo:space-id" ? "space-support" : null),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(selectSpace("space-other")).toBe(false);
  });

  it("reports when a space selection was persisted", () => {
    const setItem = vi.fn();
    const localStorage = { getItem: () => null, setItem, removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("rakazo:space-id", "space-support");
  });
});

it("advances the selection generation across A to B to A and logout", () => {
  const stored = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  };
  vi.stubGlobal("window", { localStorage });
  const initial = currentSpaceSelectionGeneration();
  expect(selectSpace("space-a")).toBe(true);
  expect(selectSpace("space-b")).toBe(true);
  expect(selectSpace("space-a")).toBe(true);
  expect(selectedSpaceId()).toBe("space-a");
  expect(currentSpaceSelectionGeneration()).toBe(initial + 3);
  clearSpaceSelection();
  expect(selectedSpaceId()).toBeNull();
  expect(currentSpaceSelectionGeneration()).toBe(initial + 4);
});

describe("settings RPC target attribution", () => {
  function setup() {
    const stored = new Map([["rakazo:space-id", "space-a"]]);
    const localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", {
      localStorage,
      location: { origin: "https://example.test", pathname: "/app" },
    });
    const fetch = vi.fn(async (_request: Request, _init?: RequestInit) =>
      Response.json({ json: {} }),
    );
    vi.stubGlobal("fetch", fetch);
    return {
      stored,
      localStorage,
      fetch,
      spaces: () =>
        fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("x-rakazo-space-id")),
    };
  }
  it("edits its explicit target without changing the selected conversation", async () => {
    const h = setup();
    await rpcForSpace("space-b").me();
    await rpc.me();
    expect(h.spaces()).toEqual(["space-b", "space-a"]);
    expect(h.localStorage.setItem).not.toHaveBeenCalled();
  });
  it("keeps captured target, explicit override and abort signal through async followups", async () => {
    const h = setup();
    const controller = new AbortController();
    const client = createSpaceRpc("space-b");
    await client.me(undefined, { signal: controller.signal });
    h.stored.set("rakazo:space-id", "space-c");
    await client.me();
    await client.me(undefined, { context: { spaceId: "space-d" } });
    await client.me(undefined, { context: { spaceId: null } });
    expect(h.spaces()).toEqual(["space-b", "space-b", "space-d", null]);
    expect(h.fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
  it("does not dispatch a retained client after its settings owner expires", async () => {
    const h = setup();
    let current = true;
    const client = createSpaceRpc("space-b", () => current);
    await client.me();
    current = false;
    await expect(client.me()).rejects.toThrow();
    expect(h.spaces()).toEqual(["space-b"]);
  });
});

describe("subscription-denial ownership", () => {
  function setup() {
    const stored = new Map([["rakazo:space-id", "space-a"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      location: { origin: "https://example.test", pathname: "/app" },
    });
  }
  function denied() {
    return Response.json(
      {
        json: {
          defined: false,
          code: "PAYMENT_REQUIRED",
          status: 402,
          message: "Subscription required",
          data: { reason: "subscription_required" },
        },
      },
      { status: 402 },
    );
  }
  it("notifies current selection denial while preserving the exact RPC error", async () => {
    setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => denied()),
    );
    const listener = vi.fn();
    const stop = subscribeSubscriptionRequired(listener);
    try {
      await expect(rpc.me()).rejects.toMatchObject({ status: 402, code: "PAYMENT_REQUIRED" });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
  it("does not let a throwing observer replace the server's response", async () => {
    setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => denied()),
    );
    const stop = subscribeSubscriptionRequired(() => {
      throw new Error("observer");
    });
    try {
      await expect(rpc.me()).rejects.toMatchObject({ status: 402 });
    } finally {
      stop();
    }
  });
  it("ignores a late denial after the selection moves A to B to A", async () => {
    setup();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((yes) => {
            resolve = yes;
          }),
      ),
    );
    const listener = vi.fn();
    const stop = subscribeSubscriptionRequired(listener);
    const request = rpc.me();
    const rejection = expect(request).rejects.toMatchObject({ status: 402 });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    selectSpace("space-b");
    selectSpace("space-a");
    resolve(denied());
    await rejection;
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
  it("does not project a settings target's denial onto a different selected Space", async () => {
    setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => denied()),
    );
    const listener = vi.fn();
    const stop = subscribeSubscriptionRequired(listener);
    try {
      await expect(createSpaceRpc("space-b").me()).rejects.toMatchObject({ status: 402 });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe("account and implicit-Space recovery ownership", () => {
  function setup(space: string | null) {
    const stored = new Map<string, string>(space ? [["rakazo:space-id", space]] : []);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      location: { origin: "https://example.test", pathname: "/app" },
    });
  }
  function denied() {
    return Response.json(
      {
        json: {
          defined: false,
          code: "PAYMENT_REQUIRED",
          status: 402,
          message: "Subscription required",
        },
      },
      { status: 402 },
    );
  }
  it.each(["account", "session", "account-ABA"])(
    "does not notify a replacement %s owner from an older actual request",
    async (kind) => {
      setup("space-shared");
      synchronizeRpcSession("authenticated", "account-a", "session-a");
      let resolve!: (response: Response) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((yes) => {
            resolve = yes;
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const old = vi.fn();
      const stopOld = subscribeSubscriptionRequired(old);
      const request = rpc.me();
      const failed = expect(request).rejects.toMatchObject({ status: 402 });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      stopOld();
      if (kind === "session") synchronizeRpcSession("authenticated", "account-a", "session-new");
      else {
        synchronizeRpcSession("authenticated", "account-b", "session-b");
        if (kind === "account-ABA")
          synchronizeRpcSession("authenticated", "account-a", "session-a");
      }
      const replacement = vi.fn();
      const stop = subscribeSubscriptionRequired(replacement);
      resolve(denied());
      await failed;
      expect(old).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      stop();
    },
  );
  it("recognizes the verified default Space when Shell sends its explicit id", async () => {
    setup(null);
    synchronizeRpcSession("authenticated", "account-default", "session-default");
    rememberImplicitRpcSpace(
      "space-default",
      currentRpcSessionGeneration(),
      currentSpaceSelectionGeneration(),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => denied()),
    );
    const listener = vi.fn();
    const stop = subscribeSubscriptionRequired(listener);
    try {
      await expect(
        rpc.threads.send(
          { botId: "bot-fake", text: "hello" },
          { context: { spaceId: "space-default" } },
        ),
      ).rejects.toMatchObject({ status: 402 });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
  it("does not treat another explicit target as the default or retain its binding across accounts", async () => {
    setup(null);
    synchronizeRpcSession("authenticated", "account-default", "session-default");
    rememberImplicitRpcSpace(
      "space-default",
      currentRpcSessionGeneration(),
      currentSpaceSelectionGeneration(),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => denied()),
    );
    const listener = vi.fn();
    const stop = subscribeSubscriptionRequired(listener);
    try {
      await expect(createSpaceRpc("space-other").me()).rejects.toMatchObject({ status: 402 });
      synchronizeRpcSession("authenticated", "account-other", "session-other");
      await expect(createSpaceRpc("space-default").me()).rejects.toMatchObject({ status: 402 });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
