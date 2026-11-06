import { withPageReplyContext } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { connectorTrustKeys, createRunTrust } from "./run-trust.js";

describe("run destination trust", () => {
  it("retains an unmarked handwritten Page link as the owner's words", async () => {
    const text = "[https://owner.example/report](page:manual)\nPlease read this.";
    const trust = createRunTrust({ externalEffect: { findMany: async () => [] } } as never, {
      run: { id: "run", userId: "owner", spaceId: "space", trigger: "user" },
      botId: "bot",
      taskPrompt: text,
      sourceMessage: { role: "user", blocks: [{ kind: "text", text }] },
      ownerStartedRun: true,
      messagingChannelRun: false,
      restored: true,
      connectedProviders: [],
    });
    expect(await trust.loadOwnerWords()).toBe(text);
    expect([...(await trust.loadTrustedSites())]).toEqual(["owner.example"]);
  });
  it.each([false, true])(
    "rebuilds owner sites from a stored Page reply without its title, restored=%s",
    async (restored) => {
      const context = {
        pageId: "page-1",
        title: "Report https://attacker.example/report [nested]",
      };
      const text = withPageReplyContext("Read https://owner.example/report", context);
      const sourceMessage = JSON.parse(
        JSON.stringify({ role: "user", blocks: [{ kind: "text", text, pageContext: context }] }),
      );
      const trust = createRunTrust({ externalEffect: { findMany: async () => [] } } as never, {
        run: { id: "run", userId: "owner", spaceId: "space", trigger: "user" },
        botId: "bot",
        taskPrompt: text,
        sourceMessage,
        ownerStartedRun: true,
        messagingChannelRun: false,
        restored,
        connectedProviders: [],
      });
      expect(await trust.loadOwnerWords()).toBe("Read https://owner.example/report");
      expect([...(await trust.loadTrustedSites())]).toEqual(["owner.example"]);
      expect(sourceMessage.blocks[0].text).toBe(text);
    },
  );

  it("projects each persisted text block independently instead of inferring provenance from joined text", async () => {
    const context = { pageId: "page-1", title: "https://attacker.example/report" };
    const blocks = [
      {
        kind: "text",
        text: withPageReplyContext("Read https://owner.example/report", context),
        pageContext: context,
      },
      { kind: "text", text: "[https://second.example/report](page:manual)\nAlso read this." },
      { kind: "text", text: "https://bad-json.example/report", pageContext: { pageId: "page-1" } },
    ];
    const trust = createRunTrust({ externalEffect: { findMany: async () => [] } } as never, {
      run: { id: "run", userId: "owner", spaceId: "space", trigger: "user" },
      botId: "bot",
      taskPrompt: "Read the reports",
      sourceMessage: JSON.parse(JSON.stringify({ role: "user", blocks })),
      ownerStartedRun: true,
      messagingChannelRun: false,
      restored: true,
      connectedProviders: [],
    });
    expect([...(await trust.loadTrustedSites())]).toEqual(["owner.example", "second.example"]);
  });
  it("keeps installed resources and each batch app separate", () => {
    const route = { connectorId: "installed", resourceId: "server-a" };
    expect(connectorTrustKeys(undefined, route, "api", [])).toEqual([
      "resource:installed:server-a",
    ]);
    expect(connectorTrustKeys(undefined, { ...route, resourceId: "server-b" }, "api", [])).toEqual([
      "resource:installed:server-b",
    ]);
    expect(
      connectorTrustKeys(["GMAIL_LIST", "SLACK_GET"], undefined, "composio", ["gmail", "slack"]),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack"]);
  });

  function fixture(input: {
    attempts?: number;
    outside?: boolean;
    trigger?: string;
    prompt?: string;
  }) {
    let outside = input.outside ?? false;
    const trust = createRunTrust(
      {
        attempt: { count: async () => input.attempts ?? 1 },
        steeringMessage: { findFirst: async () => (outside ? { id: "steering" } : null) },
        externalEffect: { findMany: async () => [] },
      } as never,
      {
        run: { id: "run", userId: "owner", spaceId: "space", trigger: input.trigger ?? "user" },
        botId: "bot",
        taskPrompt: input.prompt ?? "Read docs.example.com",
        sourceMessage: { role: "user", blocks: [{ kind: "text", text: "Read docs.example.com" }] },
        ownerStartedRun: input.trigger === undefined,
        messagingChannelRun: false,
        restored: false,
        connectedProviders: [],
      },
    );
    return {
      trust,
      receiveOutside: () => {
        outside = true;
      },
    };
  }

  it("retains outside steering and treats a later attempt conservatively", async () => {
    const current = fixture({});
    expect(await current.trust.isTainted()).toBe(false);
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
