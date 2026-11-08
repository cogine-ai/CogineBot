import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { ComposioEmulator } from "@rakazo/adapters";
import type { Actor, ModelCredential } from "@rakazo/contracts";
import { callClientNonce } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  createDb,
  createThreadEvents,
  deletePageShareSecrets,
  IsolationError,
  PAGE_SHARE_SECRET_KIND,
  PageShareConflictError,
  provisionRuntimeRole,
  rlsBypassKey,
  runAsTenant,
  swapPageShare,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.js";
import {
  getPage,
  listPages,
  PageListCursorError,
  pinPage,
  removePage,
  renamePage,
} from "../../../apps/api/src/pages.js";
import { TeamChatBridge } from "../../../apps/api/src/team-chat-bridge.js";
import { prepareSharedPageUpdate } from "../../adapters/src/page-share-update.js";
import type { PageToolContext } from "../../adapters/src/page-tools.js";
import { recoverSavedPageFromTool, savePageFromTool } from "../../adapters/src/page-tools.js";
import { parseStoredScriptedState } from "../../adapters/src/scripted-state.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;
const source = (text: string) =>
  `export default function App() { return <Page title="Example"><Text>${text}</Text></Page>; }`;
const appOrigin = "http://127.0.0.1:5173";
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const preparedShare = ({
  botId,
  groupId,
  title,
  currentVersion = 1,
  shareRevision = 0,
}: {
  botId: string | null;
  groupId: string | null;
  title: string;
  currentVersion?: number;
  shareRevision?: number;
}) => {
  const id = randomUUID();
  const ciphertext = `sealed-fixture:${id}`;
  return {
    botId,
    groupId,
    expectedVersion: currentVersion,
    expectedTitle: title,
    expectedShareRevision: shareRevision,
    tokenHash: createHash("sha256").update(id).digest("hex"),
    secret: { id, ref: ciphertext, ciphertext },
    unreadable: null,
  };
};

function withTransaction(
  prisma: PrismaClient,
  wrap: (
    next: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>,
) {
  return new Proxy(prisma, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key, target);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        wrap((next) => target.$transaction(next), work);
    },
  });
}

function afterPageRead(prisma: PrismaClient, observe: () => Promise<void>) {
  return withTransaction(prisma, (next, work) =>
    next((tx) =>
      work(
        new Proxy(tx, {
          get(target, key) {
            if (key !== "page") return Reflect.get(target, key, target);
            return new Proxy(target.page, {
              get(table, method) {
                if (method !== "findFirst") return Reflect.get(table, method, table);
                return async (args: Prisma.PageFindFirstArgs) => {
                  const row = await table.findFirst(args);
                  await observe();
                  return row;
                };
              },
            });
          },
        }),
      ),
    ),
  );
}

async function pageAppSession(handles: Awaited<ReturnType<typeof createApp>>) {
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin },
    body: JSON.stringify({
      email: `page-approval-${randomUUID()}@example.test`,
      password: "password12",
      name: "Page approval fixture",
    }),
  });
  expect(signup.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(signup);
  const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: appOrigin },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { json?: T; error?: { message?: string } };
    if (response.status >= 400 || body.error)
      throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
    return body.json as T;
  };
  return { cookie, rpc };
}

postgres("private Pages operations (isolated PostgreSQL)", () => {
  const login = `pages_runtime_${randomBytes(8).toString("hex")}`;
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let grantRole: string | undefined;
  let runtimeUrl: string | undefined;
  let ownRoles = false;
  const admin = () => owner!.prisma;
  const client = () => runtime!.prisma;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE ||
      database !== process.env.VERIFY_ISOLATED_DATABASE ||
      ["host", "hostaddr", "port", "database", "dbname", "service"].some((key) =>
        url.searchParams.has(key),
      )
    ) {
      throw new Error("Pages tests require an explicitly isolated harness database");
    }
    owner = createDb(databaseUrl!, { poolMax: 4 });
    const identity = await owner.pool.query<{ name: string; grant: string }>(
      "SELECT datname AS name, 'coginebot_app_' || oid::text AS grant FROM pg_database WHERE datname=current_database()",
    );
    expect(identity.rows[0]?.name).toBe(database);
    grantRole = identity.rows[0]!.grant;
    expect(
      (
        await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [
          [login, grantRole],
        ])
      ).rowCount,
    ).toBe(0);
    ownRoles = true;
    url.username = login;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 5, rowSecurity: true });
    await expect(verifyRuntimeDatabase(client())).resolves.toMatchObject({
      connectionEnforced: true,
    });
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (runtime) {
      await clean(() => runtime!.prisma.$disconnect());
      await clean(() => runtime!.pool.end());
    }
    if (owner) {
      if (ownRoles) {
        if (runtimeUrl) {
          await clean(() =>
            owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [rlsBypassKey(runtimeUrl!)],
            ),
          );
        }
        for (const role of [login, grantRole!]) {
          await clean(async () => {
            const exists = await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
              role,
            ]);
            if (!exists.rowCount) return;
            await owner!.pool.query(`DROP OWNED BY ${quoted(role)}`);
            await owner!.pool.query(`DROP ROLE ${quoted(role)}`);
          });
        }
      }
      await clean(() => owner!.prisma.$disconnect());
      await clean(() => owner!.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "Pages fixture cleanup failed");
  });

  it.each(["allow", "deny", "rotated", "marker-only denial", "TeamChat", "Routine"] as const)(
    "binds a real Pi public update to its reviewed change and one outcome (%s)",
    async (outcome) => {
      const pageId = randomUUID();
      const args = { pageId, edits: [{ find: "Original value", replace: "Reviewed value" }] };
      const markerOnly = outcome === "marker-only denial";
      const denied = outcome === "deny" || markerOnly;
      const teamChat = outcome === "TeamChat";
      const routine = outcome === "Routine";
      const allowed = outcome === "allow" || routine;
      const prompt = routine
        ? `Update the shared inventory page with pageId ${pageId}. Stay silent after saving.`
        : "Update the shared inventory page.";
      const callId = markerOnly ? "recover-page" : "update-page";
      const toolArgs = { name: "save_page", arguments: args };
      const fixtureKey = "offline-page-approval-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(request.tools).toContainEqual(
                expect.objectContaining({
                  function: expect.objectContaining({ name: "use_tool" }),
                }),
              );
              if (routine) expect(JSON.stringify(request.messages)).toContain(prompt);
            },
            response: {
              type: "tool",
              id: "update-page",
              name: "use_tool",
              arguments: toolArgs,
            },
          },
          ...(markerOnly
            ? [
                {
                  expect(request) {
                    const continuation = request.messages
                      .flatMap((message) =>
                        typeof message.content === "string" ? message.content.split("\n") : [],
                      )
                      .find((line) => line.startsWith("use_tool: "));
                    expect(continuation).toBeDefined();
                    expect(JSON.parse(continuation!.slice("use_tool: ".length))).toEqual(toolArgs);
                    expect(JSON.stringify(request.messages)).not.toMatch(
                      /candidateDigest|baseTitleDigest|requestKind/,
                    );
                  },
                  response: {
                    type: "tool" as const,
                    id: callId,
                    name: "use_tool",
                    arguments: toolArgs,
                  },
                },
              ]
            : []),
          {
            expect(request) {
              const result = request.messages.filter(
                (message) => message.role === "tool" && message.tool_call_id === callId,
              );
              expect(result).toHaveLength(1);
              const body = JSON.parse(String(result[0]?.content));
              if (allowed) expect(body).toMatchObject({ pageId, version: 2 });
              else if (teamChat)
                expect(body).toMatchObject({
                  error: "This shared Page update needs approval in the owner's chat.",
                  unchanged: true,
                });
              else expect(JSON.stringify(body)).toMatch(denied ? /denied/i : /changed/i);
              expect(JSON.stringify(request.messages)).not.toMatch(
                /candidateDigest|baseTitleDigest|requestKind/,
              );
            },
            response: {
              type: "text",
              text: routine ? "NO_RESPONSE" : "Finished checking the update.",
            },
          },
        ],
      });
      const dataDir = await mkdtemp(join(tmpdir(), "cogine-page-approval-"));
      let stop: (() => Promise<void>) | undefined;
      let bridge: TeamChatBridge | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: runtimeUrl!,
          realtimeDatabaseUrl: runtimeUrl!,
          authUrl: appOrigin,
          webOrigin: appOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "offline-page-approval-encryption-key",
        });
        stop = handles.stop;
        const { cookie, rpc } = await pageAppSession(handles);
        const credential = await rpc<ModelCredential>("models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        });
        const bot = await rpc<{ id: string }>("bots/create", {
          name: "Page approval fixture",
          title: "",
          description: "",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc("bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const db = admin();
        const { spaceId, userId } = await db.bot.findUniqueOrThrow({ where: { id: bot.id } });
        const scope = { spaceId, userId, botId: bot.id, groupId: null };
        const share = preparedShare({ ...scope, title: "Inventory" });
        await db.page.create({
          data: {
            ...scope,
            id: pageId,
            title: "Inventory",
            versions: {
              create: {
                version: 1,
                title: "Inventory",
                source: source("Original value"),
                code: "fixture current render",
              },
            },
          },
        });
        await runAsTenant({ spaceId, userId }, () => swapPageShare(client(), scope, pageId, share));
        await db.actionApprovalRule.create({
          data: {
            spaceId,
            createdByUserId: userId,
            matchKind: "tool",
            matchValue: "save_page",
            effect: "always_allow",
          },
        });
        let runId: string;
        if (routine) {
          const clock = new Date();
          const { id: routineId } = await rpc<{ id: string }>("routines/create", {
            botId: bot.id,
            name: "Refresh shared inventory",
            prompt,
            crons: [`${clock.getUTCMinutes()} ${(clock.getUTCHours() + 6) % 24} * * *`],
            timezone: "UTC",
            active: true,
          });
          const dueAt = new Date(clock.getTime() - 1_000);
          await db.routine.update({ where: { id: routineId }, data: { nextRunAt: dueAt } });
          await handles.jobs.enqueue(routineWakeupJob(routineId, dueAt));
          await handles.awaitIdle!();
          const run = await db.run.findFirstOrThrow({ where: { routineId } });
          expect(run).toMatchObject({ botId: bot.id, userId, trigger: "routine" });
          runId = run.id;
        } else if (teamChat) {
          const chat = new TeamChatBridge({
            prisma: handles.prisma,
            events: createThreadEvents(handles.prisma),
            jobs: handles.jobs,
            providerId: "slack",
            botId: bot.id,
            send: async () => ({ handle: "fixture-outbound" }),
          });
          bridge = chat;
          const eventId = randomUUID();
          const target = await runAsTenant({ spaceId, userId }, async () => {
            await chat.start();
            return chat.receive({
              eventId,
              workspaceId: "fixture-workspace",
              kind: "direct",
              conversationType: "channel",
              conversationKey: "fixture-channel",
              conversationId: "fixture-channel",
              senderId: "fixture-sender",
              senderName: "Fixture sender",
              content: prompt,
              replyThreadId: null,
            });
          });
          const inbound = await db.externalMessage.findFirstOrThrow({
            where: {
              providerEventId: eventId,
              externalConversation: { thread: { id: target.threadId } },
            },
          });
          if (!inbound.runId) throw new Error("Expected the TeamChat bridge to queue a Run");
          runId = inbound.runId;
        } else {
          ({ runId } = await rpc<{ runId: string }>("threads/send", {
            botId: bot.id,
            text: prompt,
          }));
        }
        const waitForStatus = async (status: string) => {
          await expect
            .poll(
              async () => {
                const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
                if (run.status === "failed") model.assertComplete();
                return run.status;
              },
              { timeout: 12_000, interval: 100 },
            )
            .toBe(status);
        };
        if (teamChat) {
          await waitForStatus("completed");
          model.assertComplete();
          expect(await db.externalEffect.count({ where: { runId, kind: "save_page" } })).toBe(0);
          expect(await db.pageVersion.count({ where: { pageId } })).toBe(1);
          expect(
            await db.message.findMany({ where: { runId, role: "bot" }, select: { blocks: true } }),
          ).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                blocks: expect.arrayContaining([expect.objectContaining({ kind: "ask" })]),
              }),
            ]),
          );
          return;
        }
        await waitForStatus("waiting_input");
        expect(model.requests).toHaveLength(1);
        expect(await db.page.findUniqueOrThrow({ where: { id: pageId } })).toMatchObject({
          currentVersion: 1,
        });
        const effect = await db.externalEffect.findFirstOrThrow({
          where: { runId, kind: "save_page", status: "intended" },
        });
        expect(effect.request).toMatchObject({
          requestKind: "shared_page_update",
          args,
          page: { id: pageId, version: 1 },
          detail: expect.stringMatching(/Original value[\s\S]*Reviewed value/),
        });
        const card = await db.message.findFirstOrThrow({
          where: { runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(card.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ask",
              approvalEffectId: effect.id,
              reviewMode: "screen",
              actions: [
                expect.objectContaining({ id: "allow" }),
                expect.objectContaining({ id: "deny" }),
              ],
            }),
          ]),
        );
        const answerInput = { botId: bot.id, runId, messageId: card.id };
        await expect(rpc("threads/answer", { ...answerInput, answer: "always" })).rejects.toThrow();
        await expect(
          rpc("threads/answer", {
            ...answerInput,
            answer: "allow",
            clientNonce: callClientNonce("fixture-call"),
          }),
        ).rejects.toThrow();
        expect(await db.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toEqual(
          effect,
        );
        if (outcome === "rotated") {
          await runAsTenant({ spaceId, userId }, async () => {
            await swapPageShare(client(), scope, pageId, null);
            const unshared = await client().page.findUniqueOrThrow({ where: { id: pageId } });
            await swapPageShare(client(), scope, pageId, preparedShare(unshared));
          });
        }
        if (markerOnly) {
          const checkpoint = await db.externalEffect.findFirstOrThrow({
            where: { runId, kind: "runtime_checkpoint", status: "runtime_checkpoint" },
          });
          const prefix = "shared-page-approval-v1:";
          if (typeof checkpoint.result !== "string" || !checkpoint.result.startsWith(prefix))
            throw new Error("Expected a shared Page checkpoint");
          const { transcript, ...marker } = JSON.parse(checkpoint.result.slice(prefix.length));
          expect(transcript).toEqual(expect.any(String));
          expect(marker).toEqual({
            effectKey: effect.idempotencyKey,
            requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
          await db.externalEffect.update({
            where: { id: checkpoint.id },
            data: { result: `${prefix}${JSON.stringify(marker)}` },
          });
        }
        await rpc("threads/answer", {
          ...answerInput,
          answer: denied ? "deny" : "allow",
        });
        await waitForStatus("completed");
        model.assertComplete();
        expect(model.requests).toHaveLength(markerOnly ? 3 : 2);
        const rows = await db.externalEffect.findMany({ where: { runId, kind: "save_page" } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: effect.id,
          request: effect.request,
          status: denied ? "denied" : "completed",
        });
        if (routine) {
          const messages = await db.message.findMany({
            where: { runId, role: "bot" },
            select: { id: true, blocks: true },
          });
          expect(messages).toEqual([
            {
              id: card.id,
              blocks: [
                expect.objectContaining({
                  kind: "ask",
                  approvalEffectId: effect.id,
                  status: "answered",
                  answer: "allow",
                }),
              ],
            },
          ]);
          expect(await db.page.findUniqueOrThrow({ where: { id: pageId } })).toMatchObject({
            currentVersion: 2,
            visibility: "link",
          });
        }
        expect(
          await db.pageVersion.findMany({
            where: { pageId },
            orderBy: { version: "asc" },
            select: { source: true },
          }),
        ).toEqual([
          { source: source("Original value") },
          ...(allowed ? [{ source: source("Reviewed value") }] : []),
        ]);
      } finally {
        try {
          try {
            await bridge?.stop();
          } finally {
            await stop?.();
          }
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    45_000,
  );

  it("resumes one shared Page approval at the same scripted cursor under row security", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cogine-page-scripted-approval-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: runtimeUrl!,
        realtimeDatabaseUrl: runtimeUrl!,
        authUrl: appOrigin,
        webOrigin: appOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        defaultProvider: "scripted",
        defaultModel: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-page-approval-encryption-key",
      });
      stop = handles.stop;
      const { cookie, rpc } = await pageAppSession(handles);
      const { id: botId } = await rpc<{ id: string }>("bots/create", {
        name: "Scripted Page fixture",
        title: "",
        description: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, botId);
      const enqueue = handles.jobs.enqueue.bind(handles.jobs);
      const held = vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
        if (job.name !== "run.continue") await enqueue(job);
      });
      try {
        const db = admin();
        const { spaceId, userId } = await db.bot.findUniqueOrThrow({ where: { id: botId } });
        const scope = { spaceId, userId, botId, groupId: null };
        const { id: pageId } = await db.page.create({
          data: {
            ...scope,
            title: "Inventory",
            versions: {
              create: {
                version: 1,
                title: "Inventory",
                source: source("Original value"),
                code: "fixture current render",
              },
            },
          },
        });
        const tenant = <T>(work: () => Promise<T>) => runAsTenant({ spaceId, userId }, work);
        await tenant(() =>
          swapPageShare(client(), scope, pageId, preparedShare({ ...scope, title: "Inventory" })),
        );
        const { runId: initialId } = await rpc<{ runId: string }>("threads/send", {
          botId,
          text: "Initial task",
        });
        const leaseOwner = "initial-scripted-worker";
        const leaseFence = 2;
        const initial = await db.run.update({
          where: { id: initialId, status: "queued" },
          data: {
            status: "running",
            leaseOwner,
            leaseFence,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        const attempt = await db.attempt.create({
          data: { runId: initialId, fence: leaseFence, status: "running" },
        });
        const args = { pageId, edits: [{ find: "Original value", replace: "Reviewed value" }] };
        for (const text of [
          "write a file called notes/before-review.txt that says before-review",
          `call save_page with ${JSON.stringify(args)}`,
          "write a file called notes/after-review.txt that says after-review",
        ]) {
          await rpc("threads/send", { botId, text });
        }
        const events = createThreadEvents(handles.prisma);
        const finished = await tenant(() =>
          events.finalizeRun({
            spaceId,
            threadId: initial.threadId,
            botId,
            runId: initial.id,
            taskId: initial.taskId,
            attemptId: attempt.id,
            leaseOwner,
            leaseFence,
            outcome: "completed",
            blocks: [{ kind: "text", text: "Initial answer" }],
          }),
        );
        const runId = finished?.continuationRunId;
        if (!runId) throw new Error("Expected a steering continuation");
        await tenant(() => handles.executor.continueRun(runId, "scripted-page-pause-worker"));
        const paused = await db.run.findUniqueOrThrow({ where: { id: runId } });
        expect(paused.status).toBe("waiting_input");
        const checkpoint = parseStoredScriptedState(paused.scriptedState, runId);
        expect(checkpoint).toMatchObject({
          version: 4,
          pause: { kind: "input", attemptId: checkpoint.attemptId, fence: checkpoint.fence },
          state: { cursor: { phase: "tool" } },
          pendingEffect: { kind: "save_page", requestKind: "shared_page_update" },
        });
        const effect = await db.externalEffect.findFirstOrThrow({
          where: { runId, kind: "save_page" },
        });
        expect(effect).toMatchObject({ id: checkpoint.pendingEffect!.id, status: "intended" });
        const messageId = checkpoint.pause!.messageId!;
        const card = await db.message.findUniqueOrThrow({ where: { id: messageId, runId } });
        expect(card.blocks).toEqual([
          expect.objectContaining({
            kind: "ask",
            approvalEffectId: effect.id,
            reviewMode: "screen",
            detail: expect.stringMatching(/Original value[\s\S]*Reviewed value/),
          }),
        ]);
        expect(await db.pageVersion.count({ where: { pageId } })).toBe(1);
        const fileEffects = () =>
          db.externalEffect.findMany({ where: { runId, kind: "write_file" } });
        const before = await fileEffects();
        expect(before).toEqual([
          expect.objectContaining({
            status: "completed",
            request: expect.objectContaining({ path: "notes/before-review.txt" }),
          }),
        ]);

        await rpc("threads/answer", { botId, runId, messageId, answer: "allow" });
        await tenant(() => handles.executor.continueRun(runId, "scripted-page-resume-worker"));

        await expect(db.run.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({
          status: "completed",
        });
        const effects = await db.externalEffect.findMany({ where: { runId, kind: "save_page" } });
        expect(effects).toEqual([
          expect.objectContaining({
            id: effect.id,
            idempotencyKey: effect.idempotencyKey,
            request: effect.request,
            status: "completed",
          }),
        ]);
        expect(
          await db.pageVersion.findMany({
            where: { pageId },
            orderBy: { version: "asc" },
            select: { source: true },
          }),
        ).toEqual([{ source: source("Original value") }, { source: source("Reviewed value") }]);
        const after = await fileEffects();
        expect(after).toHaveLength(2);
        expect(after).toEqual(
          expect.arrayContaining([
            before[0],
            expect.objectContaining({
              status: "completed",
              request: expect.objectContaining({ path: "notes/after-review.txt" }),
            }),
          ]),
        );
      } finally {
        held.mockRestore();
      }
    } finally {
      try {
        await stop?.();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 45_000);

  it("updates a scheduled Page in place and respects failure, pause, and deletion", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cogine-routine-page-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: runtimeUrl!,
        realtimeDatabaseUrl: runtimeUrl!,
        authUrl: appOrigin,
        webOrigin: appOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        defaultProvider: "scripted",
        defaultModel: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-routine-page-encryption-key",
      });
      stop = handles.stop;
      const { cookie, rpc } = await pageAppSession(handles);
      const { id: botId } = await rpc<{ id: string }>("bots/create", {
        name: "Scheduled Page fixture",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, botId);
      const db = admin();
      const { userId, thread } = await db.bot.findUniqueOrThrow({
        where: { id: botId },
        include: { thread: true },
      });
      const savePrompt = (args: Record<string, unknown>) =>
        `call save_page with ${JSON.stringify(args)}\nthen say NO_RESPONSE`;
      const clock = new Date();
      const { id: routineId } = await rpc<{ id: string }>("routines/create", {
        botId,
        name: "Refresh inventory",
        prompt: savePrompt({ title: "Inventory", source: source("Original value") }),
        crons: [`${clock.getUTCMinutes()} ${(clock.getUTCHours() + 6) % 24} * * *`],
        timezone: "UTC",
        active: true,
      });
      const observedRunIds: string[] = [];
      const makeDue = async () => {
        // Advance only the due timestamp; real queue and worker code handle the occurrence.
        const dueAt = new Date(clock.getTime() - 1_000 + observedRunIds.length);
        await db.routine.update({ where: { id: routineId }, data: { nextRunAt: dueAt } });
        return dueAt;
      };
      const deliver = async (dueAt: Date) => {
        await handles.jobs.enqueue(routineWakeupJob(routineId, dueAt));
        await handles.awaitIdle!();
      };
      const fire = async () => {
        await deliver(await makeDue());
        const runs = await db.run.findMany({
          where: { routineId, id: { notIn: observedRunIds } },
        });
        expect(runs).toHaveLength(1);
        const run = runs[0]!;
        expect(run).toMatchObject({
          botId,
          userId,
          threadId: thread!.id,
          trigger: "routine",
          status: "completed",
        });
        observedRunIds.push(run.id);
        return run.id;
      };
      const messages = (runId: string) =>
        db.message.findMany({ where: { runId }, select: { blocks: true } });
      const expectSaveError = async (runId: string, error: string) => {
        const completions = await db.event.findMany({
          where: { runId, type: "agent.tool.completed" },
          select: { payload: true },
        });
        expect(completions.map((event) => event.payload)).toEqual([
          expect.objectContaining({ name: "save_page", outcome: "error", error }),
        ]);
      };

      const firstRun = await fire();
      const { id: pageId } = await db.page.findFirstOrThrow({ where: { botId } });
      expect(await messages(firstRun)).toEqual([
        { blocks: [{ kind: "page", pageId, title: "Inventory", version: 1 }] },
      ]);

      const update = (args: Record<string, unknown>) =>
        rpc("routines/update", { routineId, prompt: savePrompt({ pageId, ...args }) });
      await update({ edits: [{ find: "Original value", replace: "Current value" }] });
      expect(await messages(await fire())).toEqual([]);
      const expectedVersions = [
        { version: 1, source: source("Original value") },
        { version: 2, source: source("Current value") },
      ];
      const versions = () =>
        db.pageVersion.findMany({
          where: { pageId },
          orderBy: { version: "asc" },
          select: { version: true, source: true },
        });
      expect(await versions()).toEqual(expectedVersions);

      await update({ source: "this is invalid JSX" });
      const failedRun = await fire();
      await expectSaveError(failedRun, "The page has problems; nothing was saved.");
      expect(await messages(failedRun)).toEqual([]);
      expect(await versions()).toEqual(expectedVersions);

      // Deliver a stale wakeup for an occurrence that was due before the owner paused.
      const pausedDueAt = await makeDue();
      await update({ source: source("Must never be saved while paused") });
      await expect(rpc("routines/update", { routineId, active: false })).resolves.toMatchObject({
        active: false,
        nextRunAt: null,
      });
      await deliver(pausedDueAt);
      expect(await db.run.count({ where: { routineId } })).toBe(observedRunIds.length);
      expect(await versions()).toEqual(expectedVersions);
      expect(await db.page.findMany({ where: { botId } })).toMatchObject([
        { id: pageId, currentVersion: 2 },
      ]);

      await expect(rpc("pages/remove", { pageId })).resolves.toEqual({ ok: true });
      await update({ title: "Inventory", source: source("Must never be recreated") });
      await rpc("routines/update", { routineId, active: true });
      const missingRun = await fire();
      await expectSaveError(missingRun, "No page with that pageId belongs to this bot or chat.");
      expect(await messages(missingRun)).toEqual([]);
      expect(await db.page.count({ where: { botId } })).toBe(0);
      expect(await versions()).toEqual([]);
    } finally {
      try {
        await stop?.();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 45_000);

  async function setup(trigger = "user", groupChat = false) {
    const id = randomUUID();
    const actor: Actor = {
      userId: `user-${id}`,
      spaceId: `space-${id}`,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const { userId, spaceId, email } = actor;
    const scope = { userId, spaceId };
    const db = admin();
    await db.user.create({ data: { id: userId, email, name: "Pages fixture" } });
    await db.space.create({
      data: {
        id: spaceId,
        name: "Pages fixture",
        organization: {
          create: { id, name: "Pages fixture", slug: id, createdAt: new Date() },
        },
      },
    });
    const bot = await db.bot.create({
      data: { ...scope, name: "Pages fixture", color: "#3EC5A8" },
    });
    const botScope = { ...scope, botId: bot.id };
    const group = groupChat
      ? await db.chatGroup.create({ data: { ...scope, name: "Pages fixture group" } })
      : null;
    const thread = await db.thread.create({
      data: group ? { ...scope, groupId: group.id } : botScope,
    });
    const task = await db.task.create({
      data: { ...botScope, threadId: thread.id, status: "running", prompt: "Pages fixture" },
    });
    const lease = { owner: "page-worker", fence: 1 };
    const run = await db.run.create({
      data: {
        ...botScope,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger,
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const notify = vi.fn<NonNullable<PageToolContext["notify"]>>(async () => undefined);
    const state = { tainted: false };
    const context = (effect: { id: string }, prisma = client()): PageToolContext => ({
      deps: { prisma },
      run,
      bot,
      thread,
      effect,
      lease,
      state,
      secrets: [],
      notify,
    });
    const newEffect = (args: Prisma.InputJsonValue, status = "intended") =>
      db.externalEffect.create({
        data: {
          spaceId,
          runId: run.id,
          kind: "save_page",
          status,
          idempotencyKey: randomUUID(),
          request: args,
        },
      });
    const seed = (
      title: string,
      attrs?: Pick<Prisma.PageUncheckedCreateInput, "id" | "updatedAt">,
    ) =>
      db.page.create({
        data: {
          ...botScope,
          title,
          ...attrs,
          versions: { create: { version: 1, title, source: source("Original"), code: "v1" } },
        },
      });
    const tenant = <T>(work: () => Promise<T>) => runAsTenant(actor, work);
    const cardWhere = { runId: run.id, threadId: thread.id, type: "thread.message.created" };
    return {
      actor,
      bot,
      run,
      thread,
      group,
      context,
      notify,
      state,
      seed,
      newEffect,
      tenant,
      cardWhere,
    };
  }

  it("keeps an unapproved private write private across a concurrent share", async () => {
    const f = await setup();
    const page = await f.seed("Inventory");
    const args = { pageId: page.id, source: source("Updated privately") };
    const effect = await f.newEffect(args);
    const interleaved = withTransaction(client(), async (next, work) => {
      await swapPageShare(client(), f.actor, page.id, preparedShare(page));
      return next(work);
    });

    await expect(
      f.tenant(() => savePageFromTool(f.context(effect, interleaved), args)),
    ).resolves.toMatchObject({ unchanged: true });

    expect(await admin().page.findUniqueOrThrow({ where: { id: page.id } })).toMatchObject({
      visibility: "link",
      currentVersion: 1,
    });
    expect(await admin().pageVersion.count({ where: { pageId: page.id } })).toBe(1);
    expect(await admin().event.count({ where: f.cardWhere })).toBe(0);
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({
      result: null,
    });
  });

  it.each([true, false])(
    "honors the owner's concurrent rename in a shared Routine update (explicit title: %s)",
    async (explicitTitle) => {
      const f = await setup("routine");
      const page = await f.seed("Inventory");
      const args = {
        pageId: page.id,
        source: source("Reviewed content"),
        ...(explicitTitle ? { title: "Reviewed title" } : {}),
      };
      const prepared = await f.tenant(async () => {
        await swapPageShare(client(), f.actor, page.id, preparedShare(page));
        return prepareSharedPageUpdate(f.context({ id: "prepare-only" }), args);
      });
      if (!prepared || !("request" in prepared)) throw new Error("Expected a shared Page review");
      const effect = await f.newEffect(prepared.request as Prisma.InputJsonObject, "executing");
      const ctx = { ...f.context(effect), approvedSharedPageRequest: prepared.request };
      await f.tenant(() => renamePage(client(), f.actor, page.id, "Owner rename"));

      const outcome = await f.tenant(() => savePageFromTool(ctx, args));
      if (explicitTitle) {
        expect(outcome).toMatchObject({ unchanged: true });
        expect(await admin().pageVersion.count({ where: { pageId: page.id } })).toBe(1);
      } else {
        expect(outcome).toMatchObject({ pageId: page.id, version: 2, title: "Owner rename" });
        await f.tenant(() => swapPageShare(client(), f.actor, page.id, null));
        await expect(
          f.tenant(() => recoverSavedPageFromTool(f.context(effect), args)),
        ).resolves.toEqual(outcome);
      }
      expect(await admin().event.count({ where: f.cardWhere })).toBe(0);
    },
  );

  it.each(
    (["intended", "executing"] as const).flatMap((status) =>
      (["create", "source", "edits"] as const).map((mode) => ({ status, mode })),
    ),
  )("replays $status $mode after the commit reply is lost", async ({ status, mode }) => {
    const { bot, run, thread, context, notify, newEffect, seed, tenant, cardWhere } = await setup();
    const previous = mode === "create" ? undefined : await seed("Plan");
    const args =
      mode === "create"
        ? { title: "Plan", source: source("Original") }
        : mode === "source"
          ? { pageId: previous!.id, source: source("Updated") }
          : { pageId: previous!.id, edits: [{ find: "Original", replace: "Original updated" }] };
    const effect = await newEffect(args, status);
    const version = mode === "create" ? 1 : 2;
    let interrupted = false;
    const ctx = context(
      effect,
      withTransaction(client(), async (next, work) => {
        const value = await next(work);
        if (!interrupted) {
          interrupted = true;
          throw new Error("lost reply after PostgreSQL commit");
        }
        return value;
      }),
    );
    const resume = () =>
      status === "executing" ? recoverSavedPageFromTool(ctx, args) : savePageFromTool(ctx, args);
    if (status === "executing") await expect(tenant(resume)).resolves.toBeUndefined();
    await expect(tenant(() => savePageFromTool(ctx, args))).rejects.toThrow("lost reply");

    const row = await admin().page.findFirstOrThrow({ where: { botId: bot.id } });
    expect(row).toMatchObject({ currentVersion: version, visibility: "private" });
    const block = { kind: "page", pageId: row.id, title: "Plan", version };
    const message = await admin().message.findFirstOrThrow({
      where: { threadId: thread.id, clientNonce: `page-save:${effect.id}` },
    });
    expect(message.blocks).toEqual([block]);
    const event = await admin().event.findFirstOrThrow({ where: cardWhere });
    expect(event.payload).toMatchObject({
      messageId: message.id,
      messageSeq: message.seq,
      blocks: [block],
    });
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({
      status,
      result: {
        kind: "page_save",
        cardEventSeq: event.seq,
        saved: { pageId: row.id, title: "Plan", version },
      },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(
      (await admin().run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(event.createdAt);

    if (status === "executing") {
      for (const changed of [
        { ...ctx, effect: { id: "another-effect" } },
        { ...ctx, run: { ...ctx.run, id: "another-run" } },
        { ...ctx, run: { ...ctx.run, userId: "another-user" } },
        { ...ctx, run: { ...ctx.run, spaceId: "another-space" } },
        { ...ctx, run: { ...ctx.run, threadId: "another-thread" } },
        { ...ctx, bot: { id: "another-bot" } },
      ]) {
        await expect(
          tenant(() => recoverSavedPageFromTool(changed, args)),
        ).resolves.toBeUndefined();
      }
      await expect(
        tenant(() => recoverSavedPageFromTool(ctx, { ...args, title: "Changed request" })),
      ).resolves.toBeUndefined();
    }
    const result = await tenant(resume);
    expect(result).toMatchObject({ pageId: row.id, version });
    await expect(tenant(resume)).resolves.toEqual(result);
    expect(notify).toHaveBeenCalledWith(thread.id, event.seq, undefined);
    expect(await admin().pageVersion.count({ where: { pageId: row.id } })).toBe(version);
    expect(await admin().message.count({ where: { threadId: thread.id } })).toBe(1);
    expect(await admin().event.count({ where: cardWhere })).toBe(1);

    const next = context(await newEffect(args));
    await expect(tenant(() => savePageFromTool(next, args))).resolves.toMatchObject({
      version: mode === "create" ? 1 : version + 1,
    });
    expect(await admin().event.count({ where: cardWhere })).toBe(2);
    expect(notify.mock.lastCall?.[2]).toBeUndefined();
    expect(
      (await admin().run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(event.createdAt);
  });

  it("serializes same-effect callers before creating any duplicate Page, version or card", async () => {
    const { bot, run, context, notify, newEffect, tenant, cardWhere, thread } = await setup();
    const args = { title: "Race", source: source("Race") };
    const effect = await newEffect(args);
    let entrants = 0;
    const bothReady = Promise.withResolvers<void>();
    const ctx = context(
      effect,
      withTransaction(client(), async (next, work) => {
        if (++entrants === 2) bothReady.resolve();
        await bothReady.promise;
        return next(work);
      }),
    );
    const [first, second] = await Promise.all([
      tenant(() => savePageFromTool(ctx, args)),
      tenant(() => savePageFromTool(ctx, args)),
    ]);
    expect(entrants).toBe(2);
    expect(first).toMatchObject({ title: "Race", version: 1 });
    expect(second).toEqual(first);
    expect(await admin().page.count({ where: { botId: bot.id } })).toBe(1);
    expect(await admin().pageVersion.count({ where: { page: { botId: bot.id } } })).toBe(1);
    expect(await admin().message.count({ where: { threadId: thread.id } })).toBe(1);
    const events = await admin().event.findMany({ where: cardWhere });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(notify.mock.calls).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith(thread.id, event.seq, run.id);
    expect(notify).toHaveBeenCalledWith(thread.id, event.seq, undefined);
    expect(
      (await admin().run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(event.createdAt);
  });

  it("rolls back the Page, version, card, sequence and receipt when event persistence fails", async () => {
    const { bot, context, newEffect, tenant, cardWhere, thread, notify } = await setup();
    const args = { title: "Rollback", source: source("Rollback") };
    const effect = await newEffect(args);
    const failed = context(
      effect,
      withTransaction(client(), (next, work) =>
        next((tx) =>
          work(
            new Proxy(tx, {
              get(target, key) {
                if (key === "event") {
                  return {
                    create: async () => {
                      throw new Error("injected event failure");
                    },
                  };
                }
                return Reflect.get(target, key, target);
              },
            }),
          ),
        ),
      ),
    );
    await expect(tenant(() => savePageFromTool(failed, args))).rejects.toThrow(
      "injected event failure",
    );
    expect(await admin().page.count({ where: { botId: bot.id } })).toBe(0);
    expect(await admin().pageVersion.count({ where: { page: { botId: bot.id } } })).toBe(0);
    expect(await admin().message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await admin().event.count({ where: cardWhere })).toBe(0);
    expect(await admin().thread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({
      nextEventSeq: 0,
      nextMessageSeq: 0,
    });
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({
      result: null,
    });
    expect(notify).not.toHaveBeenCalled();
    await expect(tenant(() => savePageFromTool(context(effect), args))).resolves.toMatchObject({
      version: 1,
    });
    expect(await admin().event.count({ where: cardWhere })).toBe(1);
  });

  it.each(["version", "rename"] as const)(
    "keeps a competing %s made after the content read",
    async (concurrent) => {
      const { actor, context, newEffect, seed, tenant, cardWhere } = await setup();
      const stored = await seed("Before");
      const args = { pageId: stored.id, source: source("Next") };
      const effect = await newEffect(args);
      const reachedWrite = Promise.withResolvers<void>();
      const competingWrite = Promise.withResolvers<void>();
      const ctx = context(
        effect,
        withTransaction(client(), async (next, work) => {
          reachedWrite.resolve();
          await competingWrite.promise;
          return next(work);
        }),
      );
      const writing = tenant(() => savePageFromTool(ctx, args));
      await Promise.race([reachedWrite.promise, writing]);
      try {
        if (concurrent === "version") {
          await admin().page.update({
            where: { id: stored.id },
            data: {
              currentVersion: 2,
              versions: {
                create: { version: 2, title: "Before", source: source("Winner"), code: "v2" },
              },
            },
          });
        } else {
          await tenant(() => renamePage(client(), actor, stored.id, "Renamed"));
        }
      } finally {
        competingWrite.resolve();
      }
      if (concurrent === "version") {
        await expect(writing).resolves.toMatchObject({ unchanged: true });
        expect(
          await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
        ).toMatchObject({
          result: null,
        });
        expect(await admin().event.count({ where: cardWhere })).toBe(0);
      } else {
        await expect(writing).resolves.toMatchObject({ title: "Renamed", version: 2 });
        expect(await admin().event.count({ where: cardWhere })).toBe(1);
      }
      const versions = await admin().pageVersion.findMany({
        where: { pageId: stored.id },
        orderBy: { version: "asc" },
      });
      expect(versions.map(({ title, source }) => ({ title, source }))).toEqual([
        { title: "Before", source: source("Original") },
        concurrent === "version"
          ? { title: "Before", source: source("Winner") }
          : { title: "Renamed", source: source("Next") },
      ]);
    },
  );

  it("requires a live lease for writes and taints a scoped source read without a write", async () => {
    const { context, newEffect, seed, tenant, cardWhere, state } = await setup();
    const stored = await seed("Read");
    const read = { pageId: stored.id };
    const args = { pageId: stored.id, source: source("Stale worker") };
    const ctx = context(await newEffect(args));
    await expect(
      tenant(() => savePageFromTool({ ...ctx, lease: { ...ctx.lease, fence: 0 } }, args)),
    ).rejects.toThrow();
    await expect(tenant(() => savePageFromTool(ctx, read))).resolves.toMatchObject({
      source: source("Original"),
      version: 1,
    });
    expect(state.tainted).toBe(true);
    expect(await admin().event.count({ where: cardWhere })).toBe(0);
    expect(await admin().pageVersion.count({ where: { pageId: stored.id } })).toBe(1);
  });

  it("restricts a group Page to its chat and admits another bot in that chat", async () => {
    const { actor, bot, group, context, newEffect, tenant, cardWhere } = await setup("user", true);
    const args = { title: "Group", source: source("New group page") };
    const ctx = context(await newEffect(args));
    const saved = await tenant(() => savePageFromTool(ctx, args));
    expect(saved).toMatchObject({ version: 1, title: "Group" });
    const row = await admin().page.findFirstOrThrow({ where: { botId: bot.id } });
    expect(row).toMatchObject({ groupId: group!.id, userId: actor.userId, visibility: "private" });
    const read = { pageId: row.id };
    for (const groupId of [null, "another-group"]) {
      await expect(
        tenant(() => savePageFromTool({ ...ctx, thread: { groupId } }, read)),
      ).resolves.toMatchObject({ error: expect.any(String) });
    }

    const { userId, spaceId } = actor;
    const peer = await admin().bot.create({
      data: { spaceId, userId, name: "Group peer", color: "#3EC5A8" },
    });
    await admin().chatGroupMember.createMany({
      data: [bot, peer].map(({ id }) => ({ groupId: group!.id, botId: id })),
    });
    await expect(
      tenant(() => savePageFromTool({ ...ctx, bot: peer }, read)),
    ).resolves.toMatchObject({
      pageId: row.id,
      version: 1,
      source: source("New group page"),
    });
    expect(await admin().event.count({ where: cardWhere })).toBe(1);
    const grouped = await tenant(() => listPages(client(), actor, { groupId: group!.id }));
    expect(grouped.items.map(({ id }) => id)).toEqual([row.id]);
    const personal = await tenant(() => listPages(client(), actor, { botId: bot.id }));
    expect(personal.items).toEqual([]);
  });

  it.each(["routine", "tickets"])("keeps a %s Page update silent", async (trigger) => {
    const { context, newEffect, tenant, cardWhere } = await setup(trigger);
    const args = { title: "Background", source: source("First") };
    const result = await tenant(async () => savePageFromTool(context(await newEffect(args)), args));
    expect(result).toMatchObject({ pageId: expect.any(String), version: 1 });
    if (!("pageId" in result) || !result.pageId) throw new Error("Missing saved Page");
    const update = { pageId: result.pageId, source: source("Second") };
    const effect = await newEffect(update);
    await expect(tenant(() => savePageFromTool(context(effect), update))).resolves.toMatchObject({
      version: 2,
    });
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({ result: { cardEventSeq: null } });
    expect(await admin().event.count({ where: cardWhere })).toBe(trigger === "routine" ? 1 : 0);
  });

  it("uses literal title search for characters with SQL pattern meanings", async () => {
    const { actor, seed, tenant } = await setup();
    const percent = await seed("100% planned");
    const underscore = await seed("foo_bar");
    const backslash = await seed("path\\src");
    await seed("100 planned");
    await seed("fooxbar");
    await seed("pathsrc");
    for (const [query, wanted] of [
      ["100%", percent],
      ["foo_bar", underscore],
      ["path\\src", backslash],
    ] as const) {
      const results = await tenant(() => listPages(client(), actor, { query }));
      expect(results.items.map(({ id }) => id)).toEqual([wanted.id]);
    }
    await expect(
      tenant(() => listPages(client(), actor, { query: "a\u0000b" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a malformed cursor without passing unsupported values to PostgreSQL", async () => {
    const { actor, seed, tenant } = await setup();
    const stored = await seed("Cursor");
    const cursor = {
      id: stored.id,
      updatedAt: stored.updatedAt.toISOString(),
      pinnedAt: null,
    };
    for (const invalid of [
      { ...cursor, id: "a\u0000b" },
      { ...cursor, updatedAt: "-100000-01-02T10:00:00.000Z" },
      { ...cursor, pinnedAt: "0000-01-02T10:00:00.000Z" },
    ]) {
      const opaque = Buffer.from(JSON.stringify(invalid)).toString("base64url");
      await expect(
        tenant(() => listPages(client(), actor, { cursor: opaque })),
      ).rejects.toBeInstanceOf(PageListCursorError);
    }
  });

  it("isolates Page and version data and paginates pinned ties under the real runtime role", async () => {
    const { actor, bot, seed, tenant } = await setup();
    const stranger = await setup();
    const updatedAt = new Date("2026-01-01T12:00:00.123Z");
    const a = await seed("Report A", { id: `a-${randomUUID()}`, updatedAt });
    const b = await seed("Report B", { id: `b-${randomUUID()}`, updatedAt });
    const c = await seed("Draft", { id: `c-${randomUUID()}`, updatedAt });
    await stranger.seed("Report secret");
    const pin = () => tenant(() => pinPage(client(), actor, a.id, true));
    const pins = await Promise.all([pin(), pin()]);
    expect(pins).toEqual([pins[0], pins[0]]);
    expect(pins[0]).toMatchObject({
      currentVersion: 1,
      updatedAt: updatedAt.toISOString(),
      pinned: true,
    });
    const pinnedAt = (await admin().page.findUniqueOrThrow({ where: { id: a.id } })).pinnedAt;
    await pin();
    expect(pinnedAt).toBeInstanceOf(Date);
    expect((await admin().page.findUniqueOrThrow({ where: { id: a.id } })).pinnedAt).toEqual(
      pinnedAt,
    );

    const list = (cursor?: string) =>
      tenant(() => listPages(client(), actor, { botId: bot.id, limit: 1, cursor }));
    const first = await list();
    const second = await list(first.nextCursor!);
    const third = await list(second.nextCursor!);
    expect([first, second, third].map(({ items }) => items[0]?.id)).toEqual([a.id, c.id, b.id]);
    expect(third.nextCursor).toBeNull();
    const reports = await tenant(() => listPages(client(), actor, { query: "rEpOrT" }));
    expect(reports.items.map(({ id }) => id)).toEqual([a.id, b.id]);
    await expect(
      tenant(() => getPage(client(), actor, { pageId: a.id, version: 1 })),
    ).resolves.toMatchObject({ id: a.id, version: 1, code: "v1", visibility: "private" });
    await expect(
      tenant(() => getPage(client(), actor, { pageId: a.id, version: 2 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      stranger.tenant(() => getPage(client(), stranger.actor, { pageId: a.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Even a forgotten Prisma filter cannot expose another user's Page or version.
    const foreignPages = { where: { id: a.id } };
    const foreignVersions = { where: { pageId: a.id } };
    await expect(stranger.tenant(() => client().page.count(foreignPages))).resolves.toBe(0);
    await expect(stranger.tenant(() => client().pageVersion.count(foreignVersions))).resolves.toBe(
      0,
    );
    await expect(
      runAsTenant({ ...actor, spaceId: stranger.actor.spaceId }, () =>
        client().page.count(foreignPages),
      ),
    ).resolves.toBe(0);
    const anonymous = await runtime!.pool.query("SELECT id FROM cogine_pages.pages WHERE id=$1", [
      a.id,
    ]);
    expect(anonymous.rows).toEqual([]);
    await expect(
      stranger.tenant(() => removePage(client(), stranger.actor, a.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tenant(() => removePage(client(), actor, a.id))).resolves.toEqual({ ok: true });
    expect(await admin().pageVersion.count(foreignVersions)).toBe(0);
  });

  it("commits one of two concurrent owner links, rotates the exact old link, and revokes it", async () => {
    const { actor, seed, tenant } = await setup();
    const page = await seed("Private plan");
    const selector = { where: { id: page.id } };
    const candidates = [preparedShare(page), preparedShare(page)];
    const { promise: bothRead, resolve: resume } = Promise.withResolvers<void>();
    let reads = 0;
    const concurrent = afterPageRead(client(), async () => {
      if (reads >= 2) return;
      if (++reads === 2) resume();
      await bothRead;
    });
    const outcomes = await Promise.all(
      candidates.map((next) => tenant(() => swapPageShare(concurrent, actor, page.id, next))),
    );
    expect(reads).toBe(2);
    expect(outcomes.map(({ kept }) => kept).sort()).toEqual([false, true]);
    const winner = candidates[outcomes.findIndex(({ kept }) => !kept)]!;
    const secretIds = candidates.map(({ secret }) => secret.id);
    expect(
      await admin().secret.findMany({ where: { id: { in: secretIds } }, select: { id: true } }),
    ).toEqual([{ id: winner.secret.id }]);
    await expect(admin().page.findUniqueOrThrow(selector)).resolves.toMatchObject({
      visibility: "link",
      shareTokenHash: winner.tokenHash,
      shareSecretId: winner.secret.id,
    });
    // A stale observation of the prior generation cannot replace the winner.
    await expect(
      tenant(() =>
        swapPageShare(client(), actor, page.id, {
          ...preparedShare(page),
          unreadable: randomUUID(),
        }),
      ),
    ).resolves.toMatchObject({ kept: true, shareSecretId: winner.secret.id });
    const replacement = preparedShare(await admin().page.findUniqueOrThrow(selector));
    await expect(
      tenant(() =>
        swapPageShare(client(), actor, page.id, { ...replacement, unreadable: winner.secret.id }),
      ),
    ).resolves.toEqual({ kept: false });
    await expect(
      admin().secret.findUnique({ where: { id: winner.secret.id } }),
    ).resolves.toBeNull();
    await expect(tenant(() => swapPageShare(client(), actor, page.id, null))).resolves.toEqual({
      kept: false,
    });
    await expect(
      admin().secret.findUnique({ where: { id: replacement.secret.id } }),
    ).resolves.toBeNull();
    await expect(tenant(() => swapPageShare(client(), actor, page.id, null))).resolves.toEqual({
      kept: false,
    });
    await expect(admin().page.findUniqueOrThrow(selector)).resolves.toMatchObject({
      visibility: "private",
      shareTokenHash: null,
      shareSecretId: null,
      updatedAt: page.updatedAt,
      currentVersion: page.currentVersion,
    });
  });

  it("refuses a prepared link after Bot deletion detaches a retained private Page", async () => {
    const { actor, bot, seed, tenant } = await setup();
    const page = await seed("Retained private Page");
    const staged = preparedShare(page);
    let detached = false;
    const duringDetach = afterPageRead(client(), async () => {
      if (detached) return;
      detached = true;
      await admin().bot.delete({ where: { id: bot.id } });
    });
    await expect(
      tenant(() => swapPageShare(duringDetach, actor, page.id, staged)),
    ).rejects.toBeInstanceOf(PageShareConflictError);
    await expect(
      admin().secret.findUnique({ where: { id: staged.secret.id } }),
    ).resolves.toBeNull();
    const retained = await admin().page.findUniqueOrThrow({ where: { id: page.id } });
    expect(retained).toMatchObject({
      botId: null,
      visibility: "private",
      shareTokenHash: null,
      shareSecretId: null,
    });
    await expect(
      tenant(() => swapPageShare(client(), actor, page.id, preparedShare(retained))),
    ).resolves.toEqual({ kept: false });
  });

  it.each(["version", "title"] as const)(
    "compares the confirmed %s again when committing the staged share",
    async (field) => {
      const { actor, seed, tenant } = await setup();
      const page = await seed("Reviewed Page");
      const next = preparedShare(page);
      const renamed = "Renamed before publication";
      const nextVersion = page.currentVersion + 1;
      let changed = false;
      const duringShare = afterPageRead(client(), async () => {
        if (changed) return;
        changed = true;
        await admin().page.update({
          where: { id: page.id },
          data:
            field === "title"
              ? { title: renamed }
              : {
                  currentVersion: nextVersion,
                  versions: {
                    create: {
                      version: nextVersion,
                      title: page.title,
                      source: source("New content"),
                      code: "new version render",
                    },
                  },
                },
        });
      });
      await expect(
        tenant(() => swapPageShare(duringShare, actor, page.id, next)),
      ).rejects.toBeInstanceOf(PageShareConflictError);
      expect(changed).toBe(true);
      expect(await admin().secret.findUnique({ where: { id: next.secret.id } })).toBeNull();
      expect(await admin().page.findUnique({ where: { id: page.id } })).toMatchObject({
        visibility: "private",
        title: field === "title" ? renamed : page.title,
        currentVersion: field === "version" ? nextVersion : page.currentVersion,
        shareSecretId: null,
        shareTokenHash: null,
      });
    },
  );

  it("scopes share changes and terminal revocation to the Page owner's token", async () => {
    const { actor, seed, tenant } = await setup();
    const stranger = await setup();
    const page = await seed("Owned");
    const credentialPage = await seed("Wrong secret kind");
    const foreignPage = await seed("Wrong secret owner");
    const elsewhere = await stranger.seed("Another Space");
    const next = preparedShare(page);
    const other = preparedShare(elsewhere);
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    await expect(
      stranger.tenant(() => swapPageShare(client(), actor, page.id, next)),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      tenant(() =>
        swapPageShare(client(), { ...scope, spaceId: stranger.actor.spaceId }, page.id, next),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(admin().secret.findUnique({ where: { id: next.secret.id } })).resolves.toBeNull();
    await tenant(() => swapPageShare(client(), actor, page.id, next));
    await stranger.tenant(() => swapPageShare(client(), stranger.actor, elsewhere.id, other));

    const credential = await admin().secret.create({
      data: { ...scope, kind: "fixture_credential", ciphertext: "unrelated credential" },
    });
    const foreign = await admin().secret.create({
      data: {
        userId: stranger.actor.userId,
        spaceId: stranger.actor.spaceId,
        kind: PAGE_SHARE_SECRET_KIND,
        ciphertext: "unrelated sealed token",
      },
    });
    for (const [target, secret] of [
      [credentialPage, credential],
      [foreignPage, foreign],
    ]) {
      await admin().page.update({
        where: { id: target.id },
        data: {
          visibility: "link",
          shareTokenHash: preparedShare(target).tokenHash,
          shareSecretId: secret.id,
        },
      });
    }
    const pageIds = [page.id, credentialPage.id, foreignPage.id];
    await expect(
      tenant(() =>
        client().$transaction((tx) =>
          deletePageShareSecrets(tx, { ...scope, id: { in: [...pageIds, elsewhere.id] } }),
        ),
      ),
    ).resolves.toBeUndefined();
    const revoked = await admin().page.findMany({ where: { id: { in: pageIds } } });
    expect(revoked).toHaveLength(3);
    expect(
      revoked.every(
        ({ visibility, shareTokenHash, shareSecretId }) =>
          visibility === "private" && shareTokenHash === null && shareSecretId === null,
      ),
    ).toBe(true);
    await expect(
      admin().page.findUniqueOrThrow({ where: { id: elsewhere.id } }),
    ).resolves.toMatchObject({
      visibility: "link",
      shareTokenHash: other.tokenHash,
      shareSecretId: other.secret.id,
    });
    const kept = await admin().secret.findMany({
      where: { id: { in: [next.secret.id, credential.id, foreign.id] } },
      select: { id: true },
    });
    expect(kept.map(({ id }) => id).sort()).toEqual([credential.id, foreign.id].sort());
  });
});
