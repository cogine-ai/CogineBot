import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

it("keeps late thread message and Run classification reads in the authenticated tenant", async () => {
  const actor: Actor = {
    spaceId: "space-thread",
    userId: "user-thread",
    email: "thread@example.test",
    isDeploymentOwner: false,
  };
  const observed: Array<{ step: string; context: unknown }> = [];
  const capture = (step: string) => observed.push({ step, context: currentDbContext() });
  const event = {
    id: "event-message",
    spaceId: actor.spaceId,
    botId: "bot-thread",
    threadId: "thread-owned",
    seq: 1,
    type: "thread.message.created",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { messageId: "message-late" },
  };
  const prisma = {
    bot: {
      findFirst: vi.fn(async () => {
        capture("target");
        return { id: "bot-thread", ...actor, thread: { id: "thread-owned" } };
      }),
    },
    message: {
      findFirst: vi.fn(async () => {
        await Promise.resolve();
        capture("message");
        return { runId: "run-late" };
      }),
    },
    run: {
      findUnique: vi.fn(async () => {
        await Promise.resolve();
        capture("run");
        return { trigger: "user" };
      }),
    },
  };
  const follow = {
    next: vi.fn(async () => ({ done: false as const, value: event })),
    return: vi.fn(async () => {
      capture("cleanup");
      return { done: true as const, value: undefined };
    }),
  };
  const client = createRouterClient(
    createRouter({
      prisma,
      env: {},
      events: { follow: vi.fn(() => follow) },
    } as unknown as RouterDeps),
    { context: { actor } },
  );
  const stream = await client.threads.subscribe({ botId: "bot-thread", cursor: 0 });
  const ambient = { spaceId: "space-observer", userId: "user-observer" };
  await runAsTenant(ambient, async () => {
    expect((await stream.next()).value).toEqual(event);
    await stream.return?.(undefined);
    expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
  });
  expect(observed.map((entry) => entry.step)).toEqual([
    "target",
    "message",
    "run",
    "run",
    "cleanup",
  ]);
  for (const entry of observed)
    expect(entry.context).toEqual({ kind: "tenant", spaceId: actor.spaceId, userId: actor.userId });
  expect(prisma.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
    }),
  );
  expect(currentDbContext()).toBeUndefined();
});
