import assert from "node:assert/strict";
import { it as test, vi } from "vitest";
import type { Data } from "./collaboration-action.js";
import { conformance, context, failure, response } from "./collaboration-conformance.js";
import { slackActions } from "./slack.js";
import fixtures from "./slack.test-fixtures.json" with { type: "json" };

conformance("slack", slackActions, fixtures);
const action = (id: string) => slackActions.find((action) => action.id === id)!;
const ts = "1792281600.000001",
  channel = "C123FIXTURE";
test("Slack refuses unapproved user data and legacy search; RTS never called", async () => {
  const ctx = context("slack", async () => {
    throw Error("No dispatch");
  });
  ctx.principal.context.slackUserDataAllowed = false;
  await assert.rejects(
    action("slack.conversations.history").execute({ channel }, ctx),
    failure("not_configured"),
  );
  ctx.principal.context.slackUserDataAllowed = true;
  ctx.principal.context.slackLegacySearchAllowed = false;
  await assert.rejects(
    action("slack.search.messages").execute({ query: "fixture" }, ctx),
    failure("not_configured"),
  );
  ctx.principal.context.tokenType = "bot";
  ctx.principal.context.botUserId = ctx.principal.subject;
  await assert.rejects(
    action("slack.search.files").execute({ query: "fixture" }, ctx),
    failure("not_configured"),
  );
});
test("Slack bot current replies supports channel history and bounded 15", async () => {
  const ctx = context("slack", async (request) => {
    assert.equal(request.query!.limit, 15);
    return response({ ok: true, messages: [], has_more: false });
  });
  ctx.principal.context = {
    tokenType: "bot",
    botUserId: ctx.principal.subject,
    teamId: ctx.principal.tenant,
  };
  await action("slack.conversations.replies").execute({ channel, ts }, ctx);
});
test("Slack update/delete cannot target another actor's message", async () => {
  let calls = 0;
  for (const id of ["slack.messages.update", "slack.messages.delete"]) {
    const ctx = context("slack", async () => {
      calls++;
      return response({ ok: true, messages: [{ user: "UOTHER", ts }] });
    });
    await assert.rejects(
      action(id).execute(
        { channel, ts, ...(id.endsWith("update") ? { text: "Fixture" } : {}) },
        ctx,
      ),
      failure("insufficient_scope"),
    );
  }
  assert.equal(calls, 2);
});
test("Slack missing email scope does not fetch user email", async () => {
  const ctx = context("slack", async () => {
    throw Error("No dispatch");
  });
  ctx.principal.scopes = ["users:read"];
  await assert.rejects(
    action("slack.users.resolve").execute({ email: "fixture@example.test" }, ctx),
    failure("insufficient_scope"),
  );
});
test("Slack user profiles and files omit private URLs and ungranted email", async () => {
  const ctx = context("slack", async () =>
    response({
      ok: true,
      user: {
        id: "U123FIXTURE",
        profile: { display_name: "Fixture", email: "fixture@example.test" },
      },
    }),
  );
  ctx.principal.scopes = ["users:read"];
  const out = await action("slack.users.resolve").execute({ userId: "U123FIXTURE" }, ctx);
  assert.equal(JSON.stringify(out).includes("fixture@example.test"), false);
});
test("Slack external upload destination is fixed; lost completion is not replayed", async () => {
  const args = { artifactId: "fixture-artifact", filename: "fixture.txt", channel_id: channel };
  let receipt: Data | undefined;
  let calls = 0;
  const ctx = context(
    "slack",
    async () => {
      calls++;
      if (calls === 1)
        return response({
          ok: true,
          file_id: "F123FIXTURE",
          upload_url: "https://files.slack.com/upload/v1/FIXTURE",
        });
      throw Error("Completion response lost");
    },
    {
      checkpoint: async (state) => {
        receipt = structuredClone(state);
      },
    },
  );
  await assert.rejects(action("slack.files.upload").execute(args, ctx), failure("result_unknown"));
  assert.equal(receipt!.file_id, "F123FIXTURE");
  assert.equal(receipt!.channel, channel);
  assert.equal(JSON.stringify(receipt).includes("upload_url"), false);
  await assert.rejects(
    action("slack.files.upload").execute(args, { ...ctx, recovery: receipt }),
    failure("result_unknown"),
  );
  assert.equal(calls, 2);
});
test("Slack malicious external upload/download URLs never reach transfer", async () => {
  let transfers = 0;
  const ctx = context(
    "slack",
    async () =>
      response({
        ok: true,
        file_id: "F123FIXTURE",
        upload_url: "https://untrusted.example.test/upload/v1/X",
      }),
    {
      uploadResource: async () => {
        transfers++;
        return { status: 200 };
      },
    },
  );
  await assert.rejects(
    action("slack.files.upload").execute(
      { artifactId: "fixture-artifact", filename: "fixture.txt", channel_id: channel },
      ctx,
    ),
    failure("invalid_input"),
  );
  ctx.request = async () =>
    response({
      ok: true,
      file: {
        id: "F123FIXTURE",
        size: 7,
        name: "fixture.txt",
        url_private: "https://untrusted.example.test/private",
      },
    });
  ctx.downloadResource = async () => {
    transfers++;
    return { bytes: new Uint8Array(), mimeType: "text/plain" };
  };
  await assert.rejects(
    action("slack.files.download").execute({ file: "F123FIXTURE" }, ctx),
    failure("invalid_input"),
  );
  assert.equal(transfers, 0);
});
test("Slack unsupported transfer explicitly fails before allocation", async () => {
  const ctx = context("slack", async () => {
    throw Error("No dispatch");
  });
  ctx.uploadResource = undefined;
  await assert.rejects(
    action("slack.files.upload").execute(
      { artifactId: "fixture-artifact", filename: "fixture.txt", channel_id: channel },
      ctx,
    ),
    failure("not_configured"),
  );
});
test("Slack schedule enforces 120-day future bound without upstream dispatch", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1792281600000);
  try {
    await assert.rejects(
      action("slack.messages.schedule").execute(
        { channel, text: "Fixture", post_at: 1792281600 + 121 * 86400 },
        context("slack", async () => {
          throw Error("No dispatch");
        }),
      ),
      failure("invalid_input"),
    );
  } finally {
    vi.restoreAllMocks();
  }
});
test("Slack ok:false catastrophic error is unknown while scope rejection is definite", async () => {
  for (const [code, kind] of [
    ["internal_error", "result_unknown"],
    ["missing_scope", "insufficient_scope"],
  ])
    await assert.rejects(
      action("slack.messages.send").execute(
        { channel, text: "Fixture" },
        context("slack", async () => response({ ok: false, error: code })),
      ),
      failure(kind!),
    );
});
