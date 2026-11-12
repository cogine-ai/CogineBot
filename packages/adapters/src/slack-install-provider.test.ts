import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SLACK_INSTALL_SCOPES, SlackInstallProvider } from "./slack-install-provider.js";

const config = {
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
  signingSecret: "fixture-signing-secret",
  redirectUri: "https://app.example.test/api/v1/messaging/install/slack/callback",
};
const access = {
  ok: true,
  token_type: "bot",
  access_token: "synthetic-bot-token",
  scope: SLACK_INSTALL_SCOPES.join(","),
  team: { id: "TFIXTURE", name: "Fixture Workspace" },
  authed_user: { id: "UFIXTURE" },
  bot_user_id: "UBOTFIXTURE",
};

function request(payload: unknown, age = 0, signingSecret = config.signingSecret) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000) - age;
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Request("https://app.example.test/api/v1/messaging/install/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
  });
}

describe("Slack workspace OAuth and event verification", () => {
  it("uses the configured callback and returns the verified workspace and bot identity", async () => {
    const fetcher = vi.fn(async (url: string | URL, _options: RequestInit) =>
      String(url).includes("/users.info")
        ? Response.json({ user: { profile: { display_name: "Fixture Installer" } } })
        : Response.json(access),
    );
    const provider = new SlackInstallProvider(config, fetcher as typeof fetch);
    const url = new URL(provider.authorizeUrl("fixture-state"));
    expect(url.origin).toBe("https://slack.com");
    expect(url.searchParams.get("state")).toBe("fixture-state");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    await expect(provider.exchange("fixture-code")).resolves.toEqual({
      workspaceId: "TFIXTURE",
      workspaceName: "Fixture Workspace",
      installerId: "UFIXTURE",
      installerName: "Fixture Installer",
      providerBotId: "UBOTFIXTURE",
      credential: "synthetic-bot-token",
    });
    const [destination, options] = fetcher.mock.calls[0]!;
    expect(destination).toBe("https://slack.com/api/oauth.v2.access");
    expect(options.redirect).toBe("error");
    expect((options.body as URLSearchParams).get("redirect_uri")).toBe(config.redirectUri);
  });

  it.each([
    { is_enterprise_install: true },
    { refresh_token: "synthetic-refresh" },
    { token_type: "user" },
    { scope: "chat:write" },
    { authed_user: null },
  ])("refuses unsupported or incomplete grants %o", async (extra) => {
    const provider = new SlackInstallProvider(config, async () =>
      Response.json({ ...access, ...extra }),
    );
    await expect(provider.exchange("fixture-code")).rejects.toThrow(
      "Slack workspace authorization failed",
    );
  });

  it("requires a recent valid signature for challenges and events", async () => {
    const provider = new SlackInstallProvider(config);
    const challenge = { type: "url_verification", challenge: "fixture" };
    await expect(provider.parseWebhook(request(challenge))).resolves.toMatchObject({
      challenge: "fixture",
    });
    await expect(provider.parseWebhook(request(challenge, 301))).rejects.toThrow("Invalid webhook");
    await expect(provider.parseWebhook(request(challenge, 0, "incorrect"))).rejects.toThrow(
      "Invalid webhook",
    );
    const eventTime = Math.floor(Date.now() / 1000);
    const event = await provider.parseWebhook(
      request({
        type: "event_callback",
        team_id: "TFIXTURE",
        event_time: eventTime,
        event: { type: "tokens_revoked", tokens: { bot: ["UBOTFIXTURE"], oauth: ["UFIXTURE"] } },
      }),
    );
    expect(event).toMatchObject({
      workspaceId: "TFIXTURE",
      eventAt: new Date(eventTime * 1000),
      revokedBots: ["UBOTFIXTURE"],
      preciseEventTime: false,
      uninstalled: false,
    });
  });
  it("preserves signed fractional event time for a newly authorized workspace", async () => {
    const provider = new SlackInstallProvider(config);
    const time = Math.floor(Date.now() / 1000) - 1;
    const verified = await provider.parseWebhook(
      request({
        type: "event_callback",
        team_id: "TFIXTURE",
        event_time: time,
        event: { type: "message", event_ts: `${time}.987000` },
      }),
    );
    expect(verified).toMatchObject({
      eventAt: new Date(time * 1000 + 987),
      preciseEventTime: true,
    });
  });
});
