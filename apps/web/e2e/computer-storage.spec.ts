import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const target = "a".repeat(64);

test("opens storage while stopped and diagnoses only on request", async ({ page }, testInfo) => {
  await signup(page, `diagnosis-${Date.now()}@example.test`, "password12", "Storage fixture");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const inputs: unknown[] = [];
  let bootCalls = 0;
  await page.route("**/rpc/computer/boot", (route) => {
    bootCalls++;
    return route.abort();
  });
  // Exercise the real authenticated transport before substituting supported-provider data.
  const withoutCapability = await rpc<{ botId: string; outcome: { status: string } }>(
    page,
    "computer/diskUsage",
    { botId },
  );
  expect(withoutCapability.botId).toBe(botId);
  expect(["not_running", "unsupported"]).toContain(withoutCapability.outcome.status);
  await page.route("**/rpc/computer/diskUsage", (route) => {
    inputs.push(route.request().postDataJSON().json);
    return route.fulfill({
      json: {
        json: {
          botId,
          target,
          outcome:
            inputs.length === 1
              ? { status: "not_running" }
              : {
                  status: "available",
                  data: {
                    volume: {
                      totalBytes: 8 * 1024 ** 3,
                      availableBytes: 512 * 1024 ** 2,
                      availableInodes: 20,
                    },
                    candidates: [{ path: "reports/notes.pdf", logicalBytes: 64 * 1024 }],
                    partial: true,
                  },
                },
        },
      },
    });
  });

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Storage" });
  await expect(dialog).toBeVisible();
  expect(inputs).toEqual([]);
  await dialog.getByRole("button", { name: "Diagnose storage" }).click();
  await expect(dialog.getByText("Computer is not running.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await dialog.getByRole("button", { name: "Diagnose storage" }).click();
  await expect(dialog.getByText("512 MB available of 8 GB")).toBeVisible();
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("512 MB available of 8 GB")).toBeVisible();
  await expect(dialog.getByText("reports/notes.pdf")).toBeVisible();
  await expect(dialog.getByText("Partial results")).toBeVisible();
  expect(inputs).toEqual([{ botId }, { botId }, { botId, expectedTarget: target }]);
  expect(bootCalls).toBe(0);
  await captureScreenshot(page, testInfo, "computer-storage-diagnosis");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Storage", exact: true })).toBeFocused();
});

test("offers a target-bound recovery after a managed upload reports storage exhaustion", async ({
  page,
}, testInfo) => {
  await signup(page, `upload-diagnosis-${Date.now()}@example.test`, "password12", "Upload fixture");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect
    .poll(
      () =>
        rpc(page, "computer/takeover", { botId }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.route("**/rpc/computer/uploadFile", (route) =>
    route.fulfill({
      status: 507,
      json: {
        json: {
          defined: false,
          code: "COMPUTER_STORAGE_FULL",
          status: 507,
          message: "Not enough storage to upload this file.",
          data: { kind: "computer_storage", code: "ENOSPC", botId, expectedTarget: target },
        },
      },
    }),
  );
  const inputs: unknown[] = [];
  await page.route("**/rpc/computer/diskUsage", (route) => {
    inputs.push(route.request().postDataJSON().json);
    return route.fulfill({ json: { json: { botId, target, outcome: { status: "changed" } } } });
  });
  await page.getByTitle("Agent computer").click();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  const viewport = page.getByTestId("computer-viewport");
  await viewport.getByRole("button", { name: "Files", exact: true }).click();
  const files = viewport.getByTestId("computer-files");
  await files.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic upload"),
  });
  await expect(files.getByRole("alert")).toHaveText("Not enough storage to upload this file.");
  const recovery = files
    .getByRole("button", { name: "Storage", exact: true })
    .filter({ hasText: "Storage" });
  await expect(recovery).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-storage-recovery");
  await recovery.click();
  const dialog = page.getByRole("dialog", { name: "Storage" });
  expect(inputs).toEqual([]);
  await dialog.getByRole("button", { name: "Diagnose storage" }).click();
  await expect(dialog.getByText("Computer changed. Open Storage again.")).toBeVisible();
  expect(inputs).toEqual([{ botId, expectedTarget: target }]);

  await page.keyboard.press("Escape");
  await page.unroute("**/rpc/computer/uploadFile");
  const uploads: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/rpc/computer/uploadFile", async (route) => {
    uploads.push(route.request().postDataJSON().json.path);
    if (uploads.length === 1) await first;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await files.locator('input[type="file"]').setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  try {
    await expect.poll(() => uploads).toEqual(["first.txt"]);
    await viewport.getByRole("button", { name: "Browser", exact: true }).click();
    await expect(files).toBeHidden();
  } finally {
    releaseFirst();
  }
  await expect.poll(() => uploads).toEqual(["first.txt", "second.txt"]);
});
