import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, ModelOAuthSessions, PiOAuthLogins } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelOAuth } from "./model-oauth.js";
import { createRouter, type RouterDeps } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);
const key = "offline-model-oauth-recovery-only";
const token = {
  type: "oauth" as const,
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: Date.now() + 3_600_000,
};

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

describe.skipIf(!enabled)("durable model subscription sign-in (PostgreSQL)", () => {
  let a: ReturnType<typeof createDb>;
  let b: ReturnType<typeof createDb>;
  const lifetimes: ModelOAuth[] = [];
  const actors: { userId: string; organizationId: string }[] = [];

  beforeAll(() => {
    a = createDb(databaseUrl!, { applicationName: "model-sign-in-a" });
    b = createDb(databaseUrl!, { applicationName: "model-sign-in-b" });
  });

  afterEach(async () => {
    for (const instance of lifetimes.splice(0)) await instance.stop();
  });

  afterAll(async () => {
    try {
      for (const { userId, organizationId } of actors) {
        await a.prisma.organization.delete({ where: { id: organizationId } });
        await a.prisma.user.delete({ where: { id: userId } });
      }
    } finally {
      for (const db of [a, b]) {
        await db?.prisma.$disconnect();
        await db?.pool.end();
      }
    }
  });

  async function member(): Promise<Actor> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const spaceId = randomUUID();
    const email = `${userId}@example.test`;
    await a.prisma.user.create({ data: { id: userId, name: "Sign-in fixture", email } });
    await a.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Sign-in fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await a.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Space", isDefault: true },
    });
    await a.prisma.member.create({
      data: { id: randomUUID(), userId, organizationId, role: "owner", createdAt: new Date() },
    });
    actors.push({ userId, organizationId });
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  function process(
    db: ReturnType<typeof createDb>,
    actor: Actor,
    exchange = vi.fn(async () => token),
    secrets = new EncryptedSecretStore(key),
  ) {
    const providerResult = gate<typeof token>();
    const providerStarted = vi.fn();
    const login = new PiOAuthLogins(async (_provider, _type, interaction) => {
      providerStarted();
      interaction.notify({
        type: "device_code",
        userCode: "TEST-CODE",
        verificationUri: "https://sign-in.example.test/device",
        expiresInSeconds: 300,
      });
      return providerResult.promise;
    });
    const oauth = new ModelOAuth(new ModelOAuthSessions(db.prisma), secrets, login, exchange);
    lifetimes.push(oauth);
    const deps = {
      prisma: db.prisma,
      oauthLogins: oauth,
      secrets,
      env: {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        webOrigin: "http://localhost:5180",
      },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), {
      context: { actor, signal: new AbortController().signal },
    });
    return { oauth, client, providerResult, providerStarted, exchange };
  }

  async function expectLateProviderSave(first: ReturnType<typeof process>) {
    const witness = vi.spyOn(first.oauth.sessions, "markSaving");
    try {
      first.providerResult.resolve(token);
      await vi.waitFor(() => expect(witness).toHaveBeenCalledOnce());
      await expect(witness.mock.results[0]!.value).resolves.toBe(false);
    } finally {
      witness.mockRestore();
    }
  }

  it("bounds shutdown when the session table blocks cleanup and pending login retirement", async () => {
    const actor = await member();
    const first = process(a, actor);
    const { loginId } = await first.client.models.beginOAuth({ provider: "github-copilot" });
    const blocker = await b.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE cogine_model_auth.model_oauth_sessions IN ACCESS EXCLUSIVE MODE",
      );
      const sweep = vi.spyOn(first.oauth.sessions, "clearExpired");
      const retire = vi.spyOn(first.oauth.sessions, "fail");
      first.oauth.startCleanup();
      const shutdown = first.oauth.stop();
      try {
        let stopped = false;
        void shutdown.then(() => {
          stopped = true;
        });
        await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 5_000 });
        expect(sweep).toHaveBeenCalledOnce();
        expect(retire).toHaveBeenCalledOnce();
        await expect(sweep.mock.results[0]!.value).rejects.toThrow(/statement timeout/);
        await expect(retire.mock.results[0]!.value).rejects.toThrow(/statement timeout/);
      } finally {
        await blocker.query("ROLLBACK");
        await shutdown;
      }
    } finally {
      blocker.release(true);
    }
    expect(await first.oauth.sessions.read({ ...actor, id: loginId })).toMatchObject({
      status: "pending",
    });
    await a.prisma.modelOAuthSession.update({
      where: { id: loginId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(first.oauth.complete(loginId, actor)).resolves.toMatchObject({
      status: "error",
      error: expect.stringMatching(/interrupted/i),
    });
  }, 10_000);

  it("times out a lease renewal blocked by a concurrent session write", async () => {
    const actor = await member();
    const first = process(a, actor);
    const { loginId } = await first.client.models.beginOAuth({ provider: "github-copilot" });
    const original = await first.oauth.sessions.read({ ...actor, id: loginId });
    const blocker = await b.pool.connect();
    let renewal: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM cogine_model_auth.model_oauth_sessions WHERE id = $1 FOR UPDATE",
        [loginId],
      );
      renewal = first.oauth.sessions.renew({
        ...actor,
        id: loginId,
        leaseOwner: original!.leaseOwner!,
      });
      let settled = false;
      void renewal.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
      await expect(renewal).rejects.toThrow(/statement timeout/);
    } finally {
      blocker.release(true);
      await renewal?.catch(() => undefined);
    }
    expect(await first.oauth.sessions.read({ ...actor, id: loginId })).toMatchObject({
      leaseExpiresAt: original!.leaseExpiresAt,
    });
  }, 10_000);

  it.each(["renew", "markSaving"] as const)(
    "does not %s a lease that expires while waiting for its row",
    async (operation) => {
      const actor = await member();
      const first = process(a, actor);
      const second = process(b, actor);
      const { loginId } = await first.client.models.beginOAuth({ provider: "github-copilot" });
      const original = await first.oauth.sessions.read({ ...actor, id: loginId });
      const expiresAt = new Date(Date.now() + 900);
      await a.prisma.modelOAuthSession.update({
        where: { id: loginId },
        data: { leaseExpiresAt: expiresAt },
      });
      const blocker = await b.pool.connect();
      let renewal: Promise<boolean> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM cogine_model_auth.model_oauth_sessions WHERE id = $1 FOR UPDATE",
          [loginId],
        );
        renewal = first.oauth.sessions[operation]({
          ...actor,
          id: loginId,
          leaseOwner: original!.leaseOwner!,
          provider: "github-copilot",
        });
        void renewal.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const waiting = await b.pool.query<{ blocked: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'model-sign-in-a' AND wait_event_type = 'Lock'
              AND cardinality(pg_blocking_pids(pid)) > 0
          ) AS blocked
        `);
            expect(waiting.rows[0]?.blocked).toBe(true);
            expect(Date.now()).toBeLessThan(expiresAt.getTime());
          },
          { timeout: 650 },
        );
        await vi.waitFor(
          async () =>
            expect(await second.client.models.completeOAuth({ loginId })).toMatchObject({
              status: "error",
              error: expect.stringMatching(/interrupted/i),
            }),
          { timeout: 1_200 },
        );
      } finally {
        blocker.release(true);
        await renewal?.catch(() => undefined);
      }
      await expect(renewal).resolves.toBe(false);
      expect(await first.oauth.sessions.read({ ...actor, id: loginId })).toMatchObject({
        leaseExpiresAt: expiresAt,
      });
    },
  );

  it.each([
    ["assertPending", "pending", "leaseExpiresAt"],
    ["assertSaving", "saving", "expiresAt"],
  ] as const)("checks %s after acquiring the row lock", async (method, status, deadlineField) => {
    const actor = await member();
    const sessions = new ModelOAuthSessions(a.prisma);
    const ref = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      id: randomUUID(),
      leaseOwner: randomUUID(),
    };
    await sessions.register({
      ...ref,
      provider: "github-copilot",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await a.prisma.modelOAuthSession.update({ where: { id: ref.id }, data: { status } });
    await runAsTenant(ref, () => a.prisma.$transaction((tx) => sessions[method](tx, ref)));
    const deadline = new Date(Date.now() + 1_200);
    await a.prisma.modelOAuthSession.update({
      where: { id: ref.id },
      data: { [deadlineField]: deadline },
    });
    const blocker = await b.pool.connect();
    let guarded: Promise<void> | undefined;
    const write = vi.fn();
    try {
      await blocker.query("BEGIN");
      const {
        rows: [row],
      } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query(
        "SELECT id FROM cogine_model_auth.model_oauth_sessions WHERE id = $1 FOR UPDATE",
        [ref.id],
      );
      guarded = runAsTenant(ref, () =>
        a.prisma.$transaction(async (tx) => {
          await sessions[method](tx, ref);
          write();
        }),
      );
      void guarded.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const { rows } = await b.pool.query<{ beforeDeadline: boolean; blocked: boolean }>(
            `SELECT clock_timestamp() < $1::timestamptz AS "beforeDeadline",
                  EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'model-sign-in-a'
                    AND $2 = ANY(pg_blocking_pids(pid))) AS blocked`,
            [deadline, row!.pid],
          );
          expect(rows[0]).toEqual({ beforeDeadline: true, blocked: true });
        },
        { timeout: 900 },
      );
      await vi.waitFor(
        async () => {
          const { rows } = await b.pool.query<{ expired: boolean }>(
            "SELECT clock_timestamp() >= $1::timestamptz AS expired",
            [deadline],
          );
          expect(rows[0]?.expired).toBe(true);
        },
        { timeout: 1_500 },
      );
      await blocker.query("COMMIT");
    } finally {
      blocker.release(true);
      await guarded?.catch(() => undefined);
    }
    await expect(guarded).rejects.toThrow(/interrupted/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("redeems a handed-off code once and persists without a finish request", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({
      provider: "anthropic",
      label: "Manual",
    });
    const id = started.loginId;
    if (started.mode !== "auth-url") throw new Error("Expected manual authorization");
    const verifier = new URL(started.verificationUri).searchParams.get("state");
    expect(verifier).toBeTruthy();
    const stored = await first.oauth.sessions.read({ ...actor, id });
    expect(stored?.handoffCiphertext).toBeTruthy();
    expect(stored?.handoffCiphertext).not.toContain(verifier);
    expect(first.providerStarted).not.toHaveBeenCalled();
    const stranger = process(b, await member());
    await expect(
      stranger.client.models.submitOAuthCode({ loginId: id, code: "fixture-code" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      first.client.models.submitOAuthCode({ loginId: id, code: "fixture-code#wrong-state" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const code = `fixture-code#${verifier}`;
    await Promise.all([
      second.client.models.submitOAuthCode({ loginId: id, code }),
      first.client.models.submitOAuthCode({ loginId: id, code }),
    ]);
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId: id })).toEqual({
        status: "ready",
      }),
    );
    const existing = await a.prisma.userModelCredential.findMany({
      where: { userId: actor.userId },
    });
    expect(existing).toHaveLength(1);
    expect(existing[0]).toMatchObject({ label: "Manual", connectionRevision: 1 });
    expect(first.exchange.mock.calls.length + second.exchange.mock.calls.length).toBe(1);
    const ready = await first.oauth.sessions.read({ ...actor, id });
    expect(ready).toMatchObject({ status: "connected", handoffCiphertext: null, leaseOwner: null });
    expect(JSON.stringify(ready?.result)).not.toContain(token.access);
    const result = await second.client.models.finishOAuth({ loginId: id });
    expect(result).toMatchObject({ id: existing[0]!.id, label: "Manual", authKind: "oauth" });
    await expect(first.client.models.finishOAuth({ loginId: id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("makes a device login result visible across processes without transferring the exchange", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({ provider: "github-copilot" });
    await expect(second.client.models.completeOAuth({ loginId: started.loginId })).resolves.toEqual(
      { status: "pending" },
    );
    first.providerResult.resolve(token);
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId: started.loginId })).toEqual({
        status: "ready",
      }),
    );
    expect(second.providerStarted).not.toHaveBeenCalled();
    await expect(
      second.client.models.finishOAuth({ loginId: started.loginId }),
    ).resolves.toMatchObject({ provider: "github-copilot", authKind: "oauth" });
  });

  it("keeps a desktop callback on the original process and shares the committed result", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const callback = "http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture";
    const credential = {
      id: randomUUID(),
      provider: "chatgpt-plan",
      label: "Desktop fixture",
      hasKey: true,
      isDefault: false,
    };
    const exchanged = vi.fn();
    const save = gate<void>();
    const persist = vi.fn<Parameters<ModelOAuth["begin"]>[1]>(async (_result, lease) => {
      await save.promise;
      await a.prisma.$transaction(async (tx) => {
        await first.oauth.sessions.assertSaving(tx, lease);
        await first.oauth.sessions.recordConnected(tx, lease, credential);
      });
      return credential;
    });
    const started = await first.oauth.begin(
      {
        ...actor,
        provider: "chatgpt-plan",
        login: async (interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://sign-in.example.test/authorize?state=fixture",
          });
          exchanged(
            await interaction.prompt({
              type: "manual_code",
              message: "Callback",
            }),
          );
          return token;
        },
      },
      persist,
    );
    const { loginId } = started;
    try {
      await expect(
        second.client.models.submitOAuthCode({ loginId, code: callback }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Finish sign-in on the local installation where it started.",
      });
      await expect(
        second.client.models.submitOAuthCode({
          loginId: randomUUID(),
          code: callback,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(second.client.models.completeOAuth({ loginId })).resolves.toEqual({
        status: "pending",
      });
      expect(exchanged).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(
        (await first.oauth.sessions.read({ ...actor, id: loginId }))?.handoffCiphertext,
      ).toBeNull();

      await expect(
        first.client.models.submitOAuthCode({ loginId, code: callback }),
      ).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      await expect(
        second.client.models.submitOAuthCode({ loginId, code: callback }),
      ).resolves.toEqual({ ok: true });
    } finally {
      save.resolve(undefined);
    }
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId })).toEqual({
        status: "ready",
      }),
    );
    await expect(
      second.client.models.submitOAuthCode({ loginId, code: callback }),
    ).resolves.toEqual({ ok: true });
    await expect(second.client.models.finishOAuth({ loginId })).resolves.toMatchObject(credential);
    expect(exchanged).toHaveBeenCalledExactlyOnceWith(callback);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("does not save a pending first login after another process disconnects", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({ provider: "github-copilot" });
    await expect(second.client.models.disconnect({ provider: "github-copilot" })).resolves.toEqual({
      ok: true,
    });
    await expectLateProviderSave(first);
    await expect(
      second.client.models.completeOAuth({ loginId: started.loginId }),
    ).resolves.toMatchObject({ status: "error", error: expect.stringMatching(/interrupted/i) });
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("continues an unclaimed manual code after shutdown but never after expiry", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const expired = await first.client.models.beginOAuth({ provider: "anthropic" });
    await runAsSystem("expire synthetic model sign-in", () =>
      a.prisma.modelOAuthSession.update({
        where: { id: expired.loginId },
        data: { expiresAt: new Date(Date.now() - 5000) },
      }),
    );
    await expect(
      second.client.models.submitOAuthCode({ loginId: expired.loginId, code: "fixture" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const started = await first.client.models.beginOAuth({ provider: "anthropic" });
    await first.oauth.stop();
    await second.client.models.submitOAuthCode({ loginId: started.loginId, code: "fixture" });
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId: started.loginId })).toEqual({
        status: "ready",
      }),
    );
    expect(second.exchange).toHaveBeenCalledOnce();
    await first.oauth.sessions.clearExpired();
    expect(await a.prisma.modelOAuthSession.count({ where: { id: expired.loginId } })).toBe(0);
  });

  it("does not allow a second Space of the same account to observe or redeem another Space's code", async () => {
    const actor = await member();
    const otherSpaceId = randomUUID();
    const organizationId = actors.find((entry) => entry.userId === actor.userId)!.organizationId;
    await a.prisma.space.create({
      data: { id: otherSpaceId, organizationId, name: "Other Space" },
    });
    await a.prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: otherSpaceId,
        userId: actor.userId,
        organizationId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const first = process(a, actor);
    const second = process(b, { ...actor, spaceId: otherSpaceId });
    const start = await first.client.models.beginOAuth({ provider: "anthropic" });
    await expect(
      second.client.models.completeOAuth({ loginId: start.loginId }),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      second.client.models.submitOAuthCode({ loginId: start.loginId, code: "fixture" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await second.client.models.cancelOAuth({ loginId: start.loginId });
    await first.client.models.submitOAuthCode({ loginId: start.loginId, code: "fixture" });
    await vi.waitFor(async () =>
      expect(await first.client.models.completeOAuth({ loginId: start.loginId })).toEqual({
        status: "ready",
      }),
    );
    expect(second.exchange).not.toHaveBeenCalled();
  });

  it("does not publish an authorization URL if disconnect lands during verifier encryption", async () => {
    const actor = await member();
    const entered = gate<void>();
    const release = gate<void>();
    const secrets = new EncryptedSecretStore(key);
    const put = secrets.put.bind(secrets);
    vi.spyOn(secrets, "put").mockImplementation(async (...args) => {
      if (args[1].operationId === "model.oauth.session") {
        entered.resolve();
        await release.promise;
      }
      return put(...args);
    });
    const first = process(a, actor, undefined, secrets);
    const second = process(b, actor);
    const begin = first.client.models.beginOAuth({ provider: "anthropic" });
    const finished = expect(begin).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await entered.promise;
    try {
      await expect(second.client.models.disconnect({ provider: "anthropic" })).resolves.toEqual({
        ok: true,
      });
    } finally {
      release.resolve();
    }
    await finished;
    expect(first.exchange).not.toHaveBeenCalled();
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("allows a new registration when disconnect acquires the provider lock first", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const beforeRegister = gate<void>();
    const release = gate<void>();
    const register = first.oauth.sessions.register.bind(first.oauth.sessions);
    vi.spyOn(first.oauth.sessions, "register").mockImplementationOnce(async (input) => {
      beforeRegister.resolve();
      await release.promise;
      return register(input);
    });
    const begin = first.client.models.beginOAuth({ provider: "anthropic" });
    await beforeRegister.promise;
    try {
      expect(await a.prisma.modelOAuthSession.count({ where: { userId: actor.userId } })).toBe(0);
      await expect(second.client.models.disconnect({ provider: "anthropic" })).resolves.toEqual({
        ok: true,
      });
    } finally {
      release.resolve();
    }
    const { loginId } = await begin;
    await first.client.models.submitOAuthCode({ loginId, code: "fixture" });
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId })).toEqual({ status: "ready" }),
    );
    expect(first.exchange).toHaveBeenCalledOnce();
  });

  it("preserves a login bound to a different credential after an exact disconnect", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const old = await second.client.models.connect({
      provider: "anthropic",
      apiKey: "synthetic-old-key",
    });
    const newer = await a.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "anthropic",
        label: "Other account",
        secretId: randomUUID(),
        updatedAt: new Date(Date.now() + 1000),
      },
    });
    const { loginId } = await first.client.models.beginOAuth({
      provider: "anthropic",
      label: "Reconnected",
    });
    await second.client.models.disconnect({
      provider: "anthropic",
      credentialId: old.id,
      expectedRevision: old.connectionRevision,
    });
    await first.client.models.submitOAuthCode({ loginId, code: "fixture" });
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId })).toEqual({ status: "ready" }),
    );
    expect(
      await a.prisma.userModelCredential.findMany({ where: { userId: actor.userId } }),
    ).toMatchObject([{ id: newer.id, connectionRevision: 2, label: "Reconnected" }]);
  });

  it("retires a first login after an intervening credential is created and explicitly disconnected", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({ provider: "anthropic" });
    const linked = await second.client.models.connect({
      provider: "anthropic",
      apiKey: "synthetic-intermediate-key",
    });
    await second.client.models.disconnect({
      provider: "anthropic",
      credentialId: linked.id,
      expectedRevision: linked.connectionRevision,
    });
    await expect(
      first.client.models.submitOAuthCode({ loginId: started.loginId, code: "fixture" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(first.exchange).not.toHaveBeenCalled();
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("cannot save after the original Space membership is removed", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({ provider: "github-copilot" });
    await runAsTenant(actor, () =>
      a.prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      }),
    );
    await expectLateProviderSave(first);
    await expect(second.oauth.sessions.read({ ...actor, id: started.loginId })).resolves.toBeNull();
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("does not persist a credential when Space deletion has already been claimed", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const { loginId } = await first.client.models.beginOAuth({ provider: "anthropic" });
    await a.prisma.space.update({ where: { id: actor.spaceId }, data: { deletingAt: new Date() } });
    await first.client.models.submitOAuthCode({ loginId, code: "fixture" });
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId })).toMatchObject({
        status: "error",
      }),
    );
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("does not overwrite a different connection revision saved while the provider was open", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({
      provider: "anthropic",
      label: "Older sign-in",
    });
    const latest = await second.client.models.connect({
      provider: "anthropic",
      label: "Newer connection",
      apiKey: "synthetic-new-key",
    });
    await first.client.models.submitOAuthCode({ loginId: started.loginId, code: "fixture" });
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId: started.loginId })).toMatchObject({
        status: "error",
      }),
    );
    expect(
      await a.prisma.userModelCredential.findMany({ where: { userId: actor.userId } }),
    ).toMatchObject([{ id: latest.id, label: "Newer connection", connectionRevision: 1 }]);
    expect(await a.prisma.secret.count({ where: { userId: actor.userId, kind: "model" } })).toBe(1);
  });

  it("waits for a claimed save and clears its result when another process disconnects", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const entered = gate<void>();
    const release = gate<void>();
    const instrumented = a.prisma.$extends({
      query: {
        secret: {
          async create({ args, query }) {
            const stored = await query(args);
            if (args.data.userId === actor.userId) {
              entered.resolve();
              await release.promise;
            }
            return stored;
          },
        },
      },
    });
    const writer = process({ ...a, prisma: instrumented as unknown as typeof a.prisma }, actor);
    const started = await writer.client.models.beginOAuth({ provider: "anthropic" });
    await writer.client.models.submitOAuthCode({ loginId: started.loginId, code: "fixture" });
    await entered.promise;
    let disconnected = false;
    const disconnect = second.client.models.disconnect({ provider: "anthropic" }).then((value) => {
      disconnected = true;
      return value;
    });
    void disconnect.catch(() => undefined);
    try {
      await expect(
        second.client.models.completeOAuth({ loginId: started.loginId }),
      ).resolves.toEqual({ status: "pending" });
      await vi.waitFor(async () => {
        const { rows } = await b.pool.query<{ blocked: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity AS waiter
            JOIN pg_stat_activity AS writer
              ON writer.pid = ANY(pg_blocking_pids(waiter.pid))
            WHERE waiter.application_name = 'model-sign-in-b'
              AND writer.application_name = 'model-sign-in-a'
              AND waiter.wait_event_type = 'Lock'
          ) AS blocked
        `);
        expect(rows[0]?.blocked).toBe(true);
      });
      expect(disconnected).toBe(false);
      let stopped = false;
      const stop = writer.oauth.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(stopped).toBe(false);
      release.resolve();
      await stop;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await disconnect.catch(() => undefined);
    }
    await expect(disconnect).resolves.toEqual({ ok: true });
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
    expect(await a.prisma.secret.count({ where: { userId: actor.userId, kind: "model" } })).toBe(0);
    await expect(
      first.client.models.completeOAuth({ loginId: started.loginId }),
    ).resolves.toMatchObject({ status: "error" });
  });

  it("reports an expired lease and refuses a provider response that returns late", async () => {
    const actor = await member();
    const first = process(a, actor);
    const second = process(b, actor);
    const started = await first.client.models.beginOAuth({ provider: "github-copilot" });
    const original = await first.oauth.sessions.read({ id: started.loginId, ...actor });
    expect(original!.expiresAt.getTime() - original!.createdAt.getTime()).toBeLessThan(310_000);
    await a.prisma.modelOAuthSession.update({
      where: { id: started.loginId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      second.client.models.completeOAuth({ loginId: started.loginId }),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringMatching(/interrupted/i),
    });
    await expectLateProviderSave(first);
    expect(await a.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("rejects a competing begin while the prior sign-in has claimed its save", async () => {
    const actor = await member();
    const entered = gate<void>();
    const release = gate<void>();
    const secrets = new EncryptedSecretStore(key);
    const put = secrets.put.bind(secrets);
    vi.spyOn(secrets, "put").mockImplementation(async (...args) => {
      if (args[1].operationId === "cred") {
        entered.resolve();
        await release.promise;
      }
      return put(...args);
    });
    const first = process(a, actor, undefined, secrets);
    const second = process(b, actor);
    const start = await first.client.models.beginOAuth({ provider: "anthropic" });
    await first.client.models.submitOAuthCode({ loginId: start.loginId, code: "fixture" });
    await entered.promise;
    try {
      const saving = await first.oauth.sessions.read({ ...actor, id: start.loginId });
      expect(saving!.expiresAt.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
      await expect(
        second.client.models.beginOAuth({ provider: "anthropic" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      release.resolve();
    }
    await vi.waitFor(async () =>
      expect(await second.client.models.completeOAuth({ loginId: start.loginId })).toEqual({
        status: "ready",
      }),
    );
    expect(await a.prisma.modelOAuthSession.count({ where: { userId: actor.userId } })).toBe(1);
  });
});
