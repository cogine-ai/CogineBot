import { readFileSync } from "node:fs";
import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  applyThreadClearReceipt,
  applyThreadRunCancellations,
  hasNewThreadWork,
  isApprovalAskBlock,
  isRunTerminalEvent,
  observeMemoryCleanup,
  ReplyAnnouncements,
  runThreadSubscription,
  searchHitThreadTarget,
  shouldResetHistoryAfterClear,
  threadClearCancelledRunIds,
  userVisibleMessages,
  withLiveStreamingProgress,
} from "@rakazo/core";
import { transformWithOxc } from "vite";
import { describe, expect, it, vi } from "vitest";
import { publishComputerCommand } from "./computer-workspace";
import {
  activeThreadRuns,
  applyThreadSendReceipt,
  clearActiveThreadRuns,
  computerPanelNeedsMaintenance,
  computerPanelNeedsScreen,
  computerTakeoverBlocked,
  isComputerStatusEvent,
  isThreadSnapshotEvent,
  mergeThreadSnapshot,
  prependThreadMessagePage,
  protectThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
  threadRunError,
  userHoldsComputerControl,
} from "./thread-events.js";

describe("thread event reduction", () => {
  it("keeps sender narration and tool steps across an in-group handoff until its Run ends", () => {
    const sender = {
      ...message("progress:run-1", [
        { kind: "text", text: "Before handoff." },
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "progress", text: "Preparing " },
      ]),
      runId: "run-1",
    };
    const other = { ...message("progress:other", []), runId: "other" };
    const handoff = event({
      type: "group.handoff",
      runId: "run-1",
      threadId: "thread-1",
      seq: 4,
      payload: {
        messageId: "handoff-file",
        messageSeq: 1,
        role: "bot",
        blocks: [
          { kind: "handoff", fromBotId: "bot-1", toBotId: "bot-2", text: "Review" },
          {
            kind: "file",
            artifactId: "material",
            name: "report.txt",
            mimeType: "text/plain",
            size: 32,
          },
        ],
      },
    });
    const shown = reduceThreadSnapshot(snapshot([sender, other]), handoff)!;
    expect(shown.messages.find((item) => item.id === sender.id)).toMatchObject(sender);
    expect(shown.messages.find((item) => item.id === other.id)).toMatchObject(other);
    expect(shown.messages.filter((item) => item.id === "handoff-file")).toHaveLength(1);
    expect(reduceThreadSnapshot(shown, handoff)).toBe(shown);
    const continued = reduceThreadSnapshot(
      shown,
      event({ type: "thread.progress", runId: "run-1", seq: 5, payload: { delta: "files." } }),
    )!;
    expect(continued.messages.find((item) => item.id === sender.id)?.blocks).toEqual([
      ...sender.blocks.slice(0, -1),
      { kind: "progress", text: "Preparing files." },
    ]);
    const called = reduceThreadSnapshot(
      continued,
      event({ type: "agent.tool.called", runId: "run-1", seq: 6, payload: { name: "write_file" } }),
    )!;
    expect(called.messages.find((item) => item.id === sender.id)?.blocks).toEqual([
      ...sender.blocks.slice(0, -1),
      { kind: "text", text: "Preparing files." },
      { kind: "steps", steps: [{ label: "Write file", count: 1 }] },
    ]);
    const completed = reduceThreadSnapshot(
      called,
      event({ type: "run.completed", runId: "run-1", seq: 7, payload: {} }),
    )!;
    expect(completed.messages.some((item) => item.id === sender.id)).toBe(false);
    expect(completed.messages.find((item) => item.id === other.id)).toMatchObject(other);
    expect(completed.messages.filter((item) => item.id === "handoff-file")).toHaveLength(1);
  });

  it("shows a group handoff attachment immediately and does not duplicate or revive its replay", () => {
    const handoff = event({
      type: "group.handoff",
      runId: undefined,
      payload: {
        messageId: "handoff-file",
        messageSeq: 1,
        role: "bot",
        blocks: [
          { kind: "handoff", fromBotId: "bot-1", toBotId: "bot-2", text: "Review" },
          {
            kind: "file",
            artifactId: "material",
            name: "report.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 32,
          },
        ],
      },
    });
    expect(isThreadSnapshotEvent(handoff)).toBe(true);
    const shown = reduceThreadSnapshot(
      snapshot([
        message("progress:legacy", []),
        { ...message("progress:other", []), runId: "other" },
      ]),
      handoff,
    )!;
    expect(shown.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "handoff-file", seq: 1, blocks: handoff.payload.blocks }),
        expect.objectContaining({ id: "progress:other", runId: "other" }),
      ]),
    );
    expect(shown.messages).toHaveLength(2);
    expect(reduceThreadSnapshot(shown, handoff)).toBe(shown);
    const cleared = reduceThreadSnapshot(shown, event({ type: "thread.cleared", seq: 5 }));
    expect(reduceThreadSnapshot(cleared, handoff)?.messages).toEqual([]);
  });

  it("updates delivery without replacing message text or reviving a cleared message", () => {
    const reply = {
      ...message("saved", [{ kind: "text", text: "Saved reply" }], 1),
      role: "bot" as const,
    };
    const before = { ...snapshot([reply]), cursor: 1 };
    const receipt = event({
      seq: 2,
      type: "thread.message.delivery",
      payload: { messageId: "saved", delivery: { state: "delivered" } },
    });
    const delivered = reduceThreadSnapshot(before, receipt);
    expect(delivered?.messages).toMatchObject([
      { id: "saved", blocks: reply.blocks, messagingDelivery: { state: "delivered" } },
    ]);
    const blocks = [{ kind: "text", text: "Edited reply" }];
    const updated = reduceThreadSnapshot(
      delivered,
      event({
        seq: 3,
        type: "thread.message.updated",
        payload: { messageId: "saved", messageSeq: 1, role: "bot", blocks },
      }),
    );
    expect(updated?.messages).toMatchObject([
      { id: "saved", blocks, messagingDelivery: { state: "delivered" } },
    ]);
    const cleared = reduceThreadSnapshot(
      before,
      event({ seq: 3, type: "thread.cleared", payload: {} }),
    );
    expect(reduceThreadSnapshot(cleared, receipt)?.messages).toEqual([]);
  });

  it("does not substitute an event position for missing durable message metadata", () => {
    const initial = snapshot([message("existing", [{ kind: "text", text: "Earlier" }], 0)]);
    const malformed = event({
      seq: 80,
      type: "thread.message.created",
      payload: { messageId: "invalid", role: "bot", blocks: [{ kind: "text", text: "Invalid" }] },
    });
    delete malformed.payload.messageSeq;

    expect(reduceThreadSnapshot(initial, malformed)).toBe(initial);
  });

  it("keeps replayed messages across a later refresh when event positions differ from message order", () => {
    let current = snapshot([
      message("old-0", [{ kind: "text", text: "Earlier" }], 0),
      message("old-1", [{ kind: "text", text: "Still reading" }], 1),
      message("new-3", [{ kind: "text", text: "New reply" }], 3),
      message("new-4", [{ kind: "text", text: "New reply" }], 4),
    ]);
    for (const [messageSeq, eventSeq] of [
      [2, 22],
      [3, 23],
      [4, 24],
    ]) {
      current = reduceThreadSnapshot(
        current,
        event({
          type: "thread.message.created",
          seq: eventSeq,
          payload: {
            messageId: `new-${messageSeq}`,
            messageSeq,
            role: "bot",
            blocks: [{ kind: "text", text: "New reply" }],
          },
        }),
      )!;
    }
    expect(current.messages.map((item) => item.id)).toEqual([
      "old-0",
      "old-1",
      "new-2",
      "new-3",
      "new-4",
    ]);
    const fresh = {
      ...snapshot(
        [
          message("new-3", [{ kind: "text", text: "New reply" }], 3),
          message("new-4", [{ kind: "text", text: "New reply" }], 4),
        ],
        3,
      ),
      cursor: 24,
    };

    const refreshed = mergeThreadSnapshot(current, fresh, true);

    expect(refreshed.messages.map((item) => item.id)).toEqual([
      "old-0",
      "old-1",
      "new-2",
      "new-3",
      "new-4",
    ]);
    expect(refreshed.messages.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(refreshed.cursor).toBe(24);
    expect(refreshed.olderCursor).toBeNull();
  });

  it("keeps an updated historical card in its message position after a refresh", () => {
    const initial = snapshot([
      message("card", [{ kind: "text", text: "Waiting" }], 0),
      message("recent", [{ kind: "text", text: "Later" }], 1),
    ]);
    const updated = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 80,
        payload: {
          messageId: "card",
          messageSeq: 0,
          role: "bot",
          blocks: [{ kind: "text", text: "Answered" }],
        },
      }),
    );
    const refreshed = mergeThreadSnapshot(
      updated,
      {
        ...snapshot([message("recent", [{ kind: "text", text: "Later" }], 1)], 1),
        cursor: 80,
      },
      true,
    );

    expect(refreshed.messages.map((item) => item.id)).toEqual(["card", "recent"]);
    expect(refreshed.messages[0]).toMatchObject({
      seq: 0,
      blocks: [{ kind: "text", text: "Answered" }],
    });
    expect(refreshed.cursor).toBe(80);
  });

  it("shows a committed direct send as queued before its snapshot refresh returns", () => {
    const initial = snapshot([message("user-1", [{ kind: "text", text: "Continue" }], 4)]);

    const next = applyThreadSendReceipt(initial, {
      botId: "bot-1",
      runId: "run-receipt",
      taskId: "task-receipt",
      createdAt: "2026-09-03T21:29:52.000Z",
    });

    expect(next?.run).toMatchObject({
      id: "run-receipt",
      taskId: "task-receipt",
      status: "queued",
    });
    expect(next?.activeRuns).toEqual([next?.run]);
    expect(next?.messages).toBe(initial.messages);
  });

  it.each([undefined, 19, 20, 21])(
    "orders a late send receipt by event cursor (%s)",
    (eventSeq) => {
      const initial = {
        ...snapshot([]),
        cursor: 30,
        olderCursor: 1,
        observedClearSeq: 20,
      };
      const next = applyThreadSendReceipt(initial, {
        botId: "bot-1",
        runId: "receipt-run",
        taskId: "receipt-task",
        eventSeq,
      });
      expect(next?.run?.id ?? null).toBe(
        eventSeq !== undefined && eventSeq > 20 ? "receipt-run" : null,
      );
      expect(next?.cursor).toBe(30);
      if (eventSeq === undefined || eventSeq <= 20) expect(next).toBe(initial);
    },
  );

  it("keeps the newest receipt when multiple sends arrive without advancing the cursor", () => {
    const initial = { ...snapshot([]), cursor: 15, olderCursor: 1 };
    const newer = applyThreadSendReceipt(initial, {
      botId: "bot-1",
      runId: "newer-receipt",
      taskId: "newer-task",
      eventSeq: 33,
    });
    expect(
      applyThreadSendReceipt(newer, {
        botId: "bot-1",
        runId: "older-receipt",
        taskId: "older-task",
        eventSeq: 31,
      }),
    ).toBe(newer);
    expect(newer?.cursor).toBe(15);
  });

  it("does not replace authoritative active or group run state with a send receipt", () => {
    const active = threadRun("run-active");
    const direct: ThreadSnapshot = { ...snapshot([]), run: active, activeRuns: [active] };
    const group: ThreadSnapshot = { ...snapshot([]), groupId: "group-1" };
    const receipt = { botId: "bot-1", runId: "run-new", taskId: "task-new" };
    const completed = { ...threadRun(receipt.runId), status: "completed" as const };

    expect(applyThreadSendReceipt(direct, receipt)).toBe(direct);
    expect(applyThreadSendReceipt(group, receipt)).toBe(group);
    expect(applyThreadSendReceipt({ ...snapshot([]), run: completed }, receipt)?.run).toBe(
      completed,
    );
    expect(applyThreadSendReceipt(snapshot([]), receipt, new Set([receipt.runId]))).toEqual(
      snapshot([]),
    );
  });

  it("appends an emoji reply with its exact target", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "reaction-1",
          role: "user",
          blocks: [{ kind: "text", text: "❤️" }],
          replyToMessageId: "message-1",
        },
      }),
    );

    expect(next?.messages.find((message) => message.id === "reaction-1")).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "❤️" }],
      replyToMessageId: "message-1",
    });
    expect(next?.cursor).toBe(4);
  });

  it("appends a quoted reply carrying its excerpt", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        createdAt: "2026-10-08T12:00:00.000Z",
        payload: {
          messageId: "reply-1",
          role: "user",
          blocks: [{ kind: "text", text: "why this?" }],
          replyToMessageId: "message-1",
          replyQuote: "Done",
          replyPreview: { role: "user", text: "Done" },
        },
      }),
    );

    expect(next?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      role: "user",
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });

    const updated = reduceThreadSnapshot(
      next,
      event({
        type: "thread.message.updated",
        seq: 5,
        payload: {
          messageId: "reply-1",
          role: "user",
          blocks: [{ kind: "text", text: "Updated" }],
        },
      }),
    );
    expect(updated?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });
  });

  it("prepends older pages in order, removes overlaps, and advances the history cursor", () => {
    const initial = snapshot([message("m-2", [], 2), message("m-3", [], 3)], 2);

    const next = prependThreadMessagePage(initial, {
      threadId: "thread-1",
      messages: [message("m-0", [], 0), message("m-1", [], 1), message("m-2", [], 2)],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("ignores a stale older page after the conversation was cleared", () => {
    const cleared = snapshot([], null);
    const next = prependThreadMessagePage(cleared, {
      threadId: "thread-1",
      messages: [message("old-1", [], 0), message("old-2", [], 1)],
      olderCursor: null,
    });
    expect(next).toBe(cleared);
  });

  it("merges a refreshed recent page with loaded history and drops stale live messages", () => {
    const previous = snapshot(
      [
        message("m-0", [], 0),
        message("m-1", [], 1),
        message("progress:run-1", [{ kind: "progress", text: "draft" }], 9),
      ],
      null,
    );
    const recent = snapshot([message("m-1", [], 1), message("m-2", [], 2)], 1);

    const next = mergeThreadSnapshot(previous, recent, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("ignores a stale thread refresh that is behind the live cursor", () => {
    const live: ThreadSnapshot = {
      ...snapshot([
        message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }], 11),
      ]),
      cursor: 12,
    };
    const stale: ThreadSnapshot = {
      ...snapshot([message("m-1", [{ kind: "text", text: "older" }], 1)]),
      cursor: 8,
    };

    expect(mergeThreadSnapshot(live, stale)).toBe(live);
    expect(mergeThreadSnapshot(live, stale, true)).toBe(live);
  });

  it("accumulates progress deltas and keeps only the active progress message", () => {
    const stale = message("progress:older", [{ kind: "progress", text: "old run" }]);
    const initial = snapshot([stale]);

    const first = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", seq: 4, runId: "run-1", payload: { delta: "Hel" } }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({ type: "thread.progress", seq: 5, runId: "run-1", payload: { delta: "lo" } }),
    );

    expect(second?.cursor).toBe(5);
    expect(second?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      }),
    ]);
  });

  it("keeps hidden token progress so re-enabling streaming stays continuous", () => {
    const initial = snapshot([]);
    const afterTokens = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Lis", streaming: true },
      }),
    );
    const afterDelta = reduceThreadSnapshot(
      afterTokens,
      event({
        type: "thread.progress",
        seq: 5,
        runId: "run-1",
        payload: { delta: "bon", streaming: true },
      }),
    );

    expect(afterDelta?.cursor).toBe(5);
    expect(afterDelta?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      }),
    ]);
    expect(withLiveStreamingProgress(afterDelta, false)?.messages).toEqual([]);

    const afterActivity = reduceThreadSnapshot(
      afterDelta,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { text: "Using browser", activity: true },
      }),
    );
    expect(withLiveStreamingProgress(afterActivity, false)?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Using browser", activity: true }],
      }),
    ]);

    const afterComplete = reduceThreadSnapshot(
      afterActivity,
      event({
        type: "thread.message.created",
        seq: 7,
        runId: "run-1",
        payload: {
          messageId: "m-final",
          role: "bot",
          blocks: [{ kind: "text", text: "Lisbon" }],
        },
      }),
    );
    expect(afterComplete?.messages).toEqual([
      expect.objectContaining({
        id: "m-final",
        blocks: [{ kind: "text", text: "Lisbon" }],
      }),
    ]);
  });

  it("resumes from retained tokens after streaming is turned back on mid-reply", () => {
    const afterPrefix = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Lis", streaming: true },
      }),
    );
    const hidden = withLiveStreamingProgress(afterPrefix, false);
    expect(hidden?.messages).toEqual([]);

    const afterResume = reduceThreadSnapshot(
      afterPrefix,
      event({
        type: "thread.progress",
        seq: 5,
        runId: "run-1",
        payload: { delta: "bon", streaming: true },
      }),
    );
    expect(withLiveStreamingProgress(afterResume, true)?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      }),
    ]);
  });

  it("updates a live subagent in place while preserving streamed answer progress", () => {
    const activeRun = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        message("subagent:research", [
          {
            kind: "subagent",
            agentId: "research",
            name: "Research",
            task: "Find sources",
            status: "running",
            progress: "Starting",
          },
        ]),
        {
          ...message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
          runId: activeRun.id,
        },
      ]),
      run: activeRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        seq: 8,
        payload: {
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "completed",
          result: "Three sources found",
        },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["subagent:research", "progress:run-1"]);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      status: "completed",
      result: "Three sources found",
    });
  });

  it("replaces transient progress and a matching live subagent with the durable message", () => {
    const initial = snapshot([
      message("durable", [{ kind: "text", text: "old value" }]),
      message("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "running",
        },
      ]),
      message("subagent:other", [
        {
          kind: "subagent",
          agentId: "other",
          name: "Other",
          task: "Keep working",
          status: "running",
        },
      ]),
      message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
    ]);
    const completedBlock = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Find sources",
      status: "completed" as const,
      result: "Done",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        id: "event-message",
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "durable", role: "bot", blocks: [completedBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["durable", "subagent:other"]);
    expect(next?.messages[0]?.blocks).toEqual([completedBlock]);
  });

  it("keeps a replayed bot-to-bot marker in its durable transcript position", () => {
    const peerBlock = {
      kind: "bot_message_received" as const,
      fromBotId: "bot-peer",
      fromBotName: "Peer",
      text: "Please check this.",
    };
    const initial = snapshot([
      message("peer-message", [peerBlock], 1),
      message("newer-message", [{ kind: "text", text: "Working on it." }], 2),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "peer-message", role: "user", blocks: [peerBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["peer-message", "newer-message"]);
  });

  it("clears durable and transient history when another client clears the thread", () => {
    const initial = snapshot(
      [
        message("message-1", [{ kind: "text", text: "old" }]),
        message("progress:run-1", [{ kind: "progress", text: "draft" }]),
      ],
      1,
    );
    initial.run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.cleared", seq: 12, runId: undefined }),
    );

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("leaves transcript state unchanged for a Bot profile metadata update", () => {
    const initial = snapshot([message("existing", [{ kind: "text", text: "Earlier" }], 0)]);
    const metadata = event({
      type: "bot.updated",
      seq: 12,
      runId: undefined,
      payload: { botId: "bot-1", name: "Chief", title: "", description: "" },
    });
    expect(isThreadSnapshotEvent(metadata)).toBe(false);
    expect(reduceThreadSnapshot(initial, metadata)).toBe(initial);
  });

  it("routes clear and terminal events through the snapshot reducer", () => {
    expect(
      isThreadSnapshotEvent(event({ type: "thread.cleared", seq: 12, runId: undefined })),
    ).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.started" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.completed" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "computer.takeover.requested" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "agent.tool.completed" }))).toBe(true);
  });

  it("event-sources the active run on run.started so Stop does not wait on threads.get", () => {
    const initial = { ...snapshot([]), cursor: 2 };
    const started = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 3,
        runId: "run-1",
        payload: { trigger: "user" },
      }),
    );

    expect(started?.run).toMatchObject({
      id: "run-1",
      botId: "bot-1",
      status: "running",
      trigger: "user",
    });
    expect(started?.activeRuns).toEqual([started?.run]);

    const progressed = reduceThreadSnapshot(
      started,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { delta: "still working" },
      }),
    );
    expect(progressed?.run?.id).toBe("run-1");
    expect(progressed?.cursor).toBe(4);
  });

  it("keeps background ticket runs out of the transcript while advancing the cursor", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        seq: 7,
        runId: "ticket-run-1",
        payload: { trigger: "tickets" },
      }),
    );

    expect(started?.run).toBeNull();
    expect(started?.activeRuns ?? []).toEqual([]);
    expect(started?.cursor).toBe(7);
  });

  it("preserves bot_message when event-sourcing a peer run", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "peer-run-1",
        payload: { trigger: "bot_message" },
      }),
    );

    expect(started?.run?.trigger).toBe("bot_message");
  });

  it("preserves webhook when event-sourcing an inbound wake", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "webhook-run-1",
        payload: { trigger: "webhook" },
      }),
    );

    expect(started?.run?.trigger).toBe("webhook");
  });

  it("preserves call_end when event-sourcing the wrap-up run", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "call-end-run-1",
        payload: { trigger: "call_end" },
      }),
    );

    expect(started?.run?.trigger).toBe("call_end");
  });

  it("marks the run as waiting when computer takeover is requested", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "computer.takeover.requested", seq: 5, runId: run.id }),
    );

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
  });

  it("inserts a peer takeover run that was absent from the open snapshot", () => {
    const userRun = threadRun("run-user");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: userRun,
      activeRuns: [userRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({
        type: "computer.takeover.requested",
        seq: 12,
        runId: "run-peer",
        botId: "bot-peer",
      }),
    );

    expect(waiting?.run).toMatchObject({
      id: "run-peer",
      botId: "bot-peer",
      status: "waiting_takeover",
      trigger: "bot_message",
    });
    expect(waiting?.activeRuns?.map((run) => ({ id: run.id, status: run.status }))).toEqual([
      { id: "run-user", status: "running" },
      { id: "run-peer", status: "waiting_takeover" },
    ]);
  });

  it("keeps event-sourced waiting_takeover when a stale refresh still shows the bot busy", () => {
    const run = threadRun("run-1");
    const waitingLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run: { ...run, status: "waiting_takeover" },
      activeRuns: [{ ...run, status: "waiting_takeover" }],
    };
    const staleRefresh: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      waitingLocal,
      staleRefresh,
      computer({ state: "running", busyBotName: null }),
    );

    expect(reconciled.snapshot.run?.status).toBe("waiting_takeover");
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(computerTakeoverBlocked(reconciled.computer, reconciled.snapshot.run?.status)).toBe(
      false,
    );
  });

  it("ignores a refresh whose cursor is behind the event-sourced snapshot", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 12,
      run: { ...run, status: "waiting_takeover" },
    };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ busyBotName: "Chief" }),
    };
    const prevComputer = computer({ busyBotName: null });

    const reconciled = reconcileRefreshedThread(newer, older, prevComputer);

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer).toBe(prevComputer);
  });

  it("refreshes busy status when only transient thread events are ahead", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = { ...snapshot([]), cursor: 12, run };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      newer,
      older,
      computer({ state: "running", controlHolder: "bot", busyBotName: null }),
    );

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("hydrates a live run from a refresh without rolling back newer progress", () => {
    const run = threadRun("run-1");
    const liveProgress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const newer: ThreadSnapshot = { ...snapshot([liveProgress]), cursor: 12, run: null };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 11,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(newer, older, computer());

    expect(reconciled.snapshot.cursor).toBe(12);
    expect(reconciled.snapshot.messages).toEqual([liveProgress]);
    expect(reconciled.snapshot.run).toBe(run);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("clears active runs and their transient progress after stop", () => {
    const run = threadRun("run-1");
    const durable = message("message-1", [{ kind: "text", text: "Keep me" }]);
    const progress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const stopped = clearActiveThreadRuns({
      ...snapshot([durable, progress]),
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    });

    expect(stopped.run).toBeNull();
    expect(stopped.activeRuns).toEqual([]);
    expect(stopped.messages).toEqual([durable]);
    expect(stopped.computer?.busyBotName).toBeNull();
  });

  it("keeps an optimistic stop clear when an older cursor refresh still looks busy", () => {
    // Stop has no terminal event, so progress can leave the local cursor ahead of threads.get.
    // After the shell clears run/busy locally, that older get must not restore Stop / Take control block.
    const run = threadRun("run-1");
    const stoppedLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 15,
      run: null,
      activeRuns: [],
      computer: computer({ state: "running", busyBotName: null }),
    };
    const staleBusyRefresh: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };
    const clearedComputer = computer({ state: "running", busyBotName: null });

    const reconciled = reconcileRefreshedThread(stoppedLocal, staleBusyRefresh, clearedComputer);

    expect(reconciled.snapshot.run).toBeNull();
    expect(reconciled.snapshot.activeRuns).toEqual([]);
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(computerTakeoverBlocked(reconciled.computer, reconciled.snapshot.run?.status)).toBe(
      false,
    );
  });

  it("always replaces the snapshot when switching to a different thread", () => {
    const previous: ThreadSnapshot = {
      ...snapshot([]),
      threadId: "thread-writer",
      cursor: 40,
      computer: computer({ mode: "team", busyBotName: null }),
    };
    const next: ThreadSnapshot = {
      ...snapshot([]),
      botId: "bot-private",
      threadId: "thread-private",
      cursor: 0,
      computer: computer({ mode: "dedicated", state: "running" }),
    };

    const reconciled = reconcileRefreshedThread(previous, next, previous.computer ?? null);

    expect(reconciled.snapshot.threadId).toBe("thread-private");
    expect(reconciled.computer?.mode).toBe("dedicated");
  });

  it("keeps group member status in sync with run lifecycle events", () => {
    const run = threadRun("run-1", "bot-member");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      botId: undefined,
      groupId: "group-1",
      members: [{ botId: "bot-member", name: "Member", color: "#8B5CF6", status: "idle" }],
    };

    const started = reduceThreadSnapshot(
      initial,
      event({ type: "run.started", botId: "bot-member", runId: run.id }),
    );
    expect(started?.members?.[0]?.status).toBe("running");
    expect(started?.run?.id).toBe(run.id);
    expect(started?.run?.status).toBe("running");
    expect(started?.activeRuns?.map((item) => item.id)).toEqual([run.id]);

    const waiting = reduceThreadSnapshot(
      started!,
      event({
        type: "run.waiting_input",
        seq: 5,
        botId: "bot-member",
        runId: run.id,
      }),
    );
    expect(waiting?.members?.[0]?.status).toBe("waiting_input");

    const completed = reduceThreadSnapshot(
      waiting,
      event({ type: "run.completed", seq: 6, botId: "bot-member", runId: run.id }),
    );
    expect(completed?.members?.[0]?.status).toBe("idle");
  });

  it("clears only the terminal run's live progress", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...message("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };
    const failed = event({ type: "run.failed", seq: 10, runId: runA.id });

    const next = reduceThreadSnapshot(initial, failed);

    expect(isThreadSnapshotEvent(failed)).toBe(true);
    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("keeps full cleaned failure details within the byte budget", () => {
    const failing = threadRun("run-a");
    const initial: ThreadSnapshot = { ...snapshot([]), run: failing };
    const diagnostic = `${"x".repeat(8155)} sk-synthetic-only-credential-value-0123456789 ${"more diagnostics ".repeat(30)}`;
    const next = reduceThreadSnapshot(
      initial,
      event({ type: "run.failed", seq: 11, runId: failing.id, payload: { error: diagnostic } }),
    );
    expect(next?.run?.status).toBe("failed");
    const details = next?.run?.error ?? "";
    expect(details.length).toBeGreaterThan(300);
    expect(details).not.toContain("sk-synthetic");
    expect(new TextEncoder().encode(details).length).toBeLessThanOrEqual(8192);
    expect(details.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
  });

  it("keeps a failed run and its error so the thread can surface the failure", () => {
    const failing = threadRun("run-a");
    const initial: ThreadSnapshot = {
      ...snapshot([
        { ...message("progress:run-a", [{ kind: "progress", text: "A" }]), runId: failing.id },
      ]),
      run: failing,
    };
    const failed = event({
      type: "run.failed",
      seq: 11,
      runId: failing.id,
      payload: { error: "Provider is not configured: openrouter" },
    });

    const next = reduceThreadSnapshot(initial, failed);

    expect(next?.messages).toEqual([]);
    expect(next?.run).toMatchObject({
      id: failing.id,
      status: "failed",
      error: "Provider is not configured: openrouter",
    });
    expect(threadRunError(next)).toBe("Provider is not configured: openrouter");
    expect(threadRunError(next, new Set([failing.id]))).toBeNull();
    expect(threadRunError(next, new Set(["other-run"]))).toBe(
      "Provider is not configured: openrouter",
    );
  });

  it("keeps the error when a member run fails while another member is still running", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.failed",
        seq: 13,
        botId: "bot-b",
        runId: runB.id,
        payload: { error: "member exploded" },
      }),
    );

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toMatchObject({ id: runB.id, status: "failed", error: "member exploded" });
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("keeps a group failure visible when another member starts before dismiss", () => {
    const failed = {
      ...threadRun("run-b", "bot-b"),
      status: "failed" as const,
      error: "member exploded",
    };
    const runA = threadRun("run-a", "bot-a");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      groupId: "group-1",
      run: failed,
      activeRuns: [runA],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 14,
        botId: "bot-c",
        runId: "run-c",
      }),
    );

    expect(next?.run).toMatchObject({ id: failed.id, status: "failed", error: "member exploded" });
    expect(next?.activeRuns).toEqual([
      runA,
      expect.objectContaining({ id: "run-c", botId: "bot-c", status: "running" }),
    ]);
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("clears the run and reports no error when it completes or fails without a message", () => {
    const finishing = threadRun("run-a");
    const initial: ThreadSnapshot = { ...snapshot([]), run: finishing };

    const completed = reduceThreadSnapshot(
      initial,
      event({ type: "run.completed", seq: 12, runId: finishing.id }),
    );
    const blank = reduceThreadSnapshot(
      initial,
      event({ type: "run.failed", seq: 12, runId: finishing.id, payload: { error: "  " } }),
    );

    expect(completed?.run).toBeNull();
    expect(threadRunError(completed)).toBeNull();
    expect(blank?.run).toBeNull();
    expect(threadRunError(blank)).toBeNull();
  });

  it("applies the durable waiting-input run transition without a refresh", () => {
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-1",
        status: "running",
        trigger: "user",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-1" }),
    );

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(6);
    expect(
      reduceThreadSnapshot(waiting, event({ type: "run.waiting_input", seq: 7, runId: "run-1" })),
    ).toEqual({ ...waiting, cursor: 7 });
  });

  it("clears live progress when a run waits for input", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-1", [{ kind: "progress", text: "working…" }]),
          runId: run.id,
        },
      ]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: run.id }),
    );

    expect(waiting?.messages).toEqual([]);
    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_input");
  });

  it("refreshes the quota wait deadline and clears it when the same run starts", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        { ...message("progress:run-1", [{ kind: "progress", text: "working…" }]), runId: run.id },
      ]),
      run,
      activeRuns: [run],
    };
    const wait = event({
      type: "run.waiting_limit",
      seq: 6,
      runId: run.id,
      payload: { until: "2026-11-09T09:00:00.000Z" },
    });
    const waiting = reduceThreadSnapshot(initial, wait);
    expect(waiting?.messages).toEqual([]);
    expect(waiting?.run).toMatchObject({
      id: run.id,
      status: "waiting_limit",
      quotaWaitUntil: wait.payload.until,
    });

    const until = "2026-11-09T10:00:00.000Z";
    const updated = reduceThreadSnapshot(waiting, { ...wait, seq: 7, payload: { until } });
    expect(updated?.activeRuns?.[0]?.quotaWaitUntil).toBe(until);
    const deferred = reduceThreadSnapshot(updated, {
      ...wait,
      seq: 8,
      payload: { until, waitingForComputer: true },
    });
    expect(deferred?.run).toMatchObject({
      id: run.id,
      status: "waiting_limit",
      quotaWaitUntil: until,
      quotaWaitForComputer: true,
    });
    expect(deferred?.activeRuns?.[0]?.quotaWaitForComputer).toBe(true);
    const newProviderWait = reduceThreadSnapshot(deferred, { ...wait, seq: 9 });
    expect(newProviderWait?.run?.quotaWaitForComputer).toBeUndefined();

    const resumed = reduceThreadSnapshot(
      deferred,
      event({ type: "run.started", seq: 9, runId: run.id }),
    );
    expect(resumed?.run).toMatchObject({ id: run.id, status: "running" });
    expect(resumed?.run?.quotaWaitUntil).toBeUndefined();
    expect(resumed?.run?.quotaWaitForComputer).toBeUndefined();
    expect(reduceThreadSnapshot(resumed, wait)).toBe(resumed);

    const failed = reduceThreadSnapshot(
      deferred,
      event({ type: "run.failed", seq: 9, runId: run.id, payload: { error: "Model unavailable" } }),
    );
    expect(failed?.run).toMatchObject({ id: run.id, status: "failed", error: "Model unavailable" });
    expect(failed?.run?.quotaWaitUntil).toBeUndefined();
    expect(failed?.run?.quotaWaitForComputer).toBeUndefined();

    const ask = { ...threadRun("run-ask"), status: "waiting_input" as const };
    const whileAsked = reduceThreadSnapshot({ ...initial, run: ask }, wait);
    expect(whileAsked?.run).toBe(ask);
    expect(whileAsked?.activeRuns?.map(({ id }) => id)).toEqual([ask.id, run.id]);
  });

  it("keeps a direct quota wait after a different run starts and fails", () => {
    const quota = {
      ...threadRun("quota"),
      status: "waiting_limit" as const,
      quotaWaitUntil: "2026-11-09T09:00:00.000Z",
    };
    const initial = { ...snapshot([]), run: quota, activeRuns: [quota] };
    const started = reduceThreadSnapshot(
      initial,
      event({ type: "run.started", seq: 6, runId: "routine", payload: { trigger: "routine" } }),
    );
    expect(started?.run?.id).toBe("routine");
    expect(started?.activeRuns).toContainEqual(quota);

    const failed = reduceThreadSnapshot(
      started,
      event({ type: "run.failed", seq: 7, runId: "routine", payload: { error: "Run failed" } }),
    );
    expect(failed?.run).toMatchObject({ id: "routine", status: "failed" });
    expect(failed?.activeRuns).toEqual([quota]);
  });

  it("accumulates tool-call steps and collapses repeats into a count", () => {
    const initial = snapshot([]);

    const first = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.called",
        seq: 4,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );
    const third = reduceThreadSnapshot(
      second,
      event({
        type: "agent.tool.called",
        seq: 6,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );

    expect(third?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Slack find channels", count: 1 },
              { label: "Slack fetch conversation history", count: 2 },
            ],
          },
        ],
      }),
    ]);
  });

  it("advances past tool completion audit events without adding a visible message", () => {
    const initial = snapshot(
      [
        message(
          "progress:run-1",
          [{ kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] }],
          4,
        ),
      ],
      4,
    );
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.completed",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS", outcome: "succeeded" },
      }),
    );

    expect(next?.cursor).toBe(5);
    expect(next?.messages).toEqual(initial.messages);
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );

    // Still mid-sentence — the tool call stays hidden, folded into the streaming text instead.
    expect(afterTool?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack ",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);

    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "for a broad search.", streaming: true },
      }),
    );

    // The sentence just finished — the completed sentence and the held-back tool call appear
    // together, in that order.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Slack for a broad search." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("survives a React StrictMode replay of the same event without double-counting", () => {
    // StrictMode invokes a setState updater twice per event in development to catch impure
    // updaters — reduceThreadSnapshot(prev, event) must return the same result both times
    // rather than mutating its pending-tool-call bookkeeping a second time.
    const initial = snapshot([]);
    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check ", streaming: true },
      }),
    );
    const toolEvent = event({
      type: "agent.tool.called",
      seq: 5,
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });

    // The tool call lands mid-sentence, so it's held back rather than flushed immediately —
    // exactly the state a naive module-level mutation would double-push on replay.
    const first = reduceThreadSnapshot(afterNarration, toolEvent);
    const replay = reduceThreadSnapshot(afterNarration, toolEvent);
    expect(replay).toEqual(first);

    const sentenceEnd = reduceThreadSnapshot(
      first,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Done.", streaming: true },
      }),
    );

    // A single tool call, not two — StrictMode's replay must not have pushed it twice.
    expect(sentenceEnd?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Done." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("keeps deferring a tool call across several sentence-less deltas", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Found it, now sanding", streaming: true },
      }),
    );

    // No sentence terminator has streamed in yet, so the tool call is still hidden and
    // everything so far renders as one continuous progress block.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack Found it, now sanding",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);
  });

  it("restores pending tool calls from a refreshed snapshot", () => {
    const refreshed = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Let me check Slack ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      refreshed,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "now.", streaming: true },
      }),
    );

    expect(next?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("does not leak pending tool calls after clearing a thread", () => {
    const withPending = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Old unfinished narration ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);
    const cleared = reduceThreadSnapshot(
      withPending,
      event({ type: "thread.cleared", seq: 7, runId: undefined }),
    );
    const next = reduceThreadSnapshot(
      cleared,
      event({ type: "thread.progress", seq: 8, runId: "run-1", payload: { text: "Fresh." } }),
    );

    expect(next?.messages[0]?.blocks).toEqual([{ kind: "progress", text: "Fresh." }]);
  });

  it("preserves another active group run while updating live progress", () => {
    const runA = {
      id: "run-a",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const otherLive = {
      ...message("progress:run-b", [{ kind: "progress" as const, text: "Other bot" }]),
      botId: "bot-b",
      runId: "run-b",
    };
    // The snapshot can lag behind the event stream when another group run starts.
    const initial = { ...snapshot([otherLive]), activeRuns: [runA] };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 8,
        runId: "run-a",
        botId: "bot-a",
        payload: { text: "Current bot" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b", "progress:run-a"]);
    expect(next?.messages.map((item) => item.botId)).toEqual(["bot-b", "bot-a"]);
  });

  it("preserves live progress from a legacy run-only snapshot", () => {
    const legacyRun = threadRun("run-legacy", "bot-legacy");
    const legacyLive = {
      ...message("progress:run-legacy", [{ kind: "progress" as const, text: "Still working" }]),
      botId: legacyRun.botId,
      runId: legacyRun.id,
    };
    const initial: ThreadSnapshot = {
      ...snapshot([legacyLive]),
      run: legacyRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", runId: "run-new", payload: { text: "New work" } }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress while applying a subagent update", () => {
    const activeRun = threadRun("run-active");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-active", [{ kind: "progress", text: "Active" }]),
          runId: "run-active",
        },
        {
          ...message("progress:run-concurrent", [{ kind: "progress", text: "Concurrent" }]),
          runId: "run-concurrent",
        },
      ]),
      run: activeRun,
      activeRuns: [activeRun],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        runId: "run-active",
        payload: { agentId: "research", name: "Research", task: "Check", status: "running" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "subagent:research",
      "progress:run-active",
      "progress:run-concurrent",
    ]);
  });

  it("clears the step trail once the durable answer arrives", () => {
    const initial = snapshot([
      message("progress:run-1", [
        { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "final", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["final"]);
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const newerRun = {
      id: "run-newer",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const waitingRun = { ...newerRun, id: "run-waiting", botId: "bot-b", taskId: "task-b" };
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: newerRun,
      activeRuns: [newerRun, waitingRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-waiting" }),
    );

    expect(waiting?.run).toEqual(newerRun);
    expect(waiting?.activeRuns?.find((run) => run.id === "run-waiting")?.status).toBe(
      "waiting_input",
    );
    expect(activeThreadRuns(waiting)).toEqual([
      newerRun,
      expect.objectContaining({ id: "run-waiting", status: "waiting_input" }),
    ]);
    expect(activeThreadRuns({ ...initial, activeRuns: undefined })).toEqual([newerRun]);
  });

  it("replaces an ask message when its durable prompt state changes", () => {
    const initial = snapshot([
      message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }]),
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 7,
        payload: {
          messageId: "ask-1",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "answered",
              answer: "Paris",
            },
          ],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ status: "answered", answer: "Paris" });
  });

  it("titles the call marker in place when the wrap-up run names it", () => {
    const initial = snapshot([
      { ...message("marker-1", [{ kind: "voice_call", title: "", farewell: "" }]), callId: "c-1" },
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 8,
        payload: {
          messageId: "marker-1",
          role: "bot",
          blocks: [{ kind: "voice_call", title: "Flight booked", farewell: "Talk soon" }],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ title: "Flight booked" });
    expect(next?.messages[0]?.callId).toBe("c-1");
  });

  it("preserves botId on durable bot messages", () => {
    const initial = snapshot([]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        botId: "bot-researcher",
        payload: {
          messageId: "msg-1",
          role: "bot",
          blocks: [{ kind: "text", text: "on it." }],
        },
      }),
    );

    expect(next?.messages[0]?.botId).toBe("bot-researcher");
  });
});

describe("computer event reduction", () => {
  it("applies valid lifecycle states without accepting unknown states", () => {
    const initial = computer();
    const running = reduceComputerStatus(
      initial,
      event({ type: "computer.status", payload: { status: "running" } }),
    );
    const unknown = reduceComputerStatus(
      running,
      event({ type: "computer.status", payload: { status: "destroyed" } }),
    );

    expect(running).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toBe(running);
  });

  it("grants user control without overwriting the lifecycle state", () => {
    const granted = reduceComputerStatus(
      computer({ state: "suspended", controlHolder: "bot" }),
      event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
    );
    expect(granted).toMatchObject({
      state: "suspended",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    expect(
      reduceComputerStatus(
        granted,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toBe(granted);
  });

  it("applies the authoritative holder when a takeover is released or expires", () => {
    const initial = computer({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    const expired = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "none", reason: "expired" },
      }),
    );
    const released = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "bot", reason: "released" },
      }),
    );
    expect(expired).toMatchObject({
      state: "running",
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
    });
    expect(released).toMatchObject({
      state: "running",
      controlHolder: "bot",
      controlBotId: null,
      takeoverRequested: false,
    });
  });

  it("fills in controlBotId when a grant arrives after controlHolder is already user", () => {
    const granted = reduceComputerStatus(
      computer({ state: "running", controlHolder: "user", controlBotId: null }),
      event({ type: "computer.takeover.granted", payload: {} }),
    );
    expect(granted).toMatchObject({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
    });
    expect(userHoldsComputerControl(granted, "bot-1")).toBe(true);
    expect(userHoldsComputerControl(granted, "bot-2")).toBe(false);
  });

  it("treats a busy bot name as a blocked takeover", () => {
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "running")).toBe(true);
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }))).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: null }), "running")).toBe(false);
    expect(computerTakeoverBlocked(null, "running")).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "waiting_takeover")).toBe(
      false,
    );
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "completed")).toBe(false);
  });

  it("ignores computer events that belong to a different bot", () => {
    const prev = computer({ takeoverRequested: false, controlHolder: "bot" });
    expect(
      reduceComputerStatus(
        prev,
        event({
          type: "computer.takeover.requested",
          botId: "bot-peer",
          payload: {},
        }),
      ),
    ).toBe(prev);
    expect(
      reduceComputerStatus(
        prev,
        event({
          type: "computer.status",
          botId: "bot-peer",
          payload: { status: "suspended" },
        }),
      ),
    ).toBe(prev);
  });

  it("marks takeover requested and clears control unless the lease was retained", () => {
    const busy = computer({ state: "running", busyBotName: "Writer", controlHolder: "bot" });
    expect(
      reduceComputerStatus(busy, event({ type: "computer.takeover.requested", payload: {} })),
    ).toMatchObject({
      busyBotName: null,
      takeoverRequested: true,
      controlHolder: "none",
      controlBotId: null,
    });
    expect(
      reduceComputerStatus(
        computer({
          state: "running",
          controlHolder: "user",
          controlBotId: "bot-1",
          takeoverRequested: false,
        }),
        event({
          type: "computer.takeover.requested",
          payload: { retainedControl: true },
        }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
      busyBotName: null,
    });
    expect(
      reduceComputerStatus(
        busy,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      busyBotName: null,
      takeoverRequested: true,
    });
  });

  it("only reconnects a running computer whose screen has no URL", () => {
    expect(computerPanelNeedsScreen("running", null)).toBe(true);
    expect(computerPanelNeedsScreen("running", "https://screen.example")).toBe(false);
    expect(computerPanelNeedsScreen("stopped")).toBe(false);
    expect(computerPanelNeedsScreen("error")).toBe(false);
    expect(computerPanelNeedsScreen(undefined)).toBe(false);
    expect(computerPanelNeedsScreen("booting")).toBe(false);
    expect(computerPanelNeedsScreen("suspended")).toBe(false);
  });

  it("shows maintenance only for an errored computer that is not booting", () => {
    expect(computerPanelNeedsMaintenance("error", false)).toBe(true);
    expect(computerPanelNeedsMaintenance("stopped", false)).toBe(false);
    expect(computerPanelNeedsMaintenance("error", true)).toBe(false);
    expect(computerPanelNeedsMaintenance("running", false)).toBe(false);
    expect(computerPanelNeedsMaintenance(undefined, false)).toBe(false);
  });

  it("hides side-panel maintenance while the computer overlay is open", () => {
    const panel = "computer";
    const booting = false;
    const showInSidePanel = (computerOpen: boolean) =>
      panel === "computer" && !computerOpen && computerPanelNeedsMaintenance("error", booting);

    expect(showInSidePanel(false)).toBe(true);
    expect(showInSidePanel(true)).toBe(false);
  });
});

function snapshot(messages: ThreadMessage[], olderCursor: number | null = null): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: computer(),
  };
}

function threadRun(id: string, botId = "bot-1"): NonNullable<ThreadSnapshot["run"]> {
  return {
    id,
    botId,
    threadId: "thread-1",
    taskId: `task-${id}`,
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "booting",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: true,
    terminalAvailable: true,
    ...overrides,
  };
}

function message(id: string, blocks: ThreadMessage["blocks"], seq = 3): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role: "bot",
    blocks,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function event(overrides: Partial<ProductEvent>): ProductEvent {
  const next: ProductEvent = {
    id: "event-1",
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 4,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
  if (next.type === "thread.message.created" || next.type === "thread.message.updated") {
    next.payload = { messageSeq: next.seq, ...next.payload };
  }
  return next;
}

describe("released takeover thread state", () => {
  function waiting() {
    const run = { ...threadRun("run-1"), status: "waiting_takeover" as const };
    const sibling = threadRun("run-2", "bot-2");
    const pending = {
      ...message(
        "takeover",
        [{ kind: "computer" as const, state: "Needs you", text: "Continue" }],
        1,
      ),
      runId: run.id,
    };
    const other = {
      ...message("other", [{ kind: "computer" as const, state: "Needs you", text: "Other" }], 2),
      runId: sibling.id,
    };
    return {
      ...snapshot([pending, other], 1),
      cursor: 10,
      groupId: "group-1",
      run,
      activeRuns: [run, sibling],
      members: [
        { botId: "bot-1", name: "One", color: "slate", status: "waiting_takeover" },
        { botId: "bot-2", name: "Two", color: "slate", status: "running" },
      ],
    } satisfies ThreadSnapshot;
  }

  it("routes the committed release through the thread reducer", () => {
    expect(isThreadSnapshotEvent(event({ type: "computer.takeover.released" }))).toBe(true);
  });

  it.each(["Done", "Skipped"])(
    "keeps the committed %s card while resuming only the matching group Run",
    (state) => {
      const initial = waiting();
      const cardUpdated = reduceThreadSnapshot(
        initial,
        event({
          type: "thread.message.updated",
          seq: 11,
          payload: {
            messageId: "takeover",
            messageSeq: 1,
            role: "bot",
            blocks: [{ kind: "computer", state, text: "Continue" }],
          },
        }),
      )!;
      const released = reduceThreadSnapshot(
        cardUpdated,
        event({
          type: "computer.takeover.released",
          seq: 12,
          payload: { reason: state === "Done" ? "done" : "skipped", holder: "none" },
        }),
      )!;
      expect(released.run?.status).toBe("queued");
      expect(released.activeRuns?.[0]?.status).toBe("queued");
      expect(released.activeRuns?.[1]).toBe(initial.activeRuns[1]);
      expect(released.members?.[0]?.status).toBe("queued");
      expect(released.members?.[1]).toBe(initial.members[1]);
      expect(released.messages[0]).toMatchObject({
        seq: 1,
        runId: "run-1",
        blocks: [{ kind: "computer", state }],
      });
      expect(released.messages[1]?.blocks).toBe(initial.messages[1]?.blocks);
      expect(released.olderCursor).toBe(1);
      expect(released.cursor).toBe(12);
    },
  );

  it("preserves a displayed group failure while another member's waiting Run is released", () => {
    const initial = waiting();
    const failed = {
      ...threadRun("failed", "bot-failed"),
      status: "failed" as const,
      error: "Retained failure",
    };
    const released = reduceThreadSnapshot(
      { ...initial, run: failed },
      event({ type: "computer.takeover.released", seq: 12 }),
    )!;
    expect(released.run).toBe(failed);
    expect(released.activeRuns?.map((run) => run.status)).toEqual(["queued", "running"]);
  });

  it.each(["queued", "leased", "running", "cancelled", "failed", "completed"] as const)(
    "does not revive or rewrite a %s Run on release",
    (status) => {
      const initial = waiting();
      const run = { ...initial.run, status };
      const released = reduceThreadSnapshot(
        { ...initial, run, activeRuns: [run] },
        event({ type: "computer.takeover.released", seq: 12 }),
      )!;
      expect(released.run).toBe(run);
      expect(released.activeRuns?.[0]).toBe(run);
      expect(released.members).toBe(initial.members);
      expect(released.cursor).toBe(12);
    },
  );

  it.each([undefined, "unknown"])("does not invent a released Run for %s", (runId) => {
    const initial = waiting();
    const released = reduceThreadSnapshot(
      initial,
      event({ type: "computer.takeover.released", seq: 12, runId }),
    )!;
    expect(released.run).toBe(initial.run);
    expect(released.activeRuns).toBe(initial.activeRuns);
    expect(released.members).toBe(initial.members);
    expect(released.messages.map((item) => item.blocks)).toEqual(
      initial.messages.map((item) => item.blocks),
    );
    expect(released.cursor).toBe(12);
  });

  it("accepts a newer authoritative release snapshot instead of keeping local waiting", () => {
    const initial = waiting();
    const run = { ...initial.run, status: "queued" as const };
    const next = { ...initial, cursor: 12, run, activeRuns: [run, initial.activeRuns[1]!] };
    const reconciled = reconcileRefreshedThread(initial, next, initial.computer ?? null);
    expect(reconciled.snapshot.run?.status).toBe("queued");
    expect(reconciled.snapshot.activeRuns?.[0]?.status).toBe("queued");
  });

  it("ignores old lifecycle and known card payloads without dropping missing durable history", () => {
    const initial = waiting();
    const queued = { ...initial.run, status: "queued" as const };
    const settled: ThreadSnapshot = {
      ...initial,
      cursor: 12,
      run: queued,
      activeRuns: [queued],
      messages: [
        {
          ...initial.messages[0]!,
          blocks: [{ kind: "computer", state: "Done", text: "Continue" }],
        },
      ],
    };
    for (const stale of [
      event({ type: "computer.takeover.requested", seq: 10 }),
      event({ type: "computer.takeover.released", seq: 11 }),
      event({
        type: "thread.message.updated",
        seq: 10,
        payload: {
          messageId: "takeover",
          messageSeq: 1,
          role: "bot",
          blocks: [{ kind: "computer", state: "Needs you", text: "Continue" }],
        },
      }),
    ])
      expect(reduceThreadSnapshot(settled, stale)).toBe(settled);
    const history = reduceThreadSnapshot(
      settled,
      event({
        type: "thread.message.created",
        seq: 7,
        payload: {
          messageId: "historical",
          messageSeq: 0,
          role: "bot",
          blocks: [{ kind: "text", text: "Earlier" }],
        },
      }),
    )!;
    expect(history.cursor).toBe(12);
    expect(history.run).toBe(queued);
    expect(history.messages.map((item) => item.id)).toEqual(["historical", "takeover"]);
  });

  it("ignores a foreign-thread release even when it names the visible Run", () => {
    const initial = waiting();
    expect(
      reduceThreadSnapshot(
        initial,
        event({ type: "computer.takeover.released", seq: 15, threadId: "other-thread" }),
      ),
    ).toBe(initial);
  });
});

describe("durable card replay version", () => {
  it("updates a newly hydrated historical card without accepting an older payload afterwards", () => {
    const initial = {
      ...snapshot([message("recent", [{ kind: "text", text: "Later" }], 9)], 9),
      cursor: 20,
    };
    const created = event({
      type: "thread.message.created",
      seq: 7,
      payload: {
        messageId: "historical-card",
        messageSeq: 0,
        role: "bot",
        blocks: [{ kind: "computer", state: "Needs you", text: "Continue" }],
      },
    });
    const hydrated = reduceThreadSnapshot(initial, created)!;
    const updated = reduceThreadSnapshot(
      hydrated,
      event({
        ...created,
        type: "thread.message.updated",
        seq: 11,
        payload: {
          ...created.payload,
          blocks: [{ kind: "computer", state: "Done", text: "Continue" }],
        },
      }),
    )!;
    expect(updated.cursor).toBe(20);
    expect(updated.messages[0]).toMatchObject({
      seq: 0,
      blocks: [{ kind: "computer", state: "Done" }],
    });
    expect(reduceThreadSnapshot(updated, created)).toBe(updated);
  });
});

describe("cleared takeover history barrier", () => {
  const oldCard = () =>
    event({
      type: "thread.message.created",
      seq: 7,
      payload: {
        messageId: "old-card",
        messageSeq: 0,
        role: "bot",
        blocks: [{ kind: "computer", state: "Needs you", text: "Old" }],
      },
    });
  it("does not hydrate an old unknown card after clear or an authoritative empty snapshot", () => {
    const cleared = reduceThreadSnapshot(snapshot([]), event({ type: "thread.cleared", seq: 20 }))!;
    expect(reduceThreadSnapshot(cleared, oldCard())).toBe(cleared);
    const empty = { ...snapshot([]), cursor: 30 };
    expect(reduceThreadSnapshot(empty, { ...oldCard(), seq: 24 })).toBe(empty);
  });
  it("retains the clear barrier through later pages while accepting post-clear historical events", () => {
    const cleared = reduceThreadSnapshot(snapshot([]), event({ type: "thread.cleared", seq: 20 }))!;
    const page = { ...snapshot([message("recent", [], 9)], 9), cursor: 30 };
    const current = mergeThreadSnapshot(cleared, page);
    expect(reduceThreadSnapshot(current, oldCard())).toBe(current);
    const hydrated = reduceThreadSnapshot(current, {
      ...oldCard(),
      id: "new-event",
      seq: 24,
      payload: { ...oldCard().payload, messageId: "new-card" },
    })!;
    expect(hydrated.cursor).toBe(30);
    expect(hydrated.messages.map((item) => item.id)).toEqual(["new-card", "recent"]);
  });
});

describe("takeover message snapshot authority", () => {
  const card = (state: string) =>
    message("card", [{ kind: "computer", state, text: "Continue" }], 1);
  const update = (seq: number, state: string) =>
    event({
      type: "thread.message.updated",
      seq,
      payload: { messageId: "card", messageSeq: 1, role: "bot", blocks: card(state).blocks },
    });
  it("keeps the original message version when unrelated progress advances the cursor", () => {
    const base = { ...snapshot([card("Needs you")]), cursor: 10 };
    const progressed = reduceThreadSnapshot(
      base,
      event({ seq: 20, payload: { text: "Working" } }),
    )!;
    const settled = reduceThreadSnapshot(progressed, update(11, "Done"))!;
    expect(settled.messages.find((item) => item.id === "card")?.blocks).toEqual(
      card("Done").blocks,
    );
    expect(settled.cursor).toBe(20);
  });
  it("uses a fresh snapshot's cursor for its messages and retains prior history versions", () => {
    const old = { ...snapshot([card("Needs you")], 1), cursor: 10 };
    const history = mergeThreadSnapshot(
      old,
      { ...snapshot([message("recent", [], 9)], 9), cursor: 30 },
      true,
    );
    expect(
      reduceThreadSnapshot(history, update(11, "Done"))?.messages.find((item) => item.id === "card")
        ?.blocks,
    ).toEqual(card("Done").blocks);
    const fresh = mergeThreadSnapshot(history, { ...snapshot([card("Done")]), cursor: 30 });
    expect(reduceThreadSnapshot(fresh, update(25, "Needs you"))).toBe(fresh);
  });
  it("protects an observed card from a page started earlier and accepts a page started later", () => {
    const base = { ...snapshot([card("Needs you")], 1), cursor: 10 };
    const current = reduceThreadSnapshot(base, update(11, "Done"))!;
    const page = {
      threadId: "thread-1",
      messages: [message("older", [], 0), card("Skipped")],
      olderCursor: null,
    };
    const delayed = prependThreadMessagePage(current, page, 10)!;
    expect(delayed.messages.find((item) => item.id === "card")?.blocks).toEqual(
      card("Done").blocks,
    );
    expect(delayed.messages.map((item) => item.id)).toEqual(["older", "card"]);
    const newer = prependThreadMessagePage(current, page, 12)!;
    expect(newer.messages.find((item) => item.id === "card")?.blocks).toEqual(
      card("Skipped").blocks,
    );
  });
});

it("replays a covered clear as a history barrier while retaining newer snapshot state", () => {
  const run = threadRun("current-run", "bot-2");
  const base = {
    ...snapshot([message("recent", [{ kind: "text", text: "After clear" }], 9)], 9),
    cursor: 30,
    run,
    activeRuns: [run],
  };
  const older = event({
    type: "thread.message.created",
    seq: 7,
    payload: {
      messageId: "old-card",
      messageSeq: 0,
      role: "bot",
      blocks: [{ kind: "computer", state: "Needs you", text: "Before clear" }],
    },
  });
  const replayed = reduceThreadSnapshot(base, older)!;
  const cleared = reduceThreadSnapshot(replayed, event({ type: "thread.cleared", seq: 20 }))!;
  expect(cleared.messages.map((item) => item.id)).toEqual(["recent"]);
  expect(cleared.run).toBe(run);
  expect(cleared.activeRuns).toBe(base.activeRuns);
  expect(cleared.cursor).toBe(30);
  expect(cleared.olderCursor).toBe(9);
  expect(reduceThreadSnapshot(cleared, older)).toBe(cleared);
});

it("the Shell reader retains a covered clear barrier without replacing current execution", () => {
  const source = readFileSync(new URL("../pages/Shell.tsx", import.meta.url), "utf8");
  const start = source.indexOf("    const applyReaderEvent = (event: ProductEvent) => {");
  const end = source.indexOf("\n    return {\n      resume,", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source
    .slice(start + "    const applyReaderEvent = ".length, end)
    .trim()
    .replace(/;$/, "");
  const bufferStart = source.indexOf(
    "    const bufferCleanupEvent =",
    source.indexOf("function createThreadReader"),
  );
  const bufferEnd = source.indexOf("    const applyReaderEvent =", bufferStart);
  const buffer = source.slice(bufferStart, bufferEnd).replace("(event: ProductEvent)", "(event)");
  const historyStart = source.indexOf("  function reconcileClearHistory(");
  const historyEnd = source.indexOf("  function retryCurrentThread()", historyStart);
  const history = source
    .slice(historyStart, historyEnd)
    .replace("(previous: ThreadSnapshot, next: ThreadSnapshot)", "(previous, next)");
  const script = `${history} ${buffer} const handler = ${body.replace("(event: ProductEvent)", "(event)")};`;
  const run = threadRun("current-run", "bot-2");
  const snapRef = {
    current: {
      ...snapshot([message("recent", [], 9)], 9),
      cursor: 30,
      run,
      activeRuns: [run],
    } as ThreadSnapshot | null,
  };
  const scope = {
    ownsReader: () => true,
    owner: "owner-one",
    observeMemoryCleanup,
    pendingMemoryCleanupEvents: { current: new Map() },
    scope: "scope-one",
    shouldResetHistoryAfterClear,
    pinnedAroundRef: { current: null },
    setScrollRequest: () => {},
    searchParamsRef: { current: new URLSearchParams() },
    setSearchParams: () => {},
    snapshotRef: snapRef,
    reduceThreadSnapshot,
    expandedHistoryThread: { current: null },
    commitSnapshot: (next: ThreadSnapshot | null) => {
      snapRef.current = next;
    },
  };
  const apply = new Function(...Object.keys(scope), `${script}; return handler;`)(
    ...Object.values(scope),
  ) as (event: ProductEvent) => void;
  const older = event({
    type: "thread.message.created",
    seq: 7,
    payload: {
      messageId: "old-card",
      messageSeq: 0,
      role: "bot",
      blocks: [{ kind: "computer", state: "Needs you", text: "Before clear" }],
    },
  });
  apply(older);
  apply(event({ type: "thread.cleared", seq: 20 }));
  apply(older);
  expect(snapRef.current?.messages.map((item) => item.id)).toEqual(["recent"]);
  expect(snapRef.current?.run).toBe(run);
  expect(snapRef.current?.cursor).toBe(30);
});

it("uses a complete nonempty snapshot as authoritative history after a clear", () => {
  const previous = {
    ...snapshot(
      [message("old-card", [{ kind: "computer", state: "Needs you", text: "Before clear" }], 0)],
      1,
    ),
    cursor: 10,
  };
  const current = mergeThreadSnapshot(
    previous,
    { ...snapshot([message("after-clear", [], 5)]), cursor: 30 },
    true,
  );
  expect(current.messages.map((item) => item.id)).toEqual(["after-clear"]);
  expect(
    reduceThreadSnapshot(
      current,
      event({
        type: "thread.message.created",
        seq: 7,
        payload: {
          messageId: "old-card",
          messageSeq: 0,
          role: "bot",
          blocks: previous.messages[0]!.blocks,
        },
      }),
    ),
  ).toBe(current);
});

it("announces an actual completion reduction after it removes the primary Run", () => {
  const run = threadRun("run-1");
  let current: ThreadSnapshot | null = { ...snapshot([]), run, activeRuns: [run] };
  const announcements = new ReplyAnnouncements();
  announcements.update("scope", true, current);
  for (const next of [
    event({
      type: "thread.message.created",
      seq: 4,
      payload: {
        messageId: "final",
        role: "bot",
        blocks: [{ kind: "text", text: "Committed reply" }],
      },
    }),
    event({ type: "run.completed", seq: 5, payload: { messageId: "final" } }),
  ]) {
    current = reduceThreadSnapshot(current, next);
    announcements.observe("scope", true, next);
  }
  expect(current?.run).toBeNull();
  expect(current?.activeRuns).toEqual([]);
  expect(announcements.update("scope", true, current)).toEqual(["Committed reply"]);
  expect(announcements.update("scope", true, current)).toEqual([]);
});

it("a send receipt introduces work before any event cursor advancement", () => {
  const initial = snapshot([]);
  const received = applyThreadSendReceipt(initial, {
    botId: "bot-1",
    runId: "new-receipt-run",
    taskId: "new-task",
  })!;
  expect(received.cursor).toBe(initial.cursor);
  expect(received.run?.id).toBe("new-receipt-run");
  expect(hasNewThreadWork(received, initial)).toBe(true);
});

describe("external memory cleanup uncertainty", () => {
  it("applies a late metadata warning without erasing messages or current work", () => {
    const initial = snapshot([message("new-message", [{ kind: "text", text: "After clear" }])]);
    initial.run = threadRun("active-after-clear");
    const update = event({ type: "thread.meta", payload: { memoryCleanupUnconfirmed: true } });
    expect(isThreadSnapshotEvent(update)).toBe(true);
    const next = reduceThreadSnapshot(initial, update)!;
    expect(next.memoryCleanupUnconfirmed).toBe(true);
    expect((next as ThreadSnapshot & { observedClearSeq?: number }).observedClearSeq).toBe(
      initial.cursor,
    );
    expect(next.messages).toHaveLength(initial.messages.length);
    expect(next.messages).toMatchObject(initial.messages);
    expect(next.run).toEqual(initial.run);
    expect(reduceThreadSnapshot(next, update)).toBe(next);
    expect(
      reduceThreadSnapshot(
        next,
        event({
          threadId: "another-thread",
          seq: 5,
          type: "thread.meta",
          payload: { memoryCleanupUnconfirmed: true },
        }),
      ),
    ).toBe(next);
  });
  it("retains uncertainty across clear and same-thread refresh without leaking to another thread", () => {
    const initial = { ...snapshot([]), memoryCleanupUnconfirmed: true as const };
    const cleared = reduceThreadSnapshot(initial, event({ type: "thread.cleared", payload: {} }))!;
    expect(cleared.memoryCleanupUnconfirmed).toBe(true);
    expect(
      mergeThreadSnapshot(cleared, { ...snapshot([]), cursor: 5 }).memoryCleanupUnconfirmed,
    ).toBe(true);
    expect(
      mergeThreadSnapshot(cleared, { ...snapshot([]), threadId: "another-thread", cursor: 5 })
        .memoryCleanupUnconfirmed,
    ).toBeUndefined();
  });
});

it("orders cleanup independently of newer transcript events and resets omitted pending on clear", () => {
  const current = {
    ...snapshot([]),
    cursor: 30,
    observedClearSeq: 1,
    memoryCleanupCursor: 5,
    memoryCleanupPending: true,
  };
  const cleared = reduceThreadSnapshot(
    current,
    event({ type: "thread.cleared", seq: 10, payload: { memoryCleanupUnconfirmed: true } }),
  )!;
  expect(cleared.cursor).toBe(30);
  expect(cleared.memoryCleanupPending).toBe(false);
  expect(cleared.memoryCleanupUnconfirmed).toBe(true);
  const settled = { ...current, memoryCleanupCursor: 20, memoryCleanupPending: false };
  expect(
    reduceThreadSnapshot(
      settled,
      event({ type: "thread.meta", seq: 15, payload: { memoryCleanupPending: true } }),
    )!.memoryCleanupPending,
  ).toBe(false);
});

it("settles pending cleanup by sequence without resetting a sticky failure or current Run", () => {
  const initial = {
    ...snapshot([]),
    run: threadRun("still-running"),
    memoryCleanupUnconfirmed: true as const,
  };
  const pendingEvent = event({
    type: "thread.meta",
    seq: 4,
    payload: { memoryCleanupPending: true },
  });
  const pending = reduceThreadSnapshot(initial, pendingEvent)!;
  expect(pending.memoryCleanupPending).toBe(true);
  const settled = reduceThreadSnapshot(
    pending,
    event({ type: "thread.meta", seq: 5, payload: { memoryCleanupPending: false } }),
  )!;
  expect(settled.memoryCleanupPending).toBe(false);
  expect(settled.memoryCleanupUnconfirmed).toBe(true);
  expect(settled.run).toBe(initial.run);
  expect(reduceThreadSnapshot(settled, pendingEvent)).toBe(settled);
});

it("keeps pending cleanup across an omitted refresh until an explicit settlement", () => {
  const previous = {
    ...snapshot([]),
    cursor: 10,
    memoryCleanupPending: true,
    memoryCleanupCursor: 10,
  };
  const refreshed = mergeThreadSnapshot(previous, { ...snapshot([]), cursor: 25 });
  expect(refreshed).toMatchObject({ memoryCleanupPending: true, memoryCleanupCursor: 10 });
  const settled = mergeThreadSnapshot(refreshed, {
    ...snapshot([]),
    cursor: 25,
    memoryCleanupPending: false,
    memoryCleanupCursor: 12,
  });
  expect(settled).toMatchObject({ memoryCleanupPending: false, memoryCleanupCursor: 12 });
});

describe("Shell clear receipt snapshot commits", () => {
  async function fixture(group = false) {
    const source = readFileSync(new URL("../pages/Shell.tsx", import.meta.url), "utf8");
    function declaration(name: string) {
      let start = source.indexOf(`  function ${name}(`);
      if (start < 0) start = source.indexOf(`  async function ${name}(`);
      if (start < 0) return "";
      if (name === "jumpToMessage")
        return source.slice(start, source.indexOf("  // The routine panel copies", start));
      const body = source.indexOf("{", start);
      let depth = 0;
      for (let end = body; end < source.length; end++) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}" && --depth === 0) return source.slice(start, end + 1);
      }
      throw new Error(`Unclosed source function ${name}`);
    }
    const start = source.indexOf(
      "onConfirm={async () => {",
      source.indexOf("<ClearConversationDialog"),
    );
    const end = source.indexOf("\n            }}", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const confirm = `${source.slice(start + "onConfirm={".length, end)}\n}`;
    const a = {
      ...snapshot([message("A-message", [{ kind: "text", text: "Thread A" }])]),
      botId: "bot-A",
      threadId: "thread-A",
      cursor: 10,
    };
    const b = {
      ...snapshot([message("deleted-B", [{ kind: "text", text: "Before clear B" }])]),
      botId: group ? undefined : "bot-B",
      ...(group ? { groupId: "group-B" } : {}),
      threadId: "thread-B",
      cursor: 10,
    };
    let releaseGet!: (value: ThreadSnapshot) => void;
    let releasePage!: (value: ThreadMessagePage) => void;
    let gotGet!: () => void;
    let gotPage!: () => void;
    const getStarted = new Promise<void>((resolve) => {
      gotGet = resolve;
    });
    const pageStarted = new Promise<void>((resolve) => {
      gotPage = resolve;
    });
    const getResponse = new Promise<ThreadSnapshot>((resolve) => {
      releaseGet = resolve;
    });
    const pageResponse = new Promise<ThreadMessagePage>((resolve) => {
      releasePage = resolve;
    });
    const snapshotRef = { current: a as ThreadSnapshot | null };
    const actor = { current: { userId: "user-one", spaceId: "space-one" as string | undefined } };
    const generation = { session: 1, selection: 1 };
    let complete!: (value: {
      ok: true;
      threadId: string;
      clearEventSeq: number;
      cancelledRunIds?: string[];
      memoryCleanupCursor?: number;
      memoryCleanupPending?: boolean;
      memoryCleanupUnconfirmed?: true;
    }) => void;
    const response = new Promise<Parameters<typeof complete>[0]>((resolve) => {
      complete = resolve;
    });
    let commit!: (value: ThreadSnapshot | null) => void;
    let pending = new Set<string>();
    const scope = {
      groupSettingsActor: actor,
      selectedSpaceId: () => null,
      currentRpcSessionGeneration: () => generation.session,
      currentSpaceSelectionGeneration: () => generation.selection,
      pendingClearReceipts: { current: new Map() },
      pendingMemoryCleanupEvents: { current: new Map() },
      dismissedMemoryCleanupNotices: { current: new Set<string>() },
      draftScopeKey: "scope-B",
      draftScopeKeyRef: { current: "scope-B" },
      readerAbort: new AbortController(),
      threadCheckpoint: { current: null },
      computerRef: { current: null },
      commitComputerEvent: vi.fn(),
      commitComputer: vi.fn(),
      savedGroupUpdates: { current: new Map() },
      searchHitThreadTarget,
      userVisibleMessages,
      reconcileRefreshedThread,
      protectThreadMessagePage,
      reduceThreadSnapshot,
      publishComputerCommand,
      isThreadSnapshotEvent,
      isComputerStatusEvent,
      reduceComputerStatus,
      isApprovalAskBlock,
      isRunTerminalEvent,
      jumpGeneration: { current: 0 },
      initiallyScrolledThread: { current: null },
      messageScroll: { current: null },
      setRoutines: vi.fn(),
      setRoutinesBotId: vi.fn(),
      window: {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        },
      },
      snapshotRef,
      terminalRunReceipts: { current: new Set<string>() },
      terminalRunReceiptBatches: { current: [] as string[][] },
      setSnapshot: vi.fn(),
      withLiveStreamingProgress: (value: ThreadSnapshot | null) => value,
      streamResponsesRef: { current: false },
      currentComputerStatus: (value: unknown) => value,
      pinnedAroundRef: {
        current: null as {
          messageId: string;
          threadId: string;
          messages: ThreadMessage[];
          olderCursor: number | null;
        } | null,
      },
      expandedHistoryThread: { current: null },
      historyEpoch: { current: 1 },
      setScrollRequest: vi.fn(),
      searchParamsRef: { current: new URLSearchParams() },
      setSearchParams: vi.fn(),
      clearHistoryWindow: vi.fn(),
      clearTarget: {
        kind: group ? "group" : "bot",
        chat: { id: group ? "group-B" : "bot-B", threadId: "thread-B" },
      },
      activeBotId: { current: group ? undefined : "bot-B" },
      activeGroupId: { current: group ? "group-B" : undefined },
      setPendingMemoryCleanupClears: (update: (value: Set<string>) => Set<string>) => {
        pending = update(pending);
      },
      rpc: {
        threads: {
          clear: vi.fn(async () => response),
          get: vi.fn(async () => {
            gotGet();
            return getResponse;
          }),
          messages: vi.fn(async () => {
            gotPage();
            return pageResponse;
          }),
        },
        routines: { list: vi.fn(async () => []) },
      },
      updateSnapshot: (update: (value: ThreadSnapshot | null) => ThreadSnapshot | null) =>
        commit(update(snapshotRef.current)),
      refreshThreadRef: { current: vi.fn(async () => undefined) },
      refreshGroupThreadRef: { current: vi.fn(async () => undefined) },
      showMemoryCleanupNotice: vi.fn(),
      setClearTarget: vi.fn(),
      refreshBots: vi.fn(async () => undefined),
      hasNewThreadWork,
      applyThreadClearReceipt,
      applyThreadRunCancellations,
      observeMemoryCleanup,
      threadClearCancelledRunIds,
      shouldResetHistoryAfterClear,
    };
    const eventHelperStart = source.indexOf("\nfunction applyThreadEvent(") + 1;
    const eventHelperEnd = source.indexOf("\nfunction ComputerReleaseActions(", eventHelperStart);
    expect(eventHelperStart).toBeGreaterThan(0);
    expect(eventHelperEnd).toBeGreaterThan(eventHelperStart);
    const script = `function buildCallbacks() {
      ${source.slice(eventHelperStart, eventHelperEnd)}
      ${declaration("rememberTerminalRunIds")}
      ${declaration("clearReceiptOwnerKey")}
      ${declaration("reconcileClearHistory")}
      ${declaration("reconcileBufferedThreadSnapshot")}
      ${declaration("commitSnapshot")}
      ${declaration("createThreadReader")}
      ${declaration("jumpToMessage")}
      const confirm = ${confirm};
      return { commit: commitSnapshot, confirm, jump: jumpToMessage, reader: createThreadReader(readerAbort) };
    }`;
    const compiled = await transformWithOxc(script, "thread-cleanup-fixture.ts");
    const callbacks = new Function(
      ...Object.keys(scope),
      `${compiled.code}; return buildCallbacks();`,
    )(...Object.values(scope)) as {
      commit(value: ThreadSnapshot | null): void;
      confirm(): Promise<void>;
      jump(target: { botId?: string; groupId?: string; messageId: string }): Promise<void>;
      reader: {
        beforeEvent(event: ProductEvent): boolean;
        ownsReader(): boolean;
        applyEvent(event: ProductEvent): void;
      };
    };
    commit = callbacks.commit;
    return {
      ...callbacks,
      complete,
      a,
      b,
      snapshotRef,
      scope,
      generation,
      actor,
      releaseGet,
      releasePage,
      getStarted,
      pageStarted,
    };
  }
  it.each([false, true].flatMap((group) => [false, true].map((resume) => ({ group, resume }))))(
    "applies a visible clear before recovery without replay restoring old rows ($group, $resume)",
    async ({ group, resume }) => {
      const h = await fixture(group);
      const before = { ...h.b, cursor: 15, olderCursor: 1 };
      h.snapshotRef.current = before;
      let releaseRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      const abort = new AbortController();
      const stopped = new Promise<void>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      const clear = event({
        threadId: "thread-B",
        botId: "bot-B",
        seq: 22,
        type: "thread.cleared",
        payload: {},
      });
      const ordinary = event({
        threadId: "thread-B",
        botId: "bot-B",
        seq: 21,
        type: "thread.message.created",
        payload: { messageId: "ordinary", messageSeq: 2, role: "user", blocks: [] },
      });
      const apply = vi.fn(h.reader.applyEvent);
      const observe = vi.fn();
      const refresh = vi.fn(async () => {
        await recovery;
        h.commit(
          reconcileRefreshedThread(
            h.snapshotRef.current,
            { ...before, cursor: 30, olderCursor: 20, messages: [message("new-after-clear", [])] },
            null,
            true,
          ).snapshot,
        );
      });
      vi.useFakeTimers();
      const running = runThreadSubscription({
        signal: abort.signal,
        loadInitial: async () => {
          throw new Error("snapshot interrupted");
        },
        loadHead: async () => ({ threadId: "thread-B", cursor: 20 }),
        refresh,
        currentSnapshot: () => h.snapshotRef.current,
        subscribe: async () =>
          (async function* () {
            yield ordinary;
            yield clear;
            await stopped;
          })(),
        beforeEvent: h.reader.beforeEvent,
        applyEvent: apply,
        onEvent: observe,
        onCursor: vi.fn(),
        ...(resume ? { resume: { threadId: "thread-B", cursor: 20 } } : {}),
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(observe).toHaveBeenCalledTimes(2);
        expect(apply).not.toHaveBeenCalled();
        expect(h.snapshotRef.current?.messages).toEqual([]);
        expect(h.snapshotRef.current).toMatchObject({ observedClearSeq: 22, cursor: 22 });
        await vi.advanceTimersByTimeAsync(250);
        expect(refresh).toHaveBeenCalledTimes(1);
        releaseRecovery();
        await vi.advanceTimersByTimeAsync(0);
        expect(apply.mock.calls.map(([event]) => event)).toEqual(resume ? [ordinary, clear] : []);
        expect(h.snapshotRef.current?.messages.map((row) => row.id)).toEqual(["new-after-clear"]);
        expect(h.snapshotRef.current).toMatchObject({ observedClearSeq: 22, cursor: 30 });
      } finally {
        releaseRecovery();
        abort.abort();
        await running;
        vi.useRealTimers();
      }
    },
  );

  it.each(
    [false, true].flatMap((reverse) =>
      ["cancelled", "fresh", "legacy"].map((mode) => ({ reverse, mode })),
    ),
  )(
    "keeps every buffered cancellation without confusing the latest clear evidence ($reverse, $mode)",
    async ({ reverse, mode }) => {
      const h = await fixture();
      const first = event({
        threadId: "thread-B",
        botId: "bot-B",
        seq: 22,
        type: "thread.cleared",
        payload: { cancelledRunIds: ["cancelled-first"] },
      });
      const latest = event({
        threadId: "thread-B",
        botId: "bot-B",
        seq: 24,
        type: "thread.cleared",
        payload: mode === "legacy" ? {} : { cancelledRunIds: [] },
      });
      for (const frame of reverse ? [latest, first] : [first, latest]) h.reader.beforeEvent(frame);
      h.reader.beforeEvent(
        event({
          threadId: "thread-B",
          botId: "bot-B",
          seq: 35,
          type: "thread.meta",
          payload: { memoryCleanupPending: true },
        }),
      );
      expect(h.snapshotRef.current).toBe(h.a);
      const run = {
        ...threadRun(mode === "cancelled" ? "cancelled-first" : "uncancelled", "bot-B"),
        threadId: "thread-B",
        status: "queued" as const,
      };
      h.commit({
        ...h.b,
        cursor: mode === "fresh" ? 30 : 15,
        olderCursor: 1,
        run,
        activeRuns: [run],
      });
      expect(h.snapshotRef.current?.run?.id ?? null).toBe(mode === "fresh" ? "uncancelled" : null);
      expect(h.snapshotRef.current?.activeRuns?.map((run) => run.id)).toEqual(
        mode === "fresh" ? ["uncancelled"] : [],
      );
      expect(h.snapshotRef.current).toMatchObject({
        observedClearSeq: 24,
        memoryCleanupCursor: 35,
        memoryCleanupPending: true,
      });
      expect(h.scope.pendingMemoryCleanupEvents.current.size).toBe(0);
    },
  );
  it.each(["queued", "running"] as const)(
    "removes a cached %s Run when only the replacement clear is received",
    async (status) => {
      const h = await fixture();
      const run = { ...threadRun("stale-run", "bot-B"), status };
      h.snapshotRef.current = { ...h.b, cursor: 15, olderCursor: 1, run, activeRuns: [run] };
      h.reader.beforeEvent(
        event({
          threadId: "thread-B",
          botId: "bot-B",
          seq: 22,
          type: "thread.cleared",
          payload: { cancelledRunIds: [] },
        }),
      );
      expect(h.snapshotRef.current?.run).toBeNull();
      expect(h.snapshotRef.current?.activeRuns).toEqual([]);
    },
  );
  it.each([false, true])(
    "keeps the post-clear queued Run before its run event (cached active: %s)",
    async (active) => {
      const h = await fixture();
      const previous = threadRun("old-run", "bot-B");
      h.snapshotRef.current = applyThreadSendReceipt(
        {
          ...h.b,
          cursor: 15,
          olderCursor: 1,
          run: active ? previous : null,
          activeRuns: active ? [previous] : [],
        },
        { botId: "bot-B", runId: "new-send", taskId: "new-task", eventSeq: 21 },
      );
      h.reader.beforeEvent(
        event({
          threadId: "thread-B",
          botId: "bot-B",
          seq: 20,
          type: "thread.cleared",
          payload: { cancelledRunIds: ["old-run"] },
        }),
      );
      expect(h.snapshotRef.current?.messages).toEqual([]);
      expect(h.snapshotRef.current?.run?.id).toBe("new-send");
      expect(h.snapshotRef.current?.activeRuns?.map((run) => run.id)).toEqual(["new-send"]);
    },
  );
  it.each(["before", "after"])(
    "rejects a cancelled send receipt arriving %s the equal-boundary clear receipt",
    async (timing) => {
      const h = await fixture();
      h.snapshotRef.current = {
        ...h.b,
        cursor: 20,
        observedClearSeq: 20,
        olderCursor: 1,
        messages: [message("anchor", [])],
        run: null,
        activeRuns: [],
      } as ThreadSnapshot;
      const receipt = { botId: "bot-B", runId: "cancelled-send", taskId: "cancelled-task" };
      const apply = () => {
        h.snapshotRef.current = applyThreadSendReceipt(
          h.snapshotRef.current,
          receipt,
          h.scope.terminalRunReceipts.current,
        );
      };
      const clearing = h.confirm();
      if (timing === "before") apply();
      h.complete({
        ok: true,
        threadId: "thread-B",
        clearEventSeq: 20,
        cancelledRunIds: [receipt.runId],
        memoryCleanupCursor: 30,
        memoryCleanupPending: false,
      });
      await clearing;
      if (timing === "after") apply();
      expect(h.snapshotRef.current?.run).toBeNull();
      expect(h.snapshotRef.current?.activeRuns).toEqual([]);
      expect(h.snapshotRef.current?.messages.map((row) => row.id)).toEqual(["anchor"]);
      expect(h.snapshotRef.current?.olderCursor).toBe(1);
      expect(h.scope.terminalRunReceipts.current.has(receipt.runId)).toBe(true);
    },
  );
  it("retains a whole atomic cancellation batch larger than the terminal history count", async () => {
    const h = await fixture();
    h.snapshotRef.current = {
      ...h.b,
      cursor: 20,
      observedClearSeq: 20,
      olderCursor: 1,
      run: null,
      activeRuns: [],
    } as ThreadSnapshot;
    const receipt = { botId: "bot-B", runId: "cancelled-first", taskId: "send-task" };
    const clearing = h.confirm();
    h.complete({
      ok: true,
      threadId: "thread-B",
      clearEventSeq: 20,
      cancelledRunIds: [
        receipt.runId,
        ...Array.from({ length: 100 }, (_, i) => `other-cancelled-${i}`),
      ],
    });
    await clearing;
    h.snapshotRef.current = applyThreadSendReceipt(
      h.snapshotRef.current,
      receipt,
      h.scope.terminalRunReceipts.current,
    );
    expect(h.snapshotRef.current?.run).toBeNull();
    expect(h.scope.terminalRunReceipts.current.has(receipt.runId)).toBe(true);
    h.snapshotRef.current = applyThreadSendReceipt(
      h.snapshotRef.current,
      { ...receipt, runId: "uncancelled", eventSeq: 21 },
      h.scope.terminalRunReceipts.current,
    );
    expect(h.snapshotRef.current?.run?.id).toBe("uncancelled");
  });
  it("keeps an uncancelled send after recording a different cancelled Run", async () => {
    const h = await fixture();
    h.snapshotRef.current = { ...h.b, cursor: 20, olderCursor: 1, run: null, activeRuns: [] };
    h.reader.beforeEvent(
      event({
        threadId: "thread-B",
        botId: "bot-B",
        seq: 22,
        type: "thread.cleared",
        payload: { cancelledRunIds: ["old-send"] },
      }),
    );
    h.snapshotRef.current = applyThreadSendReceipt(
      h.snapshotRef.current,
      { botId: "bot-B", runId: "new-send", taskId: "new-task", eventSeq: 23 },
      h.scope.terminalRunReceipts.current,
    );
    expect(h.snapshotRef.current?.run?.id).toBe("new-send");
    expect(h.scope.terminalRunReceipts.current.has("old-send")).toBe(true);
  });
  it.each(
    [false, true].flatMap((group) =>
      ["in-flight", "before-page", "post-clear-snapshot"].flatMap((timing) =>
        ["meta-first", "clear-first"].map((order) => ({ group, timing, order })),
      ),
    ),
  )(
    "admits only post-clear web pages ($group, $timing, $order)",
    async ({ group, timing, order }) => {
      const h = await fixture(group);
      const target = group ? { groupId: "group-B" } : { botId: "bot-B" };
      const cursor = timing === "post-clear-snapshot" ? 25 : 15;
      const base = {
        ...h.b,
        cursor,
        olderCursor: 1,
        messages: [message(timing === "in-flight" ? "anchor" : "old-from-snapshot", [])],
      };
      const loading = h.jump({ ...target, messageId: "anchor" });
      await h.getStarted;
      const clear = event({
        type: "thread.cleared",
        threadId: "thread-B",
        botId: "bot-B",
        seq: 20,
        payload: {},
      });
      const meta = event({
        type: "thread.meta",
        threadId: "thread-B",
        botId: "bot-B",
        seq: 40,
        payload: { memoryCleanupPending: true, memoryCleanupUnconfirmed: true },
      });
      const emit = () => {
        if (order === "meta-first") h.reader.beforeEvent(meta);
        h.reader.beforeEvent(clear);
        if (order === "clear-first") h.reader.beforeEvent(meta);
      };
      if (timing === "before-page") emit();
      h.releaseGet(base);
      await h.pageStarted;
      if (timing !== "before-page") emit();
      expect(h.snapshotRef.current).toBe(h.a);
      h.releasePage({ threadId: "thread-B", messages: [message("anchor", [])], olderCursor: 1 });
      await loading;
      const rejected = timing === "in-flight";
      expect(h.snapshotRef.current?.messages.map((row) => row.id)).toEqual(
        rejected ? [] : ["anchor"],
      );
      expect(h.scope.pinnedAroundRef.current?.messageId ?? null).toBe(rejected ? null : "anchor");
      expect(h.snapshotRef.current).toMatchObject({
        cursor: timing === "post-clear-snapshot" ? 25 : 20,
        observedClearSeq: 20,
        memoryCleanupCursor: 40,
        memoryCleanupPending: true,
        memoryCleanupUnconfirmed: true,
      });
      expect(h.scope.historyEpoch.current).toBe(1);
    },
  );

  it.each(["user", "session", "selection", "abort", "target"] as const)(
    "rejects a cold live clear from an obsolete reader after %s changes",
    async (change) => {
      const h = await fixture();
      if (change === "user") h.actor.current.userId = "user-two";
      else if (change === "session" || change === "selection") h.generation[change]++;
      else if (change === "abort") h.scope.readerAbort.abort();
      else h.scope.activeBotId.current = "bot-C";
      expect(
        h.reader.beforeEvent(
          event({
            type: "thread.cleared",
            threadId: "thread-B",
            botId: "bot-B",
            seq: 20,
            payload: { cancelledRunIds: ["foreign-run"] },
          }),
        ),
      ).toBe(false);
      expect(h.scope.pendingMemoryCleanupEvents.current.size).toBe(0);
      expect(h.scope.terminalRunReceipts.current.size).toBe(0);
      expect(h.snapshotRef.current).toBe(h.a);
    },
  );

  it("does not apply a former owner's buffered live clear to a new snapshot", async () => {
    const h = await fixture();
    h.scope.pendingMemoryCleanupEvents.current.set("thread-B", {
      owner: "former-owner",
      scope: "scope-B",
      seq: 40,
      clear: event({ type: "thread.cleared", threadId: "thread-B", seq: 20, payload: {} }),
      payload: { memoryCleanupPending: true },
    });
    h.commit(h.b);
    expect(h.snapshotRef.current?.messages).toEqual(h.b.messages);
    expect(h.snapshotRef.current?.memoryCleanupPending).toBeUndefined();
  });

  it("buffers B's clear boundary while A is still the committed snapshot", async () => {
    const h = await fixture();
    const clearing = h.confirm();
    h.complete({
      ok: true,
      threadId: "thread-B",
      clearEventSeq: 12,
      cancelledRunIds: [],
      memoryCleanupPending: true,
      memoryCleanupCursor: 15,
    });
    await clearing;
    expect(h.snapshotRef.current).toBe(h.a);
    h.commit({ ...h.b, memoryCleanupPending: false });
    expect(h.snapshotRef.current).toMatchObject({
      threadId: "thread-B",
      cursor: 12,
      memoryCleanupPending: true,
      memoryCleanupCursor: 15,
      messages: [],
    });
    expect(h.scope.pendingClearReceipts.current.size).toBe(0);
  });
  it("rearms a dismissed web interval between consecutive committed metadata frames", async () => {
    const h = await fixture();
    const current = { ...h.b, cursor: 20, memoryCleanupCursor: 20, memoryCleanupPending: true };
    h.commit(current);
    const noticeScope = JSON.stringify(["user-one", "space-one", "thread-B"]);
    const key = JSON.stringify([noticeScope, true]);
    h.scope.dismissedMemoryCleanupNotices.current.add(key);
    const settled = reduceThreadSnapshot(
      current,
      event({
        type: "thread.meta",
        threadId: "thread-B",
        botId: "bot-B",
        seq: 21,
        payload: { memoryCleanupPending: false },
      }),
    )!;
    h.commit(settled);
    h.commit(
      reduceThreadSnapshot(
        settled,
        event({
          type: "thread.meta",
          threadId: "thread-B",
          botId: "bot-B",
          seq: 22,
          payload: { memoryCleanupPending: true },
        }),
      ),
    );
    expect(h.scope.dismissedMemoryCleanupNotices.current.has(key)).toBe(false);
    h.scope.dismissedMemoryCleanupNotices.current.add(key);
    h.commit(
      reduceThreadSnapshot(
        h.snapshotRef.current,
        event({
          type: "thread.meta",
          threadId: "thread-B",
          botId: "bot-B",
          seq: 19,
          payload: { memoryCleanupPending: false },
        }),
      ),
    );
    expect(h.scope.dismissedMemoryCleanupNotices.current.has(key)).toBe(true);
  });
  it("keeps a newer matching snapshot ahead of the buffered cleanup receipt", async () => {
    const h = await fixture();
    const clearing = h.confirm();
    h.complete({
      ok: true,
      threadId: "thread-B",
      clearEventSeq: 12,
      memoryCleanupPending: true,
      memoryCleanupCursor: 15,
    });
    await clearing;
    const after = {
      ...h.b,
      cursor: 20,
      memoryCleanupPending: false,
      memoryCleanupCursor: 20,
      messages: [message("after", [{ kind: "text", text: "After clear" }])],
    };
    h.commit(after);
    expect(h.snapshotRef.current).toMatchObject({
      cursor: 20,
      memoryCleanupPending: false,
      memoryCleanupCursor: 20,
      messages: after.messages,
    });
  });
  it.each(["user", "session", "selection"] as const)(
    "does not apply another %s owner's buffered receipt",
    async (change) => {
      const h = await fixture();
      const clearing = h.confirm();
      h.complete({
        ok: true,
        threadId: "thread-B",
        clearEventSeq: 12,
        memoryCleanupPending: true,
        memoryCleanupCursor: 15,
      });
      await clearing;
      if (change === "user") h.actor.current.userId = "user-two";
      else h.generation[change]++;
      h.commit(h.b);
      expect(h.snapshotRef.current?.messages).toEqual(h.b.messages);
      expect(h.snapshotRef.current?.memoryCleanupPending).toBeUndefined();
    },
  );
  it("keeps clear ownership stable when the implicit Space proof becomes ready", async () => {
    const h = await fixture();
    h.actor.current.spaceId = undefined;
    const clearing = h.confirm();
    h.actor.current.spaceId = "space-one";
    h.complete({
      ok: true,
      threadId: "thread-B",
      clearEventSeq: 12,
      memoryCleanupPending: true,
      memoryCleanupCursor: 15,
    });
    await clearing;
    h.commit(h.b);
    expect(h.snapshotRef.current).toMatchObject({ memoryCleanupPending: true, messages: [] });
  });
});
