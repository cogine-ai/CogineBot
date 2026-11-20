import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolveHostname } from "./network-address.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "./serenity-memory-provider.js";
import {
  prepareSupermemoryConnection,
  SupermemoryMemoryProvider,
} from "./supermemory-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function provider() {
  return new SupermemoryMemoryProvider({
    baseUrl: "http://localhost:6767",
    apiKey: "sm_test_key",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("SupermemoryMemoryProvider", () => {
  it("keeps Supermemory namespaces inside the adapter and omits empty history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      { query: "project", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:workspace:workspace-1", "rakazo:bot-1"]);
  });

  it("adds the current history generation only after compaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      {
        query: "project",
        scope: "isolated",
        botId: "bot-1",
        historyGeneration: 3,
        limit: 5,
      },
      context,
    );

    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:bot-1", "rakazo:bot-1:history:3"]);
  });

  it.each([
    { scenario: "complete facts", space: "facts", bot: "facts", history: "facts" },
    { scenario: "complete empty", space: "empty", bot: "empty", history: "empty" },
    {
      scenario: "space unavailable",
      space: "failed",
      bot: "facts",
      history: "facts",
      partial: true,
    },
    { scenario: "bot unavailable", space: "facts", bot: "failed", history: "facts", partial: true },
    {
      scenario: "history unavailable",
      space: "facts",
      bot: "facts",
      history: "failed",
      partial: true,
    },
    { scenario: "partial empty", space: "failed", bot: "empty", history: "empty", partial: true },
    { scenario: "all unavailable", space: "failed", bot: "failed", history: "failed" },
  ] as const)("distinguishes $scenario across scoped containers", async (test) => {
    const spaceTag = "rakazo:workspace:workspace-1";
    const botTag = "rakazo:bot-1";
    const historyTag = "rakazo:bot-1:history:3";
    const updatedAt = "2025-01-01T00:00:00Z";
    const responses = new Map([
      [spaceTag, { outcome: test.space, results: [{ memory: "shared", similarity: 0.7 }] }],
      [botTag, { outcome: test.bot, results: [{ memory: "shared", similarity: 0.9, updatedAt }] }],
      [
        historyTag,
        {
          outcome: test.history,
          results: [
            { memory: "history", similarity: 0.8 },
            { memory: "low", similarity: 0.1 },
          ],
        },
      ],
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const { containerTag } = JSON.parse(String(init?.body));
      const fixture = responses.get(containerTag);
      if (!fixture) throw new Error("Unexpected fixture container");
      if (fixture.outcome === "failed") {
        return new Response("synthetic unavailable container details", { status: 503 });
      }
      return Response.json({ results: fixture.outcome === "empty" ? [] : fixture.results });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().recall(
      { query: "project", scope: "shared", botId: "bot-1", historyGeneration: 3, limit: 2 },
      context,
    );

    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).containerTag),
    ).toEqual([spaceTag, botTag, historyTag]);
    expect(
      fetchMock.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).limit === 2),
    ).toBe(true);
    if (test.space === "failed" && test.bot === "failed" && test.history === "failed") {
      const error = "Supermemory search failed: 503";
      expect(result).toEqual({ ok: false, error: [error, error, error].join("; ") });
      return;
    }
    expect(result).toEqual({
      ok: true,
      value: [
        ...(test.bot === "facts" ? [{ memory: "shared", score: 0.9, updatedAt }] : []),
        ...(test.history === "facts" ? [{ memory: "history", score: 0.8 }] : []),
        ...(test.bot !== "facts" && test.space === "facts"
          ? [{ memory: "shared", score: 0.7 }]
          : []),
      ],
      ...("partial" in test && { partial: true }),
    });
  });

  it("keeps blank queries empty without querying any container", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      provider().recall({ query: "  ", scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes recall limits and cancellation through to the provider client", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 2 },
      { ...context, signal: controller.signal },
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).limit).toBe(2);
    expect(init?.signal.aborted).toBe(true);
  });

  it("mirrors shared durable saves so a later scope change retains bot memory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:workspace:workspace-1", "rakazo:bot-1"]);
  });

  it("purges only requested history generations", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url) =>
      Response.json({
        success: true,
        containerTag: decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!),
        deletedDocumentsCount: 0,
        deletedMemoriesCount: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [2, 3, 3] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:6767/v3/container-tags/rakazo%3Abot-1%3Ahistory%3A2",
      "http://localhost:6767/v3/container-tags/rakazo%3Abot-1%3Ahistory%3A3",
    ]);
  });

  it("does not fetch when a saved local base URL is a public address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SupermemoryMemoryProvider({
      baseUrl: "http://203.0.113.10:6767",
      apiKey: "sm_test_key",
    }).recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context);

    expect(result).toEqual({
      ok: false,
      error: "Local mode requires a loopback or private-network address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const credentials = { apiKey: "sm_test_key" };
const privateResolver = async () => [{ address: "172.18.0.4", family: 4 as const }];
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("Supermemory local base URL", () => {
  it("accepts loopback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://127.0.0.1:6767" },
      credentials,
      { allowPrivateEndpoint: true },
    );

    expect(prepared.settings).toEqual({ mode: "local", baseUrl: "http://127.0.0.1:6767" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:6767/v3/container-tags/list");
  });

  it.each(["http://10.0.0.8:6767", "http://192.168.1.20:6767", "http://[fd00::1]:6767"])(
    "accepts private literal %s for the deployment owner",
    async (baseUrl) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const prepared = await prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials, {
        allowPrivateEndpoint: true,
      });

      expect(prepared.settings.baseUrl).toBe(baseUrl);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/v3/container-tags/list`);
    },
  );

  it("accepts a Compose service name that resolves to a private address", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("[]", { status: 200 }));
    const resolveHostname = vi.fn(privateResolver);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://supermemory:6767" },
      credentials,
      { allowPrivateEndpoint: true, resolveHostname, fetch: fetchMock },
    );

    expect(prepared.settings).toEqual({ mode: "local", baseUrl: "http://supermemory:6767" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://supermemory:6767/v3/container-tags/list",
    );
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("accepts Docker Desktop and private-suffix hosts that resolve privately", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("[]", { status: 200 }));

    await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://host.docker.internal:6767" },
      credentials,
      {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "192.168.65.254", family: 4 as const }],
        fetch: fetchMock,
      },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://host.docker.internal:6767/v3/container-tags/list",
    );
  });

  it.each(["http://example.com:6767", "https://memory.example.com"])(
    "rejects public host %s",
    async (baseUrl) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials, {
          allowPrivateEndpoint: true,
          resolveHostname: publicResolver,
        }),
      ).rejects.toThrow(/private-network/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a Compose name that resolves to a public address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://supermemory:6767" },
        credentials,
        { allowPrivateEndpoint: true, resolveHostname: publicResolver },
      ),
    ).rejects.toThrow(/private-network/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cloud metadata and link-local targets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://169.254.169.254/latest/meta-data/" },
        credentials,
        { allowPrivateEndpoint: true },
      ),
    ).rejects.toThrow(/blocked address/);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "https://nas.local:6767" },
        credentials,
        {
          allowPrivateEndpoint: true,
          resolveHostname: async () => [{ address: "169.254.170.2", family: 4 as const }],
        },
      ),
    ).rejects.toThrow(/blocked address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects private endpoints for a non-owner before DNS or probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolveHostname = vi.fn(privateResolver);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://10.0.0.8:6767" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderDeploymentOwnerRequiredError);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://supermemory:6767" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderDeploymentOwnerRequiredError);

    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Supermemory private host reuse", () => {
  function privateProvider(resolveHostname: ResolveHostname, fetchImpl: typeof globalThis.fetch) {
    return new SupermemoryMemoryProvider({
      baseUrl: "http://supermemory:6767",
      apiKey: "sm_test_key",
      resolveHostname,
      fetch: fetchImpl,
    });
  }

  it("resolves a private hostname once for multi-tag recall, save, and purge", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const resolveHostname = vi.fn(privateResolver);
    const memory = privateProvider(resolveHostname, fetchMock);

    await expect(
      memory.recall({ query: "project", scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveHostname).toHaveBeenCalledOnce();

    resolveHostname.mockRejectedValue(new Error("dns blip"));
    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toMatchObject({ ok: true });
    await memory.save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    await memory.purgeHistory({ botId: "bot-1", generations: [1] }, context);

    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("retries a private hostname after a failed lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolveHostname = vi
      .fn()
      .mockRejectedValueOnce(new Error("eai_again"))
      .mockResolvedValue([{ address: "172.18.0.4", family: 4 as const }]);
    const memory = privateProvider(resolveHostname, fetchMock);

    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toEqual({
      ok: false,
      error: "Local mode requires a loopback or private-network address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toMatchObject({ ok: true });
    expect(resolveHostname).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
