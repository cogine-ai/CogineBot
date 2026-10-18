import {
  NativeEventObservationSchema,
  type NativeRoutineEventSpec,
  NativeRoutineEventSpecSchema,
  nativeEventApp,
  nativeEventResource,
} from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { NativeActionContext } from "../action.js";
import type { NativeOAuthStore } from "../oauth.js";
import { nativeEventReadPermitted } from "./authorization.js";
import {
  emitRemainingObservation,
  readRemainingEvent,
  remainingObservation,
} from "./remaining-readers.js";
import type { RemainingEventSpec, RemainingReadApi } from "./remaining-transport.js";
import { NativeEventResourceVerifier } from "./resource-verifier.js";
import { nativeObservationMatches } from "./store.js";
import type { NativeSourceReadContext } from "./worker.js";

const BOT = "123456789012345678",
  APP = "223456789012345678",
  GUILD = "323456789012345678",
  CHANNEL = "423456789012345678",
  COMMAND = "523456789012345678";
const scope = { userId: "fixture-owner", spaceId: "fixture-space" };
const specs: RemainingEventSpec[] = [
  { kind: "sharepoint.list_item.changed", siteId: "site", listId: "list" },
  {
    kind: "excel.range.changed",
    driveId: "drive",
    itemId: "workbook",
    worksheetId: "sheet",
    address: "A1:B2",
  },
  { kind: "planner.task.changed", planId: "plan" },
  { kind: "teams.channel_message.created", teamId: "team", channelId: "channel" },
  { kind: "feishu.calendar_event.changed", calendarId: "calendar" },
  {
    kind: "dingtalk.calendar_event.changed",
    userId: "ding-user",
    calendarId: "calendar",
    timeMin: "2026-10-18T00:00:00Z",
    timeMax: "2026-10-19T00:00:00Z",
  },
  { kind: "wecom.schedule.changed", calendarId: "calendar" },
  { kind: "telegram.pinned_message.changed", chatId: "-100123456" },
  { kind: "discord.channel_message.created", channelId: CHANNEL },
  {
    kind: "discord.command.invoked",
    guildId: GUILD,
    channelId: CHANNEL,
    commandId: COMMAND,
    commandName: "review",
  },
];

function context(
  spec: NativeRoutineEventSpec,
  emit = vi.fn(async () => true),
): NativeSourceReadContext {
  return {
    scope,
    signal: new AbortController().signal,
    heartbeat: vi.fn(async () => {}),
    emit,
    row: {
      id: "trigger",
      routineId: "routine",
      connectionId: "connection",
      authorizationRevision: "authorization",
      grantId: "grant",
      authGeneration: 1,
      configId: "config",
      configRevision: 1,
      version: 1,
      kind: spec.kind,
      resourceType: nativeEventResource(spec).type,
      resourceId: nativeEventResource(spec).id,
      spec,
      armedAt: new Date("2026-10-17T00:00:00Z"),
      state: { ready: true },
      leaseId: "lease",
      leaseUntil: new Date(Date.now() + 120000),
      nextPollAt: new Date(),
    },
  };
}
function principal(spec: RemainingEventSpec): NativeActionContext["principal"] {
  const app = nativeEventApp(spec),
    bot = app === "discord" || app === "telegram-bot",
    enterprise = ["feishu-lark", "dingtalk", "wecom"].includes(app);
  return {
    subject: bot ? BOT : "user",
    tenant: bot ? (app === "discord" ? GUILD : null) : "tenant",
    scopes: [],
    capabilities: ["read", "commands"],
    knowledgeBaseIds: [],
    context: bot
      ? {
          actorType: "bot",
          credentialType: "bot_token",
          scopeAuthority: "provider_enforced",
          botId: BOT,
          boundSpaceId: scope.spaceId,
          applicationId: APP,
          interactionPublicKey: "a".repeat(64),
          bindingNamespace: "guild",
          verifiedTargets: [
            {
              id: app === "discord" ? CHANNEL : "-100123456",
              ...(app === "discord" ? { guildId: GUILD } : {}),
            },
          ],
        }
      : enterprise
        ? {
            provider: app,
            tenantId: "tenant",
            appId: "external-app",
            actorType: "app",
            credentialType: "machine_key",
            region: "feishu",
          }
        : { actorType: "user", credentialType: "oauth", tenantId: "tenant" },
  };
}
const requiredScopes: Record<string, string[]> = {
  sharepoint: ["Sites.Read.All"],
  excel: ["Files.ReadWrite"],
  planner: ["Tasks.Read"],
  teams: ["ChannelMessage.Read.All", "Channel.ReadBasic.All"],
  "feishu-lark": ["calendar:calendar:readonly"],
};
function response(spec: RemainingEventSpec, path: string): unknown {
  switch (spec.kind) {
    case "sharepoint.list_item.changed":
      return { id: path.endsWith("/lists/list") ? "list" : "site" };
    case "excel.range.changed":
      return path.includes("range(")
        ? { address: "Sheet!A1:B2", rowCount: 2, columnCount: 2 }
        : path.endsWith("/worksheets/sheet")
          ? { id: "sheet" }
          : {
              id: "workbook",
              parentReference: { driveId: "drive" },
              file: {
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              },
            };
    case "planner.task.changed":
      return { id: "plan" };
    case "teams.channel_message.created":
      return { id: "channel" };
    case "feishu.calendar_event.changed":
      return { code: 0, data: { calendar: { calendar_id: "calendar" } } };
    case "dingtalk.calendar_event.changed":
      return { response: { calendars: [{ id: "calendar" }] } };
    case "wecom.schedule.changed":
      return { errcode: 0, calendar_list: [{ cal_id: "calendar" }] };
    case "telegram.pinned_message.changed":
      return {
        ok: true,
        result: path.endsWith("/getMe")
          ? { id: Number(BOT), is_bot: true }
          : path.endsWith("/getChat")
            ? { id: -100123456, type: "private" }
            : { user: { id: Number(BOT), is_bot: true }, status: "member" },
      };
    default:
      if (path.endsWith("/users/@me")) return { id: BOT, bot: true };
      if (path.endsWith(`/channels/${CHANNEL}`))
        return { id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [] };
      if (path.endsWith(`/members/${BOT}`)) return { user: { id: BOT }, roles: [] };
      if (path.endsWith("/roles")) return [{ id: GUILD, permissions: "66560" }];
      if (path.endsWith("/oauth2/applications/@me")) return { id: APP, bot: { id: BOT } };
      return { id: COMMAND, application_id: APP, guild_id: GUILD, type: 1, name: "review" };
  }
}
function fixture(
  spec: RemainingEventSpec,
  mutate?: (bound: Bound, n: number) => void,
  upstream?: (path: string, call: number) => unknown,
) {
  const p = principal(spec),
    app = nativeEventApp(spec),
    calls: Array<{ url: URL; headers: Headers; method: string; body: unknown }> = [];
  // Telegram identities are numeric and safe; Discord snowflakes remain strings.
  if (app === "telegram-bot") {
    p.subject = "123456";
    p.context.botId = "123456";
  }
  const scopes = requiredScopes[app] ?? [];
  type Bound = Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
  const bound = {
    connection: {
      id: "connection",
      ...scope,
      connectorId: "native",
      provider: app,
      metadata: { authRevision: "authorization" },
    },
    config: {
      id: "config",
      revision: 1,
      appId: app,
      credentialKind: ["dingtalk", "wecom", "feishu-lark"].includes(app)
        ? "machine_key"
        : app === "discord" || app === "telegram-bot"
          ? "bot_token"
          : "oauth",
      config: {
        scopes,
        capabilities: p.capabilities,
        knowledgeBaseIds: [],
        region: "feishu",
        ...(app === "discord" || app === "telegram-bot"
          ? {
              boundSpaceId: scope.spaceId,
              targetIds: app === "discord" ? [CHANNEL] : ["-100123456"],
              tenantId: app === "discord" ? GUILD : undefined,
            }
          : {}),
      },
    },
    grant: {
      id: "grant",
      authGeneration: 1,
      tokenVersion: 1,
      subject: p.subject,
      tenant: p.tenant,
      scopes,
      principal: p.context,
    },
    auth: {
      tokens: { accessToken: app === "telegram-bot" ? "123456:fixture-token" : "fixture-access" },
      identity: { subject: p.subject, tenant: p.tenant, context: p.context },
    },
  } as unknown as Bound;
  let checks = 0,
    forced = 0;
  const rejectCredential = vi.fn(async () => {});
  const oauth = {
    rejectCredential,
    authorization: async (_connectionId?: string, _context?: unknown, force = false) => {
      if (force) {
        forced++;
        bound.auth.tokens.accessToken = "fixture-refreshed";
        bound.grant.tokenVersion = 2;
      }
      mutate?.(bound, ++checks);
      return structuredClone(bound);
    },
  };
  const verifier = new NativeEventResourceVerifier(oauth, {
    network: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        calls.push({
          url,
          headers: new Headers(init?.headers),
          method: String(init?.method),
          body: init?.body,
        });
        let body = upstream
          ? upstream(decodeURIComponent(url.pathname), calls.length)
          : response(spec, decodeURIComponent(url.pathname));
        if (app === "telegram-bot")
          body = {
            ok: true,
            result: url.pathname.endsWith("/getMe")
              ? { id: 123456, is_bot: true }
              : { id: -100123456, type: "private" },
          };
        return new Response(JSON.stringify(body));
      },
    },
  });
  return { bound, verifier, calls, forced: () => forced, rejectCredential };
}
type Bound = Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
for (const spec of specs) {
  it(`${spec.kind} has an explicit intent/resource and rejects missing or hidden execution fields`, () => {
    expect(NativeRoutineEventSpecSchema.parse(spec)).toEqual(spec);
    expect(
      NativeRoutineEventSpecSchema.safeParse({ ...spec, authorizationRevision: "forged" }).success,
    ).toBe(false);
    const { kind, ...fields } = spec;
    const first = Object.keys(fields)[0]!;
    expect(NativeRoutineEventSpecSchema.safeParse({ ...spec, [first]: "" }).success).toBe(false);
    expect(nativeEventApp(spec)).toBeTruthy();
    expect(nativeEventResource(spec).id).toBeTruthy();
  });
  it(`${spec.kind} verifies the actual selected resource on fixed authenticated HTTP and returns a credential-free proof`, async () => {
    const f = fixture(spec);
    const result = await f.verifier.prepare(
      scope,
      { connectionId: "connection", spec },
      new AbortController().signal,
    );
    expect(result.proof.resource).toEqual(nativeEventResource(spec));
    expect(result.proof.grantId).toBe("grant");
    expect(JSON.stringify(result)).not.toContain("fixture-access");
    expect(f.calls.length).toBeGreaterThan(0);
    if (spec.kind.startsWith("wecom.")) {
      expect(f.calls[0]!.method).toBe("POST");
      expect(f.calls[0]!.url.searchParams.get("access_token")).toBe("fixture-access");
      expect(f.calls[0]!.headers.get("authorization")).toBeNull();
    } else if (spec.kind.startsWith("dingtalk."))
      expect(f.calls[0]!.headers.get("x-acs-dingtalk-access-token")).toBe("fixture-access");
    else if (spec.kind.startsWith("discord."))
      expect(f.calls[0]!.headers.get("authorization")).toBe("Bot fixture-access");
    else if (spec.kind.startsWith("telegram."))
      expect(f.calls[0]!.url.pathname.startsWith("/bot123456:fixture-token/")).toBe(true);
    else expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer fixture-access");
  });
  it(`${spec.kind} refuses changed authorization generation before the resource HTTP request`, async () => {
    const f = fixture(spec, (bound, n) => {
      if (n > 1) bound.grant.authGeneration = 2;
    });
    await expect(
      f.verifier.prepare(scope, { connectionId: "connection", spec }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.calls).toHaveLength(0);
  });
}
it("the new bridge accepts an already-enqueued permanent duplicate without changing the old worker boolean meaning", async () => {
  const ctx = context(
    specs[0]!,
    vi.fn(async () => false),
  );
  await expect(
    emitRemainingObservation(ctx, {
      eventIdentity: "identity",
      observedVersion: "v1",
      occurredAt: new Date().toISOString(),
      metadata: { siteId: "site", listId: "list", itemId: "item" },
    }),
  ).resolves.toBe(true);
  expect(ctx.emit).toHaveBeenCalledTimes(1);
});
it("an enqueue/claim failure propagates before a leaf can advance its cursor", async () => {
  const ctx = context(
    specs[0]!,
    vi.fn(async () => {
      throw new Error("durable queue failed");
    }),
  );
  await expect(
    emitRemainingObservation(ctx, {
      eventIdentity: "identity",
      observedVersion: "v1",
      occurredAt: new Date().toISOString(),
    }),
  ).rejects.toThrow("durable queue failed");
});
it("Microsoft and enterprise first baselines set the existing durable ready fence and remain silent", async () => {
  for (const spec of [specs[2]!, specs[4]!, specs[6]!]) {
    const ctx = context(spec),
      p = principal(spec),
      api = {
        get: async () =>
          spec.kind.startsWith("planner.")
            ? { value: [] }
            : { code: 0, data: { items: [], has_more: false } },
        post: async () => ({ errcode: 0, schedule_list: [] }),
        request: vi.fn(),
      } as unknown as RemainingReadApi;
    const result = await readRemainingEvent(ctx, api, p);
    expect(result.state.ready).toBe(true);
    expect(ctx.emit).not.toHaveBeenCalled();
  }
});
it("selected resource metadata remains part of the existing observation fence", () => {
  const spec = specs[0]!,
    ctx = context(spec);
  const observation = remainingObservation(ctx, {
    eventIdentity: "identity",
    observedVersion: "v1",
    occurredAt: new Date().toISOString(),
    metadata: { siteId: "site", listId: "list", itemId: "item" },
  });
  expect(NativeEventObservationSchema.safeParse(observation).success).toBe(true);
  expect(nativeObservationMatches(ctx.row, observation, new Date())).toBe(true);
  expect(
    nativeObservationMatches(
      ctx.row,
      { ...observation, sourceMetadata: { siteId: "other", listId: "list", itemId: "item" } },
      new Date(),
    ),
  ).toBe(false);
  expect(
    nativeObservationMatches(
      ctx.row,
      { ...observation, evidence: "visible_state_change" },
      new Date(),
    ),
  ).toBe(false);
});
it("Feishu enrollment requires the actual calendar metadata permission and Teams requires channel metadata permission", () => {
  const principal = {
    provider: "feishu-lark",
    appId: "app",
    tenantId: "tenant",
    actorType: "user",
    credentialType: "oauth",
    region: "feishu",
  };
  expect(nativeEventReadPermitted(specs[4]!, ["calendar:calendar.event:read"], [], principal)).toBe(
    false,
  );
  expect(nativeEventReadPermitted(specs[4]!, ["calendar:calendar:readonly"], [], principal)).toBe(
    true,
  );
  expect(nativeEventReadPermitted(specs[3]!, ["ChannelMessage.Read.All"], [], {})).toBe(false);
  expect(
    nativeEventReadPermitted(
      specs[3]!,
      ["ChannelMessage.Read.All", "Channel.ReadBasic.All"],
      [],
      {},
    ),
  ).toBe(true);
});
it("DingTalk requires an ordered explicit interval and Discord commands require exact numeric identities", () => {
  expect(
    NativeRoutineEventSpecSchema.safeParse({ ...specs[5], timeMax: "2026-10-17T00:00:00Z" })
      .success,
  ).toBe(false);
  expect(
    NativeRoutineEventSpecSchema.safeParse({ ...specs[9], commandId: "name-instead-of-id" })
      .success,
  ).toBe(false);
});

it("Feishu HTTP200 token rejection refreshes the exact generation once and retries this read with the new token", async () => {
  const spec = specs[4]!,
    f = fixture(spec, undefined, (path, n) =>
      n === 1 ? { code: 99991663, msg: "fixture rejected credential" } : response(spec, path),
    );
  await f.verifier.prepare(
    scope,
    { connectionId: "connection", spec },
    new AbortController().signal,
  );
  expect(f.forced()).toBe(1);
  expect(f.calls).toHaveLength(2);
  expect(f.calls.map((call) => call.headers.get("authorization"))).toEqual([
    "Bearer fixture-access",
    "Bearer fixture-refreshed",
  ]);
  expect(f.rejectCredential).not.toHaveBeenCalled();
});
it("a second definitive enterprise credential rejection retires only the tokenVersion used for that request", async () => {
  const spec = specs[4]!,
    f = fixture(spec, undefined, () => ({ code: 99991663, msg: "fixture rejected credential" }));
  await expect(
    f.verifier.prepare(scope, { connectionId: "connection", spec }, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "authorization_expired" });
  expect(f.forced()).toBe(1);
  expect(f.calls).toHaveLength(2);
  expect(f.rejectCredential).toHaveBeenCalledWith("connection", expect.objectContaining(scope), 2);
});
