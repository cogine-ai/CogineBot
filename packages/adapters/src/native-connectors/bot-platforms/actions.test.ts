import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it as test } from "vitest";
import type { Data } from "../collaboration-action.js";
import { validateNativeInput } from "../validation.js";
import { botPlatformApps } from "./index.js";
import {
  assertRequest,
  context,
  type Fixture,
  failure,
  response,
  subset,
  suites,
} from "./testing.js";

for (const app of botPlatformApps) {
  const suite = suites[app.slug];
  test(`${app.slug}: frozen contract and complete actual protocol coverage`, () => {
    const bytes = readFileSync(new URL(`./${app.slug}.contract.json`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), suite.contractSha256);
    assert.deepEqual(
      app.actions.map((a) => a.id),
      suite.fixtures.map((f) => f.id),
    );
    assert.equal(app.actions.length, app.slug === "discord" ? 10 : 8);
  });
  for (const f of suite.fixtures as Fixture[]) {
    const action = app.actions.find((a) => a.id === f.id)!;
    test(`${f.id}: exact provider protocol, confirmed JSON and effect receipt`, async () => {
      let i = 0;
      const receipts: Data[] = [];
      const ctx = context(
        app.slug,
        async (r) => {
          const s = f.steps[i++];
          assert.ok(s, "No unplanned request");
          await assertRequest(r, s);
          if (r.method !== "GET") assert.equal(receipts.at(-1)?.dispatch_state, "in_flight");
          return response(s);
        },
        receipts,
      );
      const result = await action.execute(structuredClone(f.input), ctx);
      assert.equal(i, f.steps.length);
      subset(f.output, result);
      const contract = JSON.parse(
        readFileSync(new URL(`./${app.slug}.contract.json`, import.meta.url)).toString(),
      ) as { actions: Array<{ id: string; outputSchema: Data }> };
      validateNativeInput(contract.actions.find((a) => a.id === f.id)!.outputSchema, result);
      if (!action.readOnly) assert.equal(receipts.at(-1)?.complete, true);
    });
    test(`${f.id}: rejects injected route, credential and foreign target before dispatch`, async () => {
      let calls = 0;
      const ctx = context(app.slug, async () => {
        calls++;
        throw Error("No dispatch");
      });
      for (const extra of [
        { url: "https://untrusted.example" },
        { access_token: "forbidden" },
        { headers: { Authorization: "forbidden" } },
      ])
        await assert.rejects(
          action.execute({ ...f.input, ...extra }, ctx),
          failure("invalid_input"),
        );
      ctx.principal.context.verifiedTargets = [];
      await assert.rejects(action.execute(f.input, ctx));
      assert.equal(calls, 0);
    });
    test(`${f.id}: bot actor and owner-enabled capabilities required`, async () => {
      let calls = 0;
      const ctx = context(app.slug, async () => {
        calls++;
        throw Error("No dispatch");
      });
      ctx.principal.context.actorType = "user";
      assert.equal(action.available?.(ctx.principal), false);
      await assert.rejects(action.execute(f.input, ctx), failure("authorization_required"));
      ctx.principal.context.actorType = "bot";
      ctx.principal.capabilities = [];
      assert.equal(action.available?.(ctx.principal), false);
      await assert.rejects(action.execute(f.input, ctx), failure("insufficient_scope"));
      assert.equal(calls, 0);
    });
    if (!action.readOnly) {
      test(`${f.id}: uncertain write never replays`, async () => {
        let i = 0,
          writes = 0;
        const receipts: Data[] = [];
        const ctx = context(
          app.slug,
          async (r) => {
            if (r.method !== "GET") {
              writes++;
              throw Error("Transport lost");
            }
            return response(f.steps[i++]!);
          },
          receipts,
        );
        await assert.rejects(action.execute(f.input, ctx), failure("result_unknown"));
        assert.equal(writes, 1);
        ctx.recovery = receipts.at(-1);
        await assert.rejects(action.execute(f.input, ctx), failure("result_unknown"));
        assert.equal(writes, 1);
      });
      test(`${f.id}: durable receipt failure prevents remote mutation`, async () => {
        let i = 0,
          writes = 0;
        const ctx = context(app.slug, async (r) => {
          if (r.method !== "GET") writes++;
          return response(f.steps[i++]!);
        });
        ctx.checkpoint = async () => {
          throw Error("Storage down");
        };
        await assert.rejects(action.execute(f.input, ctx), failure("temporarily_unavailable"));
        assert.equal(writes, 0);
      });
      test(`${f.id}: exact acknowledged effect recovery is bound to original input and actor`, async () => {
        let i = 0;
        const receipts: Data[] = [];
        const ctx = context(app.slug, async () => response(f.steps[i++]!), receipts);
        await action.execute(f.input, ctx);
        ctx.recovery = receipts.at(-1);
        ctx.request = async () => {
          throw Error("No replay");
        };
        assert.equal(((await action.execute(f.input, ctx)) as Data).recovered_from_exact_ack, true);
        ctx.principal.subject = "100099";
        ctx.principal.context.botId = "100099";
        await assert.rejects(action.execute(f.input, ctx), failure("invalid_input"));
      });
    }
  }
}
