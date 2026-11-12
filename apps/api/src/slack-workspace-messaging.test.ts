import type { MessagingInboundEvent, MessagingSurface } from "@rakazo/adapter-kit";
import type {
  MessagingInstallations,
  SlackInstallProvider,
  WorkspaceInstallation,
} from "@rakazo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlackWorkspaceMessaging } from "./slack-workspace-messaging.js";

const { receive } = vi.hoisted(() => ({ receive: vi.fn() }));
vi.mock("./team-chat-bridge.js", () => ({
  TeamChatBridge: class {
    receive = receive;
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
  },
}));

const request = new Request("https://app.example.test/events", { method: "POST" });
const row = {
  id: "install-A",
  revision: 1,
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  workspaceId: "TFIXTURE",
  installerId: "UOWNER",
  providerBotId: "UBOT",
  ciphertext: "sealed",
  acceptAfter: new Date("2026-01-01T00:00:00Z"),
} as WorkspaceInstallation;
const message = {
  type: "message",
  provider: "slack",
  workspaceId: row.workspaceId,
  handle: "fixture",
  from: row.installerId,
  fromLabel: "Owner",
  threadId: "slack:D1:1",
  isDirect: true,
  channelName: null,
  participants: [],
  content: "Hello",
  mediaUrl: null,
} as const;

function harness() {
  let sink: (event: MessagingInboundEvent) => Promise<void>;
  let inbound = { ...message, participants: [] } as MessagingInboundEvent;
  let active: WorkspaceInstallation | null = row;
  const sendToThread = vi.fn();
  const surface = {
    onInbound: (handler: typeof sink) => {
      sink = handler;
    },
    handleWebhook: async () => {
      await sink(inbound);
      return new Response(null, { status: 200 });
    },
    sendToThread,
  } as unknown as MessagingSurface;
  const verified = { request, workspaceId: row.workspaceId, eventAt: new Date("2026-01-02") };
  const provider = {
    parseWebhook: vi.fn(async () => verified),
    surface: vi.fn(() => surface),
  };
  const store = {
    activeByWorkspace: vi.fn(async () => active),
    activeById: vi.fn(async () => active),
    credential: vi.fn(async () => "fixture-credential"),
    revoke: vi.fn(async () => undefined),
  };
  const runtime = new SlackWorkspaceMessaging(
    store as unknown as MessagingInstallations,
    provider as unknown as SlackInstallProvider,
    {} as ConstructorParameters<typeof SlackWorkspaceMessaging>[2],
  );
  return {
    runtime,
    provider,
    store,
    verified,
    setActive: (value: typeof active) => {
      active = value;
    },
    setInbound: (value: typeof inbound) => {
      inbound = value;
    },
  };
}

beforeEach(() => receive.mockReset());

describe("Slack installed workspace routing", () => {
  it("accepts a signed installer DM and refuses strangers, other workspaces, and app messages", async () => {
    const { runtime, provider, setInbound } = harness();
    for (const candidate of [
      { ...message, from: "UOTHER", participants: [] },
      { ...message, workspaceId: "TOTHER", participants: [] },
      { ...message, senderIsBot: true, participants: [] },
      { ...message, isDirect: false, kind: "ambient" as const, participants: [] },
    ]) {
      setInbound(candidate);
      await runtime.webhook(request);
    }
    expect(receive).not.toHaveBeenCalled();
    setInbound({ ...message, participants: [] });
    await runtime.webhook(request);
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "UOWNER", kind: "direct" }),
      expect.anything(),
    );
    expect(provider.surface).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("does not start old or paused work and passes verified removal to the durable store", async () => {
    const { runtime, provider, store, verified, setActive } = harness();
    provider.parseWebhook.mockResolvedValueOnce({ ...verified, eventAt: row.acceptAfter });
    await runtime.webhook(request);
    setActive(null);
    await runtime.webhook(request);
    expect(provider.surface).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    provider.parseWebhook.mockResolvedValueOnce({
      ...verified,
      uninstalled: true,
    } as typeof verified);
    await runtime.webhook(request);
    expect(store.revoke).toHaveBeenCalledWith(row.workspaceId, verified.eventAt, undefined);
    provider.parseWebhook.mockRejectedValueOnce(new Error("bad signature"));
    expect((await runtime.webhook(request)).status).toBe(401);
    await runtime.stop();
  });
});
