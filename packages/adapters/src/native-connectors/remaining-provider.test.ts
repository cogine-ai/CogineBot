import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectedConnector,
  ConnectorEvent,
} from "@rakazo/adapter-kit";
import { NativeRemainingAppIdSchema, remainingNativeProfile } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, it as test, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import type { NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import { principal as botPrincipal } from "./bot-platforms/testing.js";
import type { NativeOAuthStore } from "./oauth.js";
import { NativeConnectorProvider } from "./provider.js";

type Data = Record<string, unknown>;
interface Step {
  request: NativeRequest;
  response: { status: number; body: unknown; headers?: Record<string, string> };
}
interface Case {
  app: string;
  id: string;
  input: Data;
  steps: Step[];
  base: string;
  group: "microsoft" | "work-management" | "business-files" | "enterprise" | "bot-platforms";
}
const json = (path: string): Data =>
  JSON.parse(readFileSync(new URL(path, import.meta.url)).toString()) as Data;
const base: Record<string, string> = {
  "outlook-mail": "https://graph.microsoft.com/v1.0",
  "outlook-calendar": "https://graph.microsoft.com/v1.0",
  onedrive: "https://graph.microsoft.com/v1.0",
  "microsoft-todo": "https://graph.microsoft.com/v1.0",
  sharepoint: "https://graph.microsoft.com/v1.0",
  excel: "https://graph.microsoft.com/v1.0",
  planner: "https://graph.microsoft.com/v1.0",
  teams: "https://graph.microsoft.com/v1.0",
  gitlab: "https://gitlab.fixture.example.test/api/v4",
  jira: "https://api.atlassian.com/ex/jira/fixture-cloud",
  confluence: "https://api.atlassian.com/ex/confluence/fixture-cloud",
  todoist: "https://api.todoist.com/api/v1",
  trello: "https://api.trello.com/1",
  asana: "https://app.asana.com/api/1.0",
  clickup: "https://api.clickup.com",
  airtable: "https://api.airtable.com",
  dropbox: "https://api.dropboxapi.com",
  hubspot: "https://api.hubapi.com",
  figma: "https://api.figma.com",
  "feishu-lark": "https://open.feishu.cn/open-apis",
  dingtalk: "https://api.dingtalk.com",
  wecom: "https://qyapi.weixin.qq.com/cgi-bin",
  "telegram-bot": "https://api.telegram.org",
  discord: "https://discord.com/api/v10",
};
const cases: Case[] = [];
for (const [group, apps] of [
  ["work-management", ["gitlab", "jira", "confluence", "todoist", "trello", "asana"]],
  ["business-files", ["clickup", "airtable", "dropbox", "hubspot", "figma"]],
  ["bot-platforms", ["telegram-bot", "discord"]],
] as const)
  for (const app of apps) {
    const rows = json(`./${group}/${app}.test-fixtures.json`).fixtures as Data[],
      contract = json(`./${group}/${app}.contract.json`).actions as Data[];
    const f = rows.find((f) => contract.find((a) => a.id === f.id)?.readOnly === true)!;
    cases.push({
      app,
      id: String(f.id),
      input: f.input as Data,
      steps: (f.steps ?? f.upstream) as Step[],
      base: base[app]!,
      group,
    });
  }
const ms = json("./microsoft/action-fixtures.json") as unknown as Array<{
  app: string;
  id: string;
  input: Data;
  readOnly: boolean;
  steps: Array<{ method: NativeRequest["method"]; path: string; body: unknown; status: number }>;
}>;
for (const app of [
  "outlook-mail",
  "outlook-calendar",
  "onedrive",
  "microsoft-todo",
  "sharepoint",
  "excel",
  "planner",
  "teams",
]) {
  const f = ms.find((f) => f.app === app && f.readOnly)!;
  cases.push({
    app,
    id: f.id,
    input: f.input,
    base: base[app]!,
    group: "microsoft",
    steps: f.steps.map((s, i) => ({
      request: {
        method: s.method,
        path: s.path,
        ...(s.path.endsWith("createSession") ? { body: { persistChanges: false } } : {}),
        ...(i > 0 && app === "excel"
          ? { headers: { "workbook-session-id": "session-fixture" } }
          : {}),
        ...(s.method === "GET" && !["sharepoint", "excel", "teams"].includes(app)
          ? {
              query: {
                $top: 25,
                ...(app === "outlook-mail"
                  ? {
                      $select:
                        "id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,conversationId,webLink",
                    }
                  : {}),
              },
            }
          : {}),
      },
      response: { status: s.status, body: s.body },
    })),
  });
}
// Exact existing enterprise protocol cases from enterprise/actions.test.ts, linked to the frozen contracts.
for (const row of [
  {
    app: "feishu-lark",
    id: "feishu.documents.content.get",
    input: { documentId: "doc-fixture" },
    request: { method: "GET", path: "/docx/v1/documents/doc-fixture/raw_content" },
    body: { code: 0, data: { content: "Fixture document" } },
  },
  {
    app: "dingtalk",
    id: "dingtalk.calendars.list",
    input: { userId: "user-fixture" },
    request: { method: "GET", path: "/v1.0/calendar/users/user-fixture/calendars" },
    body: { response: { calendars: [{ id: "calendar-fixture" }] } },
  },
  {
    app: "wecom",
    id: "wecom.members.get",
    input: { userId: "user-fixture" },
    request: { method: "GET", path: "/user/get", query: { userid: "user-fixture" } },
    body: { errcode: 0, userid: "user-fixture" },
  },
])
  cases.push({
    app: row.app,
    id: row.id,
    input: row.input,
    steps: [{ request: row.request as NativeRequest, response: { status: 200, body: row.body } }],
    base: base[row.app]!,
    group: "enterprise",
  });

const open: NativeConnectorProvider[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
  vi.restoreAllMocks();
});
function setup(
  testCase: Case,
  extra: {
    region?: "lark";
    endpoint?: string;
    credentialKind?: string;
    actor?: string;
    configuredScopes?: string[];
    grantedScopes?: string[];
  } = {},
) {
  const f = structuredClone(testCase),
    selected: ConnectedConnector = {
      id: "fixture-connection-a",
      connectorId: "native",
      externalId: f.app,
      displayName: "Fixture account A",
      providerRef: "fixture-grant-a",
      revision: "fixture-grant-a:1",
    };
  const context: AdapterContext = {
    userId: "fixture-user-a",
    spaceId: "fixture-space",
    botId: "fixture-bot",
    operationId: "fixture-operation",
    traceId: "fixture-trace",
    signal: new AbortController().signal,
    connectedConnections: [selected],
  };
  const profile = remainingNativeProfile(f.app)!;
  const staticUser = ["clickup", "figma", "todoist"].includes(f.app),
    bot = f.group === "bot-platforms",
    enterprise = f.group === "enterprise";
  const credentialKind =
    extra.credentialKind ??
    (staticUser ? "personal_token" : bot ? "bot_token" : enterprise ? "machine_key" : "oauth");
  const configuredScopes =
    extra.configuredScopes ?? [...profile.scopes].filter((s) => s !== "default");
  const grantedScopes =
    extra.grantedScopes ?? (staticUser || bot || enterprise ? [] : [...configuredScopes]);
  const actor = extra.actor ?? (bot ? "bot" : enterprise ? "app" : "user"),
    tenant =
      f.group === "microsoft"
        ? "fixture-tenant"
        : ["jira", "confluence"].includes(f.app)
          ? "fixture-cloud"
          : enterprise
            ? "tenant-fixture"
            : f.app === "discord"
              ? "100003"
              : f.app === "hubspot"
                ? "hub1"
                : null;
  const identityContext: Data = bot
    ? botPrincipal(f.app as "telegram-bot" | "discord").context
    : {
        actorType: actor,
        credentialType: credentialKind,
        ...(f.group === "business-files"
          ? {
              businessFilesApp: f.app,
              ...(f.app === "clickup" ? { workspaceIds: ["W1"] } : {}),
              ...(f.app === "hubspot"
                ? { hubId: tenant, hubspotAccessLevel: actor === "user" ? "user" : "account" }
                : {}),
              ...(staticUser ? { scopeAuthority: "provider_enforced" } : {}),
            }
          : {}),
        ...(f.group === "microsoft" ? { tenantId: tenant } : {}),
        ...(["jira", "confluence"].includes(f.app) ? { cloudId: tenant } : {}),
        ...(enterprise
          ? {
              provider: f.app,
              appId: "client-fixture",
              tenantId: tenant,
              region: extra.region ?? "feishu",
              agentId: "1000001",
              scopeAuthority: "provider_enforced",
            }
          : {}),
      };
  const subject = bot ? "100001" : "fixture-user",
    token = f.app === "telegram-bot" ? "100001:fixture-access" : "fixture-access";
  const live = {
    connection: {
      id: selected.id,
      userId: context.userId,
      spaceId: context.spaceId,
      provider: f.app,
      providerRef: selected.providerRef,
      displayName: selected.displayName,
      metadata: { authRevision: selected.revision },
      nativeConfigRevision: 1,
    },
    config: {
      id: "fixture-config",
      appId: f.app,
      credentialKind,
      ownership: "byo",
      enabled: true,
      revision: 1,
      callbackUri: "https://api.example.test/api/connectors/oauth/callback",
      config: {
        clientId: "client-fixture",
        actor,
        scopes: configuredScopes,
        capabilities: bot ? ["read"] : [],
        knowledgeBaseIds: [],
        ...(tenant ? { tenantId: tenant } : {}),
        ...(f.app === "gitlab"
          ? { endpoint: extra.endpoint ?? "https://gitlab.fixture.example.test" }
          : {}),
        ...(enterprise || bot ? { boundSpaceId: context.spaceId } : {}),
        ...(f.app === "feishu-lark" ? { region: extra.region ?? "feishu" } : {}),
        ...(f.app === "wecom" ? { agentId: "1000001" } : {}),
        ...(bot ? { targetIds: [f.app === "discord" ? "100004" : "-1001234567890"] } : {}),
      },
    },
    grant: {
      id: selected.providerRef,
      userId: context.userId,
      spaceId: context.spaceId,
      configRevision: 1,
      subject,
      tenant,
      scopes: grantedScopes,
      tokenVersion: 1,
    },
    auth: {
      tokens: { accessToken: token, refreshToken: null },
      scopes: grantedScopes,
      expiresAt: null,
      identity: {
        authority: f.base,
        subject,
        tenant,
        displayName: selected.displayName,
        context: identityContext,
      },
    },
  } as unknown as Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
  let index = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const step = f.steps[index++]!;
    assert.ok(step, "No unplanned HTTP request");
    const url = new URL(String(input)),
      prefix =
        extra.region === "lark" && f.app === "feishu-lark"
          ? "https://open.larksuite.com/open-apis"
          : extra.endpoint && f.app === "gitlab"
            ? `${extra.endpoint}/api/v4`
            : f.base;
    assert.equal(
      url.origin + url.pathname,
      prefix + (f.app === "telegram-bot" ? `/bot${token}` : "") + step.request.path,
    );
    assert.equal(init?.method, step.request.method);
    const h = new Headers(init?.headers);
    assert.equal(
      h.get("authorization"),
      ["dingtalk", "wecom", "telegram-bot", "figma"].includes(f.app) && credentialKind !== "oauth"
        ? null
        : f.app === "discord"
          ? `Bot ${token}`
          : f.app === "clickup" && credentialKind === "personal_token"
            ? token
            : `Bearer ${token}`,
    );
    if (f.app === "figma" && credentialKind === "personal_token")
      assert.equal(h.get("x-figma-token"), token);
    if (f.app === "dingtalk") assert.equal(h.get("x-acs-dingtalk-access-token"), token);
    if (["outlook-mail", "outlook-calendar"].includes(f.app))
      assert.equal(h.get("prefer"), 'IdType="ImmutableId"');
    for (const [k, v] of Object.entries(step.request.headers ?? {})) assert.equal(h.get(k), v);
    for (const [k, v] of Object.entries(step.request.query ?? {}))
      assert.equal(url.searchParams.get(k), String(v));
    assert.equal(url.searchParams.get("access_token"), f.app === "wecom" ? token : null);
    if (step.request.body !== undefined)
      assert.deepEqual(JSON.parse(String(init?.body)), step.request.body);
    else assert.equal(init?.body, undefined);
    return new Response(step.response.status === 204 ? null : JSON.stringify(step.response.body), {
      status: step.response.status,
      headers: { "content-type": "application/json", ...step.response.headers },
    });
  });
  const provider = new NativeConnectorProvider(
    {} as PrismaClient,
    new EncryptedSecretStore("fixture-provider-key"),
    "https://api.example.test",
    {
      artifacts: {
        get: async () => {
          throw Error("No artifact forwarding");
        },
      } as unknown as ArtifactStore,
      network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    },
  );
  open.push(provider);
  const authorization = vi
    .spyOn(provider.oauth, "authorization")
    .mockImplementation(async (id, ctx) => {
      assert.equal(id, selected.id);
      if (ctx.spaceId !== context.spaceId || ctx.userId !== context.userId)
        throw new NativeActionError(
          "authorization_required",
          "Exact synthetic OAuth owner/Space fence",
        );
      return live;
    });
  const tools = async () => provider.discoverTools(context);
  const collect = async (
    tool: Awaited<ReturnType<typeof tools>>[number],
    ctx = context,
    selectedId?: string,
  ) => {
    const events: ConnectorEvent[] = [];
    for await (const event of provider.execute(
      {
        tool: tool.name,
        route: tool.route,
        args: f.input,
        executionId: "fixture-provider-read",
        ...(selectedId ? { connectionId: selectedId } : {}),
      },
      ctx,
    ))
      events.push(event);
    return events;
  };
  return {
    f,
    selected,
    context,
    live,
    provider,
    fetch,
    authorization,
    tools,
    collect,
    get calls() {
      return index;
    },
  };
}

test("actual native catalog registers all 24 remaining applications", async () => {
  assert.deepEqual(cases.map((c) => c.app).sort(), [...NativeRemainingAppIdSchema.options].sort());
  const s = setup(cases[0]!);
  vi.spyOn(s.provider.oauth, "expireSessions").mockResolvedValue();
  vi.spyOn(s.provider, "listConnectedExternalIds").mockResolvedValue([]);
  vi.spyOn(s.provider.configurations, "statuses").mockResolvedValue([]);
  const catalog = await s.provider.catalog(s.context);
  for (const app of NativeRemainingAppIdSchema.options)
    assert.equal(catalog.filter((row) => row.slug === app).length, 1);
});
for (const f of cases)
  test(`${f.app}: actual provider discovery, exact account and native HTTP execute ${f.id}`, async () => {
    const s = setup(f),
      tool = (await s.tools()).find((t) => t.route?.toolName === f.id);
    assert.ok(tool, "Representative action must be wired and discoverable");
    assert.equal(tool.readOnly, true);
    assert.equal(tool.route?.connectionId, s.selected.id);
    assert.equal(tool.route?.resourceId, f.app);
    const events = await s.collect(tool);
    assert.equal(events.at(-1)?.type, "result", JSON.stringify(events));
    assert.equal(s.calls, f.steps.length);
    assert.ok(s.authorization.mock.calls.every(([id]) => id === s.selected.id));
  });
for (const app of ["outlook-mail", "jira", "todoist", "hubspot"])
  test(`${app}: configured and actual permission intersection controls provider discovery`, async () => {
    const f = cases.find((c) => c.app === app)!;
    const noPolicy = setup(f, { configuredScopes: [] });
    assert.equal(
      (await noPolicy.tools()).some((t) => t.route?.toolName === f.id),
      false,
    );
    assert.equal(noPolicy.fetch.mock.calls.length, 0);
    if (app !== "todoist") {
      const noActual = setup(f, { credentialKind: "oauth", grantedScopes: [] });
      assert.equal(
        (await noActual.tools()).some((t) => t.route?.toolName === f.id),
        false,
      );
      assert.equal(noActual.fetch.mock.calls.length, 0);
    }
  });
test("Feishu user OAuth regional selection routes the actual action to Lark", async () => {
  const s = setup(cases.find((c) => c.app === "feishu-lark")!, {
    region: "lark",
    credentialKind: "oauth",
    actor: "user",
    grantedScopes: ["docx:document:readonly"],
  });
  const tool = (await s.tools()).find((t) => t.route?.toolName === s.f.id)!;
  assert.ok(tool);
  const events = await s.collect(tool);
  assert.equal(events.at(-1)?.type, "result", JSON.stringify(events));
  assert.equal(s.calls, 1);
});
test("GitLab default public authority is selected independently of the custom-origin fixture", async () => {
  const s = setup(cases.find((c) => c.app === "gitlab")!, { endpoint: "https://gitlab.com" });
  const tool = (await s.tools()).find((t) => t.route?.toolName === s.f.id)!;
  assert.equal((await s.collect(tool)).at(-1)?.type, "result");
});
test("provider never replaces an exact selected account after its OAuth boundary fails", async () => {
  const s = setup(cases.find((c) => c.app === "jira")!),
    tool = (await s.tools()).find((t) => t.route?.toolName === s.f.id)!;
  s.context.connectedConnections!.push({
    ...s.selected,
    id: "fixture-sibling-account",
    providerRef: "fixture-sibling-grant",
  });
  s.authorization.mockClear();
  s.authorization.mockRejectedValue(
    new NativeActionError("authorization_expired", "Synthetic selected account expired"),
  );
  const events = await s.collect(tool);
  assert.deepEqual(
    s.authorization.mock.calls.map(([id]) => id),
    [s.selected.id],
  );
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(s.fetch.mock.calls.length, 0);
});
test("provider passes exact owner/Space to OAuth and refuses conflicting call account before HTTP", async () => {
  const s = setup(cases.find((c) => c.app === "discord")!),
    tool = (await s.tools()).find((t) => t.route?.toolName === s.f.id)!;
  assert.equal(
    (await s.collect(tool, { ...s.context, spaceId: "foreign-space" })).at(-1)?.type,
    "error",
  );
  s.authorization.mockClear();
  assert.equal((await s.collect(tool, s.context, "fixture-sibling-account")).at(-1)?.type, "error");
  assert.equal(s.authorization.mock.calls.length, 0);
  assert.equal(s.fetch.mock.calls.length, 0);
});
test("provider rejects a changed authorization generation or config revision without HTTP", async () => {
  const s = setup(cases.find((c) => c.app === "asana")!),
    tool = (await s.tools()).find((t) => t.route?.toolName === s.f.id)!;
  s.live.connection.metadata = { authRevision: "fixture-grant-a:2" };
  assert.equal((await s.collect(tool)).at(-1)?.type, "error");
  s.authorization.mockRejectedValue(
    new NativeActionError("not_configured", "Synthetic real-store configRevision fence"),
  );
  const events = await s.collect(tool);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(s.fetch.mock.calls.length, 0);
});
