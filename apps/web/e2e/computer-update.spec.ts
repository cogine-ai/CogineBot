import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ComputerStatus, ComputerUpdate, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

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

  let recoveryBlocked = true;

  function markUnconfirmed(status: ComputerStatus | undefined) {
    if (!status) return;
    status.state = "error";
    status.powerState = "quarantined";
    status.screenAvailable = false;
    status.canUpdate = false;
    status.recoveryBlocked = recoveryBlocked;
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
  const listed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/computer/files") &&
      response.request().postDataJSON()?.json?.source === "saved",
  );
  await savedFiles.click();
  expect((await listed).ok()).toBe(true);
  await expect(savedFiles).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Could not load files", { exact: true })).toHaveCount(0);
  expect(bootRequests).toBe(0);
  await savedFiles.click();
  await page.getByTestId("computer-more-button").click();
  await expect(
    page.getByRole("menuitem", { name: "Recover computer", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Reset computer", exact: true })).toBeDisabled();
  await expect(page.getByText(/restore the original computer provider settings/)).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-stop-provider-blocked");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("computer-more-menu")).not.toBeVisible();
  const computerPanel = page.getByTitle("Agent computer");
  if (await preview.isVisible()) await computerPanel.click();
  await expect(preview).not.toBeVisible();
  recoveryBlocked = false;
  await computerPanel.click();
  await page.getByTestId("computer-more-button").click();
  await expect(page.getByRole("menuitem", { name: "Recover computer", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Recover computer", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Update computer", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-stop-unconfirmed");
  await page.getByRole("menuitem", { name: "Recover computer", exact: true }).click();
  await expect(page.getByRole("alertdialog").getByRole("heading")).toHaveText("Recover computer?");
  expect(bootRequests).toBe(0);
});

test("workspace maintenance shows measured progress and live files after a failed save", async ({
  page,
}, testInfo) => {
  await signup(page, `workspace-save-${Date.now()}@example.test`, "password12", "Workspace Save");
  await completeOnboarding(page);
  let progress = { files: 2, bytes: 1024 };
  let failed = false;
  const patch = async (route: Route, getStatus: (json: unknown) => ComputerStatus | undefined) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: unknown };
    const status = getStatus(body.json);
    if (status) {
      status.state = failed ? "running" : "error";
      status.powerState = failed ? undefined : "stopping";
      status.screenAvailable = false;
      status.workspaceSaveProgress = failed ? undefined : progress;
      status.workspaceSaveFailure = failed ? "disk_space" : undefined;
    }
    await route.fulfill({ response, json: body });
  };
  await page.route("**/rpc/bootstrap", (route) =>
    patch(route, (json) => (json as { thread?: { computer?: ComputerStatus } })?.thread?.computer),
  );
  await page.route("**/rpc/threads/get", (route) =>
    patch(route, (json) => (json as { computer?: ComputerStatus })?.computer),
  );
  await page.route("**/rpc/computer/status", (route) =>
    patch(route, (json) => json as ComputerStatus),
  );
  await page.route("**/rpc/computer/files", async (route) => {
    expect(route.request().postDataJSON()?.json).not.toHaveProperty("source");
    await route.fulfill({
      json: { json: [{ path: "large-report.txt", kind: "file", size: 10240 }] },
    });
  });
  await page.reload();
  await page.getByTitle("Agent computer").click();
  const counts = page.getByTestId("workspace-save-progress");
  await expect(page.getByText("Saving workspace…", { exact: true })).toBeVisible();
  await expect(counts).toHaveText("2 files processed · 1 KB");
  progress = { files: 4, bytes: 1536 };
  await expect(counts).toHaveText("4 files processed · 1.5 KB");
  await captureScreenshot(page, testInfo, "computer-save-progress");

  failed = true;
  await expect(counts).toHaveCount(0);
  const warning = page.getByTestId("workspace-save-failure");
  await expect(warning).toContainText("Computer still running. Workspace not saved.");
  await expect(warning).toContainText("Not enough disk space to save the workspace.");
  await page.getByRole("button", { name: "View files", exact: true }).click();
  await expect(page.getByText("large-report.txt", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-save-failure");
});

test("a group computer window observes saving before its next attendance poll", async ({
  page,
}, testInfo) => {
  await signup(page, `group-workspace-save-${Date.now()}@example.test`, "password12", "Group Save");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const teammateId = await createNamedBot(page, "Teammate");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Workspace Team",
    botIds: [botId, teammateId],
  });
  const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { groupId: group.id });
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", {});
  await page.route("**/rpc/threads/get", async (route) => {
    if (route.request().postDataJSON()?.json?.groupId !== group.id) return route.continue();
    const response = await route.fetch();
    const { json } = (await response.json()) as { json: ThreadSnapshot };
    await route.fulfill({
      response,
      json: {
        json: {
          ...json,
          messages: [
            ...json.messages,
            {
              id: "workspace-group-computer",
              threadId: json.threadId,
              seq: 100,
              role: "bot",
              botId,
              blocks: [{ kind: "computer", state: "Needs you", text: "Continue in the computer." }],
              createdAt: new Date().toISOString(),
            },
          ],
        },
      },
    });
  });

  let subscribed = false;
  const { promise: releaseEvent, resolve: emitSave } = Promise.withResolvers<void>();
  await page.route("**/rpc/threads/subscribe", async (route) => {
    const target = route.request().postDataJSON()?.json;
    if (target?.groupId !== group.id || subscribed) return route.continue();
    subscribed = true;
    await releaseEvent;
    const event = {
      id: "group-workspace-save-changed",
      spaceId,
      threadId: snapshot.threadId,
      botId,
      seq: target.cursor + 1,
      type: "computer.status",
      payload: { workspaceSaveChanged: true },
      createdAt: new Date().toISOString(),
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`,
    });
  });

  let state: "running" | "saving" | "failed" = "running";
  const baseStatus = await rpc<ComputerStatus>(page, "computer/status", { botId });
  const serveStatus = async (route: Route) => {
    expect(route.request().postDataJSON()?.json).toMatchObject({ botId });
    await route.fulfill({
      json: {
        json: {
          ...baseStatus,
          state: state === "saving" ? "error" : "running",
          powerState: state === "saving" ? "stopping" : undefined,
          screenAvailable: false,
          controlHolder: state === "failed" ? "user" : "none",
          controlBotId: state === "failed" ? botId : null,
          takeoverRequested: false,
          workspaceSaveProgress: state === "saving" ? { files: 2, bytes: 1024 } : undefined,
          workspaceSaveFailure: state === "failed" ? "disk_space" : undefined,
        },
      },
    });
  };
  await page.route("**/rpc/computer/boot", serveStatus);
  await page.route("**/rpc/computer/status", serveStatus);
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({ json: { json: { url: null } } }),
  );
  await page.route("**/rpc/computer/files", async (route) => {
    expect(route.request().postDataJSON()?.json).not.toHaveProperty("source");
    await route.fulfill({
      json: { json: [{ path: "group-report.txt", kind: "file", size: 1024 }] },
    });
  });
  try {
    await page.goto(`/app/g/${group.id}`);
    await expect.poll(() => subscribed).toBe(true);
    const attended = page.waitForResponse(
      (response) => response.url().endsWith("/rpc/computer/heartbeat") && response.ok(),
    );
    await page.getByTestId("computer-card-open").click();
    await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
    // Wait until opening reads have completed, so only the group event can see the transition.
    await attended;
    await expect(
      page.getByTestId("computer-chrome").getByText("Watching", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("workspace-save-progress")).toHaveCount(0);

    state = "saving";
    emitSave();
    await expect(page.getByTestId("workspace-save-progress")).toHaveText(
      "2 files processed · 1 KB",
      {
        timeout: 10_000,
      },
    );
    state = "failed";
    await expect(page.getByText("You have control", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View files", exact: true }).click();
    await expect(page.getByText("group-report.txt", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);
    await captureScreenshot(page, testInfo, "computer-save-group");

    await page.getByRole("button", { name: "Close Files", exact: true }).click();
    const viewport = page.getByTestId("computer-viewport");
    await viewport.getByRole("button", { name: "Files", exact: true }).click();
    await expect(viewport.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  } finally {
    emitSave();
  }
});
