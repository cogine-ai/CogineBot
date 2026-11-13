import { describe, expect, it } from "vitest";
import { readBackupModelApiKey } from "./model-credentials.js";

const apiKey = "synthetic-key-for-fixture";

describe("readBackupModelApiKey", () => {
  it("reads an explicit reference from the selected backup environment", () => {
    const config =
      '{ models: { providers: { openai: { apiKey: { source: "env", id: "MODEL_FIXTURE_KEY" } } } } }';
    expect(
      readBackupModelApiKey("openclaw", "openai", {
        config,
        env: `export MODEL_FIXTURE_KEY="${apiKey}" # comment`,
      }),
    ).toBe(apiKey);
    expect(readBackupModelApiKey("openclaw", "openai", { config })).toBeUndefined();
  });

  it("uses a manual model key from the credential pool", () => {
    const auth = JSON.stringify({
      credential_pool: {
        "openai-api": [
          { auth_type: "oauth", source: "manual", access_token: "synthetic-oauth-token" },
          { auth_type: "api_key", source: "env:OPENAI_API_KEY", access_token: "environment-token" },
          { auth_type: "api_key", source: "manual", access_token: apiKey },
        ],
      },
    });
    expect(readBackupModelApiKey("hermes", "openai", { auth })).toBe(apiKey);
    expect(readBackupModelApiKey("openclaw", "openai", { auth })).toBeUndefined();
    expect(readBackupModelApiKey("hermes", "openai-codex", { auth })).toBeUndefined();
  });

  it.each([
    {
      config: "model: {provider: openai-api, base_url: 'https://proxy.example.test/v1'}",
      env: `OPENAI_API_KEY=${apiKey}`,
    },
    {
      config: "model: {provider: openai-api}",
      env: `OPENAI_API_KEY=${apiKey}\nOPENAI_BASE_URL=https://proxy.example.test/v1`,
    },
    {
      config: "model: {provider: openai-api}",
      auth: JSON.stringify({
        credential_pool: {
          "openai-api": [
            {
              auth_type: "api_key",
              source: "manual",
              access_token: apiKey,
              runtime_base_url: "https://proxy.example.test/v1",
            },
          ],
        },
      }),
    },
  ])("does not read a model key routed to a separate endpoint", (files) => {
    expect(readBackupModelApiKey("hermes", "openai", files)).toBeUndefined();
  });

  it("does not execute references or turn unresolved values into a key", () => {
    for (const candidate of [{ source: "exec", id: "fixture-exec" }, `\${process.env.FIXTURE}`]) {
      const config = JSON.stringify({ models: { providers: { openai: { apiKey: candidate } } } });
      expect(readBackupModelApiKey("openclaw", "openai", { config })).toBeUndefined();
    }
  });
});
