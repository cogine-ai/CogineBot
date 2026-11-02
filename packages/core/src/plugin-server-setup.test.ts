import type { McpServer, PluginServerConnectionInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PluginServerAuthorizationResult } from "./plugin-server-setup.js";
import { createPluginServerSetup, initialPluginServerSetup } from "./plugin-server-setup.js";

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "owned-child",
    spaceId: "space",
    slug: "research",
    name: "Research",
    description: "",
    transport: "streamable_http",
    endpoint: "https://research.example.test/mcp",
    command: null,
    args: [],
    envKeys: [],
    headerKeys: ["Authorization"],
    hasSecret: true,
    oauthStatus: "none",
    enabled: false,
    allowAllTools: false,
    allowedTools: [],
    revision: 2,
    createdAt: "2026-11-02T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let current = true;
  let state = initialPluginServerSetup;
  const list = vi.fn(async (_signal: AbortSignal) => [server()]);
  const save = vi.fn(async (_input: PluginServerConnectionInput, _signal: AbortSignal) =>
    server({ enabled: true, revision: 3 }),
  );
  const authorize = vi.fn(
    async (_id: string, _signal: AbortSignal): Promise<PluginServerAuthorizationResult> =>
      "returned",
  );
  const changed = vi.fn((next: typeof state) => {
    state = next;
  });
  const manager = createPluginServerSetup({
    serverId: "owned-child",
    list,
    save,
    authorize,
    isCurrent: () => current,
    changed,
  });
  return {
    manager,
    list,
    save,
    authorize,
    changed,
    state: () => state,
    leave: () => {
      current = false;
    },
  };
}

describe("owned plugin server connection review", () => {
  it("reads an unknown credential status before starting a new authorization", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce([server({ enabled: true, oauthStatus: "unknown" })]);
    await f.manager.refresh();
    await f.manager.connectOAuth();
    expect(f.authorize).not.toHaveBeenCalled();
    f.list.mockResolvedValueOnce([server({ enabled: true, oauthStatus: "none" })]);
    await f.manager.refresh();
    await f.manager.connectOAuth();
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });
  it("reads only the exact child and never enables or authorizes it implicitly", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce([server({ id: "other-child", enabled: true }), server()]);
    await f.manager.refresh();
    await f.manager.connectOAuth();
    expect(f.state().server?.id).toBe("owned-child");
    expect(f.save).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("submits only the explicit connection patch and the reviewed revision", async () => {
    const f = fixture();
    await f.manager.refresh();
    await f.manager.saveConnection({
      enabled: true,
      headerUpdates: { "X-API-Key": "synthetic-value" },
    });
    expect(f.save.mock.calls[0]?.[0]).toEqual({
      id: "owned-child",
      connection: { revision: 2, enabled: true, headerUpdates: { "X-API-Key": "synthetic-value" } },
    });
    expect(JSON.stringify(f.state())).not.toContain("synthetic-value");
    expect(f.state().server?.allowAllTools).toBe(false);
  });
  it("does not replay a save after lost acknowledgement until a fresh read", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.save.mockRejectedValueOnce(new Error("lost response"));
    await f.manager.saveConnection({ enabled: true });
    await f.manager.saveConnection({ enabled: true });
    await f.manager.connectOAuth();
    expect(f.state().phase).toBe("unknown");
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.authorize).not.toHaveBeenCalled();
    f.list.mockResolvedValueOnce([server({ enabled: true, revision: 7 })]);
    await f.manager.refresh();
    await f.manager.saveConnection({ enabled: false });
    expect(f.save.mock.calls[1]?.[0]).toMatchObject({
      connection: { revision: 7, enabled: false },
    });
  });
  it("does not adopt a response for a different server", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.save.mockResolvedValueOnce(server({ id: "other-child", enabled: true }));
    await f.manager.saveConnection({ enabled: true });
    expect(f.state().phase).toBe("unknown");
    expect(f.state().server?.id).toBe("owned-child");
  });
  it("holds duplicate save and OAuth actions while a save is running", async () => {
    const f = fixture();
    const pending = deferred<McpServer>();
    await f.manager.refresh();
    f.save.mockReturnValueOnce(pending.promise);
    const one = f.manager.saveConnection({ enabled: true });
    await f.manager.saveConnection({ enabled: false });
    await f.manager.connectOAuth();
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.authorize).not.toHaveBeenCalled();
    pending.resolve(server({ enabled: true, revision: 3 }));
    await one;
  });
  it.each([
    "returned",
    "pending",
    "cancelled",
    "already_connected",
    "authorization_not_requested",
  ] as const)("requires exact-server readback after OAuth result %s", async (result) => {
    const f = fixture();
    f.list.mockResolvedValue([server({ enabled: true })]);
    f.authorize.mockResolvedValueOnce(result);
    await f.manager.refresh();
    await f.manager.connectOAuth();
    expect(f.state().server?.oauthStatus).toBe("none");
    expect(f.state().authorizationResult).toBe(result);
    expect(f.state().phase).toBe(
      result === "authorization_not_requested" ? "ready" : "authorization_pending",
    );
    expect(f.list).toHaveBeenCalledTimes(2);
    await f.manager.connectOAuth();
    expect(f.authorize).toHaveBeenCalledTimes(result === "authorization_not_requested" ? 2 : 1);
  });
  it("shows backend-confirmed connection and keeps tool sharing separate", async () => {
    const f = fixture();
    f.list
      .mockResolvedValueOnce([server({ enabled: true })])
      .mockResolvedValueOnce([server({ enabled: true, oauthStatus: "connected", revision: 3 })]);
    await f.manager.refresh();
    await f.manager.connectOAuth();
    expect(f.state()).toMatchObject({
      phase: "ready",
      server: { oauthStatus: "connected", allowAllTools: false, allowedTools: [] },
    });
    expect(f.save).not.toHaveBeenCalled();
  });
  it("does not claim success when callback readback fails or the child disappears", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce([server({ enabled: true })]).mockResolvedValueOnce([]);
    await f.manager.refresh();
    await f.manager.connectOAuth();
    expect(f.state().phase).toBe("authorization_pending");
    expect(f.state().server?.oauthStatus).toBe("none");
    await f.manager.connectOAuth();
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });
  it("takes a late save behind a newer authoritative refresh out of circulation", async () => {
    const f = fixture();
    const pending = deferred<McpServer>();
    await f.manager.refresh();
    f.save.mockReturnValueOnce(pending.promise);
    const saving = f.manager.saveConnection({ enabled: true });
    f.list.mockResolvedValueOnce([server({ revision: 8, enabled: false })]);
    await f.manager.refresh();
    pending.resolve(server({ revision: 3, enabled: true }));
    await saving;
    expect(f.state().server).toMatchObject({ revision: 8, enabled: false });
  });
  it.each(["scope", "dispose"])(
    "never starts or applies a readback after %s changes",
    async (reason) => {
      const f = fixture();
      const pending = deferred<PluginServerAuthorizationResult>();
      f.list.mockResolvedValue([server({ enabled: true })]);
      f.authorize.mockReturnValueOnce(pending.promise);
      await f.manager.refresh();
      const task = f.manager.connectOAuth();
      if (reason === "scope") f.leave();
      else f.manager.dispose();
      const notifications = f.changed.mock.calls.length;
      pending.resolve("returned");
      await task;
      await f.manager.refresh();
      expect(f.list).toHaveBeenCalledTimes(1);
      expect(f.changed).toHaveBeenCalledTimes(notifications);
    },
  );
  it("removes an unavailable child from the usable form after refresh", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.list.mockResolvedValueOnce([]);
    await f.manager.refresh();
    await f.manager.saveConnection({ enabled: true });
    expect(f.state()).toMatchObject({ phase: "error", server: null });
    expect(f.save).not.toHaveBeenCalled();
  });
});
