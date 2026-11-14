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
  const requestId = "00000000-0000-4000-8000-000000000001";
  let receipt: { requestId: string; serverId: string | null } | null = null;
  const wire = vi.fn(async (procedure: string, input: unknown, signal: AbortSignal) => {
    if (procedure === "mcp/servers/newCreateRequest") return { requestId };
    if (procedure === "mcp/servers/creation") return receipt;
    if (procedure === "mcp/servers/cancelCreate") {
      receipt ??= { requestId, serverId: null };
      return receipt;
    }
    if (procedure === "mcp/servers/createOnce") {
      const row = await request(
        "mcp/servers/create",
        (input as { config: unknown }).config,
        signal,
      );
      receipt = { requestId, serverId: row.id };
      return receipt;
    }
    return request(procedure, input, signal);
  });
  const manager = createMcpManagement({
    request: wire as never,
    isCurrent: () => live,
    changed: (value) => {
      state = value;
    },
  });
  return {
    manager,
    request,
    wire,
    committed: (serverId: string) => {
      receipt = { requestId, serverId };
    },
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
  it("recovers a committed create with lost response by request receipt instead of creating twice", async () => {
    const x = setup();
    await x.manager.refresh();
    x.committed(server.id);
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

describe("independent acceptance regressions", () => {
  it.each(["conflict", "acknowledged", "lost-response"])(
    "never adopts a same-slug replacement after %s",
    async (outcome) => {
      const x = setup();
      await x.manager.refresh();
      const replacement = {
        ...server,
        id: "replacement",
        endpoint: "https://other.example.test/mcp",
        transport: "sse",
      };
      if (outcome === "lost-response") x.committed(server.id);
      if (outcome === "acknowledged") x.request.mockResolvedValueOnce(server);
      else
        x.request.mockRejectedValueOnce(
          Object.assign(new Error("uncertain"), {
            status: outcome === "conflict" ? 409 : undefined,
          }),
        );
      x.request.mockResolvedValueOnce([replacement]);
      await x.manager.create(draft);
      expect(x.state().recovered).toBeNull();
    },
  );
  it.each([400, 401, 403, 422])(
    "allows correcting a draft after uncertain send then definitive %s rejection only through a server fence",
    async (status) => {
      const x = setup();
      await x.manager.refresh();
      x.request.mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce([]);
      await x.manager.create(draft);
      x.request
        .mockRejectedValueOnce(Object.assign(new Error("denied"), { status }))
        .mockResolvedValueOnce([]);
      await x.manager.create(draft);
      expect(x.state().pendingCreate).toBe(false);
      expect(draft.name).toBe("Fixture");
    },
  );
});

describe("durable creation cancellation", () => {
  it("does not unlock an uncertain request when its rejection fence fails", async () => {
    const x = setup();
    await x.manager.refresh();
    x.request.mockRejectedValueOnce(new Error("lost send")).mockResolvedValueOnce([]);
    await x.manager.create(draft);
    const wire = x.wire.getMockImplementation()!;
    x.wire.mockImplementation(async (procedure, input, signal) => {
      if (procedure === "mcp/servers/cancelCreate") throw new Error("fence unavailable");
      return wire(procedure, input, signal);
    });
    x.request
      .mockRejectedValueOnce(Object.assign(new Error("rejected"), { status: 400 }))
      .mockResolvedValueOnce([]);
    await x.manager.create(draft);
    expect(x.state()).toMatchObject({ pendingCreate: true, recovered: null });
    await x.manager.write("mcp/servers/remove", { id: "other" });
    expect(x.request.mock.calls.some(([procedure]) => procedure === "mcp/servers/remove")).toBe(
      false,
    );
  });
  it("can fence cancellation while list recovery fails and keeps writes locked until a new read succeeds", async () => {
    const x = setup();
    await x.manager.refresh();
    x.request
      .mockRejectedValueOnce(new Error("lost send"))
      .mockRejectedValueOnce(new Error("list unavailable"));
    await x.manager.create(draft);
    expect(x.state()).toMatchObject({ pendingCreate: true, fresh: false });
    x.request.mockRejectedValueOnce(new Error("list still unavailable"));
    await x.manager.cancelCreate();
    expect(x.state()).toMatchObject({ pendingCreate: false, fresh: false, error: "read" });
    await x.manager.refresh();
    expect(x.state()).toMatchObject({ pendingCreate: false, fresh: true });
    expect(draft.name).toBe("Fixture");
  });
  it("recovers an earlier commit when a later invocation is rejected instead of canceling its object", async () => {
    const x = setup();
    await x.manager.refresh();
    x.request.mockRejectedValueOnce(new Error("lost send")).mockResolvedValueOnce([]);
    await x.manager.create(draft);
    x.committed(server.id);
    x.request
      .mockRejectedValueOnce(Object.assign(new Error("rejected"), { status: 403 }))
      .mockResolvedValueOnce([server]);
    await x.manager.create(draft);
    expect(x.state()).toMatchObject({ pendingCreate: false, recovered: server });
  });
  it("rejects a changed receipt after an acknowledged ID and preserves the draft", async () => {
    const x = setup();
    await x.manager.refresh();
    const wire = x.wire.getMockImplementation()!;
    x.wire.mockImplementation(async (procedure, input, signal) => {
      if (procedure === "mcp/servers/creation")
        return { requestId: "00000000-0000-4000-8000-000000000001", serverId: "replacement" };
      return wire(procedure, input, signal);
    });
    x.request.mockResolvedValueOnce(server);
    await x.manager.create(draft);
    expect(x.state()).toMatchObject({
      pendingCreate: true,
      fresh: false,
      error: "read",
      recovered: null,
    });
  });
});

it("fails closed before sending config to a server without request-receipt support", async () => {
  const x = setup();
  await x.manager.refresh();
  x.wire.mockRejectedValueOnce(Object.assign(new Error("Unknown procedure"), { status: 404 }));
  await x.manager.create(draft);
  expect(
    x.wire.mock.calls.some(
      ([procedure]) => procedure === "mcp/servers/createOnce" || procedure === "mcp/servers/create",
    ),
  ).toBe(false);
  expect(x.state()).toMatchObject({ pendingCreate: false, recovered: null, error: "write" });
  expect(draft.name).toBe("Fixture");
});
