import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGRAM_SCRIPT_PATH, mountDiagramScript } from "./diagram-script.js";

const app = new Hono();
mountDiagramScript(app);

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

describe("diagram script route", () => {
  it("serves the exact installed browser bundle without authentication", async () => {
    const response = await app.request(DIAGRAM_SCRIPT_PATH, {
      headers: { origin: "null" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    const require = createRequire(import.meta.url);
    const installed = await readFile(require.resolve("mermaid/dist/mermaid.min.js"));
    const license = await readFile(require.resolve("mermaid/LICENSE"), "utf8");
    const served = Buffer.concat([Buffer.from(`/*! Mermaid\n${license}\n*/\n`), installed]);
    expect(body).toEqual(new Uint8Array(served));
    expect(response.headers.get("etag")).toBe(
      `"mermaid-${createHash("sha256").update(served).digest("hex")}"`,
    );
    expect(new TextDecoder().decode(body)).toContain('globalThis["mermaid"]');
  });

  it.each([
    ["strong", (etag: string) => etag],
    ["weak", (etag: string) => `W/${etag}`],
    ["list", (etag: string) => `"other,tag", W/${etag}, "another"`],
    ["wildcard", () => " * "],
  ])("returns no body for matching %s revalidation", async (_name, validator) => {
    const etag = (await app.request(DIAGRAM_SCRIPT_PATH)).headers.get("etag") ?? "";
    const response = await app.request(DIAGRAM_SCRIPT_PATH, {
      headers: { "if-none-match": validator(etag) },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it.each(['"other,tag"', 'W/"other"', '"other", "another"', '"mermaid-not-the-digest"'])(
    "returns the bundle for nonmatching validator %s",
    async (validator) => {
      const response = await app.request(DIAGRAM_SCRIPT_PATH, {
        headers: { "if-none-match": validator },
      });
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
    },
  );

  it("does not expose arbitrary asset or filesystem paths", async () => {
    const response = await app.request("/api/v1/assets/not-a-bundle.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns an opaque, uncached failure and retries loading the next request", async () => {
    const failure = new Error("private path must not be included in the response");
    const load = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(Buffer.from("bundle"));
    const read = vi.fn((path: string) =>
      path.endsWith("LICENSE") ? Promise.resolve("license") : load(),
    );
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ readFile: read }));
    const { mountDiagramScript: mount } = await import("./diagram-script.js");
    const isolated = new Hono();
    mount(isolated);
    const failed = await isolated.request(DIAGRAM_SCRIPT_PATH);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await failed.text()).toBe("Diagram renderer unavailable");
    const retry = await isolated.request(DIAGRAM_SCRIPT_PATH);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("/*! Mermaid\nlicense\n*/\nbundle");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
