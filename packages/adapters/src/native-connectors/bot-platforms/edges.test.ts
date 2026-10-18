import assert from "node:assert/strict";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { it as test, vi } from "vitest";
import type { Data } from "../collaboration-action.js";
import { DiscordAttachmentDownloads } from "./download.js";
import { botPlatformApps } from "./index.js";
import { CHANNEL, context, type Fixture, failure, GUILD, response, suites } from "./testing.js";

function harness(id: string) {
  const app = id.startsWith("telegram.") ? "telegram-bot" : "discord",
    f = structuredClone((suites[app].fixtures as Fixture[]).find((f) => f.id === id)!),
    action = botPlatformApps.find((a) => a.slug === app)!.actions.find((a) => a.id === id)!;
  let i = 0,
    writes = 0;
  const requests: unknown[] = [],
    receipts: Data[] = [];
  const ctx = context(
    app,
    async (r) => {
      requests.push(r);
      if (r.method !== "GET") writes++;
      const step = f.steps[i++];
      assert.ok(step);
      return response(step);
    },
    receipts,
  );
  return {
    f,
    action,
    ctx,
    requests,
    receipts,
    get writes() {
      return writes;
    },
    run: () => action.execute(f.input, ctx),
  };
}
for (const platform of ["telegram", "discord"] as const)
  test(`${platform}: foreign configured target is rejected before target access`, async () => {
    const h = harness(platform === "telegram" ? "telegram.messages.send" : "discord.messages.send");
    h.f.input[platform === "telegram" ? "chat_id" : "channel_id"] =
      platform === "telegram" ? "-100099" : "100099";
    await assert.rejects(h.run(), failure("insufficient_scope"));
    assert.equal(h.writes, 0);
    assert.ok(h.requests.length <= 1);
  });
for (const id of ["telegram.messages.send", "discord.messages.send"])
  test(`${id}: token identity changed before target read`, async () => {
    const h = harness(id);
    const first = h.f.steps[0]!.response.body as Data;
    if (id.startsWith("telegram")) (first.result as Data).id = 100099;
    else first.id = "100099";
    await assert.rejects(h.run(), failure("authorization_expired"));
    assert.equal(h.writes, 0);
    assert.equal(h.requests.length, 1);
  });
for (const [name, buttons] of [
  ["insecure URL", [[{ text: "Go", url: "http://example.test" }]]],
  ["credential URL", [[{ text: "Go", url: "https://user:pass@example.test" }]]],
  ["callback field", [[{ text: "Go", url: "https://example.test", callback_data: "unproven" }]]],
] as const)
  test(`Telegram URL buttons reject ${name} before write`, async () => {
    const h = harness("telegram.messages.send");
    h.f.input.buttons = buttons;
    await assert.rejects(h.run(), failure("invalid_input"));
    assert.equal(h.writes, 0);
  });
for (const [name, change] of [
  [
    "foreign chat",
    (r: Data) => {
      (r.chat as Data).id = 100099;
    },
  ],
  [
    "foreign actor",
    (r: Data) => {
      (r.from as Data).id = 100099;
    },
  ],
  [
    "omitted message ID",
    (r: Data) => {
      delete r.message_id;
    },
  ],
] as const)
  test(`Telegram acknowledged send with ${name} remains unknown and does not replay`, async () => {
    const h = harness("telegram.messages.send");
    change((h.f.steps.at(-1)!.response.body as Data).result as Data);
    await assert.rejects(h.run(), failure("result_unknown"));
    assert.equal(h.writes, 1);
    h.ctx.recovery = h.receipts.at(-1);
    await assert.rejects(h.run(), failure("result_unknown"));
    assert.equal(h.writes, 1);
  });
test("Telegram pinned action validates chat identity, not only outer getChat", async () => {
  const h = harness("telegram.pinned.get");
  (((h.f.steps[1]!.response.body as Data).result as Data).pinned_message as Data).chat = {
    id: 100099,
  };
  await assert.rejects(h.run(), failure("incomplete_response"));
});
test("Telegram false deletion acknowledgement cannot mark confirmed", async () => {
  const h = harness("telegram.messages.delete");
  h.f.steps.at(-1)!.response.body = { ok: true, result: false };
  await assert.rejects(h.run(), failure("result_unknown"));
  assert.equal(h.writes, 1);
});
for (const size of [0, ATTACHMENT_MAX_BYTES + 1])
  test(`Telegram file size ${size} stops before upload`, async () => {
    const h = harness("telegram.files.send");
    h.ctx.readArtifact = async () => ({
      bytes: new Uint8Array(size),
      name: "fixture.txt",
      mimeType: "text/plain",
    });
    await assert.rejects(h.run(), failure("invalid_input"));
    assert.equal(h.writes, 0);
  });
for (const id of ["discord.messages.delete", "discord.reactions.create"])
  test(`${id}: only documented 204 proves completion`, async () => {
    const h = harness(id);
    h.f.steps.at(-1)!.response.status = 200;
    await assert.rejects(h.run(), failure("result_unknown"));
    assert.equal(h.writes, 1);
  });
test("Discord edits require actual current bot ownership; attachments are preserved by omitted field", async () => {
  const h = harness("discord.messages.update");
  (h.f.steps[4]!.response.body as Data).author = { id: "100099" };
  await assert.rejects(h.run(), failure("insufficient_scope"));
  assert.equal(h.writes, 0);
  const valid = harness("discord.messages.update");
  await valid.run();
  const req = valid.requests.at(-1) as { body: Data };
  assert.deepEqual(req.body.allowed_mentions, { parse: [] });
  assert.equal("attachments" in req.body, false);
});
test("Discord deleting someone else's message requires MANAGE_MESSAGES while own deletion does not", async () => {
  const h = harness("discord.messages.delete");
  (h.f.steps[4]!.response.body as Data).author = { id: "100099" };
  (h.f.steps[3]!.response.body as Data[])[0]!.permissions = String(1024 + 65536);
  await assert.rejects(h.run(), failure("insufficient_scope"));
  assert.equal(h.writes, 0);
  const own = harness("discord.messages.delete");
  (own.f.steps[3]!.response.body as Data[])[0]!.permissions = String(1024 + 65536);
  await own.run();
  assert.equal(own.writes, 1);
});
test("Discord file send reads Space artifact, checks ATTACH_FILES and disables all mentions", async () => {
  const h = harness("discord.messages.send");
  h.f.input.artifactId = "fixture-artifact";
  h.f.input.reply_to = "100020";
  await h.run();
  const req = h.requests.at(-1) as { body: FormData };
  assert.ok(req.body instanceof FormData);
  const data = JSON.parse(String(req.body.get("payload_json"))) as Data;
  assert.deepEqual(data.allowed_mentions, { parse: [] });
  assert.deepEqual(data.attachments, [{ id: 0, filename: "fixture.txt" }]);
  assert.deepEqual(data.message_reference, {
    message_id: "100020",
    channel_id: CHANNEL,
    guild_id: GUILD,
    fail_if_not_exists: true,
  });
  assert.equal(await (req.body.get("files[0]") as Blob).text(), "abc");
  const denied = harness("discord.messages.send");
  denied.f.input.artifactId = "fixture-artifact";
  (denied.f.steps[3]!.response.body as Data[])[0]!.permissions = String(1024 + 2048);
  await assert.rejects(denied.run(), failure("insufficient_scope"));
  assert.equal(denied.writes, 0);
});
for (const [name, change] of [
  [
    "attachment belongs to different ID",
    (r: Data) => {
      r.id = "100099";
    },
  ],
  [
    "external file URL",
    (r: Data) => {
      r.url = "https://untrusted.example/file";
    },
  ],
  [
    "different channel URL",
    (r: Data) => {
      r.url = "https://cdn.discordapp.com/attachments/100099/100006/file";
    },
  ],
  [
    "oversized file",
    (r: Data) => {
      r.size = ATTACHMENT_MAX_BYTES + 1;
    },
  ],
] as const)
  test(`Discord attachment proof rejects ${name} before download`, async () => {
    const h = harness("discord.attachments.download");
    change(((h.f.steps[4]!.response.body as Data).attachments as Data[])[0]!);
    let downloads = 0;
    h.ctx.downloadResource = async () => {
      downloads++;
      throw Error("No unproved file");
    };
    await assert.rejects(h.run());
    assert.equal(downloads, 0);
  });
test("Discord attachment byte mismatch cannot create a partial artifact", async () => {
  const h = harness("discord.attachments.download");
  h.ctx.downloadResource = async () => ({ bytes: new Uint8Array(2), mimeType: "text/plain" });
  let writes = 0;
  h.ctx.writeArtifact = async () => {
    writes++;
    throw Error("No truncated artifact");
  };
  await assert.rejects(h.run(), failure("incomplete_response"));
  assert.equal(writes, 0);
});
for (const [name, change] of [
  [
    "another application",
    (r: Data) => {
      r.application_id = "100099";
    },
  ],
  [
    "another guild",
    (r: Data) => {
      r.guild_id = "100099";
    },
  ],
] as const)
  test(`Discord existing commands from ${name} block upsert`, async () => {
    const h = harness("discord.commands.upsert");
    change((h.f.steps[5]!.response.body as Data[])[0]!);
    await assert.rejects(h.run(), failure("incomplete_response"));
    assert.equal(h.writes, 0);
  });
for (const [name, options] of [
  [
    "duplicate names",
    [
      { name: "topic", type: 3, description: "Topic" },
      { name: "topic", type: 3, description: "Topic" },
    ],
  ],
  [
    "required after optional",
    [
      { name: "optional", type: 3, description: "Optional" },
      { name: "required", type: 3, description: "Required", required: true },
    ],
  ],
] as const)
  test(`Discord command ${name} cannot dispatch`, async () => {
    const h = harness("discord.commands.upsert");
    h.f.input.options = options;
    await assert.rejects(h.run(), failure("invalid_input"));
    assert.equal(h.writes, 0);
  });
test("Discord wrong acknowledged command guild is unknown; command capability must be explicitly enabled", async () => {
  const h = harness("discord.commands.upsert");
  (h.f.steps.at(-1)!.response.body as Data).guild_id = "100099";
  await assert.rejects(h.run(), failure("result_unknown"));
  const disabled = harness("discord.commands.upsert");
  disabled.ctx.principal.capabilities = ["read", "send"];
  await assert.rejects(disabled.run(), failure("insufficient_scope"));
  assert.equal(disabled.requests.length, 0);
});
const url =
  "https://cdn.discordapp.com/attachments/100004/100006/fixture.txt?ex=fixture&hm=fixture";
function downloads(
  responseValue: Response | (() => Response) = new Response("abc", {
    headers: { "content-type": "text/plain", "content-length": "3" },
  }),
) {
  let checks = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), url);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(init?.redirect, "manual");
    return typeof responseValue === "function" ? responseValue() : responseValue;
  });
  const transport = new DiscordAttachmentDownloads(
    async () => {
      checks++;
    },
    new AbortController().signal,
    { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
  );
  return {
    transport,
    fetch,
    get checks() {
      return checks;
    },
  };
}
test("Discord CDN download is credential-free, bounded and revalidates immediately", async () => {
  const h = downloads();
  try {
    const out = await h.transport.download({ url, maxBytes: 3 });
    assert.equal(new TextDecoder().decode(out.bytes), "abc");
    assert.equal(out.mimeType, "text/plain");
    assert.equal(h.checks, 1);
    assert.equal(h.fetch.mock.calls.length, 1);
  } finally {
    await h.transport.close();
  }
});
for (const bad of [
  "http://cdn.discordapp.com/attachments/100004/100006/file",
  "https://evil.example/attachments/100004/100006/file",
  "https://cdn.discordapp.com.evil.example/attachments/100004/100006/file",
  "https://user:pass@cdn.discordapp.com/attachments/100004/100006/file",
  "https://cdn.discordapp.com/attachments/100004/100006/%ZZ",
  "https://cdn.discordapp.com/attachments/100004/100006/%2e%2e/file",
  "https://cdn.discordapp.com/other/100004/100006/file",
])
  test(`Discord CDN rejects untrusted boundary ${bad}`, async () => {
    const h = downloads();
    try {
      await assert.rejects(
        h.transport.download({ url: bad, maxBytes: 3 }),
        failure("invalid_input"),
      );
      assert.equal(h.fetch.mock.calls.length, 0);
      assert.equal(h.checks, 0);
    } finally {
      await h.transport.close();
    }
  });
for (const [name, res] of [
  ["declared oversized", () => new Response("abc", { headers: { "content-length": "4" } })],
  ["stream oversized", () => new Response("abcd")],
  [
    "redirect",
    () => new Response(null, { status: 302, headers: { location: "https://untrusted.example" } }),
  ],
] as const)
  test(`Discord CDN ${name} does not follow or truncate`, async () => {
    const h = downloads(res);
    try {
      await assert.rejects(h.transport.download({ url, maxBytes: 3 }));
      assert.equal(h.fetch.mock.calls.length, 1);
    } finally {
      await h.transport.close();
    }
  });
