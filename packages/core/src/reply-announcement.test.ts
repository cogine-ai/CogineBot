import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import replyAnnouncementCases from "../../testkit/src/reply-announcement-fixtures.json" with {
  type: "json",
};
import type { AnnouncementEvent, AnnouncementSnapshot } from "./reply-announcement.js";
import { ReplyAnnouncements } from "./reply-announcement.js";

const REPLY_ANNOUNCEMENT_CASES = replyAnnouncementCases as {
  name: string;
  blocks: MessageBlock[];
  spoken: string;
}[];

function snapshot(runId: string | null = "run-a", text?: string): AnnouncementSnapshot {
  return {
    threadId: "thread-a",
    cursor: 10,
    run: runId ? { id: runId, status: "running" } : null,
    messages:
      text === undefined
        ? []
        : [{ id: "final", role: "bot", runId: "run-a", blocks: [{ kind: "text", text }] }],
  };
}
function terminal(overrides: Partial<AnnouncementEvent> = {}): AnnouncementEvent {
  return {
    type: "run.completed",
    threadId: "thread-a",
    runId: "run-a",
    seq: 12,
    payload: { messageId: "final" },
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("durable visible reply announcements", () => {
  it.each(REPLY_ANNOUNCEMENT_CASES)(
    "announces visible $name without mutating stored blocks",
    ({ blocks, spoken }) => {
      const observer = new ReplyAnnouncements();
      observer.update("scope", true, snapshot());
      observer.observe("scope", true, terminal());
      const completed = snapshot(null);
      const storedBlocks = deepFreeze(structuredClone(blocks));
      completed.messages = [{ id: "final", role: "bot", runId: "run-a", blocks: storedBlocks }];
      const original = structuredClone(blocks);
      expect(observer.update("scope", true, completed)).toEqual(spoken ? [spoken] : []);
      expect(completed.messages[0]!.blocks).toBe(storedBlocks);
      expect(storedBlocks).toEqual(original);
      observer.observe("scope", true, terminal());
      expect(observer.update("scope", true, completed)).toEqual([]);
    },
  );
  it("consumes an empty visible result without announcing a later edit or duplicate receipt", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "***"))).toEqual([]);
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "Late visible edit"))).toEqual([]);
  });
  it("does not announce background ticket work that never became the visible Run", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot(null));
    observer.observe(
      "scope",
      true,
      terminal({ type: "run.started", seq: 11, payload: { trigger: "tickets" } }),
    );
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "Internal ticket work"))).toEqual([]);
  });
  it("does not let a covered historical clear suppress the current Run", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    observer.update("scope", true, { ...snapshot(), cursor: 30 });
    observer.observe("scope", true, { type: "thread.cleared", threadId: "thread-a", seq: 20 });
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "Done"))).toEqual(["Done"]);
  });
  it("announces the exact committed message after the primary Run has been cleared, once", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "最终\nreply 👩‍👩‍👧‍👦"))).toEqual([
      "最终 reply 👩‍👩‍👧‍👦",
    ]);
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "最终\nreply 👩‍👩‍👧‍👦"))).toEqual([]);
  });
  it("retains a terminal receipt until its matching durable message arrives", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null))).toEqual([]);
    expect(observer.update("scope", true, snapshot(null, "Done"))).toEqual(["Done"]);
  });
  it("tracks a fast Run started and completed between React renders", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot(null));
    observer.observe("scope", true, terminal({ type: "run.started", seq: 11, payload: {} }));
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "Done"))).toEqual(["Done"]);
  });
  it.each(["run.failed", "run.cancelled"])("ignores %s and stale later completion", (type) => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    observer.observe("scope", true, terminal({ type }));
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "Late"))).toEqual([]);
  });
  it.each([undefined, {}, { messageId: "" }, { messageId: 4 }])(
    "safely ignores old or invalid receipts: %j",
    (payload) => {
      const observer = new ReplyAnnouncements();
      observer.update("scope", true, snapshot());
      observer.observe("scope", true, terminal({ payload }));
      expect(observer.update("scope", true, snapshot(null, "Done"))).toEqual([]);
    },
  );
  it("does not treat Run disappearance or a completed-status snapshot as success", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    expect(
      observer.update("scope", true, {
        ...snapshot(null, "Done"),
        run: { id: "run-a", status: "completed" },
      }),
    ).toEqual([]);
  });
  it("suppresses immediate Stop and thread clear even before a late terminal receipt", () => {
    for (const clear of [false, true]) {
      const observer = new ReplyAnnouncements();
      observer.update("scope", true, snapshot());
      if (clear) observer.observe("scope", true, { type: "thread.cleared", threadId: "thread-a" });
      else observer.stop("scope", ["run-a"]);
      observer.observe("scope", true, terminal());
      expect(observer.update("scope", true, snapshot(null, "Late"))).toEqual([]);
    }
  });
  it("baselines history, replay, scope changes and hidden completion without reading it later", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot(null, "History"));
    observer.observe("scope", true, terminal({ seq: 10 }));
    expect(observer.update("scope", true, snapshot(null, "History"))).toEqual([]);
    observer.update("scope", true, snapshot());
    observer.update("scope", false, snapshot());
    observer.observe("scope", false, terminal());
    observer.update("scope", true, snapshot());
    observer.observe("scope", true, terminal());
    expect(observer.update("scope", true, snapshot(null, "Hidden"))).toEqual([]);
    observer.observe("scope", true, terminal());
    expect(observer.update("other", true, snapshot(null, "History"))).toEqual([]);
  });
  it("never reads tool/progress blocks, wrong identity, foreign scope or another thread", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot());
    observer.observe("foreign", true, terminal());
    observer.observe("scope", true, terminal({ threadId: "foreign" }));
    expect(observer.update("scope", true, snapshot(null, "No"))).toEqual([]);
    observer.observe("scope", true, terminal());
    const wrong = snapshot(null, "No");
    wrong.messages[0]!.runId = "foreign";
    expect(observer.update("scope", true, wrong)).toEqual([]);
    const tools = snapshot(null, "");
    tools.messages[0]!.blocks = [{ kind: "progress", text: "Tool", activity: true }];
    expect(observer.update("scope", true, tools)).toEqual([]);
    expect(observer.update("scope", true, snapshot(null, "Late update"))).toEqual([]);
  });
  it("handles simultaneous group Runs with independent Stop and exact final identities", () => {
    const observer = new ReplyAnnouncements();
    const group = { ...snapshot(), activeRuns: [{ id: "run-b", status: "running" }] };
    observer.update("scope", true, group);
    observer.stop("scope", ["run-a"]);
    observer.observe("scope", true, terminal());
    observer.observe("scope", true, terminal({ runId: "run-b", payload: { messageId: "second" } }));
    const result = snapshot(null, "Stopped");
    result.messages = [
      ...result.messages,
      {
        id: "second",
        role: "bot",
        runId: "run-b",
        blocks: [{ kind: "text", text: "Other reply" }],
      },
    ];
    expect(observer.update("scope", true, result)).toEqual(["Other reply"]);
  });
});
