import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { Actor, Bot, Group, Space } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePostgres = hasDb ? describe.sequential : describe.skip;

describePostgres("retrying group creation through the real API", () => {
  let handles: AppHandles;
  let cookie: string;
  let actor: Actor;
  let bots: Bot[];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let dataDir: string | undefined;

  async function raw(procedure: string, input: unknown, session = cookie, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session,
        origin: "http://127.0.0.1:5173",
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }

  async function rpc<T>(
    procedure: string,
    input: unknown = {},
    session = cookie,
    spaceId?: string,
  ) {
    const response = await raw(procedure, input, session, spaceId);
    const result = (await response.json()) as { json?: T };
    if (!response.ok) throw new Error(`${procedure} failed (${response.status})`);
    return result.json as T;
  }

  async function signup(label: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `group-${label}-${stamp}@rakazo.test`,
        password: "password12",
        name: "Group test user",
      }),
    });
    if (!response.ok) throw new Error(`Signup failed (${response.status})`);
    return sessionCookieHeader(response);
  }

  async function createBot(name: string, session = cookie, spaceId?: string) {
    const bot = await rpc<Bot>("bots/create", { name }, session, spaceId);
    return discardBotIntroFromCreate(handles, session, "bots/create", bot);
  }

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-group-creation-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
      signupsEnabled: "true",
    });
    cookie = await signup("owner");
    actor = await rpc<Actor>("me");
    bots = [];
    for (const name of ["Orange", "Blue", "Violet"]) bots.push(await createBot(name));
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("replays simultaneous create requests as one group and one thread", async () => {
    const input = {
      name: "Weekend",
      botIds: [bots[0]!.id, bots[1]!.id],
      clientNonce: `concurrent-${stamp}`,
    };
    const groups = await Promise.all(
      Array.from({ length: 5 }, () => rpc<Group>("groups/create", input)),
    );
    expect(new Set(groups.map((group) => group.id)).size).toBe(1);
    expect(new Set(groups.map((group) => group.threadId)).size).toBe(1);
    expect(groups[0]!.members.map((member) => member.botId)).toEqual(input.botIds);
    await expect(
      handles.prisma.chatGroup.count({ where: { clientNonce: input.clientNonce } }),
    ).resolves.toBe(1);
    await expect(handles.prisma.thread.count({ where: { groupId: groups[0]!.id } })).resolves.toBe(
      1,
    );
  });

  it("preserves chosen member order across reloads and member replacement", async () => {
    const initialOrder = [bots[2]!.id, bots[0]!.id, bots[1]!.id];
    const created = await rpc<Group>("groups/create", {
      name: "Ordered companions",
      botIds: initialOrder,
      clientNonce: `ordered-${stamp}`,
    });
    expect(created.members.map((member) => member.botId)).toEqual(initialOrder);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await rpc<Group>("groups/get", { groupId: created.id });
      expect(fresh.members.map((member) => member.botId)).toEqual(initialOrder);
    }
    const replacementOrder = [bots[1]!.id, bots[2]!.id];
    const updated = await rpc<Group>("groups/update", {
      groupId: created.id,
      botIds: replacementOrder,
    });
    expect(updated.members.map((member) => member.botId)).toEqual(replacementOrder);
    await rpc("groups/update", { groupId: created.id, name: "Renamed companions" });
    const reloaded = await rpc<Group>("groups/get", { groupId: created.id });
    expect(reloaded.members.map((member) => member.botId)).toEqual(replacementOrder);
  });

  it("keeps the creation signature after renaming or replacing members", async () => {
    const input = {
      name: "Original name",
      botIds: [bots[0]!.id, bots[1]!.id],
      clientNonce: `immutable-${stamp}`,
    };
    const group = await rpc<Group>("groups/create", input);
    await rpc("groups/update", {
      groupId: group.id,
      name: "Renamed group",
      botIds: [bots[0]!.id, bots[2]!.id],
    });
    const replay = await rpc<Group>("groups/create", input);
    expect(replay.id).toBe(group.id);
    expect(replay.name).toBe("Renamed group");
    expect(replay.members.map((member) => member.botId)).toEqual([bots[0]!.id, bots[2]!.id]);
    for (const changed of [
      { ...input, name: "Changed creation name" },
      { ...input, botIds: [bots[1]!.id, bots[0]!.id] },
      { ...input, botIds: [bots[0]!.id, bots[2]!.id] },
    ]) {
      expect((await raw("groups/create", changed)).status).toBe(409);
    }
    await expect(
      handles.prisma.chatGroup.count({ where: { clientNonce: input.clientNonce } }),
    ).resolves.toBe(1);
  });

  it("keeps intentional legacy creations separate and does not revive archived groups", async () => {
    const input = { name: "Same companions", botIds: [bots[0]!.id, bots[1]!.id] };
    const first = await rpc<Group>("groups/create", input);
    const second = await rpc<Group>("groups/create", input);
    expect(second.id).not.toBe(first.id);
    const retryInput = { ...input, clientNonce: `archived-${stamp}` };
    const archived = await rpc<Group>("groups/create", retryInput);
    await rpc("groups/archive", { groupId: archived.id });
    expect((await raw("groups/create", retryInput)).status).toBe(409);
    await expect(
      handles.prisma.chatGroup.count({ where: { clientNonce: retryInput.clientNonce } }),
    ).resolves.toBe(1);
  });

  it("replays the original creation after a removed member is archived", async () => {
    const original = await createBot("Original companion");
    const input = {
      name: "Changing companions",
      botIds: [bots[0]!.id, original.id],
      clientNonce: `removed-member-${stamp}`,
    };
    const group = await rpc<Group>("groups/create", input);
    await rpc("groups/update", { groupId: group.id, botIds: [bots[0]!.id, bots[2]!.id] });
    await rpc("bots/archive", { botId: original.id });
    const replay = await rpc<Group>("groups/create", input);
    expect(replay.id).toBe(group.id);
    expect(replay.members.map((member) => member.botId)).toEqual([bots[0]!.id, bots[2]!.id]);
    await expect(
      handles.prisma.chatGroup.count({ where: { clientNonce: input.clientNonce } }),
    ).resolves.toBe(1);
  });

  it("scopes creation nonces by user and Space and rejects foreign recipients", async () => {
    const clientNonce = `scope-${stamp}`;
    const originalInput = { name: "Private", botIds: [bots[0]!.id, bots[1]!.id], clientNonce };
    const original = await rpc<Group>("groups/create", originalInput);
    const otherCookie = await signup("other");
    expect((await raw("groups/create", originalInput, otherCookie)).status).toBeGreaterThanOrEqual(
      400,
    );
    const otherBots = [
      await createBot("Other one", otherCookie),
      await createBot("Other two", otherCookie),
    ];
    const other = await rpc<Group>(
      "groups/create",
      { name: "Private", botIds: otherBots.map((bot) => bot.id), clientNonce },
      otherCookie,
    );
    expect(other.id).not.toBe(original.id);

    const space = await rpc<Space>("spaces/create", { name: "Another Space" });
    expect(
      (await raw("groups/create", originalInput, cookie, space.id)).status,
    ).toBeGreaterThanOrEqual(400);
    const spaceBots = [
      await createBot("Space one", cookie, space.id),
      await createBot("Space two", cookie, space.id),
    ];
    const scoped = await rpc<Group>(
      "groups/create",
      { name: "Private", botIds: spaceBots.map((bot) => bot.id), clientNonce },
      cookie,
      space.id,
    );
    expect(scoped.id).not.toBe(original.id);
    expect(scoped.spaceId).toBe(space.id);
    await expect(
      handles.prisma.chatGroup.count({ where: { userId: actor.userId, clientNonce } }),
    ).resolves.toBe(2);
  });

  it("replays the first send after the create response is retried", async () => {
    const input = {
      name: "First message",
      botIds: [bots[0]!.id, bots[1]!.id],
      clientNonce: `first-create-${stamp}`,
    };
    const group = await rpc<Group>("groups/create", input);
    const send = {
      groupId: group.id,
      text: "Let's pick a place for Saturday.",
      clientNonce: `first-message-${stamp}`,
    };
    const first = await rpc<{ runId: string; runIds?: string[] }>("threads/send", send);
    const recovered = await rpc<Group>("groups/create", input);
    expect(recovered.id).toBe(group.id);
    const replay = await rpc<{ runId: string; runIds?: string[] }>("threads/send", {
      ...send,
      groupId: recovered.id,
    });
    expect(replay.runId).toBe(first.runId);
    expect(replay.runIds).toEqual(first.runIds);
    await expect(
      handles.prisma.message.count({
        where: { threadId: group.threadId, clientNonce: send.clientNonce },
      }),
    ).resolves.toBe(1);
  });

  it("keeps tied membership timestamps stable across physical order changes and default sends", async () => {
    const group = await rpc<Group>("groups/create", {
      name: "Stable companions",
      botIds: bots.map((bot) => bot.id),
    });
    const createdAt = new Date("2030-01-02T03:04:05.000Z");
    // Controlled IDs make the intended tie-break explicit. Their order does
    // not describe business join order or depend on CUID generation details.
    const membership = [
      { id: `member-c-${stamp}`, botId: bots[0]!.id, groupId: group.id, createdAt },
      { id: `member-a-${stamp}`, botId: bots[1]!.id, groupId: group.id, createdAt },
      { id: `member-b-${stamp}`, botId: bots[2]!.id, groupId: group.id, createdAt },
    ];
    const expectedBotIds = [bots[1]!.id, bots[2]!.id, bots[0]!.id];
    const physicalOrders = [
      [membership[0]!, membership[2]!, membership[1]!],
      [membership[2]!, membership[0]!, membership[1]!],
      [membership[1]!, membership[0]!, membership[2]!],
    ];

    for (const [index, physicalOrder] of physicalOrders.entries()) {
      await handles.prisma.$transaction(async (tx) => {
        await tx.chatGroupMember.deleteMany({ where: { groupId: group.id } });
        await tx.chatGroupMember.createMany({ data: physicalOrder });
      });
      const stored = await handles.prisma.chatGroupMember.findMany({
        where: { groupId: group.id },
        select: { createdAt: true },
      });
      expect(stored).toHaveLength(3);
      expect(stored.map((member) => member.createdAt.toISOString())).toEqual(
        Array.from({ length: 3 }, () => createdAt.toISOString()),
      );
      const physical = await handles.prisma.$queryRaw<Array<{ botId: string }>>`
        SELECT "botId" FROM chat_group_members
        WHERE "groupId" = ${group.id}
        ORDER BY ctid
      `;
      expect(physical.map((member) => member.botId)).toEqual(
        physicalOrder.map((member) => member.botId),
      );
      expect(physical.map((member) => member.botId)).not.toEqual(expectedBotIds);

      const listed = (await rpc<Group[]>("groups/list")).find((item) => item.id === group.id);
      const detail = await rpc<Group>("groups/get", { groupId: group.id });
      const snapshot = await rpc<{ members: Group["members"] }>("threads/get", {
        groupId: group.id,
      });
      expect.soft(listed?.members.map((member) => member.botId)).toEqual(expectedBotIds);
      expect.soft(detail.members.map((member) => member.botId)).toEqual(expectedBotIds);
      expect.soft(snapshot.members.map((member) => member.botId)).toEqual(expectedBotIds);
      const confirmed = await rpc<Group>("groups/update", {
        groupId: group.id,
        name: `Ordered companions ${index + 1}`,
        expectedBotIds,
      });
      expect(confirmed.members.map((member) => member.botId)).toEqual(expectedBotIds);

      try {
        const receipt = await rpc<{ runId: string; runIds?: string[] }>("threads/send", {
          groupId: group.id,
          text: `A small thought ${index + 1}.`,
          clientNonce: `ordered-default-${stamp}-${index}`,
        });
        const runIds = receipt.runIds ?? [receipt.runId];
        expect(runIds).toHaveLength(1);
        const runs = await handles.prisma.run.findMany({
          where: { id: { in: runIds } },
          select: { botId: true },
        });
        expect.soft(runs.map((run) => run.botId)).toEqual([expectedBotIds[0]]);
      } finally {
        await rpc("threads/stop", { groupId: group.id });
      }
    }

    const explicitlyMentionedBot = bots[0]!;
    expect(explicitlyMentionedBot.id).not.toBe(expectedBotIds[0]);
    try {
      const receipt = await rpc<{ runId: string; runIds?: string[] }>("threads/send", {
        groupId: group.id,
        text: `@${explicitlyMentionedBot.name} A thought for you.`,
        mentions: [{ kind: "bot", id: explicitlyMentionedBot.id }],
        clientNonce: `ordered-mention-${stamp}`,
      });
      const runIds = receipt.runIds ?? [receipt.runId];
      expect(runIds).toHaveLength(1);
      const runs = await handles.prisma.run.findMany({
        where: { id: { in: runIds } },
        select: { botId: true },
      });
      expect(runs.map((run) => run.botId)).toEqual([explicitlyMentionedBot.id]);
    } finally {
      await rpc("threads/stop", { groupId: group.id });
    }
  });
  it("creates ten members in order and rejects an eleventh without changing the group", async () => {
    const members: Bot[] = [];
    for (let index = 1; index <= 11; index += 1) members.push(await createBot(`Member ${index}`));
    const botIds = members.slice(0, 10).map((bot) => bot.id);
    const created = await rpc<Group>("groups/create", { name: "Ten members", botIds });
    expect(created.members.map((member) => member.botId)).toEqual(botIds);
    expect(
      (await rpc<Group>("groups/get", { groupId: created.id })).members.map(
        (member) => member.botId,
      ),
    ).toEqual(botIds);
    expect(
      (
        await raw("groups/update", {
          groupId: created.id,
          botIds: members.map((bot) => bot.id),
          expectedBotIds: botIds,
        })
      ).status,
    ).toBe(400);
    expect(
      (await rpc<Group>("groups/get", { groupId: created.id })).members.map(
        (member) => member.botId,
      ),
    ).toEqual(botIds);
    expect(
      (await raw("groups/create", { name: "Too many", botIds: members.map((bot) => bot.id) }))
        .status,
    ).toBe(400);
  });

  it("serializes competing confirmed roster replacements and keeps the winner's order", async () => {
    const created = await rpc<Group>("groups/create", {
      name: "Concurrent editors",
      botIds: [bots[0]!.id, bots[1]!.id],
    });
    const expectedBotIds = created.members.map((member) => member.botId);
    const inputs = [
      {
        groupId: created.id,
        name: "First editor",
        botIds: [bots[2]!.id, bots[0]!.id],
        expectedBotIds,
      },
      {
        groupId: created.id,
        name: "Second editor",
        botIds: [bots[1]!.id, bots[2]!.id],
        expectedBotIds,
      },
    ];
    const responses = await Promise.all(inputs.map((input) => raw("groups/update", input)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((response) => response.status === 200);
    const current = await rpc<Group>("groups/get", { groupId: created.id });
    expect(current.name).toBe(inputs[winner]!.name);
    expect(current.members.map((member) => member.botId)).toEqual(inputs[winner]!.botIds);
    expect((await raw("groups/update", inputs[1 - winner]!)).status).toBe(409);
    const unchanged = await rpc<Group>("groups/get", { groupId: created.id });
    expect(unchanged.name).toBe(current.name);
    expect(unchanged.members).toEqual(current.members);
    const renamed = await rpc<Group>("groups/update", {
      groupId: created.id,
      name: "Legacy rename",
    });
    expect(renamed.members).toEqual(current.members);
    expect(renamed.name).toBe("Legacy rename");
  });

  it("rejects an old ordered roster after a peer changes the default recipient", async () => {
    const replacement = await createBot("Replacement companion");
    const originalOrder = bots.map((bot) => bot.id);
    const winnerOrder = [bots[1]!.id, bots[2]!.id, bots[0]!.id];
    const created = await rpc<Group>("groups/create", {
      name: "Original companions",
      botIds: originalOrder,
    });
    const winner = await rpc<Group>("groups/update", {
      groupId: created.id,
      name: "Winner companions",
      pinned: true,
      botIds: winnerOrder,
      expectedBotIds: originalOrder,
    });
    expect(winner.members.map((member) => member.botId)).toEqual(winnerOrder);

    const task = await handles.prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bots[2]!.id,
        threadId: created.threadId,
        prompt: "Synthetic pending group work",
        status: "waiting_input",
      },
    });
    const pending = await handles.prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bots[2]!.id,
        threadId: created.threadId,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const before = await handles.prisma.chatGroup.findUniqueOrThrow({
      where: { id: created.id },
    });
    const beforeEventCount = await handles.prisma.event.count({
      where: { threadId: created.threadId },
    });
    try {
      const stale = await raw("groups/update", {
        groupId: created.id,
        name: "Stale companions",
        pinned: false,
        botIds: [bots[0]!.id, bots[1]!.id, replacement.id],
        expectedBotIds: originalOrder,
      });
      expect.soft(stale.status).toBe(409);
      const unchanged = await rpc<Group>("groups/get", { groupId: created.id });
      expect.soft(unchanged).toMatchObject({ name: winner.name, pinned: true });
      expect.soft(unchanged.members.map((member) => member.botId)).toEqual(winnerOrder);
      expect
        .soft(await handles.prisma.chatGroup.findUniqueOrThrow({ where: { id: created.id } }))
        .toEqual(before);
      expect
        .soft(await handles.prisma.run.findUniqueOrThrow({ where: { id: pending.id } }))
        .toEqual(pending);
      expect
        .soft(await handles.prisma.task.findUniqueOrThrow({ where: { id: task.id } }))
        .toEqual(task);
      expect
        .soft(await handles.prisma.event.count({ where: { threadId: created.threadId } }))
        .toBe(beforeEventCount);
    } finally {
      await rpc("threads/stop", { groupId: created.id });
    }

    try {
      const receipt = await rpc<{ runId: string; runIds?: string[] }>("threads/send", {
        groupId: created.id,
        text: "A thought for the first companion.",
        clientNonce: `ordered-cas-default-${stamp}`,
      });
      const runs = await handles.prisma.run.findMany({
        where: { id: { in: receipt.runIds ?? [receipt.runId] } },
        select: { botId: true },
      });
      expect(runs.map((run) => run.botId)).toEqual([winnerOrder[0]]);
    } finally {
      await rpc("threads/stop", { groupId: created.id });
    }

    const fresh = await rpc<Group>("groups/update", {
      groupId: created.id,
      botIds: [replacement.id, bots[1]!.id],
      expectedBotIds: winnerOrder,
    });
    expect(fresh.members.map((member) => member.botId)).toEqual([replacement.id, bots[1]!.id]);
    const legacy = await rpc<Group>("groups/update", {
      groupId: created.id,
      botIds: [bots[1]!.id, replacement.id],
    });
    expect(legacy.members.map((member) => member.botId)).toEqual([bots[1]!.id, replacement.id]);
  });

  it("compares only active members and never admits a foreign editor through CAS", async () => {
    const localBots: Bot[] = [];
    for (const name of ["Active one", "Archived member", "Active two", "Replacement"])
      localBots.push(await createBot(name));
    const created = await rpc<Group>("groups/create", {
      name: "Archived roster",
      botIds: localBots.slice(0, 3).map((bot) => bot.id),
    });
    await rpc("bots/archive", { botId: localBots[1]!.id });
    const active = (await rpc<Group>("groups/get", { groupId: created.id })).members.map(
      (member) => member.botId,
    );
    expect(active).toEqual([localBots[0]!.id, localBots[2]!.id]);
    const input = {
      groupId: created.id,
      botIds: [localBots[3]!.id, localBots[2]!.id],
      expectedBotIds: active,
    };
    expect(
      (await raw("groups/update", { ...input, expectedBotIds: [...active].reverse() })).status,
    ).toBe(409);
    const otherCookie = await signup("foreign-editor");
    expect((await raw("groups/update", input, otherCookie)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await rpc<Group>("groups/get", { groupId: created.id })).members.map(
        (member) => member.botId,
      ),
    ).toEqual(active);
    const updated = await rpc<Group>("groups/update", input);
    expect(updated.members.map((member) => member.botId)).toEqual(input.botIds);
    expect(
      (
        await raw("groups/update", {
          ...input,
          expectedBotIds: localBots.slice(0, 3).map((bot) => bot.id),
        })
      ).status,
    ).toBe(409);
  });
});
