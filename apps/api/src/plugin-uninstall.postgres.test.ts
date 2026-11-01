import { randomUUID } from "node:crypto";
import {
  ComposedSecretStore,
  EncryptedSecretStore,
  InfisicalSecretStore,
  withSecretPersistence,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { bootstrapUserSpace, createDb, IsolationError } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import { createPluginUninstaller } from "./plugin-uninstall.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

postgres("managed plugin uninstall acceptance", () => {
  let database: ReturnType<typeof createDb>;
  const users: string[] = [];
  const organizations: string[] = [];
  beforeAll(() => {
    database = createDb(process.env.DATABASE_URL!);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await database.prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    for (const id of users) await database.prisma.user.deleteMany({ where: { id } });
    await database.prisma.$disconnect();
    await database.pool.end();
  });

  async function account(): Promise<Actor> {
    const id = randomUUID();
    users.push(id);
    await database.prisma.user.create({
      data: { id, name: "Offline fixture", email: `${id}@example.test` },
    });
    const { spaceId } = await bootstrapUserSpace(
      database.prisma,
      { id },
      { signupsEnabled: "true", signupAllowlist: "" },
      { claimDeploymentOwner: false },
    );
    const space = await database.prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
    organizations.push(space.organizationId);
    return { userId: id, spaceId, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  async function installation(actor: Actor) {
    const store = new EncryptedSecretStore("offline-plugin-uninstall-fixture");
    const secret = await store.put("synthetic-mcp-token", {
      ...actor,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    });
    await database.prisma.secret.create({
      data: {
        id: secret.id,
        userId: actor.userId,
        spaceId: actor.spaceId,
        ciphertext: secret.ciphertext,
        kind: "mcp",
      },
    });
    const install = await database.prisma.capabilityInstall.create({
      data: {
        ...{ userId: actor.userId, spaceId: actor.spaceId },
        kind: "plugin",
        name: "Fixture plugin",
        source: "https://github.com/example/fixture",
        version: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        clientNonce: randomUUID(),
        requestBinding: "c".repeat(64),
      },
    });
    const server = await database.prisma.mcpServer.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        installId: install.id,
        name: "Fixture MCP",
        slug: randomUUID(),
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        secretId: secret.id,
      },
    });
    const skill = await database.prisma.agentSkill.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        installId: install.id,
        name: `fixture-${randomUUID()}`,
        description: "Offline fixture",
        content: "Synthetic instructions",
        source: "plugin",
      },
    });
    await database.prisma.capabilityInstall.update({
      where: { id: install.id },
      data: {
        config: {
          installedChildren: {
            skills: [{ id: skill.id, name: skill.name }],
            mcpServers: [
              {
                id: server.id,
                name: server.name,
                endpoint: server.endpoint,
                transport: server.transport,
              },
            ],
          },
        },
      },
    });
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const events = { notify: vi.fn(async () => undefined) };
    const prisma = withSecretPersistence(database.prisma, store);
    return {
      install,
      server,
      skill,
      secret,
      store,
      jobs,
      events,
      service: createPluginUninstaller({ prisma, secrets: store, jobs, events }),
    };
  }

  it("keeps a durable disabled tombstone on secret deletion failure and resumes exact cleanup", async () => {
    const actor = await account();
    const f = await installation(actor);
    const remove = vi
      .spyOn(f.store, "delete")
      .mockRejectedValue(new Error("synthetic store outage"));
    const failed = await f.service.uninstall(actor, {
      installId: f.install.id,
      expectedRevision: 1,
    });
    expect(failed.status).toBe("cleanup_failed");
    expect(JSON.stringify(failed)).not.toContain(f.secret.ciphertext);
    expect(
      await database.prisma.mcpServer.findUnique({ where: { id: f.server.id } }),
    ).toMatchObject({ enabled: false, secretId: null });
    expect(await database.prisma.agentSkill.count({ where: { installId: f.install.id } })).toBe(0);
    const tombstone = await database.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id: f.install.id },
    });
    expect(tombstone.cleanupRefs).toEqual([{ id: f.secret.id, ref: f.secret.ciphertext }]);
    remove.mockResolvedValue();
    const removed = await f.service.uninstall(actor, {
      installId: f.install.id,
      expectedRevision: failed.revision,
    });
    expect(removed).toMatchObject({
      status: "removed",
      clientNonce: f.install.clientNonce,
      skills: [{ id: f.skill.id }],
    });
    expect(await database.prisma.mcpServer.count({ where: { installId: f.install.id } })).toBe(0);
    expect(await database.prisma.secret.count({ where: { id: f.secret.id } })).toBe(0);
    const deletes = remove.mock.calls.length;
    expect(
      await f.service.uninstall(actor, { installId: f.install.id, expectedRevision: 1 }),
    ).toEqual(removed);
    expect(remove).toHaveBeenCalledTimes(deletes);
  });

  it("preserves a secret and unrelated server still sharing its exact row", async () => {
    const actor = await account();
    const f = await installation(actor);
    const other = await database.prisma.mcpServer.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: "Unrelated MCP",
        slug: randomUUID(),
        transport: "streamable_http",
        endpoint: "https://other.example.test",
        secretId: f.secret.id,
      },
    });
    const remove = vi.spyOn(f.store, "delete");
    expect(
      (await f.service.uninstall(actor, { installId: f.install.id, expectedRevision: 1 })).status,
    ).toBe("removed");
    expect(await database.prisma.mcpServer.findUnique({ where: { id: other.id } })).toMatchObject({
      enabled: true,
      secretId: f.secret.id,
    });
    expect(await database.prisma.secret.count({ where: { id: f.secret.id } })).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("uses current Space ownership rather than deployment ownership to authorize removal", async () => {
    const owner = await account();
    const member = await account();
    const f = await installation(owner);
    const space = await database.prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    await database.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    // Organization membership creates default-Space membership through the
    // deployed member_default_space_membership trigger; inspect that real row.
    const membership = await database.prisma.spaceMember.findUniqueOrThrow({
      where: { spaceId_userId: { spaceId: owner.spaceId, userId: member.userId } },
    });
    expect(membership.role).toBe("member");
    const actor = { ...member, spaceId: owner.spaceId, isDeploymentOwner: true };
    await expect(
      f.service.uninstall(actor, { installId: f.install.id, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      await database.prisma.mcpServer.findUnique({ where: { id: f.server.id } }),
    ).toMatchObject({ enabled: true });
    await database.prisma.spaceMember.update({
      where: { id: membership.id },
      data: { role: "owner" },
    });
    expect(
      (await f.service.uninstall(actor, { installId: f.install.id, expectedRevision: 1 })).status,
    ).toBe("removed");
    expect(await database.prisma.secret.count({ where: { id: f.secret.id } })).toBe(0);
  });

  it("administratively settles both card types and resumes the same waiting Run without a user denial", async () => {
    const actor = await account();
    const f = await installation(actor);
    const bot = await database.prisma.bot.create({
      data: { userId: actor.userId, spaceId: actor.spaceId, name: "Fixture", color: "blue" },
    });
    const thread = await database.prisma.thread.create({
      data: { userId: actor.userId, spaceId: actor.spaceId, botId: bot.id },
    });
    const task = await database.prisma.task.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Offline action",
        status: "running",
      },
    });
    const run = await database.prisma.run.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        trigger: "follow_up",
        status: "waiting_input",
      },
    });
    const effect = await database.prisma.externalEffect.create({
      data: {
        spaceId: actor.spaceId,
        runId: run.id,
        kind: "mcp__fixture__write",
        idempotencyKey: randomUUID(),
        status: "intended",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: f.server.id,
              resourceRevision: 1,
              toolName: "write",
            },
            args: {},
          },
        ],
      },
    });
    const message = await database.prisma.message.create({
      data: {
        threadId: thread.id,
        botId: bot.id,
        runId: run.id,
        seq: 0,
        role: "bot",
        blocks: [
          {
            kind: "ask",
            text: "Approve?",
            approvalEffectId: effect.id,
            status: "pending",
            actions: [{ id: "allow", label: "Allow" }],
          },
          {
            kind: "mcp_approval",
            serverId: f.server.id,
            name: f.server.name,
            transport: "streamable_http",
            endpoint: f.server.endpoint,
            needsOAuth: false,
            status: "pending",
          },
        ],
      },
    });
    await f.service.uninstall(actor, { installId: f.install.id, expectedRevision: 1 });
    expect(
      await database.prisma.externalEffect.findUnique({ where: { id: effect.id } }),
    ).toMatchObject({ status: "completed", result: { code: "plugin_removed" } });
    const updated = await database.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.blocks).toMatchObject([
      { kind: "ask", status: "answered" },
      { kind: "mcp_approval", status: "dismissed" },
    ]);
    expect(JSON.stringify(updated.blocks)).not.toContain('"answer"');
    expect(
      await database.prisma.actionApprovalRule.count({ where: { spaceId: actor.spaceId } }),
    ).toBe(0);
    expect(await database.prisma.run.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "queued",
    });
    expect(f.jobs.enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: run.id },
    });
    expect(await database.prisma.run.count({ where: { taskId: task.id } })).toBe(1);
  });
  it("retains an unknown credential-write marker while clearing other known refs", async () => {
    const actor = await account();
    const f = await installation(actor);
    const pending = { id: randomUUID(), pending: true as const };
    await database.prisma.capabilityInstall.update({
      where: { id: f.install.id },
      data: { cleanupRefs: [pending] },
    });
    const receipt = await f.service.uninstall(actor, {
      installId: f.install.id,
      expectedRevision: 1,
    });
    expect(receipt.status).toBe("cleanup_failed");
    expect(
      await database.prisma.capabilityInstall.findUnique({ where: { id: f.install.id } }),
    ).toMatchObject({ cleanupRefs: [pending] });
    expect(await database.prisma.secret.count({ where: { id: f.secret.id } })).toBe(0);
    expect(
      await database.prisma.mcpServer.findUnique({ where: { id: f.server.id } }),
    ).toMatchObject({ enabled: false });
  });

  it("retires an explicitly inline pending write without guessing the provider of old markers", async () => {
    const actor = await account();
    const f = await installation(actor);
    const id = randomUUID();
    await database.prisma.capabilityInstall.update({
      where: { id: f.install.id },
      data: { cleanupRefs: [{ id, pending: true, recoveryRef: f.store.prepareWrite(id) }] },
    });
    expect(
      (await f.service.uninstall(actor, { installId: f.install.id, expectedRevision: 1 })).status,
    ).toBe("removed");
    expect(
      (await database.prisma.capabilityInstall.findUniqueOrThrow({ where: { id: f.install.id } }))
        .cleanupRefs,
    ).toEqual([]);
  });

  it.each([false, true])(
    "recovers a lost remote acknowledgement using its original scope (configuration changed: %s)",
    async (changed) => {
      const actor = await account();
      const f = await installation(actor);
      const fake = infisicalFake();
      const writer = new InfisicalSecretStore({
        ...fake.options,
        fetch: async (input, init) => {
          const response = await fake.fetcher(input, init);
          if (init?.method === "POST" && String(input).includes("/secrets/"))
            throw new Error("synthetic acknowledgement lost after remote commit");
          return response;
        },
      });
      const id = randomUUID();
      const recoveryRef = writer.prepareWrite(id);
      const pending = { id, pending: true as const, recoveryRef };
      await database.prisma.capabilityInstall.update({
        where: { id: f.install.id },
        data: { cleanupRefs: [pending] },
      });
      await expect(
        writer.put(
          "synthetic-private-material",
          {
            ...actor,
            operationId: "offline",
            traceId: "offline",
            signal: new AbortController().signal,
          },
          { recordId: id, recoveryRef },
        ),
      ).rejects.toThrow();
      expect(fake.values.size).toBe(1);
      await writer.close();
      const remote = new InfisicalSecretStore({
        ...fake.options,
        ...(changed ? { projectId: "different-project" } : {}),
      });
      const store = new ComposedSecretStore(f.store, remote);
      const service = createPluginUninstaller({
        prisma: withSecretPersistence(database.prisma, store),
        secrets: store,
        events: f.events,
        jobs: f.jobs,
      });
      let receipt = await service.uninstall(actor, {
        installId: f.install.id,
        expectedRevision: 1,
      });
      try {
        expect(JSON.stringify(receipt)).not.toContain(recoveryRef);
        if (changed) {
          expect(receipt.status).toBe("cleanup_failed");
          expect(fake.values.size).toBe(1);
          expect(
            (
              await database.prisma.capabilityInstall.findUniqueOrThrow({
                where: { id: f.install.id },
              })
            ).cleanupRefs,
          ).toEqual([pending]);
          const matching = new ComposedSecretStore(f.store, new InfisicalSecretStore(fake.options));
          try {
            receipt = await createPluginUninstaller({
              prisma: withSecretPersistence(database.prisma, matching),
              secrets: matching,
              events: f.events,
              jobs: f.jobs,
            }).uninstall(actor, { installId: f.install.id, expectedRevision: receipt.revision });
          } finally {
            await matching.close();
          }
        }
        expect(receipt.status).toBe("removed");
        expect(fake.values.size).toBe(0);
        expect(
          (
            await database.prisma.capabilityInstall.findUniqueOrThrow({
              where: { id: f.install.id },
            })
          ).cleanupRefs,
        ).toEqual([]);
        expect(await database.prisma.mcpServer.count({ where: { installId: f.install.id } })).toBe(
          0,
        );
      } finally {
        await store.close();
      }
    },
  );

  it("cannot finish uninstall while a remote create may still complete late", async () => {
    const actor = await account();
    const f = await installation(actor);
    const fake = infisicalFake();
    let opened!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = new InfisicalSecretStore({
      ...fake.options,
      fetch: async (input, init) => {
        if (init?.method === "POST" && String(input).includes("/secrets/")) {
          opened();
          await gate;
        }
        return fake.fetcher(input, init);
      },
    });
    const store = new ComposedSecretStore(f.store, remote);
    const id = randomUUID();
    const recoveryRef = store.prepareWrite(id);
    const pending = { id, pending: true as const, recoveryRef };
    await database.prisma.capabilityInstall.update({
      where: { id: f.install.id },
      data: { cleanupRefs: [pending] },
    });
    const writing = store.put(
      "synthetic-late-material",
      {
        ...actor,
        operationId: "offline",
        traceId: "offline",
        signal: new AbortController().signal,
      },
      { recordId: id, recoveryRef },
    );
    const service = createPluginUninstaller({
      prisma: withSecretPersistence(database.prisma, store),
      secrets: store,
      events: f.events,
      jobs: f.jobs,
    });
    try {
      await started;
      const blocked = await service.uninstall(actor, {
        installId: f.install.id,
        expectedRevision: 1,
      });
      expect(blocked.status).toBe("cleanup_failed");
      expect(
        (await database.prisma.capabilityInstall.findUniqueOrThrow({ where: { id: f.install.id } }))
          .cleanupRefs,
      ).toEqual([pending]);
      expect(
        await database.prisma.mcpServer.findUnique({ where: { id: f.server.id } }),
      ).toMatchObject({ enabled: false });
      expect(fake.values.size).toBe(0);
      release();
      await writing;
      expect(fake.values.size).toBe(1);
      expect(
        (
          await service.uninstall(actor, {
            installId: f.install.id,
            expectedRevision: blocked.revision,
          })
        ).status,
      ).toBe("removed");
      expect(fake.values.size).toBe(0);
    } finally {
      release();
      await writing.catch(() => undefined);
      await store.close();
    }
  });
});
