import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "./rpc";
import { readThreadSnapshot } from "./thread-snapshot-request";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Read timed out", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
  vi.stubGlobal("window", {
    location: new URL("http://localhost/login"),
    localStorage: { getItem: () => null },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function heldBody(onAbort: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
  let request!: Request;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    request = input as Request;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => onAbort(controller), { once: true });
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, request: () => request };
}

const abortedBody = (controller: ReadableStreamDefaultController<Uint8Array>) =>
  controller.error(new DOMException("The user aborted a request.", "AbortError"));

it.each(
  (["get", "head"] as const).flatMap((method) =>
    (["botId", "groupId"] as const).map((targetKey) => ({ method, targetKey })),
  ),
)(
  "retains its deadline when a 200 $targetKey $method body aborts during RPC decoding",
  async ({ method, targetKey }) => {
    const body = heldBody(abortedBody);
    const parent = new AbortController();
    const { isRecoverableReadError } = await import("./bootstrap");
    const outcome = readThreadSnapshot(parent.signal, (signal) =>
      rpc.threads[method]({ [targetKey]: "target" }, { signal }),
    ).catch((error: unknown) => error);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(body.fetch).toHaveBeenCalledOnce();
    expect(body.request().signal.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(body.request().signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(parent.signal.aborted).toBe(false);
    expect(error).toBe(body.request().signal.reason);
    expect(isRecoverableReadError(error)).toBe(true);
  },
);

it("leaves the real RPC decoder's ordinary body abort non-recoverable", async () => {
  const body = heldBody(abortedBody);
  const parent = new AbortController();
  const { isRecoverableReadError } = await import("./bootstrap");
  const outcome = readThreadSnapshot(parent.signal, (signal) =>
    rpc.threads.get({ botId: "target" }, { signal }),
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  parent.abort();
  const error = await outcome;
  expect(error).toMatchObject({
    message: "Cannot parse response body, please check the response body and content-type.",
    cause: { name: "AbortError" },
  });
  expect(body.request().signal.reason).toBe(parent.signal.reason);
  expect(isRecoverableReadError(error)).toBe(false);
});

it("does not normalize an unrelated body abort while its own signal is live", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start: abortedBody,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  const parent = new AbortController();
  const { isRecoverableReadError } = await import("./bootstrap");
  const error = await readThreadSnapshot(parent.signal, (signal) =>
    rpc.threads.get({ botId: "target" }, { signal }),
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({ cause: { name: "AbortError" } });
  expect(isRecoverableReadError(error)).toBe(false);
  expect(parent.signal.aborted).toBe(false);
});

it.each([false, true])("does not retry malformed JSON after deadline=%s", async (atDeadline) => {
  if (atDeadline)
    heldBody((controller) => {
      controller.enqueue(new TextEncoder().encode("{"));
      controller.close();
    });
  else
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { headers: { "content-type": "application/json" } })),
    );
  const { isRecoverableReadError } = await import("./bootstrap");
  const outcome = readThreadSnapshot(new AbortController().signal, (signal) =>
    rpc.threads.get({ botId: "target" }, { signal }),
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(atDeadline ? 2_000 : 0);
  const error = await outcome;
  expect(error).toMatchObject({ cause: { name: "SyntaxError" } });
  expect(isRecoverableReadError(error)).toBe(false);
});

it.each(["UNAUTHORIZED", "FORBIDDEN"] as const)("preserves a decoded %s response", async (code) => {
  const failure = new ORPCError(code);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { json: { defined: false, code, status: failure.status, message: "Read denied" } },
        { status: failure.status },
      ),
    ),
  );
  const { isRecoverableReadError } = await import("./bootstrap");
  const error = await readThreadSnapshot(new AbortController().signal, (signal) =>
    rpc.threads.get({ botId: "target" }, { signal }),
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({ code, status: failure.status });
  expect(isRecoverableReadError(error)).toBe(false);
});

it.each(["UNAUTHORIZED", "FORBIDDEN"] as const)(
  "preserves nested %s even with an abort cause after its deadline",
  async (code) => {
    const failure = new Error("Read failed", {
      cause: new ORPCError(code, { cause: new DOMException("Aborted", "AbortError") }),
    });
    const { isRecoverableReadError } = await import("./bootstrap");
    const outcome = readThreadSnapshot(
      new AbortController().signal,
      (signal) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(failure), { once: true }),
        ),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await outcome;
    expect(error).toBe(failure);
    expect(isRecoverableReadError(error)).toBe(false);
  },
);

it("prioritizes parent cancellation when it follows the deadline before rejection", async () => {
  const parent = new AbortController();
  const failure = new Error("Cannot parse response body", {
    cause: new DOMException("Aborted", "AbortError"),
  });
  const { isRecoverableReadError } = await import("./bootstrap");
  const outcome = readThreadSnapshot(
    parent.signal,
    (signal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            parent.abort();
            reject(failure);
          },
          { once: true },
        ),
      ),
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await outcome).toBe(failure);
  expect(isRecoverableReadError(await outcome)).toBe(false);
});
