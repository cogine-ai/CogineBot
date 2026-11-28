import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { Me, ModelCatalogEntry, ModelCredential, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

const LOCAL_MODEL_ID = "rakazo-e2e-local";
const LOCAL_MODEL_REPLY = "OpenAI-compatible endpoint verified end to end.";

test("ChatGPT plan model settings choose a saved account or add a separate registration", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `chatgpt-model-${stamp}@rakazo.test`, "password12", "ChatGPT model user");
  await completeOnboarding(page);
  await page.route("**/rpc/models/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json: Array<Record<string, unknown> & { provider: string }>;
    };
    body.json = body.json.filter((entry) => entry.provider !== "chatgpt-plan");
    body.json.push({
      provider: "chatgpt-plan",
      providerName: "ChatGPT",
      id: "chatgpt-plan",
      label: "ChatGPT",
      auth: "oauth",
      oauthLabel: "Continue with ChatGPT",
      billing: "ChatGPT plan",
      signIn: "auth-url",
      placeholder: true,
    });
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  let accountsUnavailable = false;
  await page.route("**/rpc/models/chatgptProfiles", async (route) => {
    if (accountsUnavailable) {
      await route.fulfill({
        status: 503,
        json: {
          json: {
            code: "SERVICE_UNAVAILABLE",
            status: 503,
            message: "Could not load ChatGPT accounts",
          },
        },
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          { id: "profile-personal", label: "Personal", status: "signed-out" },
          { id: "profile-work", label: "Work", status: "registered" },
        ],
      }),
    });
  });
  const attempts: Array<{
    registrationId?: string;
    newRegistration?: boolean;
    callbackTransport?: string;
    modelId?: string;
  }> = [];
  await page.route("**/rpc/models/beginOAuth", async (route) => {
    attempts.push(route.request().postDataJSON().json);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          provider: "chatgpt-plan",
          loginId: `login-${attempts.length}`,
          mode: "auth-url",
          callbackTransport: "loopback",
          verificationUri: "https://auth.openai.com/api/accounts/authorize?state=fixture-state",
          expiresInSeconds: 600,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: "pending" } }),
    });
  });
  const cancellations: string[] = [];
  await page.route("**/rpc/models/cancelOAuth", async (route) => {
    cancellations.push(route.request().postDataJSON().json.loginId);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("chatgpt-plan");
  await page
    .getByRole("button", { name: /ChatGPT/ })
    .first()
    .click();
  await page
    .getByRole("combobox", { name: "ChatGPT account", exact: true })
    .selectOption("profile-work");
  const usage = page.getByRole("link", { name: "Manage usage", exact: true });
  await expect(usage).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  const providerRow = page.getByRole("button", { name: /ChatGPT/ }).first();
  await expect(providerRow).toContainText("Sign in");
  await expect(providerRow).not.toContainText("1 model");
  await captureScreenshot(page, testInfo, "chatgpt-plan-account-picker");
  await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(1);
  expect(attempts[0]).toMatchObject({
    registrationId: "profile-work",
    newRegistration: false,
    callbackTransport: "loopback",
  });
  expect(attempts[0]?.modelId).toBeUndefined();
  await expect(page.getByRole("link", { name: "auth.openai.com" })).toBeVisible();
  await expect(page.getByLabel("Authorization code or callback URL")).toBeHidden();
  await captureScreenshot(page, testInfo, "chatgpt-plan-loopback-sign-in");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => cancellations).toEqual(["login-1"]);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toMatchObject({ newRegistration: true, callbackTransport: "loopback" });
  expect(attempts[1]?.registrationId).toBeUndefined();
  expect(attempts[1]?.modelId).toBeUndefined();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => cancellations).toEqual(["login-1", "login-2"]);

  accountsUnavailable = true;
  await page.getByRole("button", { name: "Close model settings", exact: true }).click();
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("chatgpt-plan");
  await page
    .getByRole("button", { name: /ChatGPT/ })
    .first()
    .click();
  await expect(page.getByRole("alert")).toHaveText("Could not load ChatGPT accounts");
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT", exact: true }),
  ).toBeDisabled();
  await expect(usage).toBeVisible();
  await captureScreenshot(page, testInfo, "chatgpt-plan-profile-error");
  await page.getByRole("button", { name: "Close model settings", exact: true }).click();

  const actor = await rpc<Me>(page, "me", {});
  const botId = activeBotId(page);
  const thread = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  expect(process.env.SANDBOX_PROVIDER).toBe("fake");
  expect(process.env.AGENT_RUNTIME).toBe("scripted");
  expect(process.env.DATABASE_URL).toBeTruthy();
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(
    new URL(process.env.DATABASE_URL!).hostname,
  );
  const { createDb } = await import("../../../packages/db/src/client");
  const db = createDb(process.env.DATABASE_URL!, {
    poolMax: 2,
    applicationName: "chatgpt-plan-usage-browser-fixture",
  });
  try {
    const task = await db.prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId: thread.threadId,
        prompt: "Synthetic ChatGPT usage failure",
        status: "failed",
      },
    });
    await db.prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId: thread.threadId,
        taskId: task.id,
        status: "failed",
        trigger: "user",
        startedAt: new Date(),
        completedAt: new Date(),
        error: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}',
      },
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
  await page.reload();
  const failure = page.getByTestId("composer-error");
  await expect(failure).toContainText("Your ChatGPT plan usage limit was reached.");
  await expect(failure.getByRole("link", { name: "Manage usage", exact: true })).toHaveAttribute(
    "href",
    "https://chatgpt.com/settings/usage",
  );
  await captureScreenshot(page, testInfo, "chatgpt-plan-usage-limit-action");
});

test("custom connections persist reasoning support and bot thinking", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Reasoning ${stamp}`;
  await signup(page, `reasoning-model-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await page.getByLabel("Model id").fill("arbitrary-model");
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeHidden();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Supports thinking" }).check();
  await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("low");
  await page.getByLabel("Maximum output tokens").fill("8192");
  await page.getByLabel("Context limit").fill("65536");
  await page.getByRole("checkbox", { name: "Supports images" }).check();
  await page.getByLabel("Maximum images per request").fill("1");
  await captureScreenshot(page, testInfo, "openai-compatible-thinking-connection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const credentials = await rpc<ModelCredential[]>(page, "models/credentials", {});
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.reasoning).toBe(true);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.thinkingLevel).toBe(
    "low",
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxTokens).toBe(8192);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.contextWindow).toBe(
    65536,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.supportsImages).toBe(
    true,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt).toBe(
    1,
  );
  await page.reload();
  await openUserSettings(page, "models");
  const panel = page.getByTestId("model-settings-panel");
  await panel.locator("summary").click();
  await expect(panel.getByRole("checkbox", { name: "Supports thinking" })).toBeChecked();
  await page.getByText("Thinking", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Reasoning effort", exact: true })).toHaveValue(
    "low",
  );
  await expect(panel.getByLabel("Maximum output tokens")).toHaveValue("8192");
  await expect(panel.getByLabel("Context limit")).toHaveValue("65536");
  await expect(panel.getByRole("checkbox", { name: "Supports images" })).toBeChecked();
  await expect(panel.getByLabel("Maximum images per request")).toHaveValue("1");
  await panel.getByLabel("Maximum images per request").fill("");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("Saved.", { exact: true })).toBeVisible();
  const clearedCredentials = await rpc<ModelCredential[]>(page, "models/credentials", {});
  const cleared = clearedCredentials.find((entry) => entry.modelId === "arbitrary-model");
  expect(cleared?.modelSettings?.["arbitrary-model"]).toMatchObject({
    reasoning: true,
    images: true,
    maxTokens: 8192,
    contextWindow: 65536,
  });
  expect(cleared?.modelSettings?.["arbitrary-model"]?.maxImagesPerPrompt).toBeUndefined();
  expect(cleared?.maxImagesPerPrompt).toBe(1);
  await captureScreenshot(page, testInfo, "saved-model-capabilities");
  await page.getByRole("button", { name: "Close model settings" }).click();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  const advanced = settings.getByTestId("bot-settings-advanced");
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  // NativeSelect sits inside a wrapping <label>, so label text includes option
  // copy and getByLabel(..., { exact: true }) misses the control. Use the
  // combobox accessible name, matching other model E2E tests.
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toBeVisible();
  await expect(model).toContainText("arbitrary-model");
  // Value key — not a /arbitrary-model/ label match, which also hits "Space default (arbitrary-model)".
  const savedConnection = credentials.find((entry) => entry.modelId === "arbitrary-model");
  expect(savedConnection).toBeDefined();
  await model.selectOption(
    JSON.stringify(["openai-compatible", "arbitrary-model", savedConnection?.id]),
  );
  const thinking = settings.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  await thinking.selectOption("low");
  await thinking.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "openai-compatible-thinking");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  await page.reload();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  await expect(settings).toBeVisible();
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(thinking).toHaveValue("low");
});

test("connects, lists, and uses an OpenAI-compatible endpoint", async ({ page }, testInfo) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: LOCAL_MODEL_ID }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      const created = Math.floor(Date.now() / 1_000);
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-rakazo-e2e",
          object: "chat.completion.chunk",
          created,
          model: LOCAL_MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: LOCAL_MODEL_REPLY },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-rakazo-e2e",
          object: "chat.completion.chunk",
          created,
          model: LOCAL_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const stamp = Date.now();
    const userName = `Local model ${stamp}`;
    await signup(page, `local-model-${stamp}@rakazo.test`, "password12", userName);
    await completeOnboarding(page);

    await openUserSettings(page, "models");
    const providerSearch = page.getByPlaceholder("Search providers");
    await providerSearch.fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeVisible();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByLabel("Model id").fill("manual-model-not-listed");
    await page.getByRole("button", { name: "Find models" }).click();

    await expect(page.getByLabel("Model id")).toHaveValue("manual-model-not-listed");
    await page.getByRole("button", { name: "Use a found model" }).click();
    const discoveredModels = page.getByRole("combobox", { name: "Models from server" });
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await discoveredModels.selectOption("");
    await expect(page.getByLabel("Model id")).toBeVisible();
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await expect(page.getByText("Found 1 model.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenAI-compatible/ })).toContainText(
      "Connected",
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");

    await page.getByLabel("OpenAI-compatible server URL").fill("");
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    if (process.env.AGENT_RUNTIME === "pi") {
      await page.getByRole("button", { name: "Close model settings" }).click();
      const composer = page.getByPlaceholder(/Message/);
      await composer.fill("Reply with the endpoint verification message.");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("transcript").getByText(LOCAL_MODEL_REPLY)).toBeVisible({
        timeout: 30_000,
      });
      await captureScreenshot(page, testInfo, "openai-compatible-response");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("model settings connect, replace, and cancel provider authentication", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, `models-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Scripted runtime/,
  );
  const apiKeyInput = page.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-key-one");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Maximum output tokens").fill("8192");
  await captureScreenshot(page, testInfo, "builtin-provider-max-tokens");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();
  const connected = await rpc<ModelCredential[]>(page, "models/credentials", {});
  const savedModel = connected.find((entry) => entry.provider === "scripted")!;
  expect(savedModel.maxTokens).toBe(8192);
  const panel = page.getByTestId("model-settings-panel");
  await panel.locator("summary").click();
  const outputLimit = panel.getByLabel("Maximum output tokens");
  await expect(outputLimit).toHaveValue("8192");
  await outputLimit.fill("16384");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("Saved.", { exact: true })).toBeVisible();
  const updated = await rpc<ModelCredential[]>(page, "models/credentials", {});
  const adjustedModel = updated.find((entry) => entry.provider === "scripted")!;
  expect(adjustedModel.modelSettings?.[savedModel.modelId!]?.maxTokens).toBe(16384);
  expect(adjustedModel.maxTokens).toBe(8192);
  await page.reload();
  await openUserSettings(page, "models");
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Scripted runtime/,
  );
  const storedKey = page.getByLabel("Replace API key");
  await expect(storedKey).toHaveValue("");
  await expect(storedKey).toHaveAttribute("placeholder", "Paste a replacement key");
  await captureScreenshot(page, testInfo, "stored-provider-api-key");
  await panel.locator("summary").click();
  await expect(panel.getByLabel("Maximum output tokens")).toHaveValue("16384");

  // Connected providers get their own section with the saved model inline;
  // searching flattens back to one ranked list.
  await providerSearch.fill("");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("All providers", { exact: true })).toBeVisible();
  const scriptedRow = page.getByRole("button", { name: /^Scripted/ });
  await expect(scriptedRow).toContainText("Scripted runtime");
  await providerSearch.fill("scripted");
  await expect(page.getByText("All providers", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: /Scripted/ })).toContainText("Connected");
  await page.getByRole("button", { name: /Scripted/ }).click();

  await page.getByLabel("Replace API key").fill("fake-scripted-key-two");
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();
  const replaced = await rpc<ModelCredential[]>(page, "models/credentials", {});
  expect(
    replaced.find((entry) => entry.id === savedModel.id)?.modelSettings?.[savedModel.modelId!]
      ?.maxTokens,
  ).toBe(16384);

  const codexCredential = {
    id: "cred-codex",
    provider: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hasKey: false,
    isDefault: false,
    modelId: "gpt-6-luna",
    authKind: "oauth",
    connectionRevision: 1,
  };
  let oauthReady = false;
  let oauthFinished = false;
  await page.route("**/rpc/models/credentials", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: unknown[] };
    if (oauthFinished) body.json.push(codexCredential);
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-login",
          provider: "openai-codex",
          mode: "device-code",
          verificationUri: "https://example.com/device",
          userCode: "TEST-CODE",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: oauthReady ? "ready" : "pending" } }),
    });
  });
  await page.route("**/rpc/models/finishOAuth", async (route) => {
    oauthFinished = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: codexCredential }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();

  // The popup is blocked (window.open returned null): the card still carries the
  // code, a copy button, the expiry, and a way to abandon the attempt.
  await expect(page.getByText("TEST-CODE")).toBeVisible();
  await expect(page.getByRole("link", { name: "example.com/device" })).toBeVisible();
  await expect(page.getByText(/code expires in about 15 minutes/)).toBeVisible();
  await captureScreenshot(page, testInfo, "oauth-device-code-card");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("TEST-CODE");

  const cancelledByButton = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await cancelledByButton;
  await expect(page.getByText("TEST-CODE")).toBeHidden();

  // A canceled attempt leaves sign-in reusable.
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("TEST-CODE")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("TEST-CODE")).toBeHidden();

  // A finished sign-in relabels the action so re-clicking reads as a reconnect.
  oauthReady = true;
  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Connected and using/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();

  // Disconnect removes the credential and its Connected marker.
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirmDisconnect = page.getByRole("alertdialog");
  await expect(
    confirmDisconnect.getByRole("heading", { name: "Disconnect Scripted?" }),
  ).toBeVisible();
  await confirmDisconnect.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText(/Disconnected Scripted/)).toBeVisible();
  const afterDisconnect = await rpc<Array<{ provider: string }>>(page, "models/credentials", {});
  expect(afterDisconnect.some((entry) => entry.provider === "scripted")).toBe(false);
  await expect(page.getByRole("button", { name: /Scripted/ })).not.toContainText("Connected");
});

test("a deployment default on server credentials says so and keeps an own key optional", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `server-credentials-${stamp}@rakazo.test`, "password12", `Server ${stamp}`);
  await completeOnboarding(page);
  // The E2E deployment runs on a scripted model, so present the active default as one that
  // authenticates from the host, the way an Amazon Bedrock deployment on an AWS role does.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        ...body,
        json: {
          ...body.json,
          defaultProvider: "amazon-bedrock",
          defaultModel: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
          hostCredentialProvider: "amazon-bedrock",
          hostCredentialSource: "AWS IAM",
        },
      },
    });
  });
  await openUserSettings(page, "models");

  const serverNote = page.getByText(
    "Uses this server's own AWS IAM credentials to access Amazon Bedrock.",
  );
  const ownKeyDisclosure = page.getByText("Use your own key", { exact: true });
  await expect(serverNote).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeHidden();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials");

  await ownKeyDisclosure.click();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeVisible();
  await expect(serverNote).toBeVisible();
  await ownKeyDisclosure.click();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeHidden();
  await expect(serverNote).toBeVisible();
});

test("a key connected in another space can replace server credentials for the same model", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `shared-model-${stamp}@rakazo.test`, "password12", "Model Owner");
  await completeOnboarding(page);
  const otherSpace = await rpc<{ id: string }>(page, "spaces/create", { name: "Other space" });
  const provider = "amazon-bedrock";
  const modelId = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
  const connected = await page.request.post("/rpc/models/connect", {
    headers: { "x-rakazo-space-id": otherSpace.id },
    data: { json: { provider, modelId, apiKey: "fake-bedrock-key" } },
  });
  expect(connected.ok()).toBe(true);
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    // The offline deployment uses Scripted; expose its untouched default as host Bedrock.
    if (body.json.defaultProvider !== provider) {
      Object.assign(body.json, {
        defaultProvider: provider,
        defaultModel: modelId,
        hostCredentialProvider: provider,
        hostCredentialSource: "AWS IAM",
      });
    }
    await route.fulfill({ response, json: body });
  });
  await openUserSettings(page, "models");
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Claude Haiku/,
  );
  await expect(
    page.getByText("Uses this server's own AWS IAM credentials to access Amazon Bedrock."),
  ).toBeVisible();
  const useModel = page.getByRole("button", { name: "Use this model", exact: true });
  await expect(useModel).toBeVisible();
  const personalBillingNote = page.getByText(
    "Uses your Amazon Bedrock API key. CogineBot does not pay for model usage.",
  );
  await expect(personalBillingNote).toBeHidden();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials-connected-key");
  const saved = page.waitForRequest("**/rpc/models/setDefault");
  await useModel.click();
  const request = await saved;
  expect(request.postDataJSON().json).toMatchObject({ provider, modelId });
  expect(request.headers()["x-rakazo-space-id"]).not.toBe(otherSpace.id);
  await expect(page.getByText(/Now using/)).toBeVisible();
  await expect(useModel).toBeHidden();
  await expect(personalBillingNote).toBeVisible();
  await expect(
    page.getByText("Uses this server's own AWS IAM credentials to access Amazon Bedrock."),
  ).toBeHidden();
  expect(await rpc(page, "me", {})).toMatchObject({
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
  });
});

test("catalog models keep a space default thinking level per saved model", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `catalog-thinking-${stamp}@rakazo.test`, "password12", `Thinking ${stamp}`);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  const providerSearch = page.getByPlaceholder("Search providers");

  // A non-reasoning provider never shows the control.
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toBeHidden();

  await providerSearch.fill("anthropic");
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await page.getByLabel("API key").fill("fake-anthropic-key");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();

  const thinking = page.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveValue("");
  await thinking.selectOption("high");
  await captureScreenshot(page, testInfo, "catalog-model-thinking");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Now using/)).toBeVisible();
  // The Active model banner surfaces the effective effort while the model can think.
  await expect(page.getByText("Thinking: High", { exact: true })).toBeVisible();

  const credentials = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
    page,
    "models/credentials",
    {},
  );
  expect(credentials.find((entry) => entry.provider === "anthropic")?.thinkingLevel).toBe("high");

  // The level persists across reloads while the same model stays selected.
  await page.reload();
  await openUserSettings(page, "models");
  await providerSearch.fill("anthropic");
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveValue("high");

  // The stored level is bound to the saved model: staging another model resets the
  // staged level, and saving the new model clears the old level instead of leaking it.
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Claude Opus 4.8", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Use this model", exact: true }).click();
  await expect(page.getByText(/Now using/)).toBeVisible();
  const updated = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
    page,
    "models/credentials",
    {},
  );
  expect(updated.find((entry) => entry.provider === "anthropic")?.thinkingLevel).toBeUndefined();
});

test("saves and reloads an ordered backup model list for connected models", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `backup-models-${stamp}@rakazo.test`, "password12", `Backups ${stamp}`);
  await completeOnboarding(page);

  const catalog = await rpc<
    Array<{
      provider: string;
      id: string;
      label: string;
      providerName?: string;
      placeholder?: boolean;
    }>
  >(page, "models/list", {});
  const targets = ["anthropic", "openai"].map((provider) => {
    const model = catalog.find((entry) => entry.provider === provider && !entry.placeholder);
    expect(model, `expected a ${provider} catalog entry`).toBeDefined();
    return model!;
  });
  // Fake credentials exercise the connected-model picker without calling a provider.
  const connections: Array<{ id: string; connectionRevision: number }> = [];
  for (const model of targets) {
    connections.push(
      await rpc<{ id: string; connectionRevision: number }>(page, "models/connect", {
        provider: model.provider,
        apiKey: `fake-backup-${model.provider}-key`,
        modelId: model.id,
      }),
    );
  }

  const settings = await openUserSettings(page, "models");
  const panel = settings.getByTestId("model-backups");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Add connected models to use them as backups.")).toBeVisible();
  const picker = panel.getByRole("combobox", { name: "Add connected model" });
  const firstValue = JSON.stringify([targets[0]!.provider, targets[0]!.id, connections[0]!.id]);
  const secondValue = JSON.stringify([targets[1]!.provider, targets[1]!.id, connections[1]!.id]);
  await picker.selectOption(firstValue);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await picker.selectOption(secondValue);
  await panel.getByRole("button", { name: "Add", exact: true }).click();

  const firstLabel = `${targets[0]!.providerName ?? targets[0]!.provider} · ${targets[0]!.label}`;
  const secondLabel = `${targets[1]!.providerName ?? targets[1]!.provider} · ${targets[1]!.label}`;
  const rotateBackupConnection = async () => {
    await settings.getByPlaceholder("Search providers").fill("openai");
    await settings
      .getByRole("button")
      .filter({ has: page.getByText("OpenAI", { exact: true }) })
      .click();
    await settings
      .getByLabel("Replace API key", { exact: true })
      .fill(`fake-backup-openai-replacement-${connections[1]!.connectionRevision}`);
    const connected = page.waitForResponse(
      (response) => response.url().includes("/rpc/models/connect") && response.ok(),
    );
    await settings.getByRole("button", { name: "Replace API key", exact: true }).click();
    await connected;
    await expect(settings.getByText(/Connected and using/)).toBeVisible();
    const refreshed = await rpc<Array<{ id: string; connectionRevision: number }>>(
      page,
      "models/credentials",
      {},
    );
    const rotated = refreshed.find((entry) => entry.id === connections[1]!.id);
    expect(rotated).toBeDefined();
    expect(rotated!.connectionRevision).toBeGreaterThan(connections[1]!.connectionRevision);
    connections[1] = rotated!;
  };
  await panel.getByRole("button", { name: `Move ${secondLabel} up` }).click();
  const rows = panel.locator('[data-testid^="model-backup-"]');
  await expect(rows.nth(0)).toContainText(secondLabel);
  await expect(rows.nth(1)).toContainText(firstLabel);
  await rotateBackupConnection();
  await expect(rows.nth(0)).toContainText(secondLabel);
  await expect(rows.nth(1)).toContainText(firstLabel);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeInViewport();

  const savedResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/models/setBackups") && response.ok(),
  );
  await panel.getByRole("button", { name: "Save backups", exact: true }).click();
  const savedBackupResponse = await savedResponse;
  expect(savedBackupResponse.request().postDataJSON().json).toEqual([
    {
      provider: targets[1]!.provider,
      modelId: targets[1]!.id,
      modelCredentialId: connections[1]!.id,
      expectedRevision: connections[1]!.connectionRevision,
    },
    {
      provider: targets[0]!.provider,
      modelId: targets[0]!.id,
      modelCredentialId: connections[0]!.id,
      expectedRevision: connections[0]!.connectionRevision,
    },
  ]);
  await expect(panel.getByText("Backup models saved.")).toBeVisible();
  expect(await rpc(page, "models/backups", {})).toEqual([
    {
      provider: targets[1]!.provider,
      modelId: targets[1]!.id,
      modelCredentialId: connections[1]!.id,
    },
    {
      provider: targets[0]!.provider,
      modelId: targets[0]!.id,
      modelCredentialId: connections[0]!.id,
    },
  ]);

  await page.reload();
  const reloadedSettings = await openUserSettings(page, "models");
  const reloadedPanel = reloadedSettings.getByTestId("model-backups");
  await reloadedPanel.scrollIntoViewIfNeeded();
  const reloadedRows = reloadedPanel.locator('[data-testid^="model-backup-"]');
  await expect(reloadedRows.nth(0)).toContainText(secondLabel);
  await expect(reloadedRows.nth(1)).toContainText(firstLabel);
  // The mounted backup list must also accept a connection edit after reloading saved rows.
  await rotateBackupConnection();
  await expect(reloadedRows.nth(0)).toContainText(secondLabel);
  await expect(reloadedRows.nth(1)).toContainText(firstLabel);
  await reloadedPanel.scrollIntoViewIfNeeded();
  await expect(reloadedPanel).toBeInViewport();
  await testInfo.attach("settings-backup-models-control", {
    body: await reloadedPanel.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  await captureScreenshot(page, testInfo, "settings-backup-models-order");
  await captureScreenshot(page, testInfo, "a1-backup-after-connection-save");
  await reloadedPanel.getByRole("button", { name: `Remove ${firstLabel}` }).click();
  const removalResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/models/setBackups") && response.ok(),
  );
  await reloadedPanel.getByRole("button", { name: "Save backups", exact: true }).click();
  const removedBackupResponse = await removalResponse;
  expect(removedBackupResponse.request().postDataJSON().json).toEqual([
    {
      provider: targets[1]!.provider,
      modelId: targets[1]!.id,
      modelCredentialId: connections[1]!.id,
      expectedRevision: connections[1]!.connectionRevision,
    },
  ]);
  expect(await rpc(page, "models/backups", {})).toEqual([
    {
      provider: targets[1]!.provider,
      modelId: targets[1]!.id,
      modelCredentialId: connections[1]!.id,
    },
  ]);
});

test("keeps enabled models and exact connection bindings across two model servers", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (
      request.method === "GET" &&
      (request.url === "/alpha/v1/models" || request.url === "/beta/v1/models")
    ) {
      requests.push(request.url);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "shared-model" }, { id: "second-model" }, { id: "unselected-model" }],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const alpha = `http://127.0.0.1:${port}/alpha/v1`;
    const beta = `http://127.0.0.1:${port}/beta/v1`;
    const stamp = Date.now();
    await signup(
      page,
      `multi-model-${stamp}@rakazo.test`,
      "password12",
      `Model connections ${stamp}`,
    );
    await completeOnboarding(page);
    await openUserSettings(page, "models");
    await page.getByPlaceholder("Search providers").fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.getByLabel("OpenAI-compatible server URL").fill(alpha);
    await page.getByText("API key", { exact: true }).click();
    await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
    await page.getByLabel("API key", { exact: true }).fill("offline-test-credential");
    await page.getByLabel("Model id").fill("shared-model");
    await page.getByRole("button", { name: "Find models", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "shared-model", exact: true })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "second-model", exact: true }),
    ).not.toBeChecked();
    await page.getByRole("checkbox", { name: "second-model", exact: true }).check();
    await expect(
      page.getByRole("checkbox", { name: "unselected-model", exact: true }),
    ).not.toBeChecked();
    await page.getByLabel("OpenAI-compatible server URL").fill(`${alpha}/`);
    await expect(page.getByRole("checkbox", { name: "second-model", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Find models", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "unselected-model", exact: true }),
    ).not.toBeChecked();
    await captureScreenshot(page, testInfo, "a1-enabled-models");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    type Credential = {
      id: string;
      connectionRevision: number;
      provider: string;
      baseUrl?: string;
      modelId?: string;
      enabledModelIds?: string[];
    };
    const first = (await rpc<Credential[]>(page, "models/credentials", {})).find(
      (entry) => entry.baseUrl === alpha,
    );
    expect(first?.enabledModelIds).toEqual(["shared-model", "second-model"]);
    expect(first?.connectionRevision).toBeGreaterThanOrEqual(1);
    await page.getByLabel("Connection", { exact: true }).selectOption("");
    await page.getByLabel("OpenAI-compatible server URL").fill(beta);
    await page.getByLabel("Model id").fill("shared-model");
    await page.getByRole("button", { name: "Find models", exact: true }).click();
    await page.getByRole("checkbox", { name: "second-model", exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    const credentials = await rpc<Credential[]>(page, "models/credentials", {});
    const second = credentials.find((entry) => entry.baseUrl === beta);
    expect(second?.id).toBeTruthy();
    expect(second?.id).not.toBe(first?.id);
    await page.getByLabel("Connection", { exact: true }).selectOption(first?.id ?? "missing");
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Find models", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "second-model", exact: true })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "unselected-model", exact: true }),
    ).not.toBeChecked();
    await expect(page).toHaveTitle(/CogineBot/);
    await expect(page).toHaveURL(/\/app\/[^/]+/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect((await page.locator("#root").innerText()).trim().length).toBeGreaterThan(40);
    await captureScreenshot(page, testInfo, "a1-saved-connection-discovery");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Connection", { exact: true })).toBeVisible();
    await page.getByLabel("Connection", { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await captureScreenshot(page, testInfo, "a1-model-settings-mobile");
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(requests).toContain("/alpha/v1/models");
    expect(requests).toContain("/beta/v1/models");
    await page.getByRole("button", { name: "Close model settings" }).click();
    await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
    const settings = page.getByTestId("bot-settings");
    await expect(settings).toBeVisible();
    await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    const model = settings.getByRole("combobox", { name: "Model", exact: true });
    const binding = JSON.stringify(["openai-compatible", "second-model", second?.id]);
    await expect(model).toContainText("second-model");
    const choices = await model
      .locator("option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(choices).toContain(JSON.stringify(["openai-compatible", "second-model", first?.id]));
    expect(choices).toContain(binding);
    expect(choices.some((key) => key.includes("unselected-model"))).toBe(false);
    await model.selectOption(binding);
    // Show the native option list in the screenshot, then restore the native picker.
    const expandedModel = settings.locator(`[id="${await model.getAttribute("id")}"]`);
    await expandedModel.evaluate((element: HTMLSelectElement) => {
      element.size = element.options.length;
      element.style.height = "auto";
    });
    await expandedModel.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "a1-exact-bot-connection");
    await expandedModel.evaluate((element: HTMLSelectElement) => {
      element.size = 0;
      element.style.removeProperty("height");
    });
    const saved = page.waitForResponse(
      (response) => response.url().includes("/rpc/bots/update") && response.ok(),
    );
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
    const botId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
    const bot = await rpc<{ modelId: string; modelCredentialId: string }>(page, "bots/get", {
      botId,
    });
    expect(bot.modelId).toBe("second-model");
    expect(bot.modelCredentialId).toBe(second?.id);
    await page.reload();
    await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
    await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await expect(model).toHaveValue(binding);
    const conflictedBinding = JSON.stringify(["openai-compatible", "second-model", first?.id]);
    await model.selectOption(conflictedBinding);
    await rpc(page, "models/connect", {
      provider: "openai-compatible",
      credentialId: first!.id,
      expectedRevision: first!.connectionRevision,
      baseUrl: alpha,
      modelId: "shared-model",
      enabledModelIds: ["shared-model", "second-model"],
    });
    const conflict = page.waitForResponse(
      (response) => response.url().includes("/rpc/bots/update") && response.status() === 409,
    );
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await conflict;
    const saveOther = settings.getByRole("button", { name: "Save other settings", exact: true });
    await expect(saveOther).toBeEnabled();
    await expect(
      settings.getByRole("button", { name: "Use updated connection", exact: true }),
    ).toBeEnabled();
    const readAloud = settings.getByRole("switch", { name: "Read replies aloud", exact: true });
    const originalReadAloud = await readAloud.isChecked();
    await readAloud.click();
    await saveOther.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "a1-conflict-other-settings");
    const otherSave = page.waitForResponse(
      (response) => response.url().includes("/rpc/bots/update") && response.ok(),
    );
    await saveOther.click();
    const otherResponse = await otherSave;
    const otherPatch = otherResponse.request().postDataJSON().json;
    for (const key of [
      "modelProvider",
      "modelId",
      "modelCredentialId",
      "expectedRevision",
      "thinkingLevel",
    ])
      expect(otherPatch).not.toHaveProperty(key);
    expect(otherPatch.autoSpeak).toBe(!originalReadAloud);
    expect(await rpc(page, "bots/get", { botId })).toMatchObject({
      modelId: "second-model",
      modelCredentialId: second!.id,
      autoSpeak: !originalReadAloud,
    });
    await expect(model).toHaveValue(conflictedBinding);
    await expect(saveOther).toBeEnabled();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const expectedConflictError =
      "console.error: Failed to load resource: the server responded with a status of 409 (Conflict)";
    expect(errors.filter((error) => error === expectedConflictError)).toHaveLength(
      errors.includes(expectedConflictError) ? 1 : 0,
    );
    expect(
      errors.filter((error) => error !== expectedConflictError),
      "no unexpected browser errors during model configuration, conflict recovery and reload",
    ).toEqual([]);
  } finally {
    try {
      const title = await page.title().catch(() => "Page unavailable during cleanup");
      await testInfo
        .attach("a1-browser-health", {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ url: page.url(), title, errors }, null, 2)),
        })
        .catch(() => undefined);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  }
});

test("custom model protocols save, reopen and preserve private headers", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const receivedHeaders: Array<{ project?: string; version?: string }> = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/models")) {
      receivedHeaders.push({
        project:
          typeof request.headers["x-project"] === "string"
            ? request.headers["x-project"]
            : undefined,
        version:
          typeof request.headers["anthropic-version"] === "string"
            ? request.headers["anthropic-version"]
            : undefined,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ id: "protocol-fixture-model" }, { id: "other-fixture-model" }] }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const stamp = Date.now();
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await signup(
      page,
      `model-protocol-${stamp}@example.test`,
      "password12",
      "Model protocol fixture",
    );
    await completeOnboarding(page);
    await openUserSettings(page, "models");
    await page.getByPlaceholder("Search providers").fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByLabel("Model id", { exact: true }).fill("protocol-fixture-model");
    await page.getByText("API key", { exact: true }).click();
    await page.getByLabel("API key", { exact: true }).fill("synthetic-ui-connection-key");
    await page.getByText("Custom headers", { exact: true }).click();
    await page.getByRole("button", { name: "Add header", exact: true }).click();
    await page.getByLabel("Header name", { exact: true }).fill("X-Project");
    await page.getByLabel("Header value", { exact: true }).fill("en");
    const protocol = page.getByRole("combobox", { name: "API protocol", exact: true });
    await expect(protocol.locator("option")).toHaveText([
      "Chat Completions",
      "Responses",
      "Anthropic Messages",
    ]);
    let connectionId: string | undefined;
    for (const apiProtocol of ["chat-completions", "responses", "anthropic-messages"] as const) {
      await protocol.selectOption(apiProtocol);
      await page.getByRole("button", { name: "Find models", exact: true }).click();
      await expect(page.getByText("Found 2 models.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
      const credentials = await rpc<
        Array<{
          id: string;
          provider: string;
          baseUrl?: string;
          apiProtocol?: string;
          headerNames?: string[];
        }>
      >(page, "models/credentials", {});
      const saved = credentials.find(
        (entry) => entry.provider === "openai-compatible" && entry.baseUrl === baseUrl,
      );
      expect(saved).toMatchObject({ apiProtocol, headerNames: ["X-Project"] });
      expect(saved).not.toHaveProperty("headers");
      expect(saved).not.toHaveProperty("apiKey");
      if (connectionId) expect(saved?.id).toBe(connectionId);
      connectionId = saved!.id;
      await page.getByLabel("Connection", { exact: true }).selectOption(connectionId);
      await expect(protocol).toHaveValue(apiProtocol);
      await expect(page.getByLabel("Header value", { exact: true })).toHaveValue("");
      await page.getByLabel("OpenAI-compatible server URL").fill(`${baseUrl}/temporary`);
      await expect(page.getByLabel("Header name", { exact: true })).toHaveCount(0);
      await page.getByLabel("OpenAI-compatible server URL").fill(`${baseUrl}/`);
      await expect(page.getByLabel("Header name", { exact: true })).toHaveValue("X-Project");
      await expect(page.getByLabel("Header value", { exact: true })).toHaveValue("");
    }
    expect(receivedHeaders).toHaveLength(3);
    expect(receivedHeaders.map((headers) => headers.project)).toEqual(["en", "en", "en"]);
    expect(receivedHeaders[2]?.version).toBe("2023-06-01");
    await captureScreenshot(page, testInfo, "model-protocols-custom-connection");
    await page.getByRole("button", { name: "Close model settings", exact: true }).click();
    await openUserSettings(page, "models");
    await page.getByPlaceholder("Search providers").fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.getByLabel("Connection", { exact: true }).selectOption(connectionId!);
    await expect(protocol).toHaveValue("anthropic-messages");
    await page.getByText("Custom headers", { exact: true }).click();
    await expect(page.getByLabel("Header value", { exact: true })).toHaveValue("");
    await captureScreenshot(page, testInfo, "model-protocols-reopened-headers");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const width of [1280, 390]) {
  test(`per-model settings save, recover and reset on the selected connection at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signup(
      page,
      `model-settings-${width}-${Date.now()}@example.test`,
      "password12",
      "Model Settings",
    );
    await completeOnboarding(page);
    type SavedConnection = {
      id: string;
      modelId?: string;
      thinkingLevel?: string;
      modelSettings?: Record<string, { maxTokens?: number; contextWindow?: number }>;
    };
    const connections: SavedConnection[] = [];
    for (const port of [8090, 8091]) {
      connections.push(
        await rpc<SavedConnection>(page, "models/connect", {
          provider: "openai-compatible",
          apiKey: "synthetic-offline-key",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          modelId: "model-a",
          enabledModelIds: ["model-a", "model-b"],
          reasoning: true,
          thinkingLevel: "low",
          maxTokens: 1024,
          contextWindow: 32000,
        }),
      );
    }
    if (width === 390)
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const settings = await openUserSettings(page, "models");
    await settings.getByPlaceholder("Search providers").fill("openai-compatible");
    await settings.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await settings.getByLabel("Connection", { exact: true }).selectOption(connections[0]!.id);
    await settings.getByLabel("Models from server", { exact: true }).selectOption("model-b");
    const panel = settings.getByTestId("model-settings-panel");
    await expect(panel.locator("summary")).toHaveText("Advanced · Default");
    await expect(panel.getByLabel("Maximum output tokens", { exact: true })).toBeHidden();
    await panel.locator("summary").click();
    await panel.getByLabel("Context limit", { exact: true }).fill("64000");
    await panel.getByLabel("Maximum output tokens", { exact: true }).fill("2048");
    let fail = true;
    await page.route("**/rpc/models/saveModelSettings", async (route) => {
      if (!fail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        json: {
          json: {
            defined: false,
            code: "SERVICE_UNAVAILABLE",
            status: 503,
            message: "Synthetic settings unavailable",
          },
        },
      });
    });
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Synthetic settings unavailable");
    await expect(panel.getByLabel("Maximum output tokens", { exact: true })).toHaveValue("2048");
    await captureScreenshot(page, testInfo, `a1-model-draft-failure-${width}`);
    fail = false;
    const savedResponse = page.waitForResponse(
      (response) => response.url().includes("/rpc/models/saveModelSettings") && response.ok(),
    );
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await savedResponse;
    await expect(panel.getByRole("status")).toHaveText("Saved.");
    await expect(settings.getByLabel("Models from server", { exact: true })).toHaveValue("model-b");
    await expect(panel.locator("summary")).toHaveText("Advanced · Adjusted");
    const read = async () => rpc<SavedConnection[]>(page, "models/credentials", {});
    const stored = await read();
    expect(
      stored.find((entry) => entry.id === connections[0]!.id)?.modelSettings?.["model-b"],
    ).toMatchObject({ contextWindow: 64000, maxTokens: 2048 });
    expect(stored.find((entry) => entry.id === connections[0]!.id)?.modelId).toBe("model-a");
    expect(
      stored.find((entry) => entry.id === connections[0]!.id)?.modelSettings?.["model-a"],
    ).toBeUndefined();
    expect(stored.find((entry) => entry.id === connections[1]!.id)?.modelSettings).toBeUndefined();
    await captureScreenshot(page, testInfo, `a1-model-settings-saved-${width}`);
    await panel.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await expect(panel.getByLabel("Maximum output tokens", { exact: true })).toHaveValue("");
    await expect(panel.locator("summary")).toHaveText("Advanced · Default");
    const reset = (await read()).find((entry) => entry.id === connections[0]!.id)!;
    expect(reset.modelSettings).toEqual({ "model-b": {} });
    expect(reset.modelId).toBe("model-a");
    await expect(settings.getByLabel("Models from server", { exact: true })).toHaveValue("model-b");
    expect(reset.thinkingLevel).toBe("low");
    await expect(panel.getByLabel("Maximum output tokens", { exact: true })).toHaveAttribute(
      "placeholder",
      "4096",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await captureScreenshot(page, testInfo, `a1-model-settings-reset-${width}`);
    await page.reload();
    if (width === 390)
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await openUserSettings(page, "models");
    await page.getByPlaceholder("Search providers").fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.getByLabel("Connection", { exact: true }).selectOption(connections[0]!.id);
    await page.getByLabel("Models from server", { exact: true }).selectOption("model-b");
    await expect(page.getByTestId("model-settings-panel").locator("summary")).toHaveText(
      "Advanced · Default",
    );
    await settings.getByLabel("Models from server", { exact: true }).selectOption("model-a");
    await panel.locator("summary").click();
    await expect(
      panel.getByRole("checkbox", { name: "Supports thinking", exact: true }),
    ).toBeChecked();
    if (width === 1280) {
      await panel.getByRole("checkbox", { name: "Supports thinking", exact: true }).uncheck();
      await panel.getByRole("button", { name: "Save", exact: true }).click();
    } else await panel.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Saved.");
    await expect(
      settings.getByRole("combobox", { name: "Reasoning effort", exact: true }),
    ).toBeHidden();
    const connectionSave = page.waitForResponse(
      (response) => response.url().includes("/rpc/models/connect") && response.ok(),
    );
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await connectionSave;
    const reconnected = await read();
    expect(reconnected.find((entry) => entry.id === connections[0]!.id)?.thinkingLevel).toBe("low");
    expect(
      reconnected.find((entry) => entry.id === connections[0]!.id)?.modelSettings?.["model-b"],
    ).toEqual({});
    expect(
      reconnected.find((entry) => entry.id === connections[1]!.id)?.modelSettings,
    ).toBeUndefined();
    await panel.getByRole("checkbox", { name: "Supports thinking", exact: true }).check();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Saved.");
    await settings.getByText("Thinking", { exact: true }).click();
    await expect(
      settings.getByRole("combobox", { name: "Reasoning effort", exact: true }),
    ).toHaveValue("low");
  });
}

test("checks a saved provider key without asking the user to re-enter it", async ({
  page,
}, testInfo) => {
  await signup(page, `catalog-key-${Date.now()}@example.test`, "password12", "Connection fixture");
  await completeOnboarding(page);
  const catalog = await rpc<Array<{ provider: string; id: string; catalogProbe?: boolean }>>(
    page,
    "models/list",
    {},
  );
  const model = catalog.find((entry) => entry.provider === "openai" && entry.catalogProbe);
  expect(model).toBeDefined();
  const saved = await rpc<ModelCredential>(page, "models/connect", {
    provider: "openai",
    apiKey: "fixture-saved-provider-key",
    modelId: model!.id,
  });
  const requests: unknown[] = [];
  await page.route("**/rpc/models/probeCatalog", async (route) => {
    requests.push(route.request().postDataJSON().json);
    await route.fulfill({ json: { json: { models: [model!.id] } } });
  });

  const settings = await openUserSettings(page, "models");
  await settings.getByPlaceholder("Search providers").fill("openai");
  await settings
    .getByRole("button")
    .filter({ has: page.getByText("OpenAI", { exact: true }) })
    .click();
  const input = settings.getByLabel("Replace API key", { exact: true });
  const check = settings.getByRole("button", { name: "Check models", exact: true });
  await expect(input).toHaveValue("");
  await expect(check).toBeEnabled();
  await input.fill("short");
  await expect(settings.getByRole("button", { name: "Test API key", exact: true })).toBeDisabled();
  await input.clear();
  await check.click();
  await expect(settings.getByText("Chat was not tested.", { exact: false })).toBeVisible();
  expect(requests).toEqual([
    { provider: "openai", credentialId: saved.id, expectedRevision: saved.connectionRevision },
  ]);
  await expect(input).toHaveValue("");
  await captureScreenshot(page, testInfo, "a1-saved-api-key-catalog-check");
});

test("prioritizes automatically listed models for a saved connection", async ({
  page,
}, testInfo) => {
  await signup(page, `listed-model-${Date.now()}@example.test`, "password12", "Connection fixture");
  await completeOnboarding(page);
  const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
  const openai = catalog.filter((entry) => entry.provider === "openai" && entry.catalogProbe);
  expect(openai.length).toBeGreaterThan(2);
  const [current, listed] = openai;
  const discovered = "gpt-fixture-directory-model";
  const saved = await rpc<ModelCredential>(page, "models/connect", {
    provider: "openai",
    apiKey: "fixture-provider-key-for-order",
    modelId: current!.id,
  });
  let savedDiscovery = false;
  const tested: unknown[] = [];
  await page.route("**/rpc/models/probeInference", async (route) => {
    tested.push(route.request().postDataJSON().json);
    await route.fulfill({ json: { json: { status: "accepted" } } });
  });
  await page.route("**/rpc/models/credentials", async (route) => {
    const includeCatalog = route.request().postDataJSON()?.json?.includeProviderCatalog === true;
    const response = await route.fetch();
    const payload = (await response.json()) as { json: ModelCredential[] };
    const json = payload.json.map((credential) =>
      credential.id === saved.id
        ? {
            ...credential,
            providerCatalogInferenceProbe: "replacement" as const,
            ...(includeCatalog ? { providerListedModelIds: [listed!.id, discovered] } : {}),
            ...(savedDiscovery
              ? { modelId: discovered, savedProviderCatalogModelIds: [discovered] }
              : {}),
          }
        : credential,
    );
    await route.fulfill({ response, json: { json } });
  });

  const settings = await openUserSettings(page, "models");
  await settings.getByPlaceholder("Search providers").fill("openai");
  await settings
    .getByRole("button")
    .filter({ has: page.getByText("OpenAI", { exact: true }) })
    .click();
  const picker = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(picker).toHaveText(current!.label);
  await picker.click();
  const listbox = settings.getByRole("listbox", { name: "Model options" });
  const options = listbox.getByRole("option");
  await expect(options.first()).toContainText(listed!.label);
  await expect(listbox.getByRole("option", { selected: true })).toContainText(current!.label);
  await captureScreenshot(page, testInfo, "a1-provider-listed-model-order");
  await picker.click();
  await settings.getByLabel("Replace API key", { exact: true }).fill("fixture-replacement");
  await picker.click();
  await expect(options.first()).toContainText(current!.label);
  await expect(options.getByText(discovered, { exact: true })).toHaveCount(0);
  await picker.click();
  await settings.getByLabel("Replace API key", { exact: true }).clear();
  await picker.click();
  await listbox.getByRole("option", { name: discovered, exact: true }).click();
  await expect(picker).toHaveText(discovered);
  const replacementKey = settings.getByLabel("Replace API key", { exact: true });
  await replacementKey.fill("fixture-replacement");
  await expect(picker).toHaveText(current!.label);
  const panel = settings.getByTestId("model-settings-panel");
  await panel.locator("summary").click();
  await panel.getByLabel("Maximum output tokens", { exact: true }).fill("512");
  const advancedWrite = page.waitForRequest("**/rpc/models/saveModelSettings");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  expect((await advancedWrite).postDataJSON().json).toMatchObject({
    credentialId: saved.id,
    modelId: current!.id,
    settings: { maxTokens: 512 },
  });
  await expect(panel.getByRole("status")).toHaveText("Saved.");
  await replacementKey.clear();
  await expect(picker).toHaveText(discovered);
  await expect(settings.getByRole("button", { name: "Save limits", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a1-discovered-api-key-model");
  const testModel = settings.getByRole("button", { name: "Test model", exact: true });
  await testModel.click();
  const accepted = settings
    .getByRole("status")
    .filter({ hasText: "The model accepted the test request." });
  await expect(accepted).toBeInViewport({ ratio: 0.98 });
  const expectedTarget = {
    provider: "openai",
    modelId: discovered,
    credentialId: saved.id,
    expectedRevision: saved.connectionRevision,
  };
  expect(tested).toEqual([expectedTarget]);
  await captureScreenshot(page, testInfo, "a1-discovered-model-accepted");
  let choice: unknown;
  await page.route("**/rpc/models/setDefault", async (route) => {
    choice = route.request().postDataJSON().json;
    savedDiscovery = true;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await settings.getByRole("button", { name: "Use this model", exact: true }).click();
  await expect
    .poll(() => choice)
    .toMatchObject({
      provider: "openai",
      modelId: discovered,
      modelCredentialId: saved.id,
      expectedRevision: saved.connectionRevision,
    });
  await expect(settings.getByText(`Now using ${discovered}.`, { exact: true })).toBeVisible();
  await replacementKey.fill("fixture-qualified-replacement");
  await expect(picker).toHaveText(discovered);
  await expect(
    settings.getByText("Connecting sends one test request that may incur usage charges."),
  ).toBeVisible();
  await testModel.click();
  await expect(accepted).toBeInViewport({ ratio: 0.98 });
  expect(tested).toEqual([
    expectedTarget,
    { ...expectedTarget, apiKey: "fixture-qualified-replacement" },
  ]);
});

for (const notListed of [true, false]) {
  test(`retains a saved model that needs confirmation (${notListed ? "missing" : "listed"})`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `saved-directory-${Date.now()}@example.test`,
      "password12",
      "Directory fixture",
    );
    await completeOnboarding(page);
    const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
    const bundled = catalog.find((entry) => entry.provider === "openai" && entry.catalogProbe)!;
    const modelId = "gpt-fixture-saved-directory-model";
    const saved = await rpc<ModelCredential>(page, "models/connect", {
      provider: "openai",
      apiKey: "fixture-saved-directory-key",
      modelId: bundled.id,
    });
    let choice: Record<string, unknown> | undefined;
    let listedAgain = !notListed;
    let failSettingsReadback = false;
    await page.route("**/rpc/me", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({
        response,
        json: {
          json: {
            ...payload.json,
            defaultProvider: "openai",
            defaultModel: choice?.modelId ?? modelId,
            defaultModelCredentialId: saved.id,
          },
        },
      });
    });
    await page.route("**/rpc/models/credentials", async (route) => {
      if (
        failSettingsReadback &&
        route.request().postDataJSON()?.json?.includeProviderCatalog === true
      ) {
        await route.abort("failed");
        return;
      }
      const response = await route.fetch();
      const payload = (await response.json()) as { json: ModelCredential[] };
      const json = payload.json.map((item) =>
        item.id === saved.id
          ? {
              ...item,
              modelId: choice?.modelId ?? modelId,
              ...(!choice
                ? {
                    savedModelDirectory: {
                      confirmationRequired: true,
                      ...(!listedAgain ? { notListed: true } : {}),
                    },
                  }
                : {
                    savedProviderCatalogModelIds: [modelId],
                  }),
            }
          : item,
      );
      await route.fulfill({ response, json: { json } });
    });
    await page.route("**/rpc/models/setDefault", async (route) => {
      choice = route.request().postDataJSON().json;
      await route.fulfill({ json: { json: { ok: true } } });
    });
    const settings = await openUserSettings(page, "models");
    await settings.getByPlaceholder("Search providers").fill("openai");
    await settings
      .getByRole("button")
      .filter({ has: page.getByText("OpenAI", { exact: true }) })
      .click();
    const picker = settings.getByRole("combobox", { name: "Model", exact: true });
    const useModel = settings.getByRole("button", { name: "Use this model", exact: true });
    await expect(picker).toHaveText(modelId);
    const message = notListed
      ? "This model is missing from the provider’s list. You can choose another model."
      : "Confirm this model for the current API key, or choose another.";
    await expect(settings.getByText(message, { exact: true })).toBeVisible();
    if (!notListed) {
      await page.route("**/rpc/models/probeCatalog", async (route) => {
        listedAgain = false;
        await route.fulfill({ json: { json: { models: [bundled.id], catalogUpdated: true } } });
      });
      await settings.getByRole("button", { name: "Check models", exact: true }).click();
      await expect(
        settings.getByRole("status").filter({ hasText: "missing from the provider’s list" }),
      ).toBeVisible();
      await page.unroute("**/rpc/models/probeCatalog");
    }
    if (!listedAgain) {
      await expect(useModel).toBeDisabled();
      if (notListed)
        await captureScreenshot(page, testInfo, "a1-saved-model-missing-from-directory");
      await picker.click();
      await settings.getByRole("option", { name: bundled.label, exact: true }).click();
      await expect(useModel).toBeEnabled();
      await picker.click();
      await settings.getByRole("option", { name: modelId, exact: true }).click();
      await expect(useModel).toBeDisabled();
      await page.route("**/rpc/models/probeCatalog", async (route) => {
        listedAgain = true;
        await route.fulfill({
          json: { json: { models: [bundled.id, modelId], catalogUpdated: true } },
        });
      });
      const checkModels = settings.getByRole("button", { name: "Check models", exact: true });
      if (notListed) {
        failSettingsReadback = true;
        await checkModels.click();
        const loadError = settings.getByRole("alert").filter({
          hasText: "Could not load model settings",
        });
        await expect(loadError).toBeInViewport({ ratio: 1 });
        await expect(settings.getByText("Chat was not tested.", { exact: false })).toHaveCount(0);
        await expect(picker).toHaveText(modelId);
        await expect(useModel).toBeDisabled();
        await captureScreenshot(page, testInfo, "a1-model-catalog-refresh-failure");
        failSettingsReadback = false;
      }
      await checkModels.click();
      await expect(
        settings.getByText("Confirm this model for the current API key, or choose another.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(settings.getByText("Could not load model settings")).toHaveCount(0);
    }
    await expect(useModel).toBeEnabled();
    await useModel.click();
    await expect
      .poll(() => choice)
      .toMatchObject({
        provider: "openai",
        modelId,
        modelCredentialId: saved.id,
        expectedRevision: saved.connectionRevision,
      });
    expect(choice).not.toHaveProperty("updateThinkingLevelOnly");
    await expect(settings.getByText(`Now using ${modelId}.`, { exact: true })).toBeVisible();
    await expect(settings.getByText(message, { exact: true })).toHaveCount(0);
  });
}

for (const inferenceStatus of ["timeout", "accepted"] as const) {
  test(`checks the replacement key while connecting a model after ${inferenceStatus}`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `connect-model-check-${Date.now()}@example.test`,
      "password12",
      "Model fixture",
    );
    await completeOnboarding(page);
    const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
    const model = catalog.find((entry) => entry.provider === "openai" && entry.catalogProbe)!;
    const saved = await rpc<ModelCredential>(page, "models/connect", {
      provider: model.provider,
      apiKey: "fixture-existing-key",
      modelId: model.id,
    });
    await page.route("**/rpc/models/list", async (route) => {
      const response = await route.fetch();
      const { json } = (await response.json()) as { json: ModelCatalogEntry[] };
      await route.fulfill({
        response,
        json: {
          json: json.map((entry) =>
            entry.id === model.id && entry.provider === model.provider
              ? { ...entry, inferenceProbe: true }
              : entry,
          ),
        },
      });
    });
    const attempts: unknown[] = [];
    let refuse = true;
    let releaseRejection!: () => void;
    const pendingRejection = new Promise<void>((resolve) => {
      releaseRejection = resolve;
    });
    let savedReplacement = false;
    await page.route("**/rpc/models/credentials", (route) =>
      savedReplacement
        ? route.fulfill({
            status: 503,
            json: { json: { code: "SERVICE_UNAVAILABLE", status: 503 } },
          })
        : route.continue(),
    );
    await page.route("**/rpc/models/connect", async (route) => {
      attempts.push(route.request().postDataJSON().json);
      if (refuse) {
        await pendingRejection;
        await route.fulfill({
          status: 400,
          json: {
            json: {
              defined: true,
              code: "BAD_REQUEST",
              status: 400,
              message: "The test rejected this key.",
              data: { inferenceStatus: "auth" },
            },
          },
        });
        return;
      }
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const { json } = await response.json();
      savedReplacement = true;
      await route.fulfill({ response, json: { json: { ...json, inferenceStatus } } });
    });

    const settings = await openUserSettings(page, "models");
    await settings.getByPlaceholder("Search providers").fill("openai");
    await settings
      .getByRole("button")
      .filter({ has: page.getByText("OpenAI", { exact: true }) })
      .click();
    const cost = settings.getByText(
      "Connecting sends one test request that may incur usage charges.",
    );
    await expect(cost).toHaveCount(0);
    const key = settings.getByLabel("Replace API key", { exact: true });
    await key.fill("fixture-connect-replacement-key");
    const replace = settings.getByRole("button", { name: "Replace API key", exact: true });
    await expect(cost).toBeInViewport({ ratio: 1 });
    if (inferenceStatus === "timeout")
      await captureScreenshot(page, testInfo, "a1-connection-test-usage");
    await replace.click();
    await expect(key).toBeDisabled();
    await expect(settings.getByRole("combobox", { name: "Model", exact: true })).toBeDisabled();
    releaseRejection();
    await expect(
      settings.getByRole("alert").filter({ hasText: "rejected the API key" }),
    ).toBeVisible();
    await expect(key).toHaveValue("fixture-connect-replacement-key");
    expect(attempts).toEqual([
      expect.objectContaining({
        provider: model.provider,
        modelId: model.id,
        apiKey: "fixture-connect-replacement-key",
        credentialId: saved.id,
        expectedRevision: saved.connectionRevision,
        verifyInference: true,
      }),
    ]);
    const afterRejection = await rpc<ModelCredential[]>(page, "models/credentials", {});
    expect(afterRejection.find((entry) => entry.id === saved.id)?.connectionRevision).toBe(
      saved.connectionRevision,
    );

    refuse = false;
    await replace.click();
    await expect(
      settings.getByRole("status").filter({
        hasText:
          inferenceStatus === "timeout" ? "Saved. Your model provider took too long" : /^Saved\.$/,
      }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      settings.getByRole("alert").filter({ hasText: "Could not load model settings" }),
    ).toBeVisible();
    await expect(key).toHaveValue("");
    await expect(cost).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    const afterTimeout = await rpc<ModelCredential[]>(page, "models/credentials", {});
    expect(afterTimeout.find((entry) => entry.id === saved.id)?.connectionRevision).toBe(
      saved.connectionRevision! + 1,
    );
    if (inferenceStatus === "timeout")
      await captureScreenshot(page, testInfo, "a1-connection-test-saved-timeout");
  });
}

test("onboarding submits the exact draft directory model and preserves a rejected choice", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: true } },
    });
  });
  await page.route("**/rpc/models/list", async (route) => {
    const response = await route.fetch();
    const { json } = (await response.json()) as { json: Array<{ provider: string }> };
    await route.fulfill({
      response,
      json: {
        json: json.map((entry) =>
          entry.provider === "openai" ? { ...entry, inferenceProbe: true } : entry,
        ),
      },
    });
  });

  await signup(
    page,
    `onboarding-directory-${Date.now()}@example.test`,
    "password12",
    "Model fixture",
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();

  const modelId = "gpt-fixture-onboarding-directory";
  const draftKey = "fixture-onboarding-openai-key";
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await page.route("**/rpc/models/probeCatalog", (route) => {
    expect(route.request().postDataJSON().json).toEqual({ provider: "openai", apiKey: draftKey });
    return route.fulfill({ json: { json: { models: [modelId], draftModelIds: [modelId] } } });
  });
  await page.getByLabel("API key", { exact: true }).fill(draftKey);
  const testKey = page.getByRole("button", { name: "Test API key", exact: true });
  await testKey.click();
  await expect(testKey).toBeEnabled();
  await model.click();
  await page.getByRole("option", { name: modelId, exact: true }).click();
  await expect(model).toContainText(modelId);
  await expect(
    page.getByText("Connecting sends one test request that may incur usage charges."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "a1-onboarding-first-directory-model");
  await page.route("**/rpc/models/connect", (route) => {
    expect(route.request().postDataJSON().json).toMatchObject({
      provider: "openai",
      apiKey: draftKey,
      modelId,
      verifyInference: true,
    });
    return route.fulfill({
      status: 400,
      json: {
        json: {
          defined: true,
          code: "BAD_REQUEST",
          status: 400,
          message: "Could not check the model.",
          data: { inferenceStatus: "model" },
        },
      },
    });
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("This key cannot use the selected model.")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue(draftKey);
  await expect(model).toContainText(modelId);
});

test("onboarding reports a timed out model check after saving", async ({ page }, testInfo) => {
  let connects = 0;
  let releaseCheck!: () => void;
  const pendingCheck = new Promise<void>((resolve) => {
    releaseCheck = resolve;
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const { json } = await response.json();
    await route.fulfill({
      response,
      json: {
        json: connects === 0 ? { ...json, needsModel: true, defaultProvider: "openai" } : json,
      },
    });
  });
  await page.route("**/rpc/models/list", async (route) => {
    const response = await route.fetch();
    const { json } = (await response.json()) as { json: ModelCatalogEntry[] };
    await route.fulfill({
      response,
      json: {
        json: json.map((entry) =>
          entry.provider === "openai" && entry.catalogProbe
            ? { ...entry, inferenceProbe: true, thinkingLevels: ["off", "low", "medium"] }
            : entry,
        ),
      },
    });
  });
  await page.route("**/rpc/models/connect", async (route) => {
    connects += 1;
    expect(route.request().postDataJSON().json).toMatchObject({
      provider: "openai",
      apiKey: "fixture-onboarding-model-key",
      verifyInference: true,
    });
    await pendingCheck;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const { json } = await response.json();
    await route.fulfill({ response, json: { json: { ...json, inferenceStatus: "timeout" } } });
  });

  await signup(
    page,
    `onboard-model-check-${Date.now()}@example.test`,
    "password12",
    "Model fixture",
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByLabel("API key", { exact: true }).fill("fixture-onboarding-model-key");
  await expect(
    page.getByText("Connecting sends one test request that may incur usage charges."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toBeDisabled();
  releaseCheck();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. The model test timed out." }),
  ).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a1-onboarding-model-check-saved-timeout");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeOnboarding(page);
  expect(connects).toBe(1);
});

test("keeps the compatible model draft fixed while onboarding saves it", async ({ page }) => {
  const baseUrl = "http://127.0.0.1:11434/v1";
  let connects = 0;
  let releaseSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const { json } = await response.json();
    await route.fulfill({
      response,
      json: {
        json:
          connects === 0
            ? { ...json, needsModel: true, defaultProvider: "openai-compatible" }
            : json,
      },
    });
  });
  await page.route("**/rpc/models/probeOpenAiCompatible", (route) =>
    route.fulfill({ json: { json: { models: ["fixture-compatible-discovered"] } } }),
  );
  await page.route("**/rpc/models/connect", async (route) => {
    connects += 1;
    const { json } = route.request().postDataJSON();
    expect(json).toMatchObject({
      provider: "openai-compatible",
      baseUrl,
      modelId: "fixture-compatible-custom",
      apiKey: "fixture-compatible-key",
    });
    expect(json).not.toHaveProperty("verifyInference");
    await pendingSave;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ response });
  });
  await signup(
    page,
    `onboarding-compatible-${Date.now()}@example.test`,
    "password12",
    "Model fixture",
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  const url = page.getByLabel("OpenAI-compatible server URL");
  await url.fill(baseUrl);
  await page
    .locator("summary")
    .filter({ hasText: /^API key$/ })
    .click();
  const key = page.getByLabel("API key", { exact: true });
  await key.fill("fixture-compatible-key");
  await page.getByRole("button", { name: "Find models" }).click();
  await page.getByRole("combobox", { name: "Models from server" }).click();
  await page.getByRole("option", { name: "Other model…" }).click();
  const model = page.getByLabel("Model id", { exact: true });
  await model.fill("fixture-compatible-custom");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(url).toBeDisabled();
  await expect(model).toBeDisabled();
  await expect(key).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use a found model" })).toBeDisabled();
  releaseSave();
  await completeOnboarding(page);
  expect(connects).toBe(1);
});

for (const { provider, providerName, prefix, screenshot } of [
  {
    provider: "openai",
    providerName: "OpenAI",
    prefix: "gpt",
    screenshot: "a1-first-directory-model",
  },
  {
    provider: "xai",
    providerName: "xAI",
    prefix: "grok",
    screenshot: "a1-xai-first-directory-model",
  },
  {
    provider: "deepseek",
    providerName: "DeepSeek",
    prefix: "deepseek",
    screenshot: "a1-deepseek-first-directory-model",
  },
  {
    provider: "groq",
    providerName: "Groq",
    prefix: "fixture-vendor/chat",
    screenshot: "a1-groq-first-directory-model",
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    prefix: "claude",
    screenshot: "a1-anthropic-first-directory-model",
  },
  {
    provider: "google",
    providerName: "Google",
    prefix: "gemini",
    screenshot: "a1-google-first-directory-model",
  },
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    prefix: "fixture-vendor/chat",
    screenshot: "a1-openrouter-first-directory-model",
  },
]) {
  test(`selects and tests the ${providerName} directory model before the first API key save`, async ({
    page,
  }, testInfo) => {
    await signup(page, `first-model-${Date.now()}@example.test`, "password12", "Model fixture");
    await completeOnboarding(page);
    const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
    const base = catalog.find((entry) => entry.provider === provider && entry.catalogProbe)!;
    const modelId = `${prefix}-fixture-directory-choice`;
    const draftKey = `fixture-first-${provider}-key`;
    let draftModelIds = [modelId];
    await page.route("**/rpc/models/list", async (route) => {
      const response = await route.fetch();
      const { json } = (await response.json()) as { json: ModelCatalogEntry[] };
      await route.fulfill({
        response,
        json: {
          json: json.map((entry) =>
            entry.id === base.id && entry.provider === base.provider
              ? { ...entry, inferenceProbe: true }
              : entry,
          ),
        },
      });
    });
    await page.route("**/rpc/models/probeCatalog", (route) => {
      const { apiKey } = route.request().postDataJSON().json;
      return route.fulfill({
        json: {
          json:
            apiKey === draftKey
              ? {
                  models: [base.id, ...draftModelIds],
                  ...(draftModelIds.length ? { draftModelIds } : {}),
                }
              : { models: [base.id] },
        },
      });
    });
    await page.route("**/rpc/models/probeInference", (route) =>
      route.fulfill({ json: { json: { status: "accepted" } } }),
    );
    await page.route("**/rpc/models/connect", (route) =>
      route.fulfill({
        status: 400,
        json: {
          json: {
            defined: true,
            code: "BAD_REQUEST",
            status: 400,
            message: "Could not check the model.",
            data: { inferenceStatus: "model" },
          },
        },
      }),
    );
    const settings = await openUserSettings(page, "models");
    await settings.getByPlaceholder("Search providers").fill(providerName);
    await settings
      .getByRole("button")
      .filter({ has: page.getByText(providerName, { exact: true }) })
      .click();
    const key = settings.getByLabel(/^(?:Or connect an )?API key$/);
    const picker = settings.getByRole("combobox", { name: "Model", exact: true });
    const option = settings.getByRole("option", { name: modelId, exact: true });
    const testKey = settings.getByRole("button", { name: "Test API key", exact: true });
    await key.fill(draftKey);
    await testKey.click();
    await expect(testKey).toBeEnabled();
    await picker.click();
    await option.click();
    await expect(picker).toHaveText(modelId);
    if (provider === "xai") {
      await expect(settings.getByText(/Sign in with SuperGrok or X Premium, or paste/)).toHaveCount(
        0,
      );
    } else if (provider !== "anthropic") {
      await expect(
        settings.getByText(`Uses your ${providerName} API key`, { exact: false }),
      ).toBeVisible();
    }
    const connect = settings.getByRole("button", { name: "Connect API key", exact: true });
    for (const observed of [[`${prefix}-fixture-other-directory-choice`], []]) {
      draftModelIds = observed;
      await testKey.click();
      await expect(testKey).toBeEnabled();
      await expect(picker).toHaveText(modelId);
      await expect(connect).toBeDisabled();
      await expect(
        settings.getByText("Confirm this model for the current API key, or choose another."),
      ).toBeVisible();
    }
    draftModelIds = [modelId];

    await key.fill(`fixture-different-${provider}-key`);
    await picker.click();
    await expect(option).toHaveCount(0);
    await picker.click();
    await key.fill(draftKey);
    await testKey.click();
    await expect(testKey).toBeEnabled();
    await picker.click();
    await option.click();
    const tested = page.waitForRequest("**/rpc/models/probeInference");
    await settings.getByRole("button", { name: "Test model", exact: true }).click();
    expect((await tested).postDataJSON().json).toEqual({
      provider: base.provider,
      apiKey: draftKey,
      modelId,
    });
    await expect(
      settings.getByRole("status").filter({ hasText: "accepted the test request" }),
    ).toBeVisible();
    await connect.evaluate((button) => button.scrollIntoView({ block: "center" }));
    const fee = settings.getByText(
      "Connecting sends one test request that may incur usage charges.",
    );
    await expect(fee).toBeInViewport({ ratio: 0.98 });
    await captureScreenshot(page, testInfo, screenshot);
    const saving = page.waitForRequest("**/rpc/models/connect");
    await connect.click();
    expect((await saving).postDataJSON().json).toMatchObject({
      provider: base.provider,
      apiKey: draftKey,
      modelId,
      verifyInference: true,
    });
    await expect(
      settings.getByRole("alert").filter({ hasText: "cannot use the selected model" }),
    ).toBeVisible();
    await expect(key).toHaveValue(draftKey);
    await expect(picker).toHaveText(modelId);
  });
}

test("tests model access with the selected saved or draft API key", async ({ page }, testInfo) => {
  await signup(page, `model-access-${Date.now()}@example.test`, "password12", "Model fixture");
  await completeOnboarding(page);
  const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
  const model = catalog.find((entry) => entry.provider === "openai" && entry.catalogProbe)!;
  const saved = await rpc<ModelCredential>(page, "models/connect", {
    provider: model.provider,
    apiKey: "fixture-saved-inference-key",
    modelId: model.id,
  });
  await page.route("**/rpc/models/list", async (route) => {
    const response = await route.fetch();
    const { json } = (await response.json()) as { json: ModelCatalogEntry[] };
    await route.fulfill({
      response,
      json: {
        json: json.map((entry) =>
          entry.id === model.id && entry.provider === model.provider
            ? { ...entry, inferenceProbe: true }
            : entry,
        ),
      },
    });
  });
  const requests: unknown[] = [];
  let connectionChanged = false;
  await page.route("**/rpc/models/probeInference", async (route) => {
    const input = route.request().postDataJSON().json;
    requests.push(input);
    if (connectionChanged) {
      await route.fulfill({
        status: 409,
        json: {
          json: {
            defined: false,
            code: "CONFLICT",
            status: 409,
            message: "Model connection changed. Reload and try again.",
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { json: { status: input.apiKey ? "auth" : "accepted" } } });
  });
  await page.route("**/rpc/models/probeCatalog", (route) =>
    route.fulfill({ json: { json: { models: [model.id] } } }),
  );

  const settings = await openUserSettings(page, "models");
  await settings.getByPlaceholder("Search providers").fill("openai");
  await settings
    .getByRole("button")
    .filter({ has: page.getByText("OpenAI", { exact: true }) })
    .click();
  await settings.getByRole("button", { name: "Check models", exact: true }).click();
  await expect(settings.getByText("Chat was not tested.", { exact: false })).toBeVisible();
  expect(requests).toEqual([]);

  const testModel = settings.getByRole("button", { name: "Test model", exact: true });
  await testModel.click();
  const accepted = settings.getByRole("status").filter({ hasText: "accepted the test request" });
  await expect(accepted).toBeInViewport({ ratio: 1 });
  expect(requests).toEqual([
    {
      provider: model.provider,
      modelId: model.id,
      credentialId: saved.id,
      expectedRevision: saved.connectionRevision,
    },
  ]);
  await captureScreenshot(page, testInfo, "a1-model-inference-accepted");

  connectionChanged = true;
  await testModel.click();
  await expect(
    settings.getByRole("alert").filter({
      hasText: "Model connection changed. Reload and try again.",
    }),
  ).toBeInViewport({ ratio: 1 });
  await expect(accepted).toHaveCount(0);
  connectionChanged = false;

  const draft = settings.getByLabel("Replace API key", { exact: true });
  await draft.fill("fixture-draft-inference-key");
  await testModel.click();
  await expect(
    settings.getByRole("alert").filter({ hasText: "rejected the API key" }),
  ).toBeInViewport({ ratio: 1 });
  await expect(draft).toHaveValue("fixture-draft-inference-key");
  expect(requests[2]).toEqual({
    provider: model.provider,
    modelId: model.id,
    apiKey: "fixture-draft-inference-key",
  });

  await settings.getByTestId("settings-nav-general").click();
  await settings.getByTestId("ui-locale-select").click();
  await settings.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await settings.getByTestId("settings-nav-models").click();
  await settings.getByPlaceholder("搜索提供方").fill("openai");
  await settings
    .getByRole("button")
    .filter({ has: page.getByText("OpenAI", { exact: true }) })
    .click();
  const localizedTest = settings.getByRole("button", { name: "测试模型", exact: true });
  const localizedDraft = settings.getByLabel("替换 API 密钥", { exact: true });
  await localizedDraft.fill("");
  await localizedTest.click();
  await expect(
    settings.getByRole("status").filter({ hasText: "模型已接收测试请求。" }),
  ).toBeInViewport({
    ratio: 1,
  });

  connectionChanged = true;
  await localizedTest.click();
  await expect(
    settings.getByRole("alert").filter({ hasText: "模型连接已更改，请重新加载后重试。" }),
  ).toBeInViewport({ ratio: 1 });
  await captureScreenshot(page, testInfo, "a1-model-inference-connection-changed");

  connectionChanged = false;
  await localizedDraft.fill("fixture-draft-inference-key");
  await localizedTest.click();
  await expect(
    settings
      .getByRole("alert")
      .filter({ hasText: "你的模型提供商拒绝了 API 密钥。请检查连接设置。" }),
  ).toBeInViewport({ ratio: 1 });
});

for (const { provider, providerName, modelId, rejection, rejectionText, variant } of [
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    modelId: "openai/gpt-oss-120b",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    modelId: "anthropic/claude-sonnet-4.6",
    rejection: "spending",
    rejectionText: /spending limit/,
    variant: "Messages",
  },
  {
    provider: "groq",
    providerName: "Groq",
    modelId: "openai/gpt-oss-120b",
    rejection: "auth",
    rejectionText: /rejected the API key/,
  },
  {
    provider: "together",
    providerName: "Together",
    modelId: "openai/gpt-oss-120b",
    rejection: "model",
    rejectionText: /cannot use the selected model/,
  },
  {
    provider: "cerebras",
    providerName: "Cerebras",
    modelId: "qwen-3.8-27b",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "moonshotai",
    providerName: "Moonshot AI",
    modelId: "kimi-k3",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "moonshotai-cn",
    providerName: "Moonshot AI CN",
    modelId: "kimi-k3",
    rejection: "auth",
    rejectionText: /rejected the API key/,
  },
  {
    provider: "kimi-coding",
    providerName: "Kimi For Coding",
    modelId: "k3-256k",
    rejection: "spending",
    rejectionText: /spending limit/,
  },
  {
    provider: "minimax",
    providerName: "MiniMax",
    modelId: "MiniMax-M3",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "fireworks",
    providerName: "Fireworks",
    modelId: "accounts/fireworks/models/gpt-oss-120b",
    rejection: "model",
    rejectionText: /cannot use the selected model/,
  },
  {
    provider: "fireworks",
    providerName: "Fireworks",
    variant: "Chat",
    modelId: "accounts/fireworks/models/glm-5p3",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "vercel-ai-gateway",
    providerName: "Vercel AI Gateway",
    modelId: "anthropic/claude-haiku-4.5",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "vercel-ai-gateway",
    providerName: "Vercel AI Gateway",
    variant: "DeepSeek",
    modelId: "deepseek/deepseek-v4.1-flash",
    rejection: "model",
    rejectionText: /cannot use the selected model/,
  },
  {
    provider: "vercel-ai-gateway",
    providerName: "Vercel AI Gateway",
    variant: "Gemini",
    modelId: "google/gemini-3.8-flash",
    rejection: "spending",
    rejectionText: /spending limit/,
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    modelId: "claude-haiku-5-5",
    rejection: "model",
    rejectionText: /cannot use the selected model/,
  },
  {
    provider: "xai",
    providerName: "xAI",
    modelId: "grok-4.7",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-flash",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
  {
    provider: "google",
    providerName: "Google",
    modelId: "gemini-3.8-flash",
    rejection: "credit",
    rejectionText: /billing settings and available credits/,
  },
] as const) {
  const testLabel = variant ? `${providerName} ${variant}` : providerName;
  const screenshotPrefix = variant ? `${provider}-${variant.toLowerCase()}` : provider;
  test(`offers the ${testLabel} model test and checks the replacement key before saving`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `provider-check-${screenshotPrefix}-${Date.now()}@example.test`,
      "password12",
      "Model fixture",
    );
    await completeOnboarding(page);
    const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", {});
    const model = catalog.find((entry) => entry.provider === provider && entry.id === modelId)!;
    const saved = await rpc<ModelCredential>(page, "models/connect", {
      provider: model.provider,
      apiKey: "fixture-gateway-saved-key",
      modelId: model.id,
    });
    await page.route("**/rpc/models/list", async (route) => {
      const response = await route.fetch();
      const { json } = (await response.json()) as { json: ModelCatalogEntry[] };
      await route.fulfill({
        response,
        json: {
          json: json.map((entry) =>
            entry.id === model.id && entry.provider === model.provider
              ? { ...entry, inferenceProbe: true }
              : entry,
          ),
        },
      });
    });
    await page.route("**/rpc/models/probeInference", (route) =>
      route.fulfill({ json: { json: { status: "accepted" } } }),
    );
    await page.route("**/rpc/models/connect", (route) =>
      route.fulfill({
        status: 400,
        json: {
          json: {
            defined: true,
            code: "BAD_REQUEST",
            status: 400,
            message: "Could not check the model.",
            data: { inferenceStatus: rejection },
          },
        },
      }),
    );

    const settings = await openUserSettings(page, "models");
    await settings.getByPlaceholder("Search providers").fill(providerName);
    await settings
      .getByRole("button")
      .filter({ has: page.getByText(providerName, { exact: true }) })
      .click();
    if (provider === "google" || provider === "anthropic") {
      await expect(
        settings.getByRole("button", { name: "Check models", exact: true }),
      ).toBeVisible();
    }
    const tested = page.waitForRequest("**/rpc/models/probeInference");
    await settings.getByRole("button", { name: "Test model", exact: true }).click();
    expect((await tested).postDataJSON().json).toEqual({
      provider: model.provider,
      modelId: model.id,
      credentialId: saved.id,
      expectedRevision: saved.connectionRevision,
    });
    await expect(
      settings.getByRole("status").filter({ hasText: "accepted the test request" }),
    ).toBeInViewport({ ratio: 0.98 });
    await captureScreenshot(page, testInfo, `a1-${screenshotPrefix}-model-test-accepted`);

    const draft = settings.getByLabel("Replace API key", { exact: true });
    const newKey = "fixture-gateway-replacement-key";
    await draft.fill(newKey);
    const submit = settings.getByRole("button", { name: "Replace API key", exact: true });
    await submit.evaluate((button) => button.scrollIntoView({ block: "center" }));
    await expect(
      settings.getByText("Connecting sends one test request that may incur usage charges."),
    ).toBeInViewport({ ratio: 0.98 });
    const replacing = page.waitForRequest("**/rpc/models/connect");
    await submit.click();
    expect((await replacing).postDataJSON().json).toMatchObject({
      provider: model.provider,
      modelId: model.id,
      credentialId: saved.id,
      expectedRevision: saved.connectionRevision,
      apiKey: newKey,
      verifyInference: true,
    });
    const refusal = settings.getByRole("alert").filter({ hasText: rejectionText });
    await expect(refusal).toBeVisible();
    await expect(draft).toHaveValue(newKey);
    if (provider === "vercel-ai-gateway" && rejection === "credit") {
      await refusal.scrollIntoViewIfNeeded();
      await expect(refusal).toBeInViewport({ ratio: 0.98 });
      await captureScreenshot(page, testInfo, "a1-vercel-ai-gateway-model-billing-refusal");
    }
  });
}
