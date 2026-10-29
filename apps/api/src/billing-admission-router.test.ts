import { createRouterClient, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user-fake",
  spaceId: "space-fake",
  email: "fake@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const assertAccess = vi.fn(async () => {
    throw new ORPCError("PAYMENT_REQUIRED", {
      status: 402,
      data: { reason: "subscription_required" },
    });
  });
  const touch = vi.fn(() => {
    throw new Error("Side effect reached before admission");
  });
  const prisma = {
    bot: { findFirst: touch },
    run: { findFirst: touch },
    routine: { findFirst: touch },
    user: { findUniqueOrThrow: touch },
  };
  const deps = {
    prisma,
    billing: { assertAccess },
    events: { sendUserMessage: touch },
    jobs: { enqueue: touch },
    env: {
      webOrigin: "https://app.example.test",
      screenProxySecret: "fake",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/fake-billing-admission",
  } as unknown as RouterDeps;
  return {
    assertAccess,
    touch,
    client: createRouterClient(createRouter(deps), { context: { actor } }),
  };
}

describe("billing admission at actual user-start RPC boundaries", () => {
  it.each([
    ["bot create", (c: ReturnType<typeof fixture>["client"]) => c.bots.create({ name: "Bot" })],
    [
      "bot duplicate",
      (c: ReturnType<typeof fixture>["client"]) => c.bots.duplicate({ botId: "bot-fake" }),
    ],
    [
      "message send",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.threads.send({ botId: "bot-fake", text: "Hello" }),
    ],
    [
      "follow up",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.threads.followUp({ botId: "bot-fake", text: "Hello" }),
    ],
    [
      "answer",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.threads.answer({
          botId: "bot-fake",
          runId: "run-fake",
          messageId: "message-fake",
          answer: "Yes",
        }),
    ],
    [
      "computer boot",
      (c: ReturnType<typeof fixture>["client"]) => c.computer.boot({ botId: "bot-fake" }),
    ],
    [
      "computer recover",
      (c: ReturnType<typeof fixture>["client"]) => c.computer.recover({ botId: "bot-fake" }),
    ],
    [
      "computer reset",
      (c: ReturnType<typeof fixture>["client"]) => c.computer.reset({ botId: "bot-fake" }),
    ],
    [
      "computer update",
      (c: ReturnType<typeof fixture>["client"]) => c.computer.update({ botId: "bot-fake" }),
    ],
    [
      "computer takeover",
      (c: ReturnType<typeof fixture>["client"]) => c.computer.takeover({ botId: "bot-fake" }),
    ],
    [
      "computer input",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.computer.input({ botId: "bot-fake", kind: "key", payload: { key: "A" } }),
    ],
    [
      "computer upload",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.computer.uploadFile({ botId: "bot-fake", path: "/fake.txt", contentBase64: "" }),
    ],
    [
      "terminal capability",
      (c: ReturnType<typeof fixture>["client"]) => c.computer.terminalUrl({ botId: "bot-fake" }),
    ],
    [
      "active routine create",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.routines.create({
          botId: "bot-fake",
          name: "Routine",
          prompt: "Run",
          crons: ["0 9 * * *"],
          active: true,
        }),
    ],
    [
      "routine test",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.routines.testRun({ routineId: "routine-fake" }),
    ],
    [
      "teaching start",
      (c: ReturnType<typeof fixture>["client"]) =>
        c.skills.start({ botId: "bot-fake", goal: "Teach" }),
    ],
    [
      "teaching test",
      (c: ReturnType<typeof fixture>["client"]) => c.skills.testRun({ skillId: "skill-fake" }),
    ],
  ] as const)("rejects %s before the target lookup, writes or dispatch", async (_name, invoke) => {
    const f = fixture();
    await expect(invoke(f.client)).rejects.toMatchObject({
      status: 402,
      data: { reason: "subscription_required" },
    });
    expect(f.assertAccess).toHaveBeenCalledExactlyOnceWith(actor);
    expect(f.touch).not.toHaveBeenCalled();
  });
  it("does not apply admission to safe billing recovery", async () => {
    const f = fixture();
    await expect(f.client.billing.status()).rejects.toBeDefined();
    expect(f.assertAccess).not.toHaveBeenCalled();
  });
});

it("distinguishes verified session without membership from an expired session", async () => {
  const router = createRouter({
    prisma: {},
    env: { webOrigin: "https://app.example.test" },
    dataDir: "/tmp/fake-recovery",
  } as unknown as RouterDeps);
  const noSpace = createRouterClient(router, {
    context: { actor: null, sessionAuthenticated: true },
  });
  const expired = createRouterClient(router, {
    context: { actor: null, sessionAuthenticated: false },
  });
  await expect(noSpace.me()).rejects.toMatchObject({
    status: 403,
    code: "FORBIDDEN",
    data: { reason: "space_forbidden" },
  });
  await expect(expired.me()).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
});

it("serializes the payment signal as HTTP402 rather than an unknown-code500", async () => {
  const assertAccess = vi.fn(async () => {
    throw new ORPCError("PAYMENT_REQUIRED", {
      status: 402,
      data: { reason: "subscription_required" },
    });
  });
  const handler = new RPCHandler(
    createRouter({
      prisma: {},
      billing: { assertAccess },
      env: { webOrigin: "https://app.example.test" },
      dataDir: "/tmp/fake-recovery",
    } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("https://app.example.test/rpc/threads/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot-fake", text: "hello" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response.status).toBe(402);
  expect(await response.json()).toMatchObject({
    json: { code: "PAYMENT_REQUIRED", data: { reason: "subscription_required" } },
  });
});

it("allows disabling a routine but rejects editing an active one before any mutation", async () => {
  const denied = vi.fn(async () => {
    throw new ORPCError("PAYMENT_REQUIRED", { status: 402 });
  });
  const target = vi.fn(async () => {
    throw new Error("target read reached");
  });
  const router = createRouter({
    prisma: {
      routine: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "routine-fake", botId: "bot-fake", active: true }),
      },
      bot: { findFirst: target },
    },
    billing: { assertAccess: denied },
    env: { webOrigin: "https://app.example.test" },
    dataDir: "/tmp/fake-recovery",
  } as unknown as RouterDeps);
  const client = createRouterClient(router, { context: { actor } });
  await expect(
    client.routines.update({ routineId: "routine-fake", name: "Updated" }),
  ).rejects.toMatchObject({ status: 402 });
  expect(target).not.toHaveBeenCalled();
  denied.mockClear();
  await expect(
    client.routines.update({ routineId: "routine-fake", active: false }),
  ).rejects.toThrow("target read reached");
  expect(denied).not.toHaveBeenCalled();
});
