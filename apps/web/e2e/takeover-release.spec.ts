import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

// The protected-input fixture follows the same control path as the computer cards.
test("released takeover cards stay settled while the computer remains available for watching", async ({
  page,
}, testInfo) => {
  await signup(page, `takeover-settlement-${Date.now()}@rakazo.test`, "password12", "Takeover");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let takeovers = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/computer/takeover")) takeovers += 1;
  });

  for (const [index, release, state, prompt] of [
    [0, "I’m done", "Done", "install the gsc cli and sign in"],
    [1, "Skip", "Skipped", "sign in again so I can skip this time"],
  ] as const) {
    await page.getByPlaceholder(/Message/).fill(prompt);
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () => {
          const result = await rpc<{ run: { status: string } | null }>(page, "threads/get", {
            botId,
          });
          return result.run?.status;
        },
        { timeout: realSandboxTimeout(90_000, 30_000) },
      )
      .toBe("waiting_takeover");
    const cards = page.getByTestId("computer-card");
    await expect(cards).toHaveCount(index + 1);
    const card = cards.nth(index);
    await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
    await card.getByTestId("computer-card-open").click();
    const chrome = page.getByTestId("computer-chrome");
    await expect(chrome.getByText("Watching", { exact: true })).toBeVisible();
    expect(takeovers).toBe(index);
    await chrome.getByRole("button", { name: "Take control", exact: true }).click();
    await expect(chrome.getByRole("button", { name: release, exact: true })).toBeVisible();
    expect(takeovers).toBe(index + 1);
    await chrome.getByRole("button", { name: release, exact: true }).click();
    await expect(chrome.getByText("Watching", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
    await page.getByRole("button", { name: "Close computer" }).click();
    await expect(card.getByText(state, { exact: true })).toBeVisible();
    await expect(card.getByText("Needs you", { exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const result = await rpc<{ run: { status: string } | null }>(page, "threads/get", {
            botId,
          });
          return result.run?.status ?? "completed";
        },
        { timeout: realSandboxTimeout(90_000, 30_000) },
      )
      .not.toBe("waiting_takeover");
    if (index === 1) await expect(cards.first().getByText("Done", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `b31-takeover-${state.toLowerCase()}`);
  }

  await page.reload();
  const cards = page.getByTestId("computer-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByText("Done", { exact: true })).toBeVisible();
  await expect(cards.last().getByText("Skipped", { exact: true })).toBeVisible();
  await expect(cards.getByText("Needs you", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "b31-takeover-reloaded");
});
