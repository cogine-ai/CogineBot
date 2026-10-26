import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openIntegrations, signup } from "./helpers";

// Synthetic responses isolate the review UI; API/transaction coverage lives in API tests.
const mixedPreview = {
  status: "ready",
  target: "https://api.example.test/v1",
  operations: [{ id: "listItems", method: "GET", path: "/items", readOnly: true }],
  diagnostics: [
    {
      scope: "operation",
      code: "external_reference",
      operationId: "createItem",
      method: "POST",
      path: "/items",
      pointer: "#/paths/~1items/post/requestBody",
    },
  ],
  counts: { discovered: 2, accepted: 1, rejected: 1, omittedDiagnostics: 0 },
  reviewToken: "synthetic-review-one",
  expiresAt: "2099-01-01T00:00:00Z",
};
const install = {
  id: "synthetic-api-install",
  kind: "api",
  name: "Inventory API",
  source: "https://example.test/openapi.yaml",
  version: "1.0.0",
  digest: "synthetic-digest",
  secretConfigured: false,
  config: {},
  createdAt: "2026-01-01T00:00:00Z",
};

async function openImport(page: Page) {
  const stamp = Date.now();
  await signup(page, `openapi-${stamp}@rakazo.test`, "password12", `OpenAPI ${stamp}`);
  await completeOnboarding(page);
  await openIntegrations(page);
  const advanced = page.getByTestId("integrations-advanced");
  await advanced.locator("summary").click();
  await advanced.getByRole("button", { name: "Add OpenAPI", exact: true }).click();
  await advanced.getByPlaceholder("Display name").fill(install.name);
  await advanced.getByPlaceholder("https://example.com/openapi.json").fill(install.source);
  return advanced;
}

test("OpenAPI review shows accepted and rejected operations before one explicit installation", async ({
  page,
}, testInfo) => {
  let installed = false;
  let confirmations = 0;
  await page.route("**/rpc/capabilities/list", (route) =>
    route.fulfill({ json: { json: installed ? [install] : [] } }),
  );
  await page.route("**/rpc/capabilities/previewOpenApi", (route) =>
    route.fulfill({ json: { json: mixedPreview } }),
  );
  await page.route("**/rpc/capabilities/confirmOpenApi", (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.reviewToken).toBe(mixedPreview.reviewToken);
    expect(input.source).toBe(install.source);
    confirmations += 1;
    installed = true;
    return route.fulfill({ json: { json: { status: "installed", install, replayed: false } } });
  });
  const advanced = await openImport(page);
  await advanced.getByRole("button", { name: "Preview", exact: true }).click();
  const review = page.getByTestId("openapi-import-review");
  await expect(review.getByText("Ready · 1", { exact: true })).toBeVisible();
  await expect(review.getByText("listItems", { exact: true })).toBeVisible();
  await expect(review.getByText("createItem", { exact: true })).toBeVisible();
  await expect(
    review.getByText("External references are not supported.", { exact: true }),
  ).toBeVisible();
  expect(confirmations).toBe(0);
  await review.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "b23-openapi-review");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(review.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await review.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "b23-openapi-review-390");
  await page.setViewportSize({ width: 1280, height: 900 });
  await review.getByRole("button", { name: "Add", exact: true }).click();
  await expect(review).toBeHidden();
  await expect(advanced.getByText(install.name, { exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
  await advanced.getByText(install.name, { exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "b23-openapi-installed");
});

test("all-invalid OpenAPI review keeps operation diagnostics and offers no Add action", async ({
  page,
}, testInfo) => {
  let confirmations = 0;
  await page.route("**/rpc/capabilities/previewOpenApi", (route) =>
    route.fulfill({
      json: {
        json: {
          ...mixedPreview,
          status: "invalid",
          operations: [],
          reviewToken: null,
          expiresAt: null,
          counts: { discovered: 1, accepted: 0, rejected: 1, omittedDiagnostics: 2 },
        },
      },
    }),
  );
  await page.route("**/rpc/capabilities/confirmOpenApi", (route) => {
    confirmations += 1;
    return route.abort();
  });
  const advanced = await openImport(page);
  await advanced.getByRole("button", { name: "Preview", exact: true }).click();
  const review = page.getByTestId("openapi-import-review");
  await expect(review.getByText(/^Ready(?:\s|·|$)/)).toHaveCount(0);
  await expect(review.getByText("Not imported · 1", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Preview again", exact: true })).toBeVisible();
  await expect(review.getByText("createItem", { exact: true })).toBeVisible();
  await expect(
    review.getByText("Additional diagnostics omitted: 2", { exact: true }),
  ).toBeVisible();
  await expect(review.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  expect(confirmations).toBe(0);
  await review.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "b23-openapi-all-invalid");
});

test("a lost OpenAPI confirmation is checked read-only with its original token", async ({
  page,
}) => {
  let confirmations = 0;
  let checks = 0;
  await page.route("**/rpc/capabilities/list", (route) =>
    route.fulfill({ json: { json: checks ? [install] : [] } }),
  );
  await page.route("**/rpc/capabilities/previewOpenApi", (route) =>
    route.fulfill({ json: { json: mixedPreview } }),
  );
  await page.route("**/rpc/capabilities/confirmOpenApi", (route) => {
    confirmations += 1;
    return route.abort();
  });
  await page.route("**/rpc/capabilities/openApiReceipt", (route) => {
    expect(route.request().postDataJSON().json).toEqual({ reviewToken: mixedPreview.reviewToken });
    checks += 1;
    return route.fulfill({ json: { json: { status: "installed", install, replayed: true } } });
  });
  const advanced = await openImport(page);
  await advanced.getByRole("button", { name: "Preview", exact: true }).click();
  const review = page.getByTestId("openapi-import-review");
  await review.getByRole("button", { name: "Add", exact: true }).click();
  await expect(review.getByText("Could not confirm installation.", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(advanced.getByText(install.name, { exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
  expect(checks).toBe(1);
});
