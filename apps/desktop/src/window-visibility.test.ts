import type { ElectronApplication, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { isNativeWindowVisible } from "../e2e/window-visibility.js";

const missingMapping = () =>
  new Error(
    "electronApplication.browserWindow: TypeError: Cannot read properties of undefined (reading 'getOwnerBrowserWindow')",
  );

function fixture(visible = true) {
  const isClosed = vi.fn(() => false);
  const isVisible = vi.fn(() => visible);
  const evaluate = vi.fn(async (fn: (win: { isVisible: () => boolean }) => boolean) =>
    fn({ isVisible }),
  );
  const browserWindow = vi.fn(async () => ({ evaluate }));
  return {
    app: { browserWindow } as unknown as ElectronApplication,
    page: { isClosed } as unknown as Page,
    browserWindow,
    evaluate,
    isClosed,
    isVisible,
  };
}

describe("desktop native window visibility", () => {
  it.each([true, false])("returns the native visibility state %s", async (visible) => {
    const f = fixture(visible);
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(visible);
    expect(f.browserWindow).toHaveBeenCalledExactlyOnceWith(f.page);
    expect(f.isVisible).toHaveBeenCalledOnce();
  });

  it("skips an already closed page without a native lookup", async () => {
    const f = fixture();
    f.isClosed.mockReturnValue(true);
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(false);
    expect(f.browserWindow).not.toHaveBeenCalled();
  });

  it("continues past a missing native mapping to a valid candidate", async () => {
    const f = fixture();
    const stalePage = { isClosed: () => false } as unknown as Page;
    f.browserWindow.mockRejectedValueOnce(missingMapping());
    const found = [];
    for (const page of [stalePage, f.page]) {
      if (await isNativeWindowVisible(f.app, page)) found.push(page);
    }
    expect(found).toEqual([f.page]);
    expect(f.browserWindow.mock.calls).toEqual([[stalePage], [f.page]]);
  });

  it("can observe the same page again after a transient native mapping failure", async () => {
    const f = fixture();
    f.browserWindow.mockRejectedValueOnce(missingMapping());
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(false);
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(true);
  });

  it("does not report a permanently missing native mapping as visible", async () => {
    const f = fixture();
    f.browserWindow.mockRejectedValue(missingMapping());
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(false);
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(false);
    expect(f.evaluate).not.toHaveBeenCalled();
  });

  it("skips a page closed during native lookup", async () => {
    const f = fixture();
    f.browserWindow.mockImplementationOnce(async () => {
      f.isClosed.mockReturnValue(true);
      throw new Error("Synthetic page closed during lookup");
    });
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(false);
  });

  it("skips a page closed during native visibility evaluation", async () => {
    const f = fixture();
    f.evaluate.mockImplementationOnce(async () => {
      f.isClosed.mockReturnValue(true);
      throw new Error("Synthetic window destroyed during evaluation");
    });
    await expect(isNativeWindowVisible(f.app, f.page)).resolves.toBe(false);
  });

  it.each([
    new Error("Synthetic Electron transport failure"),
    new Error("Cannot read properties of undefined (reading 'getOwnerBrowserWindow')"),
    new Error("electronApplication.browserWindow: Synthetic unknown failure"),
    "Synthetic non-Error failure",
  ])("propagates an unrecognized lookup failure %s", async (error) => {
    const f = fixture();
    f.browserWindow.mockRejectedValueOnce(error);
    await expect(isNativeWindowVisible(f.app, f.page)).rejects.toBe(error);
  });

  it("propagates an unknown native evaluation failure", async () => {
    const f = fixture();
    const error = new Error("Synthetic native evaluation failure");
    f.evaluate.mockRejectedValueOnce(error);
    await expect(isNativeWindowVisible(f.app, f.page)).rejects.toBe(error);
  });
});
