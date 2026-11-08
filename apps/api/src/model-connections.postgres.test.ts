import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import {
  ComposedSecretStore,
  EncryptedSecretStore,
  parseModelSecret,
  persistPreparedSecret,
} from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  claimSteering,
  createDb,
  createThreadEvents,
  createThreadMessage,
  finalizeRun,
  IsolationError,
  retireModelCredential,
  sendUserMessage,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";
import { deliverWebhookEvent } from "./webhook-inbound.js";

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
  let afterSecretCreate:
    | ((record: { id: string; ciphertext: string }) => Promise<void>)
    | undefined;
  let ordinal = 0;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "model-connection-"));
    database = createDb(process.env.DATABASE_URL!);
    const instrumented = database.prisma.$extends({
      query: {
        secret: {
          async create({ args, query }) {
            const row = await query(args);
            await afterSecretCreate?.(row);
            return row;
          },
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
    afterSecretCreate = undefined;
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
  function raw(
    cookie: string,
    procedure: string,
    input: unknown = {},
    spaceId?: string,
    signal?: AbortSignal,
  ) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
      signal,
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

  function externalSecrets() {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const deleted: string[] = [];
    let afterPut: ((plaintext: string, ref: string) => Promise<void>) | undefined;
    const load = ComposedSecretStore.prototype.load;
    const remove = ComposedSecretStore.prototype.delete;
    vi.spyOn(ComposedSecretStore.prototype, "put").mockImplementation(async (plaintext) => {
      const id = randomUUID();
      const ref = `synthetic-vault:${id}`;
      values.set(ref, plaintext);
      writes.push(ref);
      await afterPut?.(plaintext, ref);
      return { id, ref, ciphertext: ref };
    });
    vi.spyOn(ComposedSecretStore.prototype, "load").mockImplementation(function (ref, context) {
      if (!ref.startsWith("synthetic-vault:")) return load.call(this, ref, context);
      const value = values.get(ref);
      if (value === undefined) throw new Error("Synthetic secret was deleted");
      return Promise.resolve(value);
    });
    vi.spyOn(ComposedSecretStore.prototype, "delete").mockImplementation(
      async function (ref, context) {
        if (!ref.startsWith("synthetic-vault:")) return remove.call(this, ref, context);
        deleted.push(ref);
        values.delete(ref);
      },
    );
    return {
      values,
      writes,
      deleted,
      setAfterPut(callback: typeof afterPut) {
        afterPut = callback;
      },
    };
  }

  it("cleans a staged external secret after a concurrent model connection save wins", async () => {
    const vault = externalSecrets();
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    let release!: () => void;
    let staged!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      staged = resolve;
    });
    vault.setAfterPut(async (plaintext) => {
      if (plaintext.includes("losing-fake-key")) {
        staged();
        await held;
      }
    });
    const losing = raw(cookie, "models/connect", edit(credential, { apiKey: "losing-fake-key" }));
    await ready;
    try {
      const winner = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        edit(credential, { apiKey: "winning-fake-key" }),
      );
      expect(winner.connectionRevision).toBe(credential.connectionRevision! + 1);
    } finally {
      release();
    }
    expect((await losing).status).toBe(409);
    expect(vault.writes).toHaveLength(3);
    expect(vault.values.size).toBe(1);
    expect([...vault.values.values()][0]).toContain("winning-fake-key");
    expect(vault.deleted).toContain(vault.writes[1]);
  });

  it("cleans staged external material when an in-use model prevents shrinking", async () => {
    const vault = externalSecrets();
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const target = await bot(cookie);
    await rpc(cookie, "bots/update", { botId: target.id, ...binding(credential, "second-model") });

    const rejected = await raw(
      cookie,
      "models/connect",
      edit(credential, { enabledModelIds: ["same-model"] }),
    );

    expect(rejected.status).toBe(400);
    expect(vault.writes).toHaveLength(2);
    expect(vault.values.size).toBe(1);
    expect(vault.values.has(vault.writes[0]!)).toBe(true);
    expect(vault.deleted).toContain(vault.writes[1]);
    expect(await rpc<ModelCredential[]>(cookie, "models/credentials")).toEqual([
      expect.objectContaining({
        id: credential.id,
        connectionRevision: credential.connectionRevision,
      }),
    ]);
  });

  it("cleans a staged external secret when cancellation arrives after the put", async () => {
    const vault = externalSecrets();
    const { cookie } = await account();
    const cancelled = new AbortController();
    vault.setAfterPut(async () => {
      cancelled.abort(new Error("Synthetic request cancellation"));
    });

    const rejected = await raw(cookie, "models/connect", input(), undefined, cancelled.signal);

    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(vault.writes).toHaveLength(1);
    expect(vault.values.size).toBe(0);
    expect(vault.deleted).toContain(vault.writes[0]);
    expect(await rpc(cookie, "models/credentials")).toEqual([]);
  });

  it("keeps the prepared external secret through a rolled-back serialization retry", async () => {
    const vault = externalSecrets();
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    let attempts = 0;
    afterSecretCreate = async (record) => {
      if (record.ciphertext !== vault.writes[1]) return;
      attempts += 1;
      expect(vault.values.has(record.ciphertext)).toBe(true);
      expect(vault.deleted).not.toContain(record.ciphertext);
      if (attempts === 1)
        throw Object.assign(new Error("Synthetic serialization conflict"), { code: "P2034" });
    };

    const saved = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      edit(credential, { apiKey: "retried-fake-key" }),
    );

    expect(attempts).toBe(2);
    expect(saved.connectionRevision).toBe(credential.connectionRevision! + 1);
    expect(vault.writes).toHaveLength(2);
    expect(vault.values.size).toBe(1);
    expect(vault.values.get(vault.writes[1]!)).toContain("retried-fake-key");
    expect(vault.deleted).not.toContain(vault.writes[1]);
  });

  it("retains externally stored material when a committed write loses its acknowledgement", async () => {
    const vault = externalSecrets();
    const { actor } = await account();
    const store = new ComposedSecretStore(new EncryptedSecretStore(encryptionKey));
    const written = await store.put("committed-fake-key", {
      operationId: "test",
      traceId: "test",
      ...actor,
      signal: new AbortController().signal,
    });

    await expect(
      persistPreparedSecret(handles.prisma, store, written, async () => {
        await handles.prisma.$transaction(async (tx) =>
          tx.secret.create({
            data: {
              id: written.id,
              userId: actor.userId,
              spaceId: null,
              kind: "model",
              ciphertext: written.ciphertext,
            },
          }),
        );
        throw new Error("Synthetic lost commit acknowledgement");
      }),
    ).rejects.toThrow("Synthetic lost commit acknowledgement");

    expect(vault.values.get(written.ciphertext)).toBe("committed-fake-key");
    expect(vault.deleted).not.toContain(written.ciphertext);
    await handles.prisma.secret.delete({ where: { id: written.id } });
    expect(vault.values.size).toBe(0);
    await store.close();
  });

  it("rotates the newest catalog connection with its own saved key and limits", async () => {
    const { cookie, actor } = await account();
    const first = await rpc<ModelCredential>(cookie, "models/connect", {
      provider: "xai",
      modelId: "grok-4.6",
      apiKey: "fake-first-connection-key",
      maxTokens: 1024,
      contextWindow: 32000,
      cacheCapabilities: { scope: "connection", retentionMode: "short", retentionMs: 60000 },
    });
    const original = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: first.id },
    });
    const sibling = await handles.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "xai",
        label: "Second catalog connection",
        secretId: original.secretId,
      },
    });
    const second = await rpc<ModelCredential>(cookie, "models/connect", {
      provider: "xai",
      modelId: "grok-4.6",
      credentialId: sibling.id,
      expectedRevision: sibling.connectionRevision,
      apiKey: "fake-newest-connection-key",
      maxTokens: 2048,
      contextWindow: 64000,
      cacheCapabilities: { scope: "connection", retentionMode: "long", retentionMs: 120000 },
    });
    await rpc(cookie, "models/setDefault", {
      provider: "xai",
      modelId: "grok-4.6",
      modelCredentialId: first.id,
      expectedRevision: first.connectionRevision,
    });
    const rotated = await rpc<ModelCredential>(cookie, "models/connect", {
      provider: "xai",
      modelId: "grok-4.6",
      maxTokens: 8192,
    });
    expect(rotated).toMatchObject({
      id: sibling.id,
      connectionRevision: second.connectionRevision! + 1,
    });
    const saved = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: sibling.id },
    });
    const secret = await handles.prisma.secret.findUniqueOrThrow({ where: { id: saved.secretId } });
    const plaintext = await new EncryptedSecretStore(encryptionKey).load(
      secret.ciphertext,
      secret.id,
    );
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: "fake-newest-connection-key",
      maxTokens: 8192,
      contextWindow: 64000,
      cacheCapabilities: { scope: "connection", retentionMode: "long", retentionMs: 120000 },
    });
    expect(
      await handles.prisma.userModelCredential.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ secretId: original.secretId, connectionRevision: first.connectionRevision });
  });

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

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "persists model protocol %s and preserves or clears its encrypted headers explicitly",
    async (apiProtocol) => {
      const { cookie, actor } = await account();
      const headers = { "X-Tenant": " en ", "X-Session": "synthetic-private-session" };
      const credential = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        input({ apiProtocol, headers }),
      );
      expect(credential).toMatchObject({ apiProtocol, headerNames: Object.keys(headers) });
      expect(JSON.stringify(credential)).not.toContain("synthetic-private-session");
      expect(credential).not.toHaveProperty("headers");
      const saved = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        edit(credential, { apiKey: undefined, baseUrl: "http://127.0.0.1:11434/v1/" }),
      );
      expect(saved).toMatchObject({ apiProtocol, headerNames: Object.keys(headers) });
      const row = await handles.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credential.id },
      });
      const secret = await handles.prisma.secret.findUniqueOrThrow({ where: { id: row.secretId } });
      expect(secret).toMatchObject({ userId: actor.userId, spaceId: null });
      expect(
        parseModelSecret(
          await new EncryptedSecretStore(encryptionKey).load(secret.ciphertext, secret.id),
        ),
      ).toMatchObject({ apiProtocol, headers, apiKey: "fake-model-key" });
      const cleared = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        edit(saved, { apiKey: undefined, headers: {} }),
      );
      expect(cleared).toMatchObject({ apiProtocol, headerNames: [] });
      const preferences = await handles.prisma.spaceModelPreference.findMany({
        where: { userId: actor.userId, credentialId: credential.id },
      });
      expect(preferences).toEqual([
        expect.objectContaining({ spaceId: actor.spaceId, credentialId: credential.id }),
      ]);
    },
  );

  it("rejects unsupported stored model protocol edits and probes without mutating the connection", async () => {
    const vault = externalSecrets();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "same-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      const { cookie, actor } = await account();
      const credential = await rpc<ModelCredential>(cookie, "models/connect", input({ baseUrl }));
      const before = await handles.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credential.id },
      });
      const stored = await handles.prisma.secret.findUniqueOrThrow({
        where: { id: before.secretId },
      });
      const preferences = await handles.prisma.spaceModelPreference.findMany({
        where: { userId: actor.userId, credentialId: credential.id },
      });
      for (const invalid of [
        { apiProtocol: "future-wire" },
        { apiProtocol: null },
        { apiProtocol: 8 },
        { apiProtocol: "" },
        { headers: null },
        { headers: { "X-Tenant": "" } },
      ]) {
        vault.values.set(
          stored.ciphertext,
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl,
            apiKey: "old-private-key",
            ...invalid,
          }),
        );
        const edited = await raw(
          cookie,
          "models/connect",
          edit(credential, { baseUrl, apiKey: "new-private-key" }),
        );
        expect(edited.status).toBe(400);
        expect(await edited.text()).not.toMatch(/old-private-key|new-private-key/);
        const probed = await raw(cookie, "models/probeOpenAiCompatible", {
          credentialId: credential.id,
          expectedBaseUrl: baseUrl,
          baseUrl,
          apiKey: "new-private-key",
        });
        expect(probed.status).toBe(400);
        expect(await probed.text()).toContain("unavailable");
        expect(requests).toBe(0);
        expect(vault.writes).toHaveLength(1);
        expect(
          await handles.prisma.userModelCredential.findUniqueOrThrow({
            where: { id: credential.id },
          }),
        ).toEqual(before);
        expect(
          await handles.prisma.spaceModelPreference.findMany({
            where: { userId: actor.userId, credentialId: credential.id },
          }),
        ).toEqual(preferences);
      }
      const fresh = await rpc<ModelCredential>(
        cookie,
        "models/connect",
        edit(credential, { baseUrl: `${baseUrl}/different`, apiKey: "fresh-private-key" }),
      );
      const freshRow = await handles.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: fresh.id },
      });
      const freshSecret = await handles.prisma.secret.findUniqueOrThrow({
        where: { id: freshRow.secretId },
      });
      const freshConfig = parseModelSecret(vault.values.get(freshSecret.ciphertext)!);
      expect(freshConfig).toMatchObject({
        kind: "openai_compatible",
        baseUrl: `${baseUrl}/different/v1`,
        apiKey: "fresh-private-key",
      });
      expect(freshConfig).not.toHaveProperty("apiProtocol");
      expect(freshConfig).not.toHaveProperty("headers");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
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

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "uses the exact saved model protocol and headers for %s discovery without borrowing on a new endpoint",
    async (apiProtocol) => {
      const requests: Array<Record<string, string | string[] | undefined>> = [];
      const server = createServer((request, response) => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          apiKey: request.headers["x-api-key"],
          version: request.headers["anthropic-version"],
          tenant: request.headers["x-tenant"],
        });
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
          input({ baseUrl, apiProtocol, headers: { "X-Tenant": " en " } }),
        );
        const probe = { credentialId: credential.id, expectedBaseUrl: baseUrl, baseUrl };
        expect((await raw(stranger.cookie, "models/probeOpenAiCompatible", probe)).status).toBe(
          404,
        );
        expect(requests).toHaveLength(0);
        expect(await rpc(owner.cookie, "models/probeOpenAiCompatible", probe)).toEqual({
          models: ["same-model"],
        });
        expect(requests[0]).toEqual({
          url: "/v1/models",
          authorization: apiProtocol === "anthropic-messages" ? undefined : "Bearer fake-model-key",
          apiKey: apiProtocol === "anthropic-messages" ? "fake-model-key" : undefined,
          version: apiProtocol === "anthropic-messages" ? "2023-06-01" : undefined,
          tenant: "en",
        });
        await rpc(owner.cookie, "models/probeOpenAiCompatible", {
          ...probe,
          apiKey: "replacement-private-key",
        });
        expect(requests[1]).toMatchObject({
          tenant: "en",
          authorization:
            apiProtocol === "anthropic-messages" ? undefined : "Bearer replacement-private-key",
          apiKey: apiProtocol === "anthropic-messages" ? "replacement-private-key" : undefined,
        });
        await rpc(owner.cookie, "models/probeOpenAiCompatible", {
          ...probe,
          apiKey: "",
          headers: {},
        });
        expect(requests[2]).toMatchObject({
          tenant: undefined,
          authorization: undefined,
          apiKey: undefined,
        });
        const load = vi
          .spyOn(ComposedSecretStore.prototype, "load")
          .mockRejectedValueOnce(new SecretStoreUnavailableError());
        await rpc(owner.cookie, "models/probeOpenAiCompatible", {
          ...probe,
          baseUrl: `http://127.0.0.1:${address.port}/changed/v1`,
          apiKey: "fresh-private-key",
        });
        expect(load).not.toHaveBeenCalled();
        expect(requests[3]).toEqual({
          url: "/changed/v1/models",
          authorization: "Bearer fresh-private-key",
          apiKey: undefined,
          version: undefined,
          tenant: undefined,
        });
        load.mockRestore();
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("preserves unavailable model storage and mutation failures without disclosing header values", async () => {
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      input({
        apiProtocol: "responses",
        headers: { "X-Tenant": ' api-mutation-private-canary"\\value ' },
      }),
    );
    const logged = vi.spyOn(getLogger(), "error");
    try {
      const before = await handles.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credential.id },
      });
      const load = vi
        .spyOn(ComposedSecretStore.prototype, "load")
        .mockRejectedValue(
          new SecretStoreUnavailableError(503, '503: X-Tenant=api-mutation-private-canary"\\value'),
        );
      const put = vi.spyOn(ComposedSecretStore.prototype, "put");
      const editResponse = await raw(
        cookie,
        "models/connect",
        edit(credential, { apiKey: "replacement-private-key" }),
      );
      expect(editResponse.status).toBe(503);
      expect(await editResponse.text()).not.toMatch(
        /api-mutation-private-canary|replacement-private-key/,
      );
      const probeResponse = await raw(cookie, "models/probeOpenAiCompatible", {
        credentialId: credential.id,
        baseUrl: credential.baseUrl,
        expectedBaseUrl: credential.baseUrl,
      });
      expect(probeResponse.status).toBe(503);
      expect(await probeResponse.text()).not.toContain("api-mutation-private-canary");
      const listed = await raw(cookie, "models/credentials");
      expect(listed.status).toBe(503);
      expect(await listed.text()).not.toContain("api-mutation-private-canary");
      expect(put).not.toHaveBeenCalled();
      expect(
        await handles.prisma.userModelCredential.findUniqueOrThrow({
          where: { id: credential.id },
        }),
      ).toEqual(before);
      load.mockRestore();
      put.mockRejectedValueOnce(
        new Error('Database write reflected api-mutation-private-canary"\\value'),
      );
      const failedWrite = await raw(
        cookie,
        "models/connect",
        edit(credential, { headers: { "X-Tenant": 'api-mutation-private-canary"\\value' } }),
      );
      expect(failedWrite.status).toBe(500);
      expect(await failedWrite.text()).not.toContain("api-mutation-private-canary");
      expect(
        await handles.prisma.userModelCredential.findUniqueOrThrow({
          where: { id: credential.id },
        }),
      ).toEqual(before);
      expect(inspect(logged.mock.calls, { depth: 6 })).not.toContain("api-mutation-private-canary");
    } finally {
      logged.mockRestore();
    }
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

  it("trusts only authenticated owner steering claimed by the current Run", async () => {
    const { cookie, actor } = await account();
    const foreign = await account();
    await rpc<ModelCredential>(cookie, "models/connect", input());
    const target = await bot(cookie);
    const prisma = handles.prisma;
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: target.id } });
    const scope = { ...actor, botId: target.id, threadId: thread.id };
    const task = await prisma.task.create({
      data: { ...scope, prompt: "Existing conversation", status: "running" },
    });
    const lease = { leaseOwner: "steering-provenance-worker", leaseFence: 2 };
    const run = await prisma.run.create({
      data: {
        ...scope,
        ...lease,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    try {
      const events = createThreadEvents(prisma);
      const send = (text: string) =>
        rpc<{ seq: number; runId: string }>(cookie, "threads/send", { botId: target.id, text });
      const owner = await send("Read https://owner.example.test/report");
      const webhook = await deliverWebhookEvent(
        { events, jobs: { enqueue: vi.fn(async () => undefined) } },
        { bot: { id: target.id, ...actor }, threadId: thread.id },
        { source: "webhook", prompt: "Read https://webhook.example.test/report", routines: [] },
      );
      expect([owner.runId, webhook.runId]).toEqual([run.id, run.id]);
      const message = (seq: number) =>
        prisma.message.findUniqueOrThrow({
          where: { threadId_seq: { threadId: thread.id, seq } },
          select: { id: true, role: true, authorUserId: true, clientNonce: true },
        });
      const ownerMessage = await message(owner.seq);
      expect(ownerMessage).toEqual({
        id: expect.any(String),
        role: "user",
        authorUserId: actor.userId,
        clientNonce: null,
      });
      await expect(message(webhook.seq)).resolves.toEqual({
        id: webhook.messageId,
        role: "user",
        authorUserId: null,
        clientNonce: null,
      });

      const releasedMessage = await message((await send("Previously claimed owner text")).seq);
      const oldClaim = new Date(0);
      const released = await prisma.steeringMessage.update({
        where: { messageId_botId: { messageId: releasedMessage.id, botId: target.id } },
        // A failed Run can release a row while leaving the previous claim timestamp.
        data: { runId: null, claimedAt: oldClaim },
      });
      const other = await prisma.run.create({
        data: { ...scope, taskId: task.id, status: "completed", trigger: "user" },
      });
      const seed = async (text: string, authorUserId: string, runId: string | null) => {
        const message = await createThreadMessage(prisma, {
          threadId: thread.id,
          role: "user",
          authorUserId,
          blocks: [{ kind: "text", text }],
        });
        return prisma.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: target.id,
            userId: actor.userId,
            runId,
            ...(runId === null ? { originTrigger: "messaging" } : {}),
          },
        });
      };
      const foreignRow = await seed("Foreign author", foreign.actor.userId, run.id);
      const otherRow = await seed("Different Run", actor.userId, other.id);
      const pending = await seed("Pending other channel", actor.userId, null);
      const claim = {
        threadId: thread.id,
        botId: target.id,
        runId: run.id,
        ...lease,
        seenIds: [],
      };
      await expect(events.claimSteering({ ...claim, leaseFence: 1 })).resolves.toEqual([]);
      expect(
        await prisma.steeringMessage.count({ where: { botId: target.id, claimedAt: null } }),
      ).toBe(5);
      const releasedState = () =>
        prisma.steeringMessage.findUniqueOrThrow({
          where: { id: released.id },
          select: { runId: true, claimedAt: true },
        });
      await expect(releasedState()).resolves.toEqual({ runId: null, claimedAt: oldClaim });

      const claimed = await events.claimSteering(claim);
      expect(claimed.map(({ messageId }) => messageId)).toEqual([
        ownerMessage.id,
        webhook.messageId,
        releasedMessage.id,
        foreignRow.messageId,
      ]);
      expect(
        claimed.filter(({ ownerInput }) => ownerInput).map(({ messageId }) => messageId),
      ).toEqual([ownerMessage.id, releasedMessage.id]);
      const currentClaim = await releasedState();
      expect(currentClaim.runId).toBe(run.id);
      expect(currentClaim.claimedAt?.getTime()).toBeGreaterThan(oldClaim.getTime());
      await expect(events.claimSteering(claim)).resolves.toEqual(claimed);
      await expect(releasedState()).resolves.toEqual(currentClaim);
      const unclaimed = await prisma.steeringMessage.findMany({
        where: { botId: target.id, claimedAt: null },
        select: { id: true, runId: true },
      });
      expect(new Set(unclaimed)).toEqual(
        new Set([
          { id: otherRow.id, runId: other.id },
          { id: pending.id, runId: null },
        ]),
      );
    } finally {
      await rpc(cookie, "threads/stop", { botId: target.id });
    }
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
          routineIds: [routine.id],
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

  it("lets users disconnect a credential once its only active use is a quota wait", async () => {
    const { cookie, actor } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const target = await bot(cookie);
    const thread = await handles.prisma.thread.findFirstOrThrow({
      where: { botId: target.id, spaceId: actor.spaceId },
    });
    const scope = { ...actor, botId: target.id, threadId: thread.id };
    const task = await handles.prisma.task.create({
      data: { ...scope, prompt: "Synthetic parked work", status: "running" },
    });
    const run = await handles.prisma.run.create({
      data: {
        ...scope,
        modelProvider: provider,
        modelId: "same-model",
        modelCredentialId: credential.id,
        taskId: task.id,
        trigger: "tickets",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const remove = () =>
      raw(cookie, "models/disconnect", {
        provider,
        credentialId: credential.id,
        expectedRevision: credential.connectionRevision,
      });
    expect((await remove()).status).toBe(400);
    const beganAt = new Date();
    const until = new Date(beganAt.getTime() + 60_000);
    await handles.prisma.run.update({
      where: { id: run.id },
      data: {
        status: "waiting_limit",
        wakeAt: until,
        leaseExpiresAt: null,
        quotaWait: {
          beganAt: beganAt.toISOString(),
          until: until.toISOString(),
          revision: 1,
          dispatchedFence: null,
          target: {
            provider,
            modelId: "same-model",
            modelCredentialId: credential.id,
            connectionRevision: credential.connectionRevision,
            endpointDigest: "a".repeat(64),
            costOwner: "user",
          },
        },
      },
    });
    expect((await remove()).status).toBe(200);
    expect(
      await handles.prisma.userModelCredential.findUnique({ where: { id: credential.id } }),
    ).toBeNull();
  });

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

  async function inboundCaptureFixture(held = false) {
    const { cookie, actor } = await account();
    const original = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      input({ reasoning: true }),
    );
    const replacement = await rpc<ModelCredential>(
      cookie,
      "models/connect",
      input({ reasoning: true, label: "Replacement" }),
    );
    const target = await bot(cookie);
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: target.id } });
    const routines = await Promise.all(
      ["First", "Second"].map((name) =>
        rpc<{ id: string }>(cookie, "routines/create", {
          botId: target.id,
          name: `Inbound ${name}`,
          prompt: "Synthetic inbound work",
          crons: ["0 9 * * 1"],
          timezone: "UTC",
          notify: false,
          active: false,
          ...binding(original, "second-model"),
          thinkingLevel: "low",
        }),
      ),
    );
    const captured = await handles.prisma.routine.findMany({
      where: { id: { in: routines.map((routine) => routine.id) } },
      select: {
        id: true,
        name: true,
        prompt: true,
        modelProvider: true,
        modelId: true,
        modelCredentialId: true,
        thinkingLevel: true,
      },
      orderBy: { id: "desc" },
    });
    if (held) {
      const task = await handles.prisma.task.create({
        data: {
          ...actor,
          botId: target.id,
          threadId: thread.id,
          prompt: "Synthetic busy turn",
          status: "running",
        },
      });
      await handles.prisma.run.create({
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
        },
      });
    }
    const modelPin = {
      routineIds: captured.map((routine) => routine.id),
      modelProvider: provider,
      modelId: "second-model",
      modelCredentialId: original.id,
      thinkingLevel: "low",
    };
    const sendInput = {
      ...actor,
      threadId: thread.id,
      botId: target.id,
      blocks: [{ kind: "text" as const, text: "Synthetic inbound work" }],
      prompt: "Synthetic inbound work",
      trigger: "webhook" as const,
      modelPin,
    };
    return { cookie, actor, original, replacement, target, thread, routines, captured, sendInput };
  }

  it("persists a webhook Routine authorization snapshot separately from delivery data", async () => {
    const fixture = await inboundCaptureFixture();
    const instructions = "Read https://owner.example.org";
    const modelPrompt = "Read https://example.net and https://model-only.example";
    await handles.prisma.routine.update({
      where: { id: fixture.captured[0]!.id },
      data: {
        prompt: instructions,
        authorizedInstructions: instructions,
        active: true,
        webhookEnabled: true,
      },
    });
    await handles.prisma.routine.update({
      where: { id: fixture.captured[1]!.id },
      data: {
        prompt: modelPrompt,
        authorizedInstructions: null,
        authorizedSites: ["example.net"],
        active: true,
        webhookEnabled: true,
      },
    });
    const routines = await handles.prisma.routine.findMany({
      where: { id: { in: fixture.captured.map((row) => row.id) } },
    });
    const stalePrompt = "Read https://old.example";
    const stale = await handles.prisma.routine.create({
      data: {
        ...fixture.actor,
        botId: fixture.target.id,
        name: "Edited",
        crons: [],
        prompt: "Read https://new.example",
        authorizedInstructions: "Read https://new.example",
        active: true,
        webhookEnabled: true,
      },
    });
    const disabled = await handles.prisma.routine.create({
      data: {
        ...fixture.actor,
        botId: fixture.target.id,
        name: "Disabled for webhooks",
        crons: [],
        active: true,
        webhookEnabled: false,
        githubEnabled: true,
        prompt: "Read https://other-trigger.example",
        authorizedInstructions: "Read https://other-trigger.example",
      },
    });
    const payload = "Read https://payload.example";
    const sent = await deliverWebhookEvent(
      {
        events: { sendUserMessage: (input) => sendUserMessage(handles.prisma, input) },
        jobs: { enqueue: vi.fn(async () => undefined) },
      },
      { bot: { id: fixture.target.id, ...fixture.actor }, threadId: fixture.thread.id },
      {
        source: "webhook",
        prompt: payload,
        routines: [...routines, { ...stale, prompt: stalePrompt }, disabled],
      },
    );
    const task = await handles.prisma.run.findUniqueOrThrow({
      where: { id: sent.runId! },
      select: { task: { select: { prompt: true, routineInstructions: true, routineSites: true } } },
    });
    expect(task.task.prompt).toContain(modelPrompt);
    expect(task.task.prompt).toContain(stalePrompt);
    expect(task.task.prompt).toContain(payload);
    expect(task.task).toMatchObject({
      routineInstructions: instructions,
      routineSites: ["example.net"],
    });
    await rpc(fixture.cookie, "threads/stop", { botId: fixture.target.id });
    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId! } }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it.each([
    { held: false, operation: "shrink" },
    { held: true, operation: "shrink" },
    { held: false, operation: "disconnect" },
    { held: true, operation: "disconnect" },
  ])(
    "rejects captured A after Routine rebind and $operation before enqueue (held=$held)",
    async ({ held, operation }) => {
      const fixture = await inboundCaptureFixture(held);
      for (const routine of fixture.routines)
        await rpc(fixture.cookie, "routines/update", {
          routineId: routine.id,
          ...binding(fixture.replacement, "second-model"),
          thinkingLevel: "low",
        });
      const removed =
        operation === "shrink"
          ? await raw(
              fixture.cookie,
              "models/connect",
              edit(fixture.original, { enabledModelIds: ["same-model"] }),
            )
          : await raw(fixture.cookie, "models/disconnect", {
              provider,
              credentialId: fixture.original.id,
              expectedRevision: 1,
            });
      expect(removed.status).toBe(200);
      const beforeMessages = await handles.prisma.message.count({
        where: { threadId: fixture.thread.id },
      });
      await expect(
        deliverWebhookEvent(
          {
            events: { sendUserMessage: (input) => sendUserMessage(handles.prisma, input) },
            jobs: { enqueue: vi.fn(async () => undefined) },
          },
          { bot: { id: fixture.target.id, ...fixture.actor }, threadId: fixture.thread.id },
          { source: "webhook", prompt: "Synthetic old delivery", routines: fixture.captured },
        ),
      ).rejects.toBeInstanceOf(IsolationError);
      expect(await handles.prisma.message.count({ where: { threadId: fixture.thread.id } })).toBe(
        beforeMessages,
      );
      expect(
        await handles.prisma.run.count({ where: { botId: fixture.target.id, trigger: "webhook" } }),
      ).toBe(0);
      expect(
        await handles.prisma.steeringMessage.count({ where: { botId: fixture.target.id } }),
      ).toBe(0);
    },
  );

  it("rejects an automatically retired captured connection while its Routine binding is unchanged", async () => {
    const fixture = await inboundCaptureFixture();
    await expect(
      retireModelCredential(handles.prisma, {
        userId: fixture.actor.userId,
        credentialId: fixture.original.id,
      }),
    ).resolves.toBe(true);
    await expect(sendUserMessage(handles.prisma, fixture.sendInput)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(
      await handles.prisma.run.count({ where: { botId: fixture.target.id, trigger: "webhook" } }),
    ).toBe(0);
    expect(
      await handles.prisma.steeringMessage.count({ where: { botId: fixture.target.id } }),
    ).toBe(0);
  });

  it("validates every captured Routine instead of accepting a still-matching first row", async () => {
    const fixture = await inboundCaptureFixture();
    await rpc(fixture.cookie, "routines/update", {
      routineId: fixture.captured[0]!.id,
      ...binding(fixture.replacement, "second-model"),
      thinkingLevel: "low",
    });
    await expect(sendUserMessage(handles.prisma, fixture.sendInput)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(
      await handles.prisma.run.count({ where: { botId: fixture.target.id, trigger: "webhook" } }),
    ).toBe(0);
  });

  it.each([false, true])(
    "holds every Routine binding until its durable inbound reference commits (held=%s)",
    async (held) => {
      const fixture = await inboundCaptureFixture(held);
      let reached!: () => void;
      let release!: () => void;
      const inside = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let enqueuePid = 0;
      const gated = {
        $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          handles.prisma.$transaction(
            async (tx) => {
              enqueuePid = (
                await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
              )[0]!.pid;
              const table = held ? "steeringMessage" : "run";
              const gatedTx = new Proxy(tx, {
                get(target, property, receiver) {
                  if (property !== table) return Reflect.get(target, property, receiver);
                  const delegate = target[table];
                  return new Proxy(delegate, {
                    get(model, method, modelReceiver) {
                      if (method !== "create") return Reflect.get(model, method, modelReceiver);
                      return async (args: unknown) => {
                        reached();
                        await resume;
                        return (model.create as (input: never) => Promise<unknown>)(args as never);
                      };
                    },
                  });
                },
              });
              return callback(gatedTx);
            },
            { timeout: 15_000 },
          ),
      } as unknown as PrismaClient;
      const inbound = sendUserMessage(gated, fixture.sendInput);
      let rebind: Promise<Response> | undefined;
      try {
        await inside;
        rebind = raw(fixture.cookie, "routines/update", {
          routineId: fixture.captured[0]!.id,
          ...binding(fixture.replacement, "second-model"),
          thinkingLevel: "low",
        });
        await vi.waitFor(
          async () => {
            const waiting = await handles.prisma.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pid FROM pg_stat_activity WHERE ${enqueuePid} = ANY(pg_blocking_pids(pid))`;
            expect(waiting.length).toBeGreaterThan(0);
          },
          { timeout: 5_000, interval: 10 },
        );
      } finally {
        release();
      }
      const sent = await inbound;
      expect((await rebind!).status).toBe(200);
      for (const routine of fixture.routines.filter(
        (routine) => routine.id !== fixture.captured[0]!.id,
      ))
        await rpc(fixture.cookie, "routines/update", {
          routineId: routine.id,
          ...binding(fixture.replacement, "second-model"),
          thinkingLevel: "low",
        });
      if (held)
        expect(
          await handles.prisma.steeringMessage.findFirstOrThrow({
            where: { messageId: sent.messageId },
          }),
        ).toMatchObject({ modelCredentialId: fixture.original.id, runId: null });
      else
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId! } }),
        ).toMatchObject({ modelCredentialId: fixture.original.id, modelPinned: true });
      const refs = await rpc<{ references: Array<{ kind: string; modelCredentialId: string }> }>(
        fixture.cookie,
        "models/references",
        { credentialId: fixture.original.id },
      );
      expect(refs.references).toContainEqual(
        expect.objectContaining({
          kind: held ? "steering" : "run",
          modelCredentialId: fixture.original.id,
        }),
      );
      expect(
        (
          await raw(
            fixture.cookie,
            "models/connect",
            edit(fixture.original, { enabledModelIds: ["same-model"] }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await raw(fixture.cookie, "models/disconnect", {
            provider,
            credentialId: fixture.original.id,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(400);
    },
    30_000,
  );

  it("allows exactly one edit with the same expected revision", async () => {
    const { cookie } = await account();
    const credential = await rpc<ModelCredential>(cookie, "models/connect", input());
    const results = await Promise.all(
      [
        {
          label: "First",
          apiProtocol: "responses",
          headers: { "X-Tenant": "first-private-value" },
        },
        {
          label: "Second",
          apiProtocol: "anthropic-messages",
          headers: { "X-Tenant": "second-private-value" },
        },
      ].map((change) => raw(cookie, "models/connect", edit(credential, change))),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await rpc<ModelCredential[]>(cookie, "models/credentials")).toEqual([
      expect.objectContaining({ id: credential.id, connectionRevision: 2 }),
    ]);
    const winner = (await results.find((result) => result.status === 200)!.json())
      .json as ModelCredential;
    const listed = await rpc<ModelCredential[]>(cookie, "models/credentials");
    expect(listed).toEqual([
      expect.objectContaining({
        id: credential.id,
        apiProtocol: winner.label === "First" ? "responses" : "anthropic-messages",
        headerNames: ["X-Tenant"],
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/first-private-value|second-private-value/);
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
