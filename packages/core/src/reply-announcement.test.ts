import { describe, expect, it } from "vitest";
import type { AnnouncementSnapshot } from "./reply-announcement.js";
import { ReplyAnnouncements } from "./reply-announcement.js";

function snapshot(status: string, text = "Done.", runId = "run-a"): AnnouncementSnapshot {
  return {
    threadId: "thread-a",
    run: { id: runId, status },
    messages: [{ id: `result-${runId}`, role: "bot", runId, blocks: [{ kind: "text", text }] }],
  };
}

describe("visible Run reply announcements", () => {
  it("skips initial history and announces each new completed result exactly once", () => {
    const observer = new ReplyAnnouncements();
    expect(observer.update("scope", true, snapshot("completed"))).toEqual([]);
    observer.update("scope", true, snapshot("running", "Partial.", "run-b"));
    expect(
      observer.update("scope", true, snapshot("completed", "最终\nresult 👩‍👩‍👧‍👦", "run-b")),
    ).toEqual(["最终\nresult 👩‍👩‍👧‍👦"]);
    expect(
      observer.update("scope", true, snapshot("completed", "最终\nresult 👩‍👩‍👧‍👦", "run-b")),
    ).toEqual([]);
  });
  it.each(["failed", "cancelled"])(
    "does not read %s results or later stale completed events",
    (terminal) => {
      const observer = new ReplyAnnouncements();
      observer.update("scope", true, snapshot("running"));
      expect(observer.update("scope", true, snapshot(terminal))).toEqual([]);
      expect(observer.update("scope", true, snapshot("completed", "Late."))).toEqual([]);
    },
  );
  it("suppresses Stop immediately, before its RPC or terminal event arrives", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot("running"));
    observer.stop("scope", ["run-a"]);
    expect(observer.update("scope", true, snapshot("completed", "Late."))).toEqual([]);
    observer.update("scope", true, snapshot("running", "", "next"));
    expect(observer.update("scope", true, snapshot("completed", "New.", "next"))).toEqual(["New."]);
  });
  it("baselines background and scope transitions without replaying old results", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot("running"));
    observer.update("scope", false, snapshot("running"));
    expect(observer.update("scope", true, snapshot("completed"))).toEqual([]);
    expect(observer.update("other-scope", true, snapshot("completed"))).toEqual([]);
  });
  it("ignores tools/progress, foreign Runs and history while retaining all final message text", () => {
    const observer = new ReplyAnnouncements();
    observer.update("scope", true, snapshot("running"));
    const value = snapshot("completed");
    value.messages = [
      ...value.messages,
      { id: "progress:r", role: "bot", runId: "run-a", blocks: [{ kind: "text", text: "Live" }] },
      { id: "foreign", role: "bot", runId: "other", blocks: [{ kind: "text", text: "Foreign" }] },
      {
        id: "tool",
        role: "bot",
        runId: "run-a",
        blocks: [{ kind: "progress", text: "Tool", activity: true }],
      },
    ];
    expect(observer.update("scope", true, value)).toEqual(["Done."]);
  });
  it("handles simultaneous group Runs with independent Stop and duplicate guards", () => {
    const observer = new ReplyAnnouncements();
    const group = { ...snapshot("running"), activeRuns: [{ id: "run-b", status: "running" }] };
    observer.update("scope", true, group);
    observer.stop("scope", ["run-a"]);
    const result = {
      ...snapshot("completed"),
      activeRuns: [{ id: "run-b", status: "completed" }],
      messages: [
        ...snapshot("completed").messages,
        ...snapshot("completed", "Other reply", "run-b").messages,
      ],
    };
    expect(observer.update("scope", true, result)).toEqual(["Other reply"]);
  });
});
