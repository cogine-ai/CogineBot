import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { serializeModelSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  assertConnectionRevision,
  listModelConnectionReferences,
  refuseAccountModelReferences,
  validateModelBinding,
} from "./model-bindings.js";

const actor = { userId: "owner", spaceId: "space" };
const binding = {
  modelProvider: "openai-compatible",
  modelId: "second",
  modelCredentialId: "connection",
  expectedRevision: 4,
};
function fixture() {
  const credential = {
    id: "connection",
    provider: "openai-compatible",
    userId: "owner",
    secretId: "secret",
    connectionRevision: 4,
    preferences: [{ modelId: "default", isDefault: true, thinkingLevel: null }],
  };
  const findFirst = vi.fn().mockResolvedValue(credential);
  const secret = vi.fn().mockResolvedValue({ id: "secret", ciphertext: "encrypted" });
  const load = vi.fn().mockResolvedValue(
    serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      enabledModelIds: ["default", "second"],
    }),
  );
  return {
    credential,
    findFirst,
    secret,
    load,
    prisma: {
      userModelCredential: { findFirst },
      secret: { findFirst: secret },
    } as unknown as PrismaClient,
    secrets: { load } as unknown as SecretStore,
  };
}

describe("transactional explicit model binding", () => {
  it("accepts a clear without choosing or reading a connection", async () => {
    const f = fixture();
    await expect(
      validateModelBinding(f.prisma, f.secrets, actor, {
        modelProvider: null,
        modelId: null,
        modelCredentialId: null,
      }),
    ).resolves.toBeNull();
    expect(f.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    { modelProvider: "openai-compatible" },
    { ...binding, modelCredentialId: null },
    { ...binding, modelId: null },
  ])("rejects an incomplete pin %o", async (input) => {
    const f = fixture();
    await expect(validateModelBinding(f.prisma, f.secrets, actor, input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(f.findFirst).not.toHaveBeenCalled();
  });
  it("binds an enabled nondefault model to only its explicitly owned credential", async () => {
    const f = fixture();
    await expect(validateModelBinding(f.prisma, f.secrets, actor, binding)).resolves.toMatchObject({
      modelId: "second",
      credential: { id: "connection", connectionRevision: 4 },
    });
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "connection", userId: "owner", provider: "openai-compatible" },
      }),
    );
    expect(f.secret).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "secret", userId: "owner", spaceId: null } }),
    );
  });
  it("validates a prepared secret with only database reads inside the transaction", async () => {
    const f = fixture();
    const plaintext = await f.load();
    f.load.mockClear();
    const prepared = {
      modelCredentialId: "connection",
      secretId: "secret",
      ciphertext: "encrypted",
      plaintext,
    };
    await expect(
      validateModelBinding(f.prisma, f.secrets, actor, binding, prepared),
    ).resolves.toMatchObject({ modelId: "second" });
    expect(f.load).not.toHaveBeenCalled();
    f.secret.mockResolvedValue({ id: "secret", ciphertext: "rotated" });
    await expect(
      validateModelBinding(f.prisma, f.secrets, actor, binding, prepared),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.load).not.toHaveBeenCalled();
  });
  it("never tries another same-provider credential after the explicit one is gone", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue(null);
    await expect(validateModelBinding(f.prisma, f.secrets, actor, binding)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(f.findFirst).toHaveBeenCalledTimes(1);
    expect(f.load).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, -1, 1.5])("requires a positive integer revision (%s)", (revision) => {
    expect(() => assertConnectionRevision({ connectionRevision: 4 }, revision)).toThrow(
      "Choose the model connection again",
    );
  });
  it("refuses stale revisions before decrypting", async () => {
    const f = fixture();
    await expect(
      validateModelBinding(f.prisma, f.secrets, actor, { ...binding, expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.load).not.toHaveBeenCalled();
  });
  it("rejects a model removed from this connection", async () => {
    const f = fixture();
    await expect(
      validateModelBinding(f.prisma, f.secrets, actor, { ...binding, modelId: "disabled" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "That model is not enabled for this connection.",
    });
  });
  it.each(["missing", "unreadable", "invalid", "wrong-kind"])(
    "fails closed for a %s secret",
    async (failure) => {
      const f = fixture();
      if (failure === "missing") f.secret.mockResolvedValue(null);
      if (failure === "unreadable") f.load.mockRejectedValue(new Error("cannot decrypt"));
      if (failure === "invalid") f.load.mockResolvedValue("{invalid");
      if (failure === "wrong-kind")
        f.load.mockResolvedValue(serializeModelSecret({ kind: "api_key", key: "fake-key" }));
      await expect(validateModelBinding(f.prisma, f.secrets, actor, binding)).rejects.toMatchObject(
        { code: "BAD_REQUEST" },
      );
    },
  );
  it("preserves unavailable storage as a retryable service error", async () => {
    const f = fixture();
    f.load.mockRejectedValue(new SecretStoreUnavailableError("offline"));
    await expect(validateModelBinding(f.prisma, f.secrets, actor, binding)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("model reference ownership and visibility", () => {
  it("lists unresolved pins while guarding only account-owned objects and active runs", async () => {
    const bot = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "bot",
          name: "Bot",
          spaceId: "space",
          modelProvider: "openai-compatible",
          modelId: "same",
          modelCredentialId: null,
        },
      ]),
    };
    const routine = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "routine",
          name: "Routine",
          spaceId: "space",
          modelProvider: "openai-compatible",
          modelId: "same",
          modelCredentialId: "retired",
        },
      ]),
    };
    const run = { findMany: vi.fn().mockResolvedValue([]) };
    const spaceModelPreference = { findMany: vi.fn().mockResolvedValue([]) };
    const rows = await listModelConnectionReferences(
      {
        bot,
        routine,
        run,
        steeringMessage: { findMany: vi.fn().mockResolvedValue([]) },
        spaceModelPreference,
        spaceBackupModel: { findMany: vi.fn().mockResolvedValue([]) },
        userModelCredential: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as PrismaClient,
      "owner",
    );
    expect(rows).toEqual([
      expect.objectContaining({ kind: "bot", unresolved: true }),
      expect.objectContaining({ kind: "routine", unresolved: true }),
    ]);
    expect(bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "owner" }) }),
    );
    expect(run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "owner", status: { in: expect.any(Array) } }),
      }),
    );
    expect(spaceModelPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner", isDefault: true } }),
    );
  });
  it("queries pending or active-run steering by owned connection and resolves its thread Space", async () => {
    const steeringMessage = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "pending",
          modelProvider: "openai-compatible",
          modelId: "same",
          modelCredentialId: "connection",
          bot: { name: "Deferred bot" },
          message: { thread: { spaceId: "deferred-space" } },
        },
        {
          id: "legacy-pending",
          modelProvider: "openai-compatible",
          modelId: "same",
          modelCredentialId: null,
          bot: { name: "Legacy bot" },
          message: { thread: { spaceId: "deferred-space" } },
        },
      ]),
    };
    const empty = () => ({ findMany: vi.fn().mockResolvedValue([]) });
    const prisma = {
      steeringMessage,
      bot: empty(),
      routine: empty(),
      run: empty(),
      spaceBackupModel: empty(),
      spaceModelPreference: empty(),
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([{ id: "connection", provider: "openai-compatible" }]),
      },
    } as unknown as PrismaClient;
    expect(await listModelConnectionReferences(prisma, "owner", "connection")).toEqual([
      expect.objectContaining({
        kind: "steering",
        id: "pending",
        name: "Deferred bot",
        spaceId: "deferred-space",
        modelCredentialId: "connection",
        unresolved: false,
      }),
      expect.objectContaining({ kind: "steering", id: "legacy-pending", unresolved: true }),
    ]);
    expect(steeringMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "owner",
          modelProvider: { not: null },
          modelId: { not: null },
          modelCredentialId: "connection",
          OR: [
            { runId: null },
            {
              run: {
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
            },
          ],
        },
      }),
    );
  });
  it.each(["bot", "steering"] as const)(
    "blocks former-Space %s references without disclosing their names",
    async (kind) => {
      const prisma = {
        spaceMember: { findMany: vi.fn().mockResolvedValue([{ spaceId: "current" }]) },
      } as unknown as PrismaClient;
      await expect(
        refuseAccountModelReferences(prisma, "owner", [
          {
            kind,
            id: "hidden",
            name: "Private name",
            spaceId: "former",
            provider: "openai-compatible",
            modelId: "same",
            modelCredentialId: "connection",
            unresolved: false,
          },
        ]),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "In use by Models in another space. Pick another model for them first.",
      });
    },
  );
});
