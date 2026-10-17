import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "../../background-job-handlers.js";
import { NativeActionError } from "../action.js";
import { nativeSourceJob, nativeSourceRetry } from "./worker.js";

const U = "11111111-1111-4111-8111-111111111111";
const payload = {
  triggerId: "trigger-a",
  triggerVersion: 2,
  hookId: "synthetic-hook",
  hookRevision: 4,
  signal: {
    id: U,
    timestamp: "2026-10-18T00:00:00Z",
    workspaceId: U,
    integrationId: U,
    subscriptionId: U,
    type: "page.content_updated" as const,
    entity: { id: U, type: "page" as const },
  },
};
function fixture() {
  const poll = vi.fn(async () => undefined),
    notionSignal = vi.fn(async () => undefined),
    continueRun = vi.fn(),
    wakeRoutine = vi.fn();
  const handlers = createBackgroundJobHandlers({
    nativeEvents: { poll, notionSignal },
    executor: { continueRun, wakeRoutine },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  return { handlers, poll, notionSignal, continueRun, wakeRoutine };
}
describe("native events use existing job dispatch", () => {
  it("dispatches source ID/version and signed delivery to their exact native handlers", async () => {
    const f = fixture(),
      job = nativeSourceJob("trigger-a", 2, new Date("2026-10-18T01:00:00Z"));
    await dispatchBackgroundJob(f.handlers, job.name, job.payload);
    await dispatchBackgroundJob(f.handlers, "native.notion.signal", payload);
    expect(f.poll).toHaveBeenCalledWith(
      { triggerId: "trigger-a", triggerVersion: 2 },
      expect.any(AbortSignal),
    );
    expect(f.notionSignal).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
    expect(f.continueRun).not.toHaveBeenCalled();
    expect(f.wakeRoutine).not.toHaveBeenCalled();
    expect(job.availableAt.toISOString()).toBe("2026-10-18T01:00:00.000Z");
  });
  it("rejects caller actor/source override and arbitrary signed payload data before handlers", async () => {
    const f = fixture();
    await expect(
      dispatchBackgroundJob(f.handlers, "native.source.poll", {
        triggerId: "trigger-a",
        triggerVersion: 2,
        userId: "other-owner",
        connectionId: "sibling",
      }),
    ).rejects.toThrow();
    await expect(
      dispatchBackgroundJob(f.handlers, "native.notion.signal", {
        ...payload,
        signal: { ...payload.signal, body: "untrusted extra" },
      }),
    ).rejects.toThrow();
    expect(f.poll).not.toHaveBeenCalled();
    expect(f.notionSignal).not.toHaveBeenCalled();
  });
  it("a missing configured native consumer fails rather than acknowledging and dropping its durable job", async () => {
    const handlers = createBackgroundJobHandlers(
      {} as Parameters<typeof createBackgroundJobHandlers>[0],
    );
    await expect(
      dispatchBackgroundJob(handlers, "native.source.poll", { triggerId: "a", triggerVersion: 1 }),
    ).rejects.toThrow("Native event processing is unavailable");
  });
  it("retry cooldown preserves the old cursor and honors the service retry interval without retaining raw errors", () => {
    const now = new Date("2026-10-18T00:00:00Z"),
      old = { ready: true, syncToken: "old-cursor" },
      retry = nativeSourceRetry(
        old,
        new NativeActionError("rate_limited", "synthetic-private-body", { retryAfterSeconds: 120 }),
        now,
      );
    expect(retry.state.syncToken).toBe("old-cursor");
    expect(retry.nextPollAt.toISOString()).toBe("2026-10-18T00:02:00.000Z");
    expect(JSON.stringify(retry.state)).not.toContain("synthetic-private-body");
    expect(old).toEqual({ ready: true, syncToken: "old-cursor" });
  });
});
