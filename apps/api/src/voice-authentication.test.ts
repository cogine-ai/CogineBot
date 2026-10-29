import { readFileSync } from "node:fs";
import { ORPCError } from "@orpc/server";
import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { mountVoiceHttpRoutes } from "./voice.js";

afterEach(() => vi.restoreAllMocks());

it.each(["speak", "transcribe"])("preserves verified authentication on voice %s", async (route) => {
  // Execute the actual application mounting callback so its session/actor distinction is tested.
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const start = source.indexOf("  mountVoiceHttpRoutes(\n");
  const end = source.indexOf("\n  mountWebhookHttpRoutes", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const mount = new Function(
    "app",
    "prisma",
    "secrets",
    "billing",
    "mountVoiceHttpRoutes",
    "requestSession",
    "sessionActor",
    "enrichLogContext",
    "ORPCError",
    source.slice(start, end),
  );
  const actor: Actor = {
    userId: "user-fake",
    spaceId: "space-fake",
    email: "fake@example.test",
    isDeploymentOwner: false,
  };
  const provider = vi.spyOn(adapters, "createVoiceProvider");
  for (const kind of ["anonymous", "memberless", "database-failure", "member"] as const) {
    const touched = vi.fn();
    const prisma = {
      userVoiceCredential: { findFirst: touched },
      spaceVoicePreference: { findFirst: touched },
      secret: { findFirst: touched },
    };
    const secrets = { load: touched };
    const requestSession = vi.fn(async () => {
      if (kind === "database-failure") throw new Error("Private database failure");
      if (kind === "anonymous") return null;
      return { actor: kind === "member" ? actor : null, sessionId: "session-fake" };
    });
    const assertAccess = vi.fn(async () => {
      throw new ORPCError("PAYMENT_REQUIRED", { data: { reason: "subscription_required" } });
    });
    const app = new Hono();
    mount(
      app,
      prisma,
      secrets,
      { assertAccess },
      mountVoiceHttpRoutes,
      requestSession,
      async () => (await requestSession())?.actor ?? null,
      vi.fn(),
      ORPCError,
    );
    const response = await app.request(`/api/voice/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        route === "speak" ? { text: "Hello" } : { audioBase64: "AQ==", mimeType: "audio/wav" },
      ),
    });
    expect(response.status, kind).toBe(
      { anonymous: 401, memberless: 403, "database-failure": 500, member: 402 }[kind],
    );
    const body = await response.json();
    if (kind === "memberless")
      expect(body).toMatchObject({ code: "FORBIDDEN", data: { reason: "space_forbidden" } });
    if (kind === "database-failure") expect(JSON.stringify(body)).not.toContain("Private");
    if (kind === "member") expect(assertAccess).toHaveBeenCalledExactlyOnceWith(actor);
    else expect(assertAccess).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  }
});

it.each(["speak", "transcribe"])("keeps voice %s provider failures as HTTP502", async (route) => {
  const failed = vi.fn(async () => {
    throw new Error("Synthetic provider failure");
  });
  vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({
    synthesize: failed,
    transcribe: failed,
  } as never);
  const app = new Hono();
  mountVoiceHttpRoutes(
    app,
    {
      prisma: {
        spaceVoicePreference: {
          findFirst: vi.fn(async () => ({
            isDefault: true,
            voiceId: "voice-fake",
            credential: {
              id: "credential-fake",
              provider: "openai",
              secretId: "secret-fake",
            },
          })),
        },
        secret: { findFirst: vi.fn(async () => ({ id: "secret-fake", ciphertext: "fake" })) },
      },
      secrets: { load: vi.fn(async () => "fake-key") },
    } as unknown as VoiceDeps,
    async () => ({ userId: "user-fake", spaceId: "space-fake" }) as Actor,
  );
  const response = await app.request(`/api/voice/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      route === "speak" ? { text: "Hello" } : { audioBase64: "AQ==", mimeType: "audio/wav" },
    ),
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Synthetic provider failure" });
  expect(failed).toHaveBeenCalledOnce();
});
