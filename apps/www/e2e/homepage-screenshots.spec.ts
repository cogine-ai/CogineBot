import type { Page, TestInfo } from "@playwright/test";
import { test } from "@playwright/test";

async function openHomepage(page: Page, path = "/") {
  await page.goto(path);
  // The server-rendered demo is visible before its client listeners are ready.
  await page
    .locator('astro-island[component-export="ProductDemo"]:not([ssr])')
    .waitFor({ state: "attached" });
}

/** Visual record for the CI screenshot gallery. No content assertions. */
async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

test("homepage screenshots", async ({ page }, testInfo) => {
  await openHomepage(page);
  await captureScreenshot(page, testInfo, "01-marketing-homepage");

  await page.locator("[data-get-started-open]").first().click();
  await page.locator("dialog[data-get-started-dialog]").waitFor({ state: "visible" });
  await captureScreenshot(page, testInfo, "02-marketing-get-started");

  await openHomepage(page, "/zh/");
  await captureScreenshot(page, testInfo, "03-marketing-homepage-zh");

  await openHomepage(page);
  await page
    .locator('.product-demo[data-product-demo-ready="true"]')
    .waitFor({ state: "attached" });
  await page.locator(".product-demo__computer-shot").first().click();
  await page.locator(".product-demo__takeover").waitFor({ state: "visible" });
  await captureScreenshot(page, testInfo, "04-marketing-demo-computer");
});
