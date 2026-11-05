import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { currentDbContext, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-request",
  userId: "user-request",
  email: "request@example.test",
  isDeploymentOwner: false,
};
const ambient = { spaceId: "space-other", userId: "user-other" };
const tenant = { kind: "tenant", spaceId: actor.spaceId, userId: actor.userId };

describe("trusted request database context", () => {
  it("uses the authenticated actor across awaits and restores the calling context", async () => {
    const observed: unknown[] = [];
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn(async () => {
          await Promise.resolve();
          observed.push(currentDbContext());
          return { email: actor.email, name: "Request", avatarStyle: "robot" };
        }),
      },
      spaceModelPreference: {
        findFirst: vi.fn(async () => {
          observed.push(currentDbContext());
          return null;
        }),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    };
    const client = createRouterClient(
      createRouter({
        prisma,
        env: { defaultProvider: "fake", defaultModel: "fake-model", sandboxProvider: "fake" },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    await runAsTenant(ambient, async () => {
      await client.me();
      expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
    });
    expect(observed).toEqual([tenant, tenant]);
    expect(currentDbContext()).toBeUndefined();
  });

  it("keeps two concurrent actors separate while database reads overlap", async () => {
    const second = { ...actor, spaceId: "space-second", userId: "user-second" };
    const observed: Array<{ userId: string; context: unknown }> = [];
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
          observed.push({ userId: where.id, context: currentDbContext() });
          if (++arrived === 2) release();
          await barrier;
          observed.push({ userId: where.id, context: currentDbContext() });
          return { email: actor.email, name: "Request", avatarStyle: "robot" };
        }),
      },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    };
    const router = createRouter({
      prisma,
      env: { defaultProvider: "fake", defaultModel: "fake-model", sandboxProvider: "fake" },
    } as unknown as RouterDeps);
    await Promise.all(
      [actor, second].map((caller) =>
        createRouterClient(router, { context: { actor: caller } }).me(),
      ),
    );
    expect(observed).toHaveLength(4);
    for (const entry of observed) {
      const caller = entry.userId === actor.userId ? actor : second;
      expect(entry.context).toEqual({
        kind: "tenant",
        spaceId: caller.spaceId,
        userId: caller.userId,
      });
    }
    expect(currentDbContext()).toBeUndefined();
  });

  it("keeps enabled board stream steps and cancellation in the authenticated context", async () => {
    const observed: unknown[] = [];
    const follow = {
      next: vi.fn(async () => {
        await Promise.resolve();
        observed.push({ step: "next", context: currentDbContext() });
        return {
          done: false as const,
          value: { spaceId: actor.spaceId, createdAt: "2026-01-01T00:00:00.000Z" },
        };
      }),
      return: vi.fn(async () => {
        observed.push({ step: "return", context: currentDbContext() });
        return { done: true as const, value: undefined };
      }),
    };
    const client = createRouterClient(
      createRouter({
        prisma: {},
        env: { ticketBoardEnabled: true },
        boardEvents: { follow: vi.fn(() => follow) },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    const stream = await client.boards.subscribe();
    await runAsTenant(ambient, async () => {
      expect((await stream.next()).value).toMatchObject({ spaceId: actor.spaceId });
      await stream.return?.(undefined);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
    });
    expect(observed).toEqual([
      { step: "next", context: tenant },
      { step: "return", context: tenant },
    ]);
  });

  it.each(["throw", "revocation"] as const)(
    "keeps stream cleanup scoped after %s and restores the caller",
    async (ending) => {
      const observed: unknown[] = [];
      let clock = Date.now();
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const follow = {
        next: vi.fn(async () => ({
          done: false as const,
          value: { spaceId: actor.spaceId, createdAt: "2026-01-01T00:00:00.000Z" },
        })),
        return: vi.fn(async () => {
          observed.push({ step: "cleanup", context: currentDbContext() });
          return { done: true as const, value: undefined };
        }),
      };
      const stillAuthorized = vi.fn(async () => {
        observed.push({ step: "before-check", context: currentDbContext() });
        const allowed = await runAsSystem("verify current session membership", async () => {
          observed.push({ step: "check", context: currentDbContext() });
          return false;
        });
        observed.push({ step: "after-check", context: currentDbContext() });
        return allowed;
      });
      const client = createRouterClient(
        createRouter({
          prisma: {},
          env: { ticketBoardEnabled: true },
          boardEvents: { follow: vi.fn(() => follow) },
        } as unknown as RouterDeps),
        { context: { actor, stillAuthorized } },
      );
      try {
        const stream = await client.boards.subscribe();
        await stream.next();
        await runAsTenant(ambient, async () => {
          if (ending === "throw") {
            await expect(stream.throw?.(new Error("Caller stopped"))).rejects.toThrow(
              "Caller stopped",
            );
          } else {
            clock += 10_001;
            await expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
          }
          expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
        });
        expect(observed.at(-1)).toEqual({ step: "cleanup", context: tenant });
        expect(stillAuthorized).toHaveBeenCalledTimes(ending === "revocation" ? 1 : 0);
        if (ending === "revocation") {
          expect(observed.slice(0, 3)).toEqual([
            { step: "before-check", context: tenant },
            { step: "check", context: { kind: "system", reason: expect.any(String) } },
            { step: "after-check", context: tenant },
          ]);
        }
        expect(currentDbContext()).toBeUndefined();
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each([
    { sessionAuthenticated: false, code: "UNAUTHORIZED" },
    { sessionAuthenticated: true, code: "FORBIDDEN" },
  ])("preserves authentication failure before database access ($code)", async (testCase) => {
    const query = vi.fn(() => {
      throw new Error("Unexpected database access");
    });
    const client = createRouterClient(
      createRouter({
        prisma: new Proxy({}, { get: () => query }),
        env: {},
      } as unknown as RouterDeps),
      { context: { actor: null, sessionAuthenticated: testCase.sessionAuthenticated } },
    );
    await expect(client.me()).rejects.toMatchObject({ code: testCase.code });
    expect(query).not.toHaveBeenCalled();
  });
});
