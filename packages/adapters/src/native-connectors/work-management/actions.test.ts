import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it as test } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { validateNativeInput } from "../validation.js";
import asana from "./asana.test-fixtures.json" with { type: "json" };
import confluence from "./confluence.test-fixtures.json" with { type: "json" };
import gitlab from "./gitlab.test-fixtures.json" with { type: "json" };
import { workManagementApps } from "./index.js";
import jira from "./jira.test-fixtures.json" with { type: "json" };
import { WORK_MANAGEMENT_METADATA } from "./metadata.js";
import todoist from "./todoist.test-fixtures.json" with { type: "json" };
import trello from "./trello.test-fixtures.json" with { type: "json" };

interface Step {
  request: NativeRequest;
  response: { status: number; body: unknown; headers?: Record<string, string> };
}
interface Fixture {
  id: string;
  input: Data;
  steps: Step[];
  output: Data;
}
const suites = { gitlab, jira, confluence, todoist, trello, asana };
function context(
  app: keyof typeof suites,
  request: NativeActionContext["request"],
  receipts: Data[] = [],
): NativeActionContext {
  return {
    operationId: "fixture-operation",
    signal: new AbortController().signal,
    principal: {
      subject: "fixture-user",
      tenant: ["jira", "confluence"].includes(app) ? "fixture-cloud" : null,
      scopes: [...WORK_MANAGEMENT_METADATA[app].scopes],
      capabilities: [],
      knowledgeBaseIds: [],
      context: { actorType: "user", credentialType: "oauth", cloudId: "fixture-cloud" },
    },
    request,
    checkpoint: async (receipt) => {
      receipts.push(structuredClone(receipt));
    },
    callMcp: async () => {
      throw Error("No MCP forwarding");
    },
    readArtifact: async () => {
      throw Error("No implicit binary access");
    },
    validateResourceUrl: async () => {
      throw Error("No model URL");
    },
  };
}
const response = (step: Step): NativeResponse => ({
  status: step.response.status,
  body: structuredClone(step.response.body),
  headers: new Headers(step.response.headers),
});
function subset(expected: unknown, actual: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((v, i) => {
      subset(v, actual[i]);
    });
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    for (const [k, v] of Object.entries(expected)) subset(v, (actual as Data)[k]);
  } else assert.deepEqual(actual, expected);
}
const failure = (kind: string) => (e: unknown) => e instanceof NativeActionError && e.kind === kind;
for (const app of workManagementApps) {
  const suite = suites[app.slug],
    fixtures = suite.fixtures as Fixture[];
  test(`${app.slug}: immutable contract digest and every action has an actual protocol fixture`, () => {
    const raw = readFileSync(new URL(`./${app.slug}.contract.json`, import.meta.url));
    assert.equal(createHash("sha256").update(raw).digest("hex"), suite.contractSha256);
    const contract = JSON.parse(raw.toString()) as {
      actions: Array<{ id: string; inputSchema: Data; readOnly: boolean }>;
    };
    assert.equal(app.actions.length, 8);
    assert.deepEqual(
      app.actions.map((a) => a.id),
      fixtures.map((f) => f.id),
    );
    for (const action of app.actions) {
      const row = contract.actions.find((r) => r.id === action.id)!;
      assert.deepEqual(action.inputSchema, row.inputSchema);
      assert.equal(action.readOnly, row.readOnly);
    }
  });
  for (const fixture of fixtures) {
    const action = app.actions.find((a) => a.id === fixture.id)!;
    test(`${fixture.id}: exact provider protocol and output`, async () => {
      let index = 0;
      const receipts: Data[] = [];
      const ctx = context(
        app.slug,
        async (request) => {
          const step = fixture.steps[index++];
          assert.ok(step, "Unexpected request");
          const actual = structuredClone(request);
          if (app.slug === "todoist" && request.method !== "GET") {
            assert.match(actual.headers?.["X-Request-Id"] ?? "", /^[0-9a-f-]{36}$/);
            delete actual.headers;
          }
          assert.deepEqual(actual, step.request);
          if (!action.readOnly && request.method !== "GET")
            assert.equal(receipts.at(-1)?.dispatch_state, "in_flight");
          return response(step);
        },
        receipts,
      );
      const result = await action.execute(structuredClone(fixture.input), ctx);
      const outputContract = JSON.parse(
        readFileSync(new URL(`./${app.slug}.contract.json`, import.meta.url)).toString(),
      ) as { actions: Array<{ id: string; outputSchema: Data }> };
      validateNativeInput(
        outputContract.actions.find((a) => a.id === fixture.id)!.outputSchema,
        result,
      );
      subset(fixture.output, result);
      assert.equal(index, fixture.steps.length);
      if (!action.readOnly) assert.equal(receipts.at(-1)?.complete, true);
    });
    test(`${fixture.id}: business credentials and arbitrary URL rejected before dispatch`, async () => {
      let calls = 0;
      const ctx = context(app.slug, async () => {
        calls++;
        throw Error("No request");
      });
      for (const extra of [
        { url: "https://untrusted.example" },
        { access_token: "forbidden" },
        { headers: { Authorization: "forbidden" } },
      ])
        await assert.rejects(
          action.execute({ ...fixture.input, ...extra }, ctx),
          failure("invalid_input"),
        );
      assert.equal(calls, 0);
    });
    test(`${fixture.id}: actor and actual scope guards remain closed`, async () => {
      let calls = 0;
      const ctx = context(app.slug, async () => {
        calls++;
        throw Error("No request");
      });
      ctx.principal.context.actorType = "app";
      assert.equal(action.available?.(ctx.principal), false);
      await assert.rejects(action.execute(fixture.input, ctx), failure("authorization_required"));
      ctx.principal.context.actorType = "user";
      ctx.principal.scopes = [];
      assert.equal(action.available?.(ctx.principal), false);
      await assert.rejects(action.execute(fixture.input, ctx), failure("insufficient_scope"));
      assert.equal(calls, 0);
    });
    if (!action.readOnly) {
      test(`${fixture.id}: lost write outcome saves receipt and never replays`, async () => {
        let index = 0,
          writes = 0;
        const receipts: Data[] = [];
        const ctx = context(
          app.slug,
          async (request) => {
            if (request.method !== "GET") {
              writes++;
              throw Error("Fixture transport loss");
            }
            return response(fixture.steps[index++]!);
          },
          receipts,
        );
        await assert.rejects(
          action.execute(structuredClone(fixture.input), ctx),
          failure("result_unknown"),
        );
        assert.equal(writes, 1);
        assert.equal(receipts.at(-1)?.dispatch_state, "in_flight");
        ctx.recovery = receipts.at(-1);
        await assert.rejects(
          action.execute(structuredClone(fixture.input), ctx),
          failure("result_unknown"),
        );
        assert.equal(writes, 1);
      });
      test(`${fixture.id}: confirmed exact acknowledgement recovers without remote request`, async () => {
        let index = 0;
        const receipts: Data[] = [];
        const ctx = context(app.slug, async () => response(fixture.steps[index++]!), receipts);
        await action.execute(structuredClone(fixture.input), ctx);
        ctx.recovery = receipts.at(-1);
        ctx.request = async () => {
          throw Error("No replay");
        };
        const recovered = (await action.execute(structuredClone(fixture.input), ctx)) as Data;
        assert.equal(recovered.recovered_from_exact_ack, true);
        ctx.principal.subject = "another-user";
        await assert.rejects(
          action.execute(structuredClone(fixture.input), ctx),
          failure("invalid_input"),
        );
      });
      test(`${fixture.id}: no remote write if durable checkpoint fails`, async () => {
        let index = 0,
          writes = 0;
        const ctx = context(app.slug, async (request) => {
          if (request.method !== "GET") writes++;
          return response(fixture.steps[index++]!);
        });
        ctx.checkpoint = async () => {
          throw Error("Fixture receipt failure");
        };
        await assert.rejects(
          action.execute(structuredClone(fixture.input), ctx),
          failure("temporarily_unavailable"),
        );
        assert.equal(writes, 0);
      });
    }
  }
}

test("Confluence page update refuses a changed version before mutation", async () => {
  const action = workManagementApps
    .find((a) => a.slug === "confluence")!
    .actions.find((a) => a.id === "confluence.pages.update")!;
  let calls = 0;
  const ctx = context("confluence", async () => {
    calls++;
    return { status: 200, headers: new Headers(), body: { id: "12", version: { number: 4 } } };
  });
  await assert.rejects(
    action.execute(
      { page_id: "12", title: "Fixture", body: "<p>Fixture</p>", expectedVersion: 3 },
      ctx,
    ),
    failure("version_conflict"),
  );
  assert.equal(calls, 1);
});
test("All update actions refuse empty changes before writing", async () => {
  for (const app of workManagementApps)
    for (const fixture of suites[app.slug].fixtures as Fixture[])
      if (fixture.input.changes) {
        const action = app.actions.find((a) => a.id === fixture.id)!;
        let calls = 0;
        const ctx = context(app.slug, async () => {
          calls++;
          throw Error("No request");
        });
        await assert.rejects(
          action.execute({ ...fixture.input, changes: {} }, ctx),
          failure("invalid_input"),
        );
        assert.equal(calls, 0);
      }
});
test("Todoist due_string and due_date cannot silently override each other", async () => {
  const action = workManagementApps
    .find((a) => a.slug === "todoist")!
    .actions.find((a) => a.id === "todoist.tasks.create")!;
  await assert.rejects(
    action.execute(
      { content: "Fixture", due_date: "2026-10-19", due_string: "tomorrow" },
      context("todoist", async () => {
        throw Error("No request");
      }),
    ),
    failure("invalid_input"),
  );
});

for (const [name, configuredScopes] of [
  ["missing configured scopes", undefined],
  ["read-only configured scopes", ["data:read"]],
  ["empty configured scopes", []],
] as const)
  test(`Todoist personal token ${name} hides and blocks writes without fabricating actual scopes`, async () => {
    const action = workManagementApps
      .find((a) => a.slug === "todoist")!
      .actions.find((a) => a.id === "todoist.tasks.create")!;
    let calls = 0;
    const ctx = context("todoist", async () => {
      calls++;
      throw Error("No unauthorized request");
    });
    ctx.principal.scopes = [];
    ctx.principal.context = {
      actorType: "user",
      credentialType: "personal_token",
      scopeAuthority: "provider_enforced",
      ...(configuredScopes ? { configuredScopes } : {}),
    };
    assert.equal(action.available?.(ctx.principal), false);
    await assert.rejects(
      action.execute({ content: "Fixture" }, ctx),
      failure("insufficient_scope"),
    );
    assert.equal(calls, 0);
    assert.deepEqual(ctx.principal.scopes, []);
  });
test("Todoist personal token configured read policy permits reads; configured write policy permits exact write", async () => {
  const app = workManagementApps.find((a) => a.slug === "todoist")!;
  for (const [id, scopes] of [
    ["todoist.projects.list", ["data:read"]],
    ["todoist.tasks.create", ["data:read_write"]],
  ] as const) {
    const action = app.actions.find((a) => a.id === id)!;
    const fixture = (todoist.fixtures as Fixture[]).find((f) => f.id === id)!;
    let index = 0;
    const ctx = context("todoist", async () => response(fixture.steps[index++]!));
    ctx.principal.scopes = [];
    ctx.principal.context = {
      actorType: "user",
      credentialType: "personal_token",
      scopeAuthority: "provider_enforced",
      configuredScopes: [...scopes],
    };
    assert.equal(action.available?.(ctx.principal), true);
    await action.execute(fixture.input, ctx);
    assert.equal(index, fixture.steps.length);
    assert.deepEqual(ctx.principal.scopes, []);
  }
});
