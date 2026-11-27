import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("onboarding preflight stays on the connection being tested", async ({ page }, testInfo) => {
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

  const stamp = Date.now();
  await signup(page, `preflight-${stamp}@rakazo.test`, "password12", `Preflight ${stamp}`);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider).toContainText("OpenRouter");
  await expect(page.getByRole("button", { name: "Test API key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test sign-in" })).toHaveCount(0);

  await provider.click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  await expect(page.getByRole("button", { name: "Test API key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test sign-in" })).toHaveCount(0);

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
  await captureScreenshot(page, testInfo, "onboarding-first-directory-model");
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

  await provider.click();
  await page.getByRole("option", { name: "Anthropic" }).click();
  await expect(page.getByRole("button", { name: "Test sign-in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test API key" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-model-preflight");

  let holdProbe = false;
  let releaseProbe = () => {};
  const probeHeld = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  await page.route("**/rpc/models/probeOpenAiCompatible", async (route) => {
    if (holdProbe) await probeHeld;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { models: ["listed-model"] } }),
    });
  });

  await provider.click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  const compatibleModelId = page.getByLabel("Model id");
  await compatibleModelId.fill("missing-model");
  await page.getByRole("button", { name: "Find models" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText("was not listed");
  await expect(page.getByText(/Found \d+ model/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-preflight-unavailable-model");

  holdProbe = true;
  const held = page.waitForRequest("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await held;
  await compatibleModelId.fill("missing-model-edited");
  await expect(alert).toHaveCount(0);
  releaseProbe();
  await expect(page.getByRole("button", { name: "Find models" })).toBeEnabled();
  await expect(alert).toHaveCount(0);
  await expect(page.getByText(/Found \d+ model/)).toHaveCount(0);
  await expect(page.getByText("was not listed")).toHaveCount(0);
});

test("settings preflight distinguishes a stored API key from sign-in", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `preflight-settings-${stamp}@rakazo.test`, "password12", `Settings ${stamp}`);
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "models");

  await page.getByPlaceholder("Search providers").fill("OpenRouter");
  await settings.getByRole("button").filter({ hasText: "OpenRouter" }).first().click();
  await expect(settings.getByRole("button", { name: "Test API key" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Test sign-in" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-model-preflight");

  let holdProbe = true;
  let releaseProbe = () => {};
  const probeHeld = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  await page.route("**/rpc/models/probeCatalog", async (route) => {
    if (holdProbe) await probeHeld;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { models: ["not-the-selected-model"] } }),
    });
  });

  const apiKey = settings.getByLabel(/API key/);
  await apiKey.fill("sk-openrouter-test");
  const held = page.waitForRequest("**/rpc/models/probeCatalog");
  await settings.getByRole("button", { name: "Test API key" }).click();
  await held;
  await apiKey.fill("sk-openrouter-edited");
  await expect(settings.getByText("Models list OK")).toHaveCount(0);
  releaseProbe();
  await expect(settings.getByRole("button", { name: "Test API key" })).toBeEnabled();
  await expect(settings.getByText("Models list OK")).toHaveCount(0);
  await expect(settings.getByText("was not listed")).toHaveCount(0);

  holdProbe = false;
  await settings.getByRole("button", { name: "Test API key" }).click();
  const catalogAlert = settings.getByRole("alert");
  await expect(catalogAlert).toHaveCount(1);
  await expect(catalogAlert).toContainText("was not listed");
  await expect(settings.getByText("Models list OK")).toHaveCount(0);

  await page.getByPlaceholder("Search providers").fill("Anthropic");
  await settings.getByRole("button").filter({ hasText: "Anthropic" }).first().click();
  await expect(settings.getByRole("button", { name: "Test sign-in" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Test API key" })).toHaveCount(0);
  await settings.getByLabel(/API key/).fill("sk-anthropic-test");
  await settings.getByRole("button", { name: "Connect API key" }).click();
  await expect(settings.getByText(/Connected and using/)).toBeVisible();
  await expect(settings.getByRole("button", { name: "Sign in again" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Sign in with Claude Pro/Max" })).toBeVisible();
  await settings.getByRole("button", { name: "Test sign-in" }).click();
  const signInAlert = settings.getByRole("alert");
  await expect(signInAlert).toContainText("An API key is stored");
  await expect(settings.getByText("A subscription credential is stored securely.")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-preflight-api-key");
});
