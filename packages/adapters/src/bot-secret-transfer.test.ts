import type { BotSecretDestination } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  adoptPreparedBotSecret,
  BotSecretConflictError,
  validateTransferBotSecret,
} from "./bot-secrets.js";

const scope = { userId: "fake-user", spaceId: "fake-space", botId: "fake-bot" };
const destination: BotSecretDestination = {
  name: "example",
  origin: "https://example.test",
  auth: { type: "bearer" },
};
const oldRevision = "8e80e9cb-6290-45c5-865e-4572a5f39b17";
const nextRevision = "8a60d059-5668-4a8c-a261-476f0f714ed0";
const row = () => ({
  id: "saved",
  ...scope,
  ...destination,
  ciphertext: "old-ref",
  revision: oldRevision,
});

describe("typed transfer credential values", () => {
  it("projects legacy login JSON to protected username/password only without editing the source", () => {
    const original = JSON.stringify({
      username: "fake-protected-login",
      password: "fake-password",
      totp: "fake-seed",
      onePassword: "fake-token",
      nested: { value: "fake-extra" },
    });
    const value = validateTransferBotSecret({ ...destination, auth: { type: "login" } }, original);
    expect(JSON.parse(value.plaintext)).toEqual({
      username: "fake-protected-login",
      password: "fake-password",
    });
    expect(JSON.parse(original)).toMatchObject({ totp: "fake-seed", onePassword: "fake-token" });
    expect(JSON.stringify(value.destination)).not.toContain("fake-protected-login");
    for (const excluded of ["fake-seed", "fake-token", "fake-extra"])
      expect(value.plaintext).not.toContain(excluded);
  });
  it.each([
    { type: "bearer" },
    { type: "header", name: "X-Api-Key" },
    { type: "basic", username: "metadata-user" },
  ] as const)("retains an API credential byte for byte under %j auth", (auth) => {
    const value = "fake-key+/== with-inside-space";
    expect(validateTransferBotSecret({ ...destination, auth }, value).plaintext).toBe(value);
  });
  it("refuses command payloads and does not echo malformed protected values", () => {
    expect(() =>
      validateTransferBotSecret({ name: "command", auth: { type: "command" } }, "fake"),
    ).toThrow("cannot be transferred");
    const malformed = "fake-sensitive-invalid-json";
    try {
      validateTransferBotSecret({ ...destination, auth: { type: "login" } }, malformed);
    } catch (error) {
      expect(String(error)).not.toContain(malformed);
      return;
    }
    throw new Error("Malformed login was accepted");
  });
  it("retains the original length gate before projecting a login envelope", () => {
    const value = JSON.stringify({ username: "fake", password: "fake", extra: "x".repeat(16_384) });
    expect(() =>
      validateTransferBotSecret({ ...destination, auth: { type: "login" } }, value),
    ).toThrow("cannot be used");
  });
});

function transaction(initial: ReturnType<typeof row> | null, ownBot = true) {
  let current = initial;
  let loseCas = false;
  const matches = (where: Record<string, unknown>) =>
    current &&
    Object.entries(where).every(([key, value]) => current![key as keyof typeof current] === value);
  const tx = {
    $queryRaw: vi.fn(async () => (ownBot ? [{ id: scope.botId }] : [])),
    botSecret: {
      findFirst: vi.fn(async ({ where }) => (matches(where) ? { ...current! } : null)),
      count: vi.fn(async () => (current ? 1 : 0)),
      create: vi.fn(async ({ data }) => {
        current = { ...data, revision: nextRevision };
        return { id: current!.id, revision: nextRevision };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (loseCas || !matches(where)) return { count: 0 };
        current = { ...current!, ...data, revision: nextRevision };
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ id: current!.id, revision: current!.revision })),
    },
  };
  return {
    tx,
    client: tx as unknown as Prisma.TransactionClient,
    current: () => current,
    lose: () => {
      loseCas = true;
    },
  };
}
describe("prepared transfer adoption", () => {
  it("adopts one new ref and returns the database revision, with no provider interface", async () => {
    const f = transaction(null);
    expect(
      await adoptPreparedBotSecret(f.client, {
        scope,
        destination,
        recordId: "new-aad",
        ciphertext: "new-ref",
        expected: { kind: "absent" },
      }),
    ).toEqual({ id: "new-aad", revision: nextRevision });
    expect(f.current()).toMatchObject({ id: "new-aad", ...scope, ciphertext: "new-ref" });
  });
  it("uses the exact old opaque revision and ref while preserving the existing AAD id", async () => {
    const f = transaction(row());
    const result = await adoptPreparedBotSecret(f.client, {
      scope,
      destination,
      recordId: "saved",
      ciphertext: "prepared-ref",
      expected: { kind: "present", id: "saved", revision: oldRevision },
    });
    expect(result).toEqual({ id: "saved", revision: nextRevision });
    expect(f.tx.botSecret.updateMany).toHaveBeenCalledWith({
      where: { id: "saved", ...scope, revision: oldRevision, ciphertext: "old-ref" },
      data: { ciphertext: "prepared-ref" },
    });
  });
  it.each(["changed", "recreated", "missing", "different-aad", "cas-loser", "not-owner"])(
    "keeps target contents when %s",
    async (kind) => {
      const initial = kind === "missing" ? null : row();
      if (initial && ["changed", "recreated"].includes(kind)) initial.revision = nextRevision;
      const f = transaction(initial, kind !== "not-owner");
      if (kind === "cas-loser") f.lose();
      await expect(
        adoptPreparedBotSecret(f.client, {
          scope,
          destination,
          recordId: kind === "different-aad" ? "wrong-id" : "saved",
          ciphertext: "prepared-ref",
          expected: { kind: "present", id: "saved", revision: oldRevision },
        }),
      ).rejects.toBeInstanceOf(BotSecretConflictError);
      expect(f.current()?.ciphertext).not.toBe("prepared-ref");
    },
  );
  it("does not replace a newly appeared target under an absent preview", async () => {
    const f = transaction(row());
    await expect(
      adoptPreparedBotSecret(f.client, {
        scope,
        destination,
        recordId: "new-id",
        ciphertext: "new-ref",
        expected: { kind: "absent" },
      }),
    ).rejects.toBeInstanceOf(BotSecretConflictError);
    expect(f.tx.botSecret.updateMany).not.toHaveBeenCalled();
  });
});
