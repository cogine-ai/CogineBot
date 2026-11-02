import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};

function fixture() {
  const pluginRead = vi.fn(async (url: string, maxBytes: number, signal?: AbortSignal) => {
    expect(url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/(cursor\/plugins|xai-org\/plugin-marketplace)\/HEAD\/\.(cursor|grok)-plugin\/marketplace\.json$/,
    );
    expect(maxBytes).toBe(2_000_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    return JSON.stringify({
      plugins: url.includes("/cursor/")
        ? Array.from({ length: 55 }, (_, i) => ({
            name: `Tool ${String(i).padStart(2, "0")}`,
            source: `./plugins/tool-${i}`,
            keywords: ["fixture"],
          }))
        : [{ name: "Other", source: "https://github.com/example/other" }],
    });
  });
  const deps = {
    pluginRead,
    prisma: {},
    secrets: {},
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fixture",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/plugin-search-fixture",
  } as unknown as RouterDeps;
  const router = createRouter(deps);
  const clientFor = (
    context: {
      actor: Actor | null;
      signal?: AbortSignal;
      stillAuthorized?: () => Promise<boolean>;
    } = { actor },
  ) => createRouterClient(router, { context: context as never });
  return { pluginRead, client: clientFor(), clientFor };
}

describe("authenticated public plugin discovery", () => {
  it("returns bounded source hints with a query-bound cursor without writing or installing", async () => {
    const f = fixture();
    const first = await f.client.plugins.search({ query: "fixture" });
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]).toMatchObject({
      name: "Tool 00",
      registry: "Cursor",
      source: "https://github.com/cursor/plugins#plugins/tool-0",
      installedSource: "https://github.com/cursor/plugins#plugins/tool-0",
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await f.client.plugins.search({ query: "fixture", cursor: first.nextCursor! });
    expect(second.entries).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(55);
    expect(f.pluginRead).toHaveBeenCalledTimes(2);
    await expect(
      f.client.plugins.search({ query: "other", cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.client.plugins.search({ query: "fixture", cursor: "invalid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports a failed registry independently from a successful empty query", async () => {
    const f = fixture();
    const original = f.pluginRead.getMockImplementation()!;
    f.pluginRead.mockImplementation(async (url, maxBytes, signal) => {
      if (url.includes("/xai-org/")) throw new Error("private raw registry diagnostics");
      return original(url, maxBytes, signal);
    });
    const result = await f.client.plugins.search({ query: "absent" });
    expect(result).toEqual({
      entries: [],
      nextCursor: null,
      unavailableRegistries: ["xAI"],
      skippedEntries: 0,
    });
    expect(JSON.stringify(result)).not.toContain("private raw");
  });

  it("refuses anonymous requests before any registry read", async () => {
    const f = fixture();
    await expect(f.clientFor({ actor: null }).plugins.search({ query: "" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(f.pluginRead).not.toHaveBeenCalled();
  });

  it("rechecks revoked authentication after the shared public fetch", async () => {
    const f = fixture();
    const stillAuthorized = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      f.clientFor({ actor, stillAuthorized }).plugins.search({ query: "" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stillAuthorized).toHaveBeenCalledTimes(2);
  });

  it("rejects an already aborted request without acquiring registry data", async () => {
    const f = fixture();
    await expect(
      f.clientFor({ actor, signal: AbortSignal.abort() }).plugins.search({ query: "" }),
    ).rejects.toThrow();
    expect(f.pluginRead).not.toHaveBeenCalled();
  });
});
