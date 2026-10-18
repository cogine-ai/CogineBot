import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("right-click grouping preserves the active chat through rename, empty groups and delete undo", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-organize-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });
  const route = page.url();
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  const draft = "Keep this draft while organizing the sidebar";
  await composer.fill(draft);
  await expect(sidebar.getByRole("button", { name: /^(Collapse|Expand) Unassigned/ })).toHaveCount(
    0,
  );

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
  await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^(Collapse|Expand) Unassigned/ })).toHaveCount(
    0,
  );
  await captureScreenshot(page, testInfo, "pinned-bots");

  // The first group starts from the conversation and moves it out of pinned.
  await bot.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Group", exact: true }).click();
  const sectionName = page.getByRole("textbox", { name: "Section name", exact: true });
  await sectionName.fill("Projects");
  await captureScreenshot(page, testInfo, "create-first-section-inline");
  await sectionName.press("Enter");

  const projects = sidebar.locator('[data-sidebar-group^="section:"]');
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Collapse Unassigned", exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue(draft);
  expect(page.url()).toBe(route);
  await captureScreenshot(page, testInfo, "bot-sections");

  await page.reload();
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");
  await composer.fill(draft);

  await projects
    .getByRole("button", { name: "Collapse Projects", exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Add (conversation|chat)/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Rename section", exact: true }).click();
  await sectionName.fill("Delivery");
  await captureScreenshot(page, testInfo, "rename-bot-section");
  await sectionName.press("Enter");
  await expect(projects).toContainText("Delivery");
  await expect(projects).not.toContainText("Projects");

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "Delivery", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New section", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename section", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "move-to-section-menu");
  await page.getByRole("menuitem", { name: "Unassigned", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="unassigned"]')).toContainText("Chief");
  await expect(
    projects.getByRole("button", { name: "Collapse Delivery", exact: true }),
  ).toBeVisible();
  await expect(projects.getByRole("button", { name: /^Chief/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "empty-section-retained");

  await sidebar
    .getByRole("button", { name: "Collapse Unassigned", exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  expect(page.url()).toBe(route);

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Delivery", exact: true }).click();
  await expect(projects).toContainText("Chief");
  await projects
    .getByRole("button", { name: "Collapse Delivery", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete section", exact: true }).click();
  await expect(projects).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^(Collapse|Expand) Unassigned/ })).toHaveCount(
    0,
  );
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  expect(page.url()).toBe(route);
  await captureScreenshot(page, testInfo, "deleted-section-undo");

  // Restoring a deleted group must not make the later Pin undo reset membership.
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
  await sidebar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(projects).toContainText("Delivery");
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
  await expect(projects.getByRole("button", { name: /^Chief/ })).toHaveCount(0);
  await projects.getByRole("button", { name: "Collapse Delivery", exact: true }).focus();
  await page.keyboard.press("Control+z");
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toHaveCount(0);
  await expect(projects).toContainText("Chief");
  await expect(
    sidebar.getByRole("button", { name: "Collapse Unassigned", exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue(draft);
  expect(page.url()).toBe(route);
  await captureScreenshot(page, testInfo, "restored-section-chat-retained");

  await page.reload();
  await expect(projects).toContainText("Delivery");
  await expect(projects).toContainText("Chief");
});

test("custom sections can be created from Move to and reordered without leaving the chat", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `section-reorder-${stamp}@rakazo.test`, "password12", "Section Order");
  await completeOnboarding(page);
  const route = page.url();
  await rpc(page, "bots/create", {
    name: "Partner",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.reload();

  const sidebar = page.locator("aside").first();
  const sectionName = page.getByRole("textbox", { name: "Section name", exact: true });
  await sidebar.getByRole("button", { name: /^Chief/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Group", exact: true }).click();
  await sectionName.fill("Projects");
  await sectionName.press("Enter");

  await sidebar.getByRole("button", { name: /^Partner/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New section", exact: true }).click();
  await expect(sectionName).toBeFocused();
  await sectionName.fill("Personal");
  await sectionName.press("Enter");
  const sections = sidebar.locator('[data-sidebar-group^="section:"]');
  const order = () =>
    sections.evaluateAll((items) =>
      items.map((item) => item.querySelector("button")?.textContent?.trim()),
    );
  await expect.poll(order).toEqual(["Projects", "Personal"]);

  const reorderSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSections/reorder") && response.ok(),
  );
  await sidebar
    .getByRole("button", { name: "Collapse Personal", exact: true })
    .dragTo(sidebar.getByRole("button", { name: "Collapse Projects", exact: true }));
  await reorderSaved;
  await expect.poll(order).toEqual(["Personal", "Projects"]);
  expect(page.url()).toBe(route);
  await captureScreenshot(page, testInfo, "sidebar-sections-reordered");
  await page.reload();
  await expect.poll(order).toEqual(["Personal", "Projects"]);

  await sidebar
    .getByRole("button", { name: "Collapse Personal", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect.poll(order).toEqual(["Projects", "Personal"]);
  expect(page.url()).toBe(route);
});

test("reorder undo preserves a section restored by independent deletion undo", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `section-undo-order-${stamp}@rakazo.test`, "password12", "Section Undo");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const botIds = [chiefId];
  for (const name of ["Partner B", "Partner C"]) {
    const bot = await rpc<{ id: string }>(page, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
    botIds.push(bot.id);
  }
  for (const [index, name] of ["A", "B", "C"].entries()) {
    await rpc(page, "botSections/create", { botId: botIds[index], name });
  }
  await page.reload();
  const sidebar = page.locator("aside").first();
  const sections = sidebar.locator('[data-sidebar-group^="section:"]');
  const order = () =>
    sections.evaluateAll((items) =>
      items.map((item) => item.querySelector("[data-sidebar-section-header]")?.textContent?.trim()),
    );
  const header = (name: string) =>
    sidebar.getByRole("button", { name: `Collapse ${name}`, exact: true });
  await expect.poll(order).toEqual(["A", "B", "C"]);
  await header("A").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete section", exact: true }).click();
  await expect.poll(order).toEqual(["B", "C"]);
  await header("C").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect.poll(order).toEqual(["C", "B"]);
  await sidebar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(order).toEqual(["A", "C", "B"]);
  await header("C").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(order).toEqual(["A", "B", "C"]);
  await expect(sidebar.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect.poll(order).toEqual(["A", "B", "C"]);
});

test("bots can be reordered by drag or keyboard and keep that order", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `bot-reorder-${stamp}@rakazo.test`, "password12", "Bot Order");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const alpha = await rpc<{ id: string }>(page, "bots/create", {
    name: "Alpha",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const beta = await rpc<{ id: string }>(page, "bots/create", {
    name: "Beta",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.reload();

  const sidebar = page.locator("aside").first();
  const rows = sidebar.locator("[data-roster-bot-id]");
  const order = () =>
    rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-roster-bot-id")));
  await expect.poll(order).toEqual([chiefId, alpha.id, beta.id]);

  let releaseStaleList!: () => void;
  let markStaleListReady!: () => void;
  let markStaleListDelivered!: () => void;
  const staleListReady = new Promise<void>((resolve) => {
    markStaleListReady = resolve;
  });
  const staleListDelivered = new Promise<void>((resolve) => {
    markStaleListDelivered = resolve;
  });
  const staleListGate = new Promise<void>((resolve) => {
    releaseStaleList = resolve;
  });
  let interceptedList = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (interceptedList) {
      await route.continue();
      return;
    }
    interceptedList = true;
    const staleResponse = await route.fetch();
    markStaleListReady();
    await staleListGate;
    await route.fulfill({ response: staleResponse });
    markStaleListDelivered();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await staleListReady;

  const reorderSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/reorder") && response.ok(),
  );
  await sidebar
    .locator(`[data-roster-bot-id="${beta.id}"]`)
    .dragTo(sidebar.locator(`[data-roster-bot-id="${chiefId}"]`));
  await reorderSaved;
  releaseStaleList();
  await staleListDelivered;
  await expect.poll(order).toEqual([beta.id, chiefId, alpha.id]);
  await page.reload();
  await expect.poll(order).toEqual([beta.id, chiefId, alpha.id]);

  const betaRow = sidebar.locator(`[data-roster-bot-id="${beta.id}"]`);
  await betaRow.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(order).toEqual([chiefId, beta.id, alpha.id]);
  await page.reload();
  await expect.poll(order).toEqual([chiefId, beta.id, alpha.id]);

  let releaseRejectedReorder!: () => void;
  let markRejectedReorderStarted!: () => void;
  const rejectedReorderStarted = new Promise<void>((resolve) => {
    markRejectedReorderStarted = resolve;
  });
  const rejectReorder = new Promise<void>((resolve) => {
    releaseRejectedReorder = resolve;
  });
  await page.route(
    "**/rpc/bots/reorder",
    async (route) => {
      markRejectedReorderStarted();
      await rejectReorder;
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    },
    { times: 1 },
  );
  await sidebar
    .locator(`[data-roster-bot-id="${alpha.id}"]`)
    .dragTo(sidebar.locator(`[data-roster-bot-id="${chiefId}"]`));
  await rejectedReorderStarted;

  const queuedReorderSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/reorder") && response.ok(),
  );
  await sidebar
    .locator(`[data-roster-bot-id="${beta.id}"]`)
    .dragTo(sidebar.locator(`[data-roster-bot-id="${alpha.id}"]`));
  releaseRejectedReorder();
  await queuedReorderSaved;
  await expect.poll(order).toEqual([beta.id, alpha.id, chiefId]);
  await page.reload();
  await expect.poll(order).toEqual([beta.id, alpha.id, chiefId]);
});

test("chat composer controls are vertically centered", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `composer-layout-${stamp}@rakazo.test`, "password12", "Composer Layout");
  await completeOnboarding(page);

  const bar = page.getByTestId("composer-bar");
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  const centers = await bar.evaluate((composerBar) =>
    ["Attach file", "Message Chief", "Voice", "Send"].map((label) => {
      const element = composerBar.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      if (!element) throw new Error(`Missing composer control: ${label}`);
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  );

  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

  await composer.fill("Short note");
  await expect(bar).toHaveAttribute("data-expanded", "false");
  await captureScreenshot(page, testInfo, "composer-one-line");

  const wrappedDraft =
    "This draft is long enough to wrap onto its own row above the controls. ".repeat(16);
  await composer.fill(wrappedDraft);
  await expect(bar).toHaveAttribute("data-expanded", "true");
  // The field moves up from the one-line slot; its box overlaps the controls until that finishes.
  await expect
    .poll(() =>
      bar.evaluate((composerBar) => {
        const field = composerBar.querySelector("textarea")?.parentElement ?? null;
        return [composerBar, field].every(
          (element) =>
            element?.getAnimations().every((animation) => animation.playState !== "running") ??
            true,
        );
      }),
    )
    .toBe(true);
  const fieldBox = await composer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    bottom: element.getBoundingClientRect().bottom,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    padding:
      Number.parseFloat(getComputedStyle(element).paddingTop) +
      Number.parseFloat(getComputedStyle(element).paddingBottom),
  }));
  const sendTop = await bar
    .getByRole("button", { name: "Send", exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(fieldBox.scrollHeight).toBeGreaterThan(fieldBox.clientHeight);
  expect(fieldBox.clientHeight).toBeLessThanOrEqual(fieldBox.lineHeight * 6 + fieldBox.padding);
  // Round both edges; a fractional bottom can sit just under a pixel past the slack.
  expect(Math.round(fieldBox.bottom)).toBeLessThanOrEqual(Math.round(sendTop) + 2);
  await captureScreenshot(page, testInfo, "composer-wrapped");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await expect(bar).toHaveAttribute("data-expanded", "true");

  await composer.fill("");
  await expect(composer).toHaveValue("");
  await expect(bar).toHaveAttribute("data-expanded", "false");

  await composer.fill(wrappedDraft);
  await expect(bar).toHaveAttribute("data-expanded", "true");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(bar).toHaveAttribute("data-expanded", "false");
});

test("group chats share every context-menu action", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-organize-${stamp}@rakazo.test`, "password12", "Group Menu");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Partner",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await rpc(page, "groups/create", {
    name: "Group menu",
    botIds: [chiefId, partner.id],
  });
  await page.reload();

  const sidebar = page.locator("aside").first();
  const group = sidebar.getByRole("button", { name: /^Group menu/ });
  await group.click({ button: "right" });
  for (const action of [
    "Pin",
    "Group",
    "Mark as Unread",
    "Edit Profile",
    "Duplicate",
    "Clear conversation",
    "Archive",
    "Delete",
  ]) {
    await expect(page.getByRole("menuitem", { name: action, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "group-context-menu-desktop");

  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Read", exact: true }).click();

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Group menu");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Group", exact: true }).click();
  const sectionName = page.getByRole("textbox", { name: "Section name", exact: true });
  await sectionName.fill("Teams");
  await sectionName.press("Enter");
  await expect(sidebar.locator('[data-sidebar-group^="section:"]')).toContainText("Group menu");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  for (const target of ["Teams", "Unassigned", "New section"]) {
    await expect(page.getByRole("menuitem", { name: target, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear Group menu’s conversation?" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "group-clear-conversation-confirmation");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear Group menu’s conversation?" }),
  ).toHaveCount(0);

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  const copy = sidebar.getByRole("button", { name: /^Group menu copy/ });
  await expect(copy).toBeVisible();

  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Group menu copy?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: /^Group menu copy/ })).toHaveCount(0);
  await expect(sidebar.getByText("Archived", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await group.click({ button: "right" });
  await captureScreenshot(page, testInfo, "group-context-menu-mobile");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile", exact: true }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "group-settings");
});

test("inline grouping retries failures and supports keyboard context menus, rename and undo", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `section-retry-${stamp}@rakazo.test`, "password12", "Section Recovery");
  await completeOnboarding(page);
  const route = page.url();
  const sidebar = page.locator("aside").first();
  const chief = sidebar.getByRole("button", { name: /^Chief/ });
  const sectionName = page.getByRole("textbox", { name: "Section name", exact: true });
  const sections = sidebar.locator('[data-sidebar-group^="section:"]');

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
  await page.route(
    "**/rpc/botSections/create",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Temporary test failure" }),
      }),
    { times: 1 },
  );

  await chief.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Group", exact: true }).click();
  await sectionName.fill("Recoverable");
  const failedCreate = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSections/create") && response.status() === 503,
  );
  await sectionName.press("Enter");
  await failedCreate;
  await expect(sectionName).toHaveValue("Recoverable");
  await expect(sectionName).toHaveAttribute("aria-invalid", "true");
  await expect(sectionName).toBeFocused();
  await expect(sections).toHaveCount(0);
  await captureScreenshot(page, testInfo, "section-create-failure-retains-draft");

  await sectionName.press("Enter");
  const recoverable = sidebar.getByRole("button", { name: "Collapse Recoverable", exact: true });
  await expect(recoverable).toBeVisible();
  await expect(sections).toContainText("Chief");
  await recoverable.focus();
  await page.keyboard.press("Control+z");
  await expect(sections).toHaveCount(0);
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
  expect(page.url()).toBe(route);

  await chief.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Group", exact: true }).click();
  await sectionName.fill("Projects");
  await sectionName.press("Enter");
  const projects = sidebar.getByRole("button", { name: "Collapse Projects", exact: true });
  await expect(projects).toBeVisible();
  await projects.focus();
  await page.keyboard.press("F2");
  await expect(sectionName).toHaveValue("Projects");
  await expect(sectionName).toBeFocused();
  await page.route(
    "**/rpc/botSections/update",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Temporary test failure" }),
      }),
    { times: 1 },
  );
  await sectionName.fill("Delivery");
  const failedRename = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSections/update") && response.status() === 503,
  );
  await sectionName.press("Enter");
  await failedRename;
  await expect(sectionName).toHaveValue("Delivery");
  await expect(sectionName).toHaveAttribute("aria-invalid", "true");
  await expect(sectionName).toBeFocused();
  await captureScreenshot(page, testInfo, "section-rename-failure-retains-draft");
  await sectionName.press("Enter");
  const delivery = sidebar.getByRole("button", { name: "Collapse Delivery", exact: true });
  await expect(delivery).toBeVisible();
  await delivery.focus();
  await page.keyboard.press("Control+z");
  await expect(projects).toBeVisible();

  await projects.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Rename section", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete section", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await chief.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Unassigned", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="unassigned"]')).toContainText("Chief");
  await expect(sections.getByRole("button", { name: /^Chief/ })).toHaveCount(0);
  await projects.focus();
  await page.keyboard.press("Control+z");
  await expect(sections).toContainText("Chief");
  expect(page.url()).toBe(route);
});
