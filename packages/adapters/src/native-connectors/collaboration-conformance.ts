import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it as test, vi } from "vitest";
import type { NativeAction, NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import type { Data } from "./collaboration-action.js";

interface Fixture {
  id: string;
  input: Data;
  upstream: { request: NativeRequest; response: { status: number; body: unknown } }[];
  expectedOutput?: Data;
  fixtureId?: string;
  expectedError?: { kind: string };
  scopes?: string[];
  binaryUpload?: { url: string; bytes: string; contentType: string };
}
interface Fixtures {
  contractSha256: string;
  fixtures: Fixture[];
}
export function failure(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof NativeActionError && error.kind === kind;
}
export function context(
  app: "github" | "linear" | "slack",
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
): NativeActionContext {
  return {
    operationId: "fixture-collaboration-effect-001",
    signal: new AbortController().signal,
    principal: {
      subject: app === "slack" ? "U123FIXTURE" : "fixture-actor",
      tenant: app === "slack" ? "T123FIXTURE" : "fixture-tenant",
      scopes: [
        "read",
        "write",
        "issues:create",
        "comments:create",
        "users:read",
        "users:read.email",
        "chat:write",
        "channels:read",
        "groups:read",
        "im:read",
        "mpim:read",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "search:read",
        "files:write",
        "files:read",
        "reactions:write",
        "im:write",
        "mpim:write",
      ],
      capabilities: [],
      knowledgeBaseIds: [],
      context:
        app === "slack"
          ? {
              tokenType: "user",
              userId: "U123FIXTURE",
              teamId: "T123FIXTURE",
              enterpriseId: null,
              slackUserDataAllowed: true,
              slackLegacySearchAllowed: true,
            }
          : app === "linear"
            ? { actorType: "user", credentialType: "oauth", organizationId: "fixture-tenant" }
            : { actorType: "fine_grained_pat" },
    },
    checkpoint: async () => {},
    request,
    callMcp: async () => {
      throw Error("Unexpected MCP");
    },
    readArtifact: async () => ({
      bytes: new TextEncoder().encode("fixture"),
      name: "fixture.txt",
      mimeType: "text/plain",
    }),
    validateResourceUrl: async () => {},
    uploadResource: async () => ({ status: 200 }),
    downloadResource: async () => ({
      bytes: new TextEncoder().encode("fixture"),
      mimeType: "text/plain",
    }),
    writeArtifact: async ({ bytes, name, mimeType }) => ({
      id: "fixture-downloaded-artifact",
      name,
      mimeType,
      size: bytes.length,
    }),
    ...extra,
  };
}
export function response(body: unknown, status = 200, headers = new Headers()): NativeResponse {
  return { body: structuredClone(body), status, headers };
}
export function subset(expected: unknown, actual: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((value, index) => {
      subset(value, actual[index]);
    });
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    for (const [key, value] of Object.entries(expected)) subset(value, (actual as Data)[key]);
    return;
  }
  assert.deepEqual(actual, expected);
}
export function conformance(
  app: "github" | "linear" | "slack",
  actions: NativeAction[],
  rawFixtures: unknown,
): void {
  const fixtures = rawFixtures as Fixtures;
  test(`${app}: frozen contract digest and exact inventory`, () => {
    const source = readFileSync(new URL(`./${app}.contract.json`, import.meta.url));
    const contract = JSON.parse(source.toString()) as { actions: NativeAction[] };
    assert.equal(createHash("sha256").update(source).digest("hex"), fixtures.contractSha256);
    assert.deepEqual(
      actions.map((action) => action.id),
      [...new Set(fixtures.fixtures.map((fixture) => fixture.id))],
    );
    for (const action of actions) {
      const row = contract.actions.find((row) => row.id === action.id)!;
      assert.deepEqual(action.inputSchema, row.inputSchema);
      assert.equal(action.readOnly, row.readOnly);
    }
  });
  for (const fixture of fixtures.fixtures) {
    const action = actions.find((action) => action.id === fixture.id)!;
    test(`${app}: exact protocol fixture ${fixture.id} ${fixture.fixtureId ?? "default"}`, async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T00:00:00.000Z"));
      let index = 0;
      const receipts: Data[] = [];
      try {
        const ctx = context(
          app,
          async (request) => {
            const step = fixture.upstream[index++];
            assert.ok(step, `Unexpected ${request.method} ${request.path}`);
            assert.deepEqual(request, step.request);
            return response(step.response.body, step.response.status);
          },
          {
            checkpoint: async (receipt) => {
              receipts.push(structuredClone(receipt));
            },
          },
        );
        if (fixture.scopes) ctx.principal.scopes = fixture.scopes;
        if (fixture.binaryUpload)
          ctx.uploadResource = async (upload) => {
            assert.equal(upload.url, fixture.binaryUpload!.url);
            assert.equal(new TextDecoder().decode(upload.bytes), fixture.binaryUpload!.bytes);
            assert.equal(upload.contentType, fixture.binaryUpload!.contentType);
            return { status: 200 };
          };
        if (fixture.expectedError)
          await assert.rejects(
            action.execute(structuredClone(fixture.input), ctx),
            failure(fixture.expectedError.kind),
          );
        else
          subset(fixture.expectedOutput, await action.execute(structuredClone(fixture.input), ctx));
        assert.equal(index, fixture.upstream.length);
        if (!action.readOnly) {
          assert.ok(receipts.some((r) => r.dispatch_state === "in_flight"));
          assert.equal(receipts.at(-1)!.complete, true);
        }
      } finally {
        vi.restoreAllMocks();
      }
    });
    test(`${app}: rejects credentials/account/URL injection ${fixture.id}`, async () => {
      for (const field of ["access_token", "url", "accountId", "queryOverride"]) {
        let calls = 0;
        await assert.rejects(
          action.execute(
            { ...fixture.input, [field]: "fixture-forbidden" },
            context(app, async () => {
              calls++;
              throw Error("Unexpected");
            }),
          ),
          failure("invalid_input"),
        );
        assert.equal(calls, 0);
      }
    });
    if (!action.readOnly) {
      test(`${app}: lost dispatch never repeats ${fixture.id}`, async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T00:00:00.000Z"));
        let index = 0;
        let receipt: Data | undefined;
        const firstWriteIndex =
          fixture.id === "linear.issues.update" ||
          fixture.id === "slack.messages.update" ||
          fixture.id === "slack.messages.delete"
            ? 1
            : 0;
        try {
          const ctx = context(
            app,
            async () => {
              const at = index++;
              if (at === firstWriteIndex) throw Error("Fixture response lost");
              const step = fixture.upstream[at]!;
              return response(step.response.body, step.response.status);
            },
            {
              checkpoint: async (state) => {
                receipt = structuredClone(state);
              },
            },
          );
          await assert.rejects(
            action.execute(structuredClone(fixture.input), ctx),
            failure("result_unknown"),
          );
          assert.ok(receipt);
          await assert.rejects(
            action.execute(structuredClone(fixture.input), {
              ...ctx,
              recovery: receipt,
              request: async () => {
                throw Error("Must not replay");
              },
            }),
            failure("result_unknown"),
          );
          assert.equal(index, firstWriteIndex + 1);
          const changed = {
            ...ctx,
            recovery: receipt,
            principal: { ...ctx.principal, subject: "other-actor" },
          };
          await assert.rejects(
            action.execute(structuredClone(fixture.input), changed),
            (error) =>
              error instanceof NativeActionError &&
              ["invalid_input", "authorization_required"].includes(error.kind),
          );
        } finally {
          vi.restoreAllMocks();
        }
      });
      test(`${app}: exact acknowledgement can return ID without replay ${fixture.id}`, async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T00:00:00.000Z"));
        let index = 0;
        let receipt: Data | undefined;
        try {
          const ctx = context(
            app,
            async () => {
              const step = fixture.upstream[index++]!;
              return response(step.response.body, step.response.status);
            },
            {
              checkpoint: async (state) => {
                receipt = structuredClone(state);
              },
            },
          );
          await action.execute(structuredClone(fixture.input), ctx);
          const replay = await action.execute(structuredClone(fixture.input), {
            ...ctx,
            recovery: receipt,
            request: async () => {
              throw Error("Must not replay");
            },
          });
          subset(
            {
              write_outcome: "confirmed",
              recovered_from_exact_ack: true,
              resource_snapshot_current: false,
            },
            replay,
          );
          assert.equal(index, fixture.upstream.length);
        } finally {
          vi.restoreAllMocks();
        }
      });
    }
  }
}
