import { isBuiltinToolName } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  connectorReadRequiresApproval,
  isOwnerStartedRun,
  newSiteOutcome,
  planActionGate,
  SITE_SENDING_TOOLS,
  toolResultTaintsRun,
} from "./action-approval.js";

describe("run result provenance", () => {
  it("assigns site-scoped allowances only to registered local builtin tools", () => {
    for (const name of SITE_SENDING_TOOLS) expect(isBuiltinToolName(name)).toBe(true);
  });
  it("keeps confirmations and saved conversation state separate from outside results", () => {
    for (const name of ["remember", "request_secret", "generate_secret", "update_preferences"]) {
      expect(isBuiltinToolName(name)).toBe(true);
      expect(toolResultTaintsRun(name)).toBe(false);
    }
    for (const name of [
      "web_fetch",
      "read_file",
      "read_history",
      "search_history",
      "browser_snapshot",
      "gmail_get",
      "new_tool",
    ])
      expect(toolResultTaintsRun(name)).toBe(true);
  });

  it("does not exempt external names that are not tools in this product", () => {
    for (const name of ["connect_app", "feedback", "list_fleet", "schedule_update"])
      expect(toolResultTaintsRun(name)).toBe(true);
  });

  it("cannot ask an unattended webhook to approve a new site", () => {
    expect(newSiteOutcome({ trigger: "webhook", decision: "ask" })).toBe("deny");
    expect(newSiteOutcome({ trigger: "webhook", decision: "allow" })).toBe("allow");
    expect(newSiteOutcome({ trigger: "user", decision: "ask" })).toBe("ask");
  });

  it("treats only the owner's own starts as owner requests", () => {
    expect(isOwnerStartedRun("user", false)).toBe(true);
    expect(isOwnerStartedRun("call_end", false)).toBe(true);
    expect(isOwnerStartedRun("follow_up", true)).toBe(true);
    for (const trigger of ["follow_up", "routine", "messaging", "bot_message", "webhook", "new"])
      expect(isOwnerStartedRun(trigger, false)).toBe(false);
  });

  it("reviews a new connector read only after outside content entered the run", () => {
    expect(connectorReadRequiresApproval({ tainted: false, connectorTrusted: false })).toBe(false);
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: false })).toBe(true);
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: true })).toBe(false);
  });

  it("keeps connector read review separate from a required confirmation", () => {
    const input = {
      resolved: { decision: "allow" as const, source: "default" as const, matchingRules: [] },
      consequential: false,
      reviewOnly: true,
      autoReviewEnabled: true,
      checkerConfigured: true,
    };
    expect(planActionGate(input)).toBe("judge");
    expect(planActionGate({ ...input, checkerConfigured: false })).toBe("allow");
    expect(planActionGate({ ...input, autoReviewEnabled: false })).toBe("allow");
  });

  it("does not treat a whole-tool allow as permission for a new destination", () => {
    const input = {
      resolved: { decision: "allow" as const, source: "always_allow" as const, matchingRules: [] },
      consequential: false,
      newDestination: true,
      autoReviewEnabled: true,
      checkerConfigured: true,
    };
    expect(planActionGate(input)).toBe("judge");
    expect(planActionGate({ ...input, checkerConfigured: false })).toBe("ask");
  });
});
