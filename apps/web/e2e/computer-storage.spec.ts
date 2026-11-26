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
  await expect(
    dialog.getByText("Computer changed. Open Storage from the Files toolbar."),
  ).toBeVisible();
  expect(inputs).toEqual([{ botId, expectedTarget: target }]);

  await page.keyboard.press("Escape");
  await files
    .getByRole("button", { name: "Storage", exact: true })
    .filter({ hasNotText: "Storage" })
    .click();
  await dialog.getByRole("button", { name: "Diagnose storage" }).click();
  await expect.poll(() => inputs).toEqual([{ botId, expectedTarget: target }, { botId }]);
  await page.keyboard.press("Escape");
  await page.unroute("**/rpc/computer/uploadFile");
  const uploads: string[] = [];
  let firstFile = "";
  let first: Promise<void>;
  await page.route("**/rpc/computer/uploadFile", async (route) => {
    const path = route.request().postDataJSON().json.path;
    uploads.push(path);
    if (path === firstFile) await first;
    await route.fulfill({ json: { json: { ok: true } } });
  });

  const browser = viewport.getByRole("button", { name: "Browser", exact: true });
  for (const [label, dismiss] of [
    ["collapse", browser],
    ["close", viewport.getByRole("button", { name: "Close Files", exact: true })],
  ] as const) {
    firstFile = `${label}-first.txt`;
    const second = `${label}-second.txt`;
    let releaseFirst!: () => void;
    first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const before = uploads.length;
    await expect(files.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
    await files.locator('input[type="file"]').setInputFiles(
      [firstFile, second].map((name) => ({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(name),
      })),
    );
    try {
      await expect.poll(() => uploads.slice(before)).toEqual([firstFile]);
      await dismiss.click();
      await expect(files).toBeHidden();
    } finally {
      releaseFirst();
    }
    await expect.poll(() => uploads.slice(before)).toEqual([firstFile, second]);
    if (label === "collapse") await browser.click();
  }
});

test("submits only the selected file versions and retries the same manual confirmation", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `selection-${Date.now()}@example.test`,
    "password12",
    "Storage selection fixture",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const planId = "a2d0e6ee-c542-4ca0-92f4-1f7858e4cfe5";
  const first = { path: "reports/selected.pdf", logicalBytes: 2 ** 20 };
  const fingerprint = { version: "d".repeat(64), modifiedAtMs: 1780000000000 };
  const plan = {
    id: planId,
    botId,
    revision: 1,
    status: "awaiting_confirmation",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    selected: [{ ...first, ...fingerprint }],
  };
  await page.route("**/rpc/computer/diskUsage", (route) =>
    route.fulfill({
      json: {
        json: {
          botId,
          target,
          outcome: {
            status: "available",
            data: {
              volume: { totalBytes: 2 ** 33, availableBytes: 0, availableInodes: 0 },
              partial: false,
              candidates: [
                {
                  path: "reports/not-selected.pdf",
                  logicalBytes: 2 ** 21,
                  cleanup: { ...fingerprint, version: "e".repeat(64) },
                },
                { ...first, cleanup: fingerprint },
                { path: "reports/ineligible[1].pdf", logicalBytes: 10 },
              ],
            },
          },
        },
      },
    }),
  );
  const creations: unknown[] = [];
  await page.route("**/rpc/computer/planCleanup", (route) => {
    creations.push(route.request().postDataJSON().json);
    return route.fulfill({ json: { json: plan } });
  });
  const confirmations: unknown[] = [];
  await page.route("**/rpc/computer/confirmCleanup", (route) => {
    confirmations.push(route.request().postDataJSON().json);
    if (confirmations.length === 1) return route.abort();
    return route.fulfill({ json: { json: { ...plan, revision: 2, status: "reviewed" } } });
  });

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Storage" });
  await dialog.getByRole("button", { name: "Diagnose storage" }).click();
  const review = dialog.getByRole("button", { name: "Review selection" });
  await expect(review).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "reports/ineligible[1].pdf" })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: first.path }).click();
  await review.click();
  const confirm = dialog.getByRole("button", { name: "Confirm selection" });
  await expect(confirm).toBeVisible();
  await expect(dialog.getByText(first.path)).toBeVisible();
  await expect(dialog.getByText("reports/not-selected.pdf")).toHaveCount(0);
  await expect(dialog.getByText("Files stay in place.")).toBeVisible();
  expect(confirmations).toEqual([]);
  expect(creations).toEqual([
    {
      botId,
      expectedTarget: target,
      requestNonce: expect.any(String),
      selected: [{ path: first.path, version: fingerprint.version }],
    },
  ]);
  await captureScreenshot(page, testInfo, "computer-storage-review");
  await confirm.click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not update the selection.");
  await confirm.click();
  await expect(dialog.getByText("Selection saved.")).toBeVisible();
  expect(confirmations).toEqual([
    { botId, planId, expectedRevision: 1, confirmed: true, requestNonce: expect.any(String) },
    confirmations[0],
  ]);
});
