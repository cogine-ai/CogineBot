import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const errorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/e2e/fixtures/avatar-editor.html");
  await expect(page.getByTestId("avatar-studio-trigger")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

test.afterEach(async ({ page }) => {
  expect(errorsByPage.get(page), "no unexpected browser errors").toEqual([]);
});

async function openEditor(page: Page, upload = false) {
  await page.getByTestId("avatar-studio-trigger").click();
  const editor = page.getByTestId("avatar-studio");
  await expect(editor).toBeVisible();
  if (upload) await editor.getByRole("button", { name: "Upload", exact: true }).click();
  return editor;
}

async function imageFile(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "red";
    context.fillRect(0, 0, 300, 180);
    context.fillStyle = "blue";
    context.fillRect(60, 0, 180, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  return { name: "companion.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

async function delayImageDecoding(page: Page) {
  await page.evaluate(() => {
    const NativeImage = window.Image;
    const sourceSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!.set!;
    const queued: Array<() => void> = [];
    window.Image = function Image() {
      const image = new NativeImage();
      Object.defineProperty(image, "src", {
        set(source: string) {
          queued.push(() => sourceSetter.call(image, source));
        },
      });
      return image;
    } as typeof Image;
    Object.assign(window, {
      avatarDecodeQueue: queued,
      releaseAvatarDecode: () => {
        queued.splice(0).forEach((decode) => {
          decode();
        });
        window.Image = NativeImage;
      },
    });
  });
}

async function waitForQueuedImage(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as Window & { avatarDecodeQueue?: unknown[] }).avatarDecodeQueue?.length),
  );
}

async function releaseImageDecoding(page: Page) {
  await page.evaluate(() => {
    (window as Window & { releaseAvatarDecode?: () => void }).releaseAvatarDecode?.();
  });
}

test("compact editor uses eleven shapes, eight colors, and instant updates", async ({
  page,
}, testInfo) => {
  const editor = await openEditor(page);
  await expect(editor.getByRole("button", { name: "Generate", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(editor.locator('[aria-label="circle"]')).toHaveAttribute("aria-pressed", "true");
  await expect(editor.locator('[aria-label^="Color "]')).toHaveCount(8);
  await expect(editor.getByTestId("avatar-studio-bot-tab").locator("button")).toHaveCount(19);
  const trigger = await page.getByTestId("avatar-studio-trigger").boundingBox();
  const card = await editor.boundingBox();
  expect(card!.width).toBeLessThanOrEqual(286);
  expect(card!.y).toBeGreaterThan(trigger!.y + trigger!.height);

  await editor.getByRole("button", { name: "arch", exact: true }).click();
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-value", "#F5A15D::shape_10");
  await expect(editor.getByRole("button", { name: "arch", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await editor.getByRole("button", { name: "Color #62A8EC", exact: true }).click();
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-value", "#62A8EC::shape_10");
  const fill = await page
    .getByTestId("synced-avatar")
    .locator("svg path")
    .first()
    .getAttribute("fill");
  expect(fill?.toLowerCase()).toBe("#62a8ec");
  await captureScreenshot(page, testInfo, "avatar-editor-bot");

  // A repeated choice can retry an existing failed auto-save.
  await editor.getByRole("button", { name: "Color #62A8EC", exact: true }).click();
  await expect(page.getByTestId("change-count")).toHaveText("3");
  await editor.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-value", "#62A8EC");
  await expect(
    editor.getByTestId("avatar-studio-bot-tab").locator('button[aria-pressed="true"]'),
  ).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
});

test("editor stays inside compact desktop and dark theme", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  const editor = await openEditor(page);
  const bounds = await editor.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(800);
  await editor.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(editor.getByTestId("avatar-studio-drop-zone")).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-editor-upload-dark");
});

test("upload crops the center to 256 pixels and resets to an existing Bot avatar", async ({
  page,
}) => {
  const editor = await openEditor(page, true);
  await editor.locator('input[type="file"]').setInputFiles(await imageFile(page));
  await expect(editor).toBeHidden();
  const value = await page.getByTestId("avatar-value").getAttribute("data-value");
  expect(value).toMatch(/^data:image\/webp;base64,/);
  await expect(page.getByTestId("synced-avatar").locator("img")).toHaveCount(3);
  const imageInfo = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source!;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: image.width,
      height: image.height,
      corner: [...context.getImageData(3, 3, 1, 1).data],
    };
  }, value);
  expect(imageInfo.width).toBe(256);
  expect(imageInfo.height).toBe(256);
  expect(imageInfo.corner[2]).toBeGreaterThan(240);
  expect(imageInfo.corner[0]).toBeLessThan(20);
  await openEditor(page, true);
  await editor.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("avatar-value")).not.toHaveAttribute("data-value", /^data:image/);
  await expect(page.getByTestId("synced-avatar").locator("img")).toHaveCount(0);
});

test("invalid or corrupt image shows a recoverable error", async ({ page }) => {
  const editor = await openEditor(page, true);
  const input = editor.locator('input[type="file"]');
  await input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(editor.getByRole("status")).toHaveText("Choose an image file");
  await input.setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("broken"),
  });
  await expect(editor.getByRole("status")).toHaveText("Could not open image. Try again.");
  await expect(page.getByTestId("change-count")).toHaveText("0");
  await input.setInputFiles(await imageFile(page));
  await expect(editor).toBeHidden();
  await expect(page.getByTestId("change-count")).toHaveText("1");
});

for (const method of ["drop", "paste"] as const) {
  test(`existing image ${method} updates the avatar`, async ({ page }) => {
    const editor = await openEditor(page, true);
    const file = await imageFile(page);
    await editor.getByTestId("avatar-studio-drop-zone").evaluate(
      (zone, input) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(
            [Uint8Array.from(atob(input.source), (value) => value.charCodeAt(0))],
            "companion.png",
            { type: "image/png" },
          ),
        );
        zone.dispatchEvent(
          input.method === "drop"
            ? new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })
            : new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              }),
        );
      },
      { method, source: file.buffer.toString("base64") },
    );
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("avatar-value")).toHaveAttribute(
      "data-value",
      /^data:image\/webp/,
    );
  });
}

test("closing or switching companions discards unfinished image decoding", async ({ page }) => {
  const file = await imageFile(page);
  await delayImageDecoding(page);
  let editor = await openEditor(page, true);
  await editor.locator('input[type="file"]').setInputFiles(file);
  await waitForQueuedImage(page);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await releaseImageDecoding(page);
  await page.waitForTimeout(100);
  await expect(page.getByTestId("change-count")).toHaveText("0");

  await delayImageDecoding(page);
  editor = await openEditor(page, true);
  await editor.locator('input[type="file"]').setInputFiles(file);
  await waitForQueuedImage(page);
  await page.getByTestId("switch-companion").click();
  await expect(editor).toBeHidden();
  await releaseImageDecoding(page);
  await page.waitForTimeout(100);
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-identity", "companion-beta");
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-value", "#62A8EC::shape_7");
  await expect(page.getByTestId("change-count")).toHaveText("0");
});

test("a newer shape choice wins over unfinished image decoding", async ({ page }) => {
  const file = await imageFile(page);
  await delayImageDecoding(page);
  const editor = await openEditor(page, true);
  await editor.locator('input[type="file"]').setInputFiles(file);
  await waitForQueuedImage(page);
  await editor.getByRole("button", { name: "Bot", exact: true }).click();
  await editor.getByRole("button", { name: "arch", exact: true }).click();
  await releaseImageDecoding(page);
  await page.waitForTimeout(100);
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-value", "#F5A15D::shape_10");
  await expect(page.getByTestId("change-count")).toHaveText("1");
});

test("working companion previews the chosen shape while editing and resumes activity on close", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-editor.html?working=1");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const profile = page.getByTestId("avatar-studio-trigger");
  await expect(profile.locator('.avatar-activity[data-motion="active"]')).toBeVisible();
  const editor = await openEditor(page);
  await expect(profile.locator(".avatar-activity")).toHaveCount(0);
  await editor.getByRole("button", { name: "arch", exact: true }).click();
  await expect(profile.locator('.rakazo-gaze-avatar[data-shape="arch"]')).toBeVisible();
  await expect(page.getByTestId("avatar-value")).toHaveAttribute("data-value", "#F5A15D::shape_10");
  // Editing affects only this preview; other real working locations keep moving.
  await expect(
    page.getByTestId("synced-avatar").locator('.avatar-activity[data-motion="active"]').first(),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-editor-working-preview");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(profile.locator('.avatar-activity[data-motion="active"]')).toBeVisible();
});
