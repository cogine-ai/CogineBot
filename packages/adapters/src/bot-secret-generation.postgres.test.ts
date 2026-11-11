import { randomUUID } from "node:crypto";
import { GenerateSecretInput } from "@rakazo/contracts";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { answerRunInput, clearEndedRunState, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeExternalEffect } from "./approval-effect.js";
import {
  findLoginFillAuthority,
  generateBotSecret,
  resolveLoginFill,
  shellCommandEnvironment,
} from "./bot-secrets.js";
import {
  createLoginGenerationEffect,
  loadLoginGenerationInput,
  loginGenerationEffectArgs,
  readLoginEffectRequest,
} from "./generated-login-request.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("generated credential receipts (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let scope: { userId: string; spaceId: string; botId: string };
  let threadId: string;
  const secretStore = new EncryptedSecretStore("test-only-generated-credential-key");
  const login = {
    type: "login",
    origin: "https://LOGIN.example.test:443/",
    username: "fixture@example.test",
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = withSecretPersistence(db.prisma, secretStore);
    await prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Generated credential fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    const spaceId = (
      await prisma.space.create({ data: { id: randomUUID(), organizationId, name: "Fixture" } })
    ).id;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Fixture", color: "ink" },
    });
    scope = { userId, spaceId, botId: bot.id };
    threadId = (await prisma.thread.create({ data: { ...scope } })).id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function action(name: string, status = "executing", options: Record<string, unknown> = {}) {
    const args = GenerateSecretInput.parse({
      name,
      type: "command",
      purpose: "Generate a fixture password",
      ...options,
    });
    const task = await prisma.task.create({
      data: { ...scope, threadId, prompt: "Generate a fixture password", status: "running" },
    });
    const run = await prisma.run.create({
      data: { ...scope, threadId, taskId: task.id, status: "running", trigger: "user" },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        runId: run.id,
        spaceId: scope.spaceId,
        kind: "generate_secret",
        status,
        idempotencyKey: `generated-credential:${run.id}`,
        request: args,
      },
    });
    return {
      effect,
      run,
      readEffect: () => prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
      generate: () =>
        generateBotSecret({
          prisma,
          secretStore,
          scope,
          args,
          lockRun: async (tx) => {
            await tx.run.update({
              where: { id: run.id, status: "running" },
              data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
            });
          },
          commitReceipt: async (tx, result) => {
            if (!(await completeExternalEffect(tx, effect.id, "executing", result)))
              throw new Error("Fixture effect ownership changed");
          },
        }),
    };
  }

  it("exports the saved value through the existing scoped shell environment", async () => {
    const first = await action("fixture-database");
    const generated = await first.generate();
    const receipt = {
      saved: true,
      name: "fixture-database",
      auth: { type: "command" },
      variable: "FIXTURE_DATABASE",
    };
    expect(generated).toMatchObject({ result: receipt });
    expect(await first.readEffect()).toMatchObject({ status: "completed", result: receipt });
    const registerRedactions = vi.fn();
    const { env } = await shellCommandEnvironment({
      prisma,
      secretStore,
      scope,
      spaceEnvironment: { FIXTURE_DATABASE: "lower-precedence-value" },
      registerRedactions,
    });
    const value = env.FIXTURE_DATABASE!;
    expect(value).toHaveLength(20);
    expect(registerRedactions).toHaveBeenCalledWith(expect.arrayContaining([value]));
    const otherBot = await prisma.bot.create({
      data: { userId, spaceId: scope.spaceId, name: "Other fixture", color: "ink" },
    });
    expect(
      await shellCommandEnvironment({
        prisma,
        secretStore,
        scope: { ...scope, botId: otherBot.id },
        spaceEnvironment: {},
        registerRedactions: vi.fn(),
      }),
    ).toEqual({ env: {}, unsetEnv: [] });

    const second = await action("fixture-database");
    expect(await second.generate()).toEqual({ error: expect.stringContaining("already exists") });
    const row = await prisma.botSecret.findFirstOrThrow({
      where: { ...scope, name: "fixture-database" },
    });
    expect(row.ciphertext).not.toContain(value);
    expect(await secretStore.load(row.ciphertext, row.id)).toBe(value);
  });

  it("does not commit a receipt on an environment alias conflict", async () => {
    await (await action("fixture-duplicate")).generate();
    const alias = await action("fixture_duplicate");
    const remove = vi.spyOn(secretStore, "delete");
    try {
      expect(await alias.generate()).toEqual({
        error: expect.stringContaining("already exported"),
      });
      expect(await alias.readEffect()).toMatchObject({ status: "executing", result: null });
      expect(await prisma.botSecret.count({ where: { ...scope, name: "fixture_duplicate" } })).toBe(
        0,
      );
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      remove.mockRestore();
    }
  });

  it("generates an editable login that can be filled by label and exported as the same password", async () => {
    const name = "fixture-site";
    const generated = await action(name, "executing", { ...login, command: true });
    const result = {
      saved: true,
      name,
      origin: "https://login.example.test",
      auth: { type: "login" },
      command: {
        name: "fixture-site-password",
        auth: { type: "command" },
        variable: "FIXTURE_SITE_PASSWORD",
      },
    };
    expect(await generated.generate()).toMatchObject({ result });
    expect(await generated.readEffect()).toMatchObject({ status: "completed", result });

    const fill = (field: string) => resolveLoginFill({ prisma, secretStore, scope, name, field });
    expect(await fill("  USERNAME  ")).toMatchObject({
      origin: result.origin,
      field: "username",
      text: login.username,
    });
    const password = await fill("Password");
    if ("error" in password) throw new Error(password.error);
    const { env } = await shellCommandEnvironment({
      prisma,
      secretStore,
      scope,
      spaceEnvironment: {},
      registerRedactions: vi.fn(),
    });
    expect(password).toMatchObject({
      origin: result.origin,
      field: "password",
      text: env.FIXTURE_SITE_PASSWORD,
      redactions: expect.arrayContaining([env.FIXTURE_SITE_PASSWORD]),
    });
    expect(password.text).toHaveLength(20);
    expect(JSON.stringify(await generated.readEffect())).not.toContain(password.text);
    const row = await prisma.botSecret.findFirstOrThrow({ where: { ...scope, name } });
    expect(row.ciphertext).not.toContain(password.text);
    expect(row.auth).toEqual({ type: "login" });
    expect(JSON.parse(await secretStore.load(row.ciphertext, row.id))).toEqual({
      username: login.username,
      password: password.text,
    });

    const computer = await prisma.computer.create({
      data: {
        spaceId: scope.spaceId,
        userId,
        kind: "fake",
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
      },
    });
    await prisma.bot.update({ where: { id: scope.botId }, data: { computerId: computer.id } });
    const workerId = "fixture-worker";
    const fence = 7;
    const live = new Date(Date.now() + 60_000);
    const expired = new Date(0);
    const renewRun = (leaseExpiresAt: Date) =>
      prisma.run.update({
        where: { id: generated.run.id },
        data: { leaseOwner: workerId, leaseFence: fence, leaseExpiresAt },
      });
    await renewRun(live);
    const computerLease = {
      computerId: computer.id,
      runId: generated.run.id,
      botId: scope.botId,
      fence: 12,
    };
    const lease = await prisma.computerExecutionLease.create({
      data: { ...computerLease, expiresAt: live },
    });
    const check = (credential = password.credential) =>
      findLoginFillAuthority(prisma, {
        scope,
        runId: generated.run.id,
        workerId,
        fence,
        computerId: computer.id,
        computerLease,
        credentials: [credential],
      });
    expect(await check()).toMatchObject({ bot: { disabledBuiltinTools: [] } });
    await renewRun(expired);
    expect(await check()).toBeNull();
    await renewRun(live);
    await prisma.computerExecutionLease.update({
      where: { id: lease.id },
      data: { expiresAt: expired },
    });
    expect(await check()).toBeNull();
    await prisma.computerExecutionLease.update({
      where: { id: lease.id },
      data: { expiresAt: live },
    });
    const updated = await prisma.botSecret.update({
      where: { id: row.id },
      data: { revision: randomUUID() },
    });
    expect(await check()).toBeNull();
    expect(await check({ id: row.id, revision: updated.revision })).not.toBeNull();
  });

  it("rolls back both stages and the receipt when the paired environment alias conflicts", async () => {
    await (await action("fixture_alias_password")).generate();
    const name = "fixture-alias";
    const paired = await action(name, "executing", { ...login, command: true });
    const remove = vi.spyOn(secretStore, "delete");
    try {
      expect(await paired.generate()).toEqual({
        error: expect.stringContaining("already exported"),
      });
      expect(await paired.readEffect()).toMatchObject({ status: "executing", result: null });
      expect(
        await prisma.botSecret.count({
          where: { ...scope, name: { in: [name, `${name}-password`] } },
        }),
      ).toBe(0);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(
        await prisma.botSecret.count({ where: { ...scope, name: "fixture_alias_password" } }),
      ).toBe(1);
    } finally {
      remove.mockRestore();
    }
  });

  it("cleans the first staged login when staging the command credential fails", async () => {
    const name = "fixture-stage-error";
    const paired = await action(name, "executing", { ...login, command: true });
    const originalPut = secretStore.put.bind(secretStore);
    const put = vi
      .spyOn(secretStore, "put")
      .mockImplementationOnce(originalPut)
      .mockRejectedValueOnce(new Error("Fixture command staging failed"));
    const remove = vi.spyOn(secretStore, "delete");
    try {
      expect(await paired.generate()).toEqual({
        error: "The credential could not be prepared. No credential was saved.",
      });
      expect(put).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledOnce();
      expect(await paired.readEffect()).toMatchObject({ status: "executing", result: null });
      expect(
        await prisma.botSecret.count({
          where: { ...scope, name: { in: [name, `${name}-password`] } },
        }),
      ).toBe(0);
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
  });

  it.each(["deny", "cancel"] as const)(
    "clears protected login input after %s",
    async (terminal) => {
      const f = await action(`fixture-protected-${terminal}`);
      const args = GenerateSecretInput.parse({
        ...login,
        name: `fixture-protected-${terminal}`,
        purpose: "Prepare fixture sign-in",
        command: true,
      });
      if (args.type !== "login") throw new Error("Fixture expects a website login");
      const effectKey = approvalEffectKey(
        f.run.id,
        "generate_secret",
        loginGenerationEffectArgs(f.run.id, args),
      );
      expect(effectKey).not.toBe(approvalEffectKey(f.run.id, "generate_secret", args));
      expect(effectKey).not.toBe(
        approvalEffectKey(
          f.run.id,
          "generate_secret",
          loginGenerationEffectArgs(f.run.id, { ...args, username: "other@example.test" }),
        ),
      );
      const signal = new AbortController().signal;
      const effect = await createLoginGenerationEffect({
        prisma,
        secretStore,
        run: f.run,
        args,
        context: { ...scope, runId: f.run.id, operationId: f.run.id, traceId: f.run.id, signal },
        data: {
          runId: f.run.id,
          spaceId: scope.spaceId,
          idempotencyKey: effectKey,
          kind: "generate_secret",
          status: "intended",
          request: {},
        },
        lockRun: async (tx) =>
          (
            await tx.run.updateMany({
              where: { id: f.run.id, status: "running" },
              data: { leaseFence: 1 },
            })
          ).count === 1,
      });
      expect(JSON.stringify(effect.request)).not.toContain(args.username);
      const request = readLoginEffectRequest(effect.request);
      if (!request) throw new Error("Fixture is missing its protected reference");
      const lookup = { prisma, secretStore, run: f.run, effectKey, request, signal };
      const row = await prisma.secret.findUniqueOrThrow({ where: { id: request.inputId } });
      expect(row.ciphertext).not.toContain(args.username);
      expect(await loadLoginGenerationInput(lookup)).toEqual(args);
      expect(
        await loadLoginGenerationInput({ ...lookup, effectKey: "unrelated-effect" }),
      ).toBeUndefined();
      if (terminal === "deny") {
        await prisma.run.update({ where: { id: f.run.id }, data: { status: "waiting_input" } });
        const message = await prisma.message.create({
          data: {
            threadId,
            runId: f.run.id,
            seq: 1,
            role: "bot",
            botId: scope.botId,
            blocks: [
              {
                kind: "ask",
                text: "Review before saving a new credential",
                approvalEffectId: effect.id,
                status: "pending",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        });
        expect(
          await answerRunInput(prisma, {
            ...scope,
            threadId,
            runId: f.run.id,
            messageId: message.id,
            answeredByUserId: userId,
            answer: "deny",
          }),
        ).toBe(true);
        expect(
          await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
        ).toMatchObject({ status: "denied" });
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
          await clearEndedRunState(tx, [f.run]);
        });
      }
      expect(await prisma.secret.findUnique({ where: { id: request.inputId } })).toBeNull();
      expect(await loadLoginGenerationInput(lookup)).toBeUndefined();
    },
  );

  it("adopts one candidate when independent Run actions compete for a name", async () => {
    const first = await action("fixture-race");
    const second = await action("fixture-race");
    let release!: () => void;
    const bothPrepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalPut = secretStore.put.bind(secretStore);
    let staged = 0;
    const put = vi.spyOn(secretStore, "put").mockImplementation(async (...args) => {
      const record = await originalPut(...args);
      if (++staged === 2) release();
      await bothPrepared;
      return record;
    });
    const remove = vi.spyOn(secretStore, "delete");
    try {
      const results = await Promise.all([first.generate(), second.generate()]);
      expect(results.filter((entry) => "result" in entry)).toHaveLength(1);
      expect(results.filter((entry) => "error" in entry)).toEqual([
        { error: expect.stringContaining("already exists") },
      ]);
      const receipts = await Promise.all([first.readEffect(), second.readEffect()]);
      expect(receipts.map((entry) => entry.status).sort()).toEqual(["completed", "executing"]);
      const rows = await prisma.botSecret.findMany({ where: { ...scope, name: "fixture-race" } });
      expect(rows).toHaveLength(1);
      expect(remove).toHaveBeenCalledOnce();
      expect(remove.mock.calls[0]![0]).not.toBe(rows[0]!.ciphertext);
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
  });

  it("treats an existing name as occupied even when its saved destination is no longer allowed", async () => {
    const name = "fixture-retired-api";
    const legacy = await prisma.botSecret.create({
      data: {
        id: randomUUID(),
        ...scope,
        name,
        origin: "http://192.0.2.10",
        auth: { type: "bearer" },
        ciphertext: "fixture-retained-reference",
      },
    });
    const generation = await action(name);
    const put = vi.spyOn(secretStore, "put");
    try {
      expect(await generation.generate()).toEqual({
        error: expect.stringContaining("already exists"),
      });
      expect(put).not.toHaveBeenCalled();
      expect(await prisma.botSecret.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(
        legacy,
      );
    } finally {
      put.mockRestore();
    }
  });

  it("leaves no credential when its action receipt is no longer owned", async () => {
    const name = "fixture-interrupted";
    const interrupted = await action(name, "uncertain", { ...login, command: true });
    const remove = vi.spyOn(secretStore, "delete");
    try {
      await expect(interrupted.generate()).rejects.toThrow("Fixture effect ownership changed");
      expect(await interrupted.readEffect()).toMatchObject({ status: "uncertain", result: null });
      expect(
        await prisma.botSecret.count({
          where: { ...scope, name: { in: [name, `${name}-password`] } },
        }),
      ).toBe(0);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      remove.mockRestore();
    }
  });
});
