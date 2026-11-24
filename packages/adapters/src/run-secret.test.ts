import { describe, expect, it, vi } from "vitest";
import {
  commitConsumedRunSecret,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveCompletedSecretLeftover,
  resolveMissingRunSecretAction,
  runSecretKind,
  secretPausedToolResult,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";

describe("runSecretKind", () => {
  it("scopes secrets to a single run", () => {
    expect(runSecretKind("run-1")).toBe("run-secret:run-1");
  });
});

describe("normalizeSecretAskPurpose", () => {
  it("keeps known purposes and defaults unknown ones to otp", () => {
    expect(normalizeSecretAskPurpose("api_key")).toBe("api_key");
    expect(normalizeSecretAskPurpose("password")).toBe("password");
    expect(normalizeSecretAskPurpose("other")).toBe("otp");
    expect(normalizeSecretAskPurpose("otp")).toBe("otp");
    expect(normalizeSecretAskPurpose(undefined)).toBe("otp");
  });
});

describe("secretPausedToolResult", () => {
  it("terminates the agent turn without exposing a value", () => {
    expect(secretPausedToolResult()).toMatchObject({
      terminate: true,
      details: { secret: "paused" },
    });
  });
});

describe("commitConsumedRunSecret", () => {
  it("deletes the stored secret before connector side effects, then persists", async () => {
    const order: string[] = [];
    const result = { ok: true, submitted: true };
    const onPersistFailed = { error: "uncertain", uncertain: true as const };

    await expect(
      commitConsumedRunSecret({
        deleteSecret: async () => {
          order.push("delete");
        },
        afterSecretTaken: async () => {
          order.push("side-effect");
          return result;
        },
        persist: async () => {
          order.push("persist");
          return true;
        },
        onPersistFailed,
      }),
    ).resolves.toBe(result);

    expect(order).toEqual(["delete", "side-effect", "persist"]);
  });

  it("does not keep the secret for a retry after side effects when persist fails", async () => {
    const deleteSecret = vi.fn();
    const onPersistFailed = { error: "uncertain", uncertain: true as const };

    await expect(
      commitConsumedRunSecret({
        deleteSecret,
        afterSecretTaken: async () => ({ ok: true, submitted: true }),
        persist: async () => false,
        onPersistFailed,
      }),
    ).resolves.toBe(onPersistFailed);

    expect(deleteSecret).toHaveBeenCalledOnce();
  });
});

describe("resolveCompletedSecretLeftover", () => {
  it("drops a leftover OTP created before the effect completed", () => {
    expect(
      resolveCompletedSecretLeftover({
        secretCreatedAt: new Date("2026-08-27T12:00:00.000Z"),
        effectUpdatedAt: new Date("2026-08-27T12:00:05.000Z"),
      }),
    ).toBe("drop_leftover");
  });

  it("consumes a replacement OTP submitted after the effect completed", () => {
    expect(
      resolveCompletedSecretLeftover({
        secretCreatedAt: new Date("2026-08-27T12:01:00.000Z"),
        effectUpdatedAt: new Date("2026-08-27T12:00:05.000Z"),
      }),
    ).toBe("consume_replacement");
  });
});

describe("resolveMissingRunSecretAction", () => {
  it("replays a completed effect instead of asking again after the secret was deleted", () => {
    const result = { ok: true, submitted: true, connected: true };
    expect(resolveMissingRunSecretAction({ status: "completed", result })).toEqual({
      action: "return",
      result,
    });
  });

  it("settles an in-flight attempt instead of re-asking for a consumed OTP", () => {
    expect(resolveMissingRunSecretAction({ status: "executing" })).toEqual({
      action: "settle_attempt",
    });
  });

  it("asks again when the effect is still waiting for input", () => {
    expect(resolveMissingRunSecretAction({ status: "intended" })).toEqual({ action: "ask" });
    expect(resolveMissingRunSecretAction(undefined)).toEqual({ action: "ask" });
  });
});

describe("reconcileManagedConnection", () => {
  const context = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "workspace-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("marks a pending connection connected when the provider is already ready", async () => {
    const connectionReady = vi.fn().mockResolvedValue(true);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          spaceId: "workspace-1",
          userId: "user-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ connectionReady })),
    };

    await expect(
      reconcileManagedConnection(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
      ),
    ).resolves.toBe("connected");

    expect(connectionReady).toHaveBeenCalled();
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conn-1",
        spaceId: "workspace-1",
        userId: "user-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "gmail-state",
        status: "pending",
      },
      data: { status: "connected" },
    });
  });
});

describe("tryCompleteConnectionWithCode", () => {
  const context = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "workspace-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("forwards the code to a pending managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          spaceId: "workspace-1",
          userId: "user-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "123456",
      ),
    ).resolves.toEqual({ connected: true });

    expect(prisma.connection.findFirst).toHaveBeenCalledWith({
      where: {
        id: "conn-1",
        spaceId: "workspace-1",
        userId: "user-1",
        status: { in: ["pending", "connected"] },
      },
    });
    expect(complete).toHaveBeenCalledWith({ state: "gmail-state", code: "123456" }, context);
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conn-1",
        spaceId: "workspace-1",
        userId: "user-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "gmail-state",
        status: "pending",
      },
      data: { status: "connected" },
    });
  });

  it("does not resubmit a code when the connection is already connected", async () => {
    const complete = vi.fn();
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          spaceId: "workspace-1",
          userId: "user-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "connected",
        }),
        updateMany: vi.fn(),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady: vi.fn() })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "123456",
      ),
    ).resolves.toEqual({ connected: true });

    expect(complete).not.toHaveBeenCalled();
    expect(prisma.connection.updateMany).not.toHaveBeenCalled();
  });

  it("returns a connector error instead of throwing", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("invalid code"));
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          spaceId: "workspace-1",
          userId: "user-1",
          connectorId: "composio",
          provider: "gmail",
          providerRef: "gmail-state",
          status: "pending",
        }),
        updateMany: vi.fn(),
      },
    };
    const connectors = {
      managed: vi.fn(() => ({ complete, connectionReady: vi.fn() })),
    };

    await expect(
      tryCompleteConnectionWithCode(
        prisma as never,
        connectors as never,
        { spaceId: "workspace-1", userId: "user-1" },
        context,
        "conn-1",
        "bad",
      ),
    ).resolves.toEqual({ connected: false, error: "Connection could not be completed." });
  });
});

describe.each(["otp", "missing-secret"] as const)("Run connection commit with %s", (entry) => {
  const scope = { spaceId: "space", userId: "user" };
  const context = {
    ...scope,
    operationId: "run",
    traceId: "run",
    signal: new AbortController().signal,
  };
  const pending = {
    ...scope,
    id: "connection",
    connectorId: "composio",
    provider: "mail",
    status: "pending",
    providerRef: "request-fixture",
    metadata: { authRevision: "fixture-revision" },
  };

  function fixture(accountAware = false) {
    const connection = {
      findFirst: vi.fn().mockResolvedValueOnce(pending),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const complete = vi.fn().mockResolvedValue({ connectionRef: pending.providerRef });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const resolveConnectedAccountId = vi.fn().mockResolvedValue("existing-sibling-account");
    const connectors = {
      managed: () => ({
        complete,
        connectionReady,
        ...(accountAware ? { resolveConnectedAccountId } : {}),
      }),
    };
    const settle = async () => {
      const prisma = { connection } as never;
      return entry === "otp"
        ? (
            await tryCompleteConnectionWithCode(
              prisma,
              connectors as never,
              scope,
              context,
              pending.id,
              "synthetic-code",
            )
          ).connected
        : await reconcileManagedConnection(prisma, connectors as never, scope, context, pending.id);
    };
    return { connection, complete, connectionReady, settle };
  }

  it.each(["revoked", "pending", "connected", null] as const)(
    "uses the committed state after a lost activation write (%s)",
    async (status) => {
      const f = fixture();
      f.connection.findFirst.mockResolvedValueOnce(status ? { status } : null);
      const result = status === "connected" || status === "pending" ? status : "missing";
      await expect(f.settle()).resolves.toBe(entry === "otp" ? result === "connected" : result);
      expect(f.connection.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: {
          ...scope,
          id: pending.id,
          connectorId: pending.connectorId,
          provider: pending.provider,
          providerRef: pending.providerRef,
          status: "pending",
        },
        data: { status: "connected" },
      });
      expect(f.connection.findFirst).toHaveBeenLastCalledWith({
        where: { ...scope, id: pending.id },
        select: { status: true },
      });
      expect(f.complete).toHaveBeenCalledTimes(entry === "otp" ? 1 : 0);
    },
  );

  it.each(["pending", "connected"] as const)(
    "uses the saved account-aware status (%s), even if another account is ready",
    async (status) => {
      const f = fixture(true);
      f.connection.findFirst.mockResolvedValueOnce({ status });
      await expect(f.settle()).resolves.toBe(entry === "otp" ? status === "connected" : status);
      expect(f.connectionReady).not.toHaveBeenCalled();
      expect(f.connection.updateMany).not.toHaveBeenCalled();
      expect(f.complete).toHaveBeenCalledTimes(entry === "otp" ? 1 : 0);
    },
  );

  it("waits for begin to save a reference before contacting the provider", async () => {
    const f = fixture();
    f.connection.findFirst.mockReset().mockResolvedValueOnce({ ...pending, providerRef: null });
    await expect(f.settle()).resolves.toBe(entry === "otp" ? false : "pending");
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.connectionReady).not.toHaveBeenCalled();
    expect(f.connection.updateMany).not.toHaveBeenCalled();
  });
});
