import type { Bot, ExternalConversationPolicy, MessagingStatus } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingSettingsApi } from "./messaging-settings.js";
import { createMessagingSettings } from "./messaging-settings.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let current = true;
  const status: MessagingStatus = {
    enabled: true,
    providers: ["synthetic"],
    openSignup: false,
    identities: [],
  };
  const api = {
    status: vi.fn(async () => status),
    channels: vi.fn(async () => []),
    connections: vi.fn(async () => []),
    bots: vi.fn(async () => [{ id: "bot-a" }, { id: "bot-b" }] as Bot[]),
    conversations: vi.fn(async () => []),
    link: vi.fn(async () => ({
      code: "FAKE-CODE",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    })),
    mutate: vi.fn(async () => ({})),
  } satisfies MessagingSettingsApi;
  const session = createMessagingSettings(api, () => current);
  return {
    api,
    session,
    status,
    invalidate: () => {
      current = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("messaging settings session", () => {
  it("discards late loads after scope change and disposal", async () => {
    const { api, session, invalidate } = setup();
    const pending = deferred<MessagingStatus>();
    api.status.mockReturnValueOnce(pending.promise);
    const refresh = session.refresh();
    invalidate();
    session.dispose();
    pending.resolve({ enabled: false, providers: [], openSignup: false, identities: [] });
    await refresh;
    expect(session.getSnapshot().data).toBeNull();
    await session.mutate("messaging/identities/unlink", { identityId: "old" });
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it("recovers a failed initial load without stale data", async () => {
    const { api, session } = setup();
    api.status.mockRejectedValueOnce(new Error("offline"));
    await session.refresh();
    expect(session.getSnapshot().error).toBe("load");
    await session.refresh();
    expect(session.getSnapshot().data?.bots).toHaveLength(2);
    expect(session.getSnapshot().error).toBeNull();
    session.dispose();
  });
  it("invalidates an issued code when the selection changes during issuance", async () => {
    const { api, session } = setup();
    await session.refresh();
    session.selectBot("bot-a");
    const pending = deferred<{ code: string; expiresAt: string }>();
    api.link.mockReturnValueOnce(pending.promise);
    const start = session.startLink();
    session.selectBot("bot-b");
    pending.resolve({ code: "OLD-CODE", expiresAt: new Date(Date.now() + 10_000).toISOString() });
    await start;
    expect(session.getSnapshot()).toMatchObject({ botId: "bot-b", link: null, busy: false });
    session.dispose();
  });
  it("expires a displayed code even while a poll is stuck", async () => {
    vi.useFakeTimers();
    const { api, session } = setup();
    await session.refresh();
    session.selectBot("bot-a");
    await session.startLink();
    const pending = deferred<MessagingStatus>();
    api.status.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(7000);
    expect(session.getSnapshot()).toMatchObject({ link: null, error: "expired" });
    pending.resolve({
      enabled: true,
      providers: [],
      openSignup: false,
      identities: [
        { id: "late", botId: "bot-a", botName: "A", provider: "synthetic", address: "fake" },
      ],
    });
    await Promise.resolve();
    expect(session.getSnapshot().data?.status.identities).toEqual([]);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("recovers polling and reads back only a new identity for the selected bot", async () => {
    vi.useFakeTimers();
    const { api, session, status } = setup();
    await session.refresh();
    session.selectBot("bot-a");
    await session.startLink();
    api.status.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(session.getSnapshot().error).toBe("poll");
    status.identities.push({
      id: "wrong",
      botId: "bot-b",
      botName: "B",
      provider: "synthetic",
      address: "fake-b",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(session.getSnapshot().link).not.toBeNull();
    status.identities.push({
      id: "right",
      botId: "bot-a",
      botName: "A",
      provider: "synthetic",
      address: "fake-a",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(session.getSnapshot().link).toBeNull();
    expect(session.getSnapshot().data?.status.identities).toHaveLength(2);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes a rejected invitation without replaying the decision", async () => {
    const { api, session } = setup();
    await session.refresh();
    api.mutate.mockRejectedValueOnce(new Error("NOT_FOUND"));
    const input = { connectionId: "connection-a", requestVersion: 2, accept: true };
    expect(await session.mutate("messaging/connections/respond", input)).toBe(false);
    expect(api.mutate).toHaveBeenCalledExactlyOnceWith("messaging/connections/respond", input);
    expect(api.connections).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toMatchObject({ error: "update", busy: false });
    session.dispose();
  });
  it.each([null, false, true])(
    "preserves listening %s and guidance null versus empty on the addressed conversation",
    async (listening) => {
      const { api, session } = setup();
      await session.refresh();
      for (const rules of [null, "", "Synthetic guidance"]) {
        const policy: ExternalConversationPolicy = {
          teamChatAmbientEnabled: listening,
          teamChatRules: rules,
          automatedSenderPolicies: {
            synthetic: { name: "Synthetic", mode: "rollup", rollupHours: 720 },
          },
        };
        expect(await session.savePolicy("conversation-a", policy)).toBe(true);
        expect(api.mutate).toHaveBeenLastCalledWith("externalConversations/updatePolicy", {
          externalConversationId: "conversation-a",
          ...policy,
        });
      }
      session.dispose();
    },
  );
  it("locks concurrent mutations and discards late mutation completion", async () => {
    const { api, session, invalidate } = setup();
    await session.refresh();
    const pending = deferred<object>();
    api.mutate.mockReturnValueOnce(pending.promise);
    const first = session.mutate("messaging/channels/leave", { membershipId: "a" });
    expect(
      await session.mutate("messaging/channels/respond", { membershipId: "b", accept: true }),
    ).toBe(false);
    invalidate();
    pending.resolve({});
    expect(await first).toBe(false);
    expect(api.status).toHaveBeenCalledTimes(1);
    session.dispose();
  });
});
