import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedSecretStore, parseModelSecret } from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { claimSteering, createDb, finalizeRun, sendUserMessage } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";
const provider = "openai-compatible";
const encryptionKey = "offline-model-connection-acceptance-key";

describePostgres("model connection HTTP acceptance", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let database: ReturnType<typeof createDb>;
  let afterSecretRead: ((secretId: string) => Promise<void>) | undefined;
  let ordinal = 0;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "model-connection-"));
    database = createDb(process.env.DATABASE_URL!);
    const instrumented = database.prisma.$extends({
      query: {
        secret: {
          async findFirst({ args, query }) {
            const row = await query(args);
            if (typeof args.where?.id === "string") await afterSecretRead?.(args.where.id);
            return row;
          },
        },
      },
    });
    handles = await createApp({
      prisma: instrumented as unknown as PrismaClient,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey,
      webOrigin: origin,
      authUrl: origin,
    });
  });
  afterEach(() => {
    afterSecretRead = undefined;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await handles?.stop();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function account() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `models-${Date.now()}-${ordinal++}@example.test`,
        password: "password12",
        name: "Model tester",
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    return { cookie, actor: { userId: me.userId, spaceId: me.spaceId } };
  }
  function raw(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T = unknown>(
    cookie: string,
    procedure: string,
    input: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const response = await raw(cookie, procedure, input, spaceId);
    const text = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${text}`);
    const result = (JSON.parse(text) as { json: T }).json;
    return discardBotIntroFromCreate(handles, cookie, procedure, result);
  }
  function input(overrides: Record<string, unknown> = {}) {
    return {
      provider,
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "same-model",
      enabledModelIds: ["same-model", "second-model"],
      apiKey: "fake-model-key",
      ...overrides,
    };
  }
  function binding(credential: ModelCredential, modelId = "same-model") {
    return {
      modelProvider: provider,
      modelId,
      modelCredentialId: credential.id,
      expectedRevision: credential.connectionRevision!,
    };
  }
  function edit(credential: ModelCredential, overrides: Record<string, unknown> = {}) {
    return input({
      credentialId: credential.id,
      expectedRevision: credential.connectionRevision!,
      ...overrides,
    });
  }
  async function bot(cookie: string) {
    return rpc<{ id: string }>(cookie, "bots/create", {
      name: "Bound bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  }

  it("creates distinct connections and keeps same-name model bindings separate", async () => {
    const { cookie } = await account();
    const first = await rpc<ModelCredential>(cookie, "models/connect", input());
    const second = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      input({ apiKey: "different-fake-key" }),
    );
    expect(first.id).not.toBe(second.id);
    expect(first.connectionRevision).toBe(1);
    expect(second.enabledModelIds).toEqual(["same-model", "second-model"]);
    const list = await rpc<ModelCredential[]>(cookie, "models/credentials");
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/fake-model-key|different-fake-key/);
    await rpc(cookie, "models/setBackups", [
      { provider, modelId: "same-model", modelCredentialId: first.id, expectedRevision: 1 },
      { provider, modelId: "same-model", modelCredentialId: second.id, expectedRevision: 1 },
    ]);
    expect(await rpc(cookie, "models/backups")).toEqual([
      { provider, modelId: "same-model", modelCredentialId: first.id },
      { provider, modelId: "same-model", modelCredentialId: second.id },
    ]);
  });

  it("reuses a saved key only for its owned ID and canonical unchanged endpoint", async () => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "same-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      const owner = await account();
      const stranger = await account();
      const credential = await rpc<ModelCredential>(
        owner.cookie,
        "models/connect",
        input({ baseUrl }),
      );
      const probe = {
        baseUrl: `${baseUrl}/`,
        expectedBaseUrl: baseUrl,
        credentialId: credential.id,
      };
      expect(await rpc(owner.cookie, "models/probeOpenAiCompatible", probe)).toEqual({
        models: ["same-model"],
      });
      expect(requests).toEqual([{ url: "/v1/models", authorization: "Bearer fake-model-key" }]);
      expect((await raw(stranger.cookie, "models/probeOpenAiCompatible", probe)).status).toBe(404);
      expect(
        (
          await raw(owner.cookie, "models/probeOpenAiCompatible", {
            ...probe,
            baseUrl: `${baseUrl}/changed`,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await raw(owner.cookie, "models/probeOpenAiCompatible", {
            ...probe,
            expectedBaseUrl: `${baseUrl}/changed`,
          })
        ).status,
      ).toBe(400);
      expect(requests).toHaveLength(1);
      await rpc(owner.cookie, "models/probeOpenAiCompatible", { ...probe, apiKey: "" });
      expect(requests[1]?.authorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("returns an unavailable error without probing when saved secret storage fails", async () => {
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const row = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    await handles.prisma.secret.update({
      where: { id: row.secretId },
      data: { ciphertext: "unreadable" },
    });
    const response = await raw(cookie, "models/probeOpenAiCompatible", {
      credentialId: credential.id,
      baseUrl: "http://127.0.0.1:1/v1",
      expectedBaseUrl: "http://127.0.0.1:1/v1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unavailable");
  });

  it("checks every pin and exposes references before shrink or disconnect", async () => {
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const target = await bot(cookie);
    await rpc(cookie, "bots/update", { botId: target.id, ...binding(credential, "second-model") });
    const refs = await rpc<{ references: Array<{ kind: string; id: string }> }>(
      cookie,
      "models/references",
      { credentialId: credential.id },
    );
    expect(refs.references).toContainEqual(expect.objectContaining({ kind: "bot", id: target.id }));
    expect(
      (await raw(cookie, "models/connect", edit(credential, { enabledModelIds: ["same-model"] })))
        .status,
    ).toBe(400);
    expect(
      (
        await raw(cookie, "models/disconnect", {
          provider,
          credentialId: credential.id,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(400);
    await rpc(cookie, "bots/update", {
      botId: target.id,
      modelProvider: null,
      modelId: null,
      modelCredentialId: null,
    });
    const saved = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      edit(credential, { enabledModelIds: ["same-model"] }),
    );
    await rpc(cookie, "models/disconnect", {
      provider,
      credentialId: credential.id,
      expectedRevision: saved.connectionRevision,
    });
    expect(await rpc(cookie, "models/credentials")).toEqual([]);
  });

  it("preserves clone and routine bindings and guards backup and active-run references", async () => {
    const { cookie, actor } = await account();
    const stranger = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    expect(
      (await raw(stranger.cookie, "models/references", { credentialId: credential.id })).status,
    ).toBe(404);
    const target = await bot(cookie);
    await rpc(cookie, "bots/update", { botId: target.id, ...binding(credential, "second-model") });
    const clone = await rpc<{ id: string; modelCredentialId: string; modelId: string }>(
      cookie,
      "bots/duplicate",
      { botId: target.id },
    );
    expect(clone).toMatchObject({ modelCredentialId: credential.id, modelId: "second-model" });
    const routine = await rpc<{ id: string; modelCredentialId: string; modelId: string }>(
      cookie,
      "routines/create",
      {
        botId: target.id,
        name: "Bound routine",
        prompt: "offline fixture",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        notify: false,
        active: false,
        ...binding(credential, "second-model"),
      },
    );
    expect(routine).toMatchObject({ modelCredentialId: credential.id, modelId: "second-model" });
    const testRun = await rpc<{ runId: string }>(cookie, "routines/testRun", {
      routineId: routine.id,
    });
    expect(
      await handles.prisma.run.findUniqueOrThrow({ where: { id: testRun.runId } }),
    ).toMatchObject({
      modelProvider: provider,
      modelId: "second-model",
      modelCredentialId: credential.id,
      modelPinned: true,
    });
    await handles.awaitIdle?.();
    for (const botId of [target.id, clone.id])
      await rpc(cookie, "bots/update", {
        botId,
        modelProvider: null,
        modelId: null,
        modelCredentialId: null,
      });
    const remove = () =>
      raw(cookie, "models/disconnect", {
        provider,
        credentialId: credential.id,
        expectedRevision: 1,
      });
    expect((await remove()).status).toBe(400);
    expect(
      (await raw(cookie, "models/connect", edit(credential, { enabledModelIds: ["same-model"] })))
        .status,
    ).toBe(400);
    expect(
      (
        await raw(cookie, "routines/update", {
          routineId: routine.id,
          modelProvider: provider,
          modelId: "second-model",
        })
      ).status,
    ).toBe(400);
    await rpc(cookie, "routines/update", {
      routineId: routine.id,
      modelProvider: null,
      modelId: null,
      modelCredentialId: null,
    });
    await rpc(cookie, "models/setBackups", [
      { provider, modelId: "second-model", modelCredentialId: credential.id, expectedRevision: 1 },
    ]);
    expect((await remove()).status).toBe(400);
    await rpc(cookie, "models/setBackups", []);
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: target.id } });
    const task = await handles.prisma.task.create({
      data: {
        ...actor,
        botId: target.id,
        threadId: thread.id,
        prompt: "offline fixture",
        status: "running",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        ...actor,
        botId: target.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        modelProvider: provider,
        modelId: "second-model",
        modelCredentialId: credential.id,
        modelPinned: true,
      },
    });
    try {
      expect((await remove()).status).toBe(400);
      const refs = await rpc<{ references: Array<{ kind: string; id: string }> }>(
        cookie,
        "models/references",
        { credentialId: credential.id },
      );
      expect(refs.references).toContainEqual(expect.objectContaining({ kind: "run", id: run.id }));
      expect(refs.references).toContainEqual(expect.objectContaining({ kind: "space-default" }));
    } finally {
      await handles.prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      await handles.prisma.task.update({ where: { id: task.id }, data: { status: "cancelled" } });
    }
    await rpc(cookie, "models/disconnect", {
      provider,
      credentialId: credential.id,
      expectedRevision: 1,
    });
  });

  it.each(["consume", "cancel"] as const)(
    "protects a deferred model after Routine rebinding until steering is %s",
    async (outcome) => {
      const { cookie, actor } = await account();
      const oldConnection = await rpc<ModelCredential>(cookie, "models/connect", input());
      const replacement = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        input({ label: "Replacement" }),
      );
      const target = await bot(cookie);
      const routine = await rpc<{ id: string }>(cookie, "routines/create", {
        botId: target.id,
        name: "Deferred model",
        prompt: "Synthetic deferred delivery",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        notify: false,
        active: false,
        ...binding(oldConnection, "second-model"),
      });
      const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: target.id } });
      const task = await handles.prisma.task.create({
        data: {
          ...actor,
          botId: target.id,
          threadId: thread.id,
          prompt: "Synthetic busy turn",
          status: "running",
        },
      });
      const busy = await handles.prisma.run.create({
        data: {
          ...actor,
          botId: target.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "created",
          modelProvider: provider,
          modelId: "same-model",
          modelCredentialId: replacement.id,
          modelPinned: true,
          leaseOwner: "steering-fixture",
          leaseFence: 1,
          startedAt: new Date(),
        },
      });
      const attempt = await handles.prisma.attempt.create({
        data: { runId: busy.id, fence: 1, status: "running" },
      });
      const sent = await sendUserMessage(handles.prisma, {
        ...actor,
        threadId: thread.id,
        botId: target.id,
        blocks: [{ kind: "text", text: "Synthetic deferred delivery" }],
        prompt: "Synthetic deferred delivery",
        trigger: "webhook",
        modelPin: {
          modelProvider: provider,
          modelId: "second-model",
          modelCredentialId: oldConnection.id,
          thinkingLevel: null,
        },
      });
      const steering = await handles.prisma.steeringMessage.findFirstOrThrow({
        where: { messageId: sent.messageId },
      });
      expect(steering).toMatchObject({
        modelCredentialId: oldConnection.id,
        runId: null,
        claimedAt: null,
      });
      await rpc(cookie, "routines/update", { routineId: routine.id, ...binding(replacement) });
      const references = () =>
        rpc<{ references: Array<{ kind: string; id: string; spaceId: string }> }>(
          cookie,
          "models/references",
          { credentialId: oldConnection.id },
        );
      const assertProtected = async () => {
        const refs = await references();
        expect(refs.references).toEqual([
          expect.objectContaining({ kind: "steering", id: steering.id, spaceId: actor.spaceId }),
        ]);
        const shrink = await raw(
          cookie,
          "models/connect",
          edit(oldConnection, { enabledModelIds: ["same-model"] }),
        );
        expect(shrink.status).toBe(400);
        expect(await shrink.text()).toContain("Bound bot");
        expect(
          (
            await raw(cookie, "models/disconnect", {
              provider,
              credentialId: oldConnection.id,
              expectedRevision: 1,
            })
          ).status,
        ).toBe(400);
      };
      await assertProtected();
      // Failed finalization can release a row without clearing its previous claim stamp.
      await handles.prisma.steeringMessage.update({
        where: { id: steering.id },
        data: { claimedAt: new Date() },
      });
      await assertProtected();
      await handles.prisma.steeringMessage.update({
        where: { id: steering.id },
        data: { claimedAt: null },
      });
      if (outcome === "consume") {
        await handles.prisma.run.update({ where: { id: busy.id }, data: { trigger: "user" } });
        expect(
          await claimSteering(handles.prisma, {
            threadId: thread.id,
            botId: target.id,
            runId: busy.id,
            leaseOwner: "steering-fixture",
            leaseFence: 1,
            seenIds: [],
          }),
        ).toEqual([expect.objectContaining({ id: steering.id, messageId: sent.messageId })]);
        expect(
          await handles.prisma.steeringMessage.findUniqueOrThrow({ where: { id: steering.id } }),
        ).toMatchObject({ runId: busy.id, claimedAt: expect.any(Date) });
        await assertProtected();
        expect(
          await finalizeRun(handles.prisma, {
            ...actor,
            botId: target.id,
            threadId: thread.id,
            runId: busy.id,
            taskId: task.id,
            attemptId: attempt.id,
            leaseOwner: "steering-fixture",
            leaseFence: 1,
            outcome: "completed",
            blocks: [],
          }),
        ).toEqual({ continuationRunId: null });
        expect(
          await handles.prisma.steeringMessage.findUnique({ where: { id: steering.id } }),
        ).toBeNull();
        expect((await references()).references).toEqual([]);
        // Retained terminal history is no longer an execution dependency.
        await handles.prisma.steeringMessage.create({
          data: {
            messageId: sent.messageId,
            botId: target.id,
            userId: actor.userId,
            runId: busy.id,
            claimedAt: new Date(),
            modelProvider: provider,
            modelId: "second-model",
            modelCredentialId: oldConnection.id,
          },
        });
        expect((await references()).references).toEqual([]);
      } else {
        await rpc(cookie, "threads/stop", { botId: target.id });
        expect(
          await handles.prisma.steeringMessage.count({ where: { messageId: sent.messageId } }),
        ).toBe(0);
        expect((await references()).references).toEqual([]);
      }
      const shrunk = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        edit(oldConnection, { enabledModelIds: ["same-model"] }),
      );
      await rpc(cookie, "models/disconnect", {
        provider,
        credentialId: oldConnection.id,
        expectedRevision: shrunk.connectionRevision,
      });
    },
  );

  it("protects another Space's active default and never copies a key to an edited address", async () => {
    const { cookie, actor } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const space = await rpc<{ id: string }>(cookie, "spaces/create", { name: "Other models" });
    await rpc(
      cookie,
      "models/setDefault",
      { provider, modelId: "second-model", modelCredentialId: credential.id, expectedRevision: 1 },
      space.id,
    );
    expect(
      (await raw(cookie, "models/connect", edit(credential, { enabledModelIds: ["same-model"] })))
        .status,
    ).toBe(400);
    const edited = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      edit(credential, { baseUrl: "http://127.0.0.1:11435/v1", apiKey: undefined }),
    );
    const row = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: edited.id },
    });
    const secret = await handles.prisma.secret.findUniqueOrThrow({ where: { id: row.secretId } });
    const plaintext = await new EncryptedSecretStore(encryptionKey).load(
      secret.ciphertext,
      secret.id,
    );
    expect(parseModelSecret(plaintext)).toMatchObject({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:11435/v1",
    });
    expect(plaintext).not.toContain("fake-model-key");
    await rpc(cookie, "models/disconnect", {
      provider,
      credentialId: credential.id,
      expectedRevision: edited.connectionRevision,
    });
    expect(
      await handles.prisma.spaceModelPreference.count({
        where: { userId: actor.userId, credentialId: credential.id },
      }),
    ).toBe(0);
  });

  it("allows exactly one edit with the same expected revision", async () => {
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const results = await Promise.all(
      ["First", "Second"].map((label) =>
        raw(cookie, "models/connect", edit(credential, { label })),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await rpc<ModelCredential[]>(cookie, "models/credentials")).toEqual([
      expect.objectContaining({ id: credential.id, connectionRevision: 2 }),
    ]);
  });

  it("serializes a new pin against an overlapping enabled-model shrink", async () => {
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const target = await bot(cookie);
    const row = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    let reached!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    afterSecretRead = async (secretId) => {
      // Auth reads outside the transaction; the next read fences the cached secret inside it.
      if (secretId === row.secretId && ++reads === 2) {
        reached();
        await resume;
      }
    };
    const pin = raw(cookie, "bots/update", {
      botId: target.id,
      ...binding(credential, "second-model"),
    });
    try {
      await inside;
      const shrink = await raw(
        cookie,
        "models/connect",
        edit(credential, { enabledModelIds: ["same-model"] }),
      );
      expect(shrink.status).toBe(200);
    } finally {
      release();
    }
    expect((await pin).status).toBe(409);
    expect(await handles.prisma.bot.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      modelProvider: null,
      modelId: null,
      modelCredentialId: null,
    });
  }, 30_000);
});
