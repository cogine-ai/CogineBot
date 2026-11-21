import { randomUUID } from "node:crypto";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectApp } from "./connect-app.js";
import type { ExecutorDeps } from "./executor.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

function provider(connectorId: string, entries: ConnectionCatalogItem[]) {
  return {
    describe: () => ({ id: connectorId }),
    catalog: vi.fn(async () => entries),
  } as unknown as ManagedConnectorProvider;
}

function entry(connectorId: string, connected = false): ConnectionCatalogItem {
  return { connectorId, slug: "GMAIL", name: "Gmail", logo: null, noAuth: false, connected };
}

describePostgres("chat app connection cards (PostgreSQL)", () => {
  let database: ReturnType<typeof createDb>;
  const userId = randomUUID();
  const spaceId = randomUUID();
  const otherSpaceId = randomUUID();
  const owner = "fixture-worker";
  const fence = 1;

  beforeAll(async () => {
    database = createDb(databaseUrl!);
    const prisma = asSystem(database.prisma);
    await prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: userId, name: "Fixture", slug: userId, createdAt: new Date() },
    });
    await prisma.space.createMany({
      data: [spaceId, otherSpaceId].map((id) => ({ id, organizationId: userId, name: "Fixture" })),
    });
  });

  afterAll(async () => {
    if (!database) return;
    const prisma = asSystem(database.prisma);
    try {
      await prisma.organization.deleteMany({ where: { id: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await database.prisma.$disconnect();
      await database.pool.end();
    }
  });

  async function fixture(providers = [provider("managed", [entry("managed")])]) {
    const prisma = asSystem(database.prisma);
    const actor = { spaceId, userId };
    const bot = await prisma.bot.create({
      data: { ...actor, name: "Fixture", color: "slate", thread: { create: actor } },
      include: { thread: true },
    });
    if (!bot.thread) throw new Error("Missing fixture thread");
    const target = { ...actor, botId: bot.id, threadId: bot.thread.id };
    const task = await prisma.task.create({
      data: { ...target, status: "running", prompt: "Connect the app in chat" },
    });
    const run = await prisma.run.create({
      data: {
        ...target,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseFence: fence,
        leaseOwner: owner,
        startedAt: new Date(),
      },
    });
    const notify = vi.fn(async () => undefined);
    const deps = {
      prisma,
      events: { notify },
      runLease: { runId: run.id, owner, fence },
    } as unknown as ExecutorDeps;
    const context = {
      ...target,
      operationId: run.id,
      traceId: run.id,
      signal: new AbortController().signal,
    };
    async function effect(status = "intended") {
      return prisma.externalEffect.create({
        data: {
          spaceId,
          runId: run.id,
          kind: "connect_app",
          idempotencyKey: randomUUID(),
          status,
          request: { app: "Google Mail" },
        },
      });
    }
    const messages = () => prisma.message.findMany({ where: { threadId: target.threadId } });
    const execute = (
      id: string,
      app = "Google Mail",
      options?: { signal?: AbortSignal; expectedStatus?: "intended" | "approved" },
    ) =>
      connectApp(
        deps,
        providers,
        { ...context, signal: options?.signal ?? context.signal },
        run,
        { app },
        { id, expectedStatus: options?.expectedStatus ?? "intended" },
        async () => undefined,
      );
    return { prisma, target, run, notify, effect, messages, execute };
  }

  it("deduplicates simultaneous calls and commits the message, event and effect together", async () => {
    const { prisma, target, effect, execute, messages, notify } = await fixture();
    const calls = await Promise.all([effect(), effect()]);
    const results = await Promise.all(calls.map(({ id }) => execute(id)));
    expect(results).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ status: "pending" }),
    ]);
    const cards = await messages();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      clientNonce: expect.stringMatching(/^connect-app:/),
      blocks: [
        expect.objectContaining({ kind: "app_connect", connectorId: "managed", provider: "GMAIL" }),
      ],
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      await prisma.event.count({
        where: { threadId: target.threadId, type: "thread.message.created" },
      }),
    ).toBe(1);
    expect(
      await prisma.externalEffect.count({
        where: { id: { in: calls.map(({ id }) => id) }, status: "completed" },
      }),
    ).toBe(2);
  });

  it("reuses the stored receipt when two deliveries share an effect", async () => {
    const { effect, execute, messages, notify } = await fixture();
    const { id } = await effect();
    const [original, replay] = await Promise.all([execute(id), execute(id)]);
    expect(original).toHaveProperty("status", "pending");
    expect(replay).toEqual(original);
    expect(await messages()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("keeps the same effect retryable when a provider catalog cannot be read", async () => {
    const source = provider("managed", [entry("managed")]);
    vi.mocked(source.catalog).mockRejectedValueOnce(new Error("fixture catalog unavailable"));
    const { prisma, effect, execute, messages } = await fixture([source]);
    const { id } = await effect();
    await expect(execute(id)).resolves.toHaveProperty("retryable", true);
    expect(await prisma.externalEffect.findUnique({ where: { id } })).toHaveProperty(
      "status",
      "intended",
    );
    expect(await messages()).toEqual([]);
    await expect(execute(id)).resolves.toHaveProperty("status", "pending");
    expect(await messages()).toHaveLength(1);
  });

  it.each(["intended", "approved"] as const)("retries an interrupted %s card", async (status) => {
    const source = provider("managed", [entry("managed")]);
    const { prisma, effect, execute, messages } = await fixture([source]);
    const { id } = await effect(status);
    const controller = new AbortController();
    let catalogEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      catalogEntered = resolve;
    });
    vi.mocked(source.catalog).mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          catalogEntered();
        }),
    );
    const interruption = expect(
      execute(id, undefined, { signal: controller.signal, expectedStatus: status }),
    ).rejects.toThrow("interrupted catalog");
    await entered;
    controller.abort(new Error("interrupted catalog"));
    await interruption;
    expect(await messages()).toEqual([]);
    expect(await prisma.externalEffect.findUnique({ where: { id } })).toHaveProperty(
      "status",
      status,
    );
    await expect(execute(id, undefined, { expectedStatus: status })).resolves.toHaveProperty(
      "status",
      "pending",
    );
    expect(await messages()).toHaveLength(1);
  });

  it("keeps old cards but opens a new one outside the most recent fifty messages", async () => {
    const { prisma, target, effect, execute, messages } = await fixture();
    await execute((await effect()).id);
    await prisma.message.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        threadId: target.threadId,
        seq: index + 1,
        role: "user",
        blocks: [{ kind: "text", text: "fixture" }],
      })),
    });
    await prisma.thread.update({ where: { id: target.threadId }, data: { nextMessageSeq: 51 } });
    await execute((await effect()).id);
    expect((await messages()).filter((message) => message.role === "bot")).toHaveLength(2);
  });

  it("rejects invalid names and mismatched connector entries before creating a card", async () => {
    const source = provider("managed", [entry("wrong")]);
    const { effect, execute, messages } = await fixture([source]);
    expect(await execute((await effect()).id, "https://example.test/authorize")).toHaveProperty(
      "error",
    );
    expect(source.catalog).not.toHaveBeenCalled();
    expect(await execute((await effect()).id)).toHaveProperty("error");
    expect(source.catalog).toHaveBeenCalledWith(expect.anything());
    expect(await messages()).toEqual([]);
  });

  it("prefers a verified connected provider and keeps accounts in other Spaces out", async () => {
    const { prisma, target, effect, execute, messages } = await fixture([
      provider("managed", [entry("managed")]),
      provider("other", [entry("other", true)]),
    ]);
    const row = await prisma.connection.create({
      data: {
        spaceId: otherSpaceId,
        userId,
        connectorId: "other",
        provider: "gmail",
        displayName: "Fixture",
        status: "connected",
      },
    });
    expect(await execute((await effect()).id)).toHaveProperty("status", "pending");
    await prisma.connection.update({ where: { id: row.id }, data: { spaceId: target.spaceId } });
    expect(await execute((await effect()).id)).toHaveProperty("status", "connected");
    expect(await messages()).toHaveLength(1);
  });

  it("rolls back a card for a superseded effect and rejects an old worker fence", async () => {
    const { prisma, run, effect, execute, messages, notify } = await fixture();
    await expect(execute((await effect("denied")).id)).resolves.toBeUndefined();
    await prisma.run.update({ where: { id: run.id }, data: { leaseFence: fence + 1 } });
    await expect(execute((await effect()).id)).resolves.toBeUndefined();
    expect(await messages()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});
