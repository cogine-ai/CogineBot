import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { loadThreadAttention, loadThreadPreviews, previewFromBlocks } from "./thread-listing.js";

const owner = { spaceId: "space-1", userId: "user-1" };
const thread = { id: "thread-1", ...owner };
const bot = { id: "bot-1", ...owner };

function approval(effectId: string, status: "pending" | "answered" = "pending"): MessageBlock {
  return {
    kind: "ask",
    text: "May I write this?",
    status,
    approvalEffectId: effectId,
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
}

function card(id: string, seq: number, runId: string | null, blocks: MessageBlock[]) {
  return { id, seq, runId, threadId: thread.id, botId: bot.id, blocks };
}

function attentionDb(input: {
  messages?: ReturnType<typeof card>[];
  runs?: Array<{ id: string; threadId: string; botId: string; spaceId: string; userId: string }>;
  effects?: Array<{ id: string; runId: string; spaceId: string }>;
  servers?: Array<{
    id: string;
    spaceId: string;
    userId: string;
    allowAllTools?: boolean;
    allowedTools?: unknown;
  }>;
}) {
  const prisma = {
    thread: { findMany: vi.fn(async () => [thread]) },
    run: { findMany: vi.fn(async () => input.runs ?? []) },
    message: { findMany: vi.fn(async (_query: unknown) => input.messages ?? []) },
    externalEffect: { findMany: vi.fn(async () => input.effects ?? []) },
    bot: { findMany: vi.fn(async () => [bot]) },
    mcpServer: { findMany: vi.fn(async () => input.servers ?? []) },
  };
  return { prisma, client: prisma as unknown as PrismaClient };
}

describe("loadThreadAttention", () => {
  it("returns every valid approval and the oldest target, without depending on a recent message page", async () => {
    const runs = ["a", "b", "c"].map((id) => ({
      id: `run-${id}`,
      threadId: thread.id,
      botId: bot.id,
      ...owner,
    }));
    const { prisma, client } = attentionDb({
      runs,
      messages: runs.map((run, index) =>
        card(`approval-${index}`, index, run.id, [approval(`effect-${index}`)]),
      ),
      effects: runs.map((run, index) => ({
        id: `effect-${index}`,
        runId: run.id,
        spaceId: owner.spaceId,
      })),
    });
    const result = await loadThreadAttention(client, [thread.id]);
    expect(result.get(thread.id)).toEqual({
      attentionMessageId: "approval-0",
      answerableApprovalMessageIds: ["approval-0", "approval-1", "approval-2"],
    });
    const query = prisma.message.findMany.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(query).not.toHaveProperty("take");
    expect(query).not.toHaveProperty("skip");
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "waiting_input",
          OR: [{ threadId: thread.id, ...owner, bot: owner }],
        },
      }),
    );
  });

  it("requires a matching waiting Run and intended effect, rather than pending text alone", async () => {
    const run = { id: "run-waiting", threadId: thread.id, botId: bot.id, ...owner };
    const { client } = attentionDb({
      runs: [run],
      messages: [
        card("cancelled", 0, "run-cancelled", [approval("effect-cancelled")]),
        card("answered", 1, run.id, [approval("effect-done", "answered")]),
        card("missing-effect", 2, run.id, [approval("effect-missing")]),
        card("foreign-effect", 3, run.id, [approval("effect-foreign")]),
        card("other-run-effect", 4, run.id, [approval("effect-other-run")]),
        card("valid", 5, run.id, [approval("effect-valid")]),
      ],
      effects: [
        { id: "effect-foreign", runId: run.id, spaceId: "other-space" },
        { id: "effect-other-run", runId: "other-run", spaceId: owner.spaceId },
        { id: "effect-valid", runId: run.id, spaceId: owner.spaceId },
      ],
    });
    expect((await loadThreadAttention(client, [thread.id])).get(thread.id)).toEqual({
      attentionMessageId: "valid",
      answerableApprovalMessageIds: ["valid"],
    });
  });

  it("does not classify ordinary questions, secrets, choices, or a later ask in a mixed card as approval", async () => {
    const run = { id: "run-waiting", threadId: thread.id, botId: bot.id, ...owner };
    const { prisma, client } = attentionDb({
      runs: [run],
      messages: [
        card("question", 0, run.id, [{ kind: "ask", text: "Where?", status: "pending" }]),
        card("secret", 1, run.id, [
          { kind: "ask", text: "Key?", input: "secret", status: "pending" },
        ]),
        card("choice", 2, run.id, [
          { kind: "ask", text: "Which?", actions: [{ id: "a", label: "A" }] },
        ]),
        card("mixed", 3, run.id, [
          { kind: "ask", text: "First ordinary question", status: "pending" },
          approval("effect-later"),
        ]),
      ],
    });
    expect((await loadThreadAttention(client, [thread.id])).get(thread.id)).toEqual({
      attentionMessageId: null,
      answerableApprovalMessageIds: [],
    });
    expect(prisma.externalEffect.findMany).not.toHaveBeenCalled();
  });

  it("uses current owned enabled MCP requests independently of Run activity and the shared server policy", async () => {
    const mcp = (serverId: string): MessageBlock => ({
      kind: "mcp_approval",
      serverId,
      name: "Example",
      status: "pending",
      transport: "stdio",
      endpoint: null,
      needsOAuth: false,
    });
    const { prisma, client } = attentionDb({
      messages: [
        card("assigned", 0, "run-completed", [mcp("server-assigned")]),
        card("disabled", 1, "run-completed", [mcp("server-disabled")]),
        card("foreign", 2, "run-completed", [mcp("server-foreign")]),
        card("request", 3, "run-completed", [mcp("server-open")]),
        card("dismissed", 4, null, [
          { ...mcp("server-open"), status: "dismissed" } as MessageBlock,
        ]),
      ],
      servers: [
        { id: "server-assigned", ...owner, allowAllTools: true },
        { id: "server-foreign", ...owner, userId: "other-user" },
        { id: "server-open", ...owner },
      ],
    });
    expect((await loadThreadAttention(client, [thread.id])).get(thread.id)).toEqual({
      attentionMessageId: "request",
      answerableApprovalMessageIds: [],
    });
    expect(prisma.mcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ enabled: true }) }),
    );
  });

  it("does not carry approval state across thread or actor ownership", async () => {
    const { client } = attentionDb({
      runs: [
        { id: "run-foreign", threadId: thread.id, botId: bot.id, ...owner, userId: "other-user" },
        { id: "run-other-thread", threadId: "thread-other", botId: bot.id, ...owner },
        { id: "run-valid", threadId: thread.id, botId: "other-bot", ...owner },
      ],
      messages: [
        card("foreign", 0, "run-foreign", [approval("effect-1")]),
        card("other-thread", 1, "run-other-thread", [approval("effect-2")]),
        card("other-bot", 2, "run-valid", [approval("effect-3")]),
      ],
    });
    expect((await loadThreadAttention(client, [thread.id])).get(thread.id)).toEqual({
      attentionMessageId: null,
      answerableApprovalMessageIds: [],
    });
  });

  it("keeps a new pending MCP request actionable when an earlier request was dismissed", async () => {
    const mcp: MessageBlock = {
      kind: "mcp_approval",
      serverId: "server-open",
      name: "Example",
      status: "pending",
      transport: "stdio",
      endpoint: null,
      needsOAuth: false,
    };
    const { client } = attentionDb({
      messages: [
        card("earlier-dismissal", 1, null, [{ ...mcp, status: "dismissed" }]),
        card("new-request", 2, null, [mcp]),
      ],
      servers: [{ id: "server-open", ...owner }],
    });
    expect((await loadThreadAttention(client, [thread.id])).get(thread.id)).toEqual({
      attentionMessageId: "new-request",
      answerableApprovalMessageIds: [],
    });
  });

  it("uses explicit-answer Run/thread/effect validity without inferring it from the speaker field", async () => {
    const run = { id: "run-waiting", threadId: thread.id, botId: bot.id, ...owner };
    const { client } = attentionDb({
      runs: [run],
      messages: [
        {
          ...card("approval-current", 1, run.id, [approval("effect-current")]),
          botId: "other-speaker",
        },
      ],
      effects: [{ id: "effect-current", runId: run.id, spaceId: owner.spaceId }],
    });
    expect(
      (await loadThreadAttention(client, [thread.id])).get(thread.id)?.answerableApprovalMessageIds,
    ).toEqual(["approval-current"]);
  });

  it("does not query anything for an empty owned thread list", async () => {
    const { prisma, client } = attentionDb({});
    expect(await loadThreadAttention(client, [])).toEqual(new Map());
    expect(prisma.thread.findMany).not.toHaveBeenCalled();
  });
});

describe("previewFromBlocks", () => {
  it("preserves literal URL paths in autolinks", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Open <https://example.test/_draft_>" }])).toBe(
      "Open https://example.test/_draft_",
    );
  });
  it("preserves filenames while removing surrounding Markdown", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Saved **monthly_sales_report.csv**" }])).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("returns the first text block with Markdown stripped", () => {
    expect(
      previewFromBlocks([
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "Created **Projects-CoS** as a **Project**" },
      ]),
    ).toBe("Created Projects-CoS as a Project");
  });

  it("returns empty when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "steps", steps: [] }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
  });

  it("keeps operational text and peer bodies out of the conversation preview", () => {
    expect(
      previewFromBlocks([
        { kind: "progress", text: "Using browser" },
        { kind: "bot_message_received", text: "Internal reply" },
        { kind: "text", text: "Let's meet by the lake." },
      ]),
    ).toBe("Let's meet by the lake.");
  });

  it("shows a real filename for an attachment-only message", () => {
    expect(previewFromBlocks([{ kind: "file", name: "weekend-plan.pdf" }])).toBe(
      "weekend-plan.pdf",
    );
    expect(previewFromBlocks([{ kind: "image", name: "lake.png" }])).toBe("lake.png");
  });
});

describe("shared sidebar previews", () => {
  it("keeps the latest peer dialogue while skipping background ticket narration", async () => {
    const prisma = {
      run: {
        findMany: vi.fn(async () => [
          { id: "ticket-run", trigger: "tickets" },
          { id: "peer-run", trigger: "bot_message" },
        ]),
      },
    } as unknown as PrismaClient;
    const previews = await loadThreadPreviews(prisma, [
      {
        id: "thread-1",
        messages: [
          {
            seq: 3,
            runId: "ticket-run",
            blocks: [{ kind: "text", text: "Internal ticket narration" }],
          },
          {
            seq: 2,
            runId: "peer-run",
            blocks: [{ kind: "text", text: "I'll meet you by the lake." }],
          },
          { seq: 1, runId: "user-run", blocks: [{ kind: "text", text: "Earlier dialogue" }] },
        ],
      },
    ]);
    expect(previews.get("thread-1")).toBe("I'll meet you by the lake.");
  });
});
