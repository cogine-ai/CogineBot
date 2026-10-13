// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficialSource } from "./official-source.js";

describe("official procedural source cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs the actual geometry engine and cancels its RAF on destroy", async () => {
    const pending = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.set(++sequence, callback);
      return sequence;
    });
    const cancel = vi.fn((id: number) => pending.delete(id));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const publish = vi.fn();
    const source = await createOfficialSource("companion-a", publish);
    const cached = source.getFrame().svg;
    const cachedMarkup = cached.outerHTML;
    expect(source.getFrame().svg.querySelectorAll("path").length).toBeGreaterThan(3);
    expect(source.getFrame().svg.style.getPropertyValue("--fg")).toBe(
      "var(--avatar-activity-color)",
    );
    expect(pending.size).toBe(1);
    const [id, callback] = Array.from(pending)[0]!;
    pending.delete(id);
    callback(performance.now() + 16);
    await Promise.resolve();
    expect(publish).toHaveBeenCalled();
    expect(cached.outerHTML).toBe(cachedMarkup);
    expect(publish.mock.calls[0]![0].svg).not.toBe(cached);
    expect(pending.size).toBe(1);
    source.destroy();
    expect(cancel).toHaveBeenCalled();
    expect(pending.size).toBe(0);
    const count = publish.mock.calls.length;
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(count);
  });
});
