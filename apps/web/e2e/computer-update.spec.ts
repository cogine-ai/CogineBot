import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ComputerStatus, ComputerUpdate } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

test("computer maintenance shows durable background progress and failure recovery", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await signup(page, `computer-update-${Date.now()}@rakazo.test`, "password12", "Computer Update");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let updates: ComputerUpdate[] = [];
  const updating: ComputerUpdate = {
    id: "update-example",
    botId,
    name: "Chief",
    mode: "team",
    action: "update",
    status: "running",
    stage: "restoring",
  };
  await page.route("**/rpc/computer/updates", (route) =>
    route.fulfill({ json: { json: updates } }),
  );
  await page.route("**/rpc/computer/update", (route) => {
    updates = [updating];
    return route.fulfill({ json: { json: updating } });
  });
  let finishRecovery: (() => void) | undefined;
  let holdRecovery = false;
  await page.route("**/rpc/computer/recover", async (route) => {
    if (holdRecovery) {
      await new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
    }
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  let releases = 0;
  await page.route("**/rpc/computer/releaseInterrupted", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      json: { id: updating.id, workersStopped: true },
    });
    releases++;
    updates = [{ ...updating, status: "failed" }];
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.getByTitle("Agent computer").click();
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await page.getByTestId("computer-more-button").click();
  await expect(page.getByText("Recreate a computer that is not working.")).toBeVisible();
  await expect(page.getByText("Restore the last saved workspace.", { exact: true })).toBeVisible();
  await expect(page.getByText("Save the workspace and install current software.")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-maintenance-menu");
  await page.getByRole("menuitem", { name: "Recover computer", exact: true }).click();
  const recoveryConfirmation = page.getByRole("alertdialog");
  await expect(recoveryConfirmation.getByRole("heading")).toHaveText("Recover computer?");
  await captureScreenshot(page, testInfo, "computer-maintenance-recover-confirmation");
  await recoveryConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("computer-more-button").click();
  await page.getByRole("menuitem", { name: "Reset computer", exact: true }).click();
  const resetConfirmation = page.getByRole("alertdialog");
  await captureScreenshot(page, testInfo, "computer-maintenance-reset-confirmation");
  await resetConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("computer-more-button").click();
  await page.getByRole("menuitem", { name: "Recover computer", exact: true }).click();
  holdRecovery = true;
  await recoveryConfirmation.getByRole("button", { name: "Recover computer", exact: true }).click();
  await expect(recoveryConfirmation.getByRole("button", { name: "Recovering…" })).toBeDisabled();
  await expect.poll(() => finishRecovery).toBeDefined();
  finishRecovery!();
  holdRecovery = false;
  await expect(recoveryConfirmation).not.toBeVisible();
  const recoveryProgress = page.getByTestId("computer-update-dialog");
  await recoveryProgress.getByRole("button", { name: "Continue in Background" }).click();
  updates = [];
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
  await page.getByTestId("computer-more-button").click();
  await page.getByRole("menuitem", { name: "Update computer", exact: true }).click();
  const dialog = page.getByTestId("computer-update-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Updating Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await captureScreenshot(page, testInfo, "computer-update-background");
  await page.reload();
  await page.getByRole("button", { name: /Updating Team Computer/ }).click();
  await expect(dialog).toBeVisible();
  updates = [{ ...updating, status: "interrupted" }];
  await expect(
    dialog.getByText("Recovery is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  updates = [{ ...updating, status: "interrupted", canReleaseReservation: true }];
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await captureScreenshot(page, testInfo, "computer-update-release-confirmation");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(releases).toBe(0);
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  await confirmation.getByRole("button", { name: "Nothing is still running", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  expect(releases).toBe(1);
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = [];
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});

test("an unconfirmed computer stop offers explicit recovery without attempting to boot", async ({
  page,
}, testInfo) => {
  await signup(page, `computer-power-${Date.now()}@example.test`, "password12", "Computer Power");
  await completeOnboarding(page);

  function markUnconfirmed(status: ComputerStatus | undefined) {
    if (!status) return;
    status.state = "error";
    status.powerState = "quarantined";
    status.screenAvailable = false;
    status.canUpdate = false;
  }

  async function patchStatus(
    route: Route,
    getStatus: (json: unknown) => ComputerStatus | undefined,
  ) {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: unknown };
    markUnconfirmed(getStatus(body.json));
    await route.fulfill({ response, json: body });
  }
  await page.route("**/rpc/bootstrap", (route) =>
    patchStatus(
      route,
      (json) => (json as { thread?: { computer?: ComputerStatus } })?.thread?.computer,
    ),
  );
  await page.route("**/rpc/threads/get", (route) =>
    patchStatus(route, (json) => (json as { computer?: ComputerStatus })?.computer),
  );
  await page.route("**/rpc/computer/status", (route) =>
    patchStatus(route, (json) => json as ComputerStatus),
  );
  let bootRequests = 0;
  await page.route("**/rpc/computer/boot", (route) => {
    bootRequests += 1;
    return route.abort();
  });
  await page.reload();

  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByText("Computer status unconfirmed", { exact: true })).toBeVisible();
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await expect(preview.locator("iframe")).toHaveCount(0);
  const savedFiles = page
    .getByRole("button", { name: "Files", exact: true })
    .filter({
      visible: true,
    })
    .and(page.locator("[aria-expanded]"));
  await savedFiles.click();
  await expect(savedFiles).toHaveAttribute("aria-expanded", "true");
  expect(bootRequests).toBe(0);
  await savedFiles.click();
  await page.getByTestId("computer-more-button").click();
  await expect(page.getByRole("menuitem", { name: "Recover computer", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Update computer", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-stop-unconfirmed");
  await page.getByRole("menuitem", { name: "Recover computer", exact: true }).click();
  await expect(page.getByRole("alertdialog").getByRole("heading")).toHaveText("Recover computer?");
  expect(bootRequests).toBe(0);
});
