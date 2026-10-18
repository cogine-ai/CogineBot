import assert from "node:assert/strict";
import { afterEach, it as test, vi } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./gmail.contract.json" with { type: "json" };
import { gmailActions } from "./gmail.js";
import fixtures from "./gmail.test-fixtures.json" with { type: "json" };

type Obj = Record<string, unknown>;
const scopes = (values: string[]) =>
  values.map((value) => `https://www.googleapis.com/auth/${value}`);
const actions = new Map(gmailActions.map((action) => [action.id, action]));
const response = (body: unknown, status = 200): NativeResponse => ({
  body: structuredClone(body),
  status,
  headers: new Headers(),
});
function context(
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
): NativeActionContext {
  return {
    operationId: "fixture-operation-001",
    signal: new AbortController().signal,
    principal: {
      subject: "fixture-google-sub",
      tenant: null,
      scopes: scopes(["gmail.modify"]),
      capabilities: [],
      knowledgeBaseIds: [],
      context: { email: "owner@example.test" },
    },
    checkpoint: async () => {},
    request,
    readArtifact: async () => ({
      bytes: Buffer.from("Hello"),
      name: "fixture.txt",
      mimeType: "text/plain",
    }),
    writeArtifact: async ({ bytes, name, mimeType }) => ({
      id: "artifact-fixture",
      name,
      mimeType,
      size: bytes.length,
    }),
    callMcp: async () => {
      throw new Error("Unexpected MCP");
    },
    validateResourceUrl: async () => {
      throw new Error("Unexpected URL");
    },
    ...extra,
  };
}
function subset(expected: unknown, actual: unknown): void {
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
    for (const [key, value] of Object.entries(expected)) subset(value, (actual as Obj)[key]);
    return;
  }
  assert.deepEqual(actual, expected);
}
const failure = (kind: string) => (error: unknown) =>
  error instanceof NativeActionError && error.kind === kind;
const row = (id: string) => fixtures.actions.find((value) => value.id === id)!;
const execute = (id: string, args: Obj, ctx: NativeActionContext) =>
  actions.get(id)!.execute(args, ctx);
afterEach(() => vi.restoreAllMocks());

test("Gmail exposes the frozen 16 action IDs, scopes, schemas and effects", () => {
  assert.equal(actions.size, 16);
  assert.deepEqual(
    [...actions.keys()],
    contract.actions.map((value) => value.id),
  );
  for (const row of contract.actions) {
    const actual = actions.get(row.id)!;
    assert.deepEqual(actual.inputSchema, row.inputSchema);
    assert.deepEqual(actual.scopesAnyOf, row.authorization.acceptedAnyOfScopes);
    assert.equal(actual.readOnly, row.readOnly);
  }
});
for (const value of fixtures.actions) {
  test(`Gmail frozen protocol: ${value.id}`, async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(value.context.now));
    const f = value as unknown as {
      input: Obj;
      requests: NativeRequest[];
      responses: { status: number; body: unknown }[];
      expectedOutput: unknown;
    };
    let at = 0;
    const checkpoints: Obj[] = [];
    const result = await execute(
      value.id,
      structuredClone(f.input),
      context(
        async (request) => {
          assert.deepEqual(request, f.requests[at]);
          const reply = f.responses[at++];
          assert.ok(reply);
          return response(reply.body, reply.status);
        },
        {
          checkpoint: async (state) => {
            checkpoints.push(structuredClone(state));
          },
        },
      ),
    );
    assert.equal(at, f.responses.length);
    subset(f.expectedOutput, result);
    if (!actions.get(value.id)!.readOnly) {
      assert.equal(checkpoints[0]!.stage, "prepared");
      assert.ok(checkpoints.some((checkpoint) => checkpoint.stage === "dispatching"));
      assert.equal(checkpoints.at(-1)!.stage, "committed");
      assert.ok(!JSON.stringify(checkpoints).includes('"raw":'));
    }
  });
  test(`Gmail rejects credentials in business input: ${value.id}`, async () => {
    await assert.rejects(
      execute(
        value.id,
        value.rejectedInput as Obj,
        context(async () => {
          throw new Error("Must not request");
        }),
      ),
      failure("invalid_input"),
    );
  });
}
test("Gmail repeats labelIds query fields without comma joining", async () => {
  await execute(
    "gmail.messages.search",
    { labelIds: ["INBOX", "UNREAD"] },
    context(async (request) => {
      assert.deepEqual(request.query?.labelIds, ["INBOX", "UNREAD"]);
      return response({});
    }),
  );
});
test("Gmail metadata/send/labels-only scopes cannot read or alter mailbox content", async () => {
  for (const [id, scope, input] of [
    ["gmail.messages.search", "gmail.metadata", {}],
    ["gmail.messages.get", "gmail.send", { messageId: "m1" }],
    ["gmail.messages.modify", "gmail.labels", { messageId: "m1", removeLabelIds: ["UNREAD"] }],
    ["gmail.drafts.send", "gmail.send", { draftId: "d1", expectedMessageId: "m1" }],
  ] as const) {
    const ctx = context(async () => {
      throw new Error("Must not request");
    });
    ctx.principal.scopes = scopes([scope]);
    await assert.rejects(execute(id, input, ctx), failure("insufficient_scope"));
  }
});
test("Gmail send-only cannot fetch an original message to manufacture a reply", async () => {
  const ctx = context(async () => {
    throw new Error("Must not request");
  });
  ctx.principal.scopes = scopes(["gmail.send"]);
  await assert.rejects(
    execute("gmail.messages.reply", row("gmail.messages.reply").input as Obj, ctx),
    failure("insufficient_scope"),
  );
});
test("Gmail rejects stale draft message identity before mutation", async () => {
  let reads = 0;
  await assert.rejects(
    execute(
      "gmail.drafts.update",
      row("gmail.drafts.update").input as Obj,
      context(async (request) => {
        assert.equal(request.method, "GET");
        reads++;
        return response({ id: "d1", message: { id: "changed" } });
      }),
    ),
    failure("version_conflict"),
  );
  assert.equal(reads, 1);
});
test("Gmail lost send acknowledgement and effect recovery never resend", async () => {
  let receipt: Obj = {},
    calls = 0;
  const args = row("gmail.messages.send").input as Obj;
  const ctx = context(
    async () => {
      calls++;
      throw new Error("fixture lost acknowledgement");
    },
    {
      checkpoint: async (state) => {
        receipt = structuredClone(state);
      },
    },
  );
  await assert.rejects(execute("gmail.messages.send", args, ctx), failure("result_unknown"));
  assert.equal(calls, 1);
  assert.equal(receipt.stage, "dispatching");
  await assert.rejects(
    execute("gmail.messages.send", args, { ...ctx, recovery: receipt }),
    failure("result_unknown"),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    execute(
      "gmail.messages.send",
      { message: { ...(args.message as Obj), text: "changed" } },
      { ...ctx, recovery: receipt },
    ),
    failure("version_conflict"),
  );
});
test("Gmail malformed send acknowledgement is unknown, not success", async () => {
  await assert.rejects(
    execute(
      "gmail.messages.send",
      row("gmail.messages.send").input as Obj,
      context(async () => response({})),
    ),
    failure("result_unknown"),
  );
});
test("Gmail verified sending identity is required even with send scope", async () => {
  const ctx = context(async () => {
    throw new Error("Must not request");
  });
  ctx.principal.context = {};
  await assert.rejects(
    execute("gmail.messages.send", row("gmail.messages.send").input as Obj, ctx),
    failure("not_configured"),
  );
});
test("Gmail MIME keeps Bcc, Reply-To, UTF-8 subject, alternatives and artifact attachments", async () => {
  await execute(
    "gmail.messages.send",
    {
      message: {
        to: ["target@example.test"],
        bcc: ["hidden@example.test"],
        replyTo: "reply@example.test",
        subject: "测试主题",
        text: "Text fixture",
        html: "<b>HTML fixture</b>",
        attachments: [{ artifactId: "artifact-source", filename: "测试.txt" }],
      },
    },
    context(async (request) => {
      const raw = Buffer.from(String((request.body as Obj).raw), "base64url").toString("utf8");
      assert.match(raw, /Bcc: hidden@example.test/);
      assert.match(raw, /Reply-To: reply@example.test/);
      assert.match(raw, /Subject: =\?UTF-8\?B\?/);
      assert.match(raw, /multipart\/mixed/);
      assert.match(raw, /multipart\/alternative/);
      assert.match(raw, /filename\*=UTF-8''%E6%B5%8B%E8%AF%95.txt/);
      assert.match(raw, /SGVsbG8=/);
      return response({ id: "sent1", threadId: "t1" });
    }),
  );
});
test("Gmail reads HTML as inert text, handles charset and reports truncation", async () => {
  const source = structuredClone(row("gmail.messages.get").responses[0]!.body) as Obj;
  source.payload = {
    partId: "0",
    mimeType: "text/html",
    headers: [{ name: "Content-Type", value: "text/html; charset=iso-8859-1" }],
    body: {
      data: Buffer.from([
        0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e,
      ]).toString("base64url"),
    },
  };
  const result = (await execute(
    "gmail.messages.get",
    { messageId: "m1", maxTextChars: 3 },
    context(async () => response(source)),
  )) as Obj;
  assert.equal(result.text, "caf");
  assert.equal(result.complete, false);
  assert.deepEqual(result.incompleteReasons, ["TEXT_TRUNCATED"]);
  (source.payload as Obj).body = {
    data: Buffer.from(
      '<script>bad()</script><img src="https://example.test/tracker"><p>Hello</p>',
    ).toString("base64url"),
  };
  const safe = (await execute(
    "gmail.messages.get",
    { messageId: "m1" },
    context(async () => response(source)),
  )) as Obj;
  assert.equal(safe.text, "Hello\n");
  assert.ok(!JSON.stringify(safe).includes("tracker"));
});
test("Gmail unknown charset never marks a message complete", async () => {
  const source = structuredClone(row("gmail.messages.get").responses[0]!.body) as Obj;
  source.payload = {
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: "text/plain; charset=fixture-unknown" }],
    body: { data: "SGVsbG8" },
  };
  const result = (await execute(
    "gmail.messages.get",
    { messageId: "m1" },
    context(async () => response(source)),
  )) as Obj;
  assert.equal(result.complete, false);
  assert.deepEqual(result.incompleteReasons, ["UNSUPPORTED_OR_INVALID_CHARSET"]);
});
test("Gmail inline attachments become artifacts without model-visible base64", async () => {
  const source = structuredClone(row("gmail.messages.get").responses[0]!.body) as Obj;
  source.payload = {
    partId: "1",
    filename: "inline.txt",
    mimeType: "text/plain",
    body: { size: 5, data: "SGVsbG8" },
  };
  let count = 0;
  const result = (await execute(
    "gmail.attachments.download",
    { messageId: "m1", partId: "1" },
    context(async () => {
      count++;
      return response(source);
    }),
  )) as Obj;
  assert.equal(count, 1);
  subset({ artifact: { id: "artifact-fixture" } }, result);
  assert.ok(!JSON.stringify(result).includes("SGVsbG8"));
});
test("Gmail wrong thread or ambiguous reply sender cannot dispatch", async () => {
  const source = structuredClone(row("gmail.messages.reply").responses[0]!.body) as Obj;
  source.threadId = "another-thread";
  await assert.rejects(
    execute(
      "gmail.messages.reply",
      row("gmail.messages.reply").input as Obj,
      context(async (request) => {
        assert.equal(request.method, "GET");
        return response(source);
      }),
    ),
    failure("version_conflict"),
  );
});

test("Gmail detached text body is explicitly incomplete instead of an empty complete email", async () => {
  const source = structuredClone(row("gmail.messages.get").responses[0]!.body) as Obj;
  source.payload = {
    partId: "0",
    mimeType: "text/plain",
    body: { size: 1000, attachmentId: "detached-body" },
  };
  const result = (await execute(
    "gmail.messages.get",
    { messageId: "m1" },
    context(async () => response(source)),
  )) as Obj;
  assert.equal(result.complete, false);
  assert.deepEqual(result.incompleteReasons, ["BODY_NOT_INLINE"]);
});
test("Gmail RFC encoded subject and folded recipient headers form one reply prefix", async () => {
  const source = structuredClone(row("gmail.messages.reply").responses[0]!.body) as Obj;
  const headers = (source.payload as Obj).headers as Obj[];
  headers.find((header) => header.name === "Subject")!.value =
    `=?UTF-8?B?${Buffer.from("Re: 测试").toString("base64")}?=`;
  headers.find((header) => header.name === "From")!.value =
    '"Fixture Sender"\r\n <sender@example.test>';
  const q: NativeRequest[] = [];
  const output = (await execute(
    "gmail.messages.reply",
    row("gmail.messages.reply").input as Obj,
    context(async (request) => {
      q.push(request);
      if (request.method === "GET") return response(source);
      const raw = Buffer.from(String((request.body as Obj).raw), "base64url").toString();
      assert.match(raw, /To: sender@example.test/);
      assert.ok(raw.includes(Buffer.from("Re: 测试").toString("base64")));
      return response({ id: "sent1", threadId: "t1" });
    }),
  )) as Obj;
  assert.equal(output.outcome, "succeeded");
  assert.equal(q.length, 2);
});

test("Gmail draft replacement preserves container identity and rejects an unchanged inner message", async () => {
  const f = row("gmail.drafts.update");
  let at = 0;
  await assert.rejects(
    execute(
      f.id,
      f.input as Obj,
      context(async () => {
        if (at++ === 0) return response(f.responses[0]!.body);
        return response({
          id: "d1",
          message: { id: "draft-message-before", threadId: "draft-thread", labelIds: ["DRAFT"] },
        });
      }),
    ),
    failure("result_unknown"),
  );
  assert.equal(at, 2);
});
test("Gmail draft sending returns a new sent message and does not reuse the unsent message ID", async () => {
  const f = row("gmail.drafts.send");
  let at = 0;
  await assert.rejects(
    execute(
      f.id,
      f.input as Obj,
      context(async () => {
        if (at++ === 0) return response(f.responses[0]!.body);
        return response({
          id: "draft-message-before",
          threadId: "draft-thread",
          labelIds: ["DRAFT"],
        });
      }),
    ),
    failure("result_unknown"),
  );
  assert.equal(at, 2);
});
test("Gmail detects malformed text bytes and unsupported encrypted MIME without claiming completeness", async () => {
  const source = structuredClone(row("gmail.messages.get").responses[0]!.body) as Obj;
  source.payload = { partId: "0", mimeType: "text/plain", body: { size: 9, data: "SGVsbG8" } };
  const mismatch = (await execute(
    "gmail.messages.get",
    { messageId: "m1" },
    context(async () => response(source)),
  )) as Obj;
  assert.equal(mismatch.complete, false);
  assert.deepEqual(mismatch.incompleteReasons, ["BODY_SIZE_MISMATCH"]);
  source.payload = {
    partId: "0",
    mimeType: "application/pkcs7-mime",
    filename: "smime.p7m",
    body: { size: 5, data: "SGVsbG8" },
  };
  const encrypted = (await execute(
    "gmail.messages.get",
    { messageId: "m1" },
    context(async () => response(source)),
  )) as Obj;
  assert.equal(encrypted.complete, false);
  assert.ok((encrypted.incompleteReasons as string[]).includes("ENCRYPTED_CONTENT"));
});
