import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, FakeSandboxProvider } from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  restoreTurnCheckpoint,
  serializeTurnCheckpoint,
} from "../../adapters/src/turn-checkpoint.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { type ModelEmulatorStep, startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi computer approval", () => {
  beforeAll(() => {
    // Use the existing compatible-endpoint capability declaration so the real
    // executor exposes computer tools without mocking its model vision gate.
    vi.stubEnv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS", "offline-fixture");
  });
  afterAll(() => vi.unstubAllEnvs());

  it.each(["allow", "deny"] as const)(
    "%s enforces the persisted computer action before any sandbox effect",
    async (answer) => {
      let sandbox: FakeSandboxProvider;
      const approvedArgs = {
        actions: [{ kind: "type", text: "approved clipboard content" }],
        observe: false,
        settle_ms: 0,
      };
      const replacementArgs = {
        ...approvedArgs,
        actions: [{ kind: "type", text: "unapproved replacement" }],
      };
      const resultStep =
        (id: string): ModelEmulatorStep["expect"] =>
        (request) => {
          const results = request.messages.filter(
            (message) => message.role === "tool" && message.tool_call_id === id,
          );
          expect(results).toHaveLength(1);
          const result = results[0];
          expect(result?.tool_call_id).toBe(id);
          const body = JSON.parse(String(result?.content));
          if (answer === "allow") expect(body).toMatchObject({ ok: true, completed: 1 });
          else expect(JSON.stringify(body)).toMatch(/denied/i);
          // Inspect the provider state while the run still owns its screen;
          // completed runs release that screen and discard its placeholder state.
          const screens = [...sandbox.boxes.values()].flatMap((box) => [...box.screens.values()]);
          expect(screens).not.toContain("unapproved replacement");
          if (answer === "allow") expect(screens).toContain("approved clipboard content");
          else expect(screens).not.toContain("approved clipboard content");
        };
      const fixtureKey = "offline-computer-approval-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(request.tools).toContainEqual(
                expect.objectContaining({
                  function: expect.objectContaining({ name: "computer_act" }),
                }),
              );
            },
            response: {
              type: "tool",
              id: "pending-action",
              name: "computer_act",
              arguments: approvedArgs,
            },
          },
          {
            expect: resultStep("pending-action"),
            response: { type: "text", text: "Finished the approval fixture." },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-approval-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: fixtureOrigin,
          webOrigin: fixtureOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "offline-computer-fixture-encryption-key",
        });
        stop = handles.stop;
        expect(handles.sandbox).toBeInstanceOf(FakeSandboxProvider);
        sandbox = handles.sandbox as FakeSandboxProvider;
        // Keep the real fake-provider implementation; observe calls and its state
        // independently of the model's claims and the persisted effect record.
        const act = vi.spyOn(sandbox, "act");
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `computer-approval-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Computer approval fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        const credential = await rpc<ModelCredential>(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Computer fixture",
          title: "",
          description: "",
          instructions: "Complete the computer task.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: storedBot.spaceId,
            createdByUserId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "computer_act",
          },
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Put approved clipboard content on the computer clipboard.",
        });
        const waitForRun = async (status: string) => {
          await expect
            .poll(
              async () => {
                const run = await handles.prisma.run.findUniqueOrThrow({
                  where: { id: sent.runId },
                });
                if (run.status === "failed") model.assertComplete();
                return run.status;
              },
              { timeout: 15_000, interval: 100 },
            )
            .toBe(status);
        };
        await waitForRun("waiting_input");
        expect(model.requests).toHaveLength(1);
        expect(act).not.toHaveBeenCalled();
        const effects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId, kind: "computer_act" },
        });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({
          kind: "computer_act",
          status: "intended",
          request: approvedArgs,
        });
        const privateRows = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId, kind: "runtime_checkpoint" },
        });
        expect(privateRows).toHaveLength(1);
        const savedRow = privateRows[0]!;
        expect(savedRow).toMatchObject({
          runId: sent.runId,
          spaceId: storedBot.spaceId,
          idempotencyKey: JSON.stringify(["runtime_checkpoint", sent.runId]),
          kind: "runtime_checkpoint",
          status: "runtime_checkpoint",
          request: {},
        });
        if (typeof savedRow.result !== "string") throw new Error("Missing saved computer turn");
        const saved = restoreTurnCheckpoint(savedRow.result, {
          provider: model.model.provider,
          id: model.model.id,
        });
        const before = JSON.parse(savedRow.result);
        expect(saved).toEqual(before);
        expect(saved.pendingToolCallId).toBe("pending-action");
        const pendingCalls = saved.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter(
                (part) => part.type === "toolCall" && part.id === saved.pendingToolCallId,
              )
            : [],
        );
        expect(pendingCalls).toHaveLength(1);
        const pendingCall = pendingCalls[0];
        if (pendingCall?.type !== "toolCall") throw new Error("Missing saved computer call");
        expect(pendingCall.name).toBe("computer_act");
        expect(pendingCall.arguments).toEqual(approvedArgs);
        if (answer === "allow") {
          pendingCall.arguments = replacementArgs;
          const changedBlob = serializeTurnCheckpoint(saved);
          const changed = restoreTurnCheckpoint(changedBlob, {
            provider: model.model.provider,
            id: model.model.id,
          });
          const changedCalls = changed.messages.flatMap((message) =>
            message.role === "assistant"
              ? message.content.filter(
                  (part) => part.type === "toolCall" && part.id === changed.pendingToolCallId,
                )
              : [],
          );
          expect(changedCalls).toHaveLength(1);
          const changedCall = changedCalls[0];
          if (changedCall?.type !== "toolCall") throw new Error("Missing modified computer call");
          expect(changedCall.arguments).toEqual(replacementArgs);
          changedCall.arguments = approvedArgs;
          expect(changed).toEqual(before);
          await handles.prisma.externalEffect.update({
            where: { id: savedRow.id },
            data: { result: changedBlob },
          });
          const changedRow = await handles.prisma.externalEffect.findUniqueOrThrow({
            where: { id: savedRow.id },
          });
          expect({ ...changedRow, result: savedRow.result, updatedAt: savedRow.updatedAt }).toEqual(
            savedRow,
          );
          expect(changedRow.result).toBe(changedBlob);
        } else {
          expect(
            await handles.prisma.externalEffect.findUniqueOrThrow({ where: { id: savedRow.id } }),
          ).toEqual(savedRow);
        }
        expect(
          await handles.prisma.externalEffect.findUniqueOrThrow({ where: { id: effects[0]!.id } }),
        ).toEqual(effects[0]);
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(card.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "ask", approvalEffectId: effects[0]!.id }),
          ]),
        );
        await rpc(handles.app, cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer,
        });
        await waitForRun("completed");
        model.assertComplete();
        expect(model.requests).toHaveLength(2);
        expect(act).toHaveBeenCalledTimes(answer === "allow" ? 1 : 0);
        if (answer === "allow") {
          expect(act.mock.calls[0]![1]).toEqual({
            actions: [{ kind: "clipboard", text: "approved clipboard content" }],
            observe: false,
            settleMs: 0,
          });
        }
        const settledEffects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId, kind: "computer_act" },
        });
        expect(settledEffects).toHaveLength(1);
        expect(settledEffects[0]).toMatchObject({
          id: effects[0]!.id,
          idempotencyKey: effects[0]!.idempotencyKey,
          status: answer === "allow" ? "completed" : "denied",
          request: approvedArgs,
        });
        expect(
          await handles.prisma.externalEffect.findUnique({
            where: { idempotencyKey: savedRow.idempotencyKey },
          }),
        ).toBeNull();
        expect(
          await handles.prisma.externalEffect.count({
            where: { runId: sent.runId, kind: "runtime_checkpoint" },
          }),
        ).toBe(0);
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    45_000,
  );
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
