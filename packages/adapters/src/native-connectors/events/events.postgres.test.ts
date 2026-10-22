import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type {
  NativeEventAuthorizationProof,
  NativeEventObservation,
  NativeEventScope,
  NativeRoutineEventSpec,
} from "@rakazo/contracts";
import { nativeEventApp, nativeEventResource } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { createJobReconciler } from "../../job-reconciler.js";
import { ingestDiscordRoutine, processDiscordRoutine } from "./discord-interactions.js";
import type { NativeRoutineTriggerRow } from "./store.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
  listNativeRoutineTriggers,
  listNativeRoutineTriggersBatch,
  nativeEventRunNonce,
  saveNativeRoutineTrigger,
} from "./store.js";
import type { NativeEventReaders } from "./worker.js";
import { handleNativeSourceJob } from "./worker.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("native event authorization and permanent receipts (PostgreSQL)", () => {
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let db: PrismaClient;
  let peer: PrismaClient;
  const configIds = new Set<string>();
  const org = randomUUID(),
    owner = randomUUID(),
    other = randomUUID(),
    space = randomUUID(),
    otherSpace = randomUUID();
  const scope: NativeEventScope = { userId: owner, spaceId: space };
  const now = () => new Date();
  beforeAll(async () => {
    first = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-event-first",
    });
    second = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-event-second",
    });
    db = first.prisma;
    peer = second.prisma;
    // A missing migration is a failure, not a condition for skipping this suite.
    await db.$queryRaw`SELECT id FROM native_routine_triggers LIMIT 0`;

    // DB calls, locks and unique receipts remain real; no Prisma delegates are mocked.
    const [version] = await db.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    assert.match(version!.version, /PostgreSQL/);
    await db.organization.create({
      data: { id: org, name: "Synthetic event organization", slug: org, createdAt: now() },
    });
    for (const id of [owner, other]) {
      await db.user.create({ data: { id, name: "Synthetic", email: `${id}@example.test` } });
      await db.member.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          userId: id,
          role: "member",
          createdAt: now(),
        },
      });
    }
    for (const id of [space, otherSpace]) {
      await db.space.create({ data: { id, organizationId: org, name: "Synthetic space" } });
      for (const userId of [owner, other])
        await db.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId: id,
            userId,
            organizationId: org,
            role: "member",
            createdAt: now(),
          },
        });
    }
  });
  afterAll(async () => {
    try {
      if (first) {
        // Only these synthetic identities/configurations belong to this suite.
        await first.prisma.organization.deleteMany({ where: { id: org } });
        await first.prisma.nativeAppConfig.deleteMany({ where: { id: { in: [...configIds] } } });
        await first.prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
      }
    } finally {
      await Promise.all(
        [first, second].filter(Boolean).map(async (client) => {
          try {
            await client.prisma.$disconnect();
          } finally {
            await client.pool.end();
          }
        }),
      );
    }
  });
  async function fixture(override?: NativeRoutineEventSpec) {
    const spec: NativeRoutineEventSpec = override ?? {
      kind: "calendar.event_changed",
      calendarId: "primary",
      target: { kind: "calendar" },
    };
    const application = nativeEventApp(spec);

    const config = await db.nativeAppConfig.create({
      data: {
        appId: application,
        label: "Synthetic event source",
        ownership: "byo",
        credentialKind: "oauth",
        callbackUri: "https://bot.example.test/api/connectors/oauth/callback",
        config: {
          scopes: ["openid", "https://www.googleapis.com/auth/calendar.events.readonly"],
          capabilities: [],
          knowledgeBaseIds: [],
        },
      },
    });
    configIds.add(config.id);
    const secret = await db.secret.create({
      data: {
        ...scope,
        kind: "native_grant",
        ciphertext: "synthetic-encrypted-material-not-used-by-store",
      },
    });
    const grant = await db.nativeOAuthGrant.create({
      data: {
        id: randomUUID(),
        ...scope,
        configId: config.id,
        configRevision: config.revision,
        authority: "https://accounts.example.test",
        subject: "synthetic-subject",
        secretId: secret.id,
        scopes: ["openid", "https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    });
    const revision = `${grant.id}:${grant.authGeneration}`;
    const connection = await db.connection.create({
      data: {
        ...scope,
        connectorId: "native",
        provider: application,
        providerRef: grant.id,
        displayName: "Synthetic account",
        status: "connected",
        oauthGrantId: grant.id,
        nativeConfigId: config.id,
        nativeConfigRevision: config.revision,
        metadata: { authRevision: revision },
      },
    });
    const bot = await db.bot.create({ data: { ...scope, name: "Synthetic Bot", color: "ink" } }),
      thread = await db.thread.create({ data: { ...scope, botId: bot.id } });
    const cron = new Date(Date.now() + 86400000);
    const routine = await db.routine.create({
      data: {
        ...scope,
        botId: bot.id,
        name: "Exact Routine",
        prompt: "Use the original instruction",
        crons: ["0 9 * * *"],
        nextRunAt: cron,
        active: true,
        modelProvider: "synthetic-model-provider",
        modelId: "synthetic-model",
        thinkingLevel: "high",
      },
    });
    const untouched = await db.routine.create({
      data: {
        ...scope,
        botId: bot.id,
        name: "Unconfigured sibling",
        prompt: "Must never run",
        crons: ["0 10 * * *"],
        nextRunAt: cron,
        active: true,
      },
    });
    await db.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ type: "text", text: "Synthetic original chat" }],
      },
    });
    const proof: NativeEventAuthorizationProof = {
      ...scope,
      connectionId: connection.id,
      authorizationRevision: revision,
      grantId: grant.id,
      authGeneration: grant.authGeneration,
      configId: config.id,
      configRevision: config.revision,
      appId: application,
      resource: nativeEventResource(spec),
      spec,
    };
    const trigger = await saveNativeRoutineTrigger(
      db,
      scope,
      routine.id,
      { input: { connectionId: connection.id, spec }, proof },
      new Date(Date.now() - 60000),
    );
    const leased = await leaseNativeEventSource(db, scope, trigger.id, trigger.version);
    assert.ok(leased?.leaseId);
    assert.equal(
      await checkpointNativeEventSource(db, scope, {
        triggerId: trigger.id,
        triggerVersion: trigger.version,
        leaseId: leased.leaseId,
        state: { ready: true },
        nextPollAt: now(),
        release: false,
      }),
      true,
    );
    const rows = await db.$queryRaw<
      NativeRoutineTriggerRow[]
    >`SELECT * FROM native_routine_triggers WHERE id=${trigger.id}`;
    const row = rows[0]!;
    const event: NativeEventObservation = {
      triggerId: row.id,
      triggerVersion: row.version,
      connectionId: connection.id,
      authorizationRevision: revision,
      kind: spec.kind,
      resource: nativeEventResource(spec),
      eventId: "synthetic-event",
      eventIdentity: "synthetic-event-version-1",
      observedVersion: "etag-v1",
      occurredAt: now().toISOString(),
      evidence: "calendar_sync",
    };
    return {
      config,
      secret,
      grant,
      connection,
      bot,
      thread,
      routine,
      untouched,
      proof,
      row,
      event,
      leaseId: row.leaseId!,
      cron,
    };
  }
  async function counts(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      tasks: await db.task.count({ where: { botId: f.bot.id } }),
      runs: await db.run.count({ where: { botId: f.bot.id } }),
      messages: await db.message.count({ where: { threadId: f.thread.id } }),
      events: await db.event.count({ where: { threadId: f.thread.id } }),
    };
  }
  it("Discord signed ingress uses actual active-grant/current-Space/explicit-Routine SQL fences before durable queue publication", async () => {
    const appId = "223456789012345678",
      guildId = "323456789012345678",
      channelId = "423456789012345678",
      commandId = "523456789012345678",
      botId = "123456789012345678";
    const spec: NativeRoutineEventSpec = {
        kind: "discord.command.invoked",
        guildId,
        channelId,
        commandId,
        commandName: "review",
      },
      f = await fixture(spec);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
      key = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    await db.nativeAppConfig.update({
      where: { id: f.config.id },
      data: {
        credentialKind: "bot_token",
        config: {
          actor: "bot",
          scopes: [],
          capabilities: ["commands"],
          knowledgeBaseIds: [],
          boundSpaceId: space,
          tenantId: guildId,
          targetIds: [channelId],
        },
      },
    });
    await db.nativeOAuthGrant.update({
      where: { id: f.grant.id },
      data: {
        subject: botId,
        tenant: guildId,
        principal: {
          actorType: "bot",
          credentialType: "bot_token",
          scopeAuthority: "provider_enforced",
          botId,
          applicationId: appId,
          interactionPublicKey: key,
          boundSpaceId: space,
          configRevision: f.config.revision,
          bindingNamespace: "guild",
          verifiedTargets: [{ id: channelId, guildId }],
        },
      },
    });
    const interactionId = (((BigInt(Date.now()) - 1420070400000n) << 22n) + 1n).toString(),
      raw = new TextEncoder().encode(
        JSON.stringify({
          type: 2,
          id: interactionId,
          application_id: appId,
          guild_id: guildId,
          channel_id: channelId,
          member: { user: { id: "623456789012345678" } },
          token: "fixture-never-retained-token",
          data: { id: commandId, type: 1, name: "review" },
        }),
      ),
      timestamp = String(Math.floor(Date.now() / 1000)),
      signature = sign(
        null,
        Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]),
        privateKey,
      ).toString("hex"),
      headers = new Headers({
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      });
    const jobs: unknown[] = [],
      publisher = {
        enqueue: async (job: unknown) => {
          jobs.push(job);
        },
      };
    assert.deepEqual(await ingestDiscordRoutine(db, publisher, f.config.id, raw, headers), {
      type: 4,
      data: { content: "Routine queued.", flags: 64 },
    });
    assert.equal(jobs.length, 1);
    assert.equal(JSON.stringify(jobs).includes("fixture-never-retained-token"), false);
    assert.equal((jobs[0] as { payload: { triggerId: string } }).payload.triggerId, f.row.id);
    await checkpointNativeEventSource(db, scope, {
      triggerId: f.row.id,
      triggerVersion: f.row.version,
      leaseId: f.leaseId,
      state: { ready: true },
      nextPollAt: now(),
      release: true,
    });
    const oauth = {
      authorization: async () => {
        const connection = await db.connection.findUniqueOrThrow({
            where: { id: f.connection.id },
          }),
          config = await db.nativeAppConfig.findUniqueOrThrow({ where: { id: f.config.id } }),
          grant = await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: f.grant.id } });
        return {
          connection,
          config,
          grant,
          auth: {
            tokens: { accessToken: "fixture-discord-read-token", refreshToken: null },
            identity: {
              authority: "https://discord.com",
              subject: botId,
              tenant: guildId,
              displayName: "Fixture bot",
              context: grant.principal as Record<string, unknown>,
            },
            scopes: [],
            expiresAt: null,
          },
        };
      },
    };
    const requestPaths: string[] = [],
      network = {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          requestPaths.push(url.pathname);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bot fixture-discord-read-token",
          );
          let value: unknown;
          if (url.pathname.endsWith("/users/@me")) value = { id: botId, bot: true };
          else if (url.pathname.endsWith(`/channels/${channelId}`))
            value = { id: channelId, guild_id: guildId, type: 0, permission_overwrites: [] };
          else if (url.pathname.endsWith(`/members/${botId}`))
            value = { user: { id: botId }, roles: [] };
          else if (url.pathname.endsWith("/roles")) value = [{ id: guildId, permissions: "66560" }];
          else if (url.pathname.endsWith("/oauth2/applications/@me"))
            value = { id: appId, bot: { id: botId } };
          else if (url.pathname.endsWith(`/commands/${commandId}`))
            value = {
              id: commandId,
              application_id: appId,
              guild_id: guildId,
              name: "review",
              type: 1,
            };
          else throw new Error("Unexpected fixed source request");
          return new Response(JSON.stringify(value));
        },
      };
    const onCreated = vi.fn(async () => {}),
      queued = jobs[0];
    await processDiscordRoutine(
      db,
      oauth,
      publisher,
      (queued as { payload: unknown }).payload,
      new AbortController().signal,
      async () => (prompt) => prompt,
      onCreated,
      network,
    );
    await processDiscordRoutine(
      peer,
      oauth,
      publisher,
      (queued as { payload: unknown }).payload,
      new AbortController().signal,
      async () => (prompt) => prompt,
      onCreated,
      network,
    );
    assert.equal(onCreated.mock.calls.length, 1);
    assert.equal(requestPaths.length, 12);
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
    await db.routine.update({ where: { id: f.routine.id }, data: { active: false } });
    jobs.length = 0;
    assert.deepEqual(await ingestDiscordRoutine(peer, publisher, f.config.id, raw, headers), {
      type: 4,
      data: { content: "No Routine is enabled for this command here.", flags: 64 },
    });
    assert.equal(jobs.length, 0);
    await db.nativeOAuthGrant.update({ where: { id: f.grant.id }, data: { revokedAt: now() } });
    await assert.rejects(ingestDiscordRoutine(db, publisher, f.config.id, raw, headers), {
      kind: "authorization_required",
    });
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
  });
  it("all ten remaining event intents use the same real PostgreSQL exact-account fence and permanent receipt", async () => {
    const cases: Array<{
      spec: NativeRoutineEventSpec;
      evidence: NativeEventObservation["evidence"];
      metadata: Record<string, unknown>;
      fields?: Partial<NativeEventObservation>;
    }> = [
      {
        spec: { kind: "sharepoint.list_item.changed", siteId: "site", listId: "list" },
        evidence: "microsoft_read",
        metadata: { siteId: "site", listId: "list", itemId: "item" },
      },
      {
        spec: {
          kind: "excel.range.changed",
          driveId: "drive",
          itemId: "workbook",
          worksheetId: "sheet",
          address: "A1:B2",
        },
        evidence: "microsoft_read",
        metadata: { driveId: "drive", fileId: "workbook", worksheetId: "sheet", address: "A1:B2" },
      },
      {
        spec: { kind: "planner.task.changed", planId: "plan" },
        evidence: "microsoft_read",
        metadata: { planId: "plan", taskId: "task" },
      },
      {
        spec: { kind: "teams.channel_message.created", teamId: "team", channelId: "channel" },
        evidence: "microsoft_read",
        metadata: { teamId: "team", channelId: "channel", messageId: "message" },
      },
      {
        spec: { kind: "feishu.calendar_event.changed", calendarId: "calendar" },
        evidence: "enterprise_read",
        metadata: { calendarId: "calendar", eventId: "event" },
      },
      {
        spec: {
          kind: "dingtalk.calendar_event.changed",
          userId: "user",
          calendarId: "calendar",
          timeMin: "2026-10-18T00:00:00Z",
          timeMax: "2026-10-19T00:00:00Z",
        },
        evidence: "enterprise_read",
        metadata: { userId: "user", calendarId: "calendar", eventId: "event" },
      },
      {
        spec: { kind: "wecom.schedule.changed", calendarId: "calendar" },
        evidence: "enterprise_read",
        metadata: { calendarId: "calendar", scheduleId: "schedule" },
      },
      {
        spec: { kind: "telegram.pinned_message.changed", chatId: "-100123456" },
        evidence: "bot_read",
        metadata: { chatId: "-100123456", messageId: null },
      },
      {
        spec: { kind: "discord.channel_message.created", channelId: "423456789012345678" },
        evidence: "bot_read",
        metadata: { channelId: "423456789012345678", messageId: "message" },
        fields: { channelId: "423456789012345678", messageId: "message" },
      },
      {
        spec: {
          kind: "discord.command.invoked",
          guildId: "323456789012345678",
          channelId: "423456789012345678",
          commandId: "523456789012345678",
          commandName: "review",
        },
        evidence: "discord_interaction",
        metadata: { userId: "fixture-user", options: [] },
        fields: {
          interactionId: "723456789012345678",
          guildId: "323456789012345678",
          channelId: "423456789012345678",
          commandId: "523456789012345678",
          commandName: "review",
        },
      },
    ];
    for (const entry of cases) {
      const f = await fixture(entry.spec),
        event = {
          ...f.event,
          eventId: undefined,
          evidence: entry.evidence,
          sourceMetadata: entry.metadata,
          ...entry.fields,
        };
      assert.equal(
        await claimNativeRoutineEvent(
          db,
          scope,
          { ...event, resource: { ...event.resource, id: "other-resource" } },
          f.leaseId,
        ),
        undefined,
        entry.spec.kind,
      );
      const first = await claimNativeRoutineEvent(db, scope, event, f.leaseId),
        second = await claimNativeRoutineEvent(peer, scope, event, f.leaseId);
      assert.equal(first?.created, true, entry.spec.kind);
      assert.equal(second?.created, false, entry.spec.kind);
      assert.equal(first?.runId, second?.runId, entry.spec.kind);
      assert.deepEqual(
        await counts(f),
        { tasks: 1, runs: 1, messages: 1, events: 0 },
        entry.spec.kind,
      );
      const task = await db.task.findUniqueOrThrow({ where: { id: first!.taskId } });
      assert.deepEqual(task.connectionIds, [f.connection.id]);
      await db.nativeOAuthGrant.update({
        where: { id: f.grant.id },
        data: { authGeneration: { increment: 1 } },
      });
      assert.equal(
        await claimNativeRoutineEvent(db, scope, event, f.leaseId),
        undefined,
        entry.spec.kind,
      );
    }
  });
  it("actual PostgreSQL creates only the exact Routine Task+Run, pins account/model and never advances cron/chat", async () => {
    const f = await fixture(),
      before = await counts(f),
      result = await claimNativeRoutineEvent(db, scope, f.event, f.leaseId);
    assert.ok(result?.created);
    const task = await db.task.findUniqueOrThrow({ where: { id: result.taskId } }),
      run = await db.run.findUniqueOrThrow({ where: { id: result.runId } }),
      routine = await db.routine.findUniqueOrThrow({ where: { id: f.routine.id } });
    assert.equal(run.routineId, f.routine.id);
    assert.equal(run.userId, owner);
    assert.equal(run.spaceId, space);
    assert.equal(run.trigger, "routine");
    assert.equal(run.modelPinned, true);
    assert.equal(run.modelProvider, f.routine.modelProvider);
    assert.equal(run.modelId, f.routine.modelId);
    assert.equal(run.thinkingLevel, "high");
    assert.deepEqual(task.connectionIds, [f.connection.id]);
    assert.equal(task.threadId, f.thread.id);
    assert.ok(task.prompt.startsWith(`${f.routine.prompt}\n`));
    assert.equal(routine.nextRunAt?.getTime(), f.cron.getTime());
    assert.deepEqual(routine.crons, f.routine.crons);
    assert.equal(await db.run.count({ where: { routineId: f.untouched.id } }), 0);
    assert.deepEqual(await counts(f), { ...before, tasks: 1, runs: 1 });
    assert.equal(
      (await db.thread.findUniqueOrThrow({ where: { id: f.thread.id } })).nextMessageSeq,
      0,
    );
  });
  it("holds the Routine model through event commit before a competing connection rebind", async () => {
    const f = await fixture();
    const firstModel = await db.userModelCredential.create({
      data: {
        userId: owner,
        provider: f.routine.modelProvider!,
        label: "First synthetic model",
        secretId: f.secret.id,
      },
    });
    const secondModel = await db.userModelCredential.create({
      data: {
        userId: owner,
        provider: f.routine.modelProvider!,
        label: "Second synthetic model",
        secretId: f.secret.id,
      },
    });
    await db.routine.update({
      where: { id: f.routine.id },
      data: { modelCredentialId: firstModel.id },
    });
    let captured!: () => void;
    let release!: () => void;
    const modelRead = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instrumented = db.$extends({
      query: {
        routine: {
          async findFirst({ args, query }) {
            const routine = await query(args);
            if (args.where?.id === f.routine.id) {
              assert.equal(routine?.modelCredentialId, firstModel.id);
              captured();
              await resume;
            }
            return routine;
          },
        },
      },
    });
    const claiming = claimNativeRoutineEvent(
      instrumented as unknown as PrismaClient,
      scope,
      f.event,
      f.leaseId,
    );
    let result: Awaited<typeof claiming>;
    try {
      await Promise.race([
        modelRead,
        claiming.then(() => {
          throw new Error("Event claim finished before the model snapshot barrier");
        }),
      ]);
      const competing = await second.pool.connect();
      try {
        await competing.query("BEGIN");
        await assert.rejects(
          async () => {
            await competing.query(
              'SELECT id FROM routines WHERE id=$1 AND "userId"=$2 AND "spaceId"=$3 FOR UPDATE NOWAIT',
              [f.routine.id, owner, space],
            );
            await competing.query(
              'UPDATE routines SET "modelCredentialId"=$1, "modelId"=$2 WHERE id=$3',
              [secondModel.id, "replacement-model", f.routine.id],
            );
          },
          (error: unknown) =>
            Boolean(
              error && typeof error === "object" && "code" in error && error.code === "55P03",
            ),
        );
      } finally {
        await competing.query("ROLLBACK");
        competing.release();
      }
      assert.equal(
        (await db.routine.findUniqueOrThrow({ where: { id: f.routine.id } })).modelCredentialId,
        firstModel.id,
      );
    } finally {
      release();
      result = await claiming;
    }
    assert.ok(result?.created);
    const queued = await db.run.findUniqueOrThrow({ where: { id: result.runId } });
    assert.equal(queued.modelCredentialId, firstModel.id);
    assert.equal(queued.modelId, f.routine.modelId);
    await peer.routine.update({
      where: { id: f.routine.id },
      data: { modelCredentialId: secondModel.id, modelId: "replacement-model" },
    });
    const rebound = await db.routine.findUniqueOrThrow({ where: { id: f.routine.id } });
    assert.equal(rebound.modelCredentialId, secondModel.id);
    assert.deepEqual(
      await db.run.findMany({
        where: {
          userId: owner,
          modelCredentialId: firstModel.id,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true },
      }),
      [{ id: queued.id }],
    );
  });
  it("API Actor extras never enter ORM filters or Task/Run writes", async () => {
    const f = await fixture();
    const actor = { ...scope, email: "synthetic@example.test", isDeploymentOwner: true };
    const listed = await listNativeRoutineTriggers(db, actor, f.routine.id);
    assert.equal(listed[0]?.id, f.row.id);
    const claimed = await claimNativeRoutineEvent(peer, actor, f.event, f.leaseId);
    assert.ok(claimed?.created);
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
  });
  it("recovers an event Run after queue failure through the existing reconciler without duplicating its receipt", async () => {
    const f = await fixture(),
      oldState = { ready: true, syncToken: "synthetic-old-cursor" },
      attempts: BackgroundJob[] = [],
      queueError = new Error("Synthetic queue unavailable");
    const jobs: JobPublisher = {
      enqueue: async (job) => {
        attempts.push(job);
        if (attempts.length === 1) throw queueError;
      },
      cancel: async () => undefined,
      close: async () => undefined,
    };
    let reads = 0;
    const created: boolean[] = [];
    const readers: NativeEventReaders = {
      calendar: async ({ row, emit }) => {
        reads++;
        assert.equal((row.state as Record<string, unknown>).syncToken, oldState.syncToken);
        created.push(await emit(f.event));
        return {
          state: { ready: true, syncToken: "synthetic-next-cursor" },
          nextPollAt: new Date(Date.now() + 60_000),
        };
      },
      notion: async () => {
        throw new Error("A Calendar source must not use the Notion reader");
      },
    };
    assert.equal(
      await checkpointNativeEventSource(db, scope, {
        triggerId: f.row.id,
        triggerVersion: f.row.version,
        leaseId: f.leaseId,
        state: oldState,
        nextPollAt: now(),
        release: true,
      }),
      true,
    );
    const payload = { triggerId: f.row.id, triggerVersion: f.row.version },
      signal = new AbortController().signal,
      nonce = nativeEventRunNonce(f.row, f.event);
    await assert.rejects(handleNativeSourceJob(db, jobs, readers, payload, signal), queueError);
    const receipt = await db.run.findFirstOrThrow({
      where: { ...scope, routineId: f.routine.id, clientNonce: nonce },
    });
    assert.equal(receipt.status, "queued");
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: receipt.taskId } })).status,
      "queued",
    );
    assert.deepEqual(attempts, [runContinueJob(receipt.id)]);
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
    const failed = await db.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: f.row.id } });
    assert.equal(failed.leaseId, null);
    assert.ok(failed.nextPollAt && failed.nextPollAt > now());
    assert.deepEqual(failed.state, {
      ...oldState,
      retryAfterAt: failed.nextPollAt.toISOString(),
      lastErrorCode: "temporarily_unavailable",
    });
    // Use the original global queued-Run scan on a separate real DB client.
    await createJobReconciler({ prisma: peer, jobs }).reconcileOnce();
    const targetAttempts = () =>
      attempts.filter((job) => job.name === "run.continue" && job.payload.runId === receipt.id);
    assert.deepEqual(targetAttempts(), [runContinueJob(receipt.id), runContinueJob(receipt.id)]);
    assert.equal(
      (await peer.run.findUniqueOrThrow({ where: { id: receipt.id } })).status,
      "queued",
    );
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
    // Advance only Date beyond the persisted retry bound; PG I/O timers remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(failed.nextPollAt.getTime() + 1));
    try {
      assert.equal(await handleNativeSourceJob(peer, jobs, readers, payload, signal), "processed");
    } finally {
      vi.useRealTimers();
    }
    assert.equal(reads, 2);
    assert.deepEqual(
      created,
      [false],
      "Replay must read the permanent receipt, not skip the source",
    );
    assert.deepEqual(
      targetAttempts(),
      Array.from({ length: 3 }, () => runContinueJob(receipt.id)),
    );
    assert.equal(await db.run.count({ where: { ...scope, clientNonce: nonce } }), 1);
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
    const after = await db.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: f.row.id } });
    assert.deepEqual(after.state, { ready: true, syncToken: "synthetic-next-cursor" });
    assert.equal(after.leaseId, null);
    assert.equal(
      (await db.routine.findUniqueOrThrow({ where: { id: f.routine.id } })).nextRunAt?.getTime(),
      f.cron.getTime(),
    );
    assert.equal(await db.run.count({ where: { routineId: f.untouched.id } }), 0);
  });
  it("permanent receipt prevents another Task+Run even after the first Run completed", async () => {
    const f = await fixture(),
      a = await claimNativeRoutineEvent(db, scope, f.event, f.leaseId);
    assert.ok(a);
    await db.run.update({
      where: { id: a.runId },
      data: { status: "completed", completedAt: now() },
    });
    const b = await claimNativeRoutineEvent(peer, scope, f.event, f.leaseId);
    assert.ok(b);
    assert.equal(b.created, false);
    assert.equal(a.runId, b.runId);
    assert.equal(a.taskId, b.taskId);
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
  });
  it("eight competing real transactions/pools create one Task and one permanent Run receipt", async () => {
    const f = await fixture();
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimNativeRoutineEvent(i % 2 ? peer : db, scope, f.event, f.leaseId),
      ),
    );
    assert.equal(all.filter((r) => r?.created).length, 1);
    assert.equal(new Set(all.map((r) => r?.runId)).size, 1);
    assert.deepEqual(await counts(f), { tasks: 1, runs: 1, messages: 1, events: 0 });
  });
  for (const [name, actor] of Object.entries({
    wrongOwner: { userId: other, spaceId: space },
    wrongSpace: { userId: owner, spaceId: otherSpace },
  }))
    it(`exact scope denies ${name} before any Task`, async () => {
      const f = await fixture();
      assert.equal(await leaseNativeEventSource(peer, actor, f.row.id, f.row.version), undefined);
      assert.equal(await claimNativeRoutineEvent(peer, actor, f.event, f.leaseId), undefined);
      assert.equal((await counts(f)).tasks, 0);
    });
  for (const [name, override] of Object.entries({
    resource: { resource: { type: "calendar" as const, id: "sibling" } },
    connection: { connectionId: "sibling" },
    revision: { authorizationRevision: "old-generation" },
    binding: { triggerVersion: 999 },
    oldObservation: { occurredAt: "2000-01-01T00:00:00Z" },
  }))
    it(`observation fence denies ${name}`, async () => {
      const f = await fixture();
      assert.equal(
        await claimNativeRoutineEvent(db, scope, { ...f.event, ...override }, f.leaseId),
        undefined,
      );
      assert.equal((await counts(f)).tasks, 0);
    });
  for (const mutation of [
    "paused",
    "archived",
    "deleted",
    "configRevision",
    "configDisabled",
    "authGeneration",
    "revoked",
  ] as const)
    it(`actual source/routine state ${mutation} blocks the old event`, async () => {
      const f = await fixture();
      if (mutation === "paused")
        await db.routine.update({ where: { id: f.routine.id }, data: { active: false } });
      if (mutation === "archived")
        await db.bot.update({ where: { id: f.bot.id }, data: { archivedAt: now() } });
      if (mutation === "deleted") await db.routine.delete({ where: { id: f.routine.id } });
      if (mutation === "configRevision")
        await db.nativeAppConfig.update({
          where: { id: f.config.id },
          data: { revision: { increment: 1 } },
        });
      if (mutation === "configDisabled")
        await db.nativeAppConfig.update({ where: { id: f.config.id }, data: { enabled: false } });
      if (mutation === "authGeneration")
        await db.nativeOAuthGrant.update({
          where: { id: f.grant.id },
          data: { authGeneration: { increment: 1 } },
        });
      if (mutation === "revoked")
        await db.connection.update({ where: { id: f.connection.id }, data: { status: "revoked" } });
      assert.equal(await claimNativeRoutineEvent(peer, scope, f.event, f.leaseId), undefined);
      assert.equal((await counts(f)).tasks, 0);
    });
  it("membership removal after a valid lease blocks the claim with actual member rows", async () => {
    const f = await fixture();
    const member = await db.spaceMember.findUniqueOrThrow({ where: { spaceId_userId: scope } });
    await db.spaceMember.delete({ where: { id: member.id } });
    try {
      assert.equal(await claimNativeRoutineEvent(peer, scope, f.event, f.leaseId), undefined);
      assert.equal((await counts(f)).tasks, 0);
    } finally {
      await db.spaceMember.create({ data: member });
    }
  });
  it("ordinary token-version rotation leaves the pinned source authorization usable", async () => {
    const f = await fixture();
    await db.nativeOAuthGrant.update({
      where: { id: f.grant.id },
      data: { tokenVersion: { increment: 1 } },
    });
    assert.ok((await claimNativeRoutineEvent(peer, scope, f.event, f.leaseId))?.created);
  });
  it("replacing the account grant never revives an old binding or selects the new sibling connection", async () => {
    const f = await fixture();
    const next = await db.nativeOAuthGrant.create({
      data: {
        id: randomUUID(),
        ...scope,
        configId: f.config.id,
        configRevision: 1,
        authority: "https://accounts.example.test",
        subject: "synthetic-new-grant",
        secretId: f.secret.id,
      },
    });
    const sibling = await db.connection.create({
      data: {
        ...scope,
        connectorId: "native",
        provider: "google-calendar",
        providerRef: next.id,
        displayName: "New account",
        status: "connected",
        oauthGrantId: next.id,
        nativeConfigId: f.config.id,
        nativeConfigRevision: 1,
        metadata: { authRevision: `${next.id}:1` },
      },
    });
    await db.connection.update({ where: { id: f.connection.id }, data: { status: "revoked" } });
    assert.equal(await claimNativeRoutineEvent(peer, scope, f.event, f.leaseId), undefined);
    assert.equal((await counts(f)).tasks, 0);
    assert.equal(sibling.status, "connected");
  });
  it("even an injected new grant pointer on the old connected row cannot satisfy the old binding", async () => {
    const f = await fixture();
    const next = await db.nativeOAuthGrant.create({
      data: {
        id: randomUUID(),
        ...scope,
        configId: f.config.id,
        configRevision: 1,
        authority: "https://accounts.example.test",
        subject: "synthetic-new-grant",
        secretId: f.secret.id,
      },
    });
    await db.connection.update({ where: { id: f.connection.id }, data: { oauthGrantId: next.id } });
    assert.equal(await claimNativeRoutineEvent(peer, scope, f.event, f.leaseId), undefined);
    assert.equal((await counts(f)).tasks, 0);
  });
  it("an expired read lease can be taken over, while its old worker cannot checkpoint or fire", async () => {
    const f = await fixture();
    await db.$executeRaw`UPDATE native_routine_triggers SET "leaseUntil"=${new Date(Date.now() - 1000)} WHERE id=${f.row.id}`;
    const next = await leaseNativeEventSource(peer, scope, f.row.id, f.row.version);
    assert.ok(next?.leaseId);
    assert.notEqual(next.leaseId, f.leaseId);
    assert.equal(
      await checkpointNativeEventSource(db, scope, {
        triggerId: f.row.id,
        triggerVersion: f.row.version,
        leaseId: f.leaseId,
        state: { ready: true, stale: true },
        nextPollAt: now(),
        release: true,
      }),
      false,
    );
    assert.equal(await claimNativeRoutineEvent(db, scope, f.event, f.leaseId), undefined);
    assert.ok((await claimNativeRoutineEvent(peer, scope, f.event, next.leaseId))?.created);
  });
  it("two workers competing for a due read source obtain one lease", async () => {
    const f = await fixture();
    await checkpointNativeEventSource(db, scope, {
      triggerId: f.row.id,
      triggerVersion: f.row.version,
      leaseId: f.leaseId,
      state: { ready: true },
      nextPollAt: now(),
      release: true,
    });
    const all = await Promise.all([
      leaseNativeEventSource(db, scope, f.row.id, f.row.version),
      leaseNativeEventSource(peer, scope, f.row.id, f.row.version),
    ]);
    assert.equal(all.filter(Boolean).length, 1);
  });
  it("batch listing preserves owned empty Routines and denies real member/Space/Bot violations", async () => {
    const f = await fixture();
    const actor = { ...scope, email: "synthetic@example.test", isDeploymentOwner: true };
    const ids = [f.routine.id, f.untouched.id];
    const batch = await listNativeRoutineTriggersBatch(db, actor, ids);
    assert.equal(batch.get(f.routine.id)?.[0]?.id, f.row.id);
    assert.deepEqual(batch.get(f.untouched.id), []);
    await assert.rejects(
      listNativeRoutineTriggersBatch(peer, { userId: other, spaceId: space }, ids),
      /Routine not found/,
    );
    await assert.rejects(
      listNativeRoutineTriggersBatch(peer, { userId: owner, spaceId: otherSpace }, ids),
      /Routine not found/,
    );
    const member = await db.spaceMember.findUniqueOrThrow({ where: { spaceId_userId: scope } });
    await db.spaceMember.delete({ where: { id: member.id } });
    try {
      await assert.rejects(listNativeRoutineTriggersBatch(peer, actor, ids), /Routine not found/);
    } finally {
      await db.spaceMember.create({ data: member });
    }
    await db.bot.update({ where: { id: f.bot.id }, data: { archivedAt: now() } });
    await assert.rejects(listNativeRoutineTriggersBatch(peer, actor, ids), /Routine not found/);
  });
});
