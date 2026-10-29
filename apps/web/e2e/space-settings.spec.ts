import type { Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ActionApprovalRule, Me, ModelCredential, SpaceNavigation } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openNewSpace, rpc, signup } from "./helpers";

async function inSpace<T>(page: Page, spaceId: string, procedure: string): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, {
    headers: { "x-rakazo-space-id": spaceId },
    data: { json: {} },
  });
  expect(response.ok(), `${procedure}: ${response.status()}`).toBe(true);
  return ((await response.json()) as { json: T }).json;
}

async function fixture(page: Page) {
  await signup(page, `space-settings-${Date.now()}@coginebot.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  await openNewSpace(page);
  const create = page.getByRole("dialog", { name: "New space" });
  await create.getByLabel("Name").fill("Support");
  await create.getByRole("button", { name: "Create space", exact: true }).click();
  await completeOnboarding(page);
  await expect(page.getByTestId("sidebar-current-space")).toContainText("Support");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const { spaces } = await rpc<SpaceNavigation>(page, "spaces/list", {});
  const personal = spaces.find((space) => space.name === "Personal")!;
  const support = spaces.find((space) => space.name === "Support")!;
  expect(personal).toBeDefined();
  expect(support).toBeDefined();
  const chatUrl = page.url();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(support.id);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Keep the current chat draft. 保留草稿。");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: "Personal", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(
    settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
  ).toHaveText("Personal");
  return { personal, support, chatUrl, settings, composer };
}

test("editing another Space saves its models and confirmations without moving the chat", async ({
  page,
}, testInfo) => {
  const { personal, support, chatUrl, settings, composer } = await fixture(page);
  const spacePicker = settings.getByTestId("settings-space");
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await spacePicker.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Close model settings", exact: true }),
    ).toBeFocused();
    await spacePicker.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
    await expect(spacePicker).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
    await expect(spacePicker).toBeFocused();
  }
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
  await expect(spacePicker).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
  const searchProviders = settings.getByPlaceholder("Search providers");
  await searchProviders.click();
  await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
  await expect(searchProviders).toBeFocused();
  await expect(spacePicker.locator('[data-slot="select-value"]')).toHaveText("Personal");
  const originalModels = await inSpace<ModelCredential[]>(page, support.id, "models/credentials");
  const originalMe = await inSpace<Me>(page, support.id, "me");
  const originalRules = await inSpace<ActionApprovalRule[]>(page, support.id, "approvalRules/list");
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await settings.getByPlaceholder("Search providers").fill("openai-compatible");
  await settings.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await settings.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await settings.getByLabel("Model id").fill("personal-target-model");
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/models/connect") && response.ok(),
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).request().headers()["x-rakazo-space-id"]).toBe(personal.id);
  await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
  const personalModels = await inSpace<ModelCredential[]>(page, personal.id, "models/credentials");
  expect(personalModels).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ modelId: "personal-target-model", isDefault: true }),
    ]),
  );
  // Connections belong to the account; their default-model preferences belong to a Space.
  const supportModels = await inSpace<ModelCredential[]>(page, support.id, "models/credentials");
  expect(
    supportModels.filter((row) => originalModels.some((original) => original.id === row.id)),
  ).toEqual(originalModels);
  expect(supportModels).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: personalModels.find((row) => row.modelId === "personal-target-model")?.id,
        isDefault: false,
      }),
    ]),
  );
  const supportMe = await inSpace<Me>(page, support.id, "me");
  expect({ provider: supportMe.defaultProvider, model: supportMe.defaultModel }).toEqual({
    provider: originalMe.defaultProvider,
    model: originalMe.defaultModel,
  });
  expect((await inSpace<Me>(page, personal.id, "me")).defaultModel).toBe("personal-target-model");

  await settings.getByTestId("settings-nav-confirmations").click();
  const ruleSaved = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/approvalRules/set") && response.ok(),
  );
  await settings.getByRole("button", { name: "Ask before purchases", exact: true }).click();
  expect((await ruleSaved).request().headers()["x-rakazo-space-id"]).toBe(personal.id);
  expect(await inSpace<ActionApprovalRule[]>(page, personal.id, "approvalRules/list")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ matchKind: "category", matchValue: "purchase" }),
    ]),
  );
  expect(await inSpace<ActionApprovalRule[]>(page, support.id, "approvalRules/list")).toEqual(
    originalRules,
  );
  await captureScreenshot(page, testInfo, "space-confirmations-target-personal");

  for (const [section, procedure] of [
    ["memory", "memory/providerConfig"],
    ["voice", "voice/credentials"],
  ] as const) {
    const loaded = page.waitForRequest((request) => request.url().endsWith(`/rpc/${procedure}`));
    await settings.getByTestId(`settings-nav-${section}`).click();
    expect((await loaded).headers()["x-rakazo-space-id"]).toBe(personal.id);
    await expect(settings.getByTestId(`${section}-settings`)).toBeVisible();
  }
  await settings.getByTestId("settings-space").click();
  await page.getByRole("option", { name: "Support", exact: true }).click();
  await expect(
    settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
  ).toHaveText("Support");
  await captureScreenshot(page, testInfo, "space-settings-target-support-current-chat-retained");
  await settings.getByTestId("settings-nav-general").click();
  await expect(settings.getByTestId("settings-space")).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close user settings", exact: true }).click();
  expect(page.url()).toBe(chatUrl);
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(support.id);
  await expect(composer).toHaveValue("Keep the current chat draft. 保留草稿。");
});

test("switching the settings target discards a late memory response", async ({
  page,
}, testInfo) => {
  const { personal, support, settings } = await fixture(page);
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finished!: () => void;
  const settled = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const recordSettled = (request: Request) => {
    if (
      request.url().endsWith("/rpc/memory/providerConfig") &&
      request.headers()["x-rakazo-space-id"] === personal.id
    ) {
      finished();
    }
  };
  page.on("requestfinished", recordSettled);
  page.on("requestfailed", recordSettled);
  await page.route("**/rpc/memory/providerConfig", async (route) => {
    if (route.request().headers()["x-rakazo-space-id"] !== personal.id) {
      await route.continue();
      return;
    }
    arrived();
    await gate;
    await route.fulfill({
      json: {
        json: {
          provider: "serenity",
          settings: { brainLabel: "Late Personal memory", allowWrites: "false" },
          defaultMemoryScope: "isolated",
          updatedAt: "2026-10-20T00:00:00.000Z",
        },
      },
    });
  });
  try {
    await settings.getByTestId("settings-nav-memory").click();
    await received;
    await settings.getByTestId("settings-space").click();
    await page.getByRole("option", { name: "Support", exact: true }).click();
    await expect(
      settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
    ).toHaveText("Support");
    await expect(settings.getByTestId("memory-settings").getByLabel("Provider")).toBeVisible();
    release();
    await settled;
    await expect(settings.getByText(/Late Personal memory/)).toHaveCount(0);
    await expect(settings.getByTestId("memory-settings").getByLabel("Provider")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(support.id);
    await captureScreenshot(page, testInfo, "space-memory-late-response-discarded");
  } finally {
    release();
    page.off("requestfinished", recordSettled);
    page.off("requestfailed", recordSettled);
    await page.unroute("**/rpc/memory/providerConfig");
  }
});

test("a shared Space member can open settings without owner actions or a chat switch", async ({
  page,
  browser,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `space-settings-owner-${stamp}@coginebot.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const ownerActor = await rpc<Me>(page, "me", {});
  const shared = await rpc<{ id: string }>(page, "spaces/create", { name: "Shared research" });
  const privateSpace = await rpc<{ id: string }>(page, "spaces/create", { name: "Owner private" });
  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const member = await memberContext.newPage();
    await signup(
      member,
      `space-settings-member-${stamp}@coginebot.test`,
      "password12",
      "Space Member",
    );
    await completeOnboarding(member);
    const memberActor = await rpc<Me>(member, "me", {});
    expect(process.env.DATABASE_URL).toBeTruthy();
    const { createDb } = await import("../../../packages/db/src/client");
    const db = createDb(process.env.DATABASE_URL!, {
      poolMax: 2,
      applicationName: "space-settings-member-fixture",
    });
    try {
      const sharedRow = await db.prisma.space.findUniqueOrThrow({
        where: { id: shared.id },
        select: { organizationId: true },
      });
      // Seed only isolated test membership; navigation, settings and denied writes use the API.
      await db.prisma.member.create({
        data: {
          id: crypto.randomUUID(),
          userId: memberActor.userId,
          organizationId: sharedRow.organizationId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: crypto.randomUUID(),
          userId: memberActor.userId,
          organizationId: sharedRow.organizationId,
          spaceId: shared.id,
          role: "member",
          createdAt: new Date(),
        },
      });
      const defaultMembership = await db.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: ownerActor.spaceId, userId: memberActor.userId } },
      });
      expect(defaultMembership).toMatchObject({
        spaceId: ownerActor.spaceId,
        userId: memberActor.userId,
        role: "member",
      });
      expect(
        await db.prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: privateSpace.id, userId: memberActor.userId } },
        }),
      ).toBeNull();
      await testInfo.attach("space-member-permission-fixture", {
        contentType: "application/json",
        body: JSON.stringify({
          defaultMembership: {
            spaceId: defaultMembership!.spaceId,
            userId: defaultMembership!.userId,
            role: defaultMembership!.role,
          },
          privateMembership: null,
        }),
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    const created = await member.request.post("/rpc/spaces/create", {
      headers: { "x-rakazo-space-id": shared.id },
      data: { json: { name: "Member chats" } },
    });
    expect(created.ok()).toBe(true);
    const { json: chatSpace } = (await created.json()) as { json: { id: string } };
    await member.evaluate(
      (spaceId) => localStorage.setItem("rakazo:space-id", spaceId),
      chatSpace.id,
    );
    await member.goto("/onboarding");
    await completeOnboarding(member);
    await expect(member.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    const navigation = await inSpace<SpaceNavigation>(member, chatSpace.id, "spaces/list");
    expect(navigation.spaces.find((space) => space.id === shared.id)).toMatchObject({
      canRename: false,
      canDelete: false,
    });
    for (const [procedure, input] of [
      ["spaces/rename", { spaceId: shared.id, name: "Forbidden rename" }],
      ["spaces/remove", { spaceId: shared.id }],
    ] as const) {
      const denied = await member.request.post(`/rpc/${procedure}`, {
        headers: { "x-rakazo-space-id": chatSpace.id },
        data: { json: input },
      });
      expect(denied.status()).toBe(403);
    }
    for (const [procedure, input] of [
      [
        "memory/connectProvider",
        { provider: "serenity", settings: {}, credentials: {}, defaultMemoryScope: "isolated" },
      ],
      ["memory/setDefaultScope", { defaultMemoryScope: "shared" }],
      ["memory/disconnectProvider", {}],
    ] as const) {
      const denied = await member.request.post(`/rpc/${procedure}`, {
        headers: { "x-rakazo-space-id": shared.id },
        data: { json: input },
      });
      expect(denied.status()).toBe(403);
    }
    expect(await inSpace<Me>(member, ownerActor.spaceId, "me")).toMatchObject({
      spaceId: ownerActor.spaceId,
      userId: memberActor.userId,
    });
    const inaccessible = await member.request.post("/rpc/me", {
      headers: { "x-rakazo-space-id": privateSpace.id },
      data: { json: {} },
    });
    expect(inaccessible.status()).toBe(403);
    const chatUrl = member.url();
    const composer = member.getByRole("combobox", { name: "Message Chief" });
    await composer.fill("Keep this member's chat draft.");
    const header = member
      .locator("aside")
      .first()
      .getByRole("button", { name: "Shared research", exact: true });
    await header.click({ button: "right" });
    await expect(member.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
    await expect(member.getByRole("menuitem", { name: "Rename space", exact: true })).toHaveCount(
      0,
    );
    await expect(member.getByRole("menuitem", { name: "Delete space", exact: true })).toHaveCount(
      0,
    );
    await captureScreenshot(member, testInfo, "space-member-settings-menu");
    await member.keyboard.press("Escape");
    await header.focus();
    await member.keyboard.press("Shift+F10");
    const settingsRead = member.waitForRequest(
      (request) =>
        request.url().endsWith("/rpc/me") && request.headers()["x-rakazo-space-id"] === shared.id,
    );
    await member.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await settingsRead;
    const settings = member.getByTestId("user-settings");
    await expect(
      settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
    ).toHaveText("Shared research");
    expect((await inSpace<Me>(member, shared.id, "me")).spaceId).toBe(shared.id);
    await captureScreenshot(member, testInfo, "space-member-settings-target");
    await settings.getByRole("button", { name: "Close model settings", exact: true }).click();
    await expect(composer).toHaveValue("Keep this member's chat draft.");
    expect(member.url()).toBe(chatUrl);
    expect(await member.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(chatSpace.id);
  } finally {
    await memberContext.close();
  }
});

for (const role of ["owner", "member"] as const) {
  test(`an empty sole Space ${role} can open its context menu from the existing switcher`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `sole-space-${role}-${Date.now()}@coginebot.test`,
      "password12",
      "Space User",
    );
    await completeOnboarding(page);
    const actor = await rpc<Me>(page, "me", {});
    const [chief] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
    expect(chief).toBeDefined();
    await rpc(page, "bots/archive", { botId: chief!.id });
    if (role === "member") {
      expect(process.env.DATABASE_URL).toBeTruthy();
      const { createDb } = await import("../../../packages/db/src/client");
      const db = createDb(process.env.DATABASE_URL!, {
        poolMax: 2,
        applicationName: "sole-space-member-fixture",
      });
      try {
        const membership = await db.prisma.spaceMember.update({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
          data: { role: "member" },
        });
        expect(membership.role).toBe("member");
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
    await page.reload();
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    const navigation = await inSpace<SpaceNavigation>(page, actor.spaceId, "spaces/list");
    expect(navigation.spaces).toHaveLength(1);
    expect(navigation.spaces[0]).toMatchObject({
      id: actor.spaceId,
      canRename: role === "owner",
      canDelete: false,
      bots: [],
      groups: [],
      botSections: [],
    });
    const sidebar = page.locator("aside").first();
    await expect(sidebar.locator("[data-sidebar-section-header]")).toHaveCount(0);
    // Let the archived chat route settle before checking settings isolation.
    await expect(page).toHaveURL(/\/app$/);
    const currentUrl = page.url();
    const selectedSpace = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));

    // The account entry still reaches the current Space; the direct context shortcut is separate.
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("user-settings");
    await settings.getByTestId("settings-nav-models").click();
    await expect(
      settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
    ).toHaveText("Personal");
    await settings.getByRole("button", { name: "Close model settings", exact: true }).click();
    await expect(settings).toHaveCount(0);

    const switcher = page.getByTestId("space-menu-trigger");
    for (const activation of ["click", "Enter", "Space"]) {
      await switcher.focus();
      if (activation === "click") await switcher.click();
      else await page.keyboard.press(activation);
      await expect(page.getByTestId("create-new-space")).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("create-new-space")).toHaveCount(0);
      await expect(switcher).toBeFocused();
    }
    for (const [activation, contextGesture] of [
      ["click", "pointer"],
      ["Enter", "ContextMenu"],
      ["Space", "Shift+F10"],
    ] as const) {
      await switcher.focus();
      if (activation === "click") await switcher.click();
      else await page.keyboard.press(activation);
      await expect(page.getByTestId("create-new-space")).toBeVisible();
      if (contextGesture === "pointer") await switcher.click({ button: "right" });
      else {
        await switcher.focus();
        await page.keyboard.press(contextGesture);
      }
      await expect(page.getByTestId("create-new-space")).toHaveCount(0);
      const settingsAction = page.getByRole("menuitem", { name: "Settings", exact: true });
      await expect(settingsAction).toBeVisible();
      await expect(page.getByRole("menu", { name: "Actions for space" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settingsAction).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(settingsAction).toHaveCount(0);
      await expect(switcher).toBeFocused();
    }
    for (const activation of ["pointer", "ContextMenu", "Shift+F10"]) {
      await switcher.focus();
      if (activation === "pointer") await switcher.click({ button: "right" });
      else await page.keyboard.press(activation);
      const settingsAction = page.getByRole("menuitem", { name: "Settings", exact: true });
      await expect(settingsAction).toBeVisible();
      await expect(page.getByRole("menu", { name: "Actions for space" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settingsAction).toBeFocused();
      await expect(page.getByRole("menuitem", { name: "Rename space", exact: true })).toHaveCount(
        role === "owner" ? 1 : 0,
      );
      await expect(page.getByRole("menuitem", { name: "Delete space", exact: true })).toHaveCount(
        0,
      );
      if (activation === "pointer")
        await captureScreenshot(page, testInfo, `space-sole-${role}-context-menu`);
      if (activation !== "Shift+F10") {
        await page.keyboard.press("Escape");
        await expect(switcher).toBeFocused();
      }
    }
    const targetRead = page.waitForRequest(
      (request) =>
        request.url().endsWith("/rpc/me") &&
        request.headers()["x-rakazo-space-id"] === actor.spaceId,
    );
    await page.keyboard.press("Enter");
    await targetRead;
    await expect(settings).toHaveAttribute("data-settings-section", "models");
    await expect(
      settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
    ).toHaveText("Personal");
    if (role === "member") {
      for (const [procedure, input] of [
        ["spaces/rename", { spaceId: actor.spaceId, name: "Forbidden rename" }],
        ["spaces/remove", { spaceId: actor.spaceId }],
        ["memory/disconnectProvider", {}],
      ] as const) {
        const denied = await page.request.post(`/rpc/${procedure}`, {
          headers: { "x-rakazo-space-id": actor.spaceId },
          data: { json: input },
        });
        expect(denied.status()).toBe(403);
      }
    }
    await captureScreenshot(page, testInfo, `space-sole-${role}-settings`);
    await settings.getByRole("button", { name: "Close model settings", exact: true }).click();
    await expect(settings).toHaveCount(0);
    expect(page.url()).toBe(currentUrl);
    expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selectedSpace);
    await expect(sidebar.locator("[data-sidebar-section-header]")).toHaveCount(0);
    await page.getByTestId("minimize-bots-sidebar").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await switcher.focus();
    await page.keyboard.press("ContextMenu");
    await expect(page.getByRole("menu", { name: "Actions for space" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(switcher).toBeFocused();
    await page.getByTestId("restore-bots-sidebar").click();
    expect(page.url()).toBe(currentUrl);
    expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selectedSpace);
  });
}
