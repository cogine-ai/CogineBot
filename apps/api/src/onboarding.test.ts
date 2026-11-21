import type * as db from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, markAppConnected } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[] }>);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted", seq: 8 };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    connection: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    message: {
      findMany: vi.fn(async () => [
        { id: "choice", seq: 7, blocks: [{ kind: "choice", answerId: null }] },
      ]),
      update: vi.fn(async () => ({ seq: 7 })),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn(async () => undefined) },
    connectors: { managedProviders: () => [{ catalog: async () => catalog }] },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}
describe("onboarding connection suggestions", () => {
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([
      expect.objectContaining({ connectorId: "pipedream", provider: "slack", name: "Slack" }),
    ]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  tx.connection.findFirst.mockResolvedValue({ id: "connection" });
  tx.message.findMany.mockResolvedValue([{ id: "cards", seq: 7, blocks }] as never);
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "cards"),
  ).resolves.toEqual({
    connected: true,
    pendingConnectionId: null,
  });
  expect(tx.connection.findFirst).toHaveBeenCalledWith({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      connectorId: "pipedream",
      provider: { equals: "slack", mode: "insensitive" },
      status: "connected",
    },
    select: { id: true },
  });
  expect(tx.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "cards", threadId: "thread", role: "bot" },
    }),
  );
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
  expect(appendEventInTransaction).toHaveBeenLastCalledWith(
    tx,
    expect.objectContaining({
      type: "thread.message.updated",
      payload: expect.objectContaining({ messageId: "cards", messageSeq: 7 }),
    }),
  );
});

it("does not change a card without a connected account in this Space", async () => {
  const { deps, actor, tx } = fixture([]);
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "cards"),
  ).resolves.toEqual({
    connected: false,
    pendingConnectionId: null,
  });
  expect(tx.connection.findFirst).toHaveBeenCalledTimes(1);
  expect(tx.message.update).not.toHaveBeenCalled();
});

it("recovers only a pending chat grant for the specified card", async () => {
  const { deps, actor, tx } = fixture([]);
  tx.connection.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "pending" });
  tx.message.findMany.mockResolvedValue([
    {
      id: "cards",
      seq: 7,
      blocks: [
        { kind: "app_connect", connectorId: "pipedream", provider: "slack", status: "pending" },
      ],
    },
  ] as never);
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "cards"),
  ).resolves.toEqual({
    connected: false,
    pendingConnectionId: "pending",
  });
  expect(tx.connection.findFirst).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        connectorId: "pipedream",
        provider: { equals: "slack", mode: "insensitive" },
        status: "pending",
        metadata: { path: ["chatAppGrant"], equals: true },
      },
    }),
  );
});
