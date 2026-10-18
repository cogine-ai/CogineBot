import type { AppBootstrap } from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    location: new URL("http://localhost/app/board"),
    localStorage: { getItem: () => null },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["transport", "response body"])(
  "aborts a hanging %s through the real RPC adapter and recovers with a fresh request",
  async (stage) => {
    let request!: Request;
    let bodyAborted = false;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      request = input as Request;
      if (stage === "transport") {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                "abort",
                () => {
                  bodyAborted = true;
                  controller.error(request.signal.reason);
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const bootstrap = await import("./bootstrap");
    const outcome = bootstrap.takeInitialBootstrap().catch((error: unknown) => error);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(request.url).pathname).toBe("/rpc/bootstrap");
    expect(request.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
    expect(request.signal.aborted).toBe(true);
    if (stage === "response body") expect(bodyAborted).toBe(true);
    expect(bootstrap.getTicketBoardEnabled()).toBeUndefined();

    const recovered = { me: { ticketBoardEnabled: true } } as AppBootstrap;
    fetch.mockImplementationOnce(async () => Response.json({ json: recovered }));
    await expect(bootstrap.takeInitialBootstrap()).resolves.toEqual(recovered);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bootstrap.getTicketBoardEnabled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);
