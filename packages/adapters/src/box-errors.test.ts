import { FetchError, ResponseError } from "@asciidev/box-sdk";
import { SandboxRateLimitError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxResponseError, wrapBoxCall } from "./box-errors.js";
import { BoxSandboxProvider, isUnrecoverableBoxError } from "./box-sandbox.js";

afterEach(() => vi.unstubAllGlobals());

describe("Box API errors", () => {
  it("uses the same neutral quota error for an actual SDK-backed create rejection", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ code: "rate_limited", message: "Start quota reached" }, { status: 429 }),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = new BoxSandboxProvider({ apiKey: "fake-box-key" });
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused" },
        {
          operationId: "test",
          traceId: "test",
          spaceId: "space",
          userId: "user",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530, 402])(
    "classifies an actual SDK-backed HTTP %i rejection without resending create",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            code: "synthetic_provider_failure",
            message:
              "Rejected fake-box-key; Bearer private-credential; https://box.example/?token=secret",
          },
          { status },
        ),
      );
      vi.stubGlobal("fetch", fetch);
      const provider = new BoxSandboxProvider({ apiKey: "fake-box-key" });
      const error = await provider
        .provision(
          { botId: "bot", homePath: "/unused" },
          {
            operationId: "test",
            traceId: "test",
            spaceId: "space",
            userId: "user",
            signal: new AbortController().signal,
          },
        )
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(SandboxUnresponsiveError);
      expect(error).toMatchObject({ cause: { response: { status } } });
      expect(isUnrecoverableBoxError(error)).toBe(false);
      for (const secret of ["fake-box-key", "private-credential", "token=secret"]) {
        expect(String(error)).not.toContain(secret);
        expect(String((error as Error).cause)).not.toContain(secret);
      }
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 401, 403, 404, 409, 422, 501])(
    "preserves an HTTP %i error's recovery contract without calling it an outage",
    async (status) => {
      const call = vi.fn(async () => {
        throw new ResponseError(
          Response.json({ message: "synthetic request rejected" }, { status }),
        );
      });
      const error = await wrapBoxCall(call, "fake-key")().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ResponseError);
      expect(error).not.toBeInstanceOf(SandboxUnresponsiveError);
      expect(isUnrecoverableBoxError(error)).toBe(status === 404);
      expect(call).toHaveBeenCalledOnce();
    },
  );

  it("classifies a lost SDK connection without resending a possibly accepted operation", async () => {
    const lost = new FetchError(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
    );
    const call = vi.fn(async () => {
      throw lost;
    });
    const error = await wrapBoxCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxUnresponsiveError);
    expect((error as Error).message).toBe("Box could not be reached");
    expect((error as Error).cause).toBe(lost);
    expect(call).toHaveBeenCalledOnce();
  });

  it.each(["AbortError", "TimeoutError"])("preserves an SDK caller's %s", async (name) => {
    const failure = new FetchError(new DOMException("synthetic cancelled request", name));
    const call = vi.fn(async () => {
      throw failure;
    });
    await expect(wrapBoxCall(call, "fake-key")()).rejects.toBe(failure);
    expect(call).toHaveBeenCalledOnce();
  });

  it("preserves a network failure after its request signal was cancelled", async () => {
    const controller = new AbortController();
    const failure = new FetchError(new TypeError("fetch failed"));
    const call = vi.fn(async (_request: object, _init: RequestInit) => {
      controller.abort();
      throw failure;
    });
    await expect(wrapBoxCall(call, "fake-key")({}, { signal: controller.signal })).rejects.toBe(
      failure,
    );
    expect(call).toHaveBeenCalledOnce();
  });

  it("maps a quota rejection to a neutral error while keeping a bounded sanitized cause", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(
        Response.json(
          {
            code: "rate_limited",
            message:
              "Rejected fake-key; Bearer private-credential; https://box.example/?token=secret",
          },
          { status: 429 },
        ),
      );
    });
    const error = await wrapBoxCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxRateLimitError);
    expect(error).toMatchObject({
      code: "SANDBOX_RATE_LIMITED",
      message: "Too many computer requests. Try again later.",
      cause: { response: { status: 429 } },
    });
    expect(isUnrecoverableBoxError(error)).toBe(false);
    expect((error as Error).cause).toBeInstanceOf(ResponseError);
    for (const secret of ["fake-key", "private-credential", "token=secret"])
      expect(String((error as Error).cause)).not.toContain(secret);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports the upstream failure through the real SDK-backed file operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "box_direct_failed",
            message: "File is too large for read_file. Use artifact download instead.",
            requestId: "req_example",
          },
          { status: 400 },
        ),
      ),
    );
    const provider = new BoxSandboxProvider({ apiKey: "fake-box-key" });
    await expect(
      provider.readFile(
        { id: "box-test", providerRef: "box-test", botId: "bot-test", kind: "box" },
        "data.bin",
        {
          operationId: "test",
          traceId: "test",
          spaceId: "test",
          userId: "test",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(
      "Box API request failed (HTTP 400, box_direct_failed): File is too large for read_file. Use artifact download instead. (request req_example)",
    );
  });

  it("preserves 404 recovery and does not retry failed commands", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(Response.json({ message: "Box not found" }, { status: 404 }));
    });
    const error = await wrapBoxCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ResponseError);
    expect(isUnrecoverableBoxError(error)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not replace cancellation and network errors", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    const call = wrapBoxCall(async () => {
      throw cancelled;
    }, "fake-key");
    await expect(call()).rejects.toBe(cancelled);
  });

  it("redacts credentials and signed URLs while retaining the useful diagnosis", async () => {
    const error = await boxResponseError(
      Response.json(
        {
          code: "unauthorized",
          message:
            "Rejected fake-box-key; Bearer other-credential; see https://box.example/desktop?token=private-value",
        },
        { status: 401 },
      ),
      "fake-box-key",
    );
    expect(error.message).toContain("HTTP 401, unauthorized");
    for (const secret of ["fake-box-key", "other-credential", "private-value"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it.each(["upstream HTML", "null", "[]", '{"message":42}'])(
    "uses an HTTP fallback for malformed or unstructured errors: %s",
    async (body) => {
      const error = await boxResponseError(new Response(body, { status: 502 }), "fake-key");
      expect(error.message).toBe("Box API request failed (HTTP 502)");
    },
  );

  it("caps upstream detail and stops reading oversized error bodies", async () => {
    const error = await boxResponseError(
      Response.json({ message: "x".repeat(1_000) }, { status: 400 }),
      "fake-key",
    );
    expect(error.message.length).toBeLessThan(600);

    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20_000));
        },
        cancel,
      }),
      { status: 503 },
    );
    expect((await boxResponseError(response, "fake-key")).message).toBe(
      "Box API request failed (HTTP 503)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back to the HTTP status when an error body stalls", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
      { status: 504 },
    );

    const pending = boxResponseError(response, "fake-key", controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).resolves.toMatchObject({
      message: "Box API request failed (HTTP 504)",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
