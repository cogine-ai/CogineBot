import { UpdateBotInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { EvalActor, EvalApp } from "./runner.js";
import { cleanupActors, runTrial } from "./runner.js";

const actors: EvalActor[] = [
  {
    botId: "root-bot",
    cookie: "root-session",
    userId: "eval-user",
    spaceId: "eval-space",
  },
];

function fixture(options: { failDisable?: boolean; failStop?: boolean } = {}) {
  const bots = [
    { id: "root-bot", userId: "eval-user", spaceId: "eval-space" },
    { id: "child-bot", userId: "eval-user", spaceId: "eval-space" },
  ];
  const runs = [
    { id: "root-run", botId: "root-bot", status: "running" },
    { id: "child-run", botId: "child-bot", status: "running" },
  ];
  const order: string[] = [];
  let lateChildCreated = false;
  let releaseQuietAbort!: () => void;
  const quietAbort = new Promise<void>((resolve) => {
    releaseQuietAbort = resolve;
  });
  const updateMany = vi.fn(async () => {
    order.push("disable");
    if (options.failDisable) throw new Error("database unavailable");
    return { count: 1 };
  });
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { json: { botId: string } };
    order.push(`stop:${body.json.botId}`);
    for (const run of runs) if (run.botId === body.json.botId) run.status = "cancelled";
    return Response.json({ json: { ok: true } }, { status: options.failStop ? 500 : 200 });
  });
  const cancel = vi.fn(async (key: string) => {
    order.push(`cancel:${key}`);
  });
  const abort = vi.fn(async (runId: string) => {
    order.push(`abort:${runId}`);
    if (runId === "root-run" && !lateChildCreated) {
      lateChildCreated = true;
      bots.push({ id: "late-child-bot", userId: "eval-user", spaceId: "eval-space" });
      runs.push({ id: "late-child-run", botId: "late-child-bot", status: "running" });
    }
    if (runId === "child-run") await quietAbort;
  });
  const findRuns = vi.fn(async (args: { select: { status?: boolean } }) =>
    runs.map((run) => (args.select.status ? { id: run.id, status: run.status } : { id: run.id })),
  );
  const handles = {
    app: { request },
    jobs: { cancel },
    runtime: { abort },
    prisma: {
      bot: { findMany: vi.fn(async () => bots.map((bot) => ({ ...bot }))) },
      run: { findMany: findRuns },
      routine: { updateMany, count: vi.fn(async () => 0) },
    },
  } as unknown as EvalApp;
  return {
    handles,
    order,
    updateMany,
    request,
    cancel,
    abort,
    releaseQuietAbort,
  };
}

describe("eval trial isolation", () => {
  it("awaits quiet runtime aborts and catches descendants created during root abort", async () => {
    const f = fixture();
    let settled = false;
    const cleanup = cleanupActors(f.handles, actors).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(f.abort).toHaveBeenCalledWith("child-run"));
    expect(settled).toBe(false);
    f.releaseQuietAbort();
    await cleanup;

    expect(f.request).toHaveBeenCalledWith(
      "/rpc/threads/stop",
      expect.objectContaining({ headers: expect.objectContaining({ cookie: "root-session" }) }),
    );
    expect(f.order.indexOf("disable")).toBeLessThan(f.order.indexOf("stop:root-bot"));
    expect(f.order).toContain("stop:child-bot");
    expect(f.order).toContain("stop:late-child-bot");
    expect(f.cancel).toHaveBeenCalledWith("run:late-child-run");
    expect(f.abort).toHaveBeenCalledWith("late-child-run");
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: "eval-user", spaceId: "eval-space" }] },
      data: { active: false, nextRunAt: null },
    });
  });

  it.each([[{ failDisable: true }], [{ failStop: true }]])(
    "attempts cancellation and fails cleanup after a cleanup operation fails",
    async (options) => {
      const f = fixture(options);
      f.releaseQuietAbort();
      await expect(cleanupActors(f.handles, actors)).rejects.toThrow("could not be stopped");
      expect(f.cancel).toHaveBeenCalledWith("run:root-run");
      expect(f.abort).toHaveBeenCalledWith("root-run");
    },
  );
});

describe("eval actor model setup", () => {
  it("pins the actor with the saved connection identity and revision", async () => {
    const actor = { id: "bot", userId: "user", spaceId: "space" };
    const pins: unknown[] = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/sign-up/email")
        return Response.json({}, { headers: { "set-cookie": "session=synthetic" } });
      if (url === "/rpc/models/connect")
        return Response.json({ json: { id: "saved-connection", connectionRevision: 7 } });
      if (url === "/rpc/bots/create") return Response.json({ json: { id: actor.id } });
      if (url === "/rpc/bots/update") {
        const body = JSON.parse(String(init?.body)) as { json: unknown };
        const parsed = UpdateBotInput.safeParse(body.json);
        if (!parsed.success) return Response.json({ error: "invalid binding" }, { status: 400 });
        pins.push(parsed.data);
        return Response.json({ json: { id: actor.id } });
      }
      if (url === "/rpc/threads/stop") return Response.json({ json: { ok: true } });
      if (url === "/rpc/memory/list") return Response.json({ json: [] });
      throw new Error(`Unexpected fixture call ${url}`);
    });
    const handles = {
      app: { request },
      jobs: { cancel: vi.fn() },
      runtime: { abort: vi.fn() },
      stop: vi.fn(),
      prisma: {
        bot: {
          findUniqueOrThrow: vi.fn(async () => actor),
          findUnique: vi.fn(async () => actor),
          findMany: vi.fn(async () => [actor]),
        },
        run: { findMany: vi.fn(async () => []) },
        attempt: { count: vi.fn(async () => 0) },
        routine: {
          findMany: vi.fn(async () => []),
          updateMany: vi.fn(async () => ({ count: 0 })),
          count: vi.fn(async () => 0),
        },
        event: { findMany: vi.fn(async () => []) },
        usageRecord: { findMany: vi.fn(async () => []) },
      },
    } as unknown as EvalApp;
    const result = await runTrial(
      {
        id: "binding-fixture",
        purpose: "Validate fixture setup",
        steps: [],
        connections: [],
        grade: () => [{ id: "setup", pass: true }],
      },
      1,
      {
        connection: {
          provider: "openai-compatible",
          modelId: "same-model",
          baseUrl: "http://localhost:11434/v1",
        },
        timeoutMs: 1000,
        maxToolCalls: 1,
        createApp: async () => handles,
      },
    );
    expect(result).toMatchObject({ status: "passed", cleanupFailed: false });
    expect(pins).toEqual([
      {
        botId: actor.id,
        modelProvider: "openai-compatible",
        modelId: "same-model",
        modelCredentialId: "saved-connection",
        expectedRevision: 7,
      },
    ]);
    expect(handles.stop).toHaveBeenCalledOnce();
  });
});
