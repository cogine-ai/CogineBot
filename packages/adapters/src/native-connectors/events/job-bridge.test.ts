import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import { currentDbContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "../../background-job-handlers.js";
import { NativeActionError } from "../action.js";
import { nativeSourceJob, nativeSourceRetry } from "./worker.js";

const U = "11111111-1111-4111-8111-111111111111";
const owner = { userId: "user-stored", spaceId: "space-stored" };
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
    slackSignal = vi.fn(async () => undefined),
    slackLifecycle = vi.fn(async () => undefined),
    discordSignal = vi.fn(async () => undefined),
    continueRun = vi.fn(),
    wakeRoutine = vi.fn();
  const handlers = createBackgroundJobHandlers({
    prisma: { $queryRaw: vi.fn(async () => [owner]) },
    nativeEvents: { poll, notionSignal, slackSignal, slackLifecycle, discordSignal },
    executor: { continueRun, wakeRoutine },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  return {
    handlers,
    poll,
    notionSignal,
    slackSignal,
    slackLifecycle,
    discordSignal,
    continueRun,
    wakeRoutine,
  };
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
  it("routes signed Slack inbox jobs without creating chat or wake actions", async () => {
    const f = fixture(),
      metadata = { inboxId: "inbox-a", hookId: "hook-a", hookRevision: 1 };
    await dispatchBackgroundJob(f.handlers, "native.slack.signal", {
      ...metadata,
      triggerId: "trigger-a",
      triggerVersion: 1,
    });
    await dispatchBackgroundJob(f.handlers, "native.slack.lifecycle", metadata);
    expect(f.slackSignal).toHaveBeenCalledWith(
      { ...metadata, triggerId: "trigger-a", triggerVersion: 1 },
      expect.any(AbortSignal),
    );
    expect(f.slackLifecycle).toHaveBeenCalledWith(metadata);
    await expect(
      dispatchBackgroundJob(f.handlers, "native.slack.lifecycle", {
        ...metadata,
        userId: "other-owner",
      }),
    ).rejects.toThrow();
    expect(f.wakeRoutine).not.toHaveBeenCalled();
    expect(f.continueRun).not.toHaveBeenCalled();
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
    const handlers = createBackgroundJobHandlers({
      prisma: { $queryRaw: vi.fn(async () => [owner]) },
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
    await expect(
      dispatchBackgroundJob(handlers, "native.source.poll", { triggerId: "a", triggerVersion: 1 }),
    ).rejects.toThrow("Native event processing is unavailable");
  });
  it("requires Discord payload identity to match its persisted trigger owner", async () => {
    const f = fixture();
    const observed: unknown[] = [];
    f.discordSignal.mockImplementation(async () => {
      observed.push(currentDbContext());
    });
    const job = {
      triggerId: "trigger-a",
      triggerVersion: 1,
      ...owner,
      configId: "config-a",
      configRevision: 1,
      connectionId: "connection-a",
      authorizationRevision: "1",
      grantId: "grant-a",
      authGeneration: 1,
      interaction: {
        id: "123456",
        applicationId: "123456",
        guildId: "123456",
        channelId: "123456",
        commandId: "123456",
        commandName: "check",
        userId: "123456",
        options: [],
      },
    };
    await dispatchBackgroundJob(f.handlers, "native.discord.signal", {
      ...job,
      userId: "forged-user",
    });
    await dispatchBackgroundJob(f.handlers, "native.discord.signal", {
      ...job,
      spaceId: "forged-space",
    });
    expect(f.discordSignal).not.toHaveBeenCalled();
    await dispatchBackgroundJob(f.handlers, "native.discord.signal", job);
    expect(f.discordSignal).toHaveBeenCalledOnce();
    expect(observed).toEqual([{ kind: "tenant", ...owner }]);
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
