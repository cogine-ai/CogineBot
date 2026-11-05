import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { mountVoiceHttpRoutes } from "./voice.js";

afterEach(() => vi.restoreAllMocks());

it.each(["speak", "transcribe"])(
  "keeps voice %s billing, credentials and provider in the verified actor context",
  async (route) => {
    const actor: Actor = {
      userId: "user-voice",
      spaceId: "space-voice",
      email: "voice@example.test",
      isDeploymentOwner: false,
    };
    const contexts: Array<{ step: string; context: unknown }> = [];
    const capture = async (step: string) => {
      await Promise.resolve();
      contexts.push({ step, context: currentDbContext() });
    };
    const provider = {
      synthesize: vi.fn(async () => {
        await capture("provider");
        return { bytes: new Uint8Array([1]), mimeType: "audio/wav" };
      }),
      transcribe: vi.fn(async () => {
        await capture("provider");
        return { text: "Recorded" };
      }),
    };
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue(provider as never);
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {
        assertAccess: vi.fn(async (resolved) => {
          expect(resolved).toEqual(actor);
          await capture("billing");
        }),
        prisma: {
          spaceVoicePreference: {
            findFirst: vi.fn(async () => {
              await capture("preference");
              return {
                isDefault: true,
                voiceId: "alloy",
                credential: {
                  id: "voice-credential",
                  provider: "openai",
                  secretId: "voice-secret",
                },
              };
            }),
          },
          secret: {
            findFirst: vi.fn(async () => {
              await capture("secret");
              return { id: "voice-secret", ciphertext: "offline-voice-reference" };
            }),
          },
        },
        secrets: {
          load: vi.fn(async () => {
            await capture("decrypt");
            return "offline-voice-key";
          }),
        },
      } as unknown as VoiceDeps,
      async () => actor,
    );
    const ambient = { spaceId: "space-unrelated", userId: "user-unrelated" };
    await runAsTenant(ambient, async () => {
      const response = await app.request(`/api/voice/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rakazo-space-id": "unverified-header-space",
        },
        body: JSON.stringify({
          spaceId: "unverified-body-space",
          userId: "unverified-user",
          ...(route === "speak"
            ? { text: "Hello" }
            : { audioBase64: "AQ==", mimeType: "audio/wav" }),
        }),
      });
      expect(response.status).toBe(200);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
    });
    expect(contexts.map((entry) => entry.step)).toEqual([
      "billing",
      "preference",
      "secret",
      "decrypt",
      "provider",
    ]);
    for (const entry of contexts)
      expect(entry.context).toEqual({
        kind: "tenant",
        spaceId: actor.spaceId,
        userId: actor.userId,
      });
    expect(currentDbContext()).toBeUndefined();
  },
);
