import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function fixture() {
  const actor: Actor = {
    spaceId: "space",
    userId: "user",
    email: "user@example.test",
    isDeploymentOwner: false,
  };
  const section = {
    id: "section",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name: "Product",
    position: 0,
    createdAt: new Date("2026-10-18T00:00:00Z"),
    updatedAt: new Date("2026-10-18T00:00:00Z"),
  };
  const update = vi.fn(async ({ data }: { data: { name: string } }) =>
    Object.assign(section, data),
  );
  const create = vi.fn(
    async ({ data }: { data: { id: string; name: string; position: number } }) => ({
      ...section,
      ...data,
    }),
  );
  const prisma = {
    botSection: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; spaceId: string; userId: string } }) =>
          where.id === section.id &&
          where.spaceId === section.spaceId &&
          where.userId === section.userId
            ? section
            : null,
      ),
      update,
      create,
      findUnique: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _max: { position: 0 } })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    bot: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    chatGroup: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (run: (tx: PrismaClient) => Promise<unknown>) => run(prisma)),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/section-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (procedure: string, input: unknown, caller = actor) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/botSections/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return response;
  };
  return { actor, section, update, create, call };
}

describe("section name RPCs", () => {
  it.each(["Unassigned", "未分组"])(
    "rejects ordinary renaming to %s before writing",
    async (name) => {
      const { call, update, section } = fixture();
      const response = await call("update", { sectionId: section.id, name });
      expect(response.status).toBe(400);
      expect(update).not.toHaveBeenCalled();
      expect(section.name).toBe("Product");
    },
  );

  it("restores valid names idempotently through the guarded RPC", async () => {
    const { call, update, section } = fixture();
    const input = { sectionId: section.id, name: "Planning", expectedName: "Product" };
    expect((await call("restoreName", input)).status).toBe(200);
    expect((await call("restoreName", input)).status).toBe(200);
    expect(section.name).toBe("Planning");
    expect(update).toHaveBeenCalledOnce();
    section.name = "Later";
    expect((await call("restoreName", input)).status).toBe(409);
    expect(section.name).toBe("Later");
  });

  it.each(["Unassigned", "未分组", "Nicht zugewiesen"])(
    "rejects client-supplied %s restore targets through both RPCs",
    async (name) => {
      const { call, update, create, section } = fixture();
      expect(
        (
          await call("restoreName", {
            sectionId: section.id,
            name,
            expectedName: section.name,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("restore", {
            section: {
              id: "restored",
              name,
              position: 1,
              createdAt: section.createdAt.toISOString(),
              updatedAt: section.updatedAt.toISOString(),
            },
            botIds: [],
            groupIds: [],
          })
        ).status,
      ).toBe(400);
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(section.name).toBe("Product");
    },
  );

  it("does not restore another actor's or space's section", async () => {
    const { call, actor, section, update } = fixture();
    for (const caller of [
      { ...actor, userId: "other" },
      { ...actor, spaceId: "other-space" },
    ]) {
      const response = await call(
        "restoreName",
        { sectionId: section.id, name: "Planning", expectedName: "Product" },
        caller,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(update).not.toHaveBeenCalled();
  });
});
