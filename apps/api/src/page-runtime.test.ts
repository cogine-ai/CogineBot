import { createHash } from "node:crypto";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPageRuntime } from "./page-runtime.js";

const app = new Hono();
mountPageRuntime(app);

afterEach(() => {
  vi.doUnmock("@rakazo/page-kit/runtime-build");
  vi.resetModules();
});

describe("page runtime asset", () => {
  it("serves the actual self-contained runtime to an anonymous opaque viewer", async () => {
    const response = await app.request(PAGE_RUNTIME_PATH, { headers: { origin: "null" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(body)).toContain("RakazoPage");
    expect(response.headers.get("etag")).toBe(
      `"page-runtime-${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`,
    );
  });

  it.each([
    ["strong", (etag: string) => etag],
    ["weak", (etag: string) => `W/${etag}`],
    ["list", (etag: string) => `"other,tag", W/${etag}, "another"`],
    ["wildcard", () => " * "],
  ])("revalidates a matching %s tag without downloading the runtime", async (_name, value) => {
    const original = await app.request(PAGE_RUNTIME_PATH);
    const response = await app.request(PAGE_RUNTIME_PATH, {
      headers: { "if-none-match": value(original.headers.get("etag") ?? "") },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(original.headers.get("etag"));
    expect(response.headers.get("cache-control")).toBe("public, no-cache");
  });

  it("returns the runtime when only a different quoted tag matches", async () => {
    const response = await app.request(PAGE_RUNTIME_PATH, {
      headers: { "if-none-match": '"other,tag", W/"not-the-runtime"' },
    });
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(0);
    expect((await app.request("/api/v1/assets/private.js")).status).toBe(404);
  });

  it("coalesces concurrent requests and retries after an opaque uncached build failure", async () => {
    let rejectBuild!: (error: Error) => void;
    const pending = new Promise<string>((_resolve, reject) => {
      rejectBuild = reject;
    });
    const build = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce("valid runtime");
    vi.resetModules();
    vi.doMock("@rakazo/page-kit/runtime-build", () => ({ buildPageRuntime: build }));
    const { mountPageRuntime: mount } = await import("./page-runtime.js");
    const isolated = new Hono();
    mount(isolated);
    const requests = [isolated.request(PAGE_RUNTIME_PATH), isolated.request(PAGE_RUNTIME_PATH)];
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    rejectBuild(new Error("synthetic private build detail"));
    const failed = await Promise.all(requests);
    for (const response of failed) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("Page renderer unavailable");
      expect(response.headers.get("etag")).toBeNull();
    }
    expect(build).toHaveBeenCalledTimes(1);
    const retry = await isolated.request(PAGE_RUNTIME_PATH);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("valid runtime");
    expect(build).toHaveBeenCalledTimes(2);
  });
});
