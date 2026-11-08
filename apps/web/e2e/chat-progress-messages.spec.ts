import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];
const states = [
  { name: "active", live: true },
  { name: "complete", live: false },
];

test("chat shows mid-turn progress without Working…", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const state of states) {
      await page.goto(`/e2e/fixtures/chat-progress-messages.html?live=${state.live ? 1 : 0}`);
      await expect(page.getByTestId("progress-message")).toBeVisible();
      await expect(page.getByTestId("progress-message")).toHaveText("Checking your calendars…");
      await expect(page.getByTestId("response")).toBeVisible();
      await expect(page.getByTestId("response")).toHaveText(
        state.live ? "Still finding a free slot…" : "Tuesday afternoon is free.",
      );
      await expect(page.getByTestId("tool-activity")).toHaveCount(0);
      await expect(page.getByText("Working…")).toHaveCount(0);
      await expect(page.getByText("Done")).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `${state.name}-${viewport.name}`);
    }
  }
});

test("short narration stays in the working status until the Run settles", async ({
  page,
}, testInfo) => {
  const fixture = "/e2e/fixtures/response-streaming.html?stream=off&narration=on";
  const narration = "I’m looking up Portugal’s capital.";
  const userMessage = page.getByTestId("message-user-bubble");
  const botMessage = page.getByTestId("message-bot-bubble");
  const status = page.getByRole("status");
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(fixture);
    await expect(status).toHaveText(narration);
    await expect(status).toBeVisible();
    await expect(page.getByText(narration, { exact: true })).toHaveCount(1);
    await expect(botMessage).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `narration-status-${viewport.name}`);

    await page.getByRole("button", { name: "Finish reply" }).click();
    await expect(botMessage).toHaveText("Lisbon is the capital of Portugal.");
    await expect(userMessage).toHaveText("What's the capital of Portugal?");
    await expect(status).toHaveCount(0);
    await expect(page.getByText(narration, { exact: true })).toHaveCount(0);
    await captureScreenshot(page, testInfo, `narration-finished-${viewport.name}`);
  }

  await page.goto(fixture);
  await expect(status).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(status).toHaveCount(0);
  await expect(page.getByText(narration, { exact: true })).toHaveCount(0);
  await expect(botMessage).toHaveCount(0);
  await expect(userMessage).toBeVisible();
  expect(errors).toEqual([]);
});
