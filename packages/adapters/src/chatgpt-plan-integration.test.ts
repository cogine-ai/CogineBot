import { describe, expect, it, vi } from "vitest";
import { refreshChatGPTPlanCredential } from "./chatgpt-plan-auth.js";
import { CHATGPT_PLAN_PROVIDER_ID } from "./chatgpt-plan-provider.js";
import {
  parseModelSecret,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
} from "./pi-oauth.js";

const now = 1_800_000_000_000;
function credential(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    access: "fake-access",
    refresh: "fake-refresh",
    expires: now + 10_000,
    clientId: "oaiapp_fake",
    issuer: "https://auth.openai.com",
    subject: "fake-subject",
    hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    idToken: "fake-id-token",
    scopes: ["chatgpt.tokens.use.direct"],
    registrationId: "fake-registration",
    chatgptPlanModels: [{ id: "fake-model", name: "Fake model" }],
    ...overrides,
  };
}

describe("ChatGPT plan credential integration", () => {
  it("publishes a non-executable rotation checkpoint before reporting unavailable identity verification", async () => {
    const initial = credential();
    const persist = vi.fn(async (_value: string) => undefined);
    const toAuth = vi.fn();
    await expect(
      resolveModelAuth(
        serializeModelSecret({ kind: "oauth", credential: initial, maxTokens: 1024 }),
        CHATGPT_PLAN_PROVIDER_ID,
        {
          now,
          persist,
          oauth: {
            refresh: (value, signal) =>
              refreshChatGPTPlanCredential(value, signal, {
                fetch: async () =>
                  Response.json({
                    access_token: "pending-access",
                    refresh_token: "pending-refresh",
                    id_token: "pending-id-token",
                    expires_in: 3600,
                    scope: "chatgpt.tokens.use.direct",
                  }),
              }),
            toAuth,
          },
        },
      ),
    ).rejects.toThrow("identity verification");
    expect(toAuth).not.toHaveBeenCalled();
    const checkpoint = parseModelSecret(persist.mock.calls[0]![0]);
    expect(checkpoint).toMatchObject({
      kind: "oauth",
      maxTokens: 1024,
      credential: {
        access: "fake-access",
        pendingRotation: { response: { refresh_token: "pending-refresh" } },
      },
    });
    expect(secretValuesToRedact(checkpoint)).toEqual(
      expect.arrayContaining([
        "fake-access",
        "fake-refresh",
        "fake-id-token",
        "pending-access",
        "pending-refresh",
        "pending-id-token",
      ]),
    );
  });

  it("preserves the complete profile/catalog and limits during a rotating refresh", async () => {
    const initial = credential();
    const replacement = {
      ...initial,
      access: "replacement-access",
      refresh: "replacement-refresh",
      expires: now + 3_600_000,
    };
    const persist = vi.fn(async (_value: string) => undefined);
    const refresh = vi.fn(async () => replacement);
    const result = await resolveModelAuth(
      serializeModelSecret({ kind: "oauth", credential: initial, maxTokens: 1024 }),
      CHATGPT_PLAN_PROVIDER_ID,
      {
        now,
        persist,
        oauth: { refresh, toAuth: async (value) => ({ apiKey: value.access }) },
      },
    );
    expect(result.apiKey).toBe("replacement-access");
    expect(parseModelSecret(persist.mock.calls[0]![0])).toEqual({
      kind: "oauth",
      credential: replacement,
      maxTokens: 1024,
    });
    expect(secretValuesToRedact(result.secret)).toEqual([
      "replacement-access",
      "replacement-refresh",
      "fake-id-token",
    ]);
  });

  it("honors the refresh-not-before timestamp without exposing an expired bearer", async () => {
    const refresh = vi.fn();
    const toAuth = vi.fn(async (value) => ({ apiKey: value.access }));
    const plaintext = serializeModelSecret({
      kind: "oauth",
      credential: credential({ expires: now - 1, earliestRefreshAt: now + 60_000 }),
    });
    await expect(
      resolveModelAuth(plaintext, CHATGPT_PLAN_PROVIDER_ID, { now, oauth: { refresh, toAuth } }),
    ).rejects.toThrow("expired");
    expect(refresh).not.toHaveBeenCalled();
    expect(toAuth).not.toHaveBeenCalled();
  });

  it("does not refresh early while the access token is still valid", async () => {
    const refresh = vi.fn();
    const plaintext = serializeModelSecret({
      kind: "oauth",
      credential: credential({ earliestRefreshAt: now + 60_000 }),
    });
    const result = await resolveModelAuth(plaintext, CHATGPT_PLAN_PROVIDER_ID, {
      now,
      oauth: { refresh, toAuth: async (value) => ({ apiKey: value.access }) },
    });
    expect(result.apiKey).toBe("fake-access");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects damaged direct-plan metadata instead of treating it as a legacy OAuth credential", () => {
    expect(() =>
      parseModelSecret(JSON.stringify(credential({ clientId: "dynamic_agent_client" }))),
    ).toThrow("corrupt");
    expect(() => parseModelSecret(JSON.stringify(credential({ subject: "" })))).toThrow("corrupt");
  });
});
