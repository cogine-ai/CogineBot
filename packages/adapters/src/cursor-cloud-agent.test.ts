import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  CloudAgentRequestRejected,
  CloudAgentRetryLater,
  CloudAgentUnavailable,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { CursorCloudAgentProvider, cursorAgentId } from "./cursor-cloud-agent.js";
import { CursorCloudAgentEmulator } from "./testing/cursor-cloud-agent-emulator.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};
const wireAgent = { id: "test-agent", status: "ACTIVE", latestRunId: "prior-run" };

describe("Cursor HTTP boundary", () => {
  it("keeps a duplicate create recoverable when the accepted agent is not yet readable", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (_url, init) =>
        new Response(null, { status: init?.method === "POST" ? 409 : 404 }),
    });
    const error = await provider
      .launch({ idempotencyKey: "operation", prompt: "Task" }, context)
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
    expect(error).not.toBeInstanceOf(CloudAgentUnavailable);
  });
  it("keeps a duplicate create unresolved when the agent already has multiple runs", async () => {
    const request = { prompt: "Synthetic launch", idempotencyKey: "duplicate-create-many" };
    const id = cursorAgentId(request.idempotencyKey);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ...wireAgent, id }))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            { id: "other-run", status: "RUNNING" },
            { id: "initial-run", status: "FINISHED" },
          ],
        }),
      );
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.launch(request, context)).rejects.toThrow("awaiting reconciliation");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("/runs?limit=2");
  });

  it("preserves throttling after a duplicate create without calling the original create rejected", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (_url, init) =>
        init?.method === "POST"
          ? new Response(null, { status: 409 })
          : new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    });
    await expect(
      provider.launch({ idempotencyKey: "operation", prompt: "Task" }, context),
    ).rejects.toMatchObject({
      name: "CloudAgentRetryLater",
      reason: "rate_limit",
      retryAfterMs: 120_000,
      requestRejected: false,
    });
  });
  it("sends the documented create shape with a stable client agent ID", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const result = await provider.launch(
      {
        idempotencyKey: "operation",
        prompt: "Task",
        repository: "https://github.com/example/demo",
        openPr: false,
        images: [{ data: "ZmFrZQ==", mimeType: "image/png" }],
      },
      context,
    );
    expect(wire.requests[0]).toEqual({
      method: "POST",
      path: "/v1/agents",
      body: {
        agentId: result.id,
        prompt: { text: "Task", images: [{ data: "ZmFrZQ==", mimeType: "image/png" }] },
        repos: [{ url: "https://github.com/example/demo" }],
        autoCreatePR: false,
      },
    });
    expect(result.id).toMatch(
      /^bc-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });
  it.each([400, 401, 403, 404, 422, 429, 500, 503])(
    "never exposes a %s response body",
    async (status) => {
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async () => new Response("fake-key and fake-secret", { status }),
      });
      const error = await provider.get("test-agent", context).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/fake-key|fake-secret/);
    },
  );
  it("rejects malformed and oversized response bodies", async () => {
    for (const body of ['{"bad":true}', "invalid fake-secret", " ".repeat(1_000_001)]) {
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async () => new Response(body),
      });
      await expect(provider.get("test-agent", context)).rejects.toThrow();
    }
  });
  it("bounds hanging body reads even if stream cancellation never settles", async () => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      timeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
        ),
    });
    await expect(provider.get("test-agent", context)).rejects.toThrow();
  });
  it("can prove a cancelled launch was never sent before calling fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(
      provider.launch(
        { prompt: "Synthetic launch", idempotencyKey: "cancelled-before-fetch" },
        { ...context, signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({
      name: "CloudAgentRetryLater",
      reason: "unavailable",
      requestRejected: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a fixed credential origin and rejects redirects", async () => {
    let redirect: RequestRedirect | undefined;
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (url, init) => {
        expect(String(url).startsWith("https://api.cursor.com/v1/agents/")).toBe(true);
        redirect = init?.redirect;
        return new Response(null, { status: 302 });
      },
    });
    await expect(provider.get("test-agent", context)).rejects.toThrow();
    expect(redirect).toBe("error");
  });
  it("does not turn a successful follow-up into failure by fetching metadata afterward", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const agent = await provider.launch({ idempotencyKey: "follow-up", prompt: "Task" }, context);
    wire.complete(agent.id);
    wire.requests.length = 0;
    await provider.reply(agent.id, { prompt: "Tests" }, context);
    expect(wire.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  });

  it("reads the newest run from the list and keeps explicit reads pinned", async () => {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const initial = await provider.launch({ idempotencyKey: "list", prompt: "Task" }, context);
    wire.complete(initial.id);
    wire.staleLatestRunId = initial.latestRunId;
    const next = await provider.reply(initial.id, { prompt: "Tests" }, context);

    expect(await provider.get(initial.id, context)).toMatchObject({
      latestRunId: next.latestRunId,
      status: "running",
    });
    expect(await provider.get(initial.id, context, initial.latestRunId)).toMatchObject({
      latestRunId: initial.latestRunId,
      status: "finished",
    });
    await expect(
      provider.observeRunSuccessor(initial.id, initial.latestRunId!, context),
    ).resolves.toBe(next.latestRunId);
  });

  it.each([
    { ids: [], latestRunId: "new-run" },
    { ids: ["prior-run"], latestRunId: "new-run" },
    { ids: ["older-run", "oldest-run"], latestRunId: "new-run" },
    { ids: ["prior-run", "prior-run"], latestRunId: "new-run" },
    { ids: ["new-run"], latestRunId: "new-run" },
  ])("observes no successor without a preceding anchor: $ids", async ({ ids, latestRunId }) => {
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (url) => {
        const request = new URL(String(url));
        if (request.pathname.endsWith("/runs")) {
          expect(request.searchParams.get("limit")).toBe("2");
          return Response.json({ items: ids.map((id) => ({ id, status: "FINISHED" })) });
        }
        return Response.json({ ...wireAgent, latestRunId });
      },
    });
    await expect(
      provider.observeRunSuccessor(wireAgent.id, "prior-run", context),
    ).resolves.toBeNull();
  });

  it("observes an expired chronological successor without settling the follow-up", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            { id: "new-run", agentId: wireAgent.id, status: "EXPIRED" },
            { id: "prior-run", agentId: wireAgent.id, status: "FINISHED" },
          ],
        }),
      );
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.observeRunSuccessor(wireAgent.id, "prior-run", context)).resolves.toBe(
      "new-run",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["not_found", "expired"] as const)(
    "checks remote availability when the legacy follow-up has no run anchor (%s)",
    async (reason) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          reason === "not_found"
            ? new Response(null, { status: 404 })
            : Response.json({ ...wireAgent, status: "ARCHIVED" }),
        );
      const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
      await expect(provider.observeRunSuccessor(wireAgent.id, null, context)).rejects.toMatchObject(
        {
          name: "CloudAgentUnavailable",
          reason,
        },
      );
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        `https://api.cursor.com/v1/agents/${wireAgent.id}`,
        expect.objectContaining({ method: "GET" }),
      );
    },
  );

  it("keeps an unknown status running and treats expired work as permanent", async () => {
    let status = "FUTURE_STATUS";
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (url) =>
        Response.json(
          String(url).endsWith("/runs/prior-run") ? { id: "prior-run", status } : wireAgent,
        ),
    });
    expect(await provider.get(wireAgent.id, context, "prior-run")).toMatchObject({
      status: "running",
    });
    status = "EXPIRED";
    await expect(provider.get(wireAgent.id, context, "prior-run")).rejects.toMatchObject({
      name: "CloudAgentUnavailable",
      reason: "expired",
    });
  });

  it("refuses an archived agent before sending any follow-up", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ...wireAgent, status: "ARCHIVED" }),
    );
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.reply(wireAgent.id, { prompt: "Tests" }, context)).rejects.toMatchObject({
      name: "CloudAgentUnavailable",
      reason: "expired",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each([
    { status: 401, reason: "credential", retryAfter: null, delay: undefined },
    { status: 403, reason: "credential", retryAfter: null, delay: undefined },
    { status: 429, reason: "rate_limit", retryAfter: "120", delay: 120_000 },
    {
      status: 429,
      reason: "rate_limit",
      retryAfter: "Wed, 21 Oct 2026 07:30:00 GMT",
      delay: 120_000,
    },
    { status: 429, reason: "rate_limit", retryAfter: "unknown", delay: undefined },
  ])(
    "keeps a definitive $status follow-up refusal retryable",
    async ({ status, reason, retryAfter, delay }) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T07:28:00Z"));
      const provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async (_url, init) =>
          init?.method === "GET"
            ? Response.json(wireAgent)
            : new Response("fake-key", {
                status,
                headers: retryAfter ? { "Retry-After": retryAfter } : {},
              }),
      });
      try {
        await expect(
          provider.reply(wireAgent.id, { prompt: "Tests" }, context),
        ).rejects.toMatchObject({
          name: "CloudAgentRetryLater",
          reason,
          requestRejected: true,
          retryAfterMs: delay,
        });
      } finally {
        now.mockRestore();
      }
    },
  );

  it("classifies pre-send failures separately from ambiguous follow-up responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("fake-key"));
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.reply(wireAgent.id, { prompt: "Tests" }, context)).rejects.toMatchObject({
      name: "CloudAgentRetryLater",
      reason: "unavailable",
      requestRejected: true,
    });
    expect(fetch).toHaveBeenCalledOnce();

    for (const failure of [
      async () => new Response("fake-key", { status: 409 }),
      async () => Response.json({ unexpected: "fake-key" }),
      async () => {
        throw new Error("fake-key");
      },
    ]) {
      fetch.mockResolvedValueOnce(Response.json(wireAgent)).mockImplementationOnce(failure);
      const error = await provider
        .reply(wireAgent.id, { prompt: "Tests" }, context)
        .catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CloudAgentRetryLater);
      expect(error).not.toBeInstanceOf(CloudAgentRequestRejected);
      expect(error).not.toBeInstanceOf(CloudAgentUnavailable);
      expect(String(error)).not.toContain("fake-key");
    }
  });

  it("treats a missing exact run as permanent and rejects an unrelated receipt", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(new Response("fake-key", { status: 404 }))
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(Response.json({ id: "other-run", status: "FINISHED" }));
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.get(wireAgent.id, context, "prior-run")).rejects.toMatchObject({
      name: "CloudAgentUnavailable",
      reason: "not_found",
    });
    await expect(provider.get(wireAgent.id, context, "prior-run")).rejects.toThrow(
      "Invalid cloud agent run response",
    );
  });

  it("treats a machine-readable busy conflict as a proven follow-up refusal", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(
        Response.json({ error: { code: "agent_busy", message: "fake-key" } }, { status: 409 }),
      );
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    const error = await provider.reply(wireAgent.id, { prompt: "Tests" }, context).catch((e) => e);
    expect(error).toMatchObject({
      name: "CloudAgentRetryLater",
      reason: "unavailable",
      requestRejected: true,
    });
    expect(String(error)).not.toContain("fake-key");
  });

  it("does not observe a successor explicitly attributed to a different agent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            { id: "foreign-run", agentId: "different-agent", status: "RUNNING" },
            { id: "prior-run", agentId: wireAgent.id, status: "FINISHED" },
          ],
        }),
      );
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.observeRunSuccessor(wireAgent.id, "prior-run", context)).rejects.toThrow(
      "Invalid cloud agent run response",
    );
  });

  it("does not settle a run as expired based on a foreign agent's receipt", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(
        Response.json({ id: "prior-run", agentId: "different-agent", status: "EXPIRED" }),
      );
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    await expect(provider.get(wireAgent.id, context, "prior-run")).rejects.toThrow(
      "Invalid cloud agent response",
    );
  });

  it("observes the exact run after a cancellation conflict", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(Response.json({ id: "prior-run", status: "RUNNING" }))
      .mockResolvedValueOnce(new Response("fake-key", { status: 409 }))
      .mockResolvedValueOnce(Response.json(wireAgent))
      .mockResolvedValueOnce(Response.json({ id: "prior-run", status: "FINISHED" }));
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch });
    expect(await provider.cancel(wireAgent.id, context, "prior-run")).toMatchObject({
      latestRunId: "prior-run",
      status: "finished",
    });
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("/runs/prior-run");
  });

  it.each([
    { apiKey: "fake-key", linkKey: "fake-key" },
    { apiKey: "fake-key", linkKey: "%66ake%2Dkey" },
    { apiKey: "fake%2Dkey", linkKey: "fake%2Dkey" },
  ])(
    "drops credentials echoed in public response metadata ($linkKey)",
    async ({ apiKey, linkKey }) => {
      const provider = new CursorCloudAgentProvider({
        apiKey,
        fetch: async (url) =>
          Response.json(
            String(url).endsWith("/runs/prior-run")
              ? {
                  id: "prior-run",
                  status: "FINISHED",
                  git: {
                    branches: [{ branch: apiKey, prUrl: `https://example.test/${linkKey}` }],
                  },
                }
              : { ...wireAgent, name: apiKey, url: `https://example.test/${linkKey}` },
          ),
      });
      expect(await provider.get(wireAgent.id, context, "prior-run")).toEqual({
        id: wireAgent.id,
        latestRunId: "prior-run",
        status: "finished",
        title: "Cloud agent",
        url: "https://cursor.com/agents/test-agent",
      });
    },
  );
});
