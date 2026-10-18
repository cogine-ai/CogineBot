import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { PipedreamConnector } from "./pipedream-connector.js";

const config = {
  clientId: "test-client",
  clientSecret: "test-secret",
  projectId: "test-project",
  environment: "development" as const,
  identitySecret: "test-identity",
};
const context: AdapterContext = {
  operationId: "account-test",
  traceId: "account-test",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
  connectedConnections: [
    {
      id: "personal",
      connectorId: "pipedream",
      externalId: "gmail",
      displayName: "Personal",
      providerRef: "apn_personal",
      revision: "auth-1",
    },
    {
      id: "work",
      connectorId: "pipedream",
      externalId: "gmail",
      displayName: "Work",
      providerRef: "apn_work",
      revision: "auth-2",
    },
  ],
};

function server(options: { count?: number; collision?: boolean; failAccount?: string } = {}) {
  const requests: Array<{
    method?: string;
    account: string | null;
    externalUser: string | null;
    args?: unknown;
  }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/oauth/token")
      return Response.json({ access_token: "test-access", expires_in: 3600 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { arguments?: unknown };
    };
    const account = request.headers.get("x-pd-account-id");
    requests.push({
      method: message.method,
      account,
      externalUser: request.headers.get("x-pd-external-user-id"),
      args: message.params?.arguments,
    });
    if (account === options.failAccount)
      return new Response("expired authorization", { status: 401 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "accounts", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: Array.from({ length: options.count ?? 1 }, (_, index) => ({
                name: index === 0 ? "send_mail" : `tool_${index}`,
                description: "Send using the selected account",
                inputSchema: {
                  type: "object",
                  properties: {
                    accountId: { type: "string", description: "Business customer account ID" },
                    mailbox: {
                      type: "string",
                      enum: [account === "apn_work" ? "work-inbox" : "personal-inbox"],
                    },
                    ...(options.collision ? { __connectionId: { type: "number" } } : {}),
                  },
                  required: ["accountId", "mailbox"],
                  additionalProperties: false,
                },
              })),
            }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "sent" }] }
            : undefined;
    return result === undefined
      ? new Response(null, { status: 202 })
      : Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  return {
    requests,
    connector: new PipedreamConnector(config, {
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    }),
  };
}

async function execute(connector: PipedreamConnector, call: ConnectorCall, ctx = context) {
  const events: ConnectorEvent[] = [];
  for await (const event of connector.execute(call, ctx)) events.push(event);
  return events;
}

describe("Pipedream authorized account binding", () => {
  it("discovers distinct account schemas under the unchanged tool name and preserves business accountId", async () => {
    const { connector, requests } = server();
    const [tool] = await connector.discoverTools(context);
    expect(tool!.name).toBe("send_mail");
    expect(tool!.inputSchema.anyOf).toHaveLength(2);
    expect(
      requests
        .filter((request) => request.method === "tools/list")
        .map((request) => request.account)
        .sort(),
    ).toEqual(["apn_personal", "apn_work"]);
    const call = {
      tool: tool!.name,
      args: { __connectionId: "work", accountId: "customer-business-id", mailbox: "work-inbox" },
      executionId: "send",
      route: tool!.route,
    };
    const resolved = await connector.resolveCall(call, context);
    expect(resolved!.call.connectionId).toBe("work");
    expect(resolved!.call.route).toMatchObject({
      connectionId: "work",
      resourceId: "gmail",
      resourceRevision: expect.any(String),
    });
    expect(resolved!.call.args.__connectionId).toBe("work");
    expect(await execute(connector, resolved!.call)).toMatchObject([{ type: "result" }]);
    expect(requests.filter((request) => request.method === "tools/call")).toEqual([
      expect.objectContaining({
        account: "apn_work",
        args: { accountId: "customer-business-id", mailbox: "work-inbox" },
      }),
    ]);
    await expect(
      connector.resolveCall(
        { ...call, args: { ...call.args, mailbox: "personal-inbox" } },
        context,
      ),
    ).rejects.toThrow("invalid");
    expect(requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
  });

  it("uses the same explicit selection through lazy load and execute", async () => {
    const { connector, requests } = server({ count: 21 });
    const tools = await connector.discoverTools(context);
    const load = tools.find((tool) => tool.name === "pipedream_load_tool")!;
    const loadEvents = await execute(connector, {
      tool: load.name,
      route: load.route,
      args: { id: "gmail:send_mail" },
      executionId: "load",
    });
    expect(loadEvents).toMatchObject([
      { type: "result", data: { name: "send_mail", inputSchema: { anyOf: expect.any(Array) } } },
    ]);
    const wrapper = tools.find((tool) => tool.name === "pipedream_execute_tool")!;
    const call = {
      tool: wrapper.name,
      route: wrapper.route,
      args: {
        id: "gmail:send_mail",
        arguments: {
          __connectionId: "personal",
          accountId: "business-account",
          mailbox: "personal-inbox",
        },
      },
      executionId: "lazy-send",
    };
    const resolved = await connector.resolveCall(call, context);
    expect(resolved!.call.route?.connectionId).toBe("personal");
    expect(await execute(connector, call)).toMatchObject([{ type: "result" }]);
    expect(requests.filter((request) => request.method === "tools/call")).toEqual([
      expect.objectContaining({
        account: "apn_personal",
        args: { accountId: "business-account", mailbox: "personal-inbox" },
      }),
    ]);
  });

  it.each([undefined, "unknown-local-id", "apn_work"])(
    "does not fall back for absent or unauthorized local selection %s",
    async (selected) => {
      const { connector, requests } = server();
      const [tool] = await connector.discoverTools(context);
      const events = await execute(connector, {
        tool: tool!.name,
        route: tool!.route,
        args: { __connectionId: selected, accountId: "business-account", mailbox: "work-inbox" },
        executionId: "rejected",
      });
      expect(events).toMatchObject([{ type: "error" }]);
      expect(requests.some((request) => request.method === "tools/call")).toBe(false);
    },
  );

  it.each(["removed", "ref-changed", "reauthorized"])(
    "rejects a bound account after %s without invoking its sibling",
    async (change) => {
      const { connector, requests } = server();
      const [tool] = await connector.discoverTools(context);
      const resolved = await connector.resolveCall(
        {
          tool: tool!.name,
          route: tool!.route,
          args: { __connectionId: "work", accountId: "business-account", mailbox: "work-inbox" },
          executionId: "approved",
        },
        context,
      );
      const changed = {
        ...context,
        connectedConnections: context.connectedConnections!.flatMap((connection) =>
          connection.id !== "work"
            ? [connection]
            : change === "removed"
              ? []
              : [
                  {
                    ...connection,
                    ...(change === "ref-changed"
                      ? { providerRef: "apn_new" }
                      : { revision: "new-authorization" }),
                  },
                ],
        ),
      };
      const before = requests.length;
      expect(await execute(connector, resolved!.call, changed)).toMatchObject([{ type: "error" }]);
      expect(requests).toHaveLength(before);
    },
  );

  it("fails closed on a selector schema collision", async () => {
    const { connector, requests } = server({ collision: true });
    expect(await connector.discoverTools(context)).toEqual([]);
    await expect(
      connector.resolveCall(
        {
          tool: "send_mail",
          route: { connectorId: "pipedream", resourceId: "gmail", toolName: "send_mail" },
          args: { __connectionId: "work", accountId: "business-account", mailbox: "work-inbox" },
          executionId: "collision",
        },
        context,
      ),
    ).rejects.toThrow("conflicts");
    expect(requests.some((request) => request.method === "tools/call")).toBe(false);
  });

  it("keeps unique legacy-account behavior and adds no arbitrary authorization ID", async () => {
    const { connector, requests } = server();
    const ctx = {
      ...context,
      connectedConnections: [{ ...context.connectedConnections![0]!, providerRef: "gmail" }],
    };
    const [tool] = await connector.discoverTools(ctx);
    expect(tool!.inputSchema.anyOf).toBeUndefined();
    expect(
      await execute(
        connector,
        {
          tool: tool!.name,
          route: tool!.route,
          args: { accountId: "business-account", mailbox: "personal-inbox" },
          executionId: "legacy",
        },
        ctx,
      ),
    ).toMatchObject([{ type: "result" }]);
    expect(requests.every((request) => request.account === null)).toBe(true);
  });

  it("isolates a failed account and never executes it through the healthy sibling", async () => {
    const { connector, requests } = server({ failAccount: "apn_work" });
    const [tool] = await connector.discoverTools(context);
    expect(tool).toBeDefined();
    expect(
      await execute(connector, {
        tool: tool!.name,
        route: tool!.route,
        args: { __connectionId: "work", accountId: "business-account", mailbox: "work-inbox" },
        executionId: "expired",
      }),
    ).toMatchObject([{ type: "error" }]);
    expect(requests.some((request) => request.method === "tools/call")).toBe(false);
  });
});
