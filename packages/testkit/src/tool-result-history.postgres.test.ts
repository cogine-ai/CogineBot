import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import { createThreadMessage, eventsAfter, readHistory } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { redactConnectorPayload } from "../../adapters/src/connector-safety.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!enabled)("connector result history through executor and Pi", () => {
  it.each([
    { disabled: false, small: true, invalidView: false },
    { disabled: false, small: false, invalidView: false },
    { disabled: true, small: false, invalidView: false },
    { disabled: false, small: false, invalidView: true },
    { disabled: false, small: false, invalidView: false, messageProbe: "current" },
    { disabled: false, small: false, invalidView: false, messageProbe: "retrieval" },
  ])(
    "keeps result references scoped with disabled=$disabled small=$small invalidView=$invalidView messageProbe=$messageProbe",
    async ({ disabled, small, invalidView, messageProbe }) => {
      const strategy = messageProbe === "retrieval" ? "retrieval" : "current";
      const messageCanary = "older-message-scope-canary";
      let messageId = "";
      const secret = 'synthetic"quoted-history-key';
      const source = {
        id: "exact-record-id",
        cursor: "exact-page-cursor",
        credential: secret,
        futureCredential: 'future"quoted\nsecret',
        count: 37,
        body: "synthetic record ".repeat(small ? 80 : 1500),
      };
      const redactedSource = { ...source, credential: "[redacted]" };
      const raw = {
        content: [{ type: "text", text: JSON.stringify(source) }],
        structuredContent: source,
      };
      if (small) {
        expect(JSON.stringify(raw).length).toBeGreaterThan(2000);
        expect(JSON.stringify(raw).length).toBeLessThan(12000);
      }
      const expected = {
        content: [{ type: "text", text: JSON.stringify(redactedSource) }],
        structuredContent: redactedSource,
      };
      let storedId = "";
      let invalidateStoredView: ((id: string) => Promise<void>) | undefined;
      const lastResult = (request: ModelEmulatorRequest) =>
        JSON.parse(
          String(request.messages.findLast((message) => message.role === "tool")?.content),
        );
      const steps: ModelEmulatorStep[] = [
        {
          expect(request) {
            const names = request.tools?.map((tool) => tool.function.name) ?? [];
            expect(names.includes("read_history")).toBe(!disabled);
            expect(names.includes("search_history")).toBe(strategy === "retrieval");
            if (!disabled) {
              const schema = request.tools!.find((tool) => tool.function.name === "read_history")!
                .function.parameters as {
                properties: Record<string, unknown>;
                required?: string[];
              };
              if (strategy === "current") {
                expect(Object.keys(schema.properties).sort()).toEqual([
                  "textOffset",
                  "toolResultId",
                  "viewHash",
                ]);
                expect(schema.required).toContain("toolResultId");
              } else expect(schema.properties).toHaveProperty("messageId");
            }
            expect(names).toContain("synthetic_read_records");
          },
          response: {
            type: "tool",
            id: "connector-read",
            name: "synthetic_read_records",
            arguments: {},
          },
        },
        {
          async expect(request) {
            const result = lastResult(request);
            if (!small) expect(result.contextTruncated).toBe(true);
            expect(
              String(request.messages.findLast((message) => message.role === "tool")?.content)
                .length,
            ).toBeLessThanOrEqual(12000);
            if (disabled) {
              expect(result.historyUnavailable).toBe(true);
              expect(result.historyReference).toBeUndefined();
            } else {
              expect(result.historyReference.tool).toBe("read_history");
              storedId = result.historyReference.arguments.toolResultId;
              expect(storedId).toBeTruthy();
              if (invalidView) await invalidateStoredView!(storedId);
            }
          },
          response: () =>
            messageProbe
              ? {
                  type: "tool",
                  id: "message-history-probe",
                  name: "read_history",
                  arguments: { messageId, direction: "around", limit: 1 },
                }
              : disabled
                ? { type: "text", text: "Connector result checked." }
                : {
                    type: "tool",
                    id: "result-history-read",
                    name: "read_history",
                    arguments: { toolResultId: storedId },
                  },
        },
        ...(!disabled
          ? [
              {
                expect(request: ModelEmulatorRequest) {
                  if (messageProbe) {
                    const text = String(
                      request.messages.findLast((message) => message.role === "tool")?.content,
                    );
                    if (strategy === "current") {
                      expect(text).toContain("toolResultId");
                      expect(text).not.toContain(messageCanary);
                    } else {
                      expect(text).toContain(messageCanary);
                      expect(lastResult(request).untrusted).toBe(true);
                    }
                    return;
                  }
                  if (invalidView) {
                    const text = String(
                      request.messages.findLast((message) => message.role === "tool")?.content,
                    );
                    expect(text).toContain("redaction_error");
                    for (const field of [
                      "unreadable original marker",
                      "toolResult",
                      "nextRead",
                      "viewHash",
                      "storageTruncated",
                      "historyReference",
                    ])
                      expect(text).not.toContain(field);
                    return;
                  }
                  const result = lastResult(request);
                  expect(result.untrusted).toBe(true);
                  expect(result.toolResult).toMatchObject({
                    toolResultId: storedId,
                    textOffset: 0,
                    storageTruncated: false,
                  });
                  expect(result.toolResult.text).toContain("[redacted]");
                  expect(result.toolResult.text).not.toContain("quoted-history-key");
                  expect(result.nextRead).toEqual({
                    toolResultId: storedId,
                    textOffset: result.toolResult.text.length,
                    viewHash: result.toolResult.viewHash,
                  });
                },
                response: { type: "text" as const, text: "Stored connector evidence checked." },
              },
            ]
          : []),
      ];
      const model = await startModelEmulator({ steps });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-tool-history-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: origin,
          webOrigin: origin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "offline-history-encryption-key",
          deploymentModelKey: secret,
          contextStrategy: strategy,
        });
        stop = handles.stop;
        invalidateStoredView = async (id) => {
          let value: unknown = { body: "unreadable original marker".repeat(100) };
          for (let depth = 0; depth < 70; depth += 1) value = { nested: value };
          const text = JSON.stringify(value);
          expect(Buffer.byteLength(text)).toBeLessThan(1_048_576);
          // Simulate an older stored view that the current redaction policy cannot process.
          await handles.prisma.event.update({
            where: { id },
            data: { toolResult: { text, storedBytes: Buffer.byteLength(text) } },
          });
        };
        const discover = vi.spyOn(handles.connector, "discoverTools").mockResolvedValue([
          {
            name: "synthetic_read_records",
            description: "Read synthetic records",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
            route: { connectorId: "destination", toolName: "synthetic_read_records" },
          },
        ]);
        const execute = vi
          .spyOn(handles.connector, "execute")
          .mockImplementation(async function* () {
            yield { type: "result" as const, data: raw };
          });
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: `tool-history-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "History fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
          const response = await handles.app.request(`/rpc/${procedure}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie, origin },
            body: JSON.stringify({ json: input }),
          });
          const body = (await response.json()) as { json: T; error?: { message: string } };
          if (response.status >= 400 || body.error)
            throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
          return body.json;
        };
        const credential = await rpc<ModelCredential>("models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          contextWindow: 160000,
          maxTokens: 4096,
        });
        const bot = await rpc<{ id: string }>("bots/create", {
          name: "History fixture",
          title: "",
          description: "",
          instructions: "Inspect synthetic connector results.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc("bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
          disabledBuiltinTools: disabled ? ["read_history"] : [],
        });
        if (messageProbe) {
          const thread = await handles.prisma.thread.findUniqueOrThrow({
            where: { botId: bot.id },
          });
          const earlier = await createThreadMessage(handles.prisma, {
            threadId: thread.id,
            role: "user",
            blocks: [{ kind: "text", text: messageCanary }],
          });
          messageId = earlier.id;
        }
        const sent = await rpc<{ runId: string }>("threads/send", {
          botId: bot.id,
          text: "Read the synthetic connector records.",
        });
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUnique({ where: { id: sent.runId } });
              if (run?.status === "failed") model.assertComplete();
              return run?.status;
            },
            { timeout: 15000, interval: 100 },
          )
          .toBe("completed");
        model.assertComplete();
        expect(execute).toHaveBeenCalledTimes(1);
        expect(discover).toHaveBeenCalled();
        const stored = await handles.prisma.event.findMany({
          where: { runId: sent.runId, type: "agent.tool.result.stored" },
        });
        expect(stored).toHaveLength(disabled ? 0 : 1);
        if (!disabled && !invalidView) {
          expect(stored[0]!.id).toBe(storedId);
          expect(JSON.stringify(stored[0]!.toolResult)).not.toContain("quoted-history-key");
          const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
          let text = "";
          let textOffset = 0;
          let viewHash: string | undefined;
          for (;;) {
            const page = await readHistory(
              handles.prisma,
              {
                spaceId: run.spaceId,
                userId: run.userId,
                botId: run.botId,
                threadId: run.threadId,
              },
              { toolResultId: storedId, textOffset, viewHash },
            );
            expect(page.toolResult).not.toBeNull();
            text += page.toolResult!.text;
            if (!page.nextRead) break;
            textOffset = page.nextRead.textOffset;
            viewHash = page.nextRead.viewHash;
          }
          expect(JSON.parse(text)).toEqual(expected);
          const newSecrets = ["record", source.futureCredential, "37"];
          const readingScope = {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
            threadId: run.threadId,
            transformToolResult: (value: unknown) => redactConnectorPayload(value, newSecrets),
          };
          const first = await readHistory(handles.prisma, readingScope, { toolResultId: storedId });
          expect(first.toolResult!.viewHash).not.toBe(viewHash);
          const changed = await readHistory(
            handles.prisma,
            {
              ...readingScope,
              transformToolResult: (value: unknown) =>
                redactConnectorPayload(value, [...newSecrets, "synthetic"]),
            },
            first.nextRead!,
          );
          expect(changed).toMatchObject({
            error: "cursor_conflict",
            toolResult: null,
            retry: { toolResultId: storedId, textOffset: 0 },
          });
          let transformed = first.toolResult!.text;
          let nextRead = first.nextRead;
          while (nextRead) {
            const page = await readHistory(handles.prisma, readingScope, nextRead);
            expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10000);
            transformed += page.toolResult!.text;
            nextRead = page.nextRead;
          }
          expect(JSON.parse(transformed)).toEqual(redactConnectorPayload(expected, newSecrets));
          const decodedView = JSON.parse(transformed);
          expect(decodedView.structuredContent.count).toBe("[redacted]");
          expect(JSON.parse(decodedView.content[0].text).futureCredential).toBe("[redacted]");
          expect(
            (await handles.prisma.event.findUniqueOrThrow({ where: { id: storedId } })).toolResult,
          ).toEqual(stored[0]!.toolResult);
          const replay = await eventsAfter(handles.prisma, run.threadId, -1);
          expect(replay.find((event) => event.id === storedId)).not.toHaveProperty("toolResult");
          expect(JSON.stringify(replay)).not.toContain("quoted-history-key");
        }
        discover.mockRestore();
        execute.mockRestore();
      } finally {
        await stop?.();
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
