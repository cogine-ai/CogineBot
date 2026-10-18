import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it as test } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import { calendarActions } from "./calendar.js";
import contract from "./calendar.test-fixtures.json" with { type: "json" };

type Obj = Record<string, unknown>;
interface Step {
  request: NativeRequest;
  response: NativeResponse;
}
const SCOPE = "https://www.googleapis.com/auth/";
const OP = "fixture-calendar-create-001";
const EVENT_ID = `cgn${createHash("sha256").update(OP).digest("hex")}`;
const response = (body: unknown, status = 200): NativeResponse => ({
  body: structuredClone(body),
  status,
  headers: new Headers(),
});
const actions = new Map(calendarActions.map((action) => [action.id, action]));
const clone = <T>(value: T): T => structuredClone(value);
function execute(id: string, args: Obj, context: NativeActionContext) {
  return actions.get(id)!.execute(args, context);
}
function ctx(
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
): NativeActionContext {
  return {
    operationId: OP,
    signal: new AbortController().signal,
    principal: {
      subject: "fixture-google-sub",
      tenant: null,
      scopes: [`${SCOPE}calendar`],
      capabilities: [],
      knowledgeBaseIds: [],
      context: {},
    },
    checkpoint: async () => {},
    request,
    callMcp: async () => {
      throw new Error("Unexpected MCP");
    },
    readArtifact: async () => {
      throw new Error("Unexpected artifact");
    },
    validateResourceUrl: async () => {
      throw new Error("Unexpected URL");
    },
    ...extra,
  };
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, clean(child)]),
    );
  return value;
}
function envelope(request: NativeRequest): unknown {
  return clean({
    method: request.method,
    path: request.path,
    query: request.query ?? {},
    headers: request.headers ?? {},
    ...(request.body === undefined ? {} : { body: request.body }),
  });
}
function subset(expected: unknown, actual: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((value, i) => {
      subset(value, actual[i]);
    });
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    for (const [key, value] of Object.entries(expected)) subset(value, (actual as Obj)[key]);
    return;
  }
  assert.deepEqual(actual, expected);
}
function failure(kind: string) {
  return (error: unknown) => error instanceof NativeActionError && error.kind === kind;
}
const row = (id: string) => contract.actions.find((action) => action.id === id)!;
const good = (id: string): Obj => clone(row(id).fixtures[0]!.input) as Obj;
const single = (): Obj =>
  clone(row("calendar.events.update").fixtures[0]!.upstream[0]!.response.body) as Obj;
function queue(
  values: (
    | NativeResponse
    | Error
    | ((request: NativeRequest) => NativeResponse | Promise<NativeResponse>)
  )[],
) {
  const calls: NativeRequest[] = [];
  return {
    calls,
    request: async (request: NativeRequest) => {
      calls.push(clone(request));
      const value = values.shift();
      assert.notEqual(value, undefined, `Unexpected ${request.method} ${request.path}`);
      if (value instanceof Error) throw value;
      return typeof value === "function" ? value(request) : value!;
    },
  };
}

test("12 exact frozen action IDs, read/effect and scopes", () => {
  assert.equal(actions.size, 12);
  assert.deepEqual(
    [...actions.keys()],
    contract.actions.map((action) => action.id),
  );
  for (const expected of contract.actions) {
    const actual = actions.get(expected.id)!;
    assert.deepEqual(actual.inputSchema, expected.inputSchema);
    assert.equal(actual.readOnly, expected.readOnly);
    assert.deepEqual(actual.scopesAnyOf, expected.authorization.acceptedAnyOfScopes);
  }
});
for (const action of contract.actions)
  for (const fixture of action.fixtures) {
    test(`frozen request/response: ${action.id} / ${fixture.id}`, async () => {
      const f = fixture as unknown as {
        input: Obj;
        context: Obj;
        upstream: Step[];
        expectedError?: { kind: string };
        expectedOutput?: Obj;
      };
      let index = 0;
      const checkpoints: Obj[] = [],
        observed: NativeRequest[] = [];
      const context = ctx(
        async (request) => {
          observed.push(clone(request));
          const step = f.upstream[index++];
          assert.ok(step, `Unexpected request ${request.path}`);
          return response(step.response.body, step.response.status);
        },
        {
          operationId: String(f.context.effectIdempotencyKey ?? OP),
          checkpoint: async (state) => {
            checkpoints.push(clone(state));
          },
        },
      );
      if (f.expectedError)
        await assert.rejects(
          execute(action.id, clone(f.input), context),
          failure(f.expectedError.kind),
        );
      else subset(f.expectedOutput, await execute(action.id, clone(f.input), context));
      assert.equal(index, f.upstream.length);
      observed.forEach((request, at) => {
        assert.deepEqual(envelope(request), envelope(f.upstream[at]!.request));
      });
      if (!action.readOnly && !f.expectedError) {
        assert.equal(checkpoints[0]!.stage, "prepared");
        assert.ok(checkpoints.some((state) => state.stage === "dispatching"));
        assert.equal(checkpoints.at(-1)!.stage, "committed");
      }
    });
  }
for (const action of contract.actions)
  for (const fixture of action.rejectedInputFixtures) {
    test(`frozen strict rejection: ${action.id} / ${fixture.id}`, async () => {
      let requests = 0,
        checkpoints = 0;
      await assert.rejects(
        execute(
          action.id,
          clone(fixture.input) as Obj,
          ctx(
            async () => {
              requests++;
              throw new Error("No network");
            },
            {
              checkpoint: async () => {
                checkpoints++;
              },
            },
          ),
        ),
        failure("invalid_input"),
      );
      assert.equal(requests, 0);
      assert.equal(checkpoints, 0);
    });
  }

test("scope profiles do not conflate free/busy with event read/write or infer owned authority", async () => {
  for (const [id, scope] of [
    ["calendar.events.search", "calendar.events.freebusy"],
    ["calendar.freebusy.query", "calendar.events"],
    ["calendar.events.create", "calendar.events.owned"],
    ["calendar.events.move", "calendar.app.created"],
  ] as const) {
    const context = ctx(async () => {
      throw new Error("Must not request");
    });
    context.principal.scopes = [`${SCOPE}${scope}`];
    await assert.rejects(execute(id, good(id), context), failure("insufficient_scope"));
  }
});

test("empty/incomplete page and cancelled sparse entries do not fake completeness", async () => {
  await assert.rejects(
    execute(
      "calendar.events.search",
      good("calendar.events.search"),
      ctx(async () => response({ nextPageToken: "next" })),
    ),
    failure("incomplete_response"),
  );
  const args = { ...good("calendar.events.instances"), pageToken: "continued-page" };
  const result = (await execute(
    "calendar.events.instances",
    args,
    ctx(async () =>
      response({ items: [{ id: "cancelled", status: "cancelled", recurringEventId: "series" }] }),
    ),
  )) as Obj;
  assert.equal(result.hasMore, false);
  assert.equal(result.allPagesRead, false);
  assert.equal((result.items as Obj[])[0]!.status, "cancelled");
});

test("window, explicit offsets, IANA zone consistency and all-day exclusive end", async () => {
  const base = good("calendar.events.create"),
    event = base.event as Obj;
  const cases = [
    { ...base, event: { ...event, start: { date: "2026-02-30" }, end: { date: "2026-03-02" } } },
    { ...base, event: { ...event, start: { date: "2026-10-20" }, end: { date: "2026-10-20" } } },
    {
      ...base,
      event: {
        ...event,
        start: { dateTime: "2026-10-20T09:00:00+08:00", timeZone: "America/New_York" },
      },
    },
    {
      ...base,
      event: { ...event, start: { dateTime: "2026-10-20T09:00:00", timeZone: "Asia/Taipei" } },
    },
    {
      ...base,
      event: {
        ...event,
        start: { dateTime: "2026-10-20T09:00:00+08:00", timeZone: "Invalid/Zone" },
      },
    },
  ];
  for (const args of cases)
    await assert.rejects(
      execute(
        "calendar.events.create",
        args,
        ctx(async () => {
          throw new Error("Must reject before network");
        }),
      ),
      failure("invalid_input"),
    );
  await assert.rejects(
    execute(
      "calendar.events.search",
      { ...good("calendar.events.search"), timeMax: "2026-01-01T00:00:00Z" },
      ctx(async () => {
        throw new Error("Must reject");
      }),
    ),
    failure("invalid_input"),
  );
  await assert.rejects(
    execute(
      "calendar.events.search",
      { ...good("calendar.events.search"), singleEvents: false, orderBy: "startTime" },
      ctx(async () => {
        throw new Error("Must reject");
      }),
    ),
    failure("invalid_input"),
  );
});

test("recurrence parse validates values, time zone and explicit series changes", async () => {
  const base = good("calendar.events.create"),
    input = base.event as Obj;
  for (const recurrence of [
    ["RRULE:COUNT=2"],
    ["RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261025T000000Z"],
    ["RRULE:FREQ=WEEKLY;BYDAY=5MO"],
    ["RRULE:FREQ=MONTHLY;BYMONTHDAY=0"],
    ["RRULE:FREQ=DAILY;BYHOUR=25"],
    ["RRULE:FREQ=DAILY;UNKNOWN=1"],
    ["EXDATE:20260230"],
    ["RRULE:FREQ=DAILY;BYSETPOS=1"],
  ]) {
    await assert.rejects(
      execute(
        "calendar.events.create",
        { ...base, event: { ...input, recurrence } },
        ctx(async () => {
          throw new Error("Must reject");
        }),
      ),
      failure("invalid_input"),
    );
  }
  const noZone = {
    ...input,
    start: { dateTime: "2026-10-20T09:00:00+08:00" },
    end: { dateTime: "2026-10-20T09:30:00+08:00" },
    recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
  };
  await assert.rejects(
    execute(
      "calendar.events.create",
      { ...base, event: noZone },
      ctx(async () => {
        throw new Error("Must reject");
      }),
    ),
    failure("invalid_input"),
  );
  await assert.rejects(
    execute(
      "calendar.events.update",
      { ...good("calendar.events.update"), changes: { recurrence: [] } },
      ctx(async () => {
        throw new Error("Must reject");
      }),
    ),
    failure("invalid_input"),
  );
});

test("preflight stale etag, recurrence target and malformed identity block writes", async () => {
  for (const changed of [
    { ...single(), etag: '"new"' },
    { ...single(), recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] },
    { ...single(), id: "another-event" },
  ]) {
    const q = queue([response(changed)]);
    await assert.rejects(
      execute("calendar.events.update", good("calendar.events.update"), ctx(q.request)),
    );
    assert.equal(q.calls.length, 1);
    assert.equal(q.calls[0]!.method, "GET");
  }
});

test("If-Match 412 rejects without rebase, refresh, clone or retry", async () => {
  const q = queue([response(single()), response({ error: { code: 412 } }, 412)]);
  await assert.rejects(
    execute("calendar.events.update", good("calendar.events.update"), ctx(q.request)),
    failure("version_conflict"),
  );
  assert.deepEqual(
    q.calls.map((request) => request.method),
    ["GET", "PATCH"],
  );
  assert.deepEqual(q.calls[1]!.headers, { "If-Match": '"fixture-event-1"' });
});

test("create response loss checks original stable ID, no alternate account or second insert", async () => {
  let saved: Obj = {};
  const wanted = good("calendar.events.create").event as Obj;
  const q = queue([new Error("response lost"), response({ ...wanted, id: EVENT_ID })]);
  const output = (await execute(
    "calendar.events.create",
    good("calendar.events.create"),
    ctx(q.request, {
      checkpoint: async (state) => {
        saved = clone(state);
      },
    }),
  )) as Obj;
  assert.deepEqual(
    q.calls.map((request) => request.method),
    ["POST", "GET"],
  );
  assert.equal(q.calls[1]!.path, `/calendars/primary/events/${EVENT_ID}`);
  assert.equal(saved.stage, "committed");
  assert.equal(output.outcome, "observed-satisfied");
});

test("uncertain create persists recovery and resume never re-inserts after unavailable lookup", async () => {
  let saved: Obj = {};
  const q = queue([new Error("lost"), response({}, 404)]);
  await assert.rejects(
    execute(
      "calendar.events.create",
      good("calendar.events.create"),
      ctx(q.request, {
        checkpoint: async (state) => {
          saved = clone(state);
        },
      }),
    ),
    failure("result_unknown"),
  );
  assert.equal(saved.stage, "dispatching");
  const resume = queue([response({}, 404)]);
  await assert.rejects(
    execute(
      "calendar.events.create",
      good("calendar.events.create"),
      ctx(resume.request, { recovery: saved }),
    ),
    failure("result_unknown"),
  );
  assert.deepEqual(
    resume.calls.map((request) => request.method),
    ["GET"],
  );
  const wrong = ctx(
    async () => {
      throw new Error("Must not request");
    },
    { recovery: saved },
  );
  wrong.principal.subject = "another-subject";
  await assert.rejects(
    execute("calendar.events.create", good("calendar.events.create"), wrong),
    failure("version_conflict"),
  );
  await assert.rejects(
    execute(
      "calendar.events.create",
      { ...good("calendar.events.create"), calendarId: "another-calendar" },
      ctx(
        async () => {
          throw new Error("Must not request");
        },
        { recovery: saved },
      ),
    ),
    failure("version_conflict"),
  );
});

test("update response loss reads exact changed fields and leaves mismatch unknown", async () => {
  const args = good("calendar.events.update");
  const q = queue([
    response(single()),
    new Error("lost"),
    response({ ...single(), summary: (args.changes as Obj).summary }),
  ]);
  const output = (await execute("calendar.events.update", args, ctx(q.request))) as Obj;
  assert.equal(output.outcome, "observed-satisfied");
  assert.deepEqual(
    q.calls.map((request) => request.method),
    ["GET", "PATCH", "GET"],
  );
  const mismatch = queue([response(single()), new Error("lost"), response(single())]);
  await assert.rejects(
    execute("calendar.events.update", args, ctx(mismatch.request)),
    failure("result_unknown"),
  );
});

test("delete 404 readback remains uncertain and never claims cancellation delivery", async () => {
  const q = queue([
    response({ ...single(), organizer: { self: false, email: "organizer@example.test" } }),
    new Error("lost"),
    response({}, 404),
  ]);
  await assert.rejects(
    execute(
      "calendar.events.delete",
      { ...good("calendar.events.delete"), expectedSemantics: "remove_calendar_copy" },
      ctx(q.request),
    ),
    (error) =>
      failure("result_unknown")(error) &&
      (error as NativeActionError).options.recovery?.semantics === "remove_calendar_copy",
  );
  assert.deepEqual(
    q.calls.map((request) => request.method),
    ["GET", "DELETE", "GET"],
  );
});

test("own RSVP rejects shared calendar and ambiguous/missing self identity", async () => {
  await assert.rejects(
    execute(
      "calendar.events.respond",
      { ...good("calendar.events.respond"), calendarId: "shared@example.test" },
      ctx(async () => {
        throw new Error("Must reject");
      }),
    ),
    failure("invalid_input"),
  );
  for (const attendees of [
    [],
    [{ email: "other@example.test", self: false }],
    [
      { email: "a@example.test", self: true },
      { email: "b@example.test", self: true },
    ],
  ]) {
    const q = queue([response({ ...single(), attendees })]);
    await assert.rejects(
      execute("calendar.events.respond", good("calendar.events.respond"), ctx(q.request)),
      failure("resource_unavailable"),
    );
    assert.equal(q.calls.length, 1);
  }
});

test("move type guard, no fabricated If-Match/body, uncertainty reads both calendars", async () => {
  const args = good("calendar.events.move"),
    q = queue([response({ ...single(), eventType: "focusTime" })]);
  await assert.rejects(
    execute("calendar.events.move", args, ctx(q.request)),
    failure("invalid_input"),
  );
  assert.equal(q.calls.length, 1);
  const lost = queue([
    response(single()),
    new Error("lost"),
    response({}, 404),
    response({ ...single(), organizer: { self: true, email: args.destination } }),
  ]);
  await assert.rejects(
    execute("calendar.events.move", args, ctx(lost.request)),
    failure("result_unknown"),
  );
  assert.deepEqual(
    lost.calls.map((request) => request.method),
    ["GET", "POST", "GET", "GET"],
  );
  assert.equal(lost.calls[1]!.body, undefined);
  assert.equal(lost.calls[1]!.headers, undefined);
  assert.equal(
    lost.calls[3]!.path,
    `/calendars/${encodeURIComponent(String(args.destination))}/events/fixtureevent001`,
  );
});

test("import response loss matching iCalUID is not causal proof and never auto-reimports", async () => {
  const args = good("calendar.events.import");
  let saved: Obj = {};
  const q = queue([
    new Error("lost"),
    response({
      items: [
        {
          ...(args.event as Obj),
          id: "pre-existing-copy",
          iCalUID: args.iCalUID,
          eventType: "default",
        },
      ],
    }),
  ]);
  await assert.rejects(
    execute(
      "calendar.events.import",
      args,
      ctx(q.request, {
        checkpoint: async (state) => {
          saved = clone(state);
        },
      }),
    ),
    (error) =>
      failure("result_unknown")(error) &&
      (
        (error as NativeActionError).options.recovery?.candidateIds as string[] | undefined
      )?.includes("pre-existing-copy"),
  );
  assert.deepEqual(
    q.calls.map((request) => request.method),
    ["POST", "GET"],
  );
  assert.equal(q.calls[0]!.query, undefined);
  assert.equal((q.calls[0]!.body as Obj).id, undefined);
  const retry = queue([response({ items: [] })]);
  await assert.rejects(
    execute("calendar.events.import", args, ctx(retry.request, { recovery: saved })),
    failure("result_unknown"),
  );
  assert.deepEqual(
    retry.calls.map((request) => request.method),
    ["GET"],
  );
});

test("checkpoint failure before dispatch prevents mutation; auth errors never refresh-loop", async () => {
  let requests = 0;
  await assert.rejects(
    execute(
      "calendar.events.create",
      good("calendar.events.create"),
      ctx(
        async () => {
          requests++;
          throw new Error("Must not request");
        },
        {
          checkpoint: async () => {
            throw new Error("fence closed");
          },
        },
      ),
    ),
  );
  assert.equal(requests, 0);
  const q = queue([response({}, 401)]);
  await assert.rejects(
    execute("calendar.events.get", good("calendar.events.get"), ctx(q.request)),
    failure("authorization_expired"),
  );
  assert.equal(q.calls.length, 1);
});

test("Google quota 403 differs from missing scope, preserving retry-after on 429", async () => {
  const quota = ctx(async () =>
    response({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403),
  );
  await assert.rejects(
    execute("calendar.events.get", good("calendar.events.get"), quota),
    failure("rate_limited"),
  );
  const limited = ctx(async () => ({
    status: 429,
    body: {},
    headers: new Headers({ "retry-after": "30" }),
  }));
  await assert.rejects(
    execute("calendar.events.get", good("calendar.events.get"), limited),
    (error) =>
      failure("rate_limited")(error) &&
      (error as NativeActionError).options.retryAfterSeconds === 30,
  );
});

test("durable committed ACK is a receipt; later resource changes do not reclassify or replay the write", async () => {
  for (const id of [
    "calendar.events.create",
    "calendar.events.update",
    "calendar.events.delete",
    "calendar.events.respond",
    "calendar.events.move",
    "calendar.events.import",
  ]) {
    const fixture = row(id).fixtures[0]! as unknown as { input: Obj; upstream: Step[] };
    let saved: Obj = {};
    let index = 0;
    await execute(
      id,
      clone(fixture.input),
      ctx(
        async () => {
          const step = fixture.upstream[index++];
          assert.ok(step, `Unexpected request: ${id}`);
          return response(step.response.body, step.response.status);
        },
        {
          checkpoint: async (state) => {
            saved = clone(state);
          },
        },
      ),
    );
    assert.equal(saved.stage, "committed");
    let requests = 0;
    const result = (await execute(
      id,
      clone(fixture.input),
      ctx(
        async () => {
          requests++;
          throw new Error("Resource is now inaccessible");
        },
        { recovery: saved },
      ),
    )) as Obj;
    assert.ok(["succeeded", "deleted"].includes(String(result.outcome)), id);
    assert.equal(requests, 0, `${id}: a durable ACK receipt requires no new mutation/read`);
  }
});

test("moving an existing recurring series keeps explicit recurrence timezone requirements", async () => {
  const args = {
    ...good("calendar.events.update"),
    targetKind: "series",
    changes: {
      start: { dateTime: "2026-10-20T10:00:00+08:00" },
      end: { dateTime: "2026-10-20T10:30:00+08:00" },
    },
  };
  const q = queue([response({ ...single(), recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] })]);
  await assert.rejects(
    execute("calendar.events.update", args, ctx(q.request)),
    failure("invalid_input"),
  );
  assert.deepEqual(
    q.calls.map((request) => request.method),
    ["GET"],
  );
});

test("free/busy cannot infer an omitted calendar is free, including expanded groups", async () => {
  const args = good("calendar.freebusy.query");
  const missing = (await execute(
    "calendar.freebusy.query",
    args,
    ctx(async () => response({ calendars: {} })),
  )) as Obj;
  assert.equal(missing.partial, true);
  assert.deepEqual(
    missing.unresolvedRequestedIds,
    (args.items as Obj[]).map((item) => item.id),
  );
  await assert.rejects(
    execute(
      "calendar.freebusy.query",
      { ...args, items: [{ id: "group@example.test" }] },
      ctx(async () =>
        response({
          calendars: {},
          groups: { "group@example.test": { calendars: ["member@example.test"] } },
        }),
      ),
    ),
    failure("incomplete_response"),
  );
});

test("page inventory completion does not imply private fields or attendee completeness", async () => {
  const output = (await execute(
    "calendar.events.search",
    good("calendar.events.search"),
    ctx(async () =>
      response({
        items: [
          { id: "private", status: "confirmed", attendeesOmitted: true },
          { id: "cancelled", status: "cancelled" },
        ],
      }),
    ),
  )) as Obj;
  assert.equal(output.allPagesRead, true);
  assert.deepEqual(output.visibilityLimitedEventIds, ["private"]);
  assert.deepEqual(output.attendeesIncompleteEventIds, ["private"]);
});
