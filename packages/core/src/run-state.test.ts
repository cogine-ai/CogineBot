import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isBackgroundRunTrigger,
  isConversationalRun,
  messageBypassesTakeoverWait,
} from "./run-state.js";

describe("run state machine", () => {
  it("allows takeover resume onto a lease", () => {
    expect(canTransition("waiting_takeover", "leased")).toBe(true);
    expect(canTransition("waiting_takeover", "running")).toBe(false);
  });

  it("withholds user steering from routine, webhook, and creation intro turns", () => {
    expect(isConversationalRun("user")).toBe(true);
    expect(isConversationalRun("follow_up")).toBe(true);
    expect(isConversationalRun("messaging")).toBe(true);
    expect(isConversationalRun("routine")).toBe(false);
    expect(isConversationalRun("webhook")).toBe(false);
    expect(isConversationalRun("created")).toBe(false);
    expect(isConversationalRun("tickets")).toBe(false);
    expect(isConversationalRun("bot_message")).toBe(false);
  });

  it("marks ticket runs as background work that stays out of the chat", () => {
    expect(isBackgroundRunTrigger("tickets")).toBe(true);
    expect(isBackgroundRunTrigger("user")).toBe(false);
    expect(isBackgroundRunTrigger("routine")).toBe(false);
    expect(isBackgroundRunTrigger(null)).toBe(false);
  });

  it("rejects rewriting a completed run", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/illegal/i);
  });

  it("never leaves a terminal state except failed retry", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("completed" as const, "cancelled" as const),
        fc.constantFrom(
          "queued" as const,
          "leased" as const,
          "running" as const,
          "waiting_input" as const,
          "completed" as const,
        ),
        (from, to) => {
          expect(canTransition(from, to)).toBe(false);
        },
      ),
    );
  });
});

describe("takeover wait message routing", () => {
  it.each(["routine", "webhook", "created", "bot_message", "tickets"])(
    "lets a message pass a %s takeover wait",
    (trigger) => {
      expect(messageBypassesTakeoverWait({ status: "waiting_takeover", trigger })).toBe(true);
    },
  );

  it.each(["user", "follow_up", null, undefined])(
    "keeps a conversational takeover wait for trigger %s",
    (trigger) => {
      expect(messageBypassesTakeoverWait({ status: "waiting_takeover", trigger })).toBe(false);
    },
  );

  it("lets a message that cannot steer pass a conversational takeover wait", () => {
    expect(
      messageBypassesTakeoverWait({ status: "waiting_takeover", trigger: "user" }, false),
    ).toBe(true);
  });

  it.each([
    "queued",
    "leased",
    "running",
    "waiting_input",
    "completed",
    "failed",
    "cancelled",
    undefined,
  ])("does not bypass a run with status %s", (status) => {
    expect(messageBypassesTakeoverWait({ status, trigger: "routine" }, false)).toBe(false);
  });
});
