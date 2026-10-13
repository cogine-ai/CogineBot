import { describe, expect, it, vi } from "vitest";
import type { ActivitySource } from "./source-pool.js";
import { ActivitySourcePool } from "./source-pool.js";

describe("shared avatar activity sources", () => {
  it("fans out one frame and gives late-mounted views the current frame", async () => {
    const destroy = vi.fn();
    let publish: (frame: number) => void = () => {};
    const factory = vi.fn(async (_identity: string, callback: (frame: number) => void) => {
      publish = callback;
      return { getFrame: () => 12, destroy };
    });
    const pool = new ActivitySourcePool(factory);
    const sidebar = vi.fn();
    const removeSidebar = pool.subscribe("companion-a", sidebar);
    await Promise.resolve();
    publish(48);
    const header = vi.fn();
    const removeHeader = pool.subscribe("companion-a", header);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(header).toHaveBeenLastCalledWith(48);
    publish(49);
    expect(sidebar).toHaveBeenLastCalledWith(49);
    expect(header).toHaveBeenLastCalledWith(49);
    removeSidebar();
    expect(destroy).not.toHaveBeenCalled();
    removeHeader();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys a deferred source after its last view has disappeared", async () => {
    let complete: (source: ActivitySource<number>) => void = () => {};
    const destroy = vi.fn();
    const pool = new ActivitySourcePool<number>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const listener = vi.fn();
    const remove = pool.subscribe("companion-a", listener);
    remove();
    complete({ getFrame: () => 1, destroy });
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not deliver old frames to an identity which has been remounted", async () => {
    const publishers: Array<(frame: number) => void> = [];
    const sources: Array<{ getFrame: () => number; destroy: ReturnType<typeof vi.fn> }> = [];
    const pool = new ActivitySourcePool(
      async (_identity: string, publish: (frame: number) => void) => {
        publishers.push(publish);
        const source = { getFrame: () => sources.length, destroy: vi.fn() };
        sources.push(source);
        return source;
      },
    );
    const oldView = vi.fn();
    const remove = pool.subscribe("companion-a", oldView);
    await Promise.resolve();
    remove();
    const newView = vi.fn();
    const removeNew = pool.subscribe("companion-a", newView);
    await Promise.resolve();
    newView.mockClear();
    publishers[0]!(99);
    expect(newView).not.toHaveBeenCalled();
    publishers[1]!(100);
    expect(newView).toHaveBeenCalledWith(100);
    expect(sources[0]!.destroy).toHaveBeenCalledTimes(1);
    removeNew();
  });

  it("keeps other identities running when one bot stops", async () => {
    const sources = new Map<
      string,
      { getFrame: () => number; destroy: ReturnType<typeof vi.fn> }
    >();
    const pool = new ActivitySourcePool(async (identity: string) => {
      const source = { getFrame: () => 1, destroy: vi.fn() };
      sources.set(identity, source);
      return source;
    });
    const removeFirst = pool.subscribe("companion-a", vi.fn());
    const removeSecond = pool.subscribe("companion-b", vi.fn());
    await Promise.resolve();
    removeFirst();
    expect(sources.get("companion-a")!.destroy).toHaveBeenCalledTimes(1);
    expect(sources.get("companion-b")!.destroy).not.toHaveBeenCalled();
    removeSecond();
  });
});
