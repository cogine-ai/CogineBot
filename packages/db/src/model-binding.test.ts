import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { findBoundModelCredential } from "./model-credentials.js";

const scope = { userId: "user-a", spaceId: "space-a" };
const binding = {
  provider: "openai-compatible",
  modelId: "shared-model",
  modelCredentialId: "connection-a",
};

function fixture(row: unknown) {
  const findFirst = vi.fn().mockResolvedValue(row);
  const prisma = { userModelCredential: { findFirst } } as unknown as Pick<
    PrismaClient,
    "userModelCredential"
  >;
  return { prisma, findFirst };
}

describe("explicit model connection lookup", () => {
  it.each([null, ""])("does not search another connection for a missing id (%s)", async (id) => {
    const { prisma, findFirst } = fixture({ id: "other-connection" });
    await expect(
      findBoundModelCredential(prisma, scope, { ...binding, modelCredentialId: id }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("requires a concrete model id", async () => {
    const { prisma, findFirst } = fixture({ id: "other-connection" });
    await expect(
      findBoundModelCredential(prisma, scope, { ...binding, modelId: "  " }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the exact connection and its preference to the owner and space", async () => {
    const row = {
      id: binding.modelCredentialId,
      userId: scope.userId,
      provider: binding.provider,
      secretId: "secret-a",
      connectionRevision: 7,
      preferences: [{ modelId: "shared-model", isDefault: true, thinkingLevel: "high" }],
    };
    const { prisma, findFirst } = fixture(row);
    await expect(findBoundModelCredential(prisma, scope, binding)).resolves.toEqual({
      id: binding.modelCredentialId,
      userId: scope.userId,
      provider: binding.provider,
      secretId: "secret-a",
      connectionRevision: 7,
      defaultModel: "shared-model",
      isDefault: true,
      thinkingLevel: "high",
    });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "connection-a", userId: "user-a", provider: "openai-compatible" },
      include: {
        preferences: {
          where: { userId: "user-a", spaceId: "space-a" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        },
      },
    });
    expect(row.preferences).toHaveLength(1);
  });

  it("can use an owned account connection without copying another space's default", async () => {
    const { prisma } = fixture({
      id: "connection-a",
      provider: "openai-compatible",
      connectionRevision: 2,
      preferences: [],
    });
    await expect(findBoundModelCredential(prisma, scope, binding)).resolves.toEqual({
      id: "connection-a",
      provider: "openai-compatible",
      connectionRevision: 2,
      defaultModel: null,
      isDefault: false,
      thinkingLevel: null,
    });
  });

  it("keeps an unavailable, retired or other-owner connection invalid", async () => {
    const { prisma, findFirst } = fixture(null);
    await expect(findBoundModelCredential(prisma, scope, binding)).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
