import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Artifact } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewSpace,
  rpc,
  signup,
} from "./helpers";

type ArtifactPage = {
  items: Array<Artifact & { versionCount: number }>;
  nextCursor: string | null;
};

async function fileFixture(page: Page, label: string) {
  await signup(page, `files-${label}-${Date.now()}@rakazo.test`, "password12", "Files Review");
  await completeOnboarding(page);
  return activeBotId(page);
}

function artifactIds(scroller: Locator) {
  return scroller
    .locator("[data-artifact-id]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-artifact-id")));
}

async function visibleAnchor(scroller: Locator) {
  return scroller.evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    for (const row of container.querySelectorAll<HTMLElement>("[data-artifact-id]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
        return { id: row.dataset.artifactId!, offset: rect.top - bounds.top };
      }
    }
    throw new Error("Expected a visible file row");
  });
}

async function expectAnchor(scroller: Locator, anchor: { id: string; offset: number }) {
  await expect
    .poll(() =>
      scroller.evaluate((container, anchor) => {
        const row = container.querySelector<HTMLElement>(`[data-artifact-id="${anchor.id}"]`);
        if (!row) return Number.POSITIVE_INFINITY;
        return Math.abs(
          row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset,
        );
      }, anchor),
    )
    .toBeLessThanOrEqual(2);
}

test("opens Files from the sidebar footer and lists created artifacts", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `artifacts-tab-${stamp}@rakazo.test`, "password12", "Artifacts Tab");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/(?!artifacts(?:\/|$))[^/]+$/);
  const chiefId = activeBotId(page);

  await expect(page.getByTestId("app-rail")).toHaveCount(0);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeVisible();
  expect((await sidebar.boundingBox())?.x).toBe(0);
  const files = sidebar.getByTestId("sidebar-files-trigger");
  await expect(files).toBeVisible();
  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Integrations", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Artifacts", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "account-menu-settings");
  await page.keyboard.press("Escape");

  await files.click();
  await expect(page).toHaveURL(/\/app\/artifacts$/);
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
  await expect(page.getByText("No artifacts found.")).toBeVisible();
  await captureScreenshot(page, testInfo, "artifacts-empty");

  await page.setViewportSize({ width: 360, height: 700 });
  const narrowHeading = page.getByRole("heading", { name: "Files", exact: true });
  const narrowCardView = page.getByRole("button", { name: "Card view" });
  await expect(narrowHeading).toBeVisible();
  await expect(narrowCardView).toBeVisible();
  const headingBox = await narrowHeading.boundingBox();
  const cardViewBox = await narrowCardView.boundingBox();
  expect(headingBox).not.toBeNull();
  expect(headingBox?.x).toBeGreaterThanOrEqual(0);
  expect((headingBox?.x ?? 0) + (headingBox?.width ?? 0)).toBeLessThanOrEqual(360);
  expect(cardViewBox?.x).toBeGreaterThanOrEqual(0);
  expect((cardViewBox?.x ?? 0) + (cardViewBox?.width ?? 0)).toBeLessThanOrEqual(360);
  await page.setViewportSize({ width: 1280, height: 720 });

  await rpc(page, "artifacts/create", {
    botId: chiefId,
    name: "notes/artifacts-tab.md",
    mimeType: "text/markdown",
    contentBase64: Buffer.from("# Artifacts tab").toString("base64"),
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(page.getByText("notes/artifacts-tab.md")).toBeVisible();
  await captureScreenshot(page, testInfo, "artifacts-list");

  await page.getByRole("link", { name: /notes\/artifacts-tab\.md/ }).click();
  await expect(page).toHaveURL(/\/app\/artifacts\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "notes/artifacts-tab.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Artifacts tab" })).toBeVisible();
  await captureScreenshot(page, testInfo, "artifacts-preview");

  await page.getByRole("link", { name: "Bots" }).click();
  await expect(page).toHaveURL(/\/app\/(?!artifacts(?:\/|$))[^/]+$/);
  await expect(page.getByTestId("transcript")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("app-rail")).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mobileSidebar = page.getByTestId("bots-sidebar");
  await expect(mobileSidebar.getByTestId("sidebar-files-trigger")).toBeVisible();
  await mobileSidebar.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "account-menu-settings-mobile");
});

test("pages older files upward without moving the reader and preserves position across views", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await fileFixture(page, "paging");
  for (let index = 0; index < 121; index += 1) {
    await rpc(page, "artifacts/create", {
      botId,
      name: `notes/file-${String(index).padStart(3, "0")}.md`,
      mimeType: "text/markdown",
      description: `A synthetic file for page ${Math.floor(index / 60) + 1}.`,
      contentBase64: Buffer.from(`# File ${index}\n\nA saved conversation note.\n`).toString(
        "base64",
      ),
    });
  }

  const first = await rpc<ArtifactPage>(page, "artifacts/listSpace", { limit: 60 });
  expect(first.items).toHaveLength(60);
  expect(first.nextCursor).toBeTruthy();
  const second = await rpc<ArtifactPage>(page, "artifacts/listSpace", {
    cursor: first.nextCursor,
    limit: 60,
  });
  expect(second.items).toHaveLength(60);
  const third = await rpc<ArtifactPage>(page, "artifacts/listSpace", {
    cursor: second.nextCursor,
    limit: 60,
  });
  expect(third.items).toHaveLength(1);
  expect(third.nextCursor).toBeNull();

  await page.goto("/app/artifacts");
  const browse = page.getByTestId("artifacts-browse");
  const loadOlder = page.getByTestId("artifacts-load-older");
  await expect
    .poll(() => artifactIds(browse))
    .toEqual(first.items.map((item) => item.id).reverse());
  await expect
    .poll(() =>
      browse.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(2);
  await captureScreenshot(page, testInfo, "files-newest-at-bottom");

  let releasePage!: () => void;
  let markPageReady!: () => void;
  const pageReady = new Promise<void>((resolve) => {
    markPageReady = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  let markPageFailed!: () => void;
  const pageFailed = new Promise<void>((resolve) => {
    markPageFailed = resolve;
  });
  let failed = false;
  let delayed = false;
  await page.route("**/rpc/artifacts/listSpace", async (route) => {
    const input = route.request().postDataJSON() as { json: { cursor?: string } };
    if (!input.json.cursor || delayed) {
      await route.continue();
      return;
    }
    if (!failed) {
      failed = true;
      await route.abort("failed");
      markPageFailed();
      return;
    }
    delayed = true;
    const response = await route.fetch();
    markPageReady();
    await gate;
    await route.fulfill({ response });
  });

  try {
    await loadOlder.click();
    await pageFailed;
    await expect(loadOlder).toBeEnabled();
    await expect
      .poll(() => artifactIds(browse))
      .toEqual(first.items.map((item) => item.id).reverse());
    await loadOlder.click();
    await pageReady;
    // The user keeps reading while the request is pending. The response must
    // preserve this position, rather than the position when Load more was clicked.
    await browse.evaluate((element) => {
      element.scrollTop = 440;
    });
    const anchor = await visibleAnchor(browse);
    releasePage();
    await expect
      .poll(() => artifactIds(browse))
      .toEqual([...first.items, ...second.items].map((item) => item.id).reverse());
    await expectAnchor(browse, anchor);
    await captureScreenshot(page, testInfo, "files-older-page-anchor");
  } finally {
    releasePage();
    await page.unroute("**/rpc/artifacts/listSpace");
  }

  const gridAnchor = await visibleAnchor(browse);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expectAnchor(browse, gridAnchor);
  await expect
    .poll(() => artifactIds(browse))
    .toEqual([...first.items, ...second.items].map((item) => item.id).reverse());

  const beforePreview = await visibleAnchor(browse);
  const previewPoint = await browse
    .locator(`[data-artifact-id="${beforePreview.id}"]`)
    .getByRole("link")
    .evaluate((link) => {
      const row = link.getBoundingClientRect();
      const container = link.closest('[data-testid="artifacts-browse"]')!.getBoundingClientRect();
      return {
        x: row.left + Math.min(24, row.width / 2),
        y: (Math.max(row.top, container.top) + Math.min(row.bottom, container.bottom)) / 2,
      };
    });
  // Click the part already visible. Locator.click would first scroll a clipped
  // row fully into view, changing the reading position before the user opens it.
  await page.mouse.click(previewPoint.x, previewPoint.y);
  const index = page.getByTestId("artifacts-index");
  await expect(index).toBeVisible();
  await expect
    .poll(() => artifactIds(index))
    .toEqual([...first.items, ...second.items].map((item) => item.id).reverse());
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await index.evaluate((element) => {
    element.scrollTop = 540;
  });
  const indexAnchor = await visibleAnchor(index);
  await page.getByRole("button", { name: "Maximize", exact: true }).click();
  await expect(index).toHaveCount(0);
  await page.getByRole("button", { name: "Show list", exact: true }).click();
  await expectAnchor(index, indexAnchor);
  await page.goBack();
  await expect(browse).toBeVisible();
  await expectAnchor(browse, beforePreview);

  await loadOlder.click();
  const allIds = [...first.items, ...second.items, ...third.items].map((item) => item.id).reverse();
  await expect.poll(() => artifactIds(browse)).toEqual(allIds);
  expect(new Set(allIds).size).toBe(121);
  await expect(loadOlder).toHaveCount(0);
  await captureScreenshot(page, testInfo, "files-three-pages-list");

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const search = page.getByRole("searchbox");
  await search.fill("file-000");
  await expect(browse.locator("[data-artifact-id]")).toHaveCount(1);
  await expect(browse.getByRole("link", { name: /notes\/file-000\.md/ })).toBeVisible();
  await search.fill("no-such-synthetic-file");
  await expect(page.getByText("No artifacts found.")).toBeVisible();
  await search.clear();
  await expect.poll(() => artifactIds(browse)).toEqual(allIds);
});

test("previews and downloads the selected version and keeps long filenames clear of controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 800, height: 720 });
  const botId = await fileFixture(page, "versions");
  const name =
    "Conversation notes — a long filename that keeps the preview and download controls usable.md";
  const firstText = "# Original note\n\nA quiet afternoon.\n";
  const secondText = "# Revised note\n\nLeave room for a walk.\n";
  const original = await rpc<Artifact>(page, "artifacts/create", {
    botId,
    name,
    mimeType: "text/markdown",
    description: "A synthetic document with two saved versions.",
    contentBase64: Buffer.from(firstText).toString("base64"),
  });
  const revised = await rpc<Artifact>(page, "artifacts/create", {
    botId,
    name,
    mimeType: "text/markdown",
    description: "A synthetic document with two saved versions.",
    contentBase64: Buffer.from(secondText).toString("base64"),
  });
  expect(revised.version).toBe(2);
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Fixture canvas is unavailable");
    context.fillStyle = "hsl(0, 0%, 94%)";
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = "hsl(0, 0%, 78%)";
    context.fillRect(24, 24, 272, 112);
    context.fillStyle = "hsl(0, 0%, 36%)";
    context.fillRect(24, 156, 180, 8);
    context.fillRect(24, 176, 120, 6);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const png = Buffer.from(pngBase64, "base64");
  const image = await rpc<Artifact>(page, "artifacts/create", {
    botId,
    name: "Preview image.png",
    mimeType: "image/png",
    contentBase64: png.toString("base64"),
  });

  await page.route("**/rpc/artifacts/listSpace", (route) => route.abort("failed"));
  await page.goto("/app/artifacts");
  await expect(page.getByRole("button", { name: "Retry now", exact: true })).toBeVisible();
  await page.unroute("**/rpc/artifacts/listSpace");
  await page.getByRole("button", { name: "Retry now", exact: true }).click();
  await expect(page.getByTestId("artifacts-browse").locator("[data-artifact-id]")).toHaveCount(2);
  await page.route("**/rpc/artifacts/listVersions", (route) => route.abort("failed"));
  await page.getByRole("link", { name: /Conversation notes/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/artifacts/${original.id}$`));
  // A failed version lookup must not silently show/download the family root.
  await expect(page.getByRole("button", { name: "Retry now", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Original note", exact: true })).toHaveCount(0);
  await page.unroute("**/rpc/artifacts/listVersions");
  await page.getByRole("button", { name: "Retry now", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revised note", exact: true })).toBeVisible();
  const version = page.getByRole("combobox", { name: "Version", exact: true });
  await expect(version).toHaveValue(revised.id);
  const heading = page.getByRole("heading", { name, exact: true });
  const download = page.getByRole("button", { name: "Download", exact: true });
  for (const control of [
    heading,
    version,
    download,
    page.getByRole("button", { name: "Maximize" }),
  ]) {
    const bounds = await control.boundingBox();
    expect(bounds, "preview control is on screen").not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(800);
  }
  const headingBounds = await heading.boundingBox();
  const downloadBounds = await download.boundingBox();
  const overlapWidth = Math.max(
    0,
    Math.min(headingBounds!.x + headingBounds!.width, downloadBounds!.x + downloadBounds!.width) -
      Math.max(headingBounds!.x, downloadBounds!.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(headingBounds!.y + headingBounds!.height, downloadBounds!.y + downloadBounds!.height) -
      Math.max(headingBounds!.y, downloadBounds!.y),
  );
  expect(overlapWidth * overlapHeight, "filename does not overlap Download").toBe(0);
  await captureScreenshot(page, testInfo, "files-long-name-version-preview");

  async function expectDownload(text: string) {
    const downloadReady = page.waitForEvent("download");
    await download.click();
    const result = await downloadReady;
    expect(result.suggestedFilename()).toBe(name);
    const path = await result.path();
    expect(path).not.toBeNull();
    expect(await readFile(path!)).toEqual(Buffer.from(text));
  }
  await expectDownload(secondText);
  await version.selectOption(original.id);
  await expect(page.getByRole("heading", { name: "Original note", exact: true })).toBeVisible();
  await expectDownload(firstText);

  let releaseVersion!: () => void;
  let markVersionReady!: () => void;
  const versionReady = new Promise<void>((resolve) => {
    markVersionReady = resolve;
  });
  const versionGate = new Promise<void>((resolve) => {
    releaseVersion = resolve;
  });
  await page.route("**/rpc/artifacts/getById", async (route) => {
    const response = await route.fetch();
    markVersionReady();
    await versionGate;
    await route.fulfill({ response });
  });
  try {
    await version.selectOption(revised.id);
    await versionReady;
    await expect(download).toHaveCount(0);
    releaseVersion();
    await expect(page.getByRole("heading", { name: "Revised note", exact: true })).toBeVisible();
    await expectDownload(secondText);
  } finally {
    releaseVersion();
    await page.unroute("**/rpc/artifacts/getById");
  }

  await page
    .getByTestId("artifacts-index")
    .getByRole("link", { name: /Preview image\.png/ })
    .click();
  const previewImage = page.getByRole("img", { name: image.name, exact: true });
  await expect(previewImage).toBeVisible();
  await expect
    .poll(() => previewImage.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(320);
  await captureScreenshot(page, testInfo, "files-image-preview");
  const imageDownloadReady = page.waitForEvent("download");
  await download.click();
  const imageDownload = await imageDownloadReady;
  expect(imageDownload.suggestedFilename()).toBe(image.name);
  expect(await readFile((await imageDownload.path())!)).toEqual(png);

  const row = page.getByTestId("artifacts-index").locator(`[data-artifact-id="${original.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("all 2 versions");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toHaveCount(1);
  const versions = await rpc<Artifact[]>(page, "artifacts/listVersions", { familyId: original.id });
  expect(versions).toHaveLength(2);

  await page.route("**/rpc/artifacts/remove", (route) => route.abort("failed"));
  await row.hover();
  await row.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await expect(row).toHaveCount(1);
  await page.unroute("**/rpc/artifacts/remove");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  const remaining = await rpc<ArtifactPage>(page, "artifacts/listSpace", { limit: 60 });
  expect(remaining.items.map((item) => item.id)).toEqual([image.id]);
  await expect(previewImage).toBeVisible();
});

test("keeps file lists and previews scoped when switching spaces", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const personalBotId = await fileFixture(page, "spaces");
  const personal = await rpc<Artifact>(page, "artifacts/create", {
    botId: personalBotId,
    name: "Personal conversation.md",
    mimeType: "text/markdown",
    contentBase64: Buffer.from("# Personal conversation\n\nSynthetic personal note.\n").toString(
      "base64",
    ),
  });
  await page.getByTestId("sidebar-files-trigger").click();
  const browse = page.getByTestId("artifacts-browse");
  await expect.poll(() => artifactIds(browse)).toEqual([personal.id]);
  await page.getByRole("link", { name: "Bots", exact: true }).click();

  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByLabel("Name").fill("Files workspace");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  // Creation awaits an RPC before navigating. Don't let the onboarding helper
  // mistake the still-visible Personal chat for a completed new-space setup.
  await page.waitForURL(
    (url) =>
      url.pathname === "/onboarding" ||
      (/^\/app\/[^/]+$/.test(url.pathname) && url.pathname !== `/app/${personalBotId}`),
  );
  await completeOnboarding(page);
  await page.waitForURL(
    (url) => /^\/app\/[^/]+$/.test(url.pathname) && url.pathname !== `/app/${personalBotId}`,
  );
  await expect(page.getByTestId("sidebar-current-space")).toHaveText("Files workspace");
  await expect(
    page
      .getByTestId("bots-sidebar")
      .locator('[data-sidebar-group^="space:"]')
      .filter({ hasText: "Files workspace" })
      .getByRole("button", { name: /^Chief/ }),
  ).toBeVisible();
  const workspaceBotId = activeBotId(page);
  expect(workspaceBotId).not.toBe(personalBotId);
  const workspaceId = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
  expect(workspaceId).toBeTruthy();
  // The ordinary RPC helper uses the default space. Include the same scope
  // header as the app when creating a fixture in the newly selected space.
  const created = await page.request.post("/rpc/artifacts/create", {
    headers: { "x-rakazo-space-id": workspaceId! },
    data: {
      json: {
        botId: workspaceBotId,
        name: "Workspace conversation.md",
        mimeType: "text/markdown",
        contentBase64: Buffer.from(
          "# Workspace conversation\n\nSynthetic workspace note.\n",
        ).toString("base64"),
      },
    },
  });
  expect(created.ok()).toBe(true);
  const workspace = ((await created.json()) as { json: Artifact }).json;
  await page.getByTestId("sidebar-files-trigger").click();
  await expect.poll(() => artifactIds(browse)).toEqual([workspace.id]);
  await expect(page.getByText(personal.name, { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "files-current-space-only");

  const denied = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/artifacts/listVersions") &&
      (response.request().postDataJSON() as { json: { familyId: string } }).json.familyId ===
        personal.id,
  );
  await page.goto(`/app/artifacts/${personal.id}`);
  expect((await denied).ok()).toBe(false);
  await expect(page.getByRole("button", { name: "Retry now", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Personal conversation", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Synthetic personal note.", { exact: true })).toHaveCount(0);
  await expect.poll(() => artifactIds(page.getByTestId("artifacts-index"))).toEqual([workspace.id]);
  await captureScreenshot(page, testInfo, "files-other-space-preview-denied");

  await page.getByRole("link", { name: "Bots", exact: true }).click();
  const personalSpace = page
    .getByTestId("bots-sidebar")
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Personal" });
  await personalSpace.getByRole("button", { name: /^Chief/ }).click();
  await page.waitForURL(new RegExp(`/app/${personalBotId}$`));
  await page.getByTestId("sidebar-files-trigger").click();
  await expect.poll(() => artifactIds(browse)).toEqual([personal.id]);
  await expect(page.getByText(workspace.name, { exact: true })).toHaveCount(0);
  await browse.getByRole("link", { name: /Personal conversation\.md/ }).click();
  await expect(
    page.getByRole("heading", { name: "Personal conversation", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
});
