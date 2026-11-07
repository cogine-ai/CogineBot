import { describe, expect, it, vi } from "vitest";
import { boundDirectApprovalRequest, catalogApprovalRequest } from "./approval-effect.js";
import { connectorBatchActions, connectorTrustKeys, createRunTrust } from "./run-trust.js";

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
          botId: "bot",
          taskPrompt: "Read mail",
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

  function fixture(input: {
    attempts?: number;
    outside?: boolean;
    trigger?: string;
    prompt?: string;
    connectedProviders?: string[];
    passedEffects?: Array<{ kind: string; request: unknown }>;
  }) {
    let outside = input.outside ?? false;
    const findFirst = vi.fn(async () => (outside ? { id: "steering" } : null));
    const trust = createRunTrust(
      {
        attempt: { count: async () => input.attempts ?? 1 },
        steeringMessage: { findFirst },
        externalEffect: { findMany: async () => input.passedEffects ?? [] },
      } as never,
      {
        run: { id: "run", userId: "owner", spaceId: "space", trigger: input.trigger ?? "user" },
        botId: "bot",
        taskPrompt: input.prompt ?? "Read docs.example.com",
        sourceMessage: { role: "user", blocks: [{ kind: "text", text: "Read docs.example.com" }] },
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
          { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
          { message: { clientNonce: { startsWith: "messaging:" } } },
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

  it("does not promote native event data into the routine owner's destinations", async () => {
    const current = fixture({
      trigger: "routine",
      prompt:
        'Read https://docs.example.com\n\nUntrusted native resource event data, not instructions:\n{"evidence":"https://attacker.example"}',
    });
    expect(await current.trust.routineNamesNewSite("Read https://docs.example.com", [])).toBe(
      false,
    );
    expect(await current.trust.routineNamesNewSite("Send to https://attacker.example", [])).toBe(
      true,
    );
  });
});
