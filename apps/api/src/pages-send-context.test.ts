import type { Actor, MessageBlock } from "@rakazo/contracts";
import { appContract, MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { blocksToAgentHistoryText, PAGE_REPLY_TASK_CONTEXT } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const title = "Report https://title.example/private [draft]";
const prefix = "[Report https://title.example/private \\[draft\\]](page:page-a)";

function fixture(
  options: {
    missing?: boolean;
    active?: boolean;
    waiting?: boolean;
    group?: boolean;
    trigger?: string;
    choices?: boolean;
  } = {},
) {
  const run = {
    id: "run-a",
    taskId: "task-a",
    botId: "bot-a",
    status: "queued",
    trigger: options.trigger ?? "user",
  };
  const ask = {
    id: "ask-a",
    role: "bot",
    blocks: [
      {
        kind: "ask",
        text: "Which report?",
        status: "pending",
        ...(options.choices
          ? {
              actions: [
                { id: "choice-a", label: "A" },
                { id: "choice-b", label: "B" },
              ],
            }
          : {}),
      },
    ],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "group-a" }]),
    page: {
      findFirst: vi.fn().mockResolvedValue(options.missing ? null : { id: "page-a", title }),
    },
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1, nextEventSeq: 1 }) },
    message: {
      create: vi
        .fn()
        .mockImplementation(async ({ data }) => ({ id: "message-a", seq: 0, ...data })),
      update: vi.fn().mockResolvedValue({ id: "message-a" }),
      findMany: vi.fn().mockResolvedValue([ask]),
      findFirst: vi.fn().mockResolvedValue(ask),
    },
    artifact: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "image-a", name: "Image", mimeType: "image/png", size: 1, storageKey: "image-a" },
        ]),
    },
    task: {
      create: vi.fn().mockResolvedValue({ id: "task-a" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    run: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(
          options.waiting
            ? [{ ...run, status: "waiting_input" }]
            : options.active
              ? [{ ...run, status: "running" }]
              : [],
        )
        .mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(run),
      findFirst: vi.fn().mockResolvedValue({ botId: "bot-a", userId: actor.userId }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue(run),
    },
    steeringMessage: { create: vi.fn() },
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        id: "group-a",
        members: [{ bot: { id: "bot-a", name: "Alpha" } }, { bot: { id: "bot-b", name: "Beta" } }],
      }),
      update: vi.fn(),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 0, createdAt: new Date() }) },
  };
  const external = {
    message: { findUnique: vi.fn().mockResolvedValue(null) },
    event: { findFirst: vi.fn().mockResolvedValue({ seq: 0, payload: { runIds: [run.id] } }) },
    run: { findMany: vi.fn().mockResolvedValue([{ ...run, status: "completed" }]) },
    $transaction: vi.fn().mockImplementation(async (work) => work(tx)),
  };
  const deps = {
    prisma: external as unknown as PrismaClient,
    events: { notify: vi.fn() } as unknown as ThreadEvents,
    jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
    beforeSend: vi.fn(),
  };
  const target = (
    options.group
      ? {
          kind: "group",
          groupId: "group-a",
          threadId: "thread-a",
          members: [],
          memberBotIds: ["bot-a", "bot-b"],
        }
      : { kind: "bot", botId: "bot-a", threadId: "thread-a" }
  ) as ThreadTarget;
  // Production callers return promises at these two external boundaries.
  deps.events.notify = vi.fn().mockResolvedValue(undefined);
  deps.beforeSend.mockResolvedValue(undefined);
  return { tx, external, deps, target, run };
}

describe("authenticated fallback Page context", () => {
  it.each(
    [false, true].flatMap((group) =>
      [
        { answer: "A", owner: "A", displayed: "A" },
        { answer: "choice-a", owner: "choice-a", displayed: "choice-a" },
        { answer: " \n a \t", owner: "a", displayed: " \n a" },
      ].map((value) => ({ group, ...value })),
    ),
  )(
    "matches a Page answer to a choice while retaining its resume prompt and context (group=$group, answer=$answer)",
    async ({ group, answer, owner, displayed }) => {
      const f = fixture({ waiting: true, group, trigger: "routine", choices: true });
      const resumeLabel = "Open https://choice-owner.example/result";
      f.tx.run.findFirst.mockResolvedValue({
        botId: "bot-a",
        userId: actor.userId,
        checkpoint: JSON.stringify({
          kind: "choice_ask_v1",
          actions: [{ id: "choice-a", label: resumeLabel }],
        }),
      } as never);
      await sendThreadMessage(f.deps, actor, f.target, {
        text: answer,
        pageContext: { pageId: "page-a" },
        clientNonce: "page-choice-nonce",
      });
      expect(f.tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-a" } } },
        data: {
          prompt: `Selected choice choice-a: ${resumeLabel}\n\n${owner}${PAGE_REPLY_TASK_CONTEXT}${prefix}`,
        },
      });
      expect(f.tx.message.update).toHaveBeenCalledWith({
        where: { id: "ask-a" },
        data: {
          blocks: [
            {
              kind: "ask",
              text: "Which report?",
              status: "answered",
              actions: [
                { id: "choice-a", label: "A" },
                { id: "choice-b", label: "B" },
              ],
              answer: "choice-a",
            },
          ],
        },
      });
      expect(f.tx.message.create.mock.calls[0]![0].data.blocks).toEqual([
        {
          kind: "text",
          text: `${prefix}\n${displayed}`,
          pageContext: { pageId: "page-a", title },
        },
      ]);
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.tx.run.create).not.toHaveBeenCalled();
    },
  );

  it("keeps a nonmatching Page answer as free text with its full context", async () => {
    const f = fixture({ waiting: true, choices: true, trigger: "routine" });
    await sendThreadMessage(f.deps, actor, f.target, {
      text: "A different report",
      pageContext: { pageId: "page-a" },
    });
    expect(f.tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-a" } } },
      data: { prompt: `A different report${PAGE_REPLY_TASK_CONTEXT}${prefix}` },
    });
    expect(f.tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-a" },
      data: {
        blocks: [
          {
            kind: "ask",
            text: "Which report?",
            status: "answered",
            actions: [
              { id: "choice-a", label: "A" },
              { id: "choice-b", label: "B" },
            ],
            answer: `${prefix}\nA different report`,
          },
        ],
      },
    });
  });

  it("keeps ordinary choice matching and its exact selected-choice prompt unchanged", async () => {
    const f = fixture({ waiting: true, choices: true });
    await sendThreadMessage(f.deps, actor, f.target, { text: " a " });
    expect(f.tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-a" } } },
      data: { prompt: "Selected choice choice-a: A" },
    });
    expect(f.tx.page.findFirst).not.toHaveBeenCalled();
    expect(f.tx.message.update.mock.calls[0]![0].data.blocks[0].answer).toBe("choice-a");
  });

  it("replays a Page choice's durable nonce without answering or resuming it twice", async () => {
    const f = fixture({ waiting: true, choices: true });
    const input = { text: "A", pageContext: { pageId: "page-a" }, clientNonce: "page-choice" };
    const first = await sendThreadMessage(f.deps, actor, f.target, input);
    f.external.message.findUnique.mockResolvedValue({
      id: "message-a",
      seq: 0,
      sourceRuns: [{ ...f.run, status: "completed" }],
    } as never);
    expect(await sendThreadMessage(f.deps, actor, f.target, input)).toEqual(first);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
    expect(f.tx.task.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.run.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.page.findFirst).toHaveBeenCalledOnce();
    expect(f.deps.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("stores canonical metadata and the composed text in message, event and task", async () => {
    const f = fixture();
    const raw = "Read https://owner.example/report";
    await sendThreadMessage(f.deps, actor, f.target, {
      text: raw,
      pageContext: { pageId: "page-a" },
    });
    expect(f.tx.page.findFirst).toHaveBeenCalledWith({
      where: {
        id: "page-a",
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: "bot-a",
        groupId: null,
      },
      select: { id: true, title: true },
    });
    const block = {
      kind: "text",
      text: `${prefix}\n${raw}`,
      pageContext: { pageId: "page-a", title },
    };
    expect(f.tx.message.create.mock.calls[0]![0].data.blocks).toEqual([block]);
    expect(f.tx.task.create.mock.calls[0]![0].data.prompt).toBe(block.text);
    expect(f.tx.event.create.mock.calls[0]![0].data.payload.blocks).toEqual([block]);
    expect(MessageBlockSchema.parse(JSON.parse(JSON.stringify(block)))).toEqual(block);
  });

  it("does not mutate or enqueue when the Page is outside the validated actor and target", async () => {
    const f = fixture({ missing: true });
    await expect(
      sendThreadMessage(f.deps, actor, f.target, {
        text: "Owner request",
        pageContext: { pageId: "foreign" },
      }),
    ).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a real hand-written Page link and owner URL unmarked and unchanged", async () => {
    const f = fixture();
    const raw = "[My Page](page:page-a)\nRead https://owner.example/report";
    await sendThreadMessage(f.deps, actor, f.target, { text: raw, fromPage: true });
    expect(f.tx.message.create.mock.calls[0]![0].data.blocks).toEqual([
      { kind: "text", text: raw },
    ]);
    expect(f.tx.task.create.mock.calls[0]![0].data.prompt).toBe(raw);
    expect(f.tx.page.findFirst).not.toHaveBeenCalled();
  });

  it("generates a reference text block for an attachment-only fallback", async () => {
    const f = fixture();
    await sendThreadMessage(f.deps, actor, f.target, {
      artifactIds: ["image-a"],
      pageContext: { pageId: "page-a" },
    });
    const blocks = f.tx.message.create.mock.calls[0]![0].data.blocks as MessageBlock[];
    expect(blocks[0]).toEqual({
      kind: "text",
      text: prefix,
      pageContext: { pageId: "page-a", title },
    });
    expect(blocks[1]).toMatchObject({ kind: "image", artifactId: "image-a" });
    expect(f.tx.task.create.mock.calls[0]![0].data.prompt).toBe(prefix);
  });

  it("persists composed context on steering without creating a second task", async () => {
    const f = fixture({ active: true });
    await sendThreadMessage(f.deps, actor, f.target, {
      text: "Continue",
      pageContext: { pageId: "page-a" },
    });
    expect(f.tx.message.create.mock.calls[0]![0].data.blocks).toEqual([
      { kind: "text", text: `${prefix}\nContinue`, pageContext: { pageId: "page-a", title } },
    ]);
    expect(f.tx.steeringMessage.create).toHaveBeenCalledOnce();
    expect(f.tx.task.create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps full Page context outside routine owner instructions (group=%s)",
    async (group) => {
      const f = fixture({ waiting: true, group, trigger: "routine" });
      const raw = "Read https://owner.example/report";
      await sendThreadMessage(f.deps, actor, f.target, {
        text: raw,
        pageContext: { pageId: "page-a" },
      });
      expect(f.tx.task.updateMany).toHaveBeenCalledWith({
        where: { runs: { some: { id: "run-a" } } },
        data: { prompt: `${raw}${PAGE_REPLY_TASK_CONTEXT}${prefix}` },
      });
      expect(f.tx.message.update).toHaveBeenCalledWith({
        where: { id: "ask-a" },
        data: {
          blocks: [
            {
              kind: "ask",
              text: "Which report?",
              status: "answered",
              answer: `${prefix}\n${raw}`,
            },
          ],
        },
      });
      const blocks = f.tx.message.create.mock.calls[0]![0].data.blocks as MessageBlock[];
      expect(blocks).toEqual([
        { kind: "text", text: `${prefix}\n${raw}`, pageContext: { pageId: "page-a", title } },
      ]);
      expect(blocksToAgentHistoryText(blocks)).toBe(`${prefix}\n${raw}`);
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.tx.steeringMessage.create).not.toHaveBeenCalled();
    },
  );

  it("does not trust a generated Page title when an attachment is the entire routine answer", async () => {
    const f = fixture({ waiting: true, trigger: "routine" });
    await sendThreadMessage(f.deps, actor, f.target, {
      artifactIds: ["image-a"],
      pageContext: { pageId: "page-a" },
    });
    expect(f.tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-a" } } },
      data: { prompt: `${PAGE_REPLY_TASK_CONTEXT}${prefix}` },
    });
    const blocks = f.tx.message.create.mock.calls[0]![0].data.blocks as MessageBlock[];
    expect(blocks[0]).toEqual({
      kind: "text",
      text: prefix,
      pageContext: { pageId: "page-a", title },
    });
    expect(blocksToAgentHistoryText(blocks)).toContain(prefix);
    expect(f.tx.message.update).toHaveBeenCalledWith({
      where: { id: "ask-a" },
      data: {
        blocks: [{ kind: "ask", text: "Which report?", status: "answered", answer: prefix }],
      },
    });
  });

  it("preserves a hand-written Page link as owner instructions in a routine answer", async () => {
    const f = fixture({ waiting: true, trigger: "routine" });
    const raw = "[https://owner.example/report](page:manual)\nRead this.";
    await sendThreadMessage(f.deps, actor, f.target, { text: raw, fromPage: true });
    expect(f.tx.task.updateMany).toHaveBeenCalledWith({
      where: { runs: { some: { id: "run-a" } } },
      data: { prompt: raw },
    });
    expect(f.tx.page.findFirst).not.toHaveBeenCalled();
  });

  it("keeps attachment ownership checks when a valid Page is supplied", async () => {
    const f = fixture();
    f.tx.artifact.findMany.mockResolvedValue([]);
    await expect(
      sendThreadMessage(f.deps, actor, f.target, {
        artifactIds: ["foreign-image"],
        pageContext: { pageId: "page-a" },
      }),
    ).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("resolves group routing from the raw owner body rather than the automatic title", async () => {
    const f = fixture({ group: true });
    f.tx.page.findFirst.mockResolvedValue({ id: "page-a", title: "@Beta report" });
    await sendThreadMessage(f.deps, actor, f.target, {
      text: "For Alpha",
      pageContext: { pageId: "page-a" },
    });
    expect(f.tx.page.findFirst).toHaveBeenCalledWith({
      where: {
        id: "page-a",
        userId: actor.userId,
        spaceId: actor.spaceId,
        groupId: "group-a",
      },
      select: { id: true, title: true },
    });
    expect(f.tx.run.create.mock.calls[0]![0].data.botId).toBe("bot-a");
    expect(f.tx.task.create.mock.calls[0]![0].data.prompt).toBe(
      "[@Beta report](page:page-a)\nFor Alpha",
    );
  });

  it("returns a durable nonce receipt before validating a now-missing Page", async () => {
    const f = fixture({ missing: true });
    f.external.message.findUnique.mockResolvedValue({
      id: "old-message",
      seq: 2,
      sourceRuns: [{ ...f.run, status: "completed" }],
    } as never);
    await expect(
      sendThreadMessage(f.deps, actor, f.target, {
        text: "Changed payload",
        clientNonce: "nonce-old",
        pageContext: { pageId: "gone" },
      }),
    ).resolves.toMatchObject({ runId: f.run.id, seq: 2 });
    expect(f.external.$transaction).not.toHaveBeenCalled();
    expect(f.deps.beforeSend).not.toHaveBeenCalled();
    expect(f.tx.page.findFirst).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied titles and ambiguous parent plus fallback context", () => {
    const input = appContract.threads.send["~orpc"].inputSchema!;
    expect(
      input.safeParse({
        botId: "bot-a",
        text: "Read",
        pageContext: { pageId: "page-a", title: "Forged" },
      }).success,
    ).toBe(false);
    expect(
      input.safeParse({
        botId: "bot-a",
        text: "Read",
        replyToMessageId: "message",
        pageContext: { pageId: "page-a" },
      }).success,
    ).toBe(false);
    expect(
      input.safeParse({
        botId: "bot-a",
        text: "Read",
        fromPage: true,
        pageContext: { pageId: "page-a" },
      }).success,
    ).toBe(true);
  });
});
