// @vitest-environment jsdom

import { ORPCError } from "@orpc/client";
import type { AppBootstrap } from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bootstrapRequest = vi.hoisted(() =>
  vi.fn<(input: { botId?: string }, options?: { signal?: AbortSignal }) => Promise<AppBootstrap>>(),
);
vi.mock("./rpc", () => ({ rpc: { bootstrap: bootstrapRequest } }));
vi.mock("./performance", () => ({ markOnce: () => {} }));

beforeEach(() => {
  vi.resetModules();
  bootstrapRequest.mockReset();
  window.history.replaceState({}, "", "/app/board");
});

afterEach(() => {
  vi.useRealTimers();
});

function bootstrapWithCapability(enabled: boolean) {
  return { me: { ticketBoardEnabled: enabled } } as AppBootstrap;
}

it.each(["direct", "cause"])("recovers an HTTP 500 read error from %s", async (kind) => {
  window.history.replaceState({}, "", "/login");
  const { isRecoverableReadError } = await import("./bootstrap");
  const failure = new ORPCError("INTERNAL_SERVER_ERROR");
  expect(failure.status).toBe(500);
  expect(
    isRecoverableReadError(
      kind === "cause" ? new Error("Read failed", { cause: failure }) : failure,
    ),
  ).toBe(true);
});

it.each(["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"] as const)(
  "does not automatically retry a permanent %s read error",
  async (code) => {
    window.history.replaceState({}, "", "/login");
    const { isRecoverableReadError } = await import("./bootstrap");
    const failure = new ORPCError(code);
    expect(isRecoverableReadError(failure)).toBe(false);
    expect(isRecoverableReadError(new Error("Failed to fetch", { cause: failure }))).toBe(false);
  },
);

it.each([
  new TypeError("Failed to fetch"),
  Object.assign(new Error("Read timed out"), { name: "TimeoutError" }),
  new ORPCError("BAD_GATEWAY"),
  new ORPCError("SERVICE_UNAVAILABLE"),
  new ORPCError("GATEWAY_TIMEOUT"),
])("preserves existing recoverable read errors: %s", async (failure) => {
  window.history.replaceState({}, "", "/login");
  const { isRecoverableReadError } = await import("./bootstrap");
  expect(isRecoverableReadError(failure)).toBe(true);
});

it("keeps Board capability unknown until the primed request returns", async () => {
  let resolve!: (bootstrap: AppBootstrap) => void;
  bootstrapRequest.mockReturnValue(
    new Promise<AppBootstrap>((finish) => {
      resolve = finish;
    }),
  );
  const bootstrap = await import("./bootstrap");
  const listener = vi.fn();
  const unsubscribe = bootstrap.subscribeTicketBoardEnabled(listener);
  expect(bootstrap.getTicketBoardEnabled()).toBeUndefined();
  expect(bootstrapRequest).toHaveBeenCalledOnce();
  expect(bootstrapRequest.mock.calls[0]?.[0]).toEqual({});

  resolve(bootstrapWithCapability(true));
  await bootstrap.peekInitialBootstrap();
  expect(bootstrap.getTicketBoardEnabled()).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  await bootstrap.takeInitialBootstrap();
  expect(bootstrapRequest).toHaveBeenCalledOnce();

  unsubscribe();
  bootstrapRequest.mockResolvedValueOnce(bootstrapWithCapability(false));
  await bootstrap.takeInitialBootstrap();
  expect(bootstrap.getTicketBoardEnabled()).toBe(false);
  expect(listener).toHaveBeenCalledOnce();
});

it("does not treat a failed bootstrap as disabled and supports a subsequent request", async () => {
  bootstrapRequest.mockRejectedValueOnce(new Error("Server unavailable"));
  const bootstrap = await import("./bootstrap");
  const listener = vi.fn();
  const unsubscribe = bootstrap.subscribeTicketBoardEnabled(listener);
  await expect(bootstrap.takeInitialBootstrap()).rejects.toThrow("Server unavailable");
  expect(bootstrap.getTicketBoardEnabled()).toBeUndefined();
  expect(listener).not.toHaveBeenCalled();

  bootstrapRequest.mockResolvedValueOnce(bootstrapWithCapability(false));
  await bootstrap.takeInitialBootstrap();
  expect(bootstrap.getTicketBoardEnabled()).toBe(false);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});

it.each(["primed", "fresh"])(
  "expires a hanging %s request and accepts a fresh recovery without stale capability updates",
  async (kind) => {
    vi.useFakeTimers();
    if (kind === "fresh") window.history.replaceState({}, "", "/login");
    let resolveExpired!: (bootstrap: AppBootstrap) => void;
    bootstrapRequest.mockReturnValueOnce(
      new Promise<AppBootstrap>((resolve) => {
        resolveExpired = resolve;
      }),
    );
    const bootstrap = await import("./bootstrap");
    const listener = vi.fn();
    bootstrap.subscribeTicketBoardEnabled(listener);
    const outcome = bootstrap.takeInitialBootstrap().then(
      () => "resolved",
      (error: unknown) => error,
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
    expect(bootstrapRequest.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(bootstrap.getTicketBoardEnabled()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    bootstrapRequest.mockResolvedValueOnce(bootstrapWithCapability(false));
    await bootstrap.takeInitialBootstrap();
    expect(bootstrapRequest).toHaveBeenCalledTimes(2);
    expect(bootstrapRequest.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(bootstrap.getTicketBoardEnabled()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();

    resolveExpired(bootstrapWithCapability(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(bootstrap.getTicketBoardEnabled()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("allows a slow bootstrap within the deadline and clears the deadline afterward", async () => {
  vi.useFakeTimers();
  let resolve!: (bootstrap: AppBootstrap) => void;
  bootstrapRequest.mockReturnValueOnce(
    new Promise<AppBootstrap>((finish) => {
      resolve = finish;
    }),
  );
  const bootstrap = await import("./bootstrap");
  const pending = bootstrap.takeInitialBootstrap();
  await vi.advanceTimersByTimeAsync(14_999);
  resolve(bootstrapWithCapability(true));
  await expect(pending).resolves.toEqual(bootstrapWithCapability(true));
  expect(bootstrap.getTicketBoardEnabled()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(bootstrapRequest.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
});

it("preserves a failed request error and clears its deadline before recovery", async () => {
  vi.useFakeTimers();
  const failure = new TypeError("Failed to fetch");
  bootstrapRequest.mockRejectedValueOnce(failure);
  const bootstrap = await import("./bootstrap");
  await expect(bootstrap.takeInitialBootstrap()).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
  bootstrapRequest.mockResolvedValueOnce(bootstrapWithCapability(true));
  await bootstrap.takeInitialBootstrap();
  expect(bootstrap.getTicketBoardEnabled()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("handles an expired speculative request before Shell consumes it", async () => {
  vi.useFakeTimers();
  bootstrapRequest.mockReturnValueOnce(new Promise<AppBootstrap>(() => {}));
  const bootstrap = await import("./bootstrap");
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(bootstrap.takeInitialBootstrap()).rejects.toMatchObject({ name: "TimeoutError" });
  expect(bootstrap.getTicketBoardEnabled()).toBeUndefined();
  bootstrapRequest.mockResolvedValueOnce(bootstrapWithCapability(true));
  await expect(bootstrap.takeInitialBootstrap()).resolves.toEqual(bootstrapWithCapability(true));
  expect(bootstrap.getTicketBoardEnabled()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
