import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Me, Routine, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

async function openComposer(page: Page, prefix: string) {
  await signup(page, `${prefix}-${Date.now()}@rakazo.test`, "password12", "Draft Keeper");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  return composer;
}

test("bootstrap failure recovers the trusted Space before sending a preserved attachment", async ({
  page,
}, testInfo) => {
  const composer = await openComposer(page, "bootstrap-recovery");
  const botId = activeBotId(page);
  const me = await rpc<Me>(page, "me", {});
  let unavailable = true;
  let attempts = 0;
  await page.route("**/rpc/bootstrap", (route) => {
    attempts += 1;
    return unavailable ? route.abort("internetdisconnected") : route.continue();
  });
  await page.reload();
  await expect(page.getByTestId("load-failure")).toContainText("Could not reach the server");
  await expect(page.getByTestId("composer-bar").getByRole("combobox")).toBeDisabled();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "false");
  const failedAttempts = attempts;
  unavailable = false;
  await page
    .getByTestId("load-failure")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect.poll(() => attempts).toBeGreaterThan(failedAttempts);
  await expect(page.getByTestId("load-failure")).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await composer.fill("Recovered with the original Space.\nKeep the attachment with this message.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "bootstrap-recovered.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("isolated bootstrap recovery"),
    });
  await expect(page.getByTestId("attachment-preview")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "bootstrap-recovered-before-send");
  const sentRequest = page.waitForRequest("**/rpc/threads/send");
  const sentResponse = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/threads/send") && response.ok(),
  );
  await composer.press("Enter");
  const request = await sentRequest;
  expect(request.headers()["x-rakazo-space-id"]).toBe(me.spaceId);
  expect(request.postDataJSON().json.botId).toBe(botId);
  expect(request.postDataJSON().json.artifactIds).toHaveLength(1);
  const receipt = (await (await sentResponse).json()).json;
  expect(receipt.runId).toBeTruthy();
  expect(receipt.taskId).toBeTruthy();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("attachment-preview")).toHaveCount(0);
  const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  const sent = snapshot.messages.filter(
    (message) =>
      message.role === "user" &&
      message.blocks.some(
        (block) =>
          block.kind === "text" && block.text.includes("Recovered with the original Space."),
      ),
  );
  expect(sent).toHaveLength(1);
});

test("a failed send keeps the message and its attachment in the composer", async ({
  page,
}, testInfo) => {
  const composer = await openComposer(page, "send-failure");
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("meeting notes"),
  });
  const removeAttachment = page.getByRole("button", { name: "Remove notes.txt" });
  await expect(removeAttachment).toBeVisible();

  await page.route("**/rpc/threads/send", (route) => route.abort("internetdisconnected"));
  await composer.fill("message that fails to send");
  await composer.press("Enter");

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("message that fails to send");
  await expect(removeAttachment).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-send-failure-keeps-draft");

  await page.unroute("**/rpc/threads/send");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("message that fails to send", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(removeAttachment).toBeHidden();
  await expect(page.getByTestId("composer-error")).toBeHidden();
});

test("a failed send leaves a newer draft alone", async ({ page }) => {
  const composer = await openComposer(page, "send-failure-newer");
  let failSend = () => {};
  const sendFailed = new Promise<void>((resolve) => {
    failSend = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await sendFailed;
    await route.abort("internetdisconnected");
  });

  await composer.fill("first message");
  await composer.press("Enter");
  await expect(composer).toHaveValue("first message");
  await composer.fill("newer draft");
  failSend();

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("newer draft");
});

async function createRoutine(page: Page, name: string) {
  return rpc<Routine>(page, "routines/create", {
    botId: activeBotId(page),
    name,
    prompt: "Summarize today",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
}

async function mentionRoutine(page: Page, composer: Locator, name: string) {
  await composer.fill(`@${name.slice(0, 4)}`);
  await expect(page.getByRole("option", { name: `@${name}` })).toBeVisible();
  await composer.press("Enter");
}

test("an accepted routine clears the submitted draft even if the refresh fails", async ({
  page,
}) => {
  const composer = await openComposer(page, "send-failure-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const chip = page.getByTestId("mention-chip");
  await expect(chip).toHaveText("daily-digest");

  const testRun = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await page.route("**/rpc/threads/get", (route) => route.abort("internetdisconnected"));
  await composer.press("Enter");
  await testRun;

  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(chip).toHaveCount(0);
  await expect(composer).toHaveValue("");
});

test("mixed routine failure retains the draft and retries only the unfinished action", async ({
  page,
}) => {
  const composer = await openComposer(page, "send-failure-routines");
  await createRoutine(page, "daily-digest");
  const failing = await createRoutine(page, "weekly-review");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  await mentionRoutine(page, composer, "weekly-review");
  await expect(page.getByTestId("mention-chip")).toHaveCount(2);

  await page.route("**/rpc/routines/testRun", (route) => {
    const input = route.request().postDataJSON() as { json: { routineId: string } };
    return input.json.routineId === failing.id
      ? route.abort("internetdisconnected")
      : route.continue();
  });
  const accepted = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await composer.fill("and the notes");
  await composer.press("Enter");
  await accepted;

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveCount(2);
  await expect(composer).toHaveValue("and the notes");
  await page.unroute("**/rpc/routines/testRun");
  const retried: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/routines/testRun"))
      retried.push(request.postDataJSON().json.routineId);
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  expect(retried).toEqual([failing.id]);
});

for (const target of ["bot", "group"] as const) {
  test(`an unchanged ${target} retry after a lost response creates only one message`, async ({
    page,
  }) => {
    const composer = await openComposer(page, `send-lost-${target}`);
    const botId = activeBotId(page);
    const threadTarget =
      target === "group"
        ? {
            groupId: (
              await rpc<{ id: string }>(page, "groups/create", {
                name: "Retry team",
                botIds: [botId, await createNamedBot(page, "Retry peer")],
              })
            ).id,
          }
        : { botId };
    if ("groupId" in threadTarget) {
      await page.goto(`/app/g/${threadTarget.groupId}`);
      await expect(composer).toBeVisible();
    }
    const nonces: string[] = [];
    const receipts: unknown[] = [];
    await page.route("**/rpc/threads/send", async (route) => {
      nonces.push(route.request().postDataJSON().json.clientNonce);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      receipts.push((await response.json()).json);
      if (nonces.length === 1) await route.abort("internetdisconnected");
      else await route.fulfill({ response });
    });
    await composer.fill("retry after a lost response");
    await composer.press("Enter");
    await expect(page.getByTestId("composer-error")).toBeVisible();
    await expect(composer).toHaveValue("retry after a lost response");
    const retryResponse = page.waitForResponse(
      (response) => response.url().includes("/rpc/threads/send") && response.ok(),
    );
    await composer.press("Enter");
    await retryResponse;
    await expect(page.getByTestId("composer-error")).toBeHidden();
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
    expect(receipts[1]).toEqual(receipts[0]);
    const snapshot = await rpc<{ messages: ThreadMessage[] }>(page, "threads/get", threadTarget);
    expect(
      snapshot.messages.filter(
        (message) =>
          message.role === "user" &&
          message.blocks.some(
            (block) => block.kind === "text" && block.text === "retry after a lost response",
          ),
      ),
    ).toHaveLength(1);
  });
}

test("an unchanged routine retry after a lost response reuses the run", async ({ page }) => {
  const composer = await openComposer(page, "send-lost-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const nonces: string[] = [];
  const runIds: string[] = [];
  await page.route("**/rpc/routines/testRun", async (route) => {
    nonces.push(route.request().postDataJSON().json.clientNonce);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    runIds.push((await response.json()).json.runId);
    if (nonces.length === 1) await route.abort("internetdisconnected");
    else await route.fulfill({ response });
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveText("daily-digest");
  const retryResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await composer.press("Enter");
  await retryResponse;
  await expect(page.getByTestId("composer-error")).toBeHidden();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  expect(nonces).toHaveLength(2);
  expect(nonces[1]).toBe(nonces[0]);
  expect(runIds[1]).toBe(runIds[0]);
});

for (const target of ["bot", "group"] as const) {
  test(`a lost ${target} attachment upload receipt retries without creating another file version`, async ({
    page,
  }, testInfo) => {
    const composer = await openComposer(page, `upload-lost-${target}`);
    const botId = activeBotId(page);
    if (target === "group") {
      const group = await rpc<{ id: string }>(page, "groups/create", {
        name: "Upload retry team",
        botIds: [botId, await createNamedBot(page, "Upload peer")],
      });
      await page.goto(`/app/g/${group.id}`);
      await expect(composer).toBeVisible();
    }
    await page.locator('input[type="file"]').setInputFiles({
      name: "receipt-retry.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("one durable attachment"),
    });
    const nonces: string[] = [];
    const artifactIds: string[] = [];
    await page.route("**/rpc/artifacts/create", async (route) => {
      nonces.push(route.request().postDataJSON().json.clientNonce);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      artifactIds.push((await response.json()).json.id);
      if (artifactIds.length === 1) await route.abort("internetdisconnected");
      else await route.fulfill({ response });
    });
    await composer.fill("Send the uploaded notes");
    await composer.press("Enter");
    await expect(page.getByTestId("composer-error")).toBeVisible();
    await expect(composer).toHaveValue("Send the uploaded notes");
    await expect(page.getByRole("button", { name: "Remove receipt-retry.txt" })).toBeVisible();
    await composer.press("Enter");
    await expect(page.getByTestId("composer-error")).toBeHidden();
    await expect(composer).toHaveValue("");
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toEqual(expect.any(String));
    expect(nonces[1]).toBe(nonces[0]);
    expect(artifactIds[1]).toBe(artifactIds[0]);
    const versions = await rpc<Array<{ id: string; version: number }>>(
      page,
      "artifacts/listVersions",
      { familyId: artifactIds[0] },
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    await captureScreenshot(page, testInfo, `composer-${target}-lost-upload-receipt`);
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`image intent keeps the rejected draft and sends the same artifact as a file (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await signup(
      page,
      `image-intent-${viewport.name}-${Date.now()}@example.test`,
      "password12",
      "Image Sender",
    );
    await completeOnboarding(page);
    const composer = page.getByRole("combobox", { name: /Message/ });
    const routine = viewport.name === "desktop" ? await createRoutine(page, "daily-digest") : null;
    if (routine) {
      await page.reload();
      await mentionRoutine(page, composer, routine.name);
      await expect(page.getByTestId("mention-chip")).toHaveText(routine.name);
    }
    const requests: Array<{
      imageHandling: string;
      artifactIds: string[];
      clientNonce: string;
      routineIds?: string[];
    }> = [];
    const standaloneRoutines: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/rpc/routines/testRun")) standaloneRoutines.push(request.url());
    });
    await page.route("**/rpc/threads/imageInput", (route) =>
      route.fulfill({ json: { json: { status: "unsupported" } } }),
    );
    const sendRoute = routine ? "**/rpc/threads/sendWithRoutines" : "**/rpc/threads/send";
    await page.route(sendRoute, (route) => {
      const body = route.request().postDataJSON().json;
      requests.push(body);
      if (body.imageHandling === "file") return route.continue();
      return route.fulfill({
        status: 409,
        json: {
          json: {
            defined: false,
            code: "CONFLICT",
            status: 409,
            message: "This model cannot read images. Choose a model that supports images.",
            data: { reason: "model_image_input_unsupported", imageInputStatus: "unsupported" },
          },
        },
      });
    });
    await composer.fill("Keep this invoice with my draft");
    await page
      .getByTestId("composer-bar")
      .locator('input[type="file"]')
      .setInputFiles({
        name: "invoice.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    await expect(
      page.getByTestId("attachment-preview").getByText("invoice.png", { exact: true }),
    ).toBeVisible();
    const removeImage = page.getByRole("button", { name: "Remove invoice.png", exact: true });
    await expect(removeImage).toBeVisible();
    const removeBox = await removeImage.boundingBox();
    expect(removeBox!.width).toBeGreaterThanOrEqual(44);
    expect(removeBox!.height).toBeGreaterThanOrEqual(44);
    const choice = page.getByTestId("image-input-choice");
    await expect(choice.getByRole("status")).toHaveText("This model cannot see images");
    await expect(
      choice.getByRole("button", { name: "Let Bot see images", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(choice.getByRole("button", { name: "Choose model", exact: true })).toBeVisible();
    await composer.press("Enter");
    await expect(page.getByTestId("composer-error")).toBeVisible();
    await expect(composer).toHaveValue("Keep this invoice with my draft");
    await expect(page.getByTestId("attachment-preview")).toHaveCount(1);
    await captureScreenshot(page, testInfo, `image-input-rejected-${viewport.name}`);
    await choice.getByRole("button", { name: "As file", exact: true }).click();
    await expect(choice.getByRole("button", { name: "As file", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(choice.getByRole("status")).toHaveCount(0);
    await page.getByRole("button", { name: "Send as file", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("attachment-preview")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(standaloneRoutines).toEqual([]);
    if (routine)
      expect(requests.map((body) => body.routineIds)).toEqual([[routine.id], [routine.id]]);
    expect(requests[1]!.artifactIds).toEqual(requests[0]!.artifactIds);
    expect(requests[1]!.clientNonce).not.toBe(requests[0]!.clientNonce);
    const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: activeBotId(page) });
    const sent = snapshot.messages.find(
      (message) =>
        message.role === "user" &&
        message.blocks.some(
          (block) => block.kind === "file" && block.artifactId === requests[0]!.artifactIds[0],
        ),
    );
    expect(sent).toBeTruthy();
    expect(sent!.blocks.some((block) => block.kind === "image")).toBe(false);
    await captureScreenshot(page, testInfo, `image-input-file-${viewport.name}`);
    expect(pageErrors).toEqual([]);
  });
}
