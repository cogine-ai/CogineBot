import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Bot,
  Group,
  SpaceCollaborationPolicy,
  SpaceNavigation,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";

describePostgres("Space collaboration through authenticated application HTTP", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let ownerCookie: string;
  let memberCookie: string;
  let owner: Actor;
  let member: Actor;

  const request = (
    procedure: string,
    input: unknown = {},
    cookie = ownerCookie,
    spaceId?: string,
  ) =>
    handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  async function call<T>(
    procedure: string,
    input: unknown = {},
    cookie = ownerCookie,
    spaceId?: string,
  ) {
    const response = await request(procedure, input, cookie, spaceId);
    const body = (await response.json()) as { json: T };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.json;
  }
  async function signup() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${randomUUID()}@example.test`,
        password: "offline-password-123",
        name: "Collaboration fixture",
      }),
    });
    expect(response.ok).toBe(true);
    return sessionCookieHeader(response);
  }
  async function currentPolicy(cookie = ownerCookie) {
    const navigation = await call<SpaceNavigation>("spaces/list", {}, cookie, owner.spaceId);
    const space = navigation.spaces.find((candidate) => candidate.id === owner.spaceId);
    expect(space).toBeDefined();
    return space!;
  }
  async function closeCollaboration() {
    const policy = await currentPolicy();
    await call("spaces/update", {
      spaceId: owner.spaceId,
      allowBotCollaboration: false,
      expectedCollaborationRevision: policy.collaborationRevision,
    });
  }
  async function createQuietBot(name: string) {
    const bot = await call<Bot>("bots/create", { name });
    return discardBotIntroFromCreate(handles, ownerCookie, "bots/create", bot);
  }
  async function expectCompleted(runIds: string[]) {
    await expect
      .poll(
        async () => {
          const rows = await handles.prisma.run.findMany({
            where: { id: { in: runIds } },
            select: { status: true, error: true },
          });
          return rows.length === runIds.length && rows.every((run) => run.status === "completed");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  }
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "space-collaboration-app-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      encryptionKey: "offline-collaboration-fixture-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
    });
    ownerCookie = await signup();
    owner = await call<Actor>("me");
    memberCookie = await signup();
    member = await call<Actor>("me", {}, memberCookie);
    const space = await handles.prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    if (
      !(await handles.prisma.member.findFirst({
        where: { organizationId: space.organizationId, userId: member.userId },
      }))
    ) {
      await handles.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId: member.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
    }
    await handles.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: member.userId } },
      create: {
        id: randomUUID(),
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      },
      update: { role: "member" },
    });
    await handles.prisma.session.updateMany({
      where: { userId: member.userId },
      data: { activeOrganizationId: space.organizationId },
    });
  });
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("requires a signed-in session for updates", async () => {
    expect(
      (
        await request(
          "spaces/update",
          {
            spaceId: owner.spaceId,
            allowBotCollaboration: false,
            expectedCollaborationRevision: 0,
          },
          "",
        )
      ).status,
    ).toBe(401);
  });
  it("publishes fresh owner policy and persists the owner setting through production composition", async () => {
    expect(await currentPolicy()).toMatchObject({
      allowBotCollaboration: true,
      collaborationRevision: 0,
      canManageCollaboration: true,
    });
    expect(
      await call<SpaceCollaborationPolicy>("spaces/update", {
        spaceId: owner.spaceId,
        allowBotCollaboration: false,
        expectedCollaborationRevision: 0,
      }),
    ).toMatchObject({ allowBotCollaboration: false, collaborationRevision: 1 });
    expect(await currentPolicy()).toMatchObject({
      allowBotCollaboration: false,
      collaborationRevision: 1,
    });
  });
  it("shows members the setting but rejects a forged manage flag", async () => {
    expect(await currentPolicy(memberCookie)).toMatchObject({
      allowBotCollaboration: false,
      collaborationRevision: 1,
      canManageCollaboration: false,
    });
    expect(
      (
        await request(
          "spaces/update",
          {
            spaceId: owner.spaceId,
            allowBotCollaboration: true,
            expectedCollaborationRevision: 1,
            canManageCollaboration: true,
          },
          memberCookie,
          owner.spaceId,
        )
      ).status,
    ).toBe(403);
  });
  it("does not treat deployment ownership as Space ownership", async () => {
    expect((await call<Actor>("me")).isDeploymentOwner).toBe(true);
    await handles.prisma.spaceMember.update({
      where: { spaceId_userId: { spaceId: owner.spaceId, userId: owner.userId } },
      data: { role: "member" },
    });
    try {
      expect(
        (
          await request("spaces/update", {
            spaceId: owner.spaceId,
            allowBotCollaboration: true,
            expectedCollaborationRevision: 1,
          })
        ).status,
      ).toBe(403);
      expect(await currentPolicy()).toMatchObject({ canManageCollaboration: false });
    } finally {
      await handles.prisma.spaceMember.update({
        where: { spaceId_userId: { spaceId: owner.spaceId, userId: owner.userId } },
        data: { role: "owner" },
      });
    }
  });
  it("returns conflict for stale revisions and rejects malformed revisions", async () => {
    expect(
      (
        await request("spaces/update", {
          spaceId: owner.spaceId,
          allowBotCollaboration: true,
          expectedCollaborationRevision: 0,
        })
      ).status,
    ).toBe(409);
    for (const revision of [-1, 0.5, "1"]) {
      expect(
        (
          await request("spaces/update", {
            spaceId: owner.spaceId,
            allowBotCollaboration: true,
            expectedCollaborationRevision: revision,
          })
        ).status,
      ).toBe(400);
    }
    expect(await currentPolicy()).toMatchObject({
      allowBotCollaboration: false,
      collaborationRevision: 1,
    });
  });
  it("returns a non-enumerating error for a Space outside membership", async () => {
    expect(
      (
        await request("spaces/update", {
          spaceId: randomUUID(),
          allowBotCollaboration: true,
          expectedCollaborationRevision: 0,
        })
      ).status,
    ).toBe(404);
  });
  it("keeps no-op receipts stable and exposes re-enabled policy to members", async () => {
    expect(
      await call<SpaceCollaborationPolicy>("spaces/update", {
        spaceId: owner.spaceId,
        allowBotCollaboration: false,
        expectedCollaborationRevision: 1,
      }),
    ).toMatchObject({ collaborationRevision: 1 });
    await call("spaces/update", {
      spaceId: owner.spaceId,
      allowBotCollaboration: true,
      expectedCollaborationRevision: 1,
    });
    expect(await currentPolicy(memberCookie)).toMatchObject({
      allowBotCollaboration: true,
      collaborationRevision: 2,
      canManageCollaboration: false,
    });
  });

  it.each(["bot", "everyone"] as const)(
    "allows human @%s group messages while automatic collaboration is disabled",
    async (mention) => {
      await closeCollaboration();
      const first = await createQuietBot("Orange");
      const second = await createQuietBot("Blue");
      const group = await call<Group>("groups/create", {
        name: "Human-directed work",
        botIds: [first.id, second.id],
      });
      const sent = await call<{ runId: string; runIds?: string[] }>("threads/send", {
        groupId: group.id,
        text: mention === "everyone" ? "@everyone hello" : "@Blue hello",
        mentions: mention === "bot" ? [{ kind: "bot", id: second.id }] : [],
        clientNonce: randomUUID(),
      });
      const runIds = sent.runIds ?? [sent.runId];
      expect(runIds).toHaveLength(mention === "everyone" ? 2 : 1);
      await expectCompleted(runIds);
      const runs = await handles.prisma.run.findMany({
        where: { id: { in: runIds } },
        select: { botId: true, origin: true, collaborationStatus: true },
      });
      expect(runs.map((run) => run.botId).sort()).toEqual(
        (mention === "everyone" ? [first.id, second.id] : [second.id]).sort(),
      );
      expect(runs.every((run) => run.origin === "human" && run.collaborationStatus === null)).toBe(
        true,
      );
      const snapshot = await call<ThreadSnapshot>("threads/get", { groupId: group.id });
      for (const runId of runIds) {
        expect(
          snapshot.messages.some((message) => message.runId === runId && message.role === "bot"),
        ).toBe(true);
      }
      expect(await currentPolicy()).toMatchObject({ allowBotCollaboration: false });
    },
  );

  it("allows human follow-up through the real worker while automatic collaboration is disabled", async () => {
    await closeCollaboration();
    const bot = await createQuietBot("Human follow-up");
    const text = "Please continue with a greeting.";
    expect(
      await call("threads/followUp", { botId: bot.id, text, clientNonce: randomUUID() }),
    ).toEqual({ ok: true });
    const snapshot = await call<ThreadSnapshot>("threads/get", { botId: bot.id });
    const message = snapshot.messages.find(
      (candidate) =>
        candidate.role === "user" &&
        candidate.blocks.some((block) => block.kind === "text" && block.text === text),
    );
    expect(message).toBeDefined();
    const run = await handles.prisma.run.findFirstOrThrow({
      where: { sourceMessageId: message!.id, botId: bot.id, threadId: snapshot.threadId },
    });
    await expectCompleted([run.id]);
    expect(run).toMatchObject({ trigger: "follow_up", origin: "human", collaborationStatus: null });
    const completed = await call<ThreadSnapshot>("threads/get", { botId: bot.id });
    expect(completed.messages.some((reply) => reply.runId === run.id && reply.role === "bot")).toBe(
      true,
    );
  });

  it("allows a same-Run scripted helper without creating a peer delivery while collaboration is disabled", async () => {
    await closeCollaboration();
    const bot = await createQuietBot("Local helper");
    const botsBefore = await call<Bot[]>("bots/list");
    const runsBefore = await handles.prisma.run.findMany({
      where: { spaceId: owner.spaceId },
      select: { id: true },
    });
    const sent = await call<{ runId: string }>("threads/send", {
      botId: bot.id,
      text: "run a subagent to summarize the notes",
      clientNonce: randomUUID(),
    });
    await expectCompleted([sent.runId]);
    const snapshot = await call<ThreadSnapshot>("threads/get", { botId: bot.id });
    expect(
      snapshot.messages
        .flatMap((message) => message.blocks)
        .some((block) => block.kind === "subagent" && block.status === "completed"),
    ).toBe(true);
    expect((await call<Bot[]>("bots/list")).map((entry) => entry.id).sort()).toEqual(
      botsBefore.map((entry) => entry.id).sort(),
    );
    const addedRuns = await handles.prisma.run.findMany({
      where: { spaceId: owner.spaceId, id: { notIn: runsBefore.map((run) => run.id) } },
      select: { id: true, origin: true, parentRunId: true, collaborationStatus: true },
    });
    expect(addedRuns).toEqual([
      { id: sent.runId, origin: "human", parentRunId: null, collaborationStatus: null },
    ]);
  });
});
