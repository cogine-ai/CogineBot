import type { ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { lazyRunComputer } from "./run-computer.js";

const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "fake",
  providerRef: "fake-1",
};

describe("a run's computer", () => {
  it("starts only when needed and shares one pending start across callers", async () => {
    let finish!: (computer: ComputerRef) => void;
    const start = vi.fn(
      () =>
        new Promise<ComputerRef>((resolve) => {
          finish = resolve;
        }),
    );
    const current = lazyRunComputer(start);
    expect(start).not.toHaveBeenCalled();
    expect(current.ready).toBeUndefined();
    expect(() => current.throwIfFailed()).not.toThrow();

    const first = current.get();
    const second = current.get();
    expect(first).toBe(second);
    expect(start).toHaveBeenCalledOnce();
    expect(current.ready).toBeUndefined();
    finish(computer);

    await expect(first).resolves.toBe(computer);
    await expect(second).resolves.toBe(computer);
    expect(current.ready).toBe(computer);
    expect(current.get()).toBe(first);
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([new Error("computer unavailable"), undefined])(
    "keeps a failed start and its original setup failure: %s",
    async (failure) => {
      const start = vi.fn(async (): Promise<ComputerRef> => {
        throw failure;
      });
      const onFailure = vi.fn();
      const current = lazyRunComputer(start, onFailure);
      const first = current.get();

      await expect(first).rejects.toBe(failure);
      expect(current.get()).toBe(first);
      await expect(current.get()).rejects.toBe(failure);
      expect(start).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledOnce();
      expect(current.ready).toBeUndefined();
      let caught = false;
      try {
        current.throwIfFailed();
      } catch (error) {
        caught = true;
        expect(error).toBe(failure);
      }
      expect(caught).toBe(true);
    },
  );

  it("does not share one run's failed computer with another run", async () => {
    const start = vi
      .fn<() => Promise<ComputerRef>>()
      .mockRejectedValueOnce(new Error("first start failed"))
      .mockResolvedValueOnce(computer);
    const first = lazyRunComputer(start);
    await expect(first.get()).rejects.toThrow("first start failed");

    const next = lazyRunComputer(start);
    await expect(next.get()).resolves.toBe(computer);
    expect(next.ready).toBe(computer);
    expect(() => next.throwIfFailed()).not.toThrow();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
