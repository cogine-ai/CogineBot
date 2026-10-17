import { ORPCError } from "@orpc/server";
import { NativeActionError, NativeRoutineEventError } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { mapNativeRoutineError, rethrowNativeRoutineError } from "./native-routine-errors.js";

describe("native Routine error boundary", () => {
  it.each([
    ["not_found", "NOT_FOUND"],
    ["conflict", "CONFLICT"],
    ["unavailable", "BAD_REQUEST"],
    ["invalid_input", "BAD_REQUEST"],
  ] as const)("maps binding %s without provider details", (kind, code) => {
    const mapped = mapNativeRoutineError(
      new NativeRoutineEventError(kind, "SECRET raw provider body"),
    );
    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped).toMatchObject({ code });
    expect((mapped as Error).message).not.toContain("SECRET");
  });
  it.each([
    ["resource_unavailable", "NOT_FOUND"],
    ["version_conflict", "CONFLICT"],
    ["authorization_required", "BAD_REQUEST"],
    ["authorization_expired", "BAD_REQUEST"],
    ["insufficient_scope", "BAD_REQUEST"],
    ["invalid_input", "BAD_REQUEST"],
    ["not_configured", "SERVICE_UNAVAILABLE"],
    ["rate_limited", "SERVICE_UNAVAILABLE"],
    ["temporarily_unavailable", "SERVICE_UNAVAILABLE"],
    ["result_unknown", "SERVICE_UNAVAILABLE"],
    ["incomplete_response", "SERVICE_UNAVAILABLE"],
  ] as const)("maps upstream %s without raw messages or recovery", (kind, code) => {
    const mapped = mapNativeRoutineError(
      new NativeActionError(kind, "SECRET raw provider body", { recovery: { private: "SECRET" } }),
    );
    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped).toMatchObject({ code });
    expect(JSON.stringify(mapped)).not.toContain("SECRET");
    expect((mapped as Error).message).not.toContain("SECRET");
  });
  it("leaves unexpected and existing RPC errors unchanged", () => {
    const unexpected = new Error("unexpected");
    const existing = new ORPCError("FORBIDDEN");
    expect(mapNativeRoutineError(unexpected)).toBe(unexpected);
    expect(mapNativeRoutineError(existing)).toBe(existing);
    expect(() => rethrowNativeRoutineError(unexpected)).toThrow(unexpected);
  });
});
