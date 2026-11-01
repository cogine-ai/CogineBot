import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, ScriptedTurn } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, ScriptedAgentRuntime } from "@rakazo/adapters";
import { MessageBlock } from "@rakazo/contracts";
import {
  bootstrapUserSpace,
  createRepos,
  createThreadEvents,
  createThreadMessage,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  parseScriptedState,
  parseStoredScriptedState,
  scriptedStateDigest,
} from "../../../packages/adapters/src/scripted-state.js";
import type { createApp } from "./app.js";
import { createPluginUninstaller } from "./plugin-uninstall.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const beforeText = "The batch prefix has already run exactly once.";
const pendingText = "This pending plugin action has not run.";
const afterText = "The original batch suffix remains after administrative removal.";

/**
 * The fixture chooses a deterministic plan for genuine, claimed steering rows.
 * The production scripted runtime owns every subsequent cursor, checkpoint and
 * resume. No executor, approval result, dispatch or worker outcome is mocked.
 */
function plannedRuntime(plan: () => ScriptedTurn[]): AgentRuntime {
  const runtime = new ScriptedAgentRuntime();
  return {
    describe: () => runtime.describe(),
    abort: (id) => runtime.abort(id),
    async *run(request, context) {
      if (!request.isSteeringContinuation || request.scriptedState) {
        yield* runtime.run(request, context);
        return;
      }
      const fresh = await request.claimSteering?.([]);
      if (!fresh?.length) throw new Error("Expected a real durable steering batch");
      const script = plan();
      if (fresh.length !== script.length) throw new Error("Fixture batch and plan must agree");
      const initial = parseScriptedState(
        {
          version: 1,
          runId: request.runId,
          batch: fresh.map((item) => ({
            id: item.id,
            messageId: item.messageId,
            contentDigest: scriptedStateDigest(item.historyText ?? item.text),
          })),
          script,
          scriptDigest: scriptedStateDigest(script),
          owners: fresh.map((item) => item.id),
          cursor: { turn: 0, tool: 0, ordinal: 0, phase: "turn" },
        },
        request.runId,
      );
      yield* runtime.run({ ...request, scriptedState: initial }, context);
    },
  };
}

describe.skipIf(!enabled)("plugin removal through the real durable worker", () => {
  it.each([false, true])(
    "consumes administrative closure without replaying the batch (unrelated ask: %s)",
    async (unrelatedAsk) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "coginebot-plugin-worker-"));
      const store = new EncryptedSecretStore("offline-plugin-worker-fixture-key");
      let handles: Awaited<ReturnType<typeof createApp>> | undefined;
      let organizationId: string | undefined;
      let userId: string | undefined;
      let prefixTool = "";
      let targetTool = "";
      let suffixTool = "";
      const calls: Array<{ endpoint: string; tool: string }> = [];
      const runtime = plannedRuntime(() => [
        { assistant: beforeText, toolCalls: [{ name: prefixTool, args: { marker: "prefix" } }] },
        { assistant: pendingText, toolCalls: [{ name: targetTool, args: { marker: "pending" } }] },
        {
          assistant: afterText,
          toolCalls: [{ name: suffixTool, args: { marker: "suffix" } }],
          complete: true,
        },
      ]);
      try {
        const { createApp } = await import("./app.js");
        handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "scripted",
          defaultProvider: "scripted",
          defaultModel: "scripted",
          wakeupDriver: "memory",
          secretStore: store,
          runtime,
          remoteConnectors: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: async (input, init) => {
              const request = input instanceof Request ? input : new Request(input, init);
              const url = new URL(request.url);
              const host = request.headers.get("host");
              if (host) url.host = host;
              expect(["plugin.example.test", "unrelated.example.test"]).toContain(url.host);
              if (request.method !== "POST") return new Response(null, { status: 405 });
              const message = JSON.parse(await request.text()) as {
                id?: number;
                method?: string;
                params?: { name?: string };
              };
              let result: unknown;
              if (message.method === "initialize") {
                result = {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "synthetic-plugin-worker", version: "1" },
                };
              } else if (message.method === "tools/list") {
                result = {
                  tools: (url.host === "plugin.example.test"
                    ? ["write"]
                    : ["prefix", "suffix"]
                  ).map((name) => ({ name, inputSchema: { type: "object" } })),
                };
              } else if (message.method === "tools/call") {
                calls.push({ endpoint: url.host, tool: message.params!.name! });
                result = { content: [{ type: "text", text: "synthetic write completed" }] };
              } else return new Response(null, { status: 202 });
              return Response.json({ jsonrpc: "2.0", id: message.id, result });
            },
          },
        });
        const prisma = handles.prisma;
        userId = randomUUID();
        await prisma.user.create({
          data: { id: userId, name: "Offline worker fixture", email: `${userId}@example.test` },
        });
        const { spaceId } = await bootstrapUserSpace(
          prisma,
          { id: userId },
          { signupsEnabled: "true", signupAllowlist: "" },
          { claimDeploymentOwner: false },
        );
        organizationId = (await prisma.space.findUniqueOrThrow({ where: { id: spaceId } }))
          .organizationId;
        const actor = {
          userId,
          spaceId,
          email: `${userId}@example.test`,
          isDeploymentOwner: false,
        };
        // Use the real creation repository so computer, browser profile and
        // memory prerequisites follow the same contract as user-created bots.
        const bot = await createRepos(prisma).createBot(actor, {
          name: "Worker fixture",
          title: "",
          description: "",
          instructions: "",
          color: "blue",
          notifyOnFinish: false,
        });
        const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
        const install = await prisma.capabilityInstall.create({
          data: {
            userId,
            spaceId,
            kind: "plugin",
            name: "Offline plugin",
            source: "https://github.com/example/fixture",
            version: "a".repeat(40),
            digest: `sha256:${"b".repeat(64)}`,
            clientNonce: randomUUID(),
            requestBinding: "c".repeat(64),
            installedAt: new Date(),
          },
        });
        const server = await prisma.mcpServer.create({
          data: {
            userId,
            spaceId,
            installId: install.id,
            name: "Pending plugin",
            slug: `plugin_${randomUUID().replaceAll("-", "")}`,
            transport: "streamable_http",
            endpoint: "https://plugin.example.test/mcp",
            allowAllTools: true,
          },
        });
        const other = await prisma.mcpServer.create({
          data: {
            userId,
            spaceId,
            name: "Unrelated server",
            slug: `other_${randomUUID().replaceAll("-", "")}`,
            transport: "streamable_http",
            endpoint: "https://unrelated.example.test/mcp",
            allowAllTools: true,
          },
        });
        await prisma.capabilityInstall.update({
          where: { id: install.id },
          data: {
            config: {
              installedChildren: {
                skills: [],
                mcpServers: [
                  {
                    id: server.id,
                    name: server.name,
                    endpoint: server.endpoint,
                    transport: server.transport,
                  },
                ],
              },
            },
          },
        });
        prefixTool = `mcp__${other.slug}__prefix`;
        suffixTool = `mcp__${other.slug}__suffix`;
        targetTool = `mcp__${server.slug}__write`;
        for (const name of [prefixTool, suffixTool, targetTool])
          await prisma.actionApprovalRule.create({
            data: {
              spaceId,
              createdByUserId: userId,
              effect: name === targetTool ? "require_approval" : "allow",
              matchKind: "tool",
              matchValue: name,
            },
          });
        const task = await prisma.task.create({
          data: {
            userId,
            spaceId,
            botId: bot.id,
            threadId: thread.id,
            prompt: "Initial task",
            status: "running",
          },
        });
        const original = await prisma.run.create({
          data: {
            userId,
            spaceId,
            botId: bot.id,
            threadId: thread.id,
            taskId: task.id,
            status: "running",
            trigger: "user",
            leaseOwner: "fixture-initial-worker",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000),
            startedAt: new Date(),
          },
        });
        const attempt = await prisma.attempt.create({
          data: { runId: original.id, fence: 1, status: "running" },
        });
        const events = createThreadEvents(prisma);
        for (const text of [
          "Preserve the completed prefix",
          "Handle the pending plugin action",
          "Preserve the original suffix",
        ])
          await events.sendUserMessage({
            spaceId,
            threadId: thread.id,
            botId: bot.id,
            userId,
            blocks: [{ kind: "text", text }],
            prompt: text,
            trigger: "follow_up",
          });
        const finalized = await events.finalizeRun({
          spaceId,
          threadId: thread.id,
          botId: bot.id,
          runId: original.id,
          taskId: task.id,
          attemptId: attempt.id,
          leaseOwner: "fixture-initial-worker",
          leaseFence: 1,
          outcome: "completed",
          blocks: [{ kind: "text", text: "Initial answer" }],
        });
        const runId = finalized?.continuationRunId;
        if (!runId) throw new Error("Expected the real steering continuation");
        await handles.executor.continueRun(runId, "fixture-prefix-worker");
        const paused = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
        expect(paused.status).toBe("waiting_input");
        expect(parseStoredScriptedState(paused.scriptedState, runId).state.cursor).toMatchObject({
          turn: 1,
          tool: 0,
          ordinal: 1,
          phase: "tool",
        });
        expect(calls).toEqual([{ endpoint: "unrelated.example.test", tool: "prefix" }]);
        const effect = await prisma.externalEffect.findFirstOrThrow({
          where: { runId, kind: targetTool },
        });
        expect(effect.status).toBe("intended");
        const beforeRunIds = (
          await prisma.run.findMany({ where: { botId: bot.id }, orderBy: { id: "asc" } })
        ).map(({ id }) => id);
        let unrelatedMessageId: string | undefined;
        if (unrelatedAsk) {
          unrelatedMessageId = (
            await createThreadMessage(prisma, {
              threadId: thread.id,
              botId: bot.id,
              runId,
              role: "bot",
              blocks: [
                {
                  kind: "ask",
                  text: "A separate decision must remain pending.",
                  status: "pending",
                },
              ],
            })
          ).id;
        }
        const uninstall = createPluginUninstaller({
          prisma,
          secrets: store,
          events,
          jobs: handles.jobs,
        });
        expect(
          (await uninstall.uninstall(actor, { installId: install.id, expectedRevision: 1 })).status,
        ).toBe("removed");
        if (unrelatedAsk) {
          // Even a delivered stale job must not admit a still-waiting Run.
          await handles.executor.continueRun(runId, "fixture-stale-worker");
          expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
            "waiting_input",
          );
          expect(await prisma.attempt.count({ where: { runId } })).toBe(1);
          expect(
            (await prisma.message.findUniqueOrThrow({ where: { id: unrelatedMessageId } })).blocks,
          ).toMatchObject([{ kind: "ask", status: "pending" }]);
          expect(calls).toEqual([{ endpoint: "unrelated.example.test", tool: "prefix" }]);
        } else {
          // The application's actual in-memory worker consumes uninstall's published job.
          await expect
            .poll(
              async () => (await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status,
              { timeout: 15_000, interval: 50 },
            )
            .toBe("completed");
          expect(await prisma.attempt.count({ where: { runId } })).toBe(2);
          expect(calls).toEqual([
            { endpoint: "unrelated.example.test", tool: "prefix" },
            { endpoint: "unrelated.example.test", tool: "suffix" },
          ]);
          const audits = await prisma.event.findMany({
            where: { runId, type: "agent.tool.completed" },
            orderBy: { seq: "asc" },
          });
          expect(audits.map(({ payload }) => payload)).toContainEqual(
            expect.objectContaining({
              name: targetTool,
              executionId: `${runId}:${targetTool}:1`,
              outcome: "error",
              error: "This plugin was removed before the tool ran.",
            }),
          );
          expect(await prisma.event.count({ where: { runId, type: "effect.reconciled" } })).toBe(1);
          const messages = await prisma.message.findMany({
            where: { runId, role: "bot" },
            orderBy: { seq: "asc" },
          });
          const text = messages
            .flatMap(({ blocks }) => MessageBlock.array().parse(blocks))
            .flatMap((block) => (block.kind === "text" ? [block.text] : []))
            .join("\n");
          for (const marker of [beforeText, pendingText, afterText])
            expect(text.split(marker)).toHaveLength(2);
          expect(await prisma.steeringMessage.count({ where: { botId: bot.id } })).toBe(0);
        }
        const updatedEffect = await prisma.externalEffect.findUniqueOrThrow({
          where: { id: effect.id },
        });
        expect(updatedEffect).toMatchObject({
          status: "completed",
          result: { code: "plugin_removed" },
        });
        expect(await prisma.externalEffect.count({ where: { runId, kind: targetTool } })).toBe(1);
        const asks = (await prisma.message.findMany({ where: { runId, role: "bot" } }))
          .flatMap(({ blocks }) => MessageBlock.array().parse(blocks))
          .filter((block) => block.kind === "ask" && block.approvalEffectId === effect.id);
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({ status: "answered" });
        expect(asks[0]).not.toHaveProperty("answer");
        expect(JSON.stringify(asks)).not.toMatch(/user denied|user approved/i);
        expect(await prisma.actionApprovalRule.count({ where: { spaceId } })).toBe(3);
        expect(
          (await prisma.run.findMany({ where: { botId: bot.id }, orderBy: { id: "asc" } })).map(
            ({ id }) => id,
          ),
        ).toEqual(beforeRunIds);
        expect(await prisma.mcpServer.findUnique({ where: { id: other.id } })).toMatchObject({
          enabled: true,
        });
      } finally {
        if (handles) {
          if (organizationId)
            await handles.prisma.organization.deleteMany({ where: { id: organizationId } });
          if (userId) await handles.prisma.user.deleteMany({ where: { id: userId } });
          await handles.stop();
        }
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
