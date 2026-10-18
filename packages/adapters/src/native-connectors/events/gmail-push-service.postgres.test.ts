import { randomUUID } from "node:crypto";
import type {
  NativeEventAuthorizationProof,
  NativeEventScope,
  NativeRoutineEventSpec,
} from "@rakazo/contracts";
import { nativeEventResource } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../../secrets.js";
import { NativeOAuthAuthorities } from "../authorities.js";
import { NativeConfigStore } from "../config.js";
import { NativeOAuthStore } from "../oauth.js";
import { NativeNotionHookStore } from "./notion-hooks.js";
import type { NativeEventJobPublisher } from "./service.js";
import { NativeRoutineEventService } from "./service.js";
import { InvalidNativeEventSignal } from "./signals.js";
import { saveNativeRoutineTrigger } from "./store.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const API_ORIGIN = "https://api.example.test";
const CALLBACK = `${API_ORIGIN}/api/connectors/events/gmail`;
const MAILBOX = "verified-mailbox@example.test";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"];
type PublishedJob = Parameters<NativeEventJobPublisher["enqueue"]>[0];

describePostgres("Gmail push verifier to exact Routine compensation queue (PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `gmail-push-org-${suffix}`;
  const userIds = [`gmail-push-owner-${suffix}`, `gmail-push-peer-${suffix}`];
  const spaces = [`gmail-push-space-${suffix}`, `gmail-push-other-${suffix}`];
  const scope: NativeEventScope = { userId: userIds[0]!, spaceId: spaces[0]! };
  const configIds = new Set<string>();
  const services: NativeRoutineEventService[] = [];
  const authorities: NativeOAuthAuthorities[] = [];
  let db: ReturnType<typeof createDb>;
  let key: Awaited<ReturnType<typeof generateKeyPair>>;
  let foreignKey: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: JSONWebKeySet;
  beforeAll(async () => {
    key = await generateKeyPair("RS256", { modulusLength: 2048 });
    foreignKey = await generateKeyPair("RS256", { modulusLength: 2048 });
    jwks = {
      keys: [
        {
          ...(await exportJWK(key.publicKey)),
          kid: "synthetic-google-key",
          alg: "RS256",
          use: "sig",
        },
      ],
    };
    db = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "gmail-push-service-proof",
    });
    const version = await db.prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    expect(version[0]?.version).toContain("PostgreSQL");
    await db.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic Gmail push organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const [index, userId] of userIds.entries()) {
      await db.prisma.user.create({
        data: { id: userId, name: "Synthetic Gmail push user", email: `${userId}@example.test` },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId,
          role: index === 0 ? "owner" : "member",
          createdAt: new Date(),
        },
      });
    }
    for (const spaceId of spaces) {
      await db.prisma.space.create({
        data: { id: spaceId, organizationId, name: "Synthetic Gmail push Space" },
      });
      for (const userId of userIds)
        await db.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId,
            spaceId,
            userId,
            role: "member",
            createdAt: new Date(),
          },
        });
    }
  }, 20_000);
  afterAll(async () => {
    await Promise.all([
      ...services.map((service) => service.close()),
      ...authorities.map((authority) => authority.close()),
    ]);
    if (db) {
      try {
        await db.prisma.organization.deleteMany({ where: { id: organizationId } });
        await db.prisma.nativeAppConfig.deleteMany({ where: { id: { in: [...configIds] } } });
        await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });

  async function fixture() {
    const projectId = `proof-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const watch = {
      projectId,
      topicName: `projects/${projectId}/topics/mailbox-topic`,
      subscriptionName: `projects/${projectId}/subscriptions/mailbox-push`,
      callbackAudience: CALLBACK,
      pushServiceAccountEmail: `push@${projectId}.iam.gserviceaccount.com`,
    };
    const config = await db.prisma.nativeAppConfig.create({
      data: {
        appId: "gmail",
        label: "Synthetic Gmail push",
        ownership: "byo",
        credentialKind: "oauth",
        callbackUri: `${API_ORIGIN}/api/connectors/oauth/callback`,
        config: {
          clientId: "synthetic-client",
          scopes: SCOPES,
          capabilities: [],
          knowledgeBaseIds: [],
          googleWatch: watch,
        },
      },
    });
    configIds.add(config.id);
    const secret = await db.prisma.secret.create({
      data: { ...scope, kind: "native_grant", ciphertext: "synthetic-push-proof-not-a-real-token" },
    });
    const grant = await db.prisma.nativeOAuthGrant.create({
      data: {
        id: randomUUID(),
        ...scope,
        configId: config.id,
        configRevision: config.revision,
        authority: "https://accounts.google.com",
        subject: `synthetic-google-sub-${randomUUID()}`,
        principal: { email: MAILBOX },
        scopes: SCOPES,
        secretId: secret.id,
      },
    });
    const authorizationRevision = `${grant.id}:${grant.authGeneration}`;
    const connection = await db.prisma.connection.create({
      data: {
        ...scope,
        connectorId: "native",
        provider: "gmail",
        displayName: MAILBOX,
        status: "connected",
        oauthGrantId: grant.id,
        nativeConfigId: config.id,
        nativeConfigRevision: config.revision,
        providerRef: grant.id,
        metadata: { authRevision: authorizationRevision },
      },
    });
    const bot = await db.prisma.bot.create({
      data: { ...scope, name: "Synthetic Gmail compensation Bot", color: "ink" },
    });
    const routine = await db.prisma.routine.create({
      data: {
        ...scope,
        botId: bot.id,
        name: "Synthetic Gmail Routine",
        prompt: "Read the explicitly authorized mailbox",
        crons: ["0 9 * * *"],
        active: true,
      },
    });
    const spec: NativeRoutineEventSpec = { kind: "gmail.message_received", labelIds: ["INBOX"] };
    const proof: NativeEventAuthorizationProof = {
      ...scope,
      appId: "gmail",
      connectionId: connection.id,
      authorizationRevision,
      grantId: grant.id,
      authGeneration: grant.authGeneration,
      configId: config.id,
      configRevision: config.revision,
      resource: nativeEventResource(spec),
      spec,
    };
    const trigger = await saveNativeRoutineTrigger(
      db.prisma,
      scope,
      routine.id,
      { input: { connectionId: connection.id, spec }, proof },
      new Date(Date.now() - 60_000),
    );
    const state = {
      ready: true,
      gmailChanged: { historyId: "100", seen: [] },
      unrelated: "retain-exactly",
    };
    await db.prisma.nativeRoutineTrigger.update({
      where: { id: trigger.id },
      data: { state, nextPollAt: new Date(Date.now() + 3_600_000) },
    });
    async function anotherRoutine(active = true) {
      const next = await db.prisma.routine.create({
        data: {
          ...scope,
          botId: bot.id,
          name: "Another explicitly enabled Gmail Routine",
          prompt: "Read the same authorized mailbox",
          crons: [],
          active,
        },
      });
      const nextTrigger = await saveNativeRoutineTrigger(
        db.prisma,
        scope,
        next.id,
        { input: { connectionId: connection.id, spec }, proof },
        new Date(Date.now() - 60_000),
      );
      await db.prisma.nativeRoutineTrigger.update({
        where: { id: nextTrigger.id },
        data: { state },
      });
      return nextTrigger;
    }
    const control = { failNext: false, failAt: 0, jwksUnavailable: false };
    const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      expect(String(target)).toBe("https://www.googleapis.com/oauth2/v3/certs");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      if (control.jwksUnavailable) return new Response("Synthetic JWKS outage", { status: 503 });
      return Response.json(jwks, { headers: { "cache-control": "public, max-age=3600" } });
    });
    const network = {
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    };
    const vault = new EncryptedSecretStore("synthetic-gmail-push-service-key");
    const authority = new NativeOAuthAuthorities(network);
    authorities.push(authority);
    const oauth = new NativeOAuthStore(
      db.prisma,
      vault,
      new NativeConfigStore(db.prisma, vault, API_ORIGIN),
      authority,
    );
    const jobs: PublishedJob[] = [];
    let enqueueAttempts = 0;
    const enqueue = vi.fn(async (job: PublishedJob) => {
      enqueueAttempts++;
      if (control.failNext || control.failAt === enqueueAttempts) {
        control.failNext = false;
        throw new Error("Synthetic durable queue unavailable");
      }
      jobs.push(job);
    });
    const append = vi.fn(async () => {
      throw new Error("A push hint must not emit chat or Routine events");
    });
    const service = new NativeRoutineEventService(
      db.prisma,
      oauth,
      new NativeNotionHookStore(db.prisma, vault, API_ORIGIN),
      { enqueue },
      { append },
      API_ORIGIN,
      network,
    );
    services.push(service);
    async function jwt(patch: Record<string, unknown> = {}, signer = key.privateKey) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        iss: "https://accounts.google.com",
        sub: "synthetic-google-push-service-account",
        aud: watch.callbackAudience,
        email: watch.pushServiceAccountEmail,
        email_verified: true,
        iat: now,
        exp: now + 3600,
        ...patch,
      } as JWTPayload)
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "synthetic-google-key" })
        .sign(signer);
    }
    const raw = (emailAddress = MAILBOX, subscription = watch.subscriptionName) =>
      new TextEncoder().encode(
        JSON.stringify({
          subscription,
          message: {
            messageId: "synthetic-message-123",
            publishTime: new Date().toISOString(),
            data: Buffer.from(
              JSON.stringify({ emailAddress, historyId: "999999999999999999" }),
            ).toString("base64"),
          },
        }),
      );
    const ingest = async (emailAddress = MAILBOX) =>
      service.ingestGmail(raw(emailAddress), `Bearer ${await jwt()}`);
    const unchanged = async () => {
      expect(
        (await db.prisma.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: trigger.id } }))
          .state,
      ).toEqual(state);
      expect(await db.prisma.task.count({ where: { botId: bot.id } })).toBe(0);
      expect(await db.prisma.run.count({ where: { botId: bot.id } })).toBe(0);
      expect(await db.prisma.thread.count({ where: { botId: bot.id } })).toBe(0);
      expect(append).not.toHaveBeenCalled();
    };
    return {
      watch,
      config,
      secret,
      grant,
      connection,
      bot,
      routine,
      trigger,
      state,
      service,
      jobs,
      control,
      enqueue,
      append,
      fetch,
      jwt,
      raw,
      ingest,
      unchanged,
      anotherRoutine,
    };
  }

  it("verifies real RSA/JWKS and enqueues only an exact current Routine read without trusting notification historyId", async () => {
    const f = await fixture();
    expect(await f.ingest()).toBe(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0]).toMatchObject({
      name: "native.source.poll",
      payload: { triggerId: f.trigger.id, triggerVersion: f.trigger.version },
      replaceKey: `native-source:${f.trigger.id}:${f.trigger.version}`,
    });
    const serialized = JSON.stringify(f.jobs);
    for (const forbidden of ["999999999999999999", MAILBOX, "Bearer", "run.continue", "chat"])
      expect(serialized).not.toContain(forbidden);
    await f.unchanged();
  });
  it("does not fan out one config's subscription to a different config with the same verified mailbox", async () => {
    const a = await fixture(),
      b = await fixture();
    expect(await a.ingest()).toBe(1);
    expect(a.jobs.map((job) => job.payload)).toEqual([
      { triggerId: a.trigger.id, triggerVersion: a.trigger.version },
    ]);
    expect(
      a.jobs.some((job) => "triggerId" in job.payload && job.payload.triggerId === b.trigger.id),
    ).toBe(false);
    expect(b.jobs).toHaveLength(0);
    await a.unchanged();
    await b.unchanged();
  });
  it("wakes each enabled Routine on the exact account while preserving an independently disabled Routine", async () => {
    const f = await fixture();
    const enabled = await f.anotherRoutine();
    const disabled = await f.anotherRoutine(false);
    expect(await f.ingest()).toBe(2);
    expect(f.jobs.map((job) => job.payload)).toEqual(
      expect.arrayContaining([
        { triggerId: f.trigger.id, triggerVersion: f.trigger.version },
        { triggerId: enabled.id, triggerVersion: enabled.version },
      ]),
    );
    expect(
      f.jobs.some((job) => "triggerId" in job.payload && job.payload.triggerId === disabled.id),
    ).toBe(false);
    await f.unchanged();
  });
  it("does not enqueue a Routine after its owner leaves the Space", async () => {
    const f = await fixture();
    const membership = await db.prisma.spaceMember.findFirstOrThrow({ where: scope });
    await db.prisma.spaceMember.delete({ where: { id: membership.id } });
    try {
      expect(await f.ingest()).toBe(0);
      expect(f.jobs).toHaveLength(0);
      await f.unchanged();
    } finally {
      await db.prisma.spaceMember.create({ data: membership });
    }
  });
  it.each(["audience", "service_account", "unverified_email", "issuer", "signature"] as const)(
    "rejects a wrong %s before enqueueing any job",
    async (change) => {
      const f = await fixture();
      const patch: Record<string, unknown> = {};
      if (change === "audience")
        patch.aud = "https://other.example.test/api/connectors/events/gmail";
      if (change === "service_account") patch.email = "other@proof-project.iam.gserviceaccount.com";
      if (change === "unverified_email") patch.email_verified = false;
      if (change === "issuer") patch.iss = "https://accounts.google.com.evil.test";
      const token = await f.jwt(
        patch,
        change === "signature" ? foreignKey.privateKey : key.privateKey,
      );
      await expect(f.service.ingestGmail(f.raw(), `Bearer ${token}`)).rejects.toBeInstanceOf(
        InvalidNativeEventSignal,
      );
      expect(f.jobs).toHaveLength(0);
      await f.unchanged();
    },
  );
  it("ignores unknown subscriptions without reading or queueing any account", async () => {
    const f = await fixture();
    expect(
      await f.service.ingestGmail(
        f.raw(MAILBOX, "projects/unknown-proof/subscriptions/unknown"),
        `Bearer ${await f.jwt()}`,
      ),
    ).toBe(0);
    expect(f.jobs).toHaveLength(0);
    expect(f.fetch).not.toHaveBeenCalled();
    await f.unchanged();
  });
  it("authenticates the subscription but does not enqueue another mailbox", async () => {
    const f = await fixture();
    expect(await f.ingest("other-mailbox@example.test")).toBe(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.jobs).toHaveLength(0);
    await f.unchanged();
  });
  it.each([
    "routine_disabled",
    "bot_archived",
    "bot_owner",
    "connection_disconnected",
    "connection_owner",
    "connection_space",
    "connection_revision",
    "grant_generation",
    "grant_revoked",
    "grant_missing_secret",
    "grant_owner",
    "config_revision",
    "config_disabled",
    "trigger_revision",
  ] as const)("refuses stale or unauthorized %s using actual database joins", async (change) => {
    const f = await fixture();
    if (change === "routine_disabled")
      await db.prisma.routine.update({ where: { id: f.routine.id }, data: { active: false } });
    if (change === "bot_archived")
      await db.prisma.bot.update({ where: { id: f.bot.id }, data: { archivedAt: new Date() } });
    if (change === "bot_owner")
      await db.prisma.bot.update({ where: { id: f.bot.id }, data: { userId: userIds[1]! } });
    if (change === "connection_disconnected")
      await db.prisma.connection.update({
        where: { id: f.connection.id },
        data: { status: "revoked" },
      });
    if (change === "connection_owner")
      await db.prisma.connection.update({
        where: { id: f.connection.id },
        data: { userId: userIds[1]! },
      });
    if (change === "connection_space")
      await db.prisma.connection.update({
        where: { id: f.connection.id },
        data: { spaceId: spaces[1]! },
      });
    if (change === "connection_revision")
      await db.prisma.connection.update({
        where: { id: f.connection.id },
        data: { metadata: { authRevision: "stale-revision" } },
      });
    if (change === "grant_generation")
      await db.prisma.nativeOAuthGrant.update({
        where: { id: f.grant.id },
        data: { authGeneration: { increment: 1 } },
      });
    if (change === "grant_revoked")
      await db.prisma.nativeOAuthGrant.update({
        where: { id: f.grant.id },
        data: { revokedAt: new Date() },
      });
    if (change === "grant_missing_secret")
      await db.prisma.nativeOAuthGrant.update({
        where: { id: f.grant.id },
        data: { secretId: null },
      });
    if (change === "grant_owner")
      await db.prisma.nativeOAuthGrant.update({
        where: { id: f.grant.id },
        data: { userId: userIds[1]! },
      });
    if (change === "config_revision")
      await db.prisma.nativeAppConfig.update({
        where: { id: f.config.id },
        data: { revision: { increment: 1 } },
      });
    if (change === "config_disabled")
      await db.prisma.nativeAppConfig.update({
        where: { id: f.config.id },
        data: { enabled: false },
      });
    if (change === "trigger_revision")
      await db.prisma.nativeRoutineTrigger.update({
        where: { id: f.trigger.id },
        data: { configRevision: { increment: 1 } },
      });
    expect(await f.ingest()).toBe(0);
    expect(f.jobs).toHaveLength(0);
    await f.unchanged();
  });
  it("propagates a durable-queue outage for HTTP 503 and a retry safely queues the same compensation key", async () => {
    const f = await fixture();
    const bytes = f.raw();
    const authorization = `Bearer ${await f.jwt()}`;
    f.control.failNext = true;
    await expect(f.service.ingestGmail(bytes, authorization)).rejects.toThrow(
      "Synthetic durable queue unavailable",
    );
    expect(f.jobs).toHaveLength(0);
    await f.unchanged();
    expect(await f.service.ingestGmail(bytes, authorization)).toBe(1);
    expect(f.jobs).toHaveLength(1);
    expect(f.enqueue.mock.calls[0]![0].replaceKey).toBe(f.enqueue.mock.calls[1]![0].replaceKey);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await f.unchanged();
  });
  it("retries a partially queued fanout using the same per-trigger replacement keys", async () => {
    const f = await fixture();
    const other = await f.anotherRoutine();
    const bytes = f.raw();
    const authorization = `Bearer ${await f.jwt()}`;
    f.control.failAt = 2;
    await expect(f.service.ingestGmail(bytes, authorization)).rejects.toThrow(
      "Synthetic durable queue unavailable",
    );
    expect(f.jobs).toHaveLength(1);
    expect(await f.service.ingestGmail(bytes, authorization)).toBe(2);
    expect(f.jobs).toHaveLength(3);
    expect(new Set(f.jobs.map((job) => job.replaceKey))).toEqual(
      new Set([
        `native-source:${f.trigger.id}:${f.trigger.version}`,
        `native-source:${other.id}:${other.version}`,
      ]),
    );
    await f.unchanged();
    expect(
      (await db.prisma.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: other.id } })).state,
    ).toEqual(f.state);
  });
  it("propagates JWKS unavailability for retry and verifies the redelivery after recovery", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const f = await fixture();
      const bytes = f.raw();
      const authorization = `Bearer ${await f.jwt()}`;
      f.control.jwksUnavailable = true;
      await expect(f.service.ingestGmail(bytes, authorization)).rejects.toMatchObject({
        kind: "temporarily_unavailable",
      });
      expect(f.jobs).toHaveLength(0);
      await f.unchanged();
      f.control.jwksUnavailable = false;
      // The verifier deliberately limits repeated key-server failures to one request per 30 seconds.
      await expect(f.service.ingestGmail(bytes, authorization)).rejects.toMatchObject({
        kind: "temporarily_unavailable",
      });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      now += 31_000;
      expect(await f.service.ingestGmail(bytes, authorization)).toBe(1);
      expect(f.jobs).toHaveLength(1);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      await f.unchanged();
    } finally {
      clock.mockRestore();
    }
  });
});
