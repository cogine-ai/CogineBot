import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("titled sidebar section expands and collapses", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `sidebar-collapse-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Group", exact: true }).click();
  const sectionName = page.getByRole("textbox", { name: "Section name", exact: true });
  await sectionName.fill("Projects");
  await sectionName.press("Enter");

  const projects = sidebar.locator('[data-sidebar-group^="section:"]');
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");

  const toggle = projects.getByRole("button", { name: /Collapse Projects|Expand Projects/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // Rest (no hover): move pointer off the header before capturing.
  await sidebar.getByPlaceholder("Search").hover();
  await expect(toggle.locator("[data-sidebar-section-count]")).toHaveCount(0);
  await expect(toggle.locator("[data-sidebar-section-chevron]")).toHaveCSS("opacity", "0");
  await captureScreenshot(page, testInfo, "sidebar-section-expanded");

  // Hover header with Chief selected underneath — outer edges must match.
  await bot.click();
  await toggle.hover();
  await expect(toggle.locator("[data-sidebar-section-chevron]")).toHaveCSS("opacity", "1");
  await expect(toggle.locator("[data-sidebar-section-count]")).toHaveCount(0);
  const headerBox = await toggle.boundingBox();
  const botBox = await bot.boundingBox();
  expect(headerBox).toBeTruthy();
  expect(botBox).toBeTruthy();
  expect(headerBox!.x).toBeCloseTo(botBox!.x, 0);
  expect(headerBox!.x + headerBox!.width).toBeCloseTo(botBox!.x + botBox!.width, 0);
  await captureScreenshot(page, testInfo, "sidebar-section-hover");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Expand Projects, 1");
  await expect(projects.getByRole("button", { name: /^Chief/ })).toHaveCount(0);
  await sidebar.getByPlaceholder("Search").hover();
  const indicator = toggle.locator("[data-sidebar-section-indicator]");
  const count = indicator.locator("[data-sidebar-section-count]");
  const chevron = indicator.locator("[data-sidebar-section-chevron]");
  await expect(count).toHaveText("1");
  await expect(count).toHaveCSS("opacity", "1");
  await expect(chevron).toHaveCSS("opacity", "0");
  await captureScreenshot(page, testInfo, "sidebar-section-collapsed");

  await toggle.hover();
  await expect(count).toHaveCSS("opacity", "0");
  await expect(chevron).toHaveCSS("opacity", "1");
  const countBox = await count.boundingBox();
  const chevronBox = await chevron.boundingBox();
  expect(countBox).toBeTruthy();
  expect(chevronBox).toBeTruthy();
  expect(countBox!.x + countBox!.width / 2).toBeCloseTo(chevronBox!.x + chevronBox!.width / 2, 0);
  expect(countBox!.y + countBox!.height / 2).toBeCloseTo(chevronBox!.y + chevronBox!.height / 2, 0);
  await captureScreenshot(page, testInfo, "sidebar-section-collapsed-hover");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Collapse Projects");
  await expect(toggle.locator("[data-sidebar-section-count]")).toHaveCount(0);
  await expect(projects.getByRole("button", { name: /^Chief/ })).toHaveCount(1);

  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(projects.getByRole("button", { name: /^Chief/ })).toBeVisible();
});
