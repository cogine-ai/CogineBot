import type { AdapterContext, ConnectorRoute } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadRunVerbatimMcpServers, restoreRunMcpResultRoute } from "./run-mcp-context.js";

const context: AdapterContext = {
  operationId: "fixture-operation",
  traceId: "fixture-trace",
  userId: "owner",
  spaceId: "space",
  botId: "existing-bot",
  signal: new AbortController().signal,
};
const selection = {
  id: true,
  slug: true,
  allowAllTools: true,
  allowedTools: true,
  verbatimResults: true,
  installId: true,
};
type Server = {
  id: string;
  slug: string;
  userId: string;
  spaceId: string;
  enabled: boolean;
  verbatimResults: boolean;
  allowAllTools: boolean;
  allowedTools: unknown;
  installId: string | null;
};
function server(id: string, patch: Partial<Server> = {}): Server {
  return {
    id,
    slug: id,
    userId: context.userId,
    spaceId: context.spaceId,
    enabled: true,
    verbatimResults: true,
    allowAllTools: false,
    allowedTools: ["read"],
    installId: null,
    ...patch,
  };
}
type Install = {
  id: string;
  userId: string;
  spaceId: string;
  kind: string;
  clientNonce: string | null;
  status: string;
};
function fixture(rows: Server[], installs: Install[] = []) {
  const matches = (row: Server, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
    );
  const client = {
    mcpServer: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) => matches(row, where)) ?? null,
      ),
    },
    capabilityInstall: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          installs.find((row) => row.id === where.id) ?? null,
      ),
    },
    botMcpServer: { findMany: vi.fn(), findFirst: vi.fn() },
  };
  return { prisma: client as unknown as PrismaClient, client };
}
const route: ConnectorRoute = {
  connectorId: "mcp",
  resourceId: "research",
  resourceRevision: "saved-revision",
  catalogGroup: "old-research-label",
  connectionId: "trusted-connection",
  toolName: "read",
};

describe("run MCP result context", () => {
  it("selects exact same-user/Space enabled opt-ins without granting tools or using Bot assignments", async () => {
    const f = fixture([
      server("all", { allowAllTools: true, allowedTools: [] }),
      server("restricted"),
      server("default-off", { verbatimResults: false }),
      server("disabled", { enabled: false }),
      server("foreign-user", { userId: "other" }),
      server("foreign-space", { spaceId: "other" }),
      server("no-tools", { allowedTools: [] }),
      server("invalid-tools", { allowedTools: [1, false] }),
    ]);
    for (const botId of ["existing-bot", "future-bot"]) {
      await expect(loadRunVerbatimMcpServers(f.prisma, { ...context, botId })).resolves.toEqual({
        ids: ["all", "restricted"],
        slugs: ["all", "restricted"],
      });
    }
    expect(f.client.mcpServer.findMany).toHaveBeenCalledWith({
      where: { userId: "owner", spaceId: "space", enabled: true, verbatimResults: true },
      select: selection,
    });
    expect(f.client.botMcpServer.findMany).not.toHaveBeenCalled();
    expect(f.client.botMcpServer.findFirst).not.toHaveBeenCalled();
  });

  it("reuses actual managed-plugin lifecycle and ownership while preserving legacy capability rules", async () => {
    const install = (id: string, patch: Partial<Install> = {}): Install => ({
      id,
      userId: "owner",
      spaceId: "space",
      kind: "plugin",
      clientNonce: "fixture-nonce",
      status: "installed",
      ...patch,
    });
    const f = fixture(
      [
        server("active", { installId: "active" }),
        server("inactive", { installId: "inactive" }),
        server("missing", { installId: "missing" }),
        server("foreign", { installId: "foreign" }),
        server("legacy", { installId: "legacy" }),
      ],
      [
        install("active"),
        install("inactive", { status: "uninstalled" }),
        install("foreign", { spaceId: "other" }),
        install("legacy", { clientNonce: null, status: "uninstalled" }),
      ],
    );
    await expect(loadRunVerbatimMcpServers(f.prisma, context)).resolves.toEqual({
      ids: ["active", "legacy"],
      slugs: ["active", "legacy"],
    });
    expect(f.client.capabilityInstall.findFirst.mock.calls.map(([call]) => call.where.id)).toEqual([
      "active",
      "inactive",
      "missing",
      "foreign",
      "legacy",
    ]);
  });

  it("does not query or expose servers without a Bot context", async () => {
    const f = fixture([server("research")]);
    await expect(
      loadRunVerbatimMcpServers(f.prisma, { ...context, botId: undefined }),
    ).resolves.toEqual({ ids: [], slugs: [] });
    await expect(
      restoreRunMcpResultRoute(f.prisma, { ...context, botId: undefined }, route),
    ).resolves.toBeUndefined();
    expect(f.client.mcpServer.findMany).not.toHaveBeenCalled();
    expect(f.client.mcpServer.findFirst).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "restores trusted historical route ownership independently of retention opt-in (%s)",
    async (verbatimResults) => {
      const f = fixture([server("research", { slug: "renamed-server", verbatimResults })]);
      const restored = await restoreRunMcpResultRoute(f.prisma, context, route);
      expect(restored).toEqual(route);
      expect(restored).not.toBe(route);
      expect(f.client.mcpServer.findFirst).toHaveBeenCalledWith({
        where: { id: "research", userId: "owner", spaceId: "space", enabled: true },
        select: selection,
      });
      expect(f.client.botMcpServer.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: false },
    { userId: "other" },
    { spaceId: "other" },
    { allowedTools: [] },
    { allowedTools: ["write"] },
    { allowedTools: null },
  ])("does not restore a disabled, foreign or no-longer-allowed tool (%j)", async (patch) => {
    const f = fixture([server("research", patch)]);
    await expect(restoreRunMcpResultRoute(f.prisma, context, route)).resolves.toBeUndefined();
  });

  it("does not guess server identity or the allowed tool from an overlapping slug or extra fields", async () => {
    const f = fixture([server("different-id", { slug: "research" })]);
    await expect(
      restoreRunMcpResultRoute(f.prisma, context, {
        ...route,
        resourceId: "missing-id",
        catalogGroup: "research",
        arguments: { serverId: "different-id" },
        details: { resourceId: "different-id" },
      } as ConnectorRoute),
    ).resolves.toBeUndefined();
    const restricted = fixture([server("research")]);
    await expect(
      restoreRunMcpResultRoute(restricted.prisma, context, {
        ...route,
        toolName: "write",
        arguments: { tool: "read" },
        details: { toolName: "read" },
      } as ConnectorRoute),
    ).resolves.toBeUndefined();
  });

  it.each([
    { ...route, connectorId: "openapi" },
    { connectorId: "mcp", toolName: "read" },
  ])("does not query for a non-MCP or unbound route (%j)", async (candidate) => {
    const f = fixture([server("research")]);
    await expect(restoreRunMcpResultRoute(f.prisma, context, candidate)).resolves.toBeUndefined();
    expect(f.client.mcpServer.findFirst).not.toHaveBeenCalled();
  });

  it.each(["load", "restore"] as const)(
    "excludes an isolated managed plugin on %s",
    async (operation) => {
      const f = fixture([server("research", { installId: "plugin" })]);
      f.client.capabilityInstall.findFirst.mockRejectedValueOnce(new IsolationError());
      if (operation === "load")
        await expect(loadRunVerbatimMcpServers(f.prisma, context)).resolves.toEqual({
          ids: [],
          slugs: [],
        });
      else
        await expect(restoreRunMcpResultRoute(f.prisma, context, route)).resolves.toBeUndefined();
    },
  );

  it.each(["load", "restore"] as const)(
    "propagates server and plugin database failures on %s",
    async (operation) => {
      const failure = new Error("fixture database unavailable");
      const f = fixture([server("research", { installId: "plugin" })]);
      if (operation === "load") f.client.mcpServer.findMany.mockRejectedValueOnce(failure);
      else f.client.mcpServer.findFirst.mockRejectedValueOnce(failure);
      const call = () =>
        operation === "load"
          ? loadRunVerbatimMcpServers(f.prisma, context)
          : restoreRunMcpResultRoute(f.prisma, context, route);
      await expect(call()).rejects.toBe(failure);
      f.client.capabilityInstall.findFirst.mockRejectedValueOnce(failure);
      await expect(call()).rejects.toBe(failure);
    },
  );
});
