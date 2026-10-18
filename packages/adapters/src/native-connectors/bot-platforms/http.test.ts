import assert from "node:assert/strict";
import { it as test, vi } from "vitest";
import { NativeHttpClient } from "../http.js";
import { botPlatformApps } from "./index.js";
import { BOT_PLATFORM_METADATA } from "./metadata.js";
import { context, type Fixture, failure, suites } from "./testing.js";

for (const app of botPlatformApps) {
  for (const f of suites[app.slug].fixtures as Fixture[]) {
    test(`${f.id}: real fixed-authority HTTP credential/body composition`, async () => {
      let i = 0;
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const step = f.steps[i++]!;
        assert.ok(step);
        const url = new URL(String(input));
        const base = BOT_PLATFORM_METADATA[app.slug].baseUrl;
        assert.equal(
          url.origin + url.pathname,
          base +
            (app.slug === "telegram-bot" ? "/bot100001:fixture-token" : "") +
            step.request.path,
        );
        assert.equal(init?.method, step.request.method);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          app.slug === "discord" ? "Bot fixture-token" : null,
        );
        for (const [k, v] of Object.entries(step.request.query ?? {}))
          assert.equal(url.searchParams.get(k), String(v));
        if (step.request.multipart) assert.ok(init?.body instanceof FormData);
        else if (step.request.body !== undefined)
          assert.deepEqual(JSON.parse(String(init?.body)), step.request.body);
        else assert.equal(init?.body, undefined);
        return new Response(
          step.response.status === 204 ? null : JSON.stringify(step.response.body),
          { status: step.response.status, headers: { "content-type": "application/json" } },
        );
      });
      const action = app.actions.find((a) => a.id === f.id)!;
      const client = new NativeHttpClient(
        BOT_PLATFORM_METADATA[app.slug].baseUrl,
        async () =>
          app.slug === "telegram-bot"
            ? { kind: "telegram_bot", value: "100001:fixture-token" }
            : { kind: "raw", value: "Bot fixture-token" },
        {
          readOnly: action.readOnly,
          signal: new AbortController().signal,
          network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        },
      );
      try {
        await action.execute(
          f.input,
          context(app.slug, (r) => client.request(r)),
        );
        assert.equal(i, f.steps.length);
      } finally {
        await client.close();
      }
    });
  }
  for (const [status, kind] of [
    [401, "authorization_expired"],
    [403, "resource_unavailable"],
    [404, "resource_unavailable"],
    [429, "rate_limited"],
    [503, "temporarily_unavailable"],
  ] as const)
    test(`${app.slug}: real HTTP read failure ${status} retains error semantics`, async () => {
      const fetch = vi.fn(
        async () =>
          new Response("{}", {
            status,
            headers: { "content-type": "application/json", "retry-after": "30" },
          }),
      );
      const client = new NativeHttpClient(
        BOT_PLATFORM_METADATA[app.slug].baseUrl,
        async () =>
          app.slug === "telegram-bot"
            ? { kind: "telegram_bot", value: "100001:fixture-token" }
            : { kind: "raw", value: "Bot fixture-token" },
        {
          readOnly: true,
          signal: new AbortController().signal,
          network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        },
      );
      try {
        await assert.rejects(
          client.request({ method: "GET", path: app.slug === "discord" ? "/users/@me" : "/getMe" }),
          failure(kind),
        );
        assert.ok(fetch.mock.calls.length <= 2);
      } finally {
        await client.close();
      }
    });
}
