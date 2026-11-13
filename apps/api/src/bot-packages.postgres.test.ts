import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  BUILTIN_AGENT_SKILLS,
  canonicalBotPackageJson,
  EncryptedSecretStore,
} from "@rakazo/adapters";
import type {
  Actor,
  BotPackageExport,
  BotPackagePreview,
  BotPackageReceipt,
  BotPackageRecentReceipt,
} from "@rakazo/contracts";
import { AGENT_BACKUP_FORMAT, BOT_PACKAGE_FORMAT } from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  claimEmptySpaceDeletionForMember,
  createDb,
  createSpaceForMember,
  releaseSpaceDeletionClaim,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listAgentSkillRecords } from "../../../packages/adapters/src/skill-tools.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";
type Account = { cookie: string; actor: Actor };
postgres("Bot packages through authenticated HTTP and transactional PostgreSQL", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let database: ReturnType<typeof createDb>;
  let dataDir: string;
  let failComponents = false;
  let loseClaimAck = false;
  let loseCommitAck = false;
  let afterMarkerAccepted: (() => Promise<void>) | undefined;
  const users: string[] = [];
  const organizations: string[] = [];
  const readCodexCatalog = vi.fn<CodexLiveCatalog["read"]>();
  const outbound = vi.fn<typeof fetch>(async () => {
    throw new Error("JSON packages must stay offline");
  });
  function faultable(prisma: PrismaClient): PrismaClient {
    return new Proxy(prisma, {
      get(client, property, receiver) {
        if (property === "$extends")
          return (...args: unknown[]) =>
            faultable(Reflect.apply(client.$extends, client, args) as PrismaClient);
        if (property !== "$transaction") return Reflect.get(client, property, receiver);
        return (...args: unknown[]) => {
          if (typeof args[0] === "function") {
            const callback = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
            args[0] = (tx: Prisma.TransactionClient) =>
              callback(
                new Proxy(tx, {
                  get(target, key, txReceiver) {
                    if (key !== "botPackageComponent") return Reflect.get(target, key, txReceiver);
                    return new Proxy(target.botPackageComponent, {
                      get(model, operation, modelReceiver) {
                        if (operation !== "createMany")
                          return Reflect.get(model, operation, modelReceiver);
                        return (...createArgs: unknown[]) => {
                          if (failComponents) {
                            failComponents = false;
                            throw new Error("Synthetic child transaction rollback");
                          }
                          return Reflect.apply(model.createMany, model, createArgs);
                        };
                      },
                    });
                  },
                }),
              );
          }
          return (Reflect.apply(client.$transaction, client, args) as Promise<unknown>).then(
            async (value) => {
              if (value && typeof value === "object" && "status" in value) {
                if (value.status === "importing" && afterMarkerAccepted) {
                  const effect = afterMarkerAccepted;
                  afterMarkerAccepted = undefined;
                  await effect();
                }
                if (loseClaimAck && value.status === "importing") {
                  loseClaimAck = false;
                  throw new Error("Synthetic accepted marker acknowledgement lost");
                }
                if (loseCommitAck && value.status === "completed") {
                  loseCommitAck = false;
                  throw new Error("Synthetic committed Bot acknowledgement lost");
                }
              }
              return value;
            },
          );
        };
      },
    });
  }
  const request = (
    account: Account,
    procedure: string,
    input: unknown = {},
    options: { anonymous?: boolean; spaceId?: string } = {},
  ) =>
    handles.app.request(`/rpc/botPackages/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: options.anonymous ? "" : account.cookie,
        "x-rakazo-space-id": options.spaceId ?? account.actor.spaceId,
      },
      body: JSON.stringify({ json: input }),
    });
  async function call<T>(account: Account, procedure: string, input: unknown = {}): Promise<T> {
    const response = await request(account, procedure, input);
    const body = (await response.json()) as { json: T };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.json;
  }
  async function account(): Promise<Account> {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${randomUUID()}@example.test`,
        password: "offline-password-123",
        name: "Offline package fixture",
      }),
    });
    expect(response.ok).toBe(true);
    const cookie = sessionCookieHeader(response);
    const current = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(current.status).toBe(200);
    const actor = ((await current.json()) as { json: Actor }).json;
    users.push(actor.userId);
    organizations.push(
      (await database.prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } }))
        .organizationId,
    );
    return { cookie, actor };
  }
  function source() {
    const skillName = `package-${randomUUID()}`;
    const content = `---\r\nname: ${skillName}\r\ndescription: Exact portable instructions\r\nnotes: |+\r\n  keep extra lines\r\n\r\n---\r\n\r\nOriginal body.\r\n\r\n`;
    return {
      format: BOT_PACKAGE_FORMAT,
      profile: {
        name: "Portable Bot",
        title: "Title",
        description: "Summary",
        instructions: "First line.\n\nContact help@example.test.\n",
      },
      skills: [{ name: skillName, description: "Exact portable instructions", content }],
      routines: [{ name: "Daily", prompt: "Summarize", crons: ["0 9 * * *"], timezone: "UTC" }],
      connections: [{ name: "Mail", note: "Authorize an inbox" }],
      memory: [{ path: "MEMORY.md", content: "Explicitly selected note.\n" }],
    };
  }
  const preview = (actor: Account, value: unknown = source(), includeMemory = false) =>
    call<BotPackagePreview>(actor, "preview", { source: JSON.stringify(value), includeMemory });
  const importPackage = (actor: Account, value: BotPackagePreview, clientNonce = randomUUID()) =>
    call<BotPackageReceipt>(actor, "import", { previewToken: value.previewToken, clientNonce });
  async function sharedSpace(owner: Account, member: Account) {
    const space = await database.prisma.space.findUniqueOrThrow({
      where: { id: owner.actor.spaceId },
    });
    await database.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: member.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await database.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: member.actor.userId } },
      update: { role: "member" },
      create: {
        id: randomUUID(),
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: member.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await database.prisma.session.updateMany({
      where: { userId: member.actor.userId },
      data: { activeOrganizationId: space.organizationId },
    });
    return { ...member, actor: { ...member.actor, spaceId: space.id } };
  }
  it("atomically saves reviewed remote connections without granting tools or making a network request", async () => {
    const owner = await account();
    const foreign = await account();
    const scope = { spaceId: owner.actor.spaceId, userId: owner.actor.userId };
    const endpoint = "https://docs.example.test/mcp";
    const original = await database.prisma.mcpServer.create({
      data: {
        ...scope,
        name: "Docs",
        slug: "unrelated-slug",
        transport: "sse",
        endpoint: "https://original.example.test/sse",
        allowAllTools: true,
      },
    });
    const plan = await preview(owner, {
      format: AGENT_BACKUP_FORMAT,
      source: "hermes",
      files: [],
      mcp: [
        { path: "mcp/server-1", name: "Docs", endpoint, transport: "streamable_http" },
        { path: "mcp/server-2", name: "Restricted", reason: "toolPolicy" },
      ],
    });
    expect(plan.document.connections).toEqual([{ name: "Docs", note: endpoint }]);
    expect(plan.leftOut).toContainEqual(
      expect.objectContaining({ name: "Restricted", kind: "connection" }),
    );
    const nonce = randomUUID();
    expect(
      (await request(foreign, "import", { previewToken: plan.previewToken, clientNonce: nonce }))
        .status,
    ).toBe(400);
    expect(await database.prisma.mcpServer.count({ where: scope })).toBe(1);
    failComponents = true;
    expect(
      (await request(owner, "import", { previewToken: plan.previewToken, clientNonce: nonce }))
        .status,
    ).toBe(500);
    expect(await database.prisma.mcpServer.count({ where: scope })).toBe(1);
    loseCommitAck = true;
    const imported = await call<BotPackageReceipt>(owner, "resume", { clientNonce: nonce });
    expect(imported).toMatchObject({
      status: "completed",
      connections: [{ name: "Docs (2)", setup: "mcp" }],
    });
    expect(await importPackage(owner, plan, nonce)).toEqual(imported);
    const server = await database.prisma.mcpServer.findFirstOrThrow({
      where: { ...scope, slug: "docs-2" },
    });
    expect(server).toMatchObject({
      endpoint,
      allowAllTools: false,
      allowedTools: [],
      headers: {},
      env: {},
      command: null,
      secretId: null,
    });
    expect(await database.prisma.mcpServer.findUnique({ where: { id: original.id } })).toEqual(
      original,
    );
    expect(await database.prisma.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
    const botId = imported.botId!;
    expect(await database.prisma.run.count({ where: { botId } })).toBe(0);
    const message = await database.prisma.message.findFirstOrThrow({
      where: { botId, role: "bot" },
    });
    expect(message.blocks).toEqual([
      {
        kind: "mcp_approval",
        serverId: server.id,
        name: "Docs (2)",
        endpoint,
        transport: "streamable_http",
        status: "pending",
        needsOAuth: false,
      },
    ]);
    for (const threadId of [message.threadId, undefined]) {
      const quickApprove = await handles.app.request("/rpc/mcp/assignments/approve", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: owner.cookie },
        body: JSON.stringify({
          json: { botId, serverId: server.id, threadId, revision: server.revision },
        }),
      });
      expect(quickApprove.status).toBe(409);
    }
    expect(await database.prisma.mcpServer.findUnique({ where: { id: server.id } })).toEqual(
      server,
    );
    const exported = await call<BotPackageExport>(owner, "export", { botId });
    expect(exported.json).not.toContain(endpoint);
    expect(exported.document.connections).toEqual([{ name: "Docs (2)", note: "" }]);
    expect(outbound).not.toHaveBeenCalled();
  });

  beforeAll(async () => {
    database = createDb(process.env.DATABASE_URL!);
    dataDir = await mkdtemp(join(tmpdir(), "bot-packages-http-"));
    handles = await createApp({
      prisma: faultable(database.prisma),
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      encryptionKey: "offline-package-http-fixture-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
      codexCatalog: { read: readCodexCatalog },
      pluginRead: outbound,
      remoteConnectors: { resolveHostname: async () => [], fetch: outbound },
    });
  });
  afterEach(() => {
    failComponents = false;
    loseClaimAck = false;
    loseCommitAck = false;
    afterMarkerAccepted = undefined;
    readCodexCatalog.mockReset();
    vi.unstubAllEnvs();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("imports a reviewed model key only on confirm and replays its committed receipt", async () => {
    const owner = await account();
    const apiKey = "synthetic-key-for-model-backup";
    const model = { provider: "openai", modelId: "gpt-4.1" };
    const fixture = { format: AGENT_BACKUP_FORMAT, source: "hermes", files: [], model };
    const input = { source: JSON.stringify(fixture), importModelKey: true };
    const unavailable = await call<BotPackagePreview>(owner, "preview", {
      ...input,
      importModelKey: false,
    });
    expect(unavailable).toMatchObject({ canImport: false, leftOut: [{ kind: "model" }] });
    expect(unavailable.modelKey).toBeUndefined();
    const plan = await call<BotPackagePreview>(owner, "preview", input);
    expect(plan.modelKey).toEqual(model);
    expect(JSON.stringify(plan)).not.toContain(apiKey);
    expect(outbound).not.toHaveBeenCalled();
    const clientNonce = randomUUID();
    const confirm = { previewToken: plan.previewToken, clientNonce, apiKey };
    expect((await request(owner, "import", { ...confirm, apiKey: undefined })).status).toBe(400);
    const check = async (url: RequestInfo | URL, options?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/models");
      expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
      return Response.json({ data: [{ id: model.modelId }] });
    };
    outbound.mockImplementationOnce(check);
    loseCommitAck = true;
    const imported = await call<BotPackageReceipt>(owner, "import", confirm);
    expect(await call<BotPackageReceipt>(owner, "import", confirm)).toEqual(imported);
    expect(outbound).toHaveBeenCalledTimes(1);
    outbound.mockClear();
    const row = await database.prisma.userModelCredential.findFirstOrThrow({
      where: { userId: owner.actor.userId, provider: model.provider },
    });
    expect(await database.prisma.bot.findUnique({ where: { id: imported.botId! } })).toMatchObject({
      modelProvider: model.provider,
      modelId: model.modelId,
      modelCredentialId: row.id,
    });
    const secret = await database.prisma.secret.findUniqueOrThrow({ where: { id: row.secretId } });
    expect(secret.ciphertext).not.toContain(apiKey);
    expect(JSON.stringify(imported)).not.toContain(apiKey);
    expect(
      (await call<BotPackageExport>(owner, "export", { botId: imported.botId })).json,
    ).not.toContain(apiKey);
    const replay = await call<BotPackagePreview>(owner, "preview", input);
    expect(replay.modelKey).toBeUndefined();
    expect(replay.model).toEqual(model);
  });

  it("rolls a rejected or failed backup connection back and resumes using the original nonce", async () => {
    const owner = await account();
    const foreign = await account();
    const apiKey = "synthetic-backup-retry-key";
    const model = { provider: "openai", modelId: "gpt-4.1" };
    const { skills } = source();
    const fixture = {
      format: AGENT_BACKUP_FORMAT,
      source: "hermes",
      files: [{ path: `skills/${skills[0]!.name}/SKILL.md`, content: skills[0]!.content }],
      model,
    };
    const plan = await call<BotPackagePreview>(owner, "preview", {
      source: JSON.stringify(fixture),
      importModelKey: true,
    });
    const clientNonce = randomUUID();
    const confirm = { previewToken: plan.previewToken, clientNonce, apiKey };
    expect((await request(foreign, "import", confirm)).status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await request(owner, "import", confirm)).status).toBe(400);
    const accountFilter = { userId: owner.actor.userId, provider: model.provider };
    expect(await database.prisma.userModelCredential.count({ where: accountFilter })).toBe(0);
    const failed = await call<BotPackageReceipt>(owner, "status", { clientNonce });
    expect(failed).toMatchObject({ status: "failed", botId: null, modelKey: model });
    expect(JSON.stringify(failed)).not.toContain(apiKey);
    outbound.mockResolvedValueOnce(Response.json({ data: [{ id: "gpt-4.1-mini" }] }));
    expect((await request(owner, "resume", { clientNonce, apiKey })).status).toBe(400);
    expect(await database.prisma.userModelCredential.count({ where: accountFilter })).toBe(0);
    const succeed = () => Response.json({ data: [{ id: model.modelId }] });
    failComponents = true;
    outbound.mockResolvedValueOnce(succeed());
    expect((await request(owner, "resume", { clientNonce, apiKey })).status).toBe(500);
    expect(await database.prisma.userModelCredential.count({ where: accountFilter })).toBe(0);
    expect(
      await database.prisma.secret.count({ where: { userId: owner.actor.userId, kind: "model" } }),
    ).toBe(0);
    outbound.mockResolvedValueOnce(succeed());
    const imported = await call<BotPackageReceipt>(owner, "resume", { clientNonce, apiKey });
    expect(imported).toMatchObject({ status: "completed", importId: failed.importId, clientNonce });
    expect(imported.modelKey).toBeUndefined();
    expect(await database.prisma.userModelCredential.count({ where: accountFilter })).toBe(1);
    expect(outbound).toHaveBeenCalledTimes(4);
    outbound.mockClear();
  });

  it("does not overwrite a model connection added in another Space during verification", async () => {
    const owner = await account();
    const sibling = await createSpaceForMember(database.prisma, {
      currentSpaceId: owner.actor.spaceId,
      userId: owner.actor.userId,
      name: "Other model Space",
    });
    const target = { ...owner, actor: { ...owner.actor, spaceId: sibling.id } };
    const model = { provider: "openai", modelId: "gpt-4.1" };
    const input = {
      source: JSON.stringify({ format: AGENT_BACKUP_FORMAT, source: "hermes", files: [], model }),
      importModelKey: true,
    };
    const first = await call<BotPackagePreview>(owner, "preview", input);
    const second = await call<BotPackagePreview>(target, "preview", input);
    const verified = () => Response.json({ data: [{ id: model.modelId }] });
    let competing: BotPackageReceipt | undefined;
    outbound.mockImplementationOnce(async () => {
      competing = await call<BotPackageReceipt>(target, "import", {
        previewToken: second.previewToken,
        clientNonce: randomUUID(),
        apiKey: "synthetic-concurrent-second-key",
      });
      return verified();
    });
    outbound.mockImplementationOnce(async () => verified());
    const result = await call<BotPackageReceipt>(owner, "import", {
      previewToken: first.previewToken,
      clientNonce: randomUUID(),
      apiKey: "synthetic-concurrent-first-key",
    });
    expect(competing?.status).toBe("completed");
    expect(result).toMatchObject({
      status: "cancelled",
      botId: null,
      leftOut: [{ kind: "model" }],
    });
    const credentials = await database.prisma.userModelCredential.findMany({
      where: { userId: owner.actor.userId, provider: model.provider },
    });
    expect(credentials).toHaveLength(1);
    expect(
      await database.prisma.bot.findUnique({ where: { id: competing!.botId! } }),
    ).toMatchObject({
      modelCredentialId: credentials[0]!.id,
    });
    expect(
      await database.prisma.spaceModelPreference.findMany({
        where: { userId: owner.actor.userId, credentialId: credentials[0]!.id },
        select: { spaceId: true, isDefault: true },
      }),
    ).toEqual([{ spaceId: sibling.id, isDefault: false }]);
    expect(
      await database.prisma.secret.count({
        where: { userId: owner.actor.userId, kind: "model" },
      }),
    ).toBe(1);
    expect(outbound).toHaveBeenCalledTimes(2);
    outbound.mockClear();
  });
  afterAll(async () => {
    if (database) {
      await database.prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await database.prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    await handles?.stop();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  it("imports a new isolated Bot atomically with pending Skills, paused routines and no credentials or Run", async () => {
    const owner = await account();
    const value = source();
    const p = await preview(owner, value);
    expect(p).not.toHaveProperty("json");
    expect(p.digest).toBe(
      createHash("sha256").update(canonicalBotPackageJson(p.document)).digest("hex"),
    );
    const receipt = await importPackage(owner, p);
    expect(receipt.status).toBe("completed");
    expect(receipt.skills[0]?.content).toBe(value.skills[0]!.content);
    expect(receipt.skills[0]?.status).toBe("pending");
    const bot = await database.prisma.bot.findUniqueOrThrow({
      where: { id: receipt.botId! },
      include: { thread: true, browserProfile: true },
    });
    expect(bot.instructions).toBe(value.profile.instructions);
    expect(bot.memoryScope).toBe("isolated");
    expect(bot.parentBotId).toBeNull();
    expect(bot.modelCredentialId).toBeNull();
    expect(bot.disabledBuiltinTools).toEqual(
      expect.arrayContaining([
        "run_subagent",
        "spawn_bot",
        "cloud_agent_launch",
        "cloud_agent_status",
        "cloud_agent_reply",
        "cloud_agent_cancel",
      ]),
    );
    expect(bot.thread).not.toBeNull();
    expect(bot.browserProfile).not.toBeNull();
    expect(await database.prisma.run.count({ where: { botId: bot.id } })).toBe(0);
    expect(await database.prisma.agentSkill.count({ where: { userId: owner.actor.userId } })).toBe(
      0,
    );
    expect(await database.prisma.botMcpServer.count({ where: { botId: bot.id } })).toBe(0);
    expect(
      (await database.prisma.routine.findFirstOrThrow({ where: { botId: bot.id } })).active,
    ).toBe(false);
    expect(
      (await database.prisma.memoryDocument.findFirstOrThrow({ where: { botId: bot.id } })).content,
    ).not.toContain("Explicitly selected");
    const marker = await database.prisma.botPackageImport.findUniqueOrThrow({
      where: { id: receipt.importId },
    });
    expect(marker.plan).toBeNull();
    expect(
      await database.prisma.botPackagePreview.count({ where: { userId: owner.actor.userId } }),
    ).toBe(0);
  });
  it("copies selected memory only into the new isolated Bot with its first revision", async () => {
    const owner = await account();
    const value = source();
    const p = await preview(owner, value, true);
    expect(p).not.toHaveProperty("json");
    expect(p.digest).toBe(
      createHash("sha256").update(canonicalBotPackageJson(p.document)).digest("hex"),
    );
    const receipt = await importPackage(owner, p);
    const notes = await database.prisma.memoryDocument.findMany({
      where: { botId: receipt.botId! },
      include: { revisions: true },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.scope).toBe("bot");
    expect(notes[0]?.content).toBe(value.memory[0]!.content);
    expect(notes[0]?.revisions[0]?.content).toBe(value.memory[0]!.content);
    expect(
      await database.prisma.memoryDocument.count({
        where: {
          userId: owner.actor.userId,
          scope: "user",
          content: { contains: "Explicitly selected" },
        },
      }),
    ).toBe(0);
  });
  it.each(["openclaw", "hermes"] as const)(
    "imports supported %s backup content through the existing preview and receipt",
    async (sourceFormat) => {
      const owner = await account();
      const instructions = "Summarize the supplied material.";
      const skill = buildSkillMd({
        name: "backup-review",
        description: "Review a supplied document",
        body: "Review the supplied material before reporting.",
      });
      const value = {
        format: AGENT_BACKUP_FORMAT,
        source: sourceFormat,
        files: [
          { path: "SOUL.md", content: instructions },
          {
            path: sourceFormat === "hermes" ? "memories/MEMORY.md" : "MEMORY.md",
            content: "Chosen backup note.",
          },
          { path: "skills/backup-review/SKILL.md", content: skill },
          { path: "skills/incomplete/SKILL.md", content: skill },
        ],
        incompleteSkills: ["skills/incomplete/SKILL.md"],
      };
      const unselected = await preview(owner, value);
      expect(unselected).toMatchObject({
        sourceFormat,
        availableMemoryCount: 1,
        document: { memory: [] },
      });
      const selected = await preview(owner, value, true);
      expect(selected.leftOut).toContainEqual(
        expect.objectContaining({ name: "skills/incomplete/SKILL.md" }),
      );
      expect(selected.digest).not.toBe(unselected.digest);
      const nonce = randomUUID();
      const receipt = await importPackage(owner, selected, nonce);
      expect(receipt).toMatchObject({ status: "completed", skills: [{ status: "pending" }] });
      expect(await importPackage(owner, selected, nonce)).toEqual(receipt);
      const bot = await database.prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId! } });
      expect(bot).toMatchObject({ instructions, memoryScope: "isolated", modelCredentialId: null });
      expect(await database.prisma.run.count({ where: { botId: bot.id } })).toBe(0);
      expect(await database.prisma.routine.count({ where: { botId: bot.id } })).toBe(0);
      expect(
        await database.prisma.memoryDocument.findMany({ where: { botId: bot.id, scope: "bot" } }),
      ).toEqual([expect.objectContaining({ path: "MEMORY.md", content: "Chosen backup note." })]);
    },
  );
  it("binds the reviewed backup model to a single exact current Space connection", async () => {
    const owner = await account();
    const model = { provider: "openai", modelId: "gpt-4.1" };
    const value = {
      format: AGENT_BACKUP_FORMAT,
      source: "hermes",
      files: [{ path: "HERMES.md", content: "Review rows." }],
      model,
    };
    const addConnection = async (label: string) => {
      const secret = await new EncryptedSecretStore("offline-package-http-fixture-key").put(
        "synthetic-connection",
        {
          ...owner.actor,
          operationId: "fixture",
          traceId: "fixture",
          signal: AbortSignal.timeout(5000),
        },
      );
      await database.prisma.secret.create({
        data: {
          id: secret.id,
          userId: owner.actor.userId,
          kind: "model",
          ciphertext: secret.ciphertext,
        },
      });
      return database.prisma.userModelCredential.create({
        data: { userId: owner.actor.userId, provider: model.provider, label, secretId: secret.id },
      });
    };
    const credential = await addConnection("Selected in this Space");
    const other = await addConnection("Other available account connection");
    const missing = await preview(owner, value);
    expect(missing.model).toBeUndefined();
    expect(missing.leftOut).toContainEqual(expect.objectContaining({ kind: "model" }));
    const missingModelOnly = await preview(owner, { ...value, files: [] });
    expect(missingModelOnly.canImport).toBe(false);
    expect(
      (
        await request(owner, "import", {
          previewToken: missingModelOnly.previewToken,
          clientNonce: randomUUID(),
        })
      ).status,
    ).toBe(400);
    const select = (credentialId: string) =>
      database.prisma.spaceModelPreference.create({
        data: {
          userId: owner.actor.userId,
          spaceId: owner.actor.spaceId,
          credentialId,
          modelId: model.modelId,
        },
      });
    await select(credential.id);
    const reviewed = await preview(owner, value);
    expect(reviewed.model).toEqual(model);
    expect(reviewed.digest).not.toBe(missing.digest);
    expect(JSON.stringify(reviewed)).not.toContain(credential.id);
    expect(JSON.stringify(reviewed)).not.toContain("synthetic-connection");
    const modelOnly = await preview(owner, { ...value, files: [] });
    expect(modelOnly.model).toEqual(model);
    const modelOnlyReceipt = await importPackage(owner, modelOnly);
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: modelOnlyReceipt.botId! } }),
    ).toMatchObject({ modelCredentialId: credential.id, instructions: "" });
    const sibling = await createSpaceForMember(database.prisma, {
      currentSpaceId: owner.actor.spaceId,
      userId: owner.actor.userId,
      name: "Unconfigured Space",
    });
    await database.prisma.spaceModelPreference.deleteMany({
      where: { spaceId: sibling.id, userId: owner.actor.userId },
    });
    expect(
      (await preview({ ...owner, actor: { ...owner.actor, spaceId: sibling.id } }, value)).model,
    ).toBeUndefined();

    const nonce = randomUUID();
    const [receipt, replay] = await Promise.all([
      importPackage(owner, reviewed, nonce),
      importPackage(owner, reviewed, nonce),
    ]);
    expect(replay).toEqual(receipt);
    expect(
      await database.prisma.botPackageImport.count({
        where: { userId: owner.actor.userId, spaceId: owner.actor.spaceId, clientNonce: nonce },
      }),
    ).toBe(1);
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId! } }),
    ).toMatchObject({
      modelProvider: model.provider,
      modelId: model.modelId,
      modelCredentialId: credential.id,
    });

    const priorToAmbiguity = await preview(owner, value);
    const secondPreference = await select(other.id);
    const fromAmbiguous = await importPackage(owner, priorToAmbiguity);
    expect(fromAmbiguous.leftOut).toContainEqual(expect.objectContaining({ kind: "model" }));
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: fromAmbiguous.botId! } }),
    ).toMatchObject({ modelCredentialId: null });
    expect((await preview(owner, value)).model).toBeUndefined();
    await database.prisma.spaceModelPreference.delete({ where: { id: secondPreference.id } });

    const stale = await preview(owner, value);
    const staleModelOnly = await preview(owner, { ...value, files: [] });
    await database.prisma.userModelCredential.update({
      where: { id: credential.id },
      data: { connectionRevision: { increment: 1 } },
    });
    const changed = await importPackage(owner, stale);
    const staleNonce = randomUUID();
    const cancelled = await importPackage(owner, staleModelOnly, staleNonce);
    expect(cancelled).toMatchObject({ status: "cancelled", botId: null });
    expect(cancelled.leftOut).toContainEqual(
      expect.objectContaining({
        kind: "model",
        reason: expect.stringContaining("preview the backup again"),
      }),
    );
    expect(await call<BotPackageReceipt>(owner, "status", { clientNonce: staleNonce })).toEqual(
      cancelled,
    );
    expect(await call<BotPackageReceipt>(owner, "resume", { clientNonce: staleNonce })).toEqual(
      cancelled,
    );
    expect(await importPackage(owner, staleModelOnly, staleNonce)).toEqual(cancelled);
    const newPreview = await preview(owner, { ...value, files: [] });
    expect(newPreview.model).toEqual(model);
    const recovered = await importPackage(owner, newPreview);
    expect(recovered.status).toBe("completed");
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: recovered.botId! } }),
    ).toMatchObject({ modelCredentialId: credential.id });
    expect(changed.leftOut).toContainEqual(
      expect.objectContaining({
        kind: "model",
        reason: expect.stringContaining("no longer available"),
      }),
    );
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: changed.botId! } }),
    ).toMatchObject({
      modelProvider: null,
      modelId: null,
      modelCredentialId: null,
    });
    const ordinary = await preview(owner, {
      ...source(),
      model,
      backupModelBinding: { ...model, credentialId: credential.id, revision: 2 },
    });
    expect(ordinary.model).toBeUndefined();
    expect(ordinary.document).not.toHaveProperty("backupModelBinding");
  });

  it("preserves the saved Azure connection identity and counts aliases as ambiguous", async () => {
    const owner = await account();
    const model = { provider: "azure", modelId: "gpt-4.1" };
    const value = {
      format: AGENT_BACKUP_FORMAT,
      source: "hermes",
      files: [{ path: "HERMES.md", content: "Review rows." }],
      model,
    };
    const select = async (provider: string) => {
      const secret = await new EncryptedSecretStore("offline-package-http-fixture-key").put(
        "synthetic-azure-connection",
        {
          ...owner.actor,
          operationId: "fixture",
          traceId: "fixture",
          signal: AbortSignal.timeout(5000),
        },
      );
      await database.prisma.secret.create({
        data: {
          id: secret.id,
          userId: owner.actor.userId,
          kind: "model",
          ciphertext: secret.ciphertext,
        },
      });
      const credential = await database.prisma.userModelCredential.create({
        data: { userId: owner.actor.userId, provider, label: provider, secretId: secret.id },
      });
      await database.prisma.spaceModelPreference.create({
        data: {
          userId: owner.actor.userId,
          spaceId: owner.actor.spaceId,
          credentialId: credential.id,
          modelId: model.modelId,
        },
      });
      return credential;
    };
    const legacy = await select("azure-openai-responses");
    const reviewed = await preview(owner, value);
    expect(reviewed.model).toEqual(model);
    const receipt = await importPackage(owner, reviewed);
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId! } }),
    ).toMatchObject({
      modelProvider: legacy.provider,
      modelId: model.modelId,
      modelCredentialId: legacy.id,
    });

    const beforeSecondAlias = await preview(owner, value);
    expect(beforeSecondAlias.model).toEqual(model);
    await select("azure");
    expect((await preview(owner, value)).model).toBeUndefined();
    const ambiguous = await importPackage(owner, beforeSecondAlias);
    expect(ambiguous.leftOut).toContainEqual(expect.objectContaining({ kind: "model" }));
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: ambiguous.botId! } }),
    ).toMatchObject({ modelProvider: null, modelId: null, modelCredentialId: null });
  });

  it("honors model availability on the exact saved subscription account", async () => {
    const owner = await account();
    const model = { provider: "openai-codex", modelId: "gpt-5.3-codex-spark" };
    const value = { format: AGENT_BACKUP_FORMAT, source: "hermes", files: [], model };
    const secret = await new EncryptedSecretStore("offline-package-http-fixture-key").put(
      JSON.stringify({
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 60_000,
        accountId: "fixture-account",
      }),
      {
        ...owner.actor,
        operationId: "fixture",
        traceId: "fixture",
        signal: AbortSignal.timeout(5000),
      },
    );
    await database.prisma.secret.create({
      data: {
        id: secret.id,
        userId: owner.actor.userId,
        kind: "model",
        ciphertext: secret.ciphertext,
      },
    });
    const credential = await database.prisma.userModelCredential.create({
      data: {
        userId: owner.actor.userId,
        provider: model.provider,
        label: "Fixture",
        secretId: secret.id,
      },
    });
    await database.prisma.spaceModelPreference.create({
      data: {
        userId: owner.actor.userId,
        spaceId: owner.actor.spaceId,
        credentialId: credential.id,
        modelId: model.modelId,
      },
    });
    readCodexCatalog.mockResolvedValue([]);
    expect(await preview(owner, value)).toMatchObject({ canImport: false });
    const available = [
      {
        slug: model.modelId,
        reasoningEfforts: [],
        supportsImages: false,
        supportsFastTier: true,
      },
    ];
    readCodexCatalog.mockResolvedValue(available);
    const reviewed = await preview(owner, value);
    expect(reviewed.model).toEqual(model);
    expect(JSON.stringify(reviewed)).not.toContain("fixture-account");
    expect(JSON.stringify(reviewed)).not.toContain("synthetic-access");
    expect(readCodexCatalog).toHaveBeenLastCalledWith(
      owner.actor.userId,
      expect.objectContaining({ accountId: "fixture-account" }),
      undefined,
    );
    const receipt = await importPackage(owner, reviewed);
    expect(receipt.status).toBe("completed");
    expect(
      await database.prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId! } }),
    ).toMatchObject({ modelCredentialId: credential.id, modelId: model.modelId });
    expect(readCodexCatalog).toHaveBeenLastCalledWith(
      owner.actor.userId,
      expect.objectContaining({ accountId: "fixture-account" }),
      { cacheOnly: true },
    );
    const prior = await preview(owner, value);
    readCodexCatalog.mockResolvedValue([]);
    expect(await importPackage(owner, prior)).toMatchObject({ status: "cancelled", botId: null });
  });

  it("binds the receipt to the selected backup files even when the Bot documents match", async () => {
    const owner = await account();
    const backup = {
      format: AGENT_BACKUP_FORMAT,
      source: "openclaw",
    };
    const content = "Review the supplied material.";
    const first = await call<BotPackagePreview>(owner, "preview", {
      source: JSON.stringify({ ...backup, files: [{ path: "SOUL.md", content }] }),
      backupOmissions: [{ path: "skills/incomplete/SKILL.md", reason: "missingSkillFiles" }],
    });
    const second = await preview(owner, { ...backup, files: [{ path: "AGENTS.md", content }] });
    expect(first.document).toEqual(second.document);
    expect(first.digest).not.toBe(second.digest);
    expect(first.leftOut).toContainEqual({
      kind: "skill",
      name: "skills/incomplete/SKILL.md",
      reason: "This Skill needs additional files.",
    });

    const nonce = randomUUID();
    const receipt = await importPackage(owner, first, nonce);
    expect(receipt.digest).toBe(first.digest);
    expect(receipt.leftOut).toEqual(first.leftOut);
    expect(await importPackage(owner, first, nonce)).toEqual(receipt);
    await expect(importPackage(owner, second, nonce)).rejects.toThrow("different content");
  });
  it.each(["openclaw", "hermes"] as const)(
    "stores a selected %s schedule as a paused draft only once",
    async (sourceFormat) => {
      const owner = await account();
      const routine = {
        name: "Morning review",
        prompt: "Review the reports.",
        crons: ["0 9 * * 1-5"],
        timezone: "Asia/Taipei",
      };
      const reviewed = await call<BotPackagePreview>(owner, "preview", {
        source: JSON.stringify({ format: AGENT_BACKUP_FORMAT, source: sourceFormat, files: [] }),
        backupRoutines: [{ path: "cron/routine-1.json", routine }],
      });
      expect(reviewed.document.routines).toEqual([routine]);
      const identicalContent = await call<BotPackagePreview>(owner, "preview", {
        source: JSON.stringify({ format: AGENT_BACKUP_FORMAT, source: sourceFormat, files: [] }),
        backupRoutines: [{ path: "cron/routine-2.json", routine }],
      });
      expect(identicalContent.document).toEqual(reviewed.document);
      expect(identicalContent.digest).not.toBe(reviewed.digest);
      const nonce = randomUUID();
      const receipt = await importPackage(owner, reviewed, nonce);
      expect(await importPackage(owner, reviewed, nonce)).toEqual(receipt);
      const routines = await database.prisma.routine.findMany({ where: { botId: receipt.botId! } });
      expect(routines).toMatchObject([
        {
          ...routine,
          active: false,
          nextRunAt: null,
          notify: false,
          webhookEnabled: false,
          messageProvider: null,
          authorizedInstructions: null,
        },
      ]);
      expect(await database.prisma.run.count({ where: { botId: receipt.botId! } })).toBe(0);
    },
  );
  it("rejects an invalid stored preview before creating an import marker or Bot", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    const before = await database.prisma.bot.count({ where: { userId: owner.actor.userId } });
    const changed = await database.prisma.botPackagePreview.updateMany({
      where: {
        userId: owner.actor.userId,
        spaceId: owner.actor.spaceId,
        tokenHash: createHash("sha256").update(p.previewToken).digest("hex"),
      },
      data: { document: { format: BOT_PACKAGE_FORMAT, profile: { name: 42 } } },
    });
    expect(changed.count).toBe(1);
    const response = await request(owner, "import", { previewToken: p.previewToken, clientNonce });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await database.prisma.botPackageImport.count({
        where: { userId: owner.actor.userId, clientNonce },
      }),
    ).toBe(0);
    expect(await database.prisma.bot.count({ where: { userId: owner.actor.userId } })).toBe(before);
  });
  it("concurrent retries serialize the same nonce and a committed replay survives preview expiry", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    const [a, b] = await Promise.all([
      importPackage(owner, p, clientNonce),
      importPackage(owner, p, clientNonce),
    ]);
    expect(a.botId).toBe(b.botId);
    expect(
      await database.prisma.botPackageImport.count({
        where: { userId: owner.actor.userId, clientNonce },
      }),
    ).toBe(1);
    expect((await importPackage(owner, p, clientNonce)).botId).toBe(a.botId);
    expect(
      (await request(owner, "import", { clientNonce, previewToken: "different-token" })).status,
    ).toBe(409);
  });
  it("binds one preview to one immutable nonce and rejects expired or foreign previews", async () => {
    const owner = await account();
    const stranger = await account();
    const p = await preview(owner);
    expect(
      (
        await request(stranger, "import", {
          clientNonce: randomUUID(),
          previewToken: p.previewToken,
        })
      ).status,
    ).toBe(400);
    await importPackage(owner, p);
    expect(
      (await request(owner, "import", { clientNonce: randomUUID(), previewToken: p.previewToken }))
        .ok,
    ).toBe(false);
    const expired = await preview(owner);
    await database.prisma.botPackagePreview.updateMany({
      where: { userId: owner.actor.userId },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (
        await request(owner, "import", {
          clientNonce: randomUUID(),
          previewToken: expired.previewToken,
        })
      ).status,
    ).toBe(400);
  });
  it("rolls back every Bot child on failure and resumes only the accepted immutable plan", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    failComponents = true;
    expect((await request(owner, "import", { clientNonce, previewToken: p.previewToken })).ok).toBe(
      false,
    );
    const failed = await call<BotPackageReceipt>(owner, "status", { clientNonce });
    expect(failed.status).toBe("failed");
    expect(failed.botId).toBeNull();
    expect(failed.skills).toEqual([]);
    expect(await database.prisma.bot.count({ where: { userId: owner.actor.userId } })).toBe(0);
    expect(await database.prisma.thread.count({ where: { userId: owner.actor.userId } })).toBe(0);
    const resumed = await call<BotPackageReceipt>(owner, "resume", { clientNonce });
    expect(resumed.status).toBe("completed");
    expect(resumed.botName).toBe(p.document.profile.name);
    expect((await call<BotPackageReceipt>(owner, "resume", { clientNonce })).botId).toBe(
      resumed.botId,
    );
  });
  it("recovers an accepted marker whose acknowledgement was lost without needing its expired preview", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    loseClaimAck = true;
    expect((await request(owner, "import", { clientNonce, previewToken: p.previewToken })).ok).toBe(
      false,
    );
    expect((await call<BotPackageReceipt>(owner, "status", { clientNonce })).status).toBe(
      "importing",
    );
    const recent = await call<BotPackageRecentReceipt[]>(owner, "recent");
    expect(recent[0]?.clientNonce).toBe(clientNonce);
    expect(JSON.stringify(recent)).not.toContain("Original body");
    expect((await call<BotPackageReceipt>(owner, "resume", { clientNonce })).status).toBe(
      "completed",
    );
  });
  it("recovers a committed Bot when the transaction acknowledgement is lost", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    loseCommitAck = true;
    const receipt = await importPackage(owner, p, clientNonce);
    expect(receipt.status).toBe("completed");
    expect((await call<BotPackageReceipt>(owner, "status", { clientNonce })).botId).toBe(
      receipt.botId,
    );
    expect(await database.prisma.bot.count({ where: { userId: owner.actor.userId } })).toBe(1);
  });
  it("cancellation records unknown-nonce tombstones so an old delayed request cannot later create a Bot", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    expect(await call(owner, "status", { clientNonce })).toBeNull();
    expect((await call<BotPackageReceipt>(owner, "cancel", { clientNonce })).status).toBe(
      "cancelled",
    );
    expect((await importPackage(owner, p, clientNonce)).status).toBe("cancelled");
    expect((await call<BotPackageReceipt>(owner, "resume", { clientNonce })).status).toBe(
      "cancelled",
    );
    expect(await database.prisma.bot.count({ where: { userId: owner.actor.userId } })).toBe(0);
  });
  it("cancels accepted or failed plans without rolling back an already committed Bot", async () => {
    const owner = await account();
    const p = await preview(owner);
    const clientNonce = randomUUID();
    failComponents = true;
    await request(owner, "import", { clientNonce, previewToken: p.previewToken });
    expect((await call<BotPackageReceipt>(owner, "cancel", { clientNonce })).status).toBe(
      "cancelled",
    );
    expect(
      (
        await database.prisma.botPackageImport.findUniqueOrThrow({
          where: {
            spaceId_userId_clientNonce: {
              spaceId: owner.actor.spaceId,
              userId: owner.actor.userId,
              clientNonce,
            },
          },
        })
      ).plan,
    ).toBeNull();
    const completed = await importPackage(owner, await preview(owner));
    expect(
      (await call<BotPackageReceipt>(owner, "cancel", { clientNonce: completed.clientNonce }))
        .botId,
    ).toBe(completed.botId);
  });
  it("activates only an explicit pending Skill into the owner+Space catalog with rename and metadata preserved", async () => {
    const owner = await account();
    const receipt = await importPackage(owner, await preview(owner));
    const pending = receipt.skills[0]!;
    expect(
      (await listAgentSkillRecords(database.prisma, owner.actor)).filter(
        (skill) => skill.source !== "builtin",
      ),
    ).toEqual([]);
    const activated = await call<BotPackageReceipt>(owner, "activateSkill", {
      componentId: pending.id,
      expectedRevision: pending.revision,
      name: "renamed-portable",
    });
    expect(activated.skills[0]?.status).toBe("activated");
    expect(activated.skills[0]?.content).toBeNull();
    const row = await database.prisma.agentSkill.findUniqueOrThrow({
      where: { id: activated.skills[0]!.skillId! },
    });
    expect(row.name).toBe("renamed-portable");
    const parsed = parseSkillMd(row.content);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.frontmatter?.notes).toContain("keep extra lines");
    expect(
      (await database.prisma.botPackageComponent.findUniqueOrThrow({ where: { id: pending.id } }))
        .content,
    ).toBeNull();
    expect(
      (
        await call<BotPackageReceipt>(owner, "activateSkill", {
          componentId: pending.id,
          expectedRevision: pending.revision,
          name: "renamed-portable",
        })
      ).skills[0]?.skillId,
    ).toBe(row.id);
    expect(
      (
        await request(owner, "activateSkill", {
          componentId: pending.id,
          expectedRevision: pending.revision,
          name: "different",
        })
      ).status,
    ).toBe(409);
  });
  it("rejects case-insensitive and builtin clashes and stale revisions without overwriting Skills", async () => {
    const owner = await account();
    const receipt = await importPackage(owner, await preview(owner));
    const skill = receipt.skills[0]!;
    await database.prisma.agentSkill.create({
      data: {
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        name: "Existing",
        description: "Original",
        content: buildSkillMd({ name: "Existing", description: "Original", body: "Keep me" }),
        source: "user",
      },
    });
    expect(
      (
        await request(owner, "activateSkill", {
          componentId: skill.id,
          expectedRevision: skill.revision,
          name: "existing",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(owner, "activateSkill", {
          componentId: skill.id,
          expectedRevision: skill.revision + 1,
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await request(owner, "activateSkill", {
          componentId: skill.id,
          expectedRevision: skill.revision,
          name: BUILTIN_AGENT_SKILLS[0]!.name,
        })
      ).status,
    ).toBe(409);
    expect(
      (await call<BotPackageReceipt>(owner, "status", { clientNonce: receipt.clientNonce }))
        .skills[0]?.status,
    ).toBe("pending");
  });
  it("exports pending raw Skills and selected shared Skills without reading whole archives", async () => {
    const owner = await account();
    const value = source();
    const receipt = await importPackage(owner, await preview(owner, value, true));
    const shared = await database.prisma.agentSkill.create({
      data: {
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        name: "shared-other",
        description: "Shared",
        content: buildSkillMd({ name: "shared-other", description: "Shared", body: "Shared body" }),
        source: "user",
      },
    });
    const exported = await call<BotPackageExport>(owner, "export", { botId: receipt.botId });
    expect(JSON.parse(exported.json)).toEqual(exported.document);
    expect(exported.document.skills).toEqual(value.skills);
    expect(exported.document.memory).toEqual([]);
    expect(exported.document.profile.instructions).toBe(value.profile.instructions);
    expect(exported.json).not.toContain(shared.content);
    expect(exported.json).not.toContain(receipt.botId!);
    const selected = await call<BotPackageExport>(owner, "export", {
      botId: receipt.botId,
      skillIds: [shared.id],
      includeMemory: true,
    });
    expect(JSON.parse(selected.json)).toEqual(selected.document);
    expect(selected.document.skills).toHaveLength(2);
    expect(selected.document.memory).toEqual(value.memory);
    expect((await preview(owner, JSON.parse(selected.json), true)).document).toEqual(
      selected.document,
    );
    expect(
      (await request(owner, "export", { botId: receipt.botId, skillIds: ["builtin:irrelevant"] }))
        .status,
    ).toBe(404);
  });
  it("uses the current activated Skill on export and never revives deleted Skills or Bots", async () => {
    const owner = await account();
    const receipt = await importPackage(owner, await preview(owner));
    const pending = receipt.skills[0]!;
    const active = await call<BotPackageReceipt>(owner, "activateSkill", {
      componentId: pending.id,
      expectedRevision: pending.revision,
    });
    const skillId = active.skills[0]!.skillId!;
    const current = await database.prisma.agentSkill.findUniqueOrThrow({ where: { id: skillId } });
    const content = current.content.replace("Original body.", "Current edited body.");
    await database.prisma.agentSkill.update({ where: { id: skillId }, data: { content } });
    expect(
      (await call<BotPackageExport>(owner, "export", { botId: receipt.botId, skillIds: [skillId] }))
        .document.skills[0]?.content,
    ).toBe(content);
    await database.prisma.agentSkill.delete({ where: { id: skillId } });
    const status = await call<BotPackageReceipt>(owner, "status", {
      clientNonce: receipt.clientNonce,
    });
    expect(status.skills[0]?.status).toBe("removed");
    expect(status.skills[0]?.content).toBeNull();
    expect(
      (
        await call<BotPackageReceipt>(owner, "activateSkill", {
          componentId: pending.id,
          expectedRevision: pending.revision,
        })
      ).skills[0]?.status,
    ).toBe("removed");
    expect(
      (await call<BotPackageExport>(owner, "export", { botId: receipt.botId })).document.skills,
    ).toEqual([]);
    await database.prisma.bot.delete({ where: { id: receipt.botId! } });
    expect(
      (await call<BotPackageReceipt>(owner, "resume", { clientNonce: receipt.clientNonce })).status,
    ).toBe("removed");
    expect(
      await database.prisma.botPackageComponent.count({ where: { importId: receipt.importId } }),
    ).toBe(0);
    expect(await database.prisma.bot.count({ where: { userId: owner.actor.userId } })).toBe(0);
  });
  it("protects private instructions and memory from other Space members and deployment admins", async () => {
    const owner = await account();
    const stranger = await account();
    const member = await sharedSpace(owner, stranger);
    const receipt = await importPackage(owner, await preview(owner));
    expect(
      (await request(member, "export", { botId: receipt.botId, includeMemory: true })).status,
    ).toBe(404);
    expect((await request(member, "forBot", { botId: receipt.botId })).status).toBe(404);
    expect(await call(member, "status", { clientNonce: receipt.clientNonce })).toBeNull();
    expect(await call(member, "recent")).toEqual([]);
    const skill = receipt.skills[0]!;
    expect(
      (
        await request(member, "activateSkill", {
          componentId: skill.id,
          expectedRevision: skill.revision,
        })
      ).status,
    ).toBe(404);
  });
  it("recovers a committed Skill activation after its acknowledgement is lost without duplicate creation", async () => {
    const owner = await account();
    const imported = await importPackage(owner, await preview(owner));
    const pending = imported.skills[0]!;
    const input = {
      componentId: pending.id,
      expectedRevision: pending.revision,
      name: "ack-safe-activation",
    };
    loseCommitAck = true;
    expect((await request(owner, "activateSkill", input)).ok).toBe(false);
    const current = await call<BotPackageReceipt>(owner, "status", {
      clientNonce: imported.clientNonce,
    });
    expect(current.skills[0]?.status).toBe("activated");
    const replay = await call<BotPackageReceipt>(owner, "activateSkill", input);
    expect(replay.skills[0]?.skillId).toBe(current.skills[0]?.skillId);
    expect(
      await database.prisma.agentSkill.count({
        where: { userId: owner.actor.userId, name: "ack-safe-activation" },
      }),
    ).toBe(1);
  });
  it("keeps activated Skills metadata-only in recovery and exports them only when explicitly selected", async () => {
    const owner = await account();
    const initial = await importPackage(owner, await preview(owner));
    const pending = initial.skills[0]!;
    const active = await call<BotPackageReceipt>(owner, "activateSkill", {
      componentId: pending.id,
      expectedRevision: pending.revision,
    });
    const skillId = active.skills[0]!.skillId!;
    expect(
      (await call<BotPackageExport>(owner, "export", { botId: initial.botId })).document.skills,
    ).toEqual([]);
    expect(
      (await call<BotPackageExport>(owner, "export", { botId: initial.botId, skillIds: [skillId] }))
        .document.skills,
    ).toHaveLength(1);
    const shared = await database.prisma.agentSkill.findUniqueOrThrow({ where: { id: skillId } });
    await database.prisma.agentSkill.update({
      where: { id: skillId },
      data: { content: shared.content + "x".repeat(100000) },
    });
    const recovery = await call<BotPackageReceipt>(owner, "forBot", { botId: initial.botId });
    expect(recovery.skills[0]?.content).toBeNull();
    expect(JSON.stringify(recovery).length).toBeLessThan(5000);
    expect(
      (await request(owner, "export", { botId: initial.botId, skillIds: [skillId] })).status,
    ).toBe(400);
  });
  it("redacts recognized credential text on preview and export while keeping ordinary emails", async () => {
    const owner = await account();
    const value = source();
    const secret = "a".repeat(48);
    value.profile.instructions += `Authorization: Bearer ${secret}\n`;
    const p = await preview(owner, value);
    expect(p.document.profile.instructions).not.toContain(secret);
    expect(p.document.profile.instructions).toContain("help@example.test");
    expect(p.leftOut).toContainEqual(
      expect.objectContaining({ name: "profile.instructions", kind: "secrets" }),
    );
    const r = await importPackage(owner, p);
    await database.prisma.bot.update({
      where: { id: r.botId! },
      data: { instructions: `Contact help@example.test. Authorization: Bearer ${secret}` },
    });
    const exported = await call<BotPackageExport>(owner, "export", { botId: r.botId });
    expect(exported.json).not.toContain(secret);
    expect(exported.json).toContain("help@example.test");
  });
  it("bounds recovery to 20 metadata-only own receipts", async () => {
    const owner = await account();
    await database.prisma.botPackageImport.createMany({
      data: Array.from({ length: 24 }, (_, index) => ({
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        clientNonce: `cancel-${index}`,
        status: "cancelled",
        botName: "Cancelled",
      })),
    });
    const recent = await call<BotPackageRecentReceipt[]>(owner, "recent");
    expect(recent).toHaveLength(20);
    expect(recent.every((entry) => !("plan" in entry) && !("skills" in entry))).toBe(true);
  });
  it("reclaims only 32 expired previews per request across actors and preserves unexpired previews", async () => {
    const owner = await account();
    const other = await account();
    const current = await preview(other);
    await database.prisma.botPackagePreview.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        spaceId: other.actor.spaceId,
        userId: other.actor.userId,
        tokenHash: `expired-${randomUUID()}`,
        digest: "a".repeat(64),
        sourceFormat: BOT_PACKAGE_FORMAT,
        document: source(),
        leftOut: [],
        expiresAt: new Date(1000 + index),
      })),
    });
    await call(owner, "recent");
    expect(
      await database.prisma.botPackagePreview.count({
        where: { userId: other.actor.userId, expiresAt: { lt: new Date() } },
      }),
    ).toBe(8);
    expect(
      await database.prisma.botPackagePreview.count({
        where: { userId: other.actor.userId, expiresAt: { gt: new Date() } },
      }),
    ).toBe(1);
    await call(owner, "status", { clientNonce: "no-intent" });
    expect(
      await database.prisma.botPackagePreview.count({
        where: { userId: other.actor.userId, expiresAt: { lt: new Date() } },
      }),
    ).toBe(0);
    expect((await importPackage(other, current)).status).toBe("completed");
  });
  it("maps real computer quota failures to actionable HTTP and resumes the same failed marker", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
    const owner = await account();
    await importPackage(owner, await preview(owner));
    const sibling = await createSpaceForMember(database.prisma, {
      currentSpaceId: owner.actor.spaceId,
      userId: owner.actor.userId,
      name: "Quota boundary",
    });
    const target = { ...owner, actor: { ...owner.actor, spaceId: sibling.id } };
    const standard = await handles.app.request("/rpc/bots/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: owner.cookie,
        "x-rakazo-space-id": sibling.id,
      },
      body: JSON.stringify({ json: { name: "Ordinary quota" } }),
    });
    expect(standard.status).toBe(400);
    expect(JSON.stringify(await standard.json())).toContain("User computer limit (1) reached");
    const p = await preview(target);
    const clientNonce = randomUUID();
    const failed = await request(target, "import", { previewToken: p.previewToken, clientNonce });
    expect(failed.status).toBe(400);
    expect(JSON.stringify(await failed.json())).toContain("User computer limit (1) reached");
    const marker = await database.prisma.botPackageImport.findUniqueOrThrow({
      where: {
        spaceId_userId_clientNonce: {
          spaceId: sibling.id,
          userId: owner.actor.userId,
          clientNonce,
        },
      },
    });
    expect(marker.status).toBe("failed");
    expect(marker.botId).toBeNull();
    expect(marker.plan).toEqual(p.document);
    expect(await database.prisma.bot.count({ where: { spaceId: sibling.id } })).toBe(0);
    expect(await database.prisma.thread.count({ where: { spaceId: sibling.id } })).toBe(0);
    expect(await database.prisma.computer.count({ where: { spaceId: sibling.id } })).toBe(0);
    expect((await request(target, "resume", { clientNonce })).status).toBe(400);
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "2");
    const resumed = await call<BotPackageReceipt>(target, "resume", { clientNonce });
    expect(resumed.status).toBe("completed");
    expect(resumed.importId).toBe(marker.id);
    expect(resumed.digest).toBe(p.digest);
    expect(await database.prisma.bot.count({ where: { spaceId: sibling.id } })).toBe(1);
    expect((await call<BotPackageReceipt>(target, "resume", { clientNonce })).botId).toBe(
      resumed.botId,
    );
  });
  it("maps a real Space deletion claim between marker acceptance and atomic creation to HTTP conflict", async () => {
    const owner = await account();
    const sibling = await createSpaceForMember(database.prisma, {
      currentSpaceId: owner.actor.spaceId,
      userId: owner.actor.userId,
      name: "Deletion boundary",
    });
    const target = { ...owner, actor: { ...owner.actor, spaceId: sibling.id } };
    const p = await preview(target);
    const clientNonce = randomUUID();
    let claim: Awaited<ReturnType<typeof claimEmptySpaceDeletionForMember>> | undefined;
    const deletion = {
      currentSpaceId: sibling.id,
      spaceId: sibling.id,
      userId: owner.actor.userId,
    };
    afterMarkerAccepted = async () => {
      claim = await claimEmptySpaceDeletionForMember(database.prisma, deletion);
    };
    try {
      const failed = await request(target, "import", { previewToken: p.previewToken, clientNonce });
      expect(failed.status).toBe(409);
      expect(JSON.stringify(await failed.json())).toContain(
        "Space deletion is already in progress",
      );
      expect(claim).toBeDefined();
      const marker = await database.prisma.botPackageImport.findUniqueOrThrow({
        where: {
          spaceId_userId_clientNonce: {
            spaceId: sibling.id,
            userId: owner.actor.userId,
            clientNonce,
          },
        },
      });
      expect(marker.status).toBe("failed");
      expect(marker.botId).toBeNull();
      expect(marker.plan).toEqual(p.document);
      expect(await database.prisma.bot.count({ where: { spaceId: sibling.id } })).toBe(0);
      expect(
        await database.prisma.botPackageComponent.count({ where: { importId: marker.id } }),
      ).toBe(0);
    } finally {
      if (claim)
        await releaseSpaceDeletionClaim(database.prisma, { ...deletion, claimId: claim.claimId });
    }
    expect((await call<BotPackageReceipt>(target, "status", { clientNonce })).status).toBe(
      "failed",
    );
    const resumed = await call<BotPackageReceipt>(target, "resume", { clientNonce });
    expect(resumed.status).toBe("completed");
    expect(resumed.digest).toBe(p.digest);
    expect(await database.prisma.bot.count({ where: { spaceId: sibling.id } })).toBe(1);
  });
  it("requires authenticated current membership and rejects oversized pure JSON before writes", async () => {
    const owner = await account();
    const p = await preview(owner);
    expect(
      (await request(owner, "preview", { source: JSON.stringify(source()) }, { anonymous: true }))
        .status,
    ).toBe(401);
    expect((await request(owner, "preview", { source: "中".repeat(1400000) })).status).toBe(400);
    expect((await request(owner, "preview", { source: "https://example.test/share" })).status).toBe(
      400,
    );
    await database.prisma.spaceMember.delete({
      where: { spaceId_userId: { spaceId: owner.actor.spaceId, userId: owner.actor.userId } },
    });
    expect(
      (await request(owner, "import", { previewToken: p.previewToken, clientNonce: randomUUID() }))
        .ok,
    ).toBe(false);
    expect(await database.prisma.bot.count({ where: { userId: owner.actor.userId } })).toBe(0);
  });
});
