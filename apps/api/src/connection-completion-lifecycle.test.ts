import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "test@example.test",
  isDeploymentOwner: true,
};
type ConnectionRow = {
  id: string;
  spaceId: string;
  userId: string;
  connectorId: string;
  provider: string;
  displayName: string;
  status: string;
  providerRef: string | null;
  metadata: { authRevision: string };
  createdAt: Date;
};

function fixture(
  input: { status?: string; providerRef?: string | null; connectorId?: string } = {},
) {
  let stored: ConnectionRow = {
    id: "target",
    spaceId: actor.spaceId,
    userId: actor.userId,
    connectorId: input.connectorId ?? "composio",
    provider: "gmail",
    displayName: "Gmail",
    status: input.status ?? "pending",
    providerRef: input.providerRef === undefined ? "new-request" : input.providerRef,
    metadata: { authRevision: "original-grant" },
    createdAt: new Date(0),
  };
  const siblings: ConnectionRow[] = [];
  const matches = (row: ConnectionRow, where: Record<string, unknown>) =>
    where.spaceId === row.spaceId &&
    where.userId === row.userId &&
    (typeof where.id !== "string" || where.id === row.id) &&
    (!where.status || where.status === row.status);
  const rootConnection = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      matches(stored, where) ? { ...stored } : null,
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<ConnectionRow> }) => {
        if (!matches(stored, where)) return { count: 0 };
        stored = { ...stored, ...data };
        return { count: 1 };
      },
    ),
  };
  const connectionReady = vi.fn(async () => true);
  const resolveConnectedAccountId = vi.fn(
    async (
      _userId: string,
      _slug: string,
      _currentRef: string | null | undefined,
      _excluded: string[],
      _spaceId: string,
    ): Promise<string | undefined> => undefined,
  );
  const cancelAuthorizationRequest = vi.fn(async () => undefined);
  const complete = vi.fn(async () => ({ connectionRef: "unused" }));
  const transactionUpdate = vi.fn();
  const beforeTransaction = vi.fn();
  const prisma = {
    connection: rootConnection,
    $transaction: vi.fn(async <T>(effect: (client: unknown) => Promise<T>): Promise<T> => {
      beforeTransaction();
      let transactionRow = { ...stored };
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        connection: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) => {
            if (!matches(transactionRow, where)) return null;
            if (typeof where.id === "string") return { ...transactionRow };
            return siblings.find((row) => row.providerRef === where.providerRef) ?? null;
          },
          findMany: vi.fn(async () => siblings),
          update: async ({ data }: { data: Partial<ConnectionRow> }) => {
            transactionUpdate(data);
            transactionRow = { ...transactionRow, ...data };
            return { ...transactionRow };
          },
        },
      };
      const result = await effect(tx);
      // Failed transactions leave root writes visible, as PostgreSQL would. This
      // catches a cleanup handler incorrectly reopening a revoked row through prisma.
      stored = transactionRow;
      return result;
    }),
  };
  const connector = {
    connectionReady,
    resolveConnectedAccountId,
    cancelAuthorizationRequest,
    complete,
  };
  const deps = {
    prisma,
    connectors: { managed: () => connector },
    env: {
      webOrigin: "http://127.0.0.1:5173",
      defaultProvider: "fake",
      defaultModel: "fake",
      sandboxProvider: "fake",
      screenProxySecret: "fake",
    },
    dataDir: "/tmp/connection-lifecycle-test",
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return {
    client,
    prisma,
    rootConnection,
    siblings,
    connectionReady,
    resolveConnectedAccountId,
    cancelAuthorizationRequest,
    complete,
    transactionUpdate,
    beforeTransaction,
    row: () => stored,
    setStatus: (status: string) => {
      stored = { ...stored, status };
    },
  };
}

describe("connection completion grant lifecycle", () => {
  it.each(["gmail", null, "new-request"])(
    "keeps %s pending when the account resolver cannot bind a concrete account",
    async (providerRef) => {
      const f = fixture({
        providerRef,
        connectorId: providerRef === "gmail" ? "pipedream" : "composio",
      });
      expect(await f.client.connections.complete({ connectionId: "target" })).toMatchObject({
        status: "pending",
        remoteAccountId: null,
      });
      expect(f.row().status).toBe("pending");
      expect(f.transactionUpdate).not.toHaveBeenCalled();
      expect(f.rootConnection.updateMany).not.toHaveBeenCalled();
      expect(f.resolveConnectedAccountId).toHaveBeenCalledWith(
        "user",
        "gmail",
        providerRef,
        [],
        "space",
      );
      expect(f.rootConnection.findFirst).toHaveBeenCalledWith({
        where: { id: "target", spaceId: "space", userId: "user" },
      });
    },
  );

  it("does not adopt an arbitrary remote account into an old error grant", async () => {
    const f = fixture({ status: "error", providerRef: null });
    f.resolveConnectedAccountId.mockResolvedValue("existing-sibling-account");
    expect(
      await f.client.connections.complete({ connectionId: "target", code: "late-code" }),
    ).toMatchObject({ status: "error", remoteAccountId: null });
    expect(f.row()).toMatchObject({
      status: "error",
      providerRef: null,
      metadata: { authRevision: "original-grant" },
    });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.connectionReady).not.toHaveBeenCalled();
    expect(f.resolveConnectedAccountId).not.toHaveBeenCalled();
    expect(f.rootConnection.updateMany).not.toHaveBeenCalled();
  });

  it("does not complete a grant that becomes error while waiting for its transaction", async () => {
    const f = fixture();
    f.beforeTransaction.mockImplementation(() => f.setStatus("error"));
    f.resolveConnectedAccountId.mockResolvedValue("unrelated-account");
    expect(
      await f.client.connections.complete({ connectionId: "target", code: "late-code" }),
    ).toMatchObject({ status: "error", remoteAccountId: null });
    expect(f.row().status).toBe("error");
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.connectionReady).not.toHaveBeenCalled();
    expect(f.resolveConnectedAccountId).not.toHaveBeenCalled();
    expect(f.transactionUpdate).not.toHaveBeenCalled();
  });

  it("does not let an unresolved old error request block or replace a fresh exact request", async () => {
    const f = fixture();
    f.siblings.push({
      ...f.row(),
      id: "old-error",
      status: "error",
      providerRef: "old-failed-request",
    });
    f.resolveConnectedAccountId.mockImplementation(async (_user, _slug, ref) =>
      ref === "new-request" ? "new-account" : undefined,
    );
    expect(await f.client.connections.complete({ connectionId: "target" })).toMatchObject({
      status: "connected",
      remoteAccountId: "new-account",
    });
    expect(f.resolveConnectedAccountId).toHaveBeenLastCalledWith(
      "user",
      "gmail",
      "new-request",
      ["old-failed-request"],
      "space",
    );
    expect(f.siblings[0]).toMatchObject({ status: "error", providerRef: "old-failed-request" });
    expect(f.row()).toMatchObject({
      status: "connected",
      providerRef: "new-account",
      metadata: { authRevision: "original-grant" },
    });
    expect(f.rootConnection.updateMany).not.toHaveBeenCalled();
  });

  it("never reopens a revoked grant after remote cleanup failure or a repeated late callback", async () => {
    const f = fixture({ status: "revoked", providerRef: "original-request" });
    f.cancelAuthorizationRequest.mockRejectedValue(new Error("Synthetic cleanup failure"));
    f.resolveConnectedAccountId.mockResolvedValue("late-oauth-account");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        f.client.connections.complete({ connectionId: "target", code: "late-code" }),
      ).rejects.toThrow();
      expect(f.row()).toMatchObject({
        status: "revoked",
        providerRef: "original-request",
        metadata: { authRevision: "original-grant" },
      });
    }
    expect(f.cancelAuthorizationRequest).toHaveBeenCalledTimes(2);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.connectionReady).not.toHaveBeenCalled();
    expect(f.resolveConnectedAccountId).not.toHaveBeenCalled();
    expect(f.rootConnection.updateMany).not.toHaveBeenCalled();
    expect(f.transactionUpdate).not.toHaveBeenCalled();
  });
});
