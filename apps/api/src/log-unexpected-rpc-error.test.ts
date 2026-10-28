import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpcError, logUnexpectedRpcError } from "./app.js";

describe("logUnexpectedRpcError", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it("stays quiet for an error the router chose to return", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    logUnexpectedRpcError(new ORPCError("BAD_REQUEST", { message: "file is too large" }), [
      "computer",
      "readFile",
    ]);

    expect(sink.events).toEqual([]);
  });

  it("sends a computer rate limit as HTTP 429 without serializing its provider cause", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const router = {
      boot: os.handler(() => {
        throw new SandboxRateLimitError({ cause: new Error("Synthetic provider diagnostic") });
      }),
    };
    const rpc = new RPCHandler(router, {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });
    const { response } = await rpc.handle(
      new Request("http://localhost/rpc/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: {} },
    );
    expect(response?.status).toBe(429);
    const body = await response!.text();
    expect(body).toContain("Too many computer requests. Try again later.");
    expect(body).not.toContain("Synthetic provider diagnostic");
    expect(sink.events[0]).toMatchObject({
      message: "rpc boot failed",
      error: { cause: { message: "Synthetic provider diagnostic" } },
    });
  });

  it("does not reinterpret ordinary failures or overwrite an explicit router status", () => {
    installLogger(createLogger({ service: "rakazo-api", sinks: [createTestSink()] }));
    expect(() =>
      handleRpcError(new Error("Synthetic network unavailable"), ["computer", "boot"]),
    ).not.toThrow();
    expect(() => handleRpcError(new ORPCError("UNAUTHORIZED"), ["computer", "boot"])).not.toThrow();
  });

  it("names the procedure and every cause behind an opaque failure", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const error = new Error("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7091"), {
        code: "ECONNREFUSED",
      }),
    });

    logUnexpectedRpcError(error, ["computer", "screenUrl"]);

    expect(sink.events[0]).toMatchObject({
      message: "rpc computer/screenUrl failed",
      error: {
        message: "fetch failed",
        cause: { message: "connect ECONNREFUSED 127.0.0.1:7091" },
      },
    });
  });
});
