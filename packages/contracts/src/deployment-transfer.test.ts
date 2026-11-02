import { describe, expect, it } from "vitest";
import {
  DeploymentTransferCandidateSchema,
  DeploymentTransferReceiptItemSchema,
  DeploymentTransferStartInput,
} from "./deployment-transfer.js";

describe("credential-transfer public boundary", () => {
  it("keeps target observations separate from the copied historical fact", () => {
    const copied = {
      itemKey: "item",
      name: "key",
      kind: "api_key",
      status: "copied",
      revision: 1,
      canRecover: false,
    };
    for (const targetState of ["unchanged", "modified", "removed"])
      expect(
        DeploymentTransferReceiptItemSchema.safeParse({ ...copied, targetState }).success,
      ).toBe(true);
    expect(
      DeploymentTransferReceiptItemSchema.safeParse({
        ...copied,
        status: "unknown",
        targetState: "removed",
      }).success,
    ).toBe(false);
  });
  it("accepts login destination metadata without exposing a protected username or value", () => {
    const candidate = {
      itemKey: "item",
      revision: "8a082559-d1aa-4c83-bf8e-104ec496263f",
      kind: "password",
      name: "website",
      origin: "https://account.example.test",
      auth: { type: "login" },
    };
    expect(DeploymentTransferCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(
      DeploymentTransferCandidateSchema.safeParse({ ...candidate, name: "Invalid Name" }).success,
    ).toBe(false);
    expect(
      DeploymentTransferCandidateSchema.safeParse({ ...candidate, value: "protected-value" })
        .success,
    ).toBe(false);
    expect(
      DeploymentTransferCandidateSchema.safeParse({
        ...candidate,
        auth: { type: "login", username: "protected-user" },
      }).success,
    ).toBe(false);
  });
  it("requires a fixed HTTPS origin rather than a callback URL or private HTTP escape", () => {
    const input = {
      targetBotId: "bot",
      sourceOrigin: "https://source.example.test",
      clientNonce: "n",
    };
    expect(DeploymentTransferStartInput.parse(input)).toEqual(input);
    for (const sourceOrigin of [
      "http://127.0.0.1:3100",
      "https://source.example.test/path",
      "https://user:password@source.example.test",
      "https://source.example.test?callback=https://elsewhere.example.test",
    ]) {
      expect(DeploymentTransferStartInput.safeParse({ ...input, sourceOrigin }).success).toBe(
        false,
      );
    }
  });
});
