import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHttpClient } from "./http.js";

const clients: NativeHttpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
function transport(responses: Array<Response | Error>, readOnly = false) {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  const credential = vi.fn(async () => ({ kind: "bearer" as const, value: "fixture-access" }));
  const client = new NativeHttpClient("https://api.example.test", credential, {
    readOnly,
    signal: new AbortController().signal,
    network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
  });
  clients.push(client);
  return { client, fetch, credential };
}
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("native HTTP execution", () => {
  it.each([410, 403, 404])(
    "distinguishes expired cursors from access failure %s",
    async (status) => {
      const { client, fetch } = transport([json({ private_body: "not retained" }, status)], true);
      const error = await client
        .request({ method: "GET", path: "/calendar/v3/calendars/primary/events" })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ kind: "resource_unavailable" });
      expect(JSON.stringify(error)).not.toContain("not retained");
      expect(error).toMatchObject({
        kind: "resource_unavailable",
        options: { recovery: { status } },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("does not replay a write after an ambiguous network failure", async () => {
    const { client, fetch } = transport([new Error("fixture-access was lost")]);
    await expect(
      client.request({ method: "POST", path: "/v1/pages", body: {} }),
    ).rejects.toMatchObject({ kind: "result_unknown", options: { uncertain: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rechecks credentials before retrying a read", async () => {
    const { client, fetch, credential } = transport([json({}, 503), json({ id: "item" })], true);
    const result = await client.request({ method: "GET", path: "/v1/pages/item" });
    expect(result.body).toEqual({ id: "item" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(credential).toHaveBeenCalledTimes(2);
  });
  it("preserves committed identifiers without leaking response content", async () => {
    const { client, fetch } = transport([
      json(
        {
          code: "service_unavailable",
          message: "private text",
          access_token: "fixture-access",
          additional_data: {
            committed_resource_id: "page-1",
            committed_child_ids: ["block-1"],
            retry_guidance: ["Read the original resource"],
            private_value: "secret",
          },
        },
        503,
      ),
    ]);
    await expect(
      client.request({ method: "PATCH", path: "/v1/pages/page-1", body: {} }),
    ).rejects.toMatchObject({
      kind: "result_unknown",
      options: {
        uncertain: true,
        recovery: {
          status: 503,
          code: "service_unavailable",
          committed_resource_id: "page-1",
          committed_child_ids: ["block-1"],
          retry_guidance: ["verify_committed_resources"],
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"])(
    "classifies Google %s as a quota failure",
    async (reason) => {
      const { client } = transport([json({ error: { errors: [{ reason }] } }, 403)], true);
      await expect(
        client.request({ method: "GET", path: "/calendar/v3/calendars/primary" }),
      ).rejects.toMatchObject({ kind: "rate_limited" });
    },
  );
  it("does not sleep/retry beyond a long Retry-After", async () => {
    const { client, fetch } = transport([json({}, 429, { "retry-after": "3600" })], true);
    await expect(client.request({ method: "GET", path: "/v1/pages" })).rejects.toMatchObject({
      kind: "rate_limited",
      options: { retryAfterSeconds: 3600 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains 429 Retry-After when a gateway returns HTML", async () => {
    const { client, fetch } = transport(
      [
        new Response("<html>rate limited</html>", {
          status: 429,
          headers: { "retry-after": "3600" },
        }),
      ],
      true,
    );
    await expect(client.request({ method: "GET", path: "/v1/pages" })).rejects.toMatchObject({
      kind: "rate_limited",
      options: { retryAfterSeconds: 3600 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves Notion overload backoff without an automatic read retry", async () => {
    const { client, fetch } = transport([json({}, 529, { "retry-after": "3600" })], true);
    await expect(client.request({ method: "GET", path: "/v1/pages/page-a" })).rejects.toMatchObject(
      {
        kind: "temporarily_unavailable",
        options: { retryAfterSeconds: 3600, uncertain: false },
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps a timed-out write uncertain and does not replay it", async () => {
    const { client, fetch } = transport([json({}, 408)]);
    await expect(
      client.request({ method: "POST", path: "/v1/pages", body: {} }),
    ).rejects.toMatchObject({ kind: "result_unknown", options: { uncertain: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("revalidates a rotated credential only after an explicit unauthorized response", async () => {
    let rotated = false;
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      rotated ? json({ id: "page-a" }) : json({}, 401),
    );
    const onUnauthorized = vi.fn(async () => {
      rotated = true;
    });
    const client = new NativeHttpClient(
      "https://api.example.test",
      async () => ({ kind: "bearer", value: rotated ? "second-access" : "first-access" }),
      {
        readOnly: false,
        signal: new AbortController().signal,
        onUnauthorized,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    clients.push(client);
    await expect(
      client.request({ method: "POST", path: "/v1/pages", body: {} }),
    ).resolves.toMatchObject({
      body: { id: "page-a" },
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("authorization")),
    ).toEqual(["Bearer first-access", "Bearer second-access"]);
  });
  it("cancels a hung DNS resolution before any credential reaches fetch", async () => {
    const abort = new AbortController();
    const fetch = vi.fn();
    const client = new NativeHttpClient(
      "https://api.example.test",
      async () => ({ kind: "bearer", value: "fixture-access" }),
      {
        signal: abort.signal,
        readOnly: false,
        network: { fetch, resolveHostname: async () => new Promise(() => {}) },
      },
    );
    clients.push(client);
    const request = client.request({ method: "POST", path: "/v1/pages", body: {} });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await expect(request).rejects.toMatchObject({
      kind: "result_unknown",
      options: { uncertain: true },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves FormData and lets fetch generate its boundary", async () => {
    const { client, fetch } = transport([json({ id: "upload-1" })]);
    const form = new FormData();
    form.set("file", new Blob(["fixture"]), "test.txt");
    await client.request({ method: "POST", path: "/v1/file_uploads/upload-1/send", body: form });
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBe(form);
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access");
  });
  it.each(["//evil.example.test", "/../outside", "/v1/test?token=x", "/v1/\\evil", "/v1/test\n"])(
    "rejects malformed path %s",
    async (path) => {
      const { client, fetch } = transport([]);
      // A root authority allows /../ normalization back into root. Only the URL
      // syntax matters there; a prefixed authority must reject traversal too.
      const prefixed = new NativeHttpClient(
        "https://api.example.test/base",
        async () => ({ kind: "bearer", value: "fake" }),
        {
          readOnly: false,
          signal: new AbortController().signal,
          network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        },
      );
      clients.push(prefixed);
      await expect(prefixed.request({ method: "GET", path })).rejects.toMatchObject({
        kind: "invalid_input",
      });
      expect(fetch).not.toHaveBeenCalled();
      void client;
    },
  );
  it.each(["Authorization", "X-API-Key", "Cookie", "Host", "Content-Length", "Connection"])(
    "rejects action-supplied %s",
    async (name) => {
      const { client, fetch } = transport([]);
      await expect(
        client.request({ method: "GET", path: "/v1/test", headers: { [name]: "fake" } }),
      ).rejects.toMatchObject({ kind: "invalid_input" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("does not claim an incomplete write response succeeded", async () => {
    const { client, fetch } = transport([new Response("{broken", { status: 200 })]);
    await expect(
      client.request({ method: "POST", path: "/v1/pages", body: {} }),
    ).rejects.toMatchObject({ kind: "incomplete_response", options: { uncertain: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
