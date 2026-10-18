import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type { NativeAction } from "./action.js";
import { NativeActionError } from "./action.js";
import { context } from "./collaboration-conformance.js";
import { githubActions } from "./github.js";
import { NativeHttpClient } from "./http.js";
import { linearActions } from "./linear.js";

const clients: NativeHttpClient[] = [];
const now = Date.parse("2026-10-18T00:00:00.000Z");
const secret = "fixture-private-response-and-token";
const linearRate = {
  errors: [{ message: secret, extensions: { code: "RATELIMITED" } }],
};
const secondaryMessage =
  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

function transport(
  base: string,
  readOnly: boolean,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const fetch = vi.fn(async () => {
    assert.equal(fetch.mock.calls.length, 1, "a rejected request must not be replayed");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  });
  const client = new NativeHttpClient(base, async () => ({ kind: "bearer", value: secret }), {
    readOnly,
    signal: new AbortController().signal,
    network: {
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    },
  });
  clients.push(client);
  return { client, fetch };
}

async function rejection(work: Promise<unknown>, kind: string, retry?: number, uncertain = false) {
  let captured: NativeActionError | undefined;
  await assert.rejects(work, (error) => {
    assert.ok(error instanceof NativeActionError);
    captured = error;
    assert.equal(error.kind, kind);
    assert.equal(error.options.retryAfterSeconds, retry);
    assert.equal(error.options.uncertain ?? false, uncertain);
    assert.ok(!JSON.stringify({ message: error.message, options: error.options }).includes(secret));
    return true;
  });
  return captured!;
}

async function throughAction(
  app: "linear" | "github",
  action: NativeAction,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const { client, fetch } = transport(
    app === "linear" ? "https://api.linear.app" : "https://api.github.com",
    action.readOnly,
    status,
    body,
    headers,
  );
  const checkpoints: Record<string, unknown>[] = [];
  const input =
    app === "linear"
      ? action.readOnly
        ? {}
        : { teamId: "22222222-2222-4222-8222-222222222222", title: "Fixture issue" }
      : {
          owner: "fixture-owner",
          repo: "fixture-repo",
          ...(!action.readOnly ? { title: "Fixture issue" } : {}),
        };
  const work = action.execute(
    input,
    context(app, (request) => client.request(request), {
      checkpoint: async (receipt) => {
        checkpoints.push(structuredClone(receipt));
      },
    }),
  );
  return { work, fetch, checkpoints };
}

for (const readOnly of [true, false]) {
  const mode = readOnly ? "read" : "write";
  const linear = linearActions.find(
    (action) => action.id === `linear.issues.${readOnly ? "list" : "create"}`,
  )!;
  const github = githubActions.find(
    (action) => action.id === `github.issues.${readOnly ? "list" : "create"}`,
  )!;

  it(`Linear HTTP 400 RATELIMITED reaches the real ${mode} handler with one dispatch`, async () => {
    const { work, fetch, checkpoints } = await throughAction("linear", linear, 400, linearRate, {
      "retry-after": "17",
    });
    await rejection(work, "rate_limited", 17);
    assert.equal(fetch.mock.calls.length, 1);
    assert.equal(checkpoints.length, readOnly ? 0 : 1);
    if (!readOnly) assert.equal(checkpoints[0]?.dispatch_state, "in_flight");
  });

  it(`Linear HTTP 200 RATELIMITED retains its existing ${mode} outcome`, async () => {
    const { work, fetch, checkpoints } = await throughAction("linear", linear, 200, linearRate);
    await rejection(work, readOnly ? "rate_limited" : "result_unknown", undefined, !readOnly);
    assert.equal(fetch.mock.calls.length, 1);
    assert.equal(checkpoints.length, readOnly ? 0 : 1);
  });

  for (const [name, headers, body, expectedRetry] of [
    [
      "primary",
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 120) },
      { message: secret },
      120,
    ],
    [
      "secondary header",
      { "retry-after": "60" },
      { message: secondaryMessage, private: secret },
      60,
    ],
    ["secondary short header", { "retry-after": "1" }, { message: secret }, 1],
    ["secondary body", {}, { message: secondaryMessage, private: secret }, 60],
    ["429 control", { "retry-after": "60" }, { message: secret }, 60],
  ] as const) {
    it(`GitHub ${name} reaches the real ${mode} handler with one dispatch`, async () => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const { work, fetch, checkpoints } = await throughAction(
        "github",
        github,
        name === "429 control" ? 429 : 403,
        body,
        headers,
      );
      await rejection(work, "rate_limited", expectedRetry);
      assert.equal(fetch.mock.calls.length, 1);
      assert.equal(checkpoints.length, readOnly ? 0 : 1);
      if (!readOnly) assert.equal(checkpoints[0]?.dispatch_state, "in_flight");
    });
  }

  it(`GitHub ordinary permission 403 retains its ${mode} outcome`, async () => {
    const { work, fetch } = await throughAction("github", github, 403, {
      message: "Resource not accessible by personal access token",
      private: secret,
    });
    await rejection(work, "resource_unavailable");
    assert.equal(fetch.mock.calls.length, 1);
  });
}

describe("provider-scoped error evidence", () => {
  for (const base of [
    "https://api.example.test",
    "https://api.linear.app.evil.test",
    "http://api.linear.app",
    "https://api.linear.app:8443",
  ]) {
    it(`Linear rate code does not classify another authority ${base}`, async () => {
      const { client, fetch } = transport(base, false, 400, linearRate);
      const blocked = base.startsWith("http:");
      await rejection(
        client.request({ method: "POST", path: "/graphql", body: {} }),
        blocked ? "result_unknown" : "invalid_input",
        undefined,
        blocked,
      );
      assert.equal(fetch.mock.calls.length, blocked ? 0 : 1);
    });
  }
  it("Linear rate code is limited to the GraphQL API path", async () => {
    const { client } = transport("https://api.linear.app", false, 400, linearRate);
    await rejection(client.request({ method: "POST", path: "/other", body: {} }), "invalid_input");
  });
  for (const body of [
    { message: "RATELIMITED", private: secret },
    { errors: [{ message: "Rate limit exceeded", extensions: { code: "BAD_USER_INPUT" } }] },
    { errors: [{ extensions: { code: "RATE_LIMITED" } }] },
    { errors: [{ extensions: { code: "ratelimited" } }] },
    { errors: { extensions: { code: "RATELIMITED" } } },
    { data: { errors: [{ extensions: { code: "RATELIMITED" } }] } },
    { errors: [] },
    `${secret}: RATELIMITED`,
  ]) {
    it(`Linear unrelated 400 is not a rate limit: ${JSON.stringify(body)}`, async () => {
      const { client } = transport("https://api.linear.app", false, 400, body);
      await rejection(
        client.request({ method: "POST", path: "/graphql", body: {} }),
        "invalid_input",
      );
    });
  }
  it("Linear partial successful mutation receipt remains uncertain and never replays", async () => {
    const { work, fetch, checkpoints } = await throughAction(
      "linear",
      linearActions.find((action) => action.id === "linear.issues.create")!,
      200,
      {
        data: {
          issueCreate: { success: true, issue: { id: "11111111-1111-4111-8111-111111111111" } },
        },
        ...linearRate,
      },
    );
    await rejection(work, "result_unknown", undefined, true);
    assert.equal(fetch.mock.calls.length, 1);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.dispatch_state, "in_flight");
  });
  for (const base of [
    "https://api.example.test",
    "https://api.github.com.evil.test",
    "http://api.github.com",
    "https://api.github.com:8443",
  ]) {
    it(`GitHub headers and body cannot classify another authority ${base}`, async () => {
      const { client, fetch } = transport(
        base,
        false,
        403,
        { message: secondaryMessage, private: secret },
        { "x-ratelimit-remaining": "0", "retry-after": "60" },
      );
      const blocked = base.startsWith("http:");
      await rejection(
        client.request({
          method: "POST",
          path: "/repos/fixture-owner/fixture-repo/issues",
          body: {},
        }),
        blocked ? "result_unknown" : "resource_unavailable",
        undefined,
        blocked,
      );
      assert.equal(fetch.mock.calls.length, blocked ? 0 : 1);
    });
  }
  for (const [body, headers] of [
    [{ message: "Resource not accessible by integration", private: secret }, {}],
    [{ message: "API rate limit exceeded", private: secret }, { "x-ratelimit-remaining": "1" }],
    [{ message: `Permission denied. ${secondaryMessage}` }, {}],
    [{ message: "secondary rate limit" }, {}],
    [
      {
        documentation_url:
          "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
      },
      {},
    ],
    [{ message: { text: secondaryMessage } }, {}],
    [{ message: secret }, { "x-ratelimit-remaining": "-1", "retry-after": "invalid" }],
    [{ message: secret }, { "retry-after": "-1" }],
    [{ message: secret }, { "retry-after": "1.5" }],
    [{ message: secret }, { "retry-after": "1e2" }],
    [{ message: secret }, { "retry-after": "99999999999999999999999999" }],
  ] as const) {
    it(`GitHub ordinary 403 cannot match a vague body or invalid header: ${JSON.stringify([body, headers])}`, async () => {
      const { client } = transport("https://api.github.com", false, 403, body, headers);
      await rejection(
        client.request({
          method: "POST",
          path: "/repos/fixture-owner/fixture-repo/issues",
          body: {},
        }),
        "resource_unavailable",
      );
    });
  }
  it("GitHub primary headers classify a non-JSON response without exposing it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { client } = transport("https://api.github.com", false, 403, `<html>${secret}</html>`, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(now / 1000 + 23),
    });
    await rejection(
      client.request({
        method: "POST",
        path: "/repos/fixture-owner/fixture-repo/issues",
        body: {},
      }),
      "rate_limited",
      23,
    );
  });
  it("GitHub primary reset and Retry-After preserve the longer wait", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { client } = transport(
      "https://api.github.com",
      false,
      403,
      { message: secret },
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(now / 1000 + 120),
        "retry-after": "90",
      },
    );
    await rejection(
      client.request({
        method: "POST",
        path: "/repos/fixture-owner/fixture-repo/issues",
        body: {},
      }),
      "rate_limited",
      120,
    );
  });
  for (const value of ["not-a-date", "Infinity", "-1", "1.5", "99999999999999999999999999"]) {
    it(`GitHub malformed epoch reset is not passed to recovery: ${value}`, async () => {
      const { client } = transport(
        "https://api.github.com",
        false,
        403,
        { message: secret },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": value },
      );
      await rejection(
        client.request({
          method: "POST",
          path: "/repos/fixture-owner/fixture-repo/issues",
          body: {},
        }),
        "rate_limited",
      );
    });
  }
  it("GitHub secondary HTTP-date Retry-After remains a bounded safe hint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { client } = transport(
      "https://api.github.com",
      false,
      403,
      { message: secret },
      { "retry-after": new Date(now + 45_000).toUTCString() },
    );
    await rejection(
      client.request({
        method: "POST",
        path: "/repos/fixture-owner/fixture-repo/issues",
        body: {},
      }),
      "rate_limited",
      45,
    );
  });
});
