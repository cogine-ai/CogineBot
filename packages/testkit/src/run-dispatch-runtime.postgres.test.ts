import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { ComposioEmulator, ScriptedAgentRuntime } from "@rakazo/adapters";
import { createDb } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const wait = (assertion: () => Promise<void> | void) =>
  vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

async function rpc<T>(
  handles: AppHandles,
  cookie: string,
  procedure: string,
  body: unknown = {},
): Promise<T> {
  const response = await handles.app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ json: body }),
  });
  const value = (await response.json()) as { json: T };
  expect(response.status).toBe(200);
  return value.json;
}

async function openApp(runtime = new ScriptedAgentRuntime()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "run-dispatch-fixture-"));
  const { createApp } = await import("../../../apps/api/src/app.ts");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    realtimeDatabaseUrl: process.env.DATABASE_URL!,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    runtime,
    wakeupDriver: "graphile",
    defaultProvider: "scripted",
    defaultModel: "scripted",
    signupsEnabled: "true",
    authUrl: origin,
    webOrigin: origin,
    composio: new ComposioEmulator(),
    encryptionKey: "synthetic-dispatch-fixture-encryption-key",
  });
  return {
    handles,
    runtime,
    close: async () => {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function seed(handles: AppHandles, label: string) {
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      name: "Fixture",
      email: `${randomUUID()}@example.test`,
      password: "password12",
    }),
  });
  expect(signup.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(signup);
  const me = await rpc<{ userId: string; spaceId: string }>(handles, cookie, "me");
  const bot = await rpc<{ id: string }>(handles, cookie, "bots/create", {
    name: "Fixture",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await wait(async () =>
    expect(
      await handles.prisma.run.count({
        where: { botId: bot.id, status: { notIn: ["completed", "cancelled", "failed"] } },
      }),
    ).toBe(0),
  );
  const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
  const identity = { userId: me.userId, spaceId: me.spaceId, botId: bot.id, threadId: thread.id };
  const task = await handles.prisma.task.create({
    data: { ...identity, prompt: `Reply to ${label}.`, status: "queued" },
  });
  const run = await handles.prisma.run.create({
    data: { ...identity, taskId: task.id, trigger: "user", status: "queued" },
  });
  return { ...identity, run };
}

describe.skipIf(!enabled)("API direct run composition (PostgreSQL)", () => {
  it("loads the stored actor and Space when a wake carries conflicting metadata", async () => {
    const f = await openApp();
    try {
      const [a, b] = await Promise.all([seed(f.handles, "actor A"), seed(f.handles, "actor B")]);
      const original = f.runtime.run.bind(f.runtime);
      const captured = vi
        .spyOn(f.runtime, "run")
        .mockImplementation(async function* (request, context) {
          if (request.runId === b.run.id) {
            expect(context).toMatchObject({
              userId: b.userId,
              spaceId: b.spaceId,
              botId: b.botId,
              runId: b.run.id,
            });
          }
          yield* original(request, context);
        });
      await f.handles.jobs.enqueue({
        ...runContinueJob(b.run.id),
        payload: { runId: b.run.id, userId: a.userId, spaceId: a.spaceId, botId: a.botId },
      } as BackgroundJob);
      await wait(async () =>
        expect(
          (await f.handles.prisma.run.findUniqueOrThrow({ where: { id: b.run.id } })).status,
        ).toBe("completed"),
      );
      expect(captured.mock.calls.filter(([request]) => request.runId === b.run.id)).toHaveLength(1);
      expect(await f.handles.prisma.attempt.count({ where: { runId: a.run.id } })).toBe(0);
      expect(
        await f.handles.prisma.run.findUniqueOrThrow({ where: { id: b.run.id } }),
      ).toMatchObject({ userId: b.userId, spaceId: b.spaceId, botId: b.botId });
      expect(
        await f.handles.prisma.message.count({ where: { runId: b.run.id, threadId: a.threadId } }),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("starts a fifth unrelated chat while four runs are waiting on external work", async () => {
    const f = await openApp();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const seeded = await Promise.all(
        Array.from({ length: 5 }, (_, index) => seed(f.handles, `parallel ${index}`)),
      );
      const waiting = new Set(seeded.slice(0, 4).map(({ run }) => run.id));
      const entered = new Set<string>();
      const original = f.runtime.run.bind(f.runtime);
      const runtime = vi
        .spyOn(f.runtime, "run")
        .mockImplementation(async function* (request, context) {
          entered.add(request.runId);
          if (waiting.has(request.runId)) await blocked;
          yield* original(request, context);
        });
      try {
        await Promise.all(
          seeded.slice(0, 4).map(({ run }) => f.handles.jobs.enqueue(runContinueJob(run.id))),
        );
        await wait(() => expect(entered.size).toBe(4));
        const fifth = seeded[4]!;
        await f.handles.jobs.enqueue(runContinueJob(fifth.run.id));
        await wait(async () => {
          const completed = await f.handles.prisma.run.findUniqueOrThrow({
            where: { id: fifth.run.id },
          });
          expect(completed.status).toBe("completed");
          expect(completed.firstResponseAt).toBeInstanceOf(Date);
        });
        expect(
          await f.handles.prisma.run.count({
            where: { id: { in: [...waiting] }, status: "running" },
          }),
        ).toBe(4);
        expect(entered.size).toBe(5);
      } finally {
        release();
        await wait(async () =>
          expect(
            await f.handles.prisma.run.count({
              where: { id: { in: seeded.map(({ run }) => run.id) }, status: "completed" },
            }),
          ).toBe(5),
        );
        runtime.mockRestore();
      }
    } finally {
      release();
      await f.close();
    }
  });

  it("does not claim future work through a stale direct delivery", async () => {
    const f = await openApp();
    try {
      const seeded = await seed(f.handles, "future run");
      const expected = await f.handles.prisma.run.update({
        where: { id: seeded.run.id },
        data: { wakeAt: new Date(Date.now() + 60_000) },
      });
      await f.handles.executor.continueRun(seeded.run.id, "stale-delivery");
      expect(
        await f.handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      ).toEqual(expected);
      expect(await f.handles.prisma.attempt.count({ where: { runId: seeded.run.id } })).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("makes repeated stop calls wait for active work, then resumes the same run", async () => {
    const f = await openApp();
    const observer = createDb(process.env.DATABASE_URL!);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = () => {};
    const sawAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let restore = () => {};
    try {
      const seeded = await seed(f.handles, "shutdown handback");
      const original = f.runtime.run.bind(f.runtime);
      const run = vi.spyOn(f.runtime, "run").mockImplementation(async function* (request, context) {
        if (request.runId !== seeded.run.id) {
          yield* original(request, context);
          return;
        }
        context?.signal?.addEventListener("abort", aborted, { once: true });
        started();
        await released;
      });
      restore = () => run.mockRestore();
      await f.handles.jobs.enqueue(runContinueJob(seeded.run.id));
      await entered;
      let firstDone = false;
      let secondDone = false;
      const first = f.handles.stop().then(() => {
        firstDone = true;
      });
      const second = f.handles.stop().then(() => {
        secondDone = true;
      });
      await sawAbort;
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);
      release();
      await Promise.all([first, second]);
      expect(
        await observer.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      ).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null, error: null });
      expect(await observer.prisma.attempt.findMany({ where: { runId: seeded.run.id } })).toEqual([
        expect.objectContaining({ status: "interrupted" }),
      ]);
      expect(
        await observer.prisma.event.count({
          where: { runId: seeded.run.id, type: { in: ["run.failed", "run.cancelled"] } },
        }),
      ).toBe(0);
      restore();
      const recovered = await openApp();
      try {
        await recovered.handles.jobs.enqueue(runContinueJob(seeded.run.id));
        await wait(async () =>
          expect(
            (await observer.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).status,
          ).toBe("completed"),
        );
        expect(
          await observer.prisma.attempt.findMany({
            where: { runId: seeded.run.id },
            orderBy: { fence: "asc" },
          }),
        ).toEqual([
          expect.objectContaining({ status: "interrupted", fence: 1 }),
          expect.objectContaining({ status: "completed", fence: 2 }),
        ]);
      } finally {
        await recovered.close();
      }
    } finally {
      release();
      restore();
      await f.close();
      await observer.prisma.$disconnect();
      await observer.pool.end();
    }
  });
});
