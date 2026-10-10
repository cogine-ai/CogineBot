import { expect, type Locator, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function openComposer(page: Page) {
  const stamp = Date.now();
  await signup(page, `composer-paste-${stamp}@rakazo.test`, "password12", "Paste Test");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  return composer;
}

async function pngFixture(page: Page, width: number, height: number) {
  const base64 = await page.evaluate(
    ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D image fixture generation is unavailable");
      context.fillStyle = "#6498b8";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#d7e8e2";
      context.fillRect(width / 4, height / 4, width / 2, height / 2);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { width, height },
  );
  if (!base64) throw new Error("PNG fixture encoding is unavailable");
  return Buffer.from(base64, "base64");
}

async function pasteImage(page: Page, name: string, caption = "") {
  const bytes = await pngFixture(page, 80, 40);
  await page.evaluate(
    ({ bytes, name, caption }) => {
      const target = document.querySelector("textarea[name='chat-message']");
      if (!(target instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
      const file = new File([new Uint8Array(bytes)], name, { type: "image/png" });
      const clipboardData = new DataTransfer();
      clipboardData.items.add(file);
      if (caption) clipboardData.setData("text/plain", caption);
      target.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    { bytes: [...bytes], name, caption },
  );
}

function attachmentPreview(page: Page, name: string) {
  return page
    .getByTestId("composer-bar")
    .getByTestId("composer-attachments")
    .getByTestId("attachment-preview")
    .filter({ has: page.getByRole("button", { name: `Remove ${name}`, exact: true }) });
}

async function expectDecodedImage(preview: Locator, width: number, height: number) {
  const image = preview.locator("img");
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const image = element as HTMLImageElement;
        return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
      }),
    )
    .toEqual({ complete: true, width, height });
  await expect(image).toHaveCSS("object-fit", "cover");
}

async function expectAttachmentLayout(
  page: Page,
  composer: Locator,
  viewportWidth: number,
  rows = 6,
) {
  const bar = page.getByTestId("composer-bar");
  const attachments = bar.getByTestId("composer-attachments");
  const cards = attachments.getByTestId("attachment-preview");
  await expect(cards).toHaveCount(4);
  const barBox = await bar.boundingBox();
  const attachmentBox = await attachments.boundingBox();
  const inputBox = await composer.boundingBox();
  expect(barBox).not.toBeNull();
  expect(attachmentBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  await expect(bar).toHaveAttribute("data-expanded", "true");
  const insets = await bar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      left: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
      right: Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth),
    };
  });
  expect(Math.abs(inputBox!.x - barBox!.x - insets.left)).toBeLessThan(1);
  expect(
    Math.abs(inputBox!.x + inputBox!.width - barBox!.x - barBox!.width + insets.right),
  ).toBeLessThan(1);
  expect(attachmentBox!.x).toBeGreaterThanOrEqual(barBox!.x);
  expect(attachmentBox!.y).toBeGreaterThanOrEqual(barBox!.y);
  expect(attachmentBox!.x + attachmentBox!.width).toBeLessThanOrEqual(barBox!.x + barBox!.width);
  expect(attachmentBox!.y + attachmentBox!.height).toBeLessThanOrEqual(inputBox!.y);
  expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(viewportWidth);
  for (const card of await cards.all()) {
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.width).toBe(48);
    expect(cardBox!.height).toBe(48);
  }
  const inputGeometry = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    const chrome =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    return {
      rows: (element.getBoundingClientRect().height - chrome) / Number.parseFloat(style.lineHeight),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(inputGeometry.rows).toBe(rows);
  expect(inputGeometry.scrollWidth).toBeLessThanOrEqual(inputGeometry.clientWidth + 1);
  for (const name of ["Attach file", "Send"]) {
    const controlBox = await bar.getByRole("button", { name, exact: true }).boundingBox();
    expect(controlBox).not.toBeNull();
    expect(controlBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(barBox!.y + barBox!.height);
    expect(controlBox!.x).toBeGreaterThanOrEqual(barBox!.x);
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(barBox!.x + barBox!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewportWidth,
  );
}

test("pasting an image into the composer creates an attachment", async ({ page }, testInfo) => {
  const composer = await openComposer(page);
  await composer.click();
  await pasteImage(page, "paste.png");
  const preview = attachmentPreview(page, "paste.png");
  await expect(preview).toHaveAttribute("data-kind", "image");
  await expectDecodedImage(preview, 80, 40);
  await preview.hover();
  await expect(page.getByRole("button", { name: "Remove paste.png" })).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-paste-attachment");
});

test("pasting text into the composer still inserts text", async ({ page, context }) => {
  const composer = await openComposer(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("pasted words"));
  await composer.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(composer).toHaveValue("pasted words");
});

test("pasting an image with text keeps the attachment and inserts text", async ({ page }) => {
  const composer = await openComposer(page);
  await composer.click();
  await pasteImage(page, "mixed.png", "caption text");
  const preview = attachmentPreview(page, "mixed.png");
  await expectDecodedImage(preview, 80, 40);
  await preview.hover();
  await expect(page.getByRole("button", { name: "Remove mixed.png" })).toBeVisible();
  await expect(composer).toHaveValue("caption text");
});

test("pending attachment cards share the composer, retain drafts and keep the four-file limit", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.exposeFunction("recordAttachmentWindowError", (message: string) => {
    errors.push(`window error: ${message}`);
  });
  await page.addInitScript(() => {
    window.addEventListener(
      "error",
      (event: Event) => {
        const message =
          event instanceof ErrorEvent
            ? event.message
            : `${event.type}: ${(event.target as Element | null)?.tagName ?? "Window"}`;
        void (
          window as unknown as {
            recordAttachmentWindowError: (message: string) => Promise<void>;
          }
        ).recordAttachmentWindowError(message);
      },
      true,
    );
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const composer = await openComposer(page);
  const chiefId = activeBotId(page);
  const bar = page.getByTestId("composer-bar");
  const fileInput = bar.locator('input[type="file"]');
  const pdfName = "A very long weekend plan for a quiet afternoon.pdf";
  const jsonName = "weekend.preferences.JSON";
  await fileInput.setInputFiles([
    { name: "landscape.png", mimeType: "image/png", buffer: await pngFixture(page, 80, 40) },
    { name: "portrait.png", mimeType: "image/png", buffer: await pngFixture(page, 40, 80) },
    { name: pdfName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") },
    { name: jsonName, mimeType: "application/json", buffer: Buffer.from('{"pace":"slow"}') },
  ]);
  const attachments = bar.getByTestId("composer-attachments");
  await expect(attachments.getByTestId("attachment-preview")).toHaveCount(4);
  await expect(attachments.locator('[data-kind="image"]')).toHaveCount(2);
  await expect(attachments.locator('[data-kind="file"]')).toHaveCount(2);
  await expectDecodedImage(attachmentPreview(page, "landscape.png"), 80, 40);
  await expectDecodedImage(attachmentPreview(page, "portrait.png"), 40, 80);
  const pdf = attachmentPreview(page, pdfName);
  const json = attachmentPreview(page, jsonName);
  await expect(pdf.locator("img")).toHaveCount(0);
  await expect(pdf.locator("svg").first()).toBeVisible();
  await expect(pdf.getByText(/^pdf$/i)).toBeVisible();
  await expect(json.getByText(/^json$/i)).toBeVisible();
  await expect(pdf).not.toContainText(pdfName);
  await expect(json).not.toContainText(jsonName);

  await composer.fill("A quiet afternoon together.");
  await expectAttachmentLayout(page, composer, 1280, 1);
  await captureScreenshot(page, testInfo, "composer-attachments-one-line-full-width");

  const draft = [
    "Keep the weekend quiet.",
    "One place is enough.",
    "Save room for a walk.",
    "Find a small cafe.",
    "We can decide later.",
    "No hurry.",
  ].join("\n");
  await composer.fill(draft);
  await expectAttachmentLayout(page, composer, 1280);
  await captureScreenshot(page, testInfo, "composer-attachments-six-lines-1280");
  await page.setViewportSize({ width: 800, height: 700 });
  await expectAttachmentLayout(page, composer, 800);
  await expect(composer).toHaveValue(draft);
  await captureScreenshot(page, testInfo, "composer-attachments-six-lines-800");

  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    notifyOnFinish: true,
  });
  const roster = page.getByTestId("bots-sidebar");
  await roster.locator(`[data-roster-bot-id="${partner.id}"]`).click();
  const partnerComposer = page.getByRole("combobox", { name: "Message Researcher", exact: true });
  await expect(partnerComposer).toHaveValue("");
  await expect(page.getByTestId("composer-attachments")).toHaveCount(0);
  await partnerComposer.fill("A separate short thought.");
  await roster.locator(`[data-roster-bot-id="${chiefId}"]`).click();
  await expect(composer).toHaveValue(draft);
  for (const name of ["landscape.png", "portrait.png", pdfName, jsonName]) {
    await expect(attachmentPreview(page, name)).toHaveCount(1);
  }
  await expectDecodedImage(attachmentPreview(page, "landscape.png"), 80, 40);
  await expectDecodedImage(attachmentPreview(page, "portrait.png"), 40, 80);
  await expectAttachmentLayout(page, composer, 800);

  const fifthFile = {
    name: "extra-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Take our time."),
  };
  await fileInput.setInputFiles(fifthFile);
  await expect(attachments.getByTestId("attachment-preview")).toHaveCount(4);
  await expect(attachmentPreview(page, fifthFile.name)).toHaveCount(0);
  const notice = page.getByTestId("composer-attachment-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("4");
  expect((await notice.innerText()).length).toBeLessThan(80);
  await captureScreenshot(page, testInfo, "composer-attachments-four-file-limit");

  const removePdf = pdf.getByRole("button", { name: `Remove ${pdfName}`, exact: true });
  await page.mouse.move(0, 0);
  await expect(removePdf).toHaveCSS("opacity", "0");
  await pdf.hover();
  await expect(removePdf).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(removePdf).toHaveCSS("opacity", "0");
  await removePdf.focus();
  await expect(removePdf).toHaveCSS("opacity", "1");
  await removePdf.click();
  await expect(pdf).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect(attachments.getByTestId("attachment-preview")).toHaveCount(3);
  await expect(composer).toHaveValue(draft);
  await fileInput.setInputFiles(fifthFile);
  await expect(attachmentPreview(page, fifthFile.name).getByText(/^txt$/i)).toBeVisible();
  await expect(attachments.getByTestId("attachment-preview")).toHaveCount(4);
  await expect(notice).toHaveCount(0);
  await expectAttachmentLayout(page, composer, 800);
  await captureScreenshot(page, testInfo, "composer-attachments-replaced-file");
  for (const name of ["landscape.png", "portrait.png", jsonName, fifthFile.name]) {
    await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
  }
  await composer.fill("");
  await expect(attachments).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect(bar).toHaveAttribute("data-expanded", "false");
  await expect.poll(async () => (await bar.boundingBox())?.height).toBe(48);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect(errors, "attachment previews and composer layout have no browser errors").toEqual([]);
});
