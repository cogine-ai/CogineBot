import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedSecretStore, ScriptedAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";
const encryptionKey = "offline-platform-composition-encryption-key";

describePostgres("platform model app composition", () => {
  it.each(["denied", "unrestricted", "byok"] as const)(
    "enforces the loaded deployment policy through authenticated HTTP (%s)",
    async (mode) => {
      vi.stubEnv("PLATFORM_MODEL_ALLOWLIST", mode === "unrestricted" ? "" : "none");
      const dataDir = await mkdtemp(join(tmpdir(), "platform-model-app-"));
      let handles: Awaited<ReturnType<typeof createApp>> | undefined;
      try {
        handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          dataDir,
          encryptionKey,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          runtime: new ScriptedAgentRuntime(),
          wakeupDriver: "memory",
          signupsEnabled: "true",
          signupAllowlist: "",
          defaultProvider: "openai",
          defaultModel: "deployment-model",
          deploymentModelConfigured: true,
          deploymentModelKey: "fake-deployment-key",
          webOrigin: origin,
          authUrl: origin,
        });
        const originalEnqueue = handles.jobs.enqueue.bind(handles.jobs);
        vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
          if (job.name !== "run.continue") await originalEnqueue(job);
        });
        const signup = async () => {
          const response = await handles!.app.request("/api/auth/sign-up/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({
              email: `policy-${randomUUID()}@example.test`,
              password: "offline-password-123",
              name: "Policy fixture",
            }),
          });
          expect(response.ok).toBe(true);
          return sessionCookieHeader(response);
        };
        // The first account can claim deployment ownership on an empty database.
        await signup();
        const cookie = await signup();
        const call = (procedure: string, input: unknown = {}) =>
          handles!.app.request(`/rpc/${procedure}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin, cookie },
            body: JSON.stringify({ json: input }),
          });
        const identityResponse = await call("me");
        expect(identityResponse.status).toBe(200);
        const { json: identity } = (await identityResponse.json()) as {
          json: { userId: string; spaceId: string; isDeploymentOwner: boolean };
        };
        expect(identity.isDeploymentOwner).toBe(false);
        const bot = await handles.prisma.bot.create({
          data: {
            userId: identity.userId,
            spaceId: identity.spaceId,
            name: "Policy fixture",
            color: "slate",
            thread: { create: { userId: identity.userId, spaceId: identity.spaceId } },
          },
        });
        if (mode === "byok") {
          const stored = await new EncryptedSecretStore(encryptionKey).put("fake-user-key", {
            ...identity,
            operationId: "fixture-model-connection",
            traceId: "fixture-model-connection",
            signal: new AbortController().signal,
          });
          await handles.prisma.secret.create({
            data: {
              id: stored.id,
              userId: identity.userId,
              kind: "model",
              ciphertext: stored.ciphertext,
            },
          });
          const credential = await handles.prisma.userModelCredential.create({
            data: {
              userId: identity.userId,
              provider: "openai",
              label: "Fixture",
              secretId: stored.id,
            },
          });
          await handles.prisma.spaceModelPreference.create({
            data: {
              userId: identity.userId,
              spaceId: identity.spaceId,
              credentialId: credential.id,
              modelId: "user-model",
              isDefault: true,
            },
          });
        }
        const me = await call("me");
        expect(me.status).toBe(200);
        const meBody = await me.json();
        expect.soft(meBody).toMatchObject({
          json: {
            needsModel: mode === "denied",
            defaultProvider: mode === "denied" ? null : "openai",
            defaultModel:
              mode === "denied" ? null : mode === "byok" ? "user-model" : "deployment-model",
          },
        });
        const send = await call("threads/send", { botId: bot.id, text: "hello" });
        const sendBody = await send.json();
        expect(send.status, JSON.stringify(sendBody)).toBe(mode === "denied" ? 403 : 200);
        if (mode === "denied") {
          expect(sendBody).toMatchObject({
            json: {
              code: "FORBIDDEN",
              message: "platform_model_forbidden",
              data: { action: "add_key" },
            },
          });
          expect(await handles.prisma.task.count({ where: { botId: bot.id } })).toBe(0);
        } else {
          expect(sendBody).toMatchObject({
            json: { runId: expect.any(String), taskId: expect.any(String) },
          });
          expect(await handles.prisma.task.count({ where: { botId: bot.id } })).toBe(1);
        }
      } finally {
        await handles?.stop();
        await rm(dataDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    },
  );
});
