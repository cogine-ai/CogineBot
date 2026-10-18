import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  approvalReplayResourceError,
  boundDirectApprovalRequest,
  catalogApprovalRequest,
} from "./approval-effect.js";
import {
  assertBoundConnectorAccount,
  connectionAuthorizationRevision,
  connectorAccountRevision,
  refreshRunConnectorContext,
  selectExplicitConnectorAccounts,
} from "./connector-account-binding.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const row = {
  id: "work",
  connectorId: "pipedream",
  provider: "gmail",
  providerRef: "apn_work",
  displayName: "Work",
  status: "connected",
  userId: "owner",
  spaceId: "space",
  metadata: { authRevision: "authorization-1" },
  updatedAt: new Date("2026-10-17T00:00:00Z"),
};

describe("connector account authority", () => {
  it("constrains the same known app across sources and never invents a default", () => {
    const rows = [
      row,
      { ...row, id: "personal" },
      { ...row, id: "another-source", connectorId: "composio" },
      { ...row, id: "calendar", provider: "calendar" },
    ];
    expect(selectExplicitConnectorAccounts(rows, []).map((item) => item.id)).toEqual(
      rows.map((item) => item.id),
    );
    expect(selectExplicitConnectorAccounts(rows, ["work"]).map((item) => item.id)).toEqual([
      "work",
      "calendar",
    ]);
    expect(
      selectExplicitConnectorAccounts(rows, ["work", "personal", "another-source"]).map(
        (item) => item.id,
      ),
    ).toEqual(rows.map((item) => item.id));
    expect(() =>
      selectExplicitConnectorAccounts([{ ...row, status: "revoked" }, rows[1]!], ["work"]),
    ).toThrow("explicitly selected");
  });

  it("uses only the known app aliases across sources and preserves unknown app identities", () => {
    const rows = [
      { ...row, id: "calendar-composio", connectorId: "composio", provider: "GOOGLECALENDAR" },
      { ...row, id: "calendar-pipedream", provider: "google_calendar" },
      { ...row, id: "custom-a", connectorId: "composio", provider: "private_example" },
      { ...row, id: "custom-b", provider: "private_example" },
    ];
    expect(
      selectExplicitConnectorAccounts(rows, ["calendar-composio", "custom-a"]).map(
        (item) => item.id,
      ),
    ).toEqual(["calendar-composio", "custom-a", "custom-b"]);
    expect(
      selectExplicitConnectorAccounts(rows, ["calendar-composio", "calendar-pipedream"]).map(
        (item) => item.id,
      ),
    ).toEqual(rows.map((item) => item.id));
  });

  it("constrains an explicit GitHub account across providers without merging identical unknown slugs", () => {
    const rows = [
      { ...row, id: "github-composio", connectorId: "composio", provider: "GITHUB" },
      { ...row, id: "github-pipedream", provider: "github" },
      {
        ...row,
        id: "unknown-composio",
        connectorId: "composio",
        provider: "private_github_app",
        displayName: "GitHub",
      },
      { ...row, id: "unknown-pipedream", provider: "private_github_app", displayName: "GitHub" },
    ];
    expect(
      selectExplicitConnectorAccounts(rows, ["github-composio"]).map((item) => item.id),
    ).toEqual(["github-composio", "unknown-composio", "unknown-pipedream"]);
    expect(
      selectExplicitConnectorAccounts(rows, ["github-composio", "github-pipedream"]).map(
        (item) => item.id,
      ),
    ).toEqual(rows.map((item) => item.id));
    expect(
      selectExplicitConnectorAccounts(rows, ["unknown-composio"]).map((item) => item.id),
    ).toEqual(rows.map((item) => item.id));
  });

  it.each(["pending", "error"])(
    "preserves an already live-confirmed %s Composio recovery without explicit intent",
    async (status) => {
      const recovery = {
        ...row,
        connectorId: "composio",
        providerRef: "ca_work",
        status,
        metadata: {},
      };
      expect(selectExplicitConnectorAccounts([recovery], [])).toEqual([recovery]);
      const initial = {
        id: recovery.id,
        connectorId: recovery.connectorId,
        externalId: recovery.provider,
        displayName: recovery.displayName,
        providerRef: recovery.providerRef,
        revision: connectionAuthorizationRevision(recovery),
      };
      let rows = [recovery];
      const prisma = {
        task: { findUniqueOrThrow: vi.fn(async () => ({ connectionIds: [] })) },
        connection: { findMany: vi.fn(async () => rows) },
      } as unknown as PrismaClient;
      const refreshed = await refreshRunConnectorContext(
        prisma,
        { ...context, connectedConnections: [initial] },
        "task",
      );
      expect(refreshed.connectedConnections).toEqual([initial]);
      rows = [{ ...recovery, status: "revoked" }];
      expect(
        (await refreshRunConnectorContext(prisma, refreshed, "task")).connectedConnections,
      ).toEqual([]);
      rows = [recovery, { ...recovery, id: "new-account", status: "connected" }];
      expect(
        (await refreshRunConnectorContext(prisma, refreshed, "task")).connectedConnections?.map(
          (connection) => connection.id,
        ),
      ).toEqual(["new-account"]);
    },
  );

  it("uses authRevision rather than display-name timestamps and changes after reauthorization", () => {
    const revision = connectionAuthorizationRevision(row);
    const renamed = { ...row, displayName: "Renamed", updatedAt: new Date() };
    expect(connectionAuthorizationRevision(renamed)).toBe(revision);
    expect(
      connectionAuthorizationRevision({ ...row, metadata: { authRevision: "authorization-2" } }),
    ).not.toBe(revision);
    expect(connectionAuthorizationRevision({ updatedAt: row.updatedAt })).toBe(
      row.updatedAt.toISOString(),
    );
  });

  it.each(["other-owner", "other-space", "revoked", "missing"])(
    "rejects explicit %s before any account can be invoked",
    async (reason) => {
      const stored =
        reason === "missing"
          ? []
          : [
              {
                ...row,
                ...(reason === "other-owner"
                  ? { userId: "other-owner" }
                  : reason === "other-space"
                    ? { spaceId: "other-space" }
                    : { status: "revoked" }),
              },
              { ...row, id: "healthy-sibling" },
            ];
      const findMany = vi.fn(async ({ where }) =>
        stored.filter((item) => item.userId === where.userId && item.spaceId === where.spaceId),
      );
      const task = vi.fn(async () => ({ connectionIds: ["work"] }));
      const prisma = {
        task: { findUniqueOrThrow: task },
        connection: { findMany },
      } as unknown as PrismaClient;
      const invoke = vi.fn();
      await expect(
        refreshRunConnectorContext(prisma, context, "task").then(invoke),
      ).rejects.toThrow("explicitly selected");
      expect(invoke).not.toHaveBeenCalled();
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "owner", spaceId: "space" } }),
      );
      expect(task).toHaveBeenCalledWith({
        where: { id: "task", userId: "owner", spaceId: "space" },
        select: { connectionIds: true },
      });
    },
  );

  it("re-reads task intent and authorization before execution instead of using the run snapshot", async () => {
    let rows = [row, { ...row, id: "personal", providerRef: "apn_personal" }];
    let selected = ["work"];
    const prisma = {
      task: { findUniqueOrThrow: vi.fn(async () => ({ connectionIds: selected })) },
      connection: { findMany: vi.fn(async () => rows) },
    } as unknown as PrismaClient;
    const first = await refreshRunConnectorContext(prisma, context, "task");
    const account = first.connectedConnections![0]!;
    const call = {
      tool: "send",
      args: {},
      executionId: "approved",
      route: {
        connectorId: "pipedream",
        resourceId: "gmail",
        toolName: "send",
        connectionId: account.id,
        resourceRevision: connectorAccountRevision(account),
      },
    };
    expect(assertBoundConnectorAccount(call, first)?.id).toBe("work");
    selected = ["personal"];
    const next = await refreshRunConnectorContext(prisma, context, "task");
    expect(() => assertBoundConnectorAccount(call, next)).toThrow("unavailable");
    selected = ["work"];
    rows = rows.map((item) =>
      item.id === "work" ? { ...item, metadata: { authRevision: "new-authorization" } } : item,
    );
    expect(() =>
      assertBoundConnectorAccount(call, {
        ...first,
        connectedConnections: next.connectedConnections,
      }),
    ).toThrow("unavailable");
    const reauthorized = await refreshRunConnectorContext(prisma, context, "task");
    expect(() => assertBoundConnectorAccount(call, reauthorized)).toThrow("authorization changed");
  });

  it.each(["direct", "catalog"])(
    "binds %s approval to the account and authorization generation",
    (kind) => {
      const account = {
        id: row.id,
        connectorId: row.connectorId,
        externalId: row.provider,
        displayName: row.displayName,
        providerRef: row.providerRef,
        revision: "auth-1",
      };
      const route = {
        connectorId: "pipedream",
        resourceId: "gmail",
        toolName: "send",
        connectionId: account.id,
        resourceRevision: connectorAccountRevision(account),
      };
      const args = { __connectionId: "work", text: "approved" };
      const request =
        kind === "direct"
          ? boundDirectApprovalRequest(route, args, "marker")
          : catalogApprovalRequest(
              "pipedream_execute_tool",
              { id: "gmail:send", arguments: args },
              "marker",
              route,
            );
      expect(
        approvalReplayResourceError("send", kind === "catalog", request, route, "marker"),
      ).toBeUndefined();
      expect(
        approvalReplayResourceError(
          "send",
          kind === "catalog",
          request,
          { ...route, connectionId: "personal" },
          "marker",
        ),
      ).toBeDefined();
      expect(
        approvalReplayResourceError(
          "send",
          kind === "catalog",
          request,
          {
            ...route,
            resourceRevision: connectorAccountRevision({ ...account, providerRef: "apn_new" }),
          },
          "marker",
        ),
      ).toBeDefined();
      expect(
        approvalReplayResourceError(
          "send",
          kind === "catalog",
          request,
          {
            ...route,
            resourceRevision: connectorAccountRevision({ ...account, revision: "auth-2" }),
          },
          "marker",
        ),
      ).toBeDefined();
    },
  );
});
