import { describe, expect, it } from "vitest";
import {
  isAgedStuckWork,
  isStuckWorkStatus,
  STUCK_WORK_EXPIRE_AFTER_MS,
  STUCK_WORK_NOTIFY_AFTER_MS,
  stuckWorkAction,
  stuckWorkDueAfterMs,
  stuckWorkReminder,
  stuckWorkStatusMessage,
  stuckWorkStatusMessages,
  stuckWorkStoppedNotification,
} from "./stuck-work.js";

describe("stuck work age", () => {
  it.each([false, true])(
    "cancels an unattended takeover at thirty minutes (notified=%s)",
    (alreadyNotified) => {
      const action = (ageMs: number) =>
        stuckWorkAction({ status: "waiting_takeover", ageMs, alreadyNotified });
      expect(stuckWorkDueAfterMs("waiting_takeover")).toBe(30 * 60 * 1000);
      expect(action(30 * 60 * 1000 - 1)).toBe("none");
      expect(action(30 * 60 * 1000)).toBe("expire");
    },
  );

  it.each(["queued", "waiting_input"] as const)(
    "keeps the four-hour reminder and day-long expiry for %s",
    (status) => {
      const action = (ageMs: number, alreadyNotified: boolean) =>
        stuckWorkAction({ status, ageMs, alreadyNotified });
      expect(stuckWorkDueAfterMs(status)).toBe(STUCK_WORK_NOTIFY_AFTER_MS);
      expect(action(30 * 60 * 1000, false)).toBe("none");
      expect(action(STUCK_WORK_NOTIFY_AFTER_MS - 1, false)).toBe("none");
      expect(action(STUCK_WORK_NOTIFY_AFTER_MS, false)).toBe("notify");
      expect(action(STUCK_WORK_NOTIFY_AFTER_MS, true)).toBe("none");
      expect(action(STUCK_WORK_EXPIRE_AFTER_MS - 1, true)).toBe("none");
      expect(action(STUCK_WORK_EXPIRE_AFTER_MS, true)).toBe("expire");
      expect(action(STUCK_WORK_EXPIRE_AFTER_MS, false)).toBe("expire");
    },
  );

  it("treats only queued and human waits as stuck", () => {
    expect(isStuckWorkStatus("queued")).toBe(true);
    expect(isStuckWorkStatus("waiting_takeover")).toBe(true);
    expect(isStuckWorkStatus("running")).toBe(false);
    expect(isAgedStuckWork("queued", new Date(Date.now() - STUCK_WORK_NOTIFY_AFTER_MS))).toBe(true);
    expect(isAgedStuckWork("running", new Date(0))).toBe(false);
    expect(isAgedStuckWork("queued", "not-a-date")).toBe(false);
  });

  it("uses a distinct status line and a matching stopped notice", () => {
    const messages = STUCK_WORK_STATUSES_FOR_TEST();
    expect(new Set(messages).size).toBe(messages.length);
    expect(stuckWorkStatusMessage("waiting_takeover")).toMatch(/screen/);
    expect(stuckWorkStoppedNotification("waiting_input", "  ")).toEqual({
      kind: "failure",
      title: "Bot stopped",
      body: stuckWorkStatusMessage("waiting_input"),
    });
    expect(stuckWorkReminder("waiting_takeover", "Ada")).toMatchObject({
      kind: "takeover",
      title: "Ada still needs you",
    });
    expect(stuckWorkReminder("queued", "Ada").kind).toBe("help");
  });
});

function STUCK_WORK_STATUSES_FOR_TEST(): string[] {
  return [...stuckWorkStatusMessages()];
}
