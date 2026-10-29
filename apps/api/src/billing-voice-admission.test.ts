import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { mountVoiceHttpRoutes } from "./voice.js";

it.each(["speak", "transcribe"])(
  "rejects voice %s before credentials or the provider are touched",
  async (route) => {
    const touched = vi.fn(() => {
      throw new Error("Provider reached");
    });
    const assertAccess = vi.fn(async () => {
      throw new ORPCError("PAYMENT_REQUIRED", {
        status: 402,
        data: { reason: "subscription_required" },
      });
    });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {
        prisma: { userVoiceCredential: { findFirst: touched } },
        assertAccess,
      } as unknown as VoiceDeps,
      async () => ({
        userId: "user-fake",
        spaceId: "space-fake",
        email: "fake@example.test",
        isDeploymentOwner: false,
      }),
    );
    const response = await app.request(`/api/voice/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        route === "speak" ? { text: "Hello" } : { audioBase64: "AQ==", mimeType: "audio/wav" },
      ),
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "PAYMENT_REQUIRED",
      data: { reason: "subscription_required" },
    });
    expect(touched).not.toHaveBeenCalled();
  },
);

it.each(["speak", "transcribe"])(
  "keeps the voice %s membership rejection as HTTP403",
  async (route) => {
    const touched = vi.fn(() => {
      throw new Error("Provider reached");
    });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {
        prisma: { userVoiceCredential: { findFirst: touched } },
        assertAccess: async () => {
          throw new ORPCError("FORBIDDEN", { data: { reason: "space_forbidden" } });
        },
      } as unknown as VoiceDeps,
      async () => ({
        userId: "user-fake",
        spaceId: "space-fake",
        email: "fake@example.test",
        isDeploymentOwner: false,
      }),
    );
    const response = await app.request(`/api/voice/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        route === "speak" ? { text: "Hello" } : { audioBase64: "AQ==", mimeType: "audio/wav" },
      ),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "space_forbidden" },
    });
    expect(touched).not.toHaveBeenCalled();
  },
);
