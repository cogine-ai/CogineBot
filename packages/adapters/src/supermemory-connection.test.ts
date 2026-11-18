import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSupermemoryContainer,
  probeSupermemory,
  SUPERMEMORY_CLOUD_BASE_URL,
  SUPERMEMORY_DELETE_FORBIDDEN_ERROR,
  saveSupermemoryMemory,
  searchSupermemory,
} from "./supermemory-client.js";
import {
  prepareSupermemoryConnection,
  SupermemoryMemoryProvider,
} from "./supermemory-memory-provider.js";

const credentials = { apiKey: "synthetic-memory-key" };
const context: AdapterContext = {
  operationId: "connection-operation",
  traceId: "connection-trace",
  spaceId: "space-one",
  userId: "user-one",
  botId: "bot-one",
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

function probeTransport(status: number) {
  return vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === "GET" ? new Response("[]", { status: 200 }) : new Response("", { status }),
  );
}

describe("semantic connection checks", () => {
  it("checks delete authority using fresh probe tags without business data", async () => {
    const fetch = probeTransport(404);
    await prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch });
    await prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "DELETE",
      "GET",
      "DELETE",
    ]);
    const tags = fetch.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!));
    expect(tags).toHaveLength(2);
    expect(new Set(tags).size).toBe(2);
    for (const tag of tags) expect(tag).toMatch(/^cogine:delete-probe:[0-9a-f-]{36}$/);
  });

  it.each([200, 404])("accepts the fresh-tag delete status %s", async (status) => {
    const fetch = probeTransport(status);
    await expect(
      prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch }),
    ).resolves.toMatchObject({ settings: { mode: "cloud" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 500])("refuses a connection whose delete check returns %s", async (status) => {
    const fetch = probeTransport(status);
    await expect(
      prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch }),
    ).rejects.toThrow(status === 403 ? SUPERMEMORY_DELETE_FORBIDDEN_ERROR : /500/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never tries deletion after a rejected read probe", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 401 }));
    await expect(
      prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch }),
    ).rejects.toThrow(/401/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the same accepted DNS pin for both connection probes", async () => {
    const fetch = probeTransport(404);
    const resolveHostname = vi.fn(async () => [{ address: "172.18.0.4", family: 4 as const }]);
    await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://memory-service:6767" },
      credentials,
      { fetch, resolveHostname, allowPrivateEndpoint: true },
    );
    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
  });

  it("rejects the Cloud origin in local mode before DNS or HTTP", async () => {
    const fetch = probeTransport(404);
    const resolveHostname = vi.fn(async () => [{ address: "172.18.0.4", family: 4 as const }]);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: SUPERMEMORY_CLOUD_BASE_URL },
        credentials,
        { fetch, resolveHostname, allowPrivateEndpoint: true },
      ),
    ).rejects.toThrow(/Cloud URL/);
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("empty semantic queries", () => {
  it.each([
    ["cloud", ""],
    ["cloud", " \n\t "],
    ["local", ""],
    ["local", " \n\t "],
  ])("returns no facts without DNS or HTTP for %s query %j", async (mode, query) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"results":[]}'));
    const resolveHostname = vi.fn(async () => [{ address: "172.18.0.4", family: 4 as const }]);
    const provider = new SupermemoryMemoryProvider({
      baseUrl: mode === "cloud" ? SUPERMEMORY_CLOUD_BASE_URL : "http://memory-service:6767",
      ...credentials,
      fetch,
      resolveHostname,
    });
    await expect(
      provider.recall({ query: query!, scope: "shared", botId: "bot-one", limit: 5 }, context),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each([200, 404, 403, 500])(
  "releases the unread delete response for status %s",
  async (status) => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(new ReadableStream({ cancel }), { status }),
    );
    await expect(
      deleteSupermemoryContainer("synthetic-container", {
        baseUrl: SUPERMEMORY_CLOUD_BASE_URL,
        ...credentials,
        fetch,
      }),
    ).resolves.toMatchObject({ ok: status === 200 || status === 404 });
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it.each(["probe", "delete", "search", "save"] as const)(
  "keeps native header errors useful without reflecting credentials for %s",
  async (operation) => {
    const apiKey = "synthetic-key-with\nnewline";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      new Headers(init?.headers);
      throw new Error("Expected native header validation to reject this fixture");
    });
    const connection = { baseUrl: SUPERMEMORY_CLOUD_BASE_URL, apiKey, fetch };
    const result = await (operation === "probe"
      ? probeSupermemory(connection)
      : operation === "delete"
        ? deleteSupermemoryContainer("synthetic-container", connection)
        : operation === "search"
          ? searchSupermemory("synthetic query", "synthetic-container", connection)
          : saveSupermemoryMemory("synthetic fact", "synthetic-container", connection));
    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("unreachable") });
    expect(JSON.stringify(result)).toContain("invalid header value");
    expect(JSON.stringify(result)).not.toContain("synthetic-key-with");
    expect(JSON.stringify(result)).not.toContain("newline");
  },
);
