import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { connectorBatchActionNames } from "./composio-batch.js";

describe("buildApprovalAskBlock", () => {
  it("retains every batch occurrence, long argument and destination in expandable details", () => {
    const wrapper = "COMPOSIO_MULTI_EXECUTE_TOOL";
    const body = `${"x".repeat(9_100)} final line`;
    const args = {
      extra: null,
      tools: [
        { tool_slug: "GMAIL_SEND", account: "work", arguments: { body, to: "first@example.test" } },
        { tool_slug: "GMAIL_SEND", account: "personal", arguments: '{"to":"second@example.test"}' },
        { tool_slug: "GMAIL_SEND", arguments: {} },
        { arguments: { channel: "unknown-target" } },
      ],
    };
    const block = buildApprovalAskBlock("effect", wrapper, args, [], {
      batch: connectorBatchActionNames(wrapper, args),
      resolvedScope: {
        action: wrapper,
        connection: "Mail",
        managedAccounts: [
          {
            id: "connection",
            connectorId: "composio",
            externalId: " GMAIL ",
            providerRef: "work",
            displayName: "Work mail",
          },
        ],
        batch: { items: "tools", action: "tool_slug" },
      },
    });
    expect(block.approvalDetails).toContain('Connection: "Mail"');
    expect(block.approvalDetails).toContain('1. "GMAIL_SEND" · "Work mail"');
    expect(block.approvalDetails).toContain('2. "GMAIL_SEND" · Explicit account');
    expect(block.approvalDetails).toContain('3. "GMAIL_SEND" · Provider-selected account (gmail)');
    expect(block.approvalDetails!.indexOf("4.")).toBeLessThan(block.approvalDetails!.indexOf(body));
    expect(block.approvalDetails).toContain(body);
    expect(block.approvalDetails).toContain("first@example.test");
    expect(block.approvalDetails).toContain("second@example.test");
    expect(block.approvalDetails).toContain("unknown-target");
    expect(block.approvalDetails?.match(/"tool_slug": "GMAIL_SEND"/g)).toHaveLength(3);
    expect(block.approvalDetails).toContain('"extra": null');
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });

  it("does not expose protected values from encoded objects, URLs, headers or preview text", () => {
    const block = buildApprovalAskBlock(
      "effect",
      "demo_send",
      {
        url: "https://account:private-password@example.test/?token=private-token&ref=report",
        body: '{"secret":"private-body","recipient":"person@example.test","value":"fixture-known"}',
        headers: [["Authorization", "private-header"], { name: "Cookie", value: "private-cookie" }],
      },
      ["fixture-known"],
      { resolvedScope: { action: "demo_send" } },
    );
    const card = JSON.stringify(block);
    for (const secret of [
      "private-password",
      "private-token",
      "private-body",
      "private-header",
      "private-cookie",
      "fixture-known",
    ])
      expect(card).not.toContain(secret);
    expect(block.approvalDetails).toContain("person@example.test");
    expect(block.approvalDetails).toContain("ref=report");
    expect(block.approvalDetails).toContain("[redacted]");
  });

  it("keeps safe counts and lists while hiding known encoded values and raw credential headers", () => {
    const secret = "fixture with spaces";
    const quoted = 'fixture "quoted" text';
    const encoded = encodeURIComponent(secret);
    const requestUrl = `https://example.test/${encoded}?label=visible&label=${encoded}`;
    const block = buildApprovalAskBlock(
      "effect",
      "demo_send",
      {
        title: "Before\u202eAfter",
        body: JSON.stringify(JSON.stringify({ summary: quoted, status: "visible" })),
        headers: "Authorization: synthetic-raw-header\r\nX-Example: visible",
        maxTokens: 300,
        accessToken: "fixture-path-field",
        private_key: "fixture-signing-private-field",
        privateKeyPem: "fixture-pem-private-field",
        secretAccessKey: "fixture-storage-secret-field",
        session_id: "fixture-session-field",
        publicKey: "fixture-public-key",
        publicKeyPem: "fixture-public-pem",
        accessTokens: ["fixture-oauth-list-field"],
        credentials: ["fixture-credential-list-field"],
        passwordConfirmation: "fixture-confirmation-field",
        named: { name: "API key", value: "fixture-key-field" },
        labels: ["cookie", "ordinary label"],
      },
      [secret, quoted],
      {
        resolvedScope: {
          action: "demo_send",
          destination: (args) => {
            const target = new URL(requestUrl);
            target.pathname += `/${encodeURIComponent(String(args.accessToken))}`;
            return { method: "POST", url: target.href };
          },
        },
      },
    );
    expect(block.detail).toContain("Before\\u202eAfter");
    expect(block.approvalDetails).toContain('Destination: POST "https://example.test/');
    expect(block.approvalDetails).toContain("/%5Bredacted%5D/%5Bredacted%5D?");
    expect(block.approvalDetails).toContain("label=visible&label=%5Bredacted%5D");
    expect(block.approvalDetails).toContain("X-Example: visible");
    expect(block.approvalDetails).toContain('"maxTokens": 300');
    expect(block.approvalDetails).toContain("fixture-public-key");
    expect(block.approvalDetails).toContain("fixture-public-pem");
    expect(block.approvalDetails).toContain("ordinary label");
    for (const protectedText of [
      secret,
      encoded,
      quoted,
      "synthetic-raw-header",
      "quoted",
      "fixture-path-field",
      "fixture-signing-private-field",
      "fixture-pem-private-field",
      "fixture-storage-secret-field",
      "fixture-session-field",
      "fixture-oauth-list-field",
      "fixture-credential-list-field",
      "fixture-confirmation-field",
      "fixture-key-field",
    ]) {
      expect(JSON.stringify(block)).not.toContain(protectedText);
    }
  });

  it("offers permanent approval only for the full list stored in the card", () => {
    const wrapper = "COMPOSIO_MULTI_EXECUTE_TOOL";
    const actions = ["X".repeat(4_000)];
    const batch = { actions, complete: true };
    const offered = buildApprovalAskBlock("effect-batch", wrapper, {}, [], { batch });
    const clipped = buildApprovalAskBlock("effect-batch", wrapper, {}, [], {
      batch,
      reviewReason: "This has a consequence",
    });
    expect(offered).toMatchObject({
      kind: "ask",
      approvalScope: "connector_batch",
      actions: [{ id: "allow" }, { id: "always" }, { id: "deny" }],
    });
    expect(clipped).toMatchObject({ actions: [{ id: "allow" }, { id: "deny" }] });
  });

  it("does not transform a configured secret in an action name before redaction", () => {
    const wrapper = "COMPOSIO_MULTI_EXECUTE_TOOL";
    const secret = "fixture-token";
    const args = { tools: [{ tool_slug: `GMAIL_SEND_${secret}` }] };
    const batch = connectorBatchActionNames(wrapper, args)!;
    const block = buildApprovalAskBlock("effect-batch", wrapper, args, [secret], { batch });
    expect(block).toMatchObject({
      detail: "GMAIL_SEND_[redacted]",
      actions: [{ id: "allow" }, { id: "deny" }],
    });
    expect(JSON.stringify(block)).not.toContain(secret.toUpperCase());
  });

  it("does not persist a batch rule whose canonical spelling reveals a known secret", () => {
    const block = buildApprovalAskBlock(
      "effect-batch",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      {},
      ["FIXTURE-TOKEN"],
      {
        batch: { actions: ["gmail_send_fixture-token"], complete: true },
      },
    );
    expect(block).toMatchObject({ actions: [{ id: "allow" }, { id: "deny" }] });
    expect(JSON.stringify(block)).not.toContain("FIXTURE-TOKEN");
  });

  it("presents the complete shared Page change for a one-time visual decision", () => {
    const detail = `- <Text>Before</Text>\n+ <Text>After</Text>\n${"x".repeat(3_958)}`;

    expect(
      buildApprovalAskBlock("effect-page", "save_page", {}, [], {
        sharedPageUpdate: { title: "Weekly [report](https://example.test)", detail },
      }),
    ).toEqual({
      kind: "ask",
      approvalEffectId: "effect-page",
      reviewMode: "screen",
      text: "Update shared page “Weekly [report](https://example.test)”?",
      detail,
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it("keeps a declined connection's requester readable without letting the label format the card", () => {
    const block = buildApprovalAskBlock(
      "effect-connection",
      "respond_agent_connection",
      {
        accept: false,
        requester_name: "`https://example.test` Peer*Bot\nfixture_secret",
        requester_address: "fixture_secret\npeer@example.test",
        requester_provider: "slack",
      },
      ["fixture_secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-connection",
      text: "Decline connection with “`` `https://example.test` Peer*Bot redacted ``”?",
      detail: "Slack: [redacted] peer@example.test",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("keeps a generic review reason within the full detail budget", () => {
    const reviewReason = "r".repeat(4_000);
    const block = buildApprovalAskBlock("effect-1", "destination.write", {}, [], {
      reviewReason,
      allowSiteAlways: false,
    });
    expect(block).toMatchObject({
      detail: reviewReason,
      actions: expect.arrayContaining([{ id: "always", label: "Always allow this tool" }]),
    });
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });

  it("shows a fetch's complete destination and offers an allowance for its site", () => {
    const url = `https://docs.example.com/${"a".repeat(1_800)}?query=value`;
    const block = buildApprovalAskBlock(
      "effect-fetch",
      "web_fetch",
      { url, method: "POST", body: "ignored payload" },
      [],
      { reviewReason: "reason ".repeat(1_000) },
    );
    expect(block).toMatchObject({
      kind: "ask",
      site: "example.com",
      actions: expect.arrayContaining([{ id: "always", label: "Always allow example.com" }]),
    });
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.detail).toContain(`url: ${url}`);
    expect(block.detail).not.toContain("method: POST");
    expect(block.detail).not.toContain("body: ignored payload");
  });

  it("retains the destination while suppressing a site allowance", () => {
    const url = "https://docs.example.com/report";
    const block = buildApprovalAskBlock("effect-fetch", "web_fetch", { url }, [], {
      allowSiteAlways: false,
    });
    expect(block).toMatchObject({
      site: "example.com",
      detail: `url: ${url}`,
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it.each([undefined, "file:///fixture", "https://fixture-user:fixture-secret@example.com/"])(
    "offers no persistent allowance when the fetch site cannot be named: %s",
    (url) => {
      const block = buildApprovalAskBlock("effect-fetch", "web_fetch", { url }, []);
      expect(block).not.toHaveProperty("site");
      expect(block).toMatchObject({
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      });
      expect(JSON.stringify(block)).not.toContain("fixture-secret");
    },
  );
});
