import type { CodexLiveCatalog } from "@rakazo/adapters";
import { serializeModelSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { readThinkingCapabilities } from "./thinking-defaults.js";

describe("thinking defaults on a subscription connection", () => {
  it.each(["gpt-6-luna", "gpt-5.3-codex-spark"])(
    "uses the selected account's advertised levels for %s",
    async (modelId) => {
      const provider = "openai-codex";
      const plaintext = serializeModelSecret({
        kind: "oauth",
        credential: {
          type: "oauth",
          access: "fake-oauth-access",
          refresh: "fake-oauth-refresh",
          expires: Date.now() + 60_000,
          accountId: "fixture-account",
        },
      });
      const row = {
        id: "fixture-credential",
        provider,
        defaultModel: modelId,
        secretId: "fixture-secret",
      };
      const database = {
        secret: { findFirst: vi.fn(async () => ({ id: row.secretId, ciphertext: plaintext })) },
      } as unknown as PrismaClient;
      const read = vi.fn(async () => [
        {
          slug: modelId,
          reasoningEfforts: ["minimal", "medium"],
          supportsImages: true,
          supportsFastTier: false,
        },
      ]);
      const info = await readThinkingCapabilities(
        database,
        { load: async (ciphertext) => ciphertext },
        { userId: "fixture-user" },
        { provider, modelId },
        row as Parameters<typeof readThinkingCapabilities>[4],
        { read } as unknown as CodexLiveCatalog,
      );
      expect(read).toHaveBeenCalledWith(
        "fixture-user",
        expect.objectContaining({
          accountId: "fixture-account",
        }),
        { waitMs: 0 },
      );
      expect(info?.levels).toEqual(["minimal", "medium"]);
    },
  );
});
