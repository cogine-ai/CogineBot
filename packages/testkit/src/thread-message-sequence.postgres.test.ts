import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { Actor, ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { appendEvent, createGroupRepos, createRepos, createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("message sequence metadata through the authenticated thread API", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let actor: Actor;
  let cookie: string;
  let dataDir: string | undefined;

  const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: input }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: T }).json;
  };

  const firstEvent = async (
    target: { botId?: string; groupId?: string },
    cursor: number,
  ): Promise<ProductEvent> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await handles.app.request("/rpc/threads/subscribe", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ json: { ...target, cursor } }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("The thread stream ended before the message event");
        buffer += decoder.decode(value, { stream: true });
        const frame = buffer.match(/event: message\n(data: .*)\n\n/);
        if (frame?.[1]) return (JSON.parse(frame[1].slice(6)) as { json: ProductEvent }).json;
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.js");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-message-sequence-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
    });
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `message-sequence-${Date.now()}@example.test`,
        password: "synthetic-password12",
        name: "Sequence fixture",
      }),
    });
    expect(signup.status).toBe(200);
    cookie = sessionCookieHeader(signup);
    actor = await rpc<Actor>("me", {});
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(["bot", "group"])(
    "keeps the created %s message sequence independent from earlier progress events",
    async (kind) => {
      const bot = await createRepos(handles.prisma).createBot(actor, {
        name: "Sequence bot",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const peer =
        kind === "group"
          ? await createRepos(handles.prisma).createBot(actor, {
              name: "Group peer",
              title: "",
              description: "",
              instructions: "",
              notifyOnFinish: false,
            })
          : undefined;
      const group = peer
        ? await createGroupRepos(handles.prisma).createGroup(actor, {
            name: "Sequence group",
            botIds: [bot.id, peer.id],
          })
        : undefined;
      const target = group ? { groupId: group.id } : { botId: bot.id };
      const thread = await handles.prisma.thread.findUniqueOrThrow({
        where: group ? { id: group.threadId } : { botId: bot.id },
      });
      const parent = await createThreadMessage(handles.prisma, {
        threadId: thread.id,
        botId: bot.id,
        role: "bot",
        blocks: [{ kind: "text", text: "A message to react to" }],
      });
      for (let index = 0; index < 5; index++) {
        await appendEvent(handles.prisma, {
          spaceId: actor.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "thread.progress",
          payload: { blocks: [{ kind: "text", text: "Working" }] },
        });
      }
      await rpc("threads/react", {
        ...target,
        messageId: parent.id,
        reaction: "👍",
        clientNonce: "sequence-reaction",
      });
      const event = await firstEvent(target, 4);
      const snapshot = await rpc<ThreadSnapshot>("threads/get", target);
      expect(event).toMatchObject({
        seq: 5,
        type: "thread.message.created",
        payload: { messageSeq: 1 },
      });
      expect(snapshot.messages.find((message) => message.id === event.payload.messageId)?.seq).toBe(
        1,
      );
      expect(await handles.prisma.run.count()).toBe(0);
    },
  );

  it("keeps an updated card at its original message sequence", async () => {
    const bot = await createRepos(handles.prisma).createBot(actor, {
      name: "Card sequence bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await rpc("onboarding/promptFocus", { botId: bot.id });
    const before = await rpc<ThreadSnapshot>("threads/get", { botId: bot.id });
    expect(before.messages).toHaveLength(1);
    const card = before.messages[0]!;
    expect(card.seq).toBe(0);
    for (let index = 0; index < 5; index++) {
      await appendEvent(handles.prisma, {
        spaceId: actor.spaceId,
        threadId: before.threadId,
        botId: bot.id,
        type: "thread.progress",
        payload: { blocks: [{ kind: "text", text: "Working" }] },
      });
    }
    await rpc("onboarding/dismissFocus", { botId: bot.id });
    const event = await firstEvent({ botId: bot.id }, 5);
    expect(event).toMatchObject({
      seq: 6,
      type: "thread.message.updated",
      payload: { messageId: card.id, messageSeq: 0 },
    });
    const after = await rpc<ThreadSnapshot>("threads/get", { botId: bot.id });
    expect(after.messages.find((message) => message.id === card.id)?.seq).toBe(0);
    expect(await handles.prisma.run.count()).toBe(0);
  });
});
