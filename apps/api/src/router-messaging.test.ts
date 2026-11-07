import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { withTransactionContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

/** Prisma filters the handlers use when scoping memberships to the caller. */
type MembershipWhere = { id?: string; identityId?: { in: string[] } };

const identity = {
  id: "mi-1",
  provider: "sendblue",
  address: "+15551111111",
  userId: "user-1",
  spaceId: "ws-1",
  botId: "bot-1",
  outboundSinceInbound: 0,
};

function messagingDeps(
  overrides: {
    enabled?: boolean;
    identity?: unknown;
    /** Every chat app the caller has linked; defaults to the single identity. */
    identities?: Array<Record<string, unknown>>;
    membership?: Record<string, unknown> | null;
    memberships?: Array<Record<string, unknown>>;
    connection?: Record<string, unknown> | null;
    connections?: Array<Record<string, unknown>>;
  } = {},
) {
  const resolvedIdentity = overrides.identity === undefined ? identity : overrides.identity;
  const membership =
    overrides.membership === undefined
      ? {
          id: "cm-1",
          channelId: "ch-1",
          address: "+15551111111",
          identityId: "mi-1",
          status: "invited",
          channel: {
            id: "ch-1",
            provider: "sendblue",
            name: "Family",
            members: [{ id: "cm-1" }, { id: "cm-2" }],
          },
        }
      : overrides.membership;
  const connection =
    overrides.connection === null
      ? null
      : {
          requestVersion: 1,
          ...(overrides.connection ?? {
            id: "ac-1",
            requesterBotId: "bot-9",
            targetBotId: "bot-1",
            status: "pending",
          }),
        };
  // One user can hold several memberships in the same channel (one per linked
  // chat app), so the mock resolves them by id the way the handlers do.
  const membershipPool = (overrides.memberships ?? (membership ? [membership] : [])).map(
    (row) => ({ ...row }) as Record<string, unknown>,
  );
  const ownedBy = (where: { identityId?: { in: string[] } } | undefined, row: unknown) =>
    !where?.identityId ||
    where.identityId.in.includes(String((row as { identityId?: string })?.identityId));
  const visibleMemberships = (where: { identityId?: { in: string[] } } | undefined) =>
    membershipPool.filter((row) => ownedBy(where, row));
  const findMembership = (where: { id?: string; identityId?: { in: string[] } } | undefined) => {
    const pool = visibleMemberships(where);
    return where?.id ? (pool.find((row) => row.id === where.id) ?? null) : (pool[0] ?? null);
  };
  const defaultChannel = { id: "ch-1", provider: "sendblue", name: "Family", members: [] };
  const connectionState = connection ? { ...connection } : null;
  const prisma = {
    messagingIdentity: {
      findFirst: vi.fn(async () => resolvedIdentity),
      findMany: vi.fn(
        async () => overrides.identities ?? (resolvedIdentity ? [resolvedIdentity] : []),
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(resolvedIdentity as Record<string, unknown>),
        ...data,
      })),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({
        count: resolvedIdentity && where.id === "mi-1" ? 1 : 0,
      })),
      findUnique: vi.fn(async ({ where }: { where: { botId?: string } }) =>
        where.botId === "bot-9"
          ? {
              id: "mi-9",
              provider: "sendblue",
              address: "+15559999999",
              userId: "user-9",
              botId: "bot-9",
            }
          : resolvedIdentity,
      ),
    },
    messagingChannelMember: {
      findMany: vi.fn(async ({ where }: { where?: MembershipWhere } = {}) =>
        visibleMemberships(where),
      ),
      findFirst: vi.fn(async ({ where }: { where?: MembershipWhere } = {}) =>
        findMembership(where),
      ),
      update: vi.fn(async ({ where, data }: { where?: MembershipWhere; data: unknown }) => {
        const row = findMembership(where);
        if (row) Object.assign(row, data as object);
        return { ...row, channel: row?.channel ?? defaultChannel };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: MembershipWhere & { status?: string };
          data: Record<string, unknown>;
        }) => {
          const row = findMembership(where);
          if (!row) return { count: 0 };
          if (where.status && row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where?: MembershipWhere } = {}) =>
        findMembership(where),
      ),
    },
    agentConnection: {
      findMany: vi.fn(async () => overrides.connections ?? (connection ? [connection] : [])),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where?: {
            id?: string;
            targetBotId?: string | { in: string[] };
            status?: string;
            requestVersion?: number;
            OR?: Array<Record<string, string | { in: string[] }>>;
          };
        }) => {
          // Handlers scope by every linked identity, so bot filters arrive
          // as { in: [...] } lists.
          const matches = (filter: string | { in: string[] } | undefined, value: string) =>
            filter === undefined ||
            (typeof filter === "string" ? filter === value : filter.in.includes(value));
          if (!connection) return null;
          if (where?.id && connection.id !== where.id) return null;
          if (
            where?.requestVersion !== undefined &&
            connection.requestVersion !== where.requestVersion
          )
            return null;
          if (!matches(where?.targetBotId, connection.targetBotId)) return null;
          if (where?.status && connection.status !== where.status) return null;
          if (where?.OR) {
            const involved = where.OR.some(
              (cond) =>
                matches(cond.requesterBotId, connection.requesterBotId) &&
                matches(cond.targetBotId, connection.targetBotId) &&
                (cond.requesterBotId !== undefined || cond.targetBotId !== undefined),
            );
            if (!involved) return null;
          }
          return connection;
        },
      ),
      update: vi.fn(async ({ data }: { data: unknown }) => ({
        ...connection,
        ...(data as object),
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; status?: string; requestVersion?: number };
          data: Record<string, unknown>;
        }) => {
          if (!connectionState) return { count: 0 };
          if (where.id && connectionState.id !== where.id) return { count: 0 };
          if (
            where.requestVersion !== undefined &&
            connectionState.requestVersion !== where.requestVersion
          )
            return { count: 0 };
          if (where.status && connectionState.status !== where.status) return { count: 0 };
          Object.assign(connectionState, data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => connectionState),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: where.id === "bot-9" ? "Helper" : "Assistant",
      })),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id.startsWith("bot-") ? { id: where.id } : null,
      ),
    },
    messagingLinkCode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "user-9", name: "Bob Owner" })),
    },
  } as unknown as PrismaClient;
  const outboundRows: Array<Record<string, unknown>> = [];
  const messagingOutbound = {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const item of data) {
        // Honors skipDuplicates against the idempotencyKey unique key.
        if (outboundRows.some((row) => row.idempotencyKey === item.idempotencyKey)) continue;
        outboundRows.push(item);
        count += 1;
      }
      return { count };
    }),
    deleteMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          idempotencyKey?: string;
          status?: string;
          OR?: Array<{ status?: string; providerHandle?: null }>;
        };
      }) => {
        let count = 0;
        for (let i = outboundRows.length - 1; i >= 0; i -= 1) {
          const row = outboundRows[i]!;
          if (where.idempotencyKey && row.idempotencyKey !== where.idempotencyKey) continue;
          if (where.status && row.status !== where.status) continue;
          if (where.OR) {
            const matches = where.OR.some((clause) => {
              if (clause.status && row.status !== clause.status) return false;
              if ("providerHandle" in clause && clause.providerHandle === null) {
                return row.providerHandle == null;
              }
              return true;
            });
            if (!matches) continue;
          }
          outboundRows.splice(i, 1);
          count += 1;
        }
        return { count };
      },
    ),
  };
  (prisma as { messagingOutbound?: unknown }).messagingOutbound = messagingOutbound;
  // The claim-and-confirm handlers run inside one interactive transaction;
  // the mock passes the same stateful models as the tx delegate.
  let transactionId = 0;
  (prisma as { $transaction?: unknown }).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const scope = { txId: `messaging-fixture-${++transactionId}` };
      return fn(
        new Proxy(prisma, {
          get(target, property, receiver) {
            return property === Symbol.for("prisma.client.transaction.scope_context")
              ? scope
              : Reflect.get(target, property, receiver);
          },
        }),
      );
    },
  );
  (prisma as { $queryRaw?: unknown }).$queryRaw = vi.fn(async () => []);
  (prisma as { $extends?: unknown }).$extends = () => prisma;
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: withTransactionContext(prisma),
    jobs: { enqueue },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    messaging: {
      enabled: overrides.enabled ?? true,
      providers: ["sendblue"],
      openSignup: false,
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const actor = {
    spaceId: "ws-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: false,
  } satisfies Actor;
  return {
    prisma,
    deps,
    actor,
    outboundRows,
    enqueue,
    handler: new RPCHandler(createRouter(deps)),
  };
}

async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown = {}) {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

describe("messaging.status", () => {
  it("reports enablement, providers, and the caller's linked identities", async () => {
    const { handler, actor } = messagingDeps({ enabled: true });
    const response = await call(handler, actor, "messaging/status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: {
        enabled: true,
        providers: ["sendblue"],
        openSignup: false,
        identities: [
          {
            id: "mi-1",
            provider: "sendblue",
            address: "+15551111111",
            botId: "bot-1",
            botName: "Assistant",
          },
        ],
      },
    });
  });

  it("reports no identities when the caller has not linked a chat app", async () => {
    const { handler, actor } = messagingDeps({ identity: null });
    const response = await call(handler, actor, "messaging/status");
    await expect(response.json()).resolves.toEqual({
      json: { enabled: true, providers: ["sendblue"], openSignup: false, identities: [] },
    });
  });
});

describe("messaging.link", () => {
  it("issues a formatted single-use code for an owned unlinked bot", async () => {
    const { handler, actor, prisma } = messagingDeps({ identity: null });
    (prisma.messagingIdentity.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const response = await call(handler, actor, "messaging/link/start", { botId: "bot-2" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { code: string; expiresAt: string } };
    expect(body.json.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(Date.parse(body.json.expiresAt)).toBeGreaterThan(Date.now());
    expect(prisma.messagingLinkCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-1", botId: "bot-2" }),
      }),
    );
  });

  it("refuses to issue a code for an already-linked bot", async () => {
    const { handler, actor } = messagingDeps();
    // messagingIdentity.findUnique resolves an identity for bot-1 by default.
    const response = await call(handler, actor, "messaging/link/start", { botId: "bot-1" });
    expect(response.status).toBe(400);
  });
});

describe("messaging.identities", () => {
  it("re-points an identity at another owned bot", async () => {
    const { handler, actor } = messagingDeps();
    const response = await call(handler, actor, "messaging/identities/setBot", {
      identityId: "mi-1",
      botId: "bot-2",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: {
        id: "mi-1",
        provider: "sendblue",
        address: "+15551111111",
        botId: "bot-2",
        botName: "Assistant",
      },
    });
  });

  it("unlinks only the caller's own identity", async () => {
    const { handler, actor, prisma } = messagingDeps();
    const response = await call(handler, actor, "messaging/identities/unlink", {
      identityId: "mi-1",
    });
    expect(response.status).toBe(200);
    expect(prisma.messagingIdentity.deleteMany).toHaveBeenCalledWith({
      where: { id: "mi-1", userId: "user-1" },
    });
    const missing = await call(handler, actor, "messaging/identities/unlink", {
      identityId: "mi-other",
    });
    expect(missing.status).toBe(404);
  });
});

describe("messaging.channels", () => {
  it("lists the caller's memberships with channel names, counting only active members", async () => {
    const { handler, actor, prisma } = messagingDeps();
    const response = await call(handler, actor, "messaging/channels/list");
    expect(prisma.messagingChannelMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          channel: expect.objectContaining({
            include: expect.objectContaining({
              members: expect.objectContaining({
                where: { status: { in: ["invited", "approved"] } },
              }),
            }),
          }),
        }),
      }),
    );
    await expect(response.json()).resolves.toEqual({
      json: [
        {
          id: "cm-1",
          channelId: "ch-1",
          identityId: "mi-1",
          provider: "sendblue",
          name: "Family",
          status: "invited",
          memberCount: 2,
        },
      ],
    });
  });

  it("approves an invited membership", async () => {
    const { handler, actor, prisma } = messagingDeps();
    const approved = await call(handler, actor, "messaging/channels/respond", {
      membershipId: "cm-1",
      accept: true,
    });
    expect(prisma.messagingChannelMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cm-1", status: "invited" },
        data: { status: "approved" },
      }),
    );
    await expect(approved.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "approved" }),
    });
  });

  it("declines an invited membership on accept=false", async () => {
    const { handler, actor, prisma } = messagingDeps();
    const declined = await call(handler, actor, "messaging/channels/respond", {
      membershipId: "cm-1",
      accept: false,
    });
    expect(prisma.messagingChannelMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cm-1", status: "invited" },
        data: { status: "declined" },
      }),
    );
    await expect(declined.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "declined" }),
    });
  });

  it("rejects respond on another user's membership or a non-invited one", async () => {
    const foreign = messagingDeps({ membership: null });
    const response = await call(foreign.handler, foreign.actor, "messaging/channels/respond", {
      membershipId: "cm-1",
      accept: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);

    const already = messagingDeps({
      membership: {
        id: "cm-1",
        channelId: "ch-1",
        identityId: "mi-1",
        status: "approved",
        channel: { id: "ch-1", provider: "sendblue", name: "Family", members: [] },
      },
    });
    const second = await call(already.handler, already.actor, "messaging/channels/respond", {
      membershipId: "cm-1",
      accept: true,
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("leaves an approved channel", async () => {
    const { handler, actor, prisma } = messagingDeps({
      membership: {
        id: "cm-1",
        channelId: "ch-1",
        identityId: "mi-1",
        status: "approved",
        channel: { id: "ch-1", provider: "sendblue", name: "Family", members: [] },
      },
    });
    const response = await call(handler, actor, "messaging/channels/leave", {
      membershipId: "cm-1",
    });
    expect(prisma.messagingChannelMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "left" } }),
    );
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("answers the named membership when one user has two chat apps in a group", async () => {
    const channel = {
      id: "ch-1",
      provider: "sendblue",
      name: "Family",
      members: [{ id: "cm-1" }, { id: "cm-2" }],
    };
    const { handler, actor, prisma } = messagingDeps({
      identities: [identity, { ...identity, id: "mi-2", address: "+15552222222", botId: "bot-2" }],
      memberships: [
        // Same user, same group, one membership per linked chat app. Answering
        // by channel would pick an arbitrary one and leave the other live.
        { id: "cm-work", channelId: "ch-1", identityId: "mi-1", status: "approved", channel },
        { id: "cm-home", channelId: "ch-1", identityId: "mi-2", status: "invited", channel },
      ],
    });

    const approved = await call(handler, actor, "messaging/channels/respond", {
      membershipId: "cm-home",
      accept: true,
    });
    expect(prisma.messagingChannelMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cm-home", status: "invited" } }),
    );
    await expect(approved.json()).resolves.toEqual({
      json: expect.objectContaining({ id: "cm-home", identityId: "mi-2", status: "approved" }),
    });

    const listed = await call(handler, actor, "messaging/channels/list");
    const rows = (await listed.json()).json as Array<{ id: string; channelId: string }>;
    expect(rows.map((row) => row.id)).toEqual(["cm-work", "cm-home"]);
    expect(new Set(rows.map((row) => row.channelId))).toEqual(new Set(["ch-1"]));
  });
});

describe("messaging.connections", () => {
  it("lists connections with the peer label and direction", async () => {
    const { handler, actor } = messagingDeps();
    const response = await call(handler, actor, "messaging/connections/list");
    await expect(response.json()).resolves.toEqual({
      json: [
        {
          id: "ac-1",
          requestVersion: 1,
          peerBotName: "Helper",
          peerOwnerLabel: "Bob",
          status: "pending",
          incoming: true,
        },
      ],
    });
  });

  it("hides peer identity for outgoing connections that are not approved", async () => {
    const { handler, actor } = messagingDeps({
      connection: { id: "ac-4", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    const response = await call(handler, actor, "messaging/connections/list");
    await expect(response.json()).resolves.toEqual({
      json: [
        expect.objectContaining({
          peerBotName: "agent",
          peerOwnerLabel: "owner",
          requestVersion: 1,
          incoming: false,
        }),
      ],
    });
  });

  it.each([
    { accept: true, status: "approved" },
    { accept: false, status: "declined" },
  ])("records the answered request version when $status", async ({ accept, status }) => {
    const { handler, actor, prisma, outboundRows, enqueue } = messagingDeps({
      connection: {
        id: "ac-1",
        requesterBotId: "bot-9",
        targetBotId: "bot-1",
        status: "pending",
        requestVersion: 2,
      },
    });
    const response = await call(handler, actor, "messaging/connections/respond", {
      connectionId: "ac-1",
      requestVersion: 2,
      accept,
    });
    expect(prisma.agentConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ac-1", targetBotId: "bot-1", status: "pending", requestVersion: 2 },
        data: { status, responseVersion: 2 },
      }),
    );
    const body = await response.json();
    expect(body).toEqual({ json: expect.objectContaining({ status, requestVersion: 2 }) });
    expect(body.json).not.toHaveProperty("responseVersion");
    expect(outboundRows).toEqual(
      accept
        ? [
            expect.objectContaining({
              idempotencyKey: "command:connected:ac-1",
              kind: "dm",
              identityId: "mi-9",
            }),
          ]
        : [],
    );
    expect(enqueue).toHaveBeenCalledTimes(accept ? 1 : 0);
  });

  it("rejects respond from the requester side", async () => {
    const outgoing = messagingDeps({
      connection: { id: "ac-2", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    const response = await call(outgoing.handler, outgoing.actor, "messaging/connections/respond", {
      connectionId: "ac-2",
      requestVersion: 1,
      accept: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("revokes an approved connection from either side", async () => {
    const { handler, actor, prisma } = messagingDeps({
      connection: {
        id: "ac-3",
        requesterBotId: "bot-1",
        targetBotId: "bot-9",
        status: "approved",
        requestVersion: 2,
      },
    });
    const response = await call(handler, actor, "messaging/connections/revoke", {
      connectionId: "ac-3",
      requestVersion: 2,
    });
    expect(prisma.agentConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ac-3", status: "approved", requestVersion: 2 },
        data: { status: "revoked", revocationVersion: 2 },
      }),
    );
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it.each([
    { action: "respond", accept: true },
    { action: "respond", accept: false },
    { action: "revoke" },
  ])(
    "rejects stale $action before writing the new request (accept=$accept)",
    async ({ action, accept }) => {
      const { handler, actor, prisma, outboundRows, enqueue } = messagingDeps({
        connection: {
          id: "ac-1",
          requesterBotId: "bot-9",
          targetBotId: "bot-1",
          status: "pending",
          requestVersion: 2,
        },
      });
      const invite = { idempotencyKey: "connect:bot-9:bot-1", kind: "dm", status: "pending" };
      outboundRows.push(invite);
      const response = await call(handler, actor, `messaging/connections/${action}`, {
        connectionId: "ac-1",
        requestVersion: 1,
        accept,
      });

      expect(response.status).toBe(404);
      expect(prisma.agentConnection.updateMany).not.toHaveBeenCalled();
      expect(prisma.messagingOutbound.deleteMany).not.toHaveBeenCalled();
      expect(outboundRows).toEqual([invite]);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, 1.5, 2_147_483_648, "2"])(
    "requires a positive PostgreSQL integer request version (%j)",
    async (requestVersion) => {
      const { handler, actor, prisma, outboundRows } = messagingDeps();
      const input = { connectionId: "ac-1", requestVersion };
      expect(
        (await call(handler, actor, "messaging/connections/respond", { ...input, accept: true }))
          .status,
      ).toBe(400);
      expect((await call(handler, actor, "messaging/connections/revoke", input)).status).toBe(400);
      expect(prisma.agentConnection.findFirst).not.toHaveBeenCalled();
      expect(prisma.agentConnection.updateMany).not.toHaveBeenCalled();
      expect(outboundRows).toEqual([]);
    },
  );

  it("cancels a pending connect invite when revoking a re-requested connection", async () => {
    const { handler, actor, prisma, outboundRows } = messagingDeps({
      connection: { id: "ac-4", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      identityId: "mi-9",
      body: "wants to connect",
      status: "pending",
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9-already-sent",
      kind: "dm",
      status: "sent",
    });

    const response = await call(handler, actor, "messaging/connections/revoke", {
      connectionId: "ac-4",
      requestVersion: 1,
    });

    expect(prisma.messagingOutbound.deleteMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "connect:bot-1:bot-9",
        OR: [{ status: "pending" }, { status: "sent", providerHandle: null }],
      },
    });
    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "connect:bot-1:bot-9-already-sent",
        status: "sent",
      }),
    ]);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("cancels a claimed-but-undelivered connect invite on revoke", async () => {
    const { handler, actor, outboundRows } = messagingDeps({
      connection: {
        id: "ac-claimed",
        requesterBotId: "bot-1",
        targetBotId: "bot-9",
        status: "pending",
      },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "sent",
      providerHandle: null,
      body: "claimed by drain",
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9-delivered",
      kind: "dm",
      status: "sent",
      providerHandle: "h-delivered",
    });

    const response = await call(handler, actor, "messaging/connections/revoke", {
      connectionId: "ac-claimed",
      requestVersion: 1,
    });

    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "connect:bot-1:bot-9-delivered",
        providerHandle: "h-delivered",
      }),
    ]);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("revokes status and cancels invites in one transaction", async () => {
    const { handler, actor, prisma, outboundRows } = messagingDeps({
      connection: { id: "ac-5", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "pending",
    });
    const order: string[] = [];
    const connectionModel = prisma.agentConnection as unknown as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    const baseUpdateMany = connectionModel.updateMany.bind(connectionModel);
    const baseDeleteMany = prisma.messagingOutbound.deleteMany;
    (prisma as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        order.push("tx-start");
        const result = await fn({
          [Symbol.for("prisma.client.transaction.scope_context")]: { txId: "revoke-fixture" },
          agentConnection: {
            updateMany: async (args: unknown) => {
              order.push("update");
              return baseUpdateMany(args);
            },
          },
          messagingOutbound: {
            deleteMany: async (args: unknown) => {
              order.push("delete");
              return baseDeleteMany(args as never);
            },
          },
        });
        order.push("tx-end");
        return result;
      },
    );

    const response = await call(handler, actor, "messaging/connections/revoke", {
      connectionId: "ac-5",
      requestVersion: 1,
    });

    expect(order).toEqual(["tx-start", "update", "delete", "tx-end"]);
    expect(outboundRows).toEqual([]);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("does not delete a reconnect invite created after revoke commits", async () => {
    const { handler, actor, prisma, outboundRows } = messagingDeps({
      connection: { id: "ac-6", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "pending",
      body: "old invite",
    });
    const connectionModel = prisma.agentConnection as unknown as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    const baseUpdateMany = connectionModel.updateMany.bind(connectionModel);
    const baseDeleteMany = prisma.messagingOutbound.deleteMany;
    (prisma as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          [Symbol.for("prisma.client.transaction.scope_context")]: { txId: "reconnect-fixture" },
          agentConnection: {
            updateMany: async (args: unknown) => baseUpdateMany(args),
          },
          messagingOutbound: {
            deleteMany: async (args: unknown) => baseDeleteMany(args as never),
          },
        }),
    );

    await call(handler, actor, "messaging/connections/revoke", {
      connectionId: "ac-6",
      requestVersion: 1,
    });
    expect(outboundRows).toEqual([]);

    // Reconnect after revoke has committed: its fresh invite must survive.
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "pending",
      body: "fresh reconnect invite",
    });
    expect(prisma.messagingOutbound.deleteMany).toHaveBeenCalledTimes(1);
    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "connect:bot-1:bot-9",
        body: "fresh reconnect invite",
      }),
    ]);
  });

  it.each(["approved", "pending"])(
    "does not let a stale revoke of %s v1 overwrite a newer pending request",
    async (status) => {
      const { handler, actor, prisma, outboundRows } = messagingDeps({
        connection: {
          id: "ac-stale",
          requesterBotId: "bot-1",
          targetBotId: "bot-9",
          status,
        },
      });
      const state = { status, requestVersion: 1 };
      const invite = {
        idempotencyKey: "connect:bot-1:bot-9",
        kind: "dm",
        status: "pending",
        body: "new request invite",
      };
      const connectionModel = prisma.agentConnection as unknown as Record<string, unknown>;
      connectionModel.findFirst = vi.fn(async () => {
        const snapshot = {
          id: "ac-stale",
          requesterBotId: "bot-1",
          targetBotId: "bot-9",
          ...state,
        };
        Object.assign(state, { status: "pending", requestVersion: 2 });
        outboundRows.push(invite);
        return snapshot;
      });
      connectionModel.updateMany = vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status?: string; requestVersion?: number };
          data: Record<string, unknown>;
        }) => {
          if (
            (where.status && state.status !== where.status) ||
            (where.requestVersion !== undefined && state.requestVersion !== where.requestVersion)
          )
            return { count: 0 };
          Object.assign(state, data);
          return { count: 1 };
        },
      );
      const response = await call(handler, actor, "messaging/connections/revoke", {
        connectionId: "ac-stale",
        requestVersion: 1,
      });

      expect(state).toEqual({ status: "pending", requestVersion: 2 });
      expect(outboundRows).toEqual([invite]);
      expect(response.status).toBe(404);
    },
  );
});

describe("messaging status-write races", () => {
  it.each([
    { status: "revoked", requestVersion: 1 },
    { status: "pending", requestVersion: 2 },
  ])(
    "does not apply a response when the request changes to $status v$requestVersion",
    async (next) => {
      const { handler, actor, prisma, outboundRows } = messagingDeps();
      const state = { status: "pending", requestVersion: 1, responseVersion: null };
      const connectionModel = prisma.agentConnection as unknown as Record<string, unknown>;
      connectionModel.findFirst = vi.fn(async () => {
        const snapshot = {
          id: "ac-1",
          requesterBotId: "bot-9",
          targetBotId: "bot-1",
          ...state,
        };
        Object.assign(state, next);
        return snapshot;
      });
      connectionModel.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data);
        return state;
      });
      connectionModel.updateMany = vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status: string; requestVersion: number };
          data: Record<string, unknown>;
        }) => {
          if (state.status !== where.status || state.requestVersion !== where.requestVersion)
            return { count: 0 };
          Object.assign(state, data);
          return { count: 1 };
        },
      );
      const response = await call(handler, actor, "messaging/connections/respond", {
        connectionId: "ac-1",
        requestVersion: 1,
        accept: true,
      });

      expect(state).toEqual({ ...next, responseVersion: null });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(outboundRows).toHaveLength(0);
    },
  );

  it("does not overwrite a concurrent leave when responding to a channel invite", async () => {
    const { handler, actor, prisma } = messagingDeps();
    const state = { status: "invited" };
    const memberModel = prisma.messagingChannelMember as unknown as Record<string, unknown>;
    memberModel.findFirst = vi.fn(async () => {
      const snapshot = {
        id: "cm-1",
        channelId: "ch-1",
        address: "+15551111111",
        identityId: "mi-1",
        status: state.status,
        channel: { id: "ch-1", provider: "sendblue", name: "Family", members: [{ id: "cm-1" }] },
      };
      // Interleaved: the owner left (or was swept out) after the read.
      state.status = "left";
      return snapshot;
    });
    memberModel.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return state;
    });
    memberModel.updateMany = vi.fn(
      async ({ where, data }: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (where.status && state.status !== where.status) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    );
    const response = await call(handler, actor, "messaging/channels/respond", {
      membershipId: "cm-1",
      accept: true,
    });

    expect(state.status).toBe("left");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("messaging.connections.respond confirmation atomicity", () => {
  it("writes the requester confirmation under the claim's transaction", async () => {
    const { handler, actor, prisma, outboundRows } = messagingDeps();
    // Track the transaction-scoped outbox delegate separately: a revoke can
    // only be excluded from the confirmation window if the claim's row lock
    // is still held when the confirmation row is written.
    const txCreateMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      outboundRows.push(...data);
      return { count: data.length };
    });
    (prisma as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          [Symbol.for("prisma.client.transaction.scope_context")]: { txId: "confirm-fixture" },
          agentConnection: prisma.agentConnection,
          messagingIdentity: prisma.messagingIdentity,
          messagingOutbound: {
            createMany: txCreateMany,
            deleteMany: vi.fn(async () => ({ count: 0 })),
          },
        }),
    );
    const response = await call(handler, actor, "messaging/connections/respond", {
      connectionId: "ac-1",
      requestVersion: 1,
      accept: true,
    });

    expect(response.status).toBe(200);
    expect(txCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ idempotencyKey: "command:connected:ac-1" })],
      }),
    );
  });
});
