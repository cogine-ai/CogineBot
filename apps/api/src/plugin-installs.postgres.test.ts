import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  SecretContext,
  SecretPutOptions,
  SecretRecord,
} from "@rakazo/adapter-kit";
import type { PluginRead } from "@rakazo/adapters";
import { BUILTIN_AGENT_SKILLS, EncryptedSecretStore } from "@rakazo/adapters";
import type {
  Actor,
  PluginInstallInput,
  PluginInstallReceipt,
  PluginPreview,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listAgentSkillRecords } from "../../../packages/adapters/src/skill-tools.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";
const sourceSha = "a".repeat(40);
const treeSha = "b".repeat(40);

function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, released, enter, release };
}
type Barrier = ReturnType<typeof barrier>;

// The store encrypts real fixture material; faults affect only the external acknowledgement.
class FixtureSecretStore extends EncryptedSecretStore {
  readonly records = new Map<string, SecretRecord>();
  puts = 0;
  deletes = 0;
  unknownAck = false;
  failDelete = false;
  nextPut: Barrier | undefined;

  override async put(
    plaintext: string,
    context: AdapterContext,
    options?: SecretPutOptions,
  ): Promise<SecretRecord> {
    const stored = await super.put(plaintext, context, options);
    if (context.operationId !== "plugins.install") return stored;
    this.puts++;
    this.records.set(stored.id, stored);
    const paused = this.nextPut;
    this.nextPut = undefined;
    if (paused) {
      paused.enter();
      await paused.released;
    }
    if (this.unknownAck) throw new Error("Synthetic vault acknowledgement lost");
    return stored;
  }

  override async delete(ref: string, context: SecretContext): Promise<void> {
    this.deletes++;
    if (this.failDelete) throw new Error("Synthetic vault deletion outage");
    await super.delete(ref, context);
    const id = typeof context === "string" ? context : context.recordId;
    this.records.delete(id);
  }
}

type Account = { cookie: string; actor: Actor };
type Fixture = {
  repository: string;
  source: string;
  files: Map<string, string>;
  skillName: string;
  skill: string;
  credential: string;
};

postgres("GitHub plugin installation through authenticated application HTTP", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let database: ReturnType<typeof createDb>;
  let dataDir: string;
  const users: string[] = [];
  const organizations: string[] = [];
  const fixtures = new Map<string, Fixture>();
  const secrets = new FixtureSecretStore("offline-plugin-http-fixture-key");
  const outbound = vi.fn(async () => {
    throw new Error("Plugin installation must not contact an MCP transport");
  });
  let pauseRead: Barrier | undefined;
  let secondChildFailure = false;
  const held: Barrier[] = [];
  const read = vi.fn<PluginRead>(async (url, maxBytes, signal) => {
    const paused = pauseRead;
    pauseRead = undefined;
    if (paused) {
      paused.enter();
      await paused.released;
    }
    signal?.throwIfAborted();
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const repository =
      parsed.hostname === "api.github.com" ? `${parts[1]}/${parts[2]}` : `${parts[0]}/${parts[1]}`;
    const fixture = fixtures.get(repository);
    if (!fixture) throw new Error("Unexpected synthetic GitHub repository");
    let body: string;
    if (parsed.hostname === "api.github.com" && parts[3] === "commits") {
      expect(["HEAD", sourceSha]).toContain(parts[4]);
      body = JSON.stringify({ sha: sourceSha, commit: { tree: { sha: treeSha } } });
    } else if (
      parsed.hostname === "api.github.com" &&
      parts[3] === "git" &&
      parts[4] === "trees" &&
      parts[5] === treeSha
    ) {
      body = JSON.stringify({
        truncated: false,
        tree: [...fixture.files].map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          size: Buffer.byteLength(content),
        })),
      });
    } else if (parsed.hostname === "raw.githubusercontent.com" && parts[2] === sourceSha) {
      const content = fixture.files.get(parts.slice(3).join("/"));
      if (content === undefined) throw new Error("Unexpected synthetic GitHub file");
      body = content;
    } else throw new Error("Unexpected synthetic GitHub route");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBytes);
    return body;
  });

  // Every query and transaction runs on real PG. Only the second child write can fail.
  function faultablePrisma(prisma: PrismaClient): PrismaClient {
    return new Proxy(prisma, {
      get(client, property, receiver) {
        if (property === "$extends")
          return (...args: unknown[]) =>
            faultablePrisma(Reflect.apply(client.$extends, client, args) as PrismaClient);
        if (property !== "$transaction") return Reflect.get(client, property, receiver);
        return (...args: unknown[]) => {
          if (typeof args[0] === "function") {
            const callback = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
            args[0] = (tx: Prisma.TransactionClient) => {
              let children = 0;
              const wrapped = new Proxy(tx, {
                get(target, key, txReceiver) {
                  if (key !== "mcpServer") return Reflect.get(target, key, txReceiver);
                  return new Proxy(target.mcpServer, {
                    get(model, operation, modelReceiver) {
                      if (operation !== "create")
                        return Reflect.get(model, operation, modelReceiver);
                      return (...createArgs: unknown[]) => {
                        children++;
                        if (secondChildFailure && children === 2) {
                          secondChildFailure = false;
                          throw new Error("Synthetic second child transaction failure");
                        }
                        return Reflect.apply(model.create, model, createArgs);
                      };
                    },
                  });
                },
              });
              return callback(wrapped);
            };
          }
          return Reflect.apply(client.$transaction, client, args);
        };
      },
    });
  }

  function request(
    account: Account,
    procedure: string,
    input: unknown = {},
    options: { spaceId?: string; signal?: AbortSignal; anonymous?: boolean } = {},
  ) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: options.anonymous ? "" : account.cookie,
        "x-rakazo-space-id": options.spaceId ?? account.actor.spaceId,
      },
      body: JSON.stringify({ json: input }),
      signal: options.signal,
    });
  }
  async function call<T>(
    account: Account,
    procedure: string,
    input: unknown = {},
    options?: Parameters<typeof request>[3],
  ): Promise<T> {
    const response = await request(account, procedure, input, options);
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
        name: "Offline plugin fixture",
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
    const space = await database.prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
    organizations.push(space.organizationId);
    return { cookie, actor };
  }
  function fixture(options: { servers?: number; skillName?: string } = {}): Fixture {
    const suffix = randomUUID();
    const repository = `example/plugin-${suffix}`;
    const skillName = options.skillName ?? `fixture-${suffix}`;
    const skill =
      `---\r\nname: ${skillName}\r\ndescription: Offline exact instructions\r\n` +
      "notes: |+\r\n  preserve blank lines\r\n\r\n---\r\n\r\nOriginal instructions.\r\n\r\n";
    const credential = `fixture-credential-${suffix}`;
    const files = new Map([
      [
        ".cursor-plugin/plugin.json",
        JSON.stringify({
          name: "fixture-plugin",
          description: "Offline fixture",
          version: "1.0.0",
        }),
      ],
      ["skills/example/SKILL.md", skill],
    ]);
    if (options.servers) {
      files.set(
        ".mcp.json",
        JSON.stringify({
          mcpServers: Object.fromEntries(
            Array.from({ length: options.servers }, (_, index) => [
              `server-${index}`,
              {
                type: index === 0 ? "http" : "sse",
                url: `https://tools.example.test/${suffix}/mcp-${index}`,
                headers: { Authorization: `Bearer ${credential}`, "X-Tenant": "fixture-routing" },
              },
            ]),
          ),
        }),
      );
    }
    const result = {
      repository,
      source: `https://github.com/${repository}`,
      files,
      skillName,
      skill,
      credential,
    };
    fixtures.set(repository, result);
    return result;
  }
  const preview = (actor: Account, f: Fixture) =>
    call<PluginPreview>(actor, "plugins/preview", { source: f.source });
  const intent = (p: PluginPreview, clientNonce = randomUUID()): PluginInstallInput => ({
    source: p.source,
    sourceSha: p.sourceSha,
    digest: p.digest,
    clientNonce,
  });
  const install = (actor: Account, input: PluginInstallInput) =>
    call<PluginInstallReceipt>(actor, "plugins/install", input);
  const list = (actor: Account, spaceId?: string) =>
    call<PluginInstallReceipt[]>(actor, "plugins/list", {}, { spaceId });
  const uninstall = (actor: Account, receipt: PluginInstallReceipt) =>
    call<PluginInstallReceipt>(actor, "plugins/uninstall", {
      installId: receipt.id,
      expectedRevision: receipt.revision,
    });
  async function noChildren(installId: string) {
    expect(await database.prisma.agentSkill.count({ where: { installId } })).toBe(0);
    expect(await database.prisma.mcpServer.count({ where: { installId } })).toBe(0);
  }
  function holdRead() {
    const paused = barrier();
    pauseRead = paused;
    held.push(paused);
    return paused;
  }
  async function share(owner: Account, member: Account) {
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
      create: {
        id: randomUUID(),
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: member.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
      update: { role: "member" },
    });
    await database.prisma.session.updateMany({
      where: { userId: member.actor.userId },
      data: { activeOrganizationId: space.organizationId },
    });
    return { ...member, actor: { ...member.actor, spaceId: space.id } };
  }

  beforeAll(async () => {
    database = createDb(process.env.DATABASE_URL!);
    dataDir = await mkdtemp(join(tmpdir(), "plugin-installs-http-"));
    handles = await createApp({
      prisma: faultablePrisma(database.prisma),
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      encryptionKey: "offline-plugin-http-fixture-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
      secretStore: secrets,
      pluginRead: read,
      remoteConnectors: {
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
        fetch: outbound,
      },
    });
  });
  afterEach(() => {
    for (const paused of held.splice(0)) paused.release();
    pauseRead = undefined;
    secrets.nextPut = undefined;
    secrets.unknownAck = false;
    secrets.failDelete = false;
    secondChildFailure = false;
    expect(outbound).not.toHaveBeenCalled();
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

  it("requires authentication before any repository read", async () => {
    const actor = await account();
    const f = fixture();
    const reads = read.mock.calls.length;
    expect(
      (await request(actor, "plugins/preview", { source: f.source }, { anonymous: true })).status,
    ).toBe(401);
    expect(read.mock.calls).toHaveLength(reads);
  });

  it("previews full original instructions, persists only encrypted headers, and installs disabled servers", async () => {
    const actor = await account();
    const f = fixture({ servers: 2 });
    const p = await preview(actor, f);
    expect(p).toMatchObject({
      source: `${f.source}/tree/${sourceSha}`,
      sourceSha,
      skills: [{ name: f.skillName, content: f.skill }],
      mcpServers: [
        { transport: "streamable_http", headerKeys: ["Authorization", "X-Tenant"] },
        { transport: "sse" },
      ],
    });
    expect(JSON.stringify(p)).not.toContain(f.credential);
    const start = read.mock.calls.length;
    const receipt = await install(actor, intent(p));
    expect(receipt.status).toBe("installed");
    expect(receipt.installedAt).not.toBeNull();
    expect(read.mock.calls.slice(start).some(([url]) => url.endsWith("/commits/HEAD"))).toBe(false);
    expect(read.mock.calls[start]?.[0]).toBe(
      `https://api.github.com/repos/${f.repository}/commits/${sourceSha}`,
    );
    expect(await list(actor)).toEqual([receipt]);
    const row = await database.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(JSON.stringify(row.config)).not.toContain(f.credential);
    expect(JSON.stringify(row.cleanupRefs)).toBe("[]");
    const saved = await database.prisma.agentSkill.findUniqueOrThrow({
      where: { id: receipt.skills[0]!.id },
    });
    expect(saved).toMatchObject({ content: f.skill, source: "plugin", installId: receipt.id });
    const servers = await database.prisma.mcpServer.findMany({
      where: { installId: receipt.id },
      include: { secret: true },
    });
    expect(servers).toHaveLength(2);
    for (const server of servers) {
      expect(server).toMatchObject({
        enabled: false,
        allowAllTools: false,
        allowedTools: [],
        args: [],
        env: {},
      });
      expect(server.headers).toEqual({ Authorization: true, "X-Tenant": true });
      expect(JSON.stringify({ ...server, secret: undefined })).not.toContain(f.credential);
      expect(server.secret).not.toBeNull();
      const material = await secrets.load(server.secret!.ciphertext, {
        recordId: server.secret!.id,
      });
      expect(JSON.parse(material)).toMatchObject({
        headers: { Authorization: `Bearer ${f.credential}` },
      });
    }
    expect(
      await database.prisma.connection.count({
        where: { userId: actor.actor.userId, spaceId: actor.actor.spaceId },
      }),
    ).toBe(0);
    expect(
      (await request(actor, "agentSkills/update", { skillId: saved.id, content: "Replacement" }))
        .status,
    ).toBe(400);
    expect((await request(actor, "agentSkills/remove", { skillId: saved.id })).status).toBe(400);
  });

  it("rejects a changed digest or conflicting pin without creating a receipt or credential", async () => {
    const actor = await account();
    const p = await preview(actor, fixture({ servers: 1 }));
    const puts = secrets.puts;
    expect(
      (
        await request(actor, "plugins/install", {
          ...intent(p),
          digest: `sha256:${"0".repeat(64)}`,
        })
      ).status,
    ).toBe(409);
    const reads = read.mock.calls.length;
    expect(
      (await request(actor, "plugins/install", { ...intent(p), sourceSha: treeSha })).status,
    ).toBe(400);
    expect(read.mock.calls).toHaveLength(reads);
    expect(await list(actor)).toEqual([]);
    expect(secrets.puts).toBe(puts);
    expect(await database.prisma.agentSkill.count({ where: { userId: actor.actor.userId } })).toBe(
      0,
    );
  });

  it("excludes surviving instructions from inactive managed plugins while preserving user and legacy skills", async () => {
    const actor = await account();
    const f = fixture();
    const receipt = await install(actor, intent(await preview(actor, f)));
    const managedId = receipt.skills[0]!.id;
    const own = await call<{ id: string; name: string }>(actor, "agentSkills/create", {
      name: `own-${randomUUID()}`,
      description: "Ordinary fixture instructions",
      body: "Keep available.",
    });
    const legacyParent = await database.prisma.capabilityInstall.create({
      data: {
        spaceId: actor.actor.spaceId,
        userId: actor.actor.userId,
        kind: "plugin",
        name: "Legacy fixture",
        source: "fixture:legacy-plugin",
        clientNonce: null,
        status: "cleanup_failed",
      },
    });
    const legacy = await database.prisma.agentSkill.create({
      data: {
        spaceId: actor.actor.spaceId,
        userId: actor.actor.userId,
        installId: legacyParent.id,
        name: `legacy-${randomUUID()}`,
        description: "Legacy fixture instructions",
        content: "Legacy instructions remain available.",
        source: "plugin",
      },
    });
    expect(
      (await listAgentSkillRecords(database.prisma, actor.actor)).map((skill) => skill.id),
    ).toContain(managedId);
    for (const status of ["cleanup_failed", "uninstalling"]) {
      // Simulate a recovery residue without deleting the real child. Admission owns this fence.
      await database.prisma.capabilityInstall.update({
        where: { id: receipt.id },
        data: { status },
      });
      expect(
        await database.prisma.agentSkill.findUnique({ where: { id: managedId } }),
      ).not.toBeNull();
      const catalog = await call<Array<{ id: string }>>(actor, "agentSkills/list");
      const ids = catalog.map((skill) => skill.id);
      expect(ids).not.toContain(managedId);
      expect(ids).toEqual(expect.arrayContaining([own.id, legacy.id]));
      const runtime = await listAgentSkillRecords(database.prisma, actor.actor);
      expect(runtime.map((skill) => skill.id)).not.toContain(managedId);
      expect(runtime.map((skill) => skill.id)).toEqual(expect.arrayContaining([own.id, legacy.id]));
      for (const input of [{ skillId: managedId }, { name: f.skillName }])
        expect((await request(actor, "agentSkills/get", input)).status).toBe(404);
      expect(
        await call<{ id: string }>(actor, "agentSkills/get", { skillId: own.id }),
      ).toMatchObject({ id: own.id });
      expect(
        await call<{ id: string }>(actor, "agentSkills/get", { name: legacy.name }),
      ).toMatchObject({ id: legacy.id });
    }
  });

  it("claims a concurrent nonce once and exposes pending work without a false installation time", async () => {
    const actor = await account();
    const p = await preview(actor, fixture({ servers: 1 }));
    const input = intent(p);
    const paused = barrier();
    held.push(paused);
    secrets.nextPut = paused;
    const puts = secrets.puts;
    const first = install(actor, input);
    try {
      await paused.entered;
      const reads = read.mock.calls.length;
      const duplicate = await install(actor, input);
      expect(duplicate).toMatchObject({
        status: "installing",
        installedAt: null,
        clientNonce: input.clientNonce,
      });
      expect(read.mock.calls).toHaveLength(reads);
      expect((await list(actor))[0]).toEqual(duplicate);
      await noChildren(duplicate.id);
      expect(secrets.puts).toBe(puts + 1);
    } finally {
      paused.release();
    }
    const installed = await first;
    expect(installed.status).toBe("installed");
    expect(installed.installedAt).not.toBeNull();
    expect(await list(actor)).toEqual([installed]);
    expect(
      await database.prisma.capabilityInstall.count({
        where: { clientNonce: input.clientNonce, userId: actor.actor.userId },
      }),
    ).toBe(1);
    expect(await database.prisma.agentSkill.count({ where: { installId: installed.id } })).toBe(1);
    expect(await database.prisma.mcpServer.count({ where: { installId: installed.id } })).toBe(1);
  });

  it("rejects a competing plugin's same-name skill at final commit without replacing either receipt", async () => {
    const actor = await account();
    const name = `competing-${randomUUID()}`;
    const firstInput = intent(await preview(actor, fixture({ servers: 1, skillName: name })));
    const secondInput = intent(await preview(actor, fixture({ skillName: name })));
    const paused = barrier();
    held.push(paused);
    secrets.nextPut = paused;
    const pending = install(actor, firstInput);
    let winner: PluginInstallReceipt;
    try {
      await paused.entered;
      winner = await install(actor, secondInput);
      expect(winner.status).toBe("installed");
    } finally {
      paused.release();
    }
    const rejected = await pending;
    expect(rejected.status).toBe("failed");
    expect(rejected.clientNonce).toBe(firstInput.clientNonce);
    await noChildren(rejected.id);
    expect(await install(actor, firstInput)).toEqual(rejected);
    expect(
      await database.prisma.agentSkill.findMany({
        where: { spaceId: actor.actor.spaceId, userId: actor.actor.userId, name },
        select: { installId: true },
      }),
    ).toEqual([{ installId: winner!.id }]);
    expect((await list(actor)).map((row) => row.id).sort()).toEqual(
      [winner!.id, rejected.id].sort(),
    );
  });

  it("binds a nonce to its original payload and preserves removed outcomes without network or writes", async () => {
    const actor = await account();
    const p = await preview(actor, fixture({ servers: 1 }));
    const input = intent(p);
    const installed = await install(actor, input);
    const reads = read.mock.calls.length;
    const puts = secrets.puts;
    expect(
      (await request(actor, "plugins/install", { ...input, digest: `sha256:${"0".repeat(64)}` }))
        .status,
    ).toBe(409);
    const removed = await uninstall(actor, installed);
    expect(removed.status).toBe("removed");
    expect(removed.installedAt).toBe(installed.installedAt);
    expect(await install(actor, input)).toEqual(removed);
    expect(await list(actor)).toEqual([removed]);
    expect(read.mock.calls).toHaveLength(reads);
    expect(secrets.puts).toBe(puts);
    await noChildren(installed.id);
  });

  it("reports built-in and existing case-insensitive skill conflicts before claiming an install", async () => {
    const actor = await account();
    const existingName = `Existing-${randomUUID()}`;
    await database.prisma.agentSkill.create({
      data: {
        userId: actor.actor.userId,
        spaceId: actor.actor.spaceId,
        name: existingName,
        description: "Fixture",
        content: "Fixture",
      },
    });
    for (const [name, expected] of [
      [existingName.toLowerCase(), existingName],
      [BUILTIN_AGENT_SKILLS[0]!.name, BUILTIN_AGENT_SKILLS[0]!.name],
    ]) {
      const p = await preview(actor, fixture({ servers: 1, skillName: name }));
      const response = await request(actor, "plugins/install", intent(p));
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(409);
      expect(JSON.stringify(body)).toContain(expected);
    }
    expect(await list(actor)).toEqual([]);
  });

  it("isolates the same nonce by user and Space and enforces current Space ownership on removal", async () => {
    const owner = await account();
    const member = await share(owner, await account());
    const outsider = await account();
    const nonce = randomUUID();
    const p = await preview(owner, fixture());
    const installed = await install(owner, intent(p, nonce));
    expect(await list(member)).toEqual([]);
    expect(
      (
        await request(member, "plugins/uninstall", {
          installId: installed.id,
          expectedRevision: installed.revision,
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(outsider, "plugins/list", {}, { spaceId: owner.actor.spaceId })).status,
    ).toBe(403);
    const memberInstall = await install(member, intent(p, nonce));
    expect(memberInstall.id).not.toBe(installed.id);
    expect(await list(owner)).toEqual([installed]);
    const removedByOwner = await call<PluginInstallReceipt>(owner, "plugins/uninstall", {
      installId: memberInstall.id,
      expectedRevision: memberInstall.revision,
    });
    expect(removedByOwner.status).toBe("removed");
    const extraSpace = await call<{ id: string }>(owner, "spaces/create", {
      name: "Plugin fixture Space",
    });
    const otherSpace = { ...owner, actor: { ...owner.actor, spaceId: extraSpace.id } };
    const second = await install(otherSpace, intent(p, nonce));
    expect(second.id).not.toBe(installed.id);
    expect(await list(otherSpace)).toEqual([second]);
    expect(await list(owner)).toEqual([installed]);
  });

  it("requires the current revision and prevents generic removal from bypassing managed cleanup", async () => {
    const actor = await account();
    const receipt = await install(actor, intent(await preview(actor, fixture({ servers: 1 }))));
    expect(
      (
        await request(actor, "plugins/uninstall", {
          installId: receipt.id,
          expectedRevision: receipt.revision + 1,
        })
      ).status,
    ).toBe(409);
    expect((await request(actor, "capabilities/remove", { id: receipt.id })).status).toBe(400);
    expect(
      (await request(actor, "mcp/servers/remove", { id: receipt.mcpServers[0]!.id })).status,
    ).toBe(400);
    expect((await list(actor))[0]).toEqual(receipt);
    const legacy = await database.prisma.capabilityInstall.create({
      data: {
        userId: actor.actor.userId,
        spaceId: actor.actor.spaceId,
        kind: "skill",
        name: "Legacy fixture",
        source: "fixture:legacy",
      },
    });
    await call(actor, "capabilities/remove", { id: legacy.id });
    expect(
      await database.prisma.capabilityInstall.findUnique({ where: { id: legacy.id } }),
    ).toBeNull();
    expect((await uninstall(actor, receipt)).status).toBe("removed");
  });

  it("rolls back a second child failure and retains a replayable failed receipt after strict cleanup", async () => {
    const actor = await account();
    const input = intent(await preview(actor, fixture({ servers: 2 })));
    const records = new Set(secrets.records.keys());
    secondChildFailure = true;
    const failed = await install(actor, input);
    expect(failed).toMatchObject({ status: "failed", installedAt: null });
    await noChildren(failed.id);
    expect(await database.prisma.secret.count({ where: { userId: actor.actor.userId } })).toBe(0);
    expect(new Set(secrets.records.keys())).toEqual(records);
    const reads = read.mock.calls.length;
    const puts = secrets.puts;
    expect(await install(actor, input)).toEqual(failed);
    expect(read.mock.calls).toHaveLength(reads);
    expect(secrets.puts).toBe(puts);
  });

  it("retains cleanup references after a provider deletion failure and resumes through explicit uninstall", async () => {
    const actor = await account();
    const f = fixture({ servers: 2 });
    const input = intent(await preview(actor, f));
    secondChildFailure = true;
    secrets.failDelete = true;
    const failed = await install(actor, input);
    expect(failed).toMatchObject({ status: "cleanup_failed", installedAt: null });
    await noChildren(failed.id);
    const row = await database.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id: failed.id },
    });
    expect(Array.isArray(row.cleanupRefs) && row.cleanupRefs.length).toBe(2);
    expect(JSON.stringify(failed)).not.toContain("cleanupRefs");
    expect(JSON.stringify(failed)).not.toContain(f.credential);
    const reads = read.mock.calls.length;
    const puts = secrets.puts;
    expect(await install(actor, input)).toEqual(failed);
    expect(read.mock.calls).toHaveLength(reads);
    expect(secrets.puts).toBe(puts);
    secrets.failDelete = false;
    const removed = await uninstall(actor, failed);
    expect(removed).toMatchObject({ status: "removed", installedAt: null });
    expect(
      (await database.prisma.capabilityInstall.findUniqueOrThrow({ where: { id: failed.id } }))
        .cleanupRefs,
    ).toEqual([]);
  });

  it("keeps unknown credential acknowledgement pending and never reports installation success", async () => {
    const actor = await account();
    const f = fixture({ servers: 1 });
    const input = intent(await preview(actor, f));
    secrets.unknownAck = true;
    const result = await install(actor, input);
    expect(result).toMatchObject({ status: "cleanup_failed", installedAt: null });
    await noChildren(result.id);
    const row = await database.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(row.cleanupRefs).toEqual([{ id: expect.any(String), pending: true }]);
    expect(JSON.stringify(result)).not.toContain("cleanupRefs");
    expect(JSON.stringify(result)).not.toContain(f.credential);
    expect(await database.prisma.secret.count({ where: { userId: actor.actor.userId } })).toBe(0);
    const reads = read.mock.calls.length;
    const puts = secrets.puts;
    secrets.unknownAck = false;
    expect(await install(actor, input)).toEqual(result);
    expect(read.mock.calls).toHaveLength(reads);
    expect(secrets.puts).toBe(puts);
  });

  it.each(["session", "membership", "abort"] as const)(
    "does not commit after %s is withdrawn during repository acquisition",
    async (withdrawal) => {
      const actor = await account();
      const input = intent(await preview(actor, fixture({ servers: 1 })));
      const paused = holdRead();
      const controller = new AbortController();
      const puts = secrets.puts;
      const pending = request(actor, "plugins/install", input, { signal: controller.signal }).catch(
        () => null,
      );
      try {
        await paused.entered;
        if (withdrawal === "session")
          await database.prisma.session.deleteMany({ where: { userId: actor.actor.userId } });
        else if (withdrawal === "membership")
          await database.prisma.spaceMember.deleteMany({
            where: { spaceId: actor.actor.spaceId, userId: actor.actor.userId },
          });
        else controller.abort();
      } finally {
        paused.release();
      }
      const response = await pending;
      if (response) expect(response.status).not.toBe(200);
      expect(
        await database.prisma.capabilityInstall.count({
          where: { userId: actor.actor.userId, clientNonce: input.clientNonce },
        }),
      ).toBe(0);
      expect(
        await database.prisma.agentSkill.count({ where: { userId: actor.actor.userId } }),
      ).toBe(0);
      expect(await database.prisma.mcpServer.count({ where: { userId: actor.actor.userId } })).toBe(
        0,
      );
      expect(secrets.puts).toBe(puts);
    },
  );
});
