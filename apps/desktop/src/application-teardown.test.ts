import { describe, expect, it, vi } from "vitest";
import { closePendingApplications } from "../e2e/application-teardown.js";

describe("desktop test application teardown", () => {
  it("waits for held attachment before closing the original application", async () => {
    const app = {};
    let release!: (value: typeof app) => void;
    const launch = new Promise<typeof app>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {});
    let completed = false;
    const teardown = closePendingApplications(new Set([launch]), new Set(), close).then(
      (errors) => {
        completed = true;
        return errors;
      },
    );
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release(app);
    await expect(teardown).resolves.toEqual([]);
    expect(close).toHaveBeenCalledExactlyOnceWith(app);
  });
  it("continues closing the remaining owned apps after a close rejects", async () => {
    const first = {};
    const second = {};
    const failed = new Error("synthetic close failure");
    const close = vi.fn(async (app: object) => {
      if (app === first) throw failed;
    });
    await expect(
      closePendingApplications(new Set(), new Set([first, second]), close),
    ).resolves.toEqual([failed]);
    expect(close.mock.calls.map(([app]) => app)).toEqual([first, second]);
  });
});
