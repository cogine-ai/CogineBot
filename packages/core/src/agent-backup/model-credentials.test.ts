import { describe, expect, it } from "vitest";
import { projectBackupModel } from "./model.js";
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

  it("requires distinct provider aliases and manual pool rows to identify one account", () => {
    const config = JSON.stringify({
      providers: { openai: { apiKey }, "openai-api": { apiKey: "different-synthetic-key" } },
    });
    expect(readBackupModelApiKey("hermes", "openai", { config })).toBeUndefined();
    expect(
      readBackupModelApiKey("hermes", "openai", {
        config: JSON.stringify({
          model: { provider: "openai", apiKey, api_key: "different-synthetic-key" },
        }),
      }),
    ).toBeUndefined();

    const row = { auth_type: "api_key", source: "manual", access_token: apiKey };
    const pool = (rows: unknown[]) => JSON.stringify({ credential_pool: { "openai-api": rows } });
    expect(
      readBackupModelApiKey("hermes", "openai", {
        auth: pool([row, { ...row, access_token: "different-synthetic-key" }]),
      }),
    ).toBeUndefined();
    expect(readBackupModelApiKey("hermes", "openai", { auth: pool([row, row]) })).toBe(apiKey);
    expect(
      readBackupModelApiKey("hermes", "openai", {
        auth: pool([row]),
        env: "OPENAI_API_KEY=different-synthetic-key",
      }),
    ).toBeUndefined();
  });

  it("follows a desktop model's named key before the standard environment keys", () => {
    const env = [
      "DESKTOP_MODEL_KEY=fixture-desktop-key",
      "GOOGLE_API_KEY=fixture-google-key",
      "GEMINI_API_KEY=fixture-gemini-key",
    ].join("\n");
    for (const field of ["key_env", "api_key_env"]) {
      expect(
        readBackupModelApiKey("hermes", "google", {
          config: `model: {provider: google-gemini, ${field}: DESKTOP_MODEL_KEY}`,
          env,
        }),
      ).toBe("fixture-desktop-key");
    }
    expect(readBackupModelApiKey("hermes", "google", { env })).toBe("fixture-google-key");
  });

  it.each(["token", "oauth", "none", "native-command"])(
    "does not use the environment key for an explicit %s auth mode",
    (auth) => {
      const config = JSON.stringify({
        models: { providers: { openai: { auth, apiKey } } },
      });
      expect(
        readBackupModelApiKey("openclaw", "openai", { config, env: `OPENAI_API_KEY=${apiKey}` }),
      ).toBeUndefined();
    },
  );

  it("does not treat an OAuth setup token as an API key", () => {
    expect(
      readBackupModelApiKey("hermes", "anthropic", {
        config: "model: {provider: anthropic, key_env: MODEL_KEY}",
        env: "MODEL_KEY=sk-ant-oat01-synthetic-fixture",
      }),
    ).toBeUndefined();
  });

  it("rejects an override on the exact reviewed model without affecting sibling models", () => {
    const config = {
      agents: { defaults: { model: "openai/gpt-4.1" } },
      models: {
        providers: {
          openai: {
            models: [{ id: " gpt-4.1 ", baseUrl: "https://proxy.example.test/v1" }],
          },
        },
      },
    };
    expect(projectBackupModel("openclaw", config, "main")).toBe("unavailable");
    config.agents.defaults.model = "openai/gpt-4.1-mini";
    expect(projectBackupModel("openclaw", config, "main")).toEqual({
      provider: "openai",
      modelId: "gpt-4.1-mini",
    });
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

  it("does not miss a dotenv colon-style endpoint override", () => {
    expect(
      readBackupModelApiKey("openclaw", "openai", {
        env: `OPENAI_API_KEY=${apiKey}\nOPENAI_BASE_URL: https://proxy.example.test/v1`,
      }),
    ).toBeUndefined();
  });

  it("leaves a provider with an ambiguous model alias endpoint to manual setup", () => {
    const config = JSON.stringify({
      models: {
        providers: {
          anthropic: {
            apiKey,
            models: [{ id: "sonnet-4.6", baseUrl: "https://proxy.example.test/v1" }],
          },
        },
      },
    });
    expect(readBackupModelApiKey("openclaw", "anthropic", { config })).toBeUndefined();
  });

  it("does not execute references or turn unresolved values into a key", () => {
    for (const candidate of [{ source: "exec", id: "fixture-exec" }, `\${process.env.FIXTURE}`]) {
      const config = JSON.stringify({ models: { providers: { openai: { apiKey: candidate } } } });
      expect(readBackupModelApiKey("openclaw", "openai", { config })).toBeUndefined();
    }
  });
});
