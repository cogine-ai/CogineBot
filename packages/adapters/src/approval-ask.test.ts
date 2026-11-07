import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
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
    const block = buildApprovalAskBlock("effect-fetch", "web_fetch", { url }, [], {
      reviewReason: "reason ".repeat(1_000),
    });
    expect(block).toMatchObject({
      kind: "ask",
      site: "example.com",
      actions: expect.arrayContaining([{ id: "always", label: "Always allow example.com" }]),
    });
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.detail).toContain(`url: ${url}`);
  });

  it("asks once for the exact connection's requester without a permanent tool allowance", () => {
    const block = buildApprovalAskBlock(
      "effect-connection",
      "respond_agent_connection",
      {
        accept: true,
        requester_name: "Peer*Bot",
        requester_address: "+15550001111",
        requester_provider: "sendblue",
      },
      [],
    );
    expect(block).toMatchObject({
      kind: "ask",
      text: "Approve connection with “Peer\\*Bot”?",
      detail: "iMessage: +15550001111",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
});
