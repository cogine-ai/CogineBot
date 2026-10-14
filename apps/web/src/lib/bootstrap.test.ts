// @vitest-environment jsdom
import type { AppBootstrap } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const bootstrapRequest = vi.hoisted(() => vi.fn<() => Promise<AppBootstrap>>());
vi.mock("./rpc", () => ({ rpc: { bootstrap: bootstrapRequest } }));
vi.mock("./performance", () => ({ markOnce: () => {} }));

beforeEach(() => {
  vi.resetModules();
  bootstrapRequest.mockReset();
  window.history.replaceState({}, "", "/app/board");
});

function bootstrapWithCapability(enabled: boolean) {
  return { me: { ticketBoardEnabled: enabled } } as AppBootstrap;
}

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
  expect(bootstrapRequest).toHaveBeenCalledWith({});

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
