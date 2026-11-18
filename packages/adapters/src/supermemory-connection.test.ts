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

describe("semantic connection checks", () => {
  it("checks readability without claiming cleanup authority or touching another namespace", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "GET"
        ? new Response("[]", { status: 200 })
        : new Response("", { status: 403 }),
    );
    await expect(
      prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch }),
    ).resolves.toMatchObject({ settings: { mode: "cloud" } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${SUPERMEMORY_CLOUD_BASE_URL}/v3/container-tags/list`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects a rejected read probe without issuing a write or delete", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 401 }));
    await expect(
      prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch }),
    ).rejects.toThrow(/401/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains the accepted DNS pin during the read check", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("[]", { status: 200 }));
    const resolveHostname = vi.fn(async () => [{ address: "172.18.0.4", family: 4 as const }]);
    await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://memory-service:6767" },
      credentials,
      { fetch, resolveHostname, allowPrivateEndpoint: true },
    );
    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });

  it("rejects the Cloud origin in local mode before DNS or HTTP", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("[]", { status: 200 }));
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

it("enforces permission at the actual Bot history namespace", async () => {
  const allowedTag = "rakazo:bot-one:history:1";
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (init?.method === "GET") return new Response("[]", { status: 200 });
    const tag = decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!);
    return tag === allowedTag
      ? Response.json({
          success: true,
          containerTag: tag,
          deletedDocumentsCount: 0,
          deletedMemoriesCount: 0,
        })
      : new Response("", { status: 403 });
  });
  await prepareSupermemoryConnection({ mode: "cloud" }, credentials, { fetch });
  const provider = new SupermemoryMemoryProvider({
    baseUrl: SUPERMEMORY_CLOUD_BASE_URL,
    ...credentials,
    fetch,
  });
  await expect(
    provider.purgeHistory({ botId: "bot-one", generations: [1] }, context),
  ).resolves.toEqual({ ok: true, value: undefined });
  await expect(
    provider.purgeHistory({ botId: "another-bot", generations: [1] }, context),
  ).resolves.toEqual({ ok: false, error: SUPERMEMORY_DELETE_FORBIDDEN_ERROR });
  expect(
    fetch.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!)),
  ).toEqual([allowedTag, "rakazo:another-bot:history:1"]);
});

it.each(["route missing", "container missing"])(
  "does not claim cleanup for an unconfirmed 404 (%s)",
  async (error) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error }, { status: 404 }),
    );
    const provider = new SupermemoryMemoryProvider({
      baseUrl: SUPERMEMORY_CLOUD_BASE_URL,
      ...credentials,
      fetch,
    });
    await expect(
      provider.purgeHistory({ botId: "bot-one", generations: [1] }, context),
    ).resolves.toEqual({ ok: false, error: expect.stringContaining("404") });
  },
);

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
    ).resolves.toMatchObject({ ok: status === 200 });
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
