import type { McpServer } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpManagement,
  emptyMcpServerDraft,
  initialMcpManagementState,
  mcpServerInput,
} from "./mcp-management.js";

const draft = {
  ...emptyMcpServerDraft(),
  name: "Fixture",
  endpoint: "https://tools.example.test/mcp",
};
const server = { id: "one", slug: "fixture", name: "Fixture", revision: 1 } as McpServer;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let state = initialMcpManagementState();
  let live = true;
  const request = vi.fn().mockResolvedValue([]);
  const manager = createMcpManagement({
    request,
    isCurrent: () => live,
    changed: (value) => {
      state = value;
    },
  });
  return {
    manager,
    request,
    state: () => state,
    leave: () => {
      live = false;
      manager.dispose();
    },
  };
}
describe("MCP management", () => {
  it.each(["streamable_http", "sse", "stdio"] as const)(
    "maps the web creation fields for %s without executing commands",
    (transport) => {
      const input = mcpServerInput({
        ...draft,
        transport,
        command: " fixture ",
        args: "--stdio  --safe",
        secret: "synthetic",
        headerValue: "fixture",
        verbatimResults: true,
      });
      expect(input).toMatchObject({
        transport,
        secret: "synthetic",
        verbatimResults: true,
        enabled: true,
      });
      expect(input).toMatchObject(
        transport === "stdio"
          ? { command: "fixture", args: ["--stdio", "--safe"], env: {} }
          : { endpoint: draft.endpoint, headers: { Authorization: "fixture" } },
      );
    },
  );
  it("locks writes until a successful read and lets a new read supersede an unresolved one", async () => {
    const x = setup();
    const old = deferred<McpServer[]>();
    const next = deferred<McpServer[]>();
    x.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const a = x.manager.refresh();
    const b = x.manager.refresh();
    old.resolve([server]);
    await a;
    expect(x.state().loading).toBe(true);
    await x.manager.create(draft);
    expect(x.request).toHaveBeenCalledTimes(2);
    next.resolve([]);
    await b;
    expect(x.state().fresh).toBe(true);
    expect(x.state().servers).toEqual([]);
  });
  it("does not let an old read's failure release the new read lock", async () => {
    const x = setup();
    const old = deferred<McpServer[]>();
    const next = deferred<McpServer[]>();
    x.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const a = x.manager.refresh();
    const b = x.manager.refresh();
    old.reject(new Error("late"));
    await a;
    expect(x.state()).toMatchObject({ loading: true, error: null, fresh: false });
    next.resolve([]);
    await b;
  });
  it("recovers a committed create with lost response by slug instead of creating twice", async () => {
    const x = setup();
    await x.manager.refresh();
    x.request.mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce([server]);
    await x.manager.create(draft);
    expect(x.state()).toMatchObject({ pendingCreate: false, recovered: server, error: null });
    expect(x.request.mock.calls.filter(([p]) => p === "mcp/servers/create")).toHaveLength(1);
  });
  it("retains the submitted identity and payload across absence and retries, including non-Latin names", async () => {
    const x = setup();
    await x.manager.refresh();
    x.request.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce([]);
    await x.manager.create({ ...draft, name: "服务" });
    const first = x.request.mock.calls.find(([p]) => p.endsWith("create"))![1];
    expect(x.state().pendingCreate).toBe(true);
    x.request.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce([]);
    await x.manager.create({ ...draft, name: "Different" });
    expect(x.request.mock.calls.filter(([p]) => p.endsWith("create"))[1]![1]).toEqual(first);
  });
  it("locks all writes after post-commit refresh failure until Retry recovers the identity", async () => {
    const x = setup();
    await x.manager.refresh();
    x.request.mockResolvedValueOnce(server).mockRejectedValueOnce(new Error("read"));
    await x.manager.create(draft);
    expect(x.state()).toMatchObject({ fresh: false, error: "read", pendingCreate: true });
    const count = x.request.mock.calls.length;
    await x.manager.create(draft);
    await x.manager.write("mcp/servers/remove", { id: "one" });
    expect(x.request).toHaveBeenCalledTimes(count);
    x.request.mockResolvedValueOnce([server]);
    await x.manager.refresh();
    expect(x.state().recovered).toEqual(server);
  });
  it.each([400, 401, 403, 422])(
    "allows correcting input after a definitive %s rejection",
    async (status) => {
      const x = setup();
      await x.manager.refresh();
      x.request
        .mockRejectedValueOnce(Object.assign(new Error("denied"), { status }))
        .mockResolvedValueOnce([]);
      await x.manager.create(draft);
      expect(x.state()).toMatchObject({ pendingCreate: false, error: "write" });
    },
  );
  it("does not recover a pre-existing duplicate as a successful create", async () => {
    const x = setup();
    x.request.mockResolvedValueOnce([server]);
    await x.manager.refresh();
    x.request.mockRejectedValueOnce(new Error("duplicate")).mockResolvedValueOnce([server]);
    await x.manager.create(draft);
    expect(x.state().recovered).toBeNull();
    expect(x.state().error).toBe("write");
  });
  it.each([{ name: "" }, { endpoint: "wrong" }, { transport: "stdio" as const, command: "" }])(
    "rejects invalid fields without retaining a pending identity",
    async (change) => {
      const x = setup();
      await x.manager.refresh();
      await x.manager.create({ ...draft, ...change });
      expect(x.request).toHaveBeenCalledTimes(1);
      expect(x.state()).toMatchObject({ error: "invalid", pendingCreate: false });
    },
  );
  it("ignores write completion after disposal and aborts its request", async () => {
    const x = setup();
    await x.manager.refresh();
    const pending = deferred<McpServer>();
    x.request.mockReturnValueOnce(pending.promise);
    const write = x.manager.write("mcp/servers/setTools", { id: "one", revision: 1 });
    const signal = x.request.mock.calls.at(-1)![2];
    x.leave();
    pending.resolve(server);
    expect(await write).toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(x.request).toHaveBeenCalledTimes(2);
  });
});
