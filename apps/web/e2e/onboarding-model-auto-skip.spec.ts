import { expect, test } from "@playwright/test";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("onboarding reports a timed out model check after saving", async ({ page }, testInfo) => {
  let connects = 0;
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
            ? { ...entry, inferenceProbe: true }
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
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. Your model provider took too long" }),
  ).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a1-onboarding-model-check-saved-timeout");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await completeOnboarding(page);
  expect(connects).toBe(1);
});

test("onboarding skips model connect when a default model is already available", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false } },
    });
  });

  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );

  const createRequest = page.waitForRequest("**/rpc/bots/create");
  const stamp = Date.now();
  await signup(
    page,
    `model-auto-skip-${stamp}@rakazo.test`,
    "password12",
    `Model auto skip ${stamp}`,
  );

  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  for (const name of ["Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }

  expect((await createRequest).postDataJSON()).toMatchObject({
    json: {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      spawnKey: "onboarding:first",
    },
  });
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  await captureScreenshot(page, testInfo, "onboarding-model-auto-skip");
});
