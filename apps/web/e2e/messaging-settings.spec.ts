import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test.afterEach(async ({ page }) => {
  // Polling can leave a route.fetch response in use when the assertions finish.
  await page.unrouteAll({ behavior: "wait" });
});

/**
 * The messaging surface is env-gated off in E2E (no platform credentials),
 * so the surface RPCs are fulfilled with fixture data. The screen itself —
 * navigation from account settings, layout, and both action lists — renders
 * exactly as it would against a live deployment.
 */
test("Korean messaging settings show linked chat apps, channels, and connections", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          providers: ["sendblue", "slack", "whatsapp", "telegram", "lark"],
          openSignup: false,
          identities: [
            {
              id: "mi-1",
              provider: "sendblue",
              address: "+15551230001",
              botId: "bot-1",
              botName: "Chief",
            },
          ],
        },
      }),
    }),
  );
  await page.route("**/rpc/messaging/link/start", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: { code: "ABCD-2345", expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }),
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "cm1",
            channelId: "ch1",
            identityId: "mi-1",
            provider: "sendblue",
            name: "Family",
            status: "invited",
            memberCount: 3,
          },
        ],
      }),
    }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "cn1",
            peerBotName: "Assistant",
            peerOwnerLabel: "Dana",
            status: "pending",
            incoming: true,
            requestVersion: 1,
          },
        ],
      }),
    }),
  );

  const stamp = Date.now();
  const userName = `Messenger ${stamp}`;
  await signup(page, `messaging-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("ui-locale-select").click();
  await settings.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "메시징", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "메시징 설정 관리" }).click();

  await expect(page.getByTestId("messaging-settings")).toBeVisible();
  await expect(page.getByText("iMessage · Slack · WhatsApp · Telegram · Feishu")).toBeVisible();
  await expect(page.getByText("iMessage · +15551230001")).toBeVisible();
  await expect(page.getByText("→ Chief")).toBeVisible();
  await expect(page.getByRole("button", { name: "연결 해제" })).toBeVisible();
  await expect(page.getByText("Family")).toBeVisible();
  await expect(page.getByText("Dana's Assistant")).toBeVisible();
  await expect(page.getByRole("button", { name: "승인" })).toHaveCount(2);

  // Linking flow: pick a bot, request a code, read it back.
  await page.getByLabel("연결할 Bot").selectOption({ index: 1 });
  await page.getByRole("button", { name: "채팅 앱 연결" }).click();
  await expect(page.getByTestId("messaging-link-code")).toContainText(
    "채팅 앱에서 연결할 회선으로 ABCD-2345를 보내세요.",
  );
  await captureScreenshot(page, testInfo, "messaging-settings-ko");

  await page.getByRole("button", { name: "메시징 설정 닫기" }).click();
  await expect(page.getByTestId("messaging-settings")).toHaveCount(0);
});

test("a reopened connection requires a fresh decision in settings", async ({ page }, testInfo) => {
  const connectionId = "cn-versioned";
  let requestVersion = 1;
  let status: "pending" | "approved" | "declined" = "pending";
  const connection = () => ({
    id: connectionId,
    peerBotName: requestVersion === 1 ? "Original helper" : "Current helper",
    peerOwnerLabel: "Dana",
    status,
    incoming: true,
    requestVersion,
  });
  const decisions: Array<{ connectionId: string; requestVersion: number; accept: boolean }> = [];
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      json: { json: { enabled: true, providers: ["slack"], openSignup: false, identities: [] } },
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({ json: { json: [] } }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({ json: { json: [connection()] } }),
  );
  await page.route("**/rpc/messaging/connections/respond", (route) => {
    const { json: decision } = route.request().postDataJSON() as {
      json: (typeof decisions)[number];
    };
    decisions.push(decision);
    if (decision.connectionId !== connectionId || decision.requestVersion !== requestVersion) {
      return route.fulfill({
        status: 404,
        json: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not Found" } },
      });
    }
    status = decision.accept ? "approved" : "declined";
    return route.fulfill({ json: { json: connection() } });
  });

  await signup(page, `connection-version-${Date.now()}@example.test`, "password12", "Messenger");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByRole("button", { name: "Manage messaging settings" }).click();
  const overlay = page.getByTestId("messaging-settings");
  await expect(overlay.getByText("Dana's Original helper", { exact: false })).toBeVisible();

  // The same connection row has reopened while the previous version is on screen.
  requestVersion = 2;
  await overlay.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(overlay.getByText("Couldn't update messaging settings")).toBeVisible();
  await expect(overlay.getByText("Dana's Current helper", { exact: false })).toBeVisible();
  expect(decisions).toEqual([{ connectionId, requestVersion: 1, accept: true }]);
  expect(status).toBe("pending");
  await captureScreenshot(page, testInfo, "messaging-connection-refreshed");

  await overlay.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(overlay.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  await expect(overlay.getByText("Couldn't update messaging settings")).toHaveCount(0);
  expect(decisions).toEqual([
    { connectionId, requestVersion: 1, accept: true },
    { connectionId, requestVersion: 2, accept: true },
  ]);
  expect(status).toBe("approved");
});

test("team conversation settings open from messaging overlay", async ({ page }, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          enabled: true,
          providers: ["sendblue", "slack", "whatsapp", "telegram", "lark"],
          openSignup: false,
          identities: [],
        },
      }),
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [] }),
    }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [] }),
    }),
  );
  await page.route("**/rpc/externalConversations/updatePolicy", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          teamChatAmbientEnabled: true,
          teamChatRules: "Reply when asked about launch.",
          automatedSenderPolicies: {
            B_GITHUB: { name: "GitHub", mode: "rollup", rollupHours: 6 },
          },
        },
      }),
    }),
  );

  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as {
      json?: {
        current?: {
          id: string;
          bots: Array<{ id: string }>;
          externalConversations?: unknown[];
        };
        spaces?: Array<{ id: string; externalConversations?: unknown[] }>;
      };
    };
    const current = payload.json?.current;
    const botId = current?.bots[0]?.id;
    if (current && botId) {
      const conversation = {
        id: "clexternal000000000000001",
        spaceId: current.id,
        botId,
        provider: "slack",
        displayName: "#launch",
        participantNames: ["Ada", "Grace"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {
          B_GITHUB: { name: "GitHub", mode: "ignore" },
        },
        automatedSenders: [{ id: "B_GITHUB", name: "GitHub" }],
        threadId: "clthread00000000000000001",
        preview: "Ship Friday?",
        unread: false,
        updatedAt: new Date().toISOString(),
      };
      current.externalConversations = [conversation];
      for (const space of payload.json?.spaces ?? []) {
        if (space.id === current.id) space.externalConversations = [conversation];
      }
    }
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  const stamp = Date.now();
  const userName = `TeamChat ${stamp}`;
  await signup(page, `team-chat-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    page.getByTestId("user-settings").getByRole("heading", { name: "Messaging" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Manage messaging settings" }).click();

  const messagingSettings = page.getByTestId("messaging-settings");
  await expect(messagingSettings).toBeVisible();
  await expect(
    messagingSettings.getByRole("heading", { name: "Team conversations" }),
  ).toBeVisible();
  await expect(messagingSettings.getByText("#launch")).toBeVisible();
  await expect(
    messagingSettings.getByRole("listitem").getByText("Slack", { exact: true }),
  ).toBeVisible();
  await messagingSettings.getByRole("button", { name: "Settings", exact: true }).click();
  const conversationSettings = page.getByTestId("external-conversation-settings");
  await expect(conversationSettings).toBeVisible();
  await expect(conversationSettings.getByText("Listening")).toBeVisible();
  await expect(conversationSettings.getByText("Room guidance")).toBeVisible();
  await expect(conversationSettings.getByText("GitHub")).toBeVisible();
  await captureScreenshot(page, testInfo, "messaging-team-conversation-settings");
});

test("shows channel acceptance and delivery uncertainty beside bot replies", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `channel-delivery-${stamp}@example.test`, "password12", "Channel Delivery");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const addDeliveryFixture = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const response = await route.fetch();
    const payload = await response.json();
    const snapshot = payload.json?.thread ?? payload.json;
    if (Array.isArray(snapshot?.messages)) {
      const previous = Math.max(
        0,
        ...snapshot.messages.map((message: { seq: number }) => message.seq),
      );
      for (const [index, [state, text]] of [
        ["accepted", "I saved your meeting notes."],
        ["delivered", "The summary is ready."],
        ["partial_failure", "The text was sent. The attachment is missing."],
        ["unknown", "I prepared a follow-up."],
      ].entries()) {
        snapshot.messages.push({
          id: `delivery-fixture-${index}`,
          threadId: snapshot.threadId,
          botId: snapshot.botId,
          role: "bot",
          seq: previous + index + 1,
          blocks: [{ kind: "text", text }],
          messagingDelivery: {
            state,
            ...(state === "partial_failure" && { reason: "attachment_unavailable" }),
          },
          createdAt: new Date().toISOString(),
        });
      }
    }
    await route.fulfill({ response, json: payload });
  };
  await page.route("**/rpc/bootstrap", addDeliveryFixture);
  await page.route("**/rpc/threads/get", addDeliveryFixture);
  await page.reload({ waitUntil: "domcontentloaded" });
  const labels = page.getByTestId("message-channel-delivery");
  await expect(labels).toHaveCount(4);
  await expect(labels.nth(0)).toHaveText("Accepted by channel");
  await expect(labels.nth(1)).toHaveText("Delivered to channel");
  await expect(labels.nth(3)).toHaveText("Channel delivery unconfirmed");
  const partial = labels.nth(2);
  await expect(partial.getByText("An attachment could not be sent.")).toBeHidden();
  await partial.getByText("Partially sent to channel").click();
  await expect(partial.getByText("An attachment could not be sent.")).toBeVisible();
  await captureScreenshot(page, testInfo, "messaging-channel-delivery");
});

test("Slack workspace installation uses a chosen bot and manages the confirmed connection", async ({
  page,
}, testInfo) => {
  let workspace: {
    id: string;
    botId: string;
    workspaceName: string;
    installerName: string | null;
    status: string;
    revision: number;
  } | null = null;
  let selectedBot: string | undefined;
  let attemptStatus = "pending";
  let reconnect: { id: string; expectedRevision: number } | undefined;
  let failLists = false;
  let pauseCalls = 0;
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      json: { json: { enabled: true, providers: [], openSignup: false, identities: [] } },
    }),
  );
  await page.route("**/rpc/messaging/installations/list", (route) => {
    if (failLists) {
      return route.fulfill({ status: 503, json: { message: "Fixture unavailable" } });
    }
    return route.fulfill({
      json: { json: { available: true, workspaces: workspace ? [workspace] : [] } },
    });
  });
  await page.route("**/rpc/messaging/installations/attempt", (route) =>
    route.fulfill({ json: { json: { status: attemptStatus } } }),
  );
  await page.route("**/rpc/messaging/installations/start", (route) => {
    attemptStatus = "pending";
    const input = route.request().postDataJSON().json;
    selectedBot = input.botId;
    reconnect = input.reconnect;
    return route.fulfill({
      json: {
        json: {
          url: "https://slack.com/oauth/v2/authorize?state=synthetic",
          attemptId: "1".repeat(64),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
    });
  });
  await page.route("**/rpc/messaging/installations/cancel", (route) => {
    expect(route.request().postDataJSON().json.attemptId).toBe("1".repeat(64));
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.route("**/rpc/messaging/installations/pause", (route) => {
    pauseCalls += 1;
    const input = route.request().postDataJSON().json;
    expect(input).toEqual({
      id: "slack-fixture",
      expectedRevision: workspace?.revision,
      paused: workspace?.status === "active",
    });
    if (workspace)
      workspace = {
        ...workspace,
        revision: workspace.revision + 1,
        status: input.paused ? "paused" : "active",
      };
    // Fail every read after the pause is committed. An earlier polling read
    // must not consume the error meant for this readback.
    if (input.paused) failLists = true;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.route("**/rpc/messaging/installations/remove", (route) => {
    expect(route.request().postDataJSON().json).toEqual({
      id: "slack-fixture",
      expectedRevision: workspace?.revision,
    });
    workspace = null;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  const stamp = Date.now();
  await signup(page, `slack-workspace-${stamp}@example.test`, "password12", `Workspace ${stamp}`);
  await completeOnboarding(page);
  const chosenBot = await createNamedBot(page, "Research Bot");
  const account = await openUserSettings(page);
  await account.getByRole("button", { name: "Manage messaging settings" }).click();
  await expect(page.getByTestId("messaging-settings")).toBeVisible();
  await page.goto("/app?slackInstallation=failed");
  const settings = page.getByTestId("messaging-settings");
  const slack = settings.getByRole("region", { name: "Slack" });
  const select = slack.getByLabel("Bot for Slack");
  await expect(slack.getByRole("alert")).toContainText("Couldn't update the Slack connection.");
  await expect(page).not.toHaveURL(/slackInstallation=/);
  await expect(slack.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
  await select.selectOption(chosenBot);
  await slack.getByRole("button", { name: "Connect Slack" }).click();
  await expect(slack.getByText("Waiting for Slack authorization")).toBeVisible();
  await expect(slack.getByText("Couldn't update the Slack connection.")).toHaveCount(0);
  expect(selectedBot).toBe(chosenBot);
  await expect(slack.getByRole("link", { name: "Open Slack" })).toHaveAttribute(
    "href",
    /slack\.com\/oauth\/v2\/authorize/,
  );
  await slack.getByRole("button", { name: "Cancel" }).click();
  await expect(slack.getByText("Waiting for Slack authorization")).toHaveCount(0);
  await slack.getByRole("button", { name: "Connect Slack" }).click();
  await expect(slack.getByText("Waiting for Slack authorization")).toBeVisible();
  workspace = {
    id: "slack-fixture",
    botId: selectedBot!,
    workspaceName: "Design Studio",
    installerName: "Jamie",
    status: "active",
    revision: 1,
  };
  attemptStatus = "connected";
  await expect(slack.getByText("Design Studio")).toBeVisible();
  await expect(slack.getByText("Connected", { exact: true })).toBeVisible();
  await slack.getByRole("button", { name: "Reconnect" }).click();
  await expect(slack.getByText("Waiting for Slack authorization")).toBeVisible();
  expect(reconnect).toEqual({ id: "slack-fixture", expectedRevision: 1 });
  workspace = { ...workspace, revision: 2 };
  attemptStatus = "connected";
  await expect(slack.getByText("Waiting for Slack authorization")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "slack-workspace-settings");
  await slack.getByRole("button", { name: "Pause" }).click();
  await expect(slack.getByRole("button", { name: "Pause" })).toBeDisabled();
  await expect(slack.getByRole("alert")).toContainText("Couldn't load messaging settings");
  failLists = false;
  await slack.getByRole("button", { name: "Retry" }).click();
  await expect(slack.getByText("Paused", { exact: true })).toBeVisible();
  expect(pauseCalls).toBe(1);
  await slack.getByRole("button", { name: "Resume" }).click();
  await expect(slack.getByText("Connected", { exact: true })).toBeVisible();
  await slack.getByRole("button", { name: "Disconnect" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disconnect Slack?" });
  await expect(confirm).toContainText("Conversation history stays in CogineBot.");
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(slack.getByText("Design Studio")).toHaveCount(0);
});

test("Slack workspace installation handoff opens the authorized Space", async ({ page }) => {
  let scopedSpaceId: string | undefined;
  await page.route("**/rpc/messaging/installations/list", (route) => {
    scopedSpaceId = route.request().headers()["x-rakazo-space-id"];
    return route.fulfill({ json: { json: { available: true, workspaces: [] } } });
  });
  const stamp = Date.now();
  await signup(page, `slack-handoff-${stamp}@example.test`, "password12", `Handoff ${stamp}`);
  await completeOnboarding(page);
  const target = await rpc<{ id: string }>(page, "spaces/create", { name: "Research Space" });
  const handoff = (spaceId: string) =>
    `/sign-in?${new URLSearchParams({ next: `/app?slackInstallation=settings&spaceId=${spaceId}` })}`;
  await page.goto(handoff(target.id));
  await expect(page.getByTestId("messaging-settings")).toBeVisible();
  await expect.poll(() => scopedSpaceId).toBe(target.id);
  await expect(page).not.toHaveURL(/slackInstallation=/);
  await page.goto(handoff("inaccessible-fixture-space"));
  await expect(page.getByText("This Space is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByTestId("messaging-settings")).toHaveCount(0);
});
