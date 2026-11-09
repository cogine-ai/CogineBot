import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { ComposioEmulator, NativeConnectorProvider } from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { connectionAuthorizationRevision } from "../../adapters/src/connector-account-binding.js";
import { CATALOG_EXECUTE } from "../../adapters/src/lazy-tool-catalog.js";
import { CALENDAR_SCOPES } from "../../adapters/src/native-connectors/config.js";
import {
  restoreTurnCheckpoint,
  serializeTurnCheckpoint,
} from "../../adapters/src/turn-checkpoint.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const action = "calendar.events.create";
const modelKey = "synthetic-catalog-model-key";
const approved = {
  calendarId: "primary",
  sendUpdates: "none",
  event: {
    summary: "Approved calendar event",
    start: { date: "2027-01-05" },
    end: { date: "2027-01-06" },
  },
};
const cases = [
  { mode: "allow", separator: ":" },
  { mode: "revoke", separator: "/" },
  { mode: "block", separator: ":" },
  { mode: "deny-retry", separator: ":" },
  { mode: "intent", separator: "__" },
  { mode: "same-labels", separator: ":" },
  { mode: "reauthorize", separator: "/" },
] as const;

const lastToolText = (request: ModelEmulatorRequest) =>
  String(request.messages.findLast((message) => message.role === "tool")?.content);

describe.skipIf(!enabled)("catalog aliases through native accounts and durable approval", () => {
  it.each(cases)(
    "$mode keeps the approved account and arguments for $separator aliases",
    async ({ mode, separator }) => {
      const allowed = mode === "allow" || mode === "same-labels";
      const labelA = "Work/一";
      const labelB = mode === "same-labels" ? labelA : "Personal";
      const alias = `Google Calendar · ${labelA}${separator}${action}`;
      const connections: string[] = [];
      const canonical = (index: number) =>
        `google-calendar:${encodeURIComponent(connections[index]!)}:${encodeURIComponent(action)}`;
      const unapprovedArguments = () => ({
        id: canonical(1),
        arguments: {
          ...approved,
          event: { ...approved.event, summary: "Unapproved replacement" },
        },
      });
      const mutations: Array<{ token: string; body: Record<string, unknown> }> = [];
      let approvedToolName = "";
      const loadStep: ModelEmulatorStep = {
        expect(request) {
          const loaded = JSON.parse(lastToolText(request));
          expect(loaded.id).toBe(canonical(0));
          expect(loaded.readOnly).toBe(false);
          expect(loaded.inputSchema).toHaveProperty("properties.event");
          expect(loaded.name).toBe(approvedToolName);
          expect(mutations).toEqual([]);
        },
        response: () => ({
          type: "tool",
          id: "initial-mutation",
          name: "native_execute_tool",
          arguments: { id: mode === "same-labels" ? canonical(0) : alias, arguments: approved },
        }),
      };
      const steps: ModelEmulatorStep[] = [
        {
          expect(request) {
            expect(request.tools?.map((tool) => tool.function.name)).toEqual(
              expect.arrayContaining([
                "native_search_tools",
                "native_load_tool",
                "native_execute_tool",
              ]),
            );
          },
          response: {
            type: "tool",
            id: "search",
            name: "native_search_tools",
            arguments: { query: action },
          },
        },
        {
          expect(request) {
            const found = JSON.parse(lastToolText(request));
            expect(found.tools.map((tool: { id: string }) => tool.id).sort()).toEqual(
              [canonical(0), canonical(1), canonical(2)].sort(),
            );
          },
          response: {
            type: "tool",
            id: "load-alias",
            name: "native_load_tool",
            arguments: { id: alias },
          },
        },
        ...(mode === "same-labels"
          ? [
              {
                expect(request: ModelEmulatorRequest) {
                  const error = lastToolText(request);
                  expect(error).toMatch(/ambiguous/i);
                  expect(error).toContain(canonical(0));
                  expect(error).toContain(canonical(1));
                  expect(error).not.toContain(canonical(2));
                  expect(mutations).toEqual([]);
                },
                response: () => ({
                  type: "tool" as const,
                  id: "load-canonical",
                  name: "native_load_tool",
                  arguments: { id: canonical(0) },
                }),
              },
            ]
          : []),
        loadStep,
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(canonical(0));
            const resumedCalls = request.messages
              .flatMap((message) => message.tool_calls ?? [])
              .filter((call) => call.id === "initial-mutation");
            expect(resumedCalls).toHaveLength(1);
            expect(resumedCalls[0]!.function.name).toBe("native_execute_tool");
            expect(JSON.parse(resumedCalls[0]!.function.arguments)).toEqual(unapprovedArguments());
            const resumedResults = request.messages.filter(
              (message) => message.role === "tool" && message.tool_call_id === "initial-mutation",
            );
            expect(resumedResults).toHaveLength(1);
            const result = String(resumedResults[0]!.content);
            if (allowed) {
              expect(result).toContain('"outcome":"succeeded"');
              expect(mutations).toHaveLength(1);
              expect(mutations[0]!.token).toBe("Bearer synthetic-native-a");
              expect(mutations[0]!.body).toMatchObject(approved.event);
              expect(mutations[0]!.body.summary).not.toBe("Unapproved replacement");
            } else if (mode === "block") {
              expect(result).toContain("action_rule_blocked");
              expect(mutations).toEqual([]);
            } else if (mode === "deny-retry") {
              expect(result).toContain("The user denied this action");
              expect(mutations).toEqual([]);
            } else {
              expect(result).not.toContain('"outcome":"succeeded"');
              expect(result).toMatch(
                /Tool is unknown or not authorized for this bot|Selected connector account is unavailable or its authorization changed|An explicitly selected connector account is unavailable/,
              );
              expect(mutations).toEqual([]);
            }
          },
          response:
            mode === "deny-retry"
              ? () => ({
                  type: "tool",
                  id: "rephrased-mutation",
                  name: "native_execute_tool",
                  arguments: {
                    id: canonical(0),
                    arguments: {
                      ...approved,
                      event: { ...approved.event, summary: "Rephrased after denial" },
                    },
                  },
                })
              : { type: "text", text: "Catalog approval fixture complete." },
        },
        ...(mode === "deny-retry"
          ? [
              {
                expect(request: ModelEmulatorRequest) {
                  expect(lastToolText(request)).toContain("The user denied this action");
                  expect(mutations).toEqual([]);
                },
                response: { type: "text" as const, text: "The refused action was skipped." },
              },
            ]
          : []),
      ];
      const model = await startModelEmulator({ apiKey: modelKey, steps });
      const dataDir = await mkdtemp(path.join(tmpdir(), "catalog-approval-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: origin,
          webOrigin: origin,
          apiUrl: "https://api.example.test",
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          contextStrategy: "current",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "synthetic-catalog-encryption-key",
          remoteConnectors: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: async (input, init) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              const headers = new Headers(init?.headers);
              if (url.href === "https://oauth2.googleapis.com/token") {
                const code = new URLSearchParams(String(init?.body)).get("code");
                expect(["a", "b", "c"]).toContain(code);
                return Response.json({
                  access_token: `synthetic-native-${code}`,
                  refresh_token: `synthetic-refresh-${code}`,
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: CALENDAR_SCOPES.join(" "),
                });
              }
              if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
                const code = headers.get("authorization")?.split("-").at(-1);
                return Response.json({ sub: `synthetic-subject-${code}`, name: `Account ${code}` });
              }
              if (
                url.origin === "https://www.googleapis.com" &&
                url.pathname === "/calendar/v3/calendars/primary/events" &&
                init?.method === "POST"
              ) {
                const body = JSON.parse(String(init.body)) as Record<string, unknown>;
                mutations.push({ token: headers.get("authorization") ?? "", body });
                return Response.json({ ...body, etag: '"synthetic-event-etag"' });
              }
              throw new Error(
                `Unexpected synthetic provider request: ${init?.method ?? "GET"} ${url.pathname}`,
              );
            },
          },
        });
        stop = handles.stop;
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: `catalog-${randomUUID()}@example.test`,
            password: "password12",
            name: "Catalog fixture",
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
          apiKey: modelKey,
          contextWindow: 160000,
          maxTokens: 4096,
        });
        const bot = await rpc<{ id: string }>("bots/create", {
          name: "Catalog fixture",
          title: "",
          description: "",
          instructions: "Use the connected calendar catalog.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        const context: AdapterContext = {
          spaceId: storedBot.spaceId,
          userId: storedBot.userId,
          botId: bot.id,
          operationId: "synthetic-catalog-setup",
          traceId: randomUUID(),
          signal: new AbortController().signal,
        };
        const native = handles.connectors.managed("native");
        expect(native).toBeInstanceOf(NativeConnectorProvider);
        if (!(native instanceof NativeConnectorProvider))
          throw new Error("Missing native provider");
        const config = await native.configurations.save(
          NativeConfigInputSchema.parse({
            appId: "google-calendar",
            ownership: "byo",
            credentialKind: "oauth",
            label: `Synthetic calendar source ${randomUUID()}`,
            clientId: "synthetic-client",
            clientSecret: "synthetic-client-secret",
            scopes: [...CALENDAR_SCOPES],
          }),
          context,
          true,
        );
        const authorize = async (code: string, previousConnectionId?: string) => {
          const started = await native.oauth.begin(config.id, context, previousConnectionId);
          const state = new URL(started.authorizationUrl).searchParams.get("state")!;
          await native.oauth.callback({ state, code }, context.signal, context.userId);
          return started.connectionId;
        };
        for (const [index, code] of ["a", "b", "c"].entries()) {
          const id = await authorize(code);
          connections.push(id);
          await handles.prisma.connection.update({
            where: { id },
            data: { displayName: [labelA, labelB, "Background"][index]! },
          });
        }
        const rows = await handles.prisma.connection.findMany({
          where: { id: { in: connections } },
        });
        const resolved = await native.resolveCall(
          {
            tool: "native_execute_tool",
            route: { connectorId: "native", toolName: CATALOG_EXECUTE },
            args: { id: canonical(0), arguments: approved },
            executionId: "synthetic-rule-lookup",
          },
          {
            ...context,
            connectedConnections: rows.map((row) => ({
              id: row.id,
              connectorId: row.connectorId,
              externalId: row.provider,
              providerRef: row.providerRef ?? undefined,
              revision: connectionAuthorizationRevision(row),
              displayName: row.displayName,
            })),
          },
        );
        if (!resolved) throw new Error("Missing synthetic action");
        approvedToolName = resolved.tool.name;
        // The first action must enter the manual approval path.
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: storedBot.spaceId,
            createdByUserId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: approvedToolName,
          },
        });
        await rpc("bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const sent = await rpc<{ runId: string }>("threads/send", {
          botId: bot.id,
          text: "Create the approved calendar event using account A.",
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
          .toBe("waiting_input");
        expect(mutations).toEqual([]);
        const effect = await handles.prisma.externalEffect.findFirstOrThrow({
          where: { runId: sent.runId, kind: approvedToolName },
        });
        const request = effect.request as unknown[];
        expect(request[1]).toBe("native_execute_tool");
        expect(request[2]).toEqual({ id: canonical(0), arguments: approved });
        expect(request[3]).toMatchObject({
          connectorId: "native",
          resourceId: "google-calendar",
          connectionId: connections[0],
          toolName: action,
        });
        expect((request[3] as { resourceRevision: unknown }).resourceRevision).toBeTruthy();
        if (mode === "revoke") await native.revoke(connections[0]!, context);
        else if (mode === "block") {
          await handles.prisma.actionApprovalRule.create({
            data: {
              spaceId: storedBot.spaceId,
              createdByUserId: storedBot.userId,
              effect: "deny",
              matchKind: "tool",
              matchValue: approvedToolName,
            },
          });
          await expect(rpc("approvalRules/list", {})).resolves.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ effect: "deny", matchValue: approvedToolName }),
            ]),
          );
        } else if (mode === "intent") {
          const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
          await handles.prisma.task.update({
            where: { id: run.taskId },
            data: { connectionIds: connections.slice(1) },
          });
        } else if (mode === "reauthorize") {
          const replacement = await authorize("a", connections[0]);
          expect(replacement).not.toBe(connections[0]);
          const old = await handles.prisma.connection.findUniqueOrThrow({
            where: { id: connections[0] },
          });
          const current = await handles.prisma.connection.findUniqueOrThrow({
            where: { id: replacement },
            include: { oauthGrant: true },
          });
          expect(old.status).toBe("revoked");
          expect(current.status).toBe("connected");
          expect(current.oauthGrantId).not.toBe(old.oauthGrantId);
          expect(current.oauthGrant?.subject).toBe("synthetic-subject-a");
          // The old alias now names a replacement account, but the approved route must not.
          await handles.prisma.connection.update({
            where: { id: replacement },
            data: { displayName: labelA },
          });
        } else
          await handles.prisma.connection.update({
            where: { id: connections[0] },
            data: { displayName: "Renamed account" },
          });
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        const savedRow = await handles.prisma.externalEffect.findUniqueOrThrow({
          where: { idempotencyKey: JSON.stringify(["runtime_checkpoint", sent.runId]) },
        });
        expect(savedRow).toMatchObject({
          runId: sent.runId,
          spaceId: storedBot.spaceId,
          kind: "runtime_checkpoint",
          status: "runtime_checkpoint",
          request: {},
        });
        if (typeof savedRow.result !== "string") throw new Error("Missing saved catalog turn");
        const saved = restoreTurnCheckpoint(savedRow.result, {
          provider: model.model.provider,
          id: model.model.id,
        });
        const before = JSON.parse(savedRow.result);
        expect(saved).toEqual(before);
        expect(saved.pendingToolCallId).toBe("initial-mutation");
        const pendingCalls = saved.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter(
                (part) => part.type === "toolCall" && part.id === saved.pendingToolCallId,
              )
            : [],
        );
        expect(pendingCalls).toHaveLength(1);
        const pendingCall = pendingCalls[0];
        if (pendingCall?.type !== "toolCall") throw new Error("Missing saved catalog call");
        expect(pendingCall.name).toBe("native_execute_tool");
        const initialArguments = {
          id: mode === "same-labels" ? canonical(0) : alias,
          arguments: approved,
        };
        expect(pendingCall.arguments).toEqual(initialArguments);
        pendingCall.arguments = unapprovedArguments();
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
        if (changedCall?.type !== "toolCall") throw new Error("Missing modified catalog call");
        expect(changedCall.arguments).toEqual(unapprovedArguments());
        changedCall.arguments = initialArguments;
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
        expect(
          await handles.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
        ).toEqual(effect);
        await rpc("threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer: mode === "deny-retry" ? "deny" : "allow",
        });
        await expect
          .poll(
            async () =>
              (await handles.prisma.run.findUnique({ where: { id: sent.runId } }))?.status,
            { timeout: 15000, interval: 100 },
          )
          .toBe(allowed || mode === "block" || mode === "deny-retry" ? "completed" : "failed");
        model.assertComplete();
        expect(model.requests).toHaveLength(
          mode === "same-labels" || mode === "deny-retry" ? 5 : 4,
        );
        expect(mutations).toHaveLength(allowed ? 1 : 0);
        const settled = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId, kind: approvedToolName },
        });
        const original = settled.find((entry) => entry.id === effect.id)!;
        expect(original.idempotencyKey).toBe(effect.idempotencyKey);
        expect(original.request).toEqual(effect.request);
        if (allowed) expect(original.status).toBe("completed");
        else if (mode === "block") {
          expect(original).toMatchObject({
            status: "completed",
            result: { code: "action_rule_blocked" },
          });
        } else if (mode === "deny-retry") {
          expect(original).toMatchObject({ status: "denied", result: null });
        } else expect(original.status).not.toBe("completed");
        const allEffects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        const nativeEffects = allEffects.filter(
          (entry) => Array.isArray(entry.request) && entry.request[1] === "native_execute_tool",
        );
        expect(nativeEffects).toContainEqual(original);
        const retries = nativeEffects.filter((entry) => entry.id !== effect.id);
        if (mode === "deny-retry") {
          expect(retries).toHaveLength(2);
          for (const retry of retries)
            expect(retry).toMatchObject({ status: "denied", result: { refused: "repeat" } });
        } else expect(retries).toEqual([]);
        const siblings = await handles.prisma.connection.findMany({
          where: { id: { in: connections.slice(1) } },
        });
        expect(siblings.map((connection) => connection.status)).toEqual(["connected", "connected"]);
      } finally {
        await stop?.();
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45000,
  );
});
