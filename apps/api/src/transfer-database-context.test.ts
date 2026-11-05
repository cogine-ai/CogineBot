import { randomUUID } from "node:crypto";
import { createRouterClient, ORPCError } from "@orpc/server";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const transferId = "a".repeat(43);
const digest = "a".repeat(64);
const revision = { transferId, expectedRevision: 1 };
const cases = [
  [
    "start",
    {
      targetBotId: "bot-owned",
      sourceOrigin: "https://source.example.test",
      clientNonce: randomUUID(),
    },
  ],
  ["preview", { mode: "target", ...revision, decisions: [] }],
  ["propose", { ...revision, selected: [{ itemKey: "item", revision: randomUUID() }] }],
  ["approve", { ...revision, planDigest: digest, expectedSourceFingerprint: digest }],
  [
    "commit",
    {
      ...revision,
      planDigest: digest,
      expectedTargetFingerprint: digest,
      clientNonce: randomUUID(),
    },
  ],
  ["status", { transferId }],
  ["recent", { botId: "bot-owned" }],
  ["cancel", revision],
] as const;

it.each(cases)(
  "scopes transfer %s without replacing its protocol authorization context",
  async (method, input) => {
    const context = {
      actor: null,
      sessionAuthenticated: true,
      sessionId: "verified-session",
      sessionUserId: "verified-user",
    };
    let observed: unknown;
    const probe = vi.fn(async (actualContext: unknown) => {
      await Promise.resolve();
      observed = currentDbContext();
      expect(actualContext).toEqual(context);
      throw new ORPCError("CONFLICT", { message: "Context probe" });
    });
    const client = createRouterClient(
      createRouter({
        prisma: {},
        env: {},
        deploymentTransfer: { [method]: probe },
      } as unknown as RouterDeps),
      { context },
    );
    const call = client.transfer[method] as (value: unknown) => Promise<unknown>;
    const ambient = { spaceId: "space-unrelated", userId: "user-unrelated" };
    await runAsTenant(ambient, async () => {
      await expect(call(input)).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Context probe",
      });
      expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(observed).toEqual({ kind: "system", reason: "deployment transfer RPC" });
  },
);
