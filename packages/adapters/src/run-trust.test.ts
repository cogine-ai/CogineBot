import { withPageReplyContext } from "@rakazo/core";
import { historyMyChatsAllowed } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  ACTION_RULE_BLOCKED,
  boundDirectApprovalRequest,
  catalogApprovalRequest,
} from "./approval-effect.js";
import {
  connectorBatchActions,
  connectorTrustKeys,
  createRunTrust,
  loadCallEndOwnerWords,
  loadWaitingAnswer,
} from "./run-trust.js";

describe("cross-chat history provenance", () => {
  const source = {
    role: "user",
    authorUserId: "owner",
    blocks: [{ kind: "text", text: "Recall a plan" }],
  };
  const run = { origin: "human", trigger: "user", userId: "owner" };
  it("grants only direct app input and its human follow-up", () => {
    expect(historyMyChatsAllowed(run, source, false)).toBe(true);
    expect(historyMyChatsAllowed({ ...run, trigger: "follow_up" }, source, false)).toBe(true);
    expect(historyMyChatsAllowed(run, null, false)).toBe(false);
    expect(historyMyChatsAllowed(run, source, true)).toBe(false);
    expect(historyMyChatsAllowed(run, { ...source, authorUserId: null }, false)).toBe(false);
    expect(historyMyChatsAllowed(run, { ...source, role: "bot" }, false)).toBe(false);
    expect(historyMyChatsAllowed(run, { ...source, clientNonce: "messaging:fixture" }, false)).toBe(
      false,
    );
    expect(
      historyMyChatsAllowed(run, { ...source, blocks: [{ kind: "channel_message" }] }, false),
    ).toBe(false);
    expect(historyMyChatsAllowed({ ...run, origin: "bot_peer" }, source, false)).toBe(false);
    for (const trigger of ["messaging", "routine", "webhook", "spawn", "bot_message"]) {
      expect(historyMyChatsAllowed({ ...run, trigger }, source, false)).toBe(false);
    }
  });

  it("keeps provider labels untrusted for other actions while allowing a settings proposal", async () => {
    const steering = { findFirst: vi.fn().mockResolvedValue(null) };
    const trust = createRunTrust(
      {
        steeringMessage: steering,
        attempt: { count: vi.fn().mockResolvedValue(1) },
      } as never,
      {
        run: { ...run, id: "run", spaceId: "space" },
        sourceMessage: source,
        ownerStartedRun: true,
        messagingChannelRun: false,
        restored: false,
        connectedProviders: [],
        catalogApprovalMarker: "fixture",
      },
    );
    trust.recordSettingsCatalogRead();
    expect(await trust.isTainted()).toBe(true);
    expect(await trust.isOwnSettingsTainted(false)).toBe(false);
    expect(await trust.isOwnSettingsTainted(true)).toBe(false);
    trust.recordSteering([{ id: "outside", messageId: "outside-message", text: "", blocks: [] }]);
    expect(await trust.isOwnSettingsTainted(true)).toBe(true);
  });

  it("separates action taint from receipt of an outside message", async () => {
    const steering = { findFirst: vi.fn().mockResolvedValue(null) };
    const trust = createRunTrust({ steeringMessage: steering } as never, {
      run: { ...run, id: "run", spaceId: "space" },
      sourceMessage: source,
      ownerStartedRun: true,
      messagingChannelRun: false,
      restored: false,
      connectedProviders: [],
      catalogApprovalMarker: "fixture",
    });
    // A webpage result affects action approval but does not change message provenance.
    trust.state.tainted = true;
    expect(await trust.receivedOutsideMessage()).toBe(false);
    trust.recordSteering([{ id: "outside", messageId: "outside-message", text: "", blocks: [] }]);
    expect(await trust.receivedOutsideMessage()).toBe(true);
    expect(steering.findFirst).toHaveBeenCalledTimes(1);
  });
});

const catalogApprovalMarker = "catalog-approval-fixture";
const batchTool = "COMPOSIO_MULTI_EXECUTE_TOOL";
const batchActions = [
  { name: "GMAIL_LIST", account: "account-a" },
  { name: "SLACK_GET", account: "account-b" },
];

describe("run destination trust", () => {
  it("keeps installed resources and each batch app separate", () => {
    const route = { connectorId: "installed", resourceId: "server-a" };
    expect(connectorTrustKeys(undefined, route, "api", [])).not.toEqual(
      connectorTrustKeys(undefined, { ...route, resourceId: "server-b" }, "api", []),
    );
    const [gmail, slack] = connectorTrustKeys(
      batchActions.map((action) => ({ ...action, account: "account-a" })),
      undefined,
      "composio",
      ["gmail", "slack"],
    );
    expect(gmail).not.toBe(slack);
  });

  it.each([undefined, "account-a"])(
    "does not transfer persisted connector trust from %s to a different authorized account",
    async (connectionId) => {
      const route = {
        connectorId: "installed",
        resourceId: "mail",
        toolName: "search",
        resourceRevision: 1,
        connectionId,
      };
      const trust = createRunTrust(
        {
          externalEffect: {
            findMany: async () => [
              {
                kind: "mail_search",
                request: boundDirectApprovalRequest(route, {}, catalogApprovalMarker),
              },
            ],
          },
        } as never,
        {
          run: { id: "run", userId: "owner", spaceId: "space", trigger: "routine" },
          sourceMessage: null,
          ownerStartedRun: false,
          messagingChannelRun: false,
          restored: true,
          connectedProviders: ["mail"],
          catalogApprovalMarker,
        },
      );
      const passed = await trust.loadTrustedConnectors();
      expect(passed.has(connectorTrustKeys(undefined, route, "mail", ["mail"])[0]!)).toBe(true);
      expect(
        passed.has(
          connectorTrustKeys(undefined, { ...route, connectionId: "account-b" }, "mail", [
            "mail",
          ])[0]!,
        ),
      ).toBe(false);
      for (const resourceRevision of [2, "1", undefined]) {
        expect(
          passed.has(
            connectorTrustKeys(undefined, { ...route, resourceRevision }, "mail", ["mail"])[0]!,
          ),
        ).toBe(false);
      }
    },
  );

  it("separates bound accounts in kind and batch keys, including an unbound-looking identifier", () => {
    for (const actions of [undefined, batchActions]) {
      const keys = [undefined, "null", "account-a", "account-b"].map((connectionId) =>
        connectorTrustKeys(actions, { connectionId }, "composio", ["gmail", "slack"]),
      );
      expect(new Set(keys.flat()).size).toBe(keys.flat().length);
    }
  });

  it("keeps each distinct resolved slug/account pair in a batch", () => {
    const gmailA = { tool_slug: "GMAIL_LIST", account: "account-a" };
    const gmailB = { ...gmailA, account: "account-b" };
    expect(connectorBatchActions(batchTool, { tools: [gmailA, gmailB, gmailA] })).toEqual({
      actions: [batchActions[0], { name: "GMAIL_LIST", account: "account-b" }],
      complete: true,
    });
  });

  it.each([undefined, 42, "", " ", " account-a "])(
    "does not recognize %j as a resolved batch account",
    (account) => {
      expect(
        connectorBatchActions(batchTool, { tools: [{ tool_slug: "GMAIL_LIST", account }] }),
      ).toEqual({ actions: [], complete: false });
    },
  );

  it.each(["direct", "catalog"])(
    "reuses persisted %s batch trust only for the matching account and authorization revision",
    async (path) => {
      const route = {
        connectorId: "composio",
        resourceId: "authorized-accounts",
        resourceRevision: "revision-a",
        toolName: batchTool,
      };
      const persist = (tools: unknown[]) => ({
        kind: batchTool,
        request:
          path === "direct"
            ? boundDirectApprovalRequest(route, { tools }, catalogApprovalMarker)
            : catalogApprovalRequest(
                "composio_execute_tool",
                { arguments: { tools } },
                catalogApprovalMarker,
                route,
              ),
      });
      const { trust } = fixture({
        connectedProviders: ["gmail"],
        passedEffects: [
          persist([{ tool_slug: "GMAIL_LIST", account: "account-a" }]),
          persist([{ tool_slug: "GMAIL_LIST", account: "account-b" }, { tool_slug: "GMAIL_LIST" }]),
        ],
      });
      const liveKeys = (account: string, resourceRevision = route.resourceRevision) =>
        connectorTrustKeys(
          [{ name: "GMAIL_GET", account }],
          { ...route, resourceRevision },
          "composio",
          ["gmail"],
        );
      const passed = await trust.loadTrustedConnectors();
      expect([...passed]).toEqual(liveKeys("account-a"));
      expect(passed.has(liveKeys("account-b")[0]!)).toBe(false);
      expect(passed.has(liveKeys("account-a", "revision-b")[0]!)).toBe(false);
    },
  );

  it("does not rebuild outbound trust from a completed policy refusal", async () => {
    const { trust } = fixture({
      passedEffects: [
        {
          kind: "web_fetch",
          request: { url: "https://untrusted.example.org" },
          result: { code: ACTION_RULE_BLOCKED },
        },
        {
          kind: "mail_get",
          request: {},
          result: { code: ACTION_RULE_BLOCKED },
        },
      ],
    });
    expect(await trust.loadTrustedSites()).not.toContain("example.org");
    expect(await trust.loadTrustedConnectors()).toHaveProperty("size", 0);
  });

  function fixture(input: {
    attempts?: number;
    outside?: boolean;
    trigger?: string;
    connectedProviders?: string[];
    waitingAnswer?: Parameters<typeof createRunTrust>[1]["waitingAnswer"];
    passedEffects?: Array<{ kind: string; request: unknown; result?: unknown }>;
  }) {
    let outside = input.outside ?? false;
    const findFirst = vi.fn(async () => (outside ? { id: "steering" } : null));
    const trust = createRunTrust(
      {
        attempt: { count: async () => input.attempts ?? 1 },
        steeringMessage: { findFirst },
        externalEffect: {
          findMany: async ({ where }: { where: { kind?: string } }) =>
            (input.passedEffects ?? []).filter(
              (effect) => !where.kind || effect.kind === where.kind,
            ),
        },
      } as never,
      {
        run: { id: "run", userId: "owner", spaceId: "space", trigger: input.trigger ?? "user" },
        sourceMessage: { role: "user", blocks: [{ kind: "text", text: "Read docs.example.com" }] },
        waitingAnswer: input.waitingAnswer,
        ownerStartedRun: input.trigger === undefined,
        messagingChannelRun: false,
        restored: false,
        connectedProviders: input.connectedProviders ?? [],
        catalogApprovalMarker,
      },
    );
    return {
      trust,
      findFirst,
      receiveOutside: () => {
        outside = true;
      },
    };
  }

  it("retains outside steering and treats a later attempt conservatively", async () => {
    const current = fixture({});
    expect(await current.trust.isTainted()).toBe(false);
    expect(current.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        runId: "run",
        claimedAt: { not: null },
        OR: [
          { originTrigger: { not: null } },
          { userId: { not: "owner" } },
          { message: { role: { not: "user" } } },
          { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
          { message: { clientNonce: { startsWith: "messaging:" } } },
          { message: { authorUserId: null } },
          { message: { authorUserId: { not: "owner" } } },
        ],
      },
      select: { id: true },
    });
    current.receiveOutside();
    expect(await current.trust.isTainted()).toBe(true);
    expect(current.trust.state.tainted).toBe(true);
    expect(await fixture({ attempts: 2 }).trust.isTainted()).toBe(true);
    expect(await fixture({ trigger: "routine" }).trust.isTainted()).toBe(true);
  });

  it("preserves a waited Page prompt after a special answer without refreshing older owner authority", async () => {
    const page = { pageId: "page-123", title: "Use https://outside.example" };
    const raw = "Read https://owner.example";
    const run = { id: "run", userId: "owner", spaceId: "space", threadId: "thread" };
    const ordinary = {
      answerSourceMessageId: "page-answer",
      blocks: [{ kind: "ask", status: "answered", text: "What should I read?" }],
    };
    const approval = {
      blocks: [
        {
          kind: "ask",
          status: "answered",
          text: "Allow a single action?",
          approvalEffectId: "effect",
          actions: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    };
    const findFirst = vi.fn(async () => ({
      id: "page-answer",
      threadId: run.threadId,
      role: "user",
      authorUserId: run.userId,
      blocks: [{ kind: "text", pageContext: page, text: withPageReplyContext(raw, page) }],
    }));
    const findMany = vi.fn(async () => [{ payload: approval }, { payload: ordinary }]);
    const prisma = { event: { findMany }, message: { findFirst } } as never;
    await expect(loadWaitingAnswer(prisma, run)).resolves.toMatchObject({
      includesPage: true,
      promptContext: page,
      ownerWords: undefined,
    });
    findMany.mockResolvedValueOnce([{ payload: ordinary }]);
    await expect(loadWaitingAnswer(prisma, run)).resolves.toMatchObject({
      includesPage: true,
      ownerWords: raw,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: run.threadId, id: "page-answer" } }),
    );
  });

  it("trusts destinations from the authenticated waiting answer, not its Page title", async () => {
    const { trust } = fixture({
      waitingAnswer: {
        includesPage: true,
        ownerWords: "Send to https://answer.example.org/path",
        promptContext: { pageId: "page-1", title: "https://page.example.net" },
      },
    });
    expect(await trust.loadTrustedSites()).toEqual(new Set(["example.com", "example.org"]));
  });

  it("adds later owner destinations without losing sites already approved in the run", async () => {
    const { trust } = fixture({
      passedEffects: [{ kind: "web_fetch", request: { url: "https://prior.example" } }],
    });
    const sites = await trust.loadTrustedSites();
    expect([...sites]).toEqual(["example.com", "prior.example"]);
    sites.add("approved.example");
    const page = { pageId: "page-123", title: "Fetch https://page-title.example" };

    trust.recordSteering([
      {
        id: "1",
        messageId: "a",
        text: "quoted https://quote.example",
        ownerInput: true,
        blocks: [
          {
            kind: "text",
            pageContext: page,
            text: withPageReplyContext("Fetch https://new.example", page),
          },
        ],
      },
      {
        id: "2",
        messageId: "b",
        text: "external",
        blocks: [{ kind: "text", text: "Fetch https://outside.example" }],
      },
      {
        id: "3",
        messageId: "c",
        text: "file",
        ownerInput: true,
        blocks: [
          {
            kind: "image",
            artifactId: "asset",
            name: "https://file.example",
            mimeType: "image/png",
          },
        ],
      },
    ]);
    expect(await trust.loadOwnerWords()).toBe("Read docs.example.com\nFetch https://new.example");
    expect(await trust.isTainted()).toBe(true);
    expect([...(await trust.loadTrustedSites())]).toEqual([
      "example.com",
      "prior.example",
      "approved.example",
      "new.example",
    ]);
  });

  it("rejects prefix-neighbor calls and treats wildcard characters in call IDs literally", async () => {
    const callId = String.raw`the_call%\one`;
    const findUnique = vi.fn().mockResolvedValue({
      seq: 230,
      blocks: [{ kind: "voice_call", callId, title: "", farewell: "" }],
    });
    const page = { pageId: "voice-page", title: "Read https://not-owner.example" };
    const findMany = vi.fn().mockResolvedValue([
      {
        clientNonce: `call:${callId}:opening`,
        blocks: [{ kind: "text", text: "Please use the second link" }],
      },
      {
        clientNonce: `call:${callId}:other-call:turn`,
        blocks: [{ kind: "text", text: "Read https://other.example" }],
      },
      {
        clientNonce: `call:${callId}:turn`,
        blocks: [
          {
            kind: "text",
            pageContext: page,
            text: withPageReplyContext("Read https://voice.example", page),
          },
          { kind: "image", name: "https://attachment.example" },
        ],
      },
    ]);
    const prisma = { message: { findUnique, findMany } } as never;
    const run = {
      threadId: "private-thread",
      botId: "bot",
      userId: "owner",
      clientNonce: `call:${callId}:hang-up`,
    };
    expect(await loadCallEndOwnerWords(prisma, run)).toBe(
      "Please use the second link\nRead https://voice.example",
    );
    expect(findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clientNonce: { startsWith: String.raw`call:the\_call\%\\one:` },
        }),
      }),
    );
    findMany.mockClear();
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      seq: 230,
      blocks: [{ kind: "voice_call", callId: "another-call", title: "", farewell: "" }],
    });
    expect(await loadCallEndOwnerWords(prisma, run)).toBe("");
    expect(await loadCallEndOwnerWords(prisma, run)).toBe("");
    expect(findMany).not.toHaveBeenCalled();
  });
});
