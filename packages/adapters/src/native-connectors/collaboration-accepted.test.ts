import assert from "node:assert/strict";
import { it as test } from "vitest";
import type { NativeActionContext, NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import { collaborationActions } from "./collaboration-action.js";

function fixture(id: string, path: string, options = true) {
  let calls = 0;
  let receipt: Record<string, unknown> = {};
  const context: NativeActionContext = {
    operationId: "fixture-effect",
    signal: new AbortController().signal,
    principal: { subject: "fixture-user", tenant: "fixture-tenant", scopes: [], capabilities: [], knowledgeBaseIds: [], context: {} },
    async checkpoint(value) { receipt = structuredClone(value); },
    async request() { calls++; return { status: 202, body: null, headers: new Headers() }; },
    async callMcp() { throw new Error("unused"); },
    async readArtifact() { throw new Error("unused"); },
    async validateResourceUrl() { throw new Error("unused"); },
  };
  const [action] = collaborationActions([
    { id, description: "Fixture accepted action", readOnly: false, inputSchema: { type: "object", properties: {}, additionalProperties: false }, authorization: { acceptedAnyOfScopes: [] } },
  ], async (_args, run) => {
    await run.request({ method: "POST", path }, true, "dispatching", options ? { acceptedStatus: 202 } : undefined);
    return run.finish({ id: "fixture-resource" }, { resource_id: "fixture-resource" });
  }, () => {});
  return { action: action!, context, calls: () => calls, receipt: () => receipt };
}

for (const [id, path] of [
  ["outlook.drafts.send", "/me/messages/fixture-resource/send"],
  ["outlook.messages.reply", "/me/messages/fixture-resource/reply"],
  ["outlook_calendar.events.cancel", "/me/events/fixture-resource/cancel"],
]) {
  test(`${id} records accepted ACK and restores it without repeating the write`, async () => {
    const f = fixture(id!, path!);
    const output = await f.action.execute({}, f.context) as Record<string, unknown>;
    assert.equal(output.write_outcome, "accepted");
    assert.equal(output.accepted, true);
    assert.equal(output.deliveryVerified, false);
    assert.equal(output.terminalStateVerified, false);
    assert.equal(f.receipt().dispatch_state, "acknowledged");
    assert.equal(f.receipt().complete, true);
    f.context.recovery = f.receipt();
    const recovered = await f.action.execute({}, f.context) as Record<string, unknown>;
    assert.equal(recovered.write_outcome, "accepted");
    assert.equal(recovered.resource_id, "fixture-resource");
    assert.equal(recovered.deliveryVerified, false);
    assert.equal(recovered.recovered_from_exact_ack, true);
    assert.equal(f.calls(), 1);
    f.context.principal.subject = "other-user";
    await assert.rejects(f.action.execute({}, f.context), (error: unknown) => error instanceof NativeActionError && error.kind === "invalid_input");
    assert.equal(f.calls(), 1);
  });
}

test("202 acceptance cannot be enabled for another action or resource path", async () => {
  for (const [id, path] of [["other.write", "/me/messages/x/send"], ["outlook.drafts.send", "/users/other/messages/x/send"], ["outlook.drafts.send", "/me/events/x/cancel"]]) {
    const f = fixture(id!, path!);
    await assert.rejects(f.action.execute({}, f.context), (error: unknown) => error instanceof NativeActionError && error.kind === "invalid_input");
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.receipt(), {});
  }
});

test("ordinary 202 responses and a lost dispatch response remain unknown and never replay", async () => {
  for (const options of [false, true]) {
    const f = fixture("outlook.drafts.send", "/me/messages/x/send", options);
    if (options) f.context.request = async (_request: NativeRequest) => { throw new NativeActionError("temporarily_unavailable", "Fixture lost response", { uncertain: true }); };
    await assert.rejects(f.action.execute({}, f.context), (error: unknown) => error instanceof NativeActionError && error.kind === "result_unknown");
    assert.equal(f.receipt().dispatch_state, "in_flight");
    f.context.recovery = f.receipt();
    f.context.request = async () => { throw new Error("must not replay"); };
    await assert.rejects(f.action.execute({}, f.context), (error: unknown) => error instanceof NativeActionError && error.kind === "result_unknown");
  }
});
