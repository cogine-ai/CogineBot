import assert from "node:assert/strict";
import type { NativeAppConfig } from "@rakazo/db";
import { it as test, vi } from "vitest";
import type { NativeActionContext } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { NativeHttpClient } from "../http.js";
import asana from "./asana.test-fixtures.json" with { type: "json" };
import confluence from "./confluence.test-fixtures.json" with { type: "json" };
import gitlab from "./gitlab.test-fixtures.json" with { type: "json" };
import { workManagementApps } from "./index.js";
import jira from "./jira.test-fixtures.json" with { type: "json" };
import { WORK_MANAGEMENT_METADATA, workManagementBase } from "./metadata.js";
import todoist from "./todoist.test-fixtures.json" with { type: "json" };
import trello from "./trello.test-fixtures.json" with { type: "json" };

const suites = { gitlab, jira, confluence, todoist, trello, asana };
const failure = (kind: string) => (e: unknown) => e instanceof NativeActionError && e.kind === kind;
function principal(app: keyof typeof suites): NativeActionContext["principal"] {
  return {
    subject: "fixture-user",
    tenant: ["jira", "confluence"].includes(app) ? "fixture-cloud" : null,
    scopes: [...WORK_MANAGEMENT_METADATA[app].scopes],
    capabilities: [],
    knowledgeBaseIds: [],
    context: { actorType: "user", credentialType: "oauth", cloudId: "fixture-cloud" },
  };
}
function ctx(p: NativeActionContext["principal"], client: NativeHttpClient): NativeActionContext {
  return {
    operationId: "fixture-http-operation",
    signal: new AbortController().signal,
    principal: p,
    checkpoint: async () => {},
    request: (r) => client.request(r),
    callMcp: async () => {
      throw Error("No MCP");
    },
    readArtifact: async () => {
      throw Error("No implicit attachment reads");
    },
    validateResourceUrl: async () => {
      throw Error("No model URL");
    },
  };
}
for (const app of workManagementApps) {
  const base = workManagementBase(
    {
      appId: app.slug,
      config: { scopes: [], capabilities: [], knowledgeBaseIds: [] },
    } as unknown as NativeAppConfig,
    "fixture-cloud",
  );
  for (const fixture of suites[app.slug].fixtures) {
    test(`${fixture.id}: real native HTTP composition pins authority, bearer and JSON body`, async () => {
      let index = 0;
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const step = fixture.steps[index++]!;
        assert.ok(step, "No additional calls");
        const actual = new URL(String(input)),
          expected = new URL(base + step.request.path);
        assert.equal(actual.origin + actual.pathname, expected.origin + expected.pathname);
        assert.equal(init?.method, step.request.method);
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-access");
        if ("body" in step.request)
          assert.deepEqual(JSON.parse(String(init?.body)), step.request.body);
        else assert.equal(init?.body, undefined);
        assert.equal(actual.searchParams.has("access_token"), false);
        const response = step.response;
        return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
          status: response.status,
          headers: {
            "content-type": "application/json",
            ...("headers" in response ? response.headers : {}),
          },
        });
      });
      const action = app.actions.find((a) => a.id === fixture.id)!;
      const client = new NativeHttpClient(
        base,
        async () => ({ kind: "bearer", value: "fixture-access" }),
        {
          signal: new AbortController().signal,
          readOnly: action.readOnly,
          network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        },
      );
      try {
        await action.execute(structuredClone(fixture.input), ctx(principal(app.slug), client));
        assert.equal(index, fixture.steps.length);
      } finally {
        await client.close();
      }
    });
  }
  for (const [status, kind] of [
    [401, "authorization_expired"],
    [403, "resource_unavailable"],
    [404, "resource_unavailable"],
    [409, "version_conflict"],
    [412, "version_conflict"],
    [429, "rate_limited"],
    [503, "temporarily_unavailable"],
  ] as const) {
    test(`${app.slug}: actual HTTP ${status} maps to ${kind} without leaking response data`, async () => {
      const fixture = suites[app.slug].fixtures[0]!,
        action = app.actions[0]!;
      const client = new NativeHttpClient(
        base,
        async () => ({ kind: "bearer", value: "fixture-access" }),
        {
          signal: new AbortController().signal,
          readOnly: true,
          network: {
            fetch: async () =>
              new Response(JSON.stringify({ detail: "fixture-private-upstream-diagnostic" }), {
                status,
                headers: { "content-type": "application/json", "Retry-After": "3" },
              }),
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
          },
        },
      );
      try {
        await assert.rejects(
          action.execute(structuredClone(fixture.input), ctx(principal(app.slug), client)),
          (e: unknown) => {
            assert.ok(failure(kind)(e));
            assert.ok(e instanceof NativeActionError);
            assert.equal(e.message.includes("fixture-private"), false);
            if (status === 429) assert.equal(e.options.retryAfterSeconds, 3);
            return true;
          },
        );
      } finally {
        await client.close();
      }
    });
  }
  test(`${app.slug}: unsafe redirect is never followed with the selected account's token`, async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example/credential" },
        }),
    );
    const client = new NativeHttpClient(
      base,
      async () => ({ kind: "bearer", value: "fixture-access" }),
      {
        signal: new AbortController().signal,
        readOnly: true,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    try {
      await assert.rejects(
        app.actions[0]!.execute(
          structuredClone(suites[app.slug].fixtures[0]!.input),
          ctx(principal(app.slug), client),
        ),
        failure("temporarily_unavailable"),
      );
      assert.ok(fetch.mock.calls.length <= 2);
    } finally {
      await client.close();
    }
  });
}

test("Confluence pagination returns only an opaque cursor, never dispatches provider Link URLs", async () => {
  const action = workManagementApps
    .find((a) => a.slug === "confluence")!
    .actions.find((a) => a.id === "confluence.spaces.list")!;
  let calls = 0;
  const context: NativeActionContext = {
    operationId: "fixture",
    signal: new AbortController().signal,
    principal: principal("confluence"),
    checkpoint: async () => {},
    request: async () => {
      calls++;
      return {
        status: 200,
        headers: new Headers(),
        body: {
          results: [{ id: "9" }],
          _links: { next: "https://untrusted.example/path?cursor=fixture-cursor" },
        },
      };
    },
    callMcp: async () => {},
    readArtifact: async () => {
      throw Error("No artifact");
    },
    validateResourceUrl: async () => {
      throw Error("No URL");
    },
  };
  const result = (await action.execute({}, context)) as Data;
  assert.equal(result.nextCursor, "fixture-cursor");
  assert.equal(calls, 1);
});
test("Missing Todoist cursor and Asana pagination state are incomplete, never complete collections", async () => {
  for (const slug of ["todoist", "asana"] as const) {
    const app = workManagementApps.find((a) => a.slug === slug)!;
    const context: NativeActionContext = {
      operationId: "fixture",
      signal: new AbortController().signal,
      principal: principal(slug),
      checkpoint: async () => {},
      request: async () => ({
        status: 200,
        headers: new Headers(),
        body: slug === "asana" ? { data: [] } : { results: [] },
      }),
      callMcp: async () => {},
      readArtifact: async () => {
        throw Error("No artifact");
      },
      validateResourceUrl: async () => {
        throw Error("No URL");
      },
    };
    await assert.rejects(app.actions[0]!.execute({}, context), failure("incomplete_response"));
  }
});
