import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type GroupRow = {
  id: string;
  name: string;
  threadId: string;
  members: Array<{ botId: string; name: string }>;
};
type UpdatePayload = { groupId: string; name?: string; botIds?: string[] };
type BrowserError = { kind: string; message: string; url?: string; expected: boolean };

const memberNames = [
  "Member Alpha",
  "Member Beta",
  "Member Gamma",
  "Member Delta",
  "Member Epsilon",
  "Member Zeta",
  "Member Eta with a longer English name for a familiar and thoughtful companion",
];
const draftText = "Keep this thought.\n安排慢一点。";
const draftFile = "成员管理草稿 Mixed notes.txt";
const errorsByPage = new WeakMap<Page, BrowserError[]>();
const expectedFaultByPage = new WeakMap<Page, string>();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: BrowserError[] = [];
  errorsByPage.set(page, errors);
  page.on("pageerror", (error) =>
    errors.push({ kind: "pageerror", message: error.message, expected: false }),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    errors.push({
      kind: "console.error",
      message: message.text(),
      url,
      expected:
        expectedFaultByPage.get(page) === url &&
        message.text().startsWith("Failed to load resource:"),
    });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const errors = errorsByPage.get(page) ?? [];
  if (errors.length) {
    await testInfo.attach("browser-errors", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(errors, null, 2)),
    });
  }
  expect
    .soft(
      errors.filter((error) => !error.expected),
      "no unexpected browser errors",
    )
    .toEqual([]);
});

function settings(page: Page) {
  return page.getByTestId("side-panel");
}

function composer(page: Page) {
  return page.getByTestId("composer-bar").locator('textarea[name="chat-message"]');
}

async function createGroup(page: Page, name: string, botIds: string[]) {
  return rpc<GroupRow>(page, "groups/create", { name, botIds });
}

async function fixture(page: Page, label: string, distinctPortraits = false) {
  await signup(page, `members-${label}-${Date.now()}@rakazo.test`, "password12", "Group Review");
  await completeOnboarding(page);
  const ids: string[] = [];
  for (const [index, name] of memberNames.entries()) {
    // Distinct uploaded fixtures exercise the image path and make a Beta/Gamma
    // substitution observable alongside the Bot identity and order checks.
    const color = distinctPortraits
      ? await page.evaluate((index) => {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 64;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Fixture canvas is unavailable");
          context.fillStyle = `hsl(${index * 43}, 45%, 85%)`;
          context.fillRect(0, 0, 64, 64);
          context.fillStyle = `hsl(${index * 43}, 35%, 45%)`;
          context.beginPath();
          context.arc(32, 32, 22, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "white";
          context.fillRect(22, 25, 5, 8);
          context.fillRect(37, 25, 5, 8);
          return canvas.toDataURL("image/png");
        }, index)
      : undefined;
    const bot = await rpc<{ id: string }>(page, "bots/create", {
      name,
      title: "",
      description: "",
      notifyOnFinish: true,
      color,
    });
    ids.push(bot.id);
  }
  const group = await createGroup(page, `Members ${label}`, ids.slice(0, 2));
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(composer(page)).toBeVisible();
  return { ids, group };
}

async function serverGroup(page: Page, groupId: string) {
  const groups = await rpc<GroupRow[]>(page, "groups/list", {});
  const group = groups.find((row) => row.id === groupId);
  expect(group, "group exists on the server").toBeDefined();
  return group as GroupRow;
}

async function expectServerMembers(page: Page, groupId: string, ids: string[]) {
  const group = await serverGroup(page, groupId);
  const actual = group.members.map((member) => member.botId);
  expect(actual).toHaveLength(ids.length);
  expect(new Set(actual).size).toBe(ids.length);
  expect([...actual].sort()).toEqual([...ids].sort());
  return group;
}

async function openSettings(page: Page) {
  await page.getByTestId("bot-settings-trigger").click();
  await expect(settings(page)).toHaveAttribute("data-panel", "group-settings");
  await expect(settings(page).getByRole("button", { name: "Save", exact: true })).toBeVisible();
}

async function toggleMember(page: Page, index: number) {
  await settings(page).getByRole("button", { name: memberNames[index], exact: true }).click();
}

async function expectSelected(page: Page, indexes: number[]) {
  const names = await settings(page).locator('button[aria-pressed="true"]').allTextContents();
  expect(names.sort()).toEqual(indexes.map((index) => memberNames[index]).sort());
}

async function saveSettings(page: Page) {
  await settings(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings(page)).toHaveAttribute("data-panel", "closed");
}

async function addDraft(page: Page) {
  await composer(page).fill("@Member Beta");
  await page.getByRole("option", { name: "@Member Beta", exact: true }).click();
  await composer(page).fill(draftText);
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: draftFile,
      mimeType: "text/plain",
      buffer: Buffer.from("Take time for a quiet afternoon.\n"),
    });
  await expectDraft(page);
}

async function expectDraft(page: Page) {
  const bar = page.getByTestId("composer-bar");
  await expect(composer(page)).toHaveValue(draftText);
  await expect(bar.getByTestId("mention-chip")).toHaveCount(1);
  await expect(bar.getByTestId("mention-chip")).toContainText("Member Beta");
  await expect(bar.getByTestId("attachment-preview")).toHaveCount(1);
  await expect(bar.getByRole("button", { name: `Remove ${draftFile}`, exact: true })).toBeVisible();
}

async function avatarPresentations(avatars: Locator) {
  return avatars.evaluateAll((elements) =>
    elements.map((element) => {
      const gaze = element.querySelector(".rakazo-gaze-avatar");
      return {
        identity: element.getAttribute("data-avatar-identity"),
        image: element.querySelector("img")?.getAttribute("src") ?? null,
        shape: gaze?.getAttribute("data-shape") ?? null,
        eyes: gaze?.getAttribute("data-eyes") ?? null,
        color: gaze?.querySelector("path")?.getAttribute("fill") ?? null,
      };
    }),
  );
}

async function groupAvatarPresentations(page: Page, groupId: string) {
  const header = page.getByTestId("bot-settings-trigger").locator(".rakazo-group-avatar");
  const row = page.locator(`[data-roster-group-id="${groupId}"]`);
  return {
    header: await avatarPresentations(header.locator(".rakazo-bot-avatar")),
    sidebar: await avatarPresentations(row.locator(".rakazo-bot-avatar")),
  };
}

async function expectAvatars(page: Page, groupId: string, count: number) {
  const group = await serverGroup(page, groupId);
  const visible = group.members.slice(0, count <= 3 ? count : 2);
  const expected = [];
  for (const member of visible) {
    const avatar = page.locator(`[data-roster-bot-id="${member.botId}"] .rakazo-bot-avatar`);
    await expect(avatar).toHaveCount(1);
    await expect(avatar).toHaveAttribute("data-avatar-identity", member.botId);
    expected.push(...(await avatarPresentations(avatar)));
  }
  await expect
    .poll(() => groupAvatarPresentations(page, groupId))
    .toEqual({
      header: expected,
      sidebar: expected,
    });
  const header = page.getByTestId("bot-settings-trigger").locator(".rakazo-group-avatar");
  const row = page.locator(`[data-roster-group-id="${groupId}"]`);
  await expect(header.locator(".rakazo-bot-avatar")).toHaveCount(visible.length);
  if (count > 3) {
    await expect(header).toContainText(`+${count - 2}`);
    await expect(row).toContainText(`+${count - 2}`);
  }
  const boxes = await header.locator(".rakazo-bot-avatar").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  for (const box of boxes) expect(Math.abs(box.width - box.height)).toBeLessThan(1);
}

async function pauseUpdates(page: Page) {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const calls: UpdatePayload[] = [];
  const handler = async (route: Route) => {
    calls.push((route.request().postDataJSON() as { json: UpdatePayload }).json);
    arrived();
    await gate;
    await route.continue();
  };
  await page.route("**/rpc/groups/update", handler);
  return {
    calls,
    received,
    release,
    async dispose() {
      release();
      await page.unroute("**/rpc/groups/update", handler);
    },
  };
}

test("member changes refresh portraits in order and preserve the Space-wide mention catalog", async ({
  page,
}, testInfo) => {
  const { ids, group } = await fixture(page, "familiar", true);
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 2);
  await saveSettings(page);
  await expectServerMembers(page, group.id, ids.slice(0, 3));
  await expectAvatars(page, group.id, 3);
  const initialPortraits = await groupAvatarPresentations(page, group.id);
  expect(new Set(initialPortraits.header.map((avatar) => avatar.image)).size).toBe(3);
  await expectDraft(page);
  await openSettings(page);
  await toggleMember(page, 1);
  await saveSettings(page);
  const updated = await expectServerMembers(page, group.id, [ids[0], ids[2]]);
  expect(updated.threadId).toBe(group.threadId);
  await expectAvatars(page, group.id, 2);
  await expectDraft(page);
  // Group member updates must not change the existing Space-wide @ chooser.
  await composer(page).fill("@Member ");
  for (const name of memberNames) {
    await expect(page.getByRole("option", { name: `@${name}`, exact: true })).toBeVisible();
  }
  await composer(page).fill(draftText);
  await expectDraft(page);
  await captureScreenshot(page, testInfo, "members-alpha-gamma-and-draft");
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expectAvatars(page, group.id, 2);
  await openSettings(page);
  await expectSelected(page, [0, 2]);
  await expect(composer(page)).toHaveValue("");
});

test("Close panel and Escape discard settings edits while keeping the chat draft", async ({
  page,
}, testInfo) => {
  const { ids, group } = await fixture(page, "cancel");
  await addDraft(page);
  await page.setViewportSize({ width: 800, height: 800 });
  for (const method of ["close", "escape"] as const) {
    await openSettings(page);
    const name = settings(page).getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Unsaved longer English group name for a thoughtful gathering of companions");
    await toggleMember(page, 2);
    const longName = settings(page).getByRole("button", { name: memberNames[6], exact: true });
    await longName.scrollIntoViewIfNeeded();
    await expect(longName).toBeVisible();
    const close = settings(page).getByRole("button", { name: "Close panel", exact: true });
    await expect(close).toBeVisible();
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    expect((closeBox?.x ?? 0) + (closeBox?.width ?? 0)).toBeLessThanOrEqual(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      800,
    );
    if (method === "close") {
      await captureScreenshot(page, testInfo, "group-settings-narrow-long-name");
      await close.click();
    } else {
      await name.press("Escape");
    }
    await expect(settings(page)).toHaveAttribute("data-panel", "closed");
    await expectDraft(page);
    await expectServerMembers(page, group.id, ids.slice(0, 2));
    await openSettings(page);
    await expect(settings(page).getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
      group.name,
    );
    await expectSelected(page, [0, 1]);
    await settings(page).getByRole("button", { name: "Close panel", exact: true }).click();
  }
});

test("group member bounds and repeated unchanged saves keep distinct members", async ({ page }) => {
  const { ids, group } = await fixture(page, "bounds");
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 1);
  await expect(settings(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await toggleMember(page, 1);
  for (const index of [2, 3, 4, 5]) await toggleMember(page, index);
  await toggleMember(page, 6);
  await expectSelected(page, [0, 1, 2, 3, 4, 5]);
  const name = settings(page).getByRole("textbox", { name: "Name", exact: true });
  await name.fill("");
  await expect(settings(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await name.fill(group.name);
  await saveSettings(page);
  await expectServerMembers(page, group.id, ids.slice(0, 6));
  await expectAvatars(page, group.id, 6);
  await openSettings(page);
  const request = page.waitForRequest((request) => request.url().endsWith("/rpc/groups/update"));
  await saveSettings(page);
  expect((await request).postDataJSON()).toEqual({ json: { groupId: group.id } });
  await expectServerMembers(page, group.id, ids.slice(0, 6));
  await expectDraft(page);
});

for (const fault of ["rejected", "response-lost"] as const) {
  test(`member save ${fault} retains edits and draft for a retry without duplicate members`, async ({
    page,
  }, testInfo) => {
    const { ids, group } = await fixture(page, fault);
    await addDraft(page);
    await openSettings(page);
    await toggleMember(page, 2);
    expectedFaultByPage.set(page, new URL("/rpc/groups/update", page.url()).toString());
    await page.route("**/rpc/groups/update", async (route) => {
      if (fault === "rejected") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "INTERNAL_SERVER_ERROR", message: "Injected test rejection" },
          }),
        });
      } else {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      }
    });
    await settings(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings(page).getByRole("alert")).toBeVisible();
    await expect(settings(page).getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expectSelected(page, [0, 1, 2]);
    await expectDraft(page);
    await expectServerMembers(page, group.id, ids.slice(0, fault === "rejected" ? 2 : 3));
    await captureScreenshot(page, testInfo, `member-save-${fault}-retained`);
    await page.unroute("**/rpc/groups/update");
    expectedFaultByPage.delete(page);
    await saveSettings(page);
    await expectServerMembers(page, group.id, ids.slice(0, 3));
    await expectAvatars(page, group.id, 3);
    await expectDraft(page);
  });
}

test("pending member save disables edits and rejects duplicate save requests", async ({ page }) => {
  const { ids, group } = await fixture(page, "pending");
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 2);
  const paused = await pauseUpdates(page);
  try {
    await settings(page).getByRole("button", { name: "Save", exact: true }).click();
    await paused.received;
    const saving = settings(page).getByRole("button", { name: "Saving…", exact: true });
    await expect(saving).toBeDisabled();
    await expect(
      settings(page).getByRole("button", { name: "Delete group", exact: true }),
    ).toBeDisabled();
    await expect(settings(page).getByRole("textbox", { name: "Name", exact: true })).toBeDisabled();
    for (const name of memberNames) {
      await expect(settings(page).getByRole("button", { name, exact: true })).toBeDisabled();
    }
    await saving.evaluate((button) => (button as HTMLButtonElement).click());
    await settings(page)
      .getByRole("button", { name: memberNames[3], exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expectSelected(page, [0, 1, 2]);
    expect(paused.calls).toHaveLength(1);
    paused.release();
    await expect(settings(page)).toHaveAttribute("data-panel", "closed");
    await expectServerMembers(page, group.id, ids.slice(0, 3));
    await expectAvatars(page, group.id, 3);
    await expectDraft(page);
  } finally {
    await paused.dispose();
  }
});

test("old group save completion leaves another group's settings and draft intact", async ({
  page,
}, testInfo) => {
  const { ids, group } = await fixture(page, "source");
  const destination = await createGroup(page, "Members destination", [ids[3], ids[4]]);
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 2);
  const paused = await pauseUpdates(page);
  try {
    await settings(page).getByRole("button", { name: "Save", exact: true }).click();
    await paused.received;
    await page.locator(`[data-roster-group-id="${destination.id}"]`).click();
    await openSettings(page);
    await addDraft(page);
    const name = settings(page).getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Destination unsaved thought");
    await toggleMember(page, 5);
    paused.release();
    await expect.poll(async () => (await serverGroup(page, group.id)).members.length).toBe(3);
    await expectAvatars(page, destination.id, 2);
    await expect(settings(page)).toHaveAttribute("data-panel", "group-settings");
    await expect(name).toHaveValue("Destination unsaved thought");
    await expectSelected(page, [3, 4, 5]);
    await expectServerMembers(page, destination.id, [ids[3], ids[4]]);
    await expectDraft(page);
    expect(paused.calls).toHaveLength(1);
    await captureScreenshot(page, testInfo, "destination-settings-after-source-save");
    await page.locator(`[data-roster-group-id="${group.id}"]`).click();
    await expectDraft(page);
    await expectAvatars(page, group.id, 3);
  } finally {
    await paused.dispose();
  }
});

test("closing and reopening the same group's pending save starts an independent editing session", async ({
  page,
}) => {
  const { ids, group } = await fixture(page, "reopen");
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 2);
  const paused = await pauseUpdates(page);
  try {
    await settings(page).getByRole("button", { name: "Save", exact: true }).click();
    await paused.received;
    await settings(page).getByRole("button", { name: "Close panel", exact: true }).click();
    await expect(settings(page)).toHaveAttribute("data-panel", "closed");
    await openSettings(page);
    const name = settings(page).getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeEnabled();
    await name.fill("A new editing session");
    await toggleMember(page, 3);
    paused.release();
    await expect.poll(async () => (await serverGroup(page, group.id)).members.length).toBe(3);
    await expectServerMembers(page, group.id, ids.slice(0, 3));
    await expectAvatars(page, group.id, 3);
    await expect(settings(page)).toHaveAttribute("data-panel", "group-settings");
    await expect(name).toHaveValue("A new editing session");
    await expectSelected(page, [0, 1, 3]);
    await expectDraft(page);
    await settings(page).getByRole("button", { name: "Close panel", exact: true }).click();
    await openSettings(page);
    await expect(name).toHaveValue(group.name);
    await expectSelected(page, [0, 1, 2]);
    expect(paused.calls).toHaveLength(1);
  } finally {
    await paused.dispose();
  }
});

test("saved member portraits update even when the subsequent thread refresh fails", async ({
  page,
}, testInfo) => {
  const { ids, group } = await fixture(page, "snapshot");
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 2);
  let failedGets = 0;
  expectedFaultByPage.set(page, new URL("/rpc/threads/get", page.url()).toString());
  await page.route("**/rpc/threads/get", async (route) => {
    const payload = route.request().postDataJSON() as { json?: { groupId?: string } };
    if (payload.json?.groupId === group.id) {
      failedGets += 1;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await saveSettings(page);
  await expectServerMembers(page, group.id, ids.slice(0, 3));
  await expect.poll(() => failedGets).toBeGreaterThan(0);
  await expectAvatars(page, group.id, 3);
  await expectDraft(page);
  await captureScreenshot(page, testInfo, "saved-portraits-despite-refresh-failure");
  await page.unroute("**/rpc/threads/get");
  expectedFaultByPage.delete(page);
});

test("a saved group closes immediately while its follow-up thread refresh is still pending", async ({
  page,
}, testInfo) => {
  const { ids, group } = await fixture(page, "slow-refresh");
  await addDraft(page);
  await openSettings(page);
  await toggleMember(page, 2);
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const handler = async (route: Route) => {
    const payload = route.request().postDataJSON() as { json?: { groupId?: string } };
    if (payload.json?.groupId !== group.id) {
      await route.continue();
      return;
    }
    arrived();
    await gate;
    await route.continue();
  };
  await page.route("**/rpc/threads/get", handler);
  try {
    await saveSettings(page);
    await received;
    await expectServerMembers(page, group.id, ids.slice(0, 3));
    await expectAvatars(page, group.id, 3);
    await expectDraft(page);
    await captureScreenshot(page, testInfo, "saved-group-with-thread-refresh-pending");
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/rpc/threads/get") &&
        response.request().postDataJSON()?.json?.groupId === group.id,
    );
    release();
    await response;
    await expect(settings(page)).toHaveAttribute("data-panel", "closed");
    await expectAvatars(page, group.id, 3);
    await expectDraft(page);
  } finally {
    release();
    await page.unroute("**/rpc/threads/get", handler);
  }
});

test("a delayed inline rename response cannot restore members replaced by a newer save", async ({
  page,
}, testInfo) => {
  const { ids, group } = await fixture(page, "rename-members-race");
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const renamed = "Renamed companions";
  const handler = async (route: Route) => {
    const payload = route.request().postDataJSON() as { json?: UpdatePayload };
    if (payload.json?.groupId !== group.id || payload.json?.name !== renamed) {
      await route.fallback();
      return;
    }
    // The server has committed the rename and captured the old member list.
    // Delay only delivery while another update replaces those members.
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  };
  await page.route("**/rpc/groups/update", handler);
  try {
    await page.getByTestId("group-title").dblclick();
    const titleInput = page.getByTestId("group-title-input");
    await titleInput.fill(renamed);
    await titleInput.press("Enter");
    await received;
    await expect.poll(async () => (await serverGroup(page, group.id)).name).toBe(renamed);

    await openSettings(page);
    await toggleMember(page, 1);
    await toggleMember(page, 2);
    await saveSettings(page);
    await expectServerMembers(page, group.id, [ids[0], ids[2]]);
    await expectAvatars(page, group.id, 2);
    const renameResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/rpc/groups/update") &&
        response.request().postDataJSON()?.json?.name === renamed,
    );
    release();
    await renameResponse;
    await expect(titleInput).toHaveCount(0);
    await expect(page.getByTestId("group-title")).toHaveText(renamed);
    await expectAvatars(page, group.id, 2);
    await openSettings(page);
    await expectSelected(page, [0, 2]);
    await captureScreenshot(page, testInfo, "newer-members-after-delayed-rename");
  } finally {
    release();
    await page.unroute("**/rpc/groups/update", handler);
  }
});
