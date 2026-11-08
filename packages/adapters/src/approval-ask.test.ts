import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
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
