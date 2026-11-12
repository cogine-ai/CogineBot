import { createHmac } from "node:crypto";
import type { SlackAdapter, SlackAdapterConfig } from "@chat-adapter/slack";
import { TelegramFormatConverter } from "@chat-adapter/telegram";
import { convertEmojiPlaceholders, markdownToPlainText } from "chat";
import { describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { LazyLarkAdapter } from "./lark/lazy-adapter.js";
import { Domain } from "./lark/thread-id.js";
import {
  enrichSlackTeamRoom,
  isMessagingEnabled,
  isMessagingSurfaceEnabled,
  type MessagingEnvironmentValues,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  parseSendblueStatus,
  splitOutboundBody,
} from "./messaging-platforms.js";

// Fake credentials: adapters are constructed offline, never called.
const fullEnv: MessagingEnvironmentValues = {
  sendblueApiKeyId: "sb-key-id",
  sendblueApiSecret: "sb-secret",
  sendblueSigningSecret: "sb-signing",
  sendbluePhoneNumber: "+15550009999",
  slackBotToken: "xoxb-fake",
  slackSigningSecret: "slack-signing",
  whatsappAccessToken: "wa-token",
  whatsappPhoneNumberId: "wa-phone-id",
  whatsappAppSecret: "wa-app-secret",
  whatsappVerifyToken: "wa-verify",
  telegramBotToken: "tg-token",
  telegramWebhookSecret: "tg-webhook-secret",
  larkAppId: "cli-fake",
  larkAppSecret: "lark-secret",
  larkVerificationToken: "lark-verify",
};

function providers(env: MessagingEnvironmentValues): string[] {
  return messagingPlatformsFromEnv(env).map((platform) => platform.provider);
}

describe("messagingPlatformsFromEnv", () => {
  it("checks workspace authorization when a queued SDK request reaches the transport", async () => {
    const fence = vi.fn(async (): Promise<void> => undefined);
    let entered!: () => void;
    let release!: () => void;
    const transportEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holdTransport = new Promise<void>((resolve) => {
      release = resolve;
    });
    type Transport = NonNullable<NonNullable<SlackAdapterConfig["webClientOptions"]>["adapter"]>;
    const transport = vi.fn<Transport>(async (config) => {
      if (config.url?.endsWith("/auth.test")) {
        entered();
        await holdTransport;
      }
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        request: { path: "/api/chat.postMessage" },
        data: { ok: true, ts: "123.4" },
      };
    });
    const [platform] = messagingPlatformsFromEnv(
      { slackBotToken: "fixture", slackSigningSecret: "fixture-signing" },
      {
        beforeSlackRequest: fence,
        slackTransport: { adapter: transport, maxRequestConcurrency: 1 },
      },
    );
    const slack = platform!.adapter as SlackAdapter;
    const lookup = slack.client.auth.test();
    await transportEntered;
    const stopped = expect(
      slack.client.chat.postMessage({ channel: "CFIXTURE", text: "Fixture" }),
    ).rejects.toThrow("Workspace paused");
    fence.mockRejectedValueOnce(new Error("Workspace paused"));
    release();
    await Promise.all([lookup, stopped]);
    expect(transport).toHaveBeenCalledOnce();
    await expect(
      slack.client.chat.postMessage({ channel: "CFIXTURE", text: "Fixture" }),
    ).resolves.toMatchObject({ ts: "123.4" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("mounts nothing without credentials and everything with full credentials", () => {
    expect(providers({})).toEqual([]);
    expect(providers(fullEnv)).toEqual(["sendblue", "slack", "whatsapp", "telegram", "lark"]);
  });

  it("requires all four sendblue values", () => {
    for (const key of [
      "sendblueApiKeyId",
      "sendblueApiSecret",
      "sendblueSigningSecret",
      "sendbluePhoneNumber",
    ] as const) {
      expect(providers({ ...fullEnv, [key]: undefined })).not.toContain("sendblue");
    }
  });

  it("requires each platform's full credential set", () => {
    expect(providers({ ...fullEnv, slackSigningSecret: undefined })).not.toContain("slack");
    expect(providers({ ...fullEnv, slackBotToken: undefined })).not.toContain("slack");
    for (const key of [
      "whatsappAccessToken",
      "whatsappPhoneNumberId",
      "whatsappAppSecret",
      "whatsappVerifyToken",
    ] as const) {
      expect(providers({ ...fullEnv, [key]: undefined })).not.toContain("whatsapp");
    }
    expect(providers({ ...fullEnv, telegramBotToken: undefined })).not.toContain("telegram");
    // Without the secret token the adapter would accept unsigned webhook
    // posts, so the secret is a mount gate, not optional hardening.
    expect(providers({ ...fullEnv, telegramWebhookSecret: undefined })).not.toContain("telegram");
    expect(providers({ telegramBotToken: "tg-token" })).toEqual([]);
    expect(
      providers({ telegramBotToken: "tg-token", telegramWebhookSecret: "tg-webhook-secret" }),
    ).toEqual(["telegram"]);
    expect(providers({ ...fullEnv, larkAppId: undefined })).not.toContain("lark");
    expect(providers({ ...fullEnv, larkAppSecret: undefined })).not.toContain("lark");
    // Without the verification token the adapter would accept unsigned
    // webhook posts, so the token is a mount gate, not optional hardening.
    expect(providers({ ...fullEnv, larkVerificationToken: undefined })).not.toContain("lark");
    expect(providers({ larkAppId: "cli-fake", larkAppSecret: "lark-secret" })).toEqual([]);
    expect(
      providers({
        larkAppId: "cli-fake",
        larkAppSecret: "lark-secret",
        larkVerificationToken: "lark-verify",
      }),
    ).toEqual(["lark"]);
  });

  it("forces Telegram into webhook mode so worker initialize cannot long-poll", () => {
    const telegram = messagingPlatformsFromEnv({
      telegramBotToken: "tg-token",
      telegramWebhookSecret: "tg-webhook-secret",
    })[0]!;
    // mode is protected on the adapter class but readable at runtime.
    expect((telegram.adapter as unknown as { mode: string }).mode).toBe("webhook");
  });

  it("forces Lark into webhook inbound so worker initialize cannot open a long connection", () => {
    const lark = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
    })[0]!;
    expect(lark.adapter).toBeInstanceOf(LazyLarkAdapter);
    expect((lark.adapter as LazyLarkAdapter).incomingConfig).toEqual({
      events: "webhook",
      callbacks: "webhook",
    });
  });

  it("maps LARK_* process env and accepts the international domain switch", () => {
    expect(
      messagingEnvFromProcess({
        LARK_APP_ID: " cli-fake ",
        LARK_APP_SECRET: " lark-secret ",
        LARK_VERIFICATION_TOKEN: " lark-verify ",
        LARK_ENCRYPT_KEY: " lark-encrypt ",
        LARK_DOMAIN: " Lark ",
      }),
    ).toMatchObject({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
      larkEncryptKey: "lark-encrypt",
      larkDomain: "Lark",
    });
    const international = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
      larkDomain: "Lark",
    })[0]!;
    expect((international.adapter as unknown as { config: { domain: Domain } }).config.domain).toBe(
      Domain.Lark,
    );
  });

  it.each(["", "unknown", "feishu"])("uses normalized Lark defaults for domain %s", (domain) => {
    vi.stubEnv("LARK_DOMAIN", domain);
    vi.stubEnv("LARK_ENCRYPT_KEY", "   ");
    try {
      const lark = messagingPlatformsFromEnv({
        ...messagingEnvFromProcess(process.env),
        larkAppId: "cli-fake",
        larkAppSecret: "lark-secret",
        larkVerificationToken: "lark-verify",
      }).find((platform) => platform.provider === "lark")!;
      const config = (
        lark.adapter as unknown as {
          config: { domain: Domain; encryptKey: string };
        }
      ).config;
      expect(config.domain).toBe(Domain.Feishu);
      expect(config.encryptKey).toBe("");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("declares group and typing support only for sendblue", () => {
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const capabilities = Object.fromEntries(
      platforms.map((platform) => [platform.provider, platform.capabilities]),
    );
    expect(capabilities.sendblue).toEqual({
      direct: true,
      groups: true,
      typing: true,
      receipt: "typing",
    });
    expect(capabilities.slack).toEqual({
      direct: true,
      groups: true,
      typing: false,
      receipt: "reaction",
    });
    expect(capabilities.whatsapp).toEqual({ direct: true, groups: false, typing: false });
    expect(capabilities.telegram).toEqual({
      direct: true,
      groups: false,
      typing: false,
      files: true,
    });
    expect(capabilities.lark).toEqual({ direct: true, groups: false, typing: false });
  });
});

describe("sendblue platform hooks", () => {
  const sendblue = messagingPlatformsFromEnv(fullEnv)[0]!;

  it("filters the deployment line and non-string entries out of the roster", () => {
    expect(
      sendblue.participants!({
        participants: ["+15551111111", "+15550009999", 42, null, "+15552222222"],
      }),
    ).toEqual(["+15551111111", "+15552222222"]);
    expect(sendblue.participants!({ participants: "not-a-list" })).toEqual([]);
    expect(sendblue.participants!(null)).toEqual([]);
  });

  it("reads the group display name only when present", () => {
    expect(sendblue.channelName!({ group_display_name: "Family" })).toBe("Family");
    expect(sendblue.channelName!({ group_display_name: "" })).toBeNull();
    expect(sendblue.channelName!({})).toBeNull();
    expect(sendblue.channelName!(null)).toBeNull();
  });

  it("accepts only supported per-message transports", () => {
    for (const service of ["iMessage", "SMS", "RCS"]) {
      expect(sendblue.transport!({ service })).toBe(service);
    }
    expect(sendblue.transport!({ service: "email" })).toBeNull();
    expect(sendblue.transport!({ service: 42 })).toBeNull();
    expect(sendblue.transport!(null)).toBeNull();
  });

  it("derives deterministic provider-prefixed direct thread ids", () => {
    expect(sendblue.directThreadId!("+15551234567")).toMatch(/^sendblue:/);
    expect(sendblue.adapter.isDM?.(sendblue.directThreadId!("+15551234567"))).toBe(true);
  });
});

describe("parseSendblueStatus", () => {
  const statusPayload = {
    content: "",
    is_outbound: true,
    status: "DELIVERED",
    message_handle: "handle-1",
    from_number: "+15550009999",
  };

  it("normalizes outbound delivery webhooks", () => {
    expect(parseSendblueStatus(statusPayload)).toEqual({
      type: "status",
      provider: "sendblue",
      handle: "handle-1",
      status: "DELIVERED",
    });
    expect(parseSendblueStatus({ ...statusPayload, status: 7 })).toEqual(
      expect.objectContaining({ status: "" }),
    );
  });

  it("ignores inbound and malformed payloads", () => {
    expect(parseSendblueStatus({ ...statusPayload, is_outbound: false })).toBeNull();
    expect(parseSendblueStatus({ ...statusPayload, message_handle: "" })).toBeNull();
    const { message_handle: _dropped, ...withoutHandle } = statusPayload;
    expect(parseSendblueStatus(withoutHandle)).toBeNull();
    expect(parseSendblueStatus(null)).toBeNull();
    expect(parseSendblueStatus("nope")).toBeNull();
  });
});

describe("isMessagingEnabled", () => {
  it("requires at least one platform", () => {
    vi.stubEnv("VITEST", "");
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(true);
    expect(isMessagingEnabled([])).toBe(false);
    vi.unstubAllEnvs();
  });

  it("is disabled under vitest even with platforms configured", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(false);
  });

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("isMessagingSurfaceEnabled", () => {
  it("requires a configured deployment model only for open signup", () => {
    vi.stubEnv("VITEST", "");
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const options = (deploymentModelConfigured: boolean, openSignup: boolean) => ({
      deploymentModelConfigured,
      openSignup,
    });
    // Open signup provisions users with no credentials of their own.
    expect(isMessagingSurfaceEnabled(platforms, options(true, true))).toBe(true);
    expect(isMessagingSurfaceEnabled(platforms, options(false, true))).toBe(false);
    // Linking-only deployments run linked users on their own credentials.
    expect(isMessagingSurfaceEnabled(platforms, options(false, false))).toBe(true);
    expect(isMessagingSurfaceEnabled([], options(true, true))).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("enrichSlackTeamRoom", () => {
  const base = {
    type: "message" as const,
    provider: "slack",
    handle: "Ev1",
    threadId: "slack:C1",
    isDirect: false,
    from: "U_OTHER",
    fromLabel: "Ada",
    channelName: "launch",
    participants: ["U_OTHER"],
    content: "hello <@U_SOMEONE>",
    mediaUrl: null,
  };

  it("marks app_mention events as mention", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: { type: "app_mention", channel: "C1", text: "<@U_BOT> ship it", user: "U_OTHER" },
      },
      base,
    );
    expect(enrichment.kind).toBe("mention");
    expect(enrichment.workspaceId).toBe("T1");
    expect(enrichment.conversationKey).toBe("C1");
  });

  it("keeps ambient when another user is mentioned, not the bot", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: {
          type: "message",
          channel: "C1",
          text: "hey <@U_SOMEONE> can you look?",
          user: "U_OTHER",
        },
      },
      base,
    );
    expect(enrichment.kind).toBe("ambient");
  });

  it("marks message events that mention the authorized bot as mention", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: {
          type: "message",
          channel: "C1",
          text: "hey <@U_BOT> ship Friday?",
          user: "U_OTHER",
        },
      },
      base,
    );
    expect(enrichment.kind).toBe("mention");
  });
});

describe("provider delivery limits and authenticated receipts", () => {
  it("keeps both Telegram encodings bounded without splitting surrogate pairs", () => {
    const converter = new TelegramFormatConverter();
    const body = `**Summary**\n\n${"😀".repeat(2050)}\n\n${"a_b[c]!".repeat(800)}`;
    const parts = splitOutboundBody("telegram", body);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      const plain = markdownToPlainText(part);
      expect(
        convertEmojiPlaceholders(converter.fromMarkdown(part), "gchat").length,
      ).toBeLessThanOrEqual(4096);
      expect(
        convertEmojiPlaceholders(plain.trim() ? plain : part, "gchat").length,
      ).toBeLessThanOrEqual(4096);
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(parts.join("").match(/😀/g)).toHaveLength(2050);
  });

  it("retries a structured WhatsApp rate rejection with its response delay", async () => {
    const [platform] = messagingPlatformsFromEnv({
      whatsappAccessToken: "fixture-token",
      whatsappPhoneNumberId: "number-one",
      whatsappAppSecret: "fixture-signing-secret",
      whatsappVerifyToken: "fixture-verify",
    });
    const surface = new ChatSdkMessagingSurface([platform!]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options?: RequestInit) =>
        options?.method === "POST"
          ? Response.json(
              { error: { code: 130429, message: "Fixture rate limit" } },
              {
                status: 400,
                headers: { "Retry-After": "37" },
              },
            )
          : Response.json({ verified_name: "Fixture" }),
      ),
    );
    try {
      await expect(
        surface.sendToThread(
          {
            threadId: "whatsapp:number-one:fixture-contact",
            body: "Reply",
          },
          {
            operationId: "fixture",
            traceId: "fixture",
            spaceId: "fixture",
            userId: "fixture",
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toMatchObject({
        disposition: "retryable",
        reason: "rate_limited",
        retryAfterMs: 37_000,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies only signed WhatsApp statuses addressed to the configured number", async () => {
    const [platform] = messagingPlatformsFromEnv({
      whatsappAccessToken: "fixture-token",
      whatsappPhoneNumberId: "number-one",
      whatsappAppSecret: "fixture-signing-secret",
      whatsappVerifyToken: "fixture-verify",
    });
    const surface = new ChatSdkMessagingSurface([platform!]);
    const sink = vi.fn(async () => undefined);
    surface.onInbound(sink);
    const payload = JSON.stringify({
      entry: [
        {
          changes: ["number-one", "number-two"].map((number) => ({
            field: "messages",
            value: {
              metadata: { phone_number_id: number },
              statuses: [{ id: `fixture-${number}`, status: "failed", errors: [{ code: 131047 }] }],
            },
          })),
        },
      ],
    });
    const signature = createHmac("sha256", "fixture-signing-secret").update(payload).digest("hex");
    const post = (sign: string) =>
      surface.handleWebhook(
        "whatsapp",
        new Request("https://example.test/webhook", {
          method: "POST",
          body: payload,
          headers: { "x-hub-signature-256": sign },
        }),
      );
    expect((await post("sha256=invalid"))?.status).toBe(401);
    expect(sink).not.toHaveBeenCalled();
    expect((await post(`sha256=${signature}`))?.status).toBe(200);
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      type: "status",
      provider: "whatsapp",
      handle: "fixture-number-one",
      status: "FAILED",
      reason: "reply_window_closed",
    });
  });
});
