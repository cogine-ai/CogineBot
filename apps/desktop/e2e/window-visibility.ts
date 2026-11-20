import type { ElectronApplication, Page } from "@playwright/test";

export async function isNativeWindowVisible(
  app: ElectronApplication,
  page: Page,
): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const window = await app.browserWindow(page);
    return await window.evaluate((win) => !win.isDestroyed() && win.isVisible());
  } catch (error) {
    // A disappearing native window may still be listed by Playwright.
    if (
      page.isClosed() ||
      (error instanceof Error &&
        error.message.startsWith("electronApplication.browserWindow:") &&
        error.message.includes(
          "Cannot read properties of undefined (reading 'getOwnerBrowserWindow')",
        ))
    ) {
      return false;
    }
    throw error;
  }
}
