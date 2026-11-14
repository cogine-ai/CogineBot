import { randomBytes, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  anthropicAuthorizationUrl,
  exchangeAnthropicAuthorizationCode,
  MODEL_OAUTH_INTERRUPTED,
  MODEL_OAUTH_LEASE_RENEW_MS,
  MODEL_OAUTH_NOT_FOUND,
  type ModelOAuthActor,
  type ModelOAuthLease,
  type ModelOAuthRef,
  ModelOAuthSaveInProgress,
  type ModelOAuthSessions,
  type PiOAuthConnected,
  PiOAuthLogins,
  parseAnthropicAuthorizationCode,
  SUBSCRIPTION_SIGN_IN_PROVIDERS,
  waitForModelOAuthSave,
} from "@rakazo/adapters";
import { type ModelCredential, ModelCredentialSchema } from "@rakazo/contracts";
import { type Prisma, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type LocalBegin = Parameters<PiOAuthLogins["begin"]>[0];
type Login = NonNullable<LocalBegin["login"]>;
export type AssertModelSignIn = (tx: Prisma.TransactionClient) => Promise<void>;
type Begin = Omit<LocalBegin, "login" | "loginId" | "onReady" | "onFailure"> & {
  login?: (interaction: Parameters<Login>[0], assertActive: AssertModelSignIn) => ReturnType<Login>;
};
type Session = NonNullable<Awaited<ReturnType<ModelOAuthSessions["read"]>>>;
export type SaveSubscription = (
  login: PiOAuthConnected,
  session: ModelOAuthLease & Pick<Session, "credentialId" | "credentialRevision">,
) => Promise<ModelCredential>;

const SIGN_IN_SECONDS = 15 * 60;
const pending = { status: "pending" } as const;
const ready = { status: "ready" } as const;
const failed = (error: string) => ({ status: "error" as const, error });

/** The database owns the result. The original process still handles non-transferable
 * provider interactions, including the local ChatGPT callback. */
export class ModelOAuth {
  private readonly running = new Map<
    string,
    {
      lease: ModelOAuthLease;
      abort: AbortController;
      heartbeat: ReturnType<typeof setInterval>;
      saving: boolean;
      renewing: boolean;
    }
  >();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private stopped = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly sessions: ModelOAuthSessions,
    private readonly secrets: Pick<SecretStore, "load" | "put">,
    private readonly local = new PiOAuthLogins(),
    private readonly exchange = exchangeAnthropicAuthorizationCode,
  ) {}

  startCleanup() {
    if (this.cleanupTimer || this.stopped) return;
    let running = false;
    const sweep = () => {
      if (running || this.stopped) return;
      running = true;
      this.track(this.sessions.clearExpired())
        .catch(() => getLogger().warn("Could not expire model sign-ins"))
        .finally(() => {
          running = false;
        });
    };
    sweep();
    this.cleanupTimer = setInterval(sweep, 60_000);
    this.cleanupTimer.unref?.();
  }

  begin(input: Begin, persist: SaveSubscription) {
    return this.track(this.start(input, persist));
  }

  private async start(input: Begin, persist: SaveSubscription) {
    this.assertRunning();
    if (!Object.hasOwn(SUBSCRIPTION_SIGN_IN_PROVIDERS, input.provider))
      throw new ORPCError("BAD_REQUEST", {
        message: "This provider does not support subscription sign-in.",
      });
    const id = randomUUID();
    const scope = { id, userId: input.userId, spaceId: input.spaceId, provider: input.provider };
    const canHandOff = input.provider === ANTHROPIC_OAUTH_PROVIDER && !input.login;
    const verifier = canHandOff ? randomBytes(32).toString("base64url") : undefined;
    const leaseOwner = randomUUID();
    input.signal?.throwIfAborted();
    const row = await this.sessions
      .register({
        ...scope,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        label: input.label,
        leaseOwner,
        expiresAt: new Date(Date.now() + SIGN_IN_SECONDS * 1000),
      })
      .catch((error: unknown) => {
        if (error instanceof ModelOAuthSaveInProgress)
          throw new ORPCError("CONFLICT", {
            message: "Another sign-in is being saved. Try again.",
          });
        throw error;
      });
    const lease = { ...scope, leaseOwner };
    const active = this.hold(lease);
    try {
      this.assertRunning();
      const signal = input.signal
        ? AbortSignal.any([input.signal, active.abort.signal])
        : active.abort.signal;
      if (verifier) {
        const { ciphertext } = await this.secrets.put(
          verifier,
          {
            userId: input.userId,
            spaceId: input.spaceId,
            operationId: "model.oauth.session",
            traceId: id,
            signal,
          },
          { recordId: id, ephemeral: true },
        );
        signal.throwIfAborted();
        if (!(await this.sessions.publishHandoff(lease, ciphertext)))
          throw new Error(MODEL_OAUTH_INTERRUPTED);
        this.release(active);
        return {
          loginId: id,
          provider: input.provider,
          mode: "auth-url" as const,
          verificationUri: anthropicAuthorizationUrl(verifier),
          expiresInSeconds: SIGN_IN_SECONDS,
        };
      }
      const begun = await this.local.begin({
        ...input,
        login: input.login
          ? (interaction) =>
              input.login!(interaction, (tx) => this.sessions.assertPending(tx, lease))
          : undefined,
        loginId: id,
        signal,
        onReady: () =>
          this.running.get(id) === active
            ? this.track(
                this.local
                  .finish(id, scope, (login) =>
                    this.save(row, lease, { ...login, signal: active.abort.signal }, persist),
                  )
                  .then(() => undefined),
              )
            : Promise.resolve(),
        onFailure: () =>
          this.running.get(id) === active ? this.track(this.fail(active)) : Promise.resolve(),
      });
      await this.sessions.setProviderExpiry(
        lease,
        new Date(Date.now() + begun.expiresInSeconds * 1000),
      );
      const current = await this.sessions.read(scope);
      if (!current || current.status === "failed") throw new Error(MODEL_OAUTH_INTERRUPTED);
      return begun;
    } catch (error) {
      await this.fail(active, MODEL_OAUTH_INTERRUPTED);
      if (input.signal?.aborted || error instanceof ORPCError) throw error;
      throw new ORPCError("BAD_REQUEST", { message: MODEL_OAUTH_INTERRUPTED });
    }
  }

  submit(id: string, actor: ModelOAuthActor, code: string, persist: SaveSubscription) {
    return this.track(this.submitCode({ ...actor, id }, code, persist));
  }

  private async submitCode(ref: ModelOAuthRef, code: string, persist: SaveSubscription) {
    this.assertRunning();
    const row = await this.sessions.read(ref);
    if (!row || row.status === "failed")
      throw new ORPCError("NOT_FOUND", { message: MODEL_OAUTH_NOT_FOUND });
    if (row.provider !== ANTHROPIC_OAUTH_PROVIDER) return this.local.submit(ref.id, ref, code);
    if (
      row.status === "connected" ||
      (row.leaseOwner && (row.leaseExpiresAt?.getTime() ?? 0) > Date.now())
    )
      return { ok: true as const };
    if (row.leaseOwner) throw new ORPCError("NOT_FOUND", { message: MODEL_OAUTH_INTERRUPTED });
    if (!row.handoffCiphertext)
      throw new ORPCError("NOT_FOUND", { message: MODEL_OAUTH_NOT_FOUND });
    const verifier = await this.secrets.load(row.handoffCiphertext, ref.id);
    try {
      parseAnthropicAuthorizationCode(verifier, code);
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Invalid authorization code.",
      });
    }
    this.assertRunning();
    const lease = { ...ref, provider: row.provider, leaseOwner: randomUUID() };
    if (!(await this.sessions.claimExchange(ref, lease.leaseOwner))) {
      const current = await this.sessions.read(ref);
      if (
        current?.status === "connected" ||
        (current?.leaseOwner && (current.leaseExpiresAt?.getTime() ?? 0) > Date.now())
      )
        return { ok: true as const };
      throw new ORPCError("NOT_FOUND", { message: MODEL_OAUTH_NOT_FOUND });
    }
    const active = this.hold(lease);
    this.track(
      (async () => {
        try {
          this.assertRunning();
          const credential = await this.exchange(verifier, code, active.abort.signal);
          await this.save(
            row,
            lease,
            {
              status: "connected",
              provider: row.provider,
              credential,
              modelId: row.modelId ?? undefined,
              thinkingLevel: row.hasThinkingLevel ? row.thinkingLevel : undefined,
              label: row.label ?? undefined,
              signal: active.abort.signal,
            },
            persist,
          );
        } catch {
          await this.fail(active);
        }
      })(),
    ).catch(() => getLogger().warn("Could not update subscription sign-in state"));
    return { ok: true as const };
  }

  async complete(id: string, actor: ModelOAuthActor) {
    const row = await this.sessions.read({ ...actor, id });
    if (!row) return failed(MODEL_OAUTH_NOT_FOUND);
    if (row.status === "failed") return failed(row.error ?? MODEL_OAUTH_INTERRUPTED);
    if (row.status === "connected") return ready;
    if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() <= Date.now())
      return failed(MODEL_OAUTH_INTERRUPTED);
    return pending;
  }

  async finish(id: string, actor: ModelOAuthActor) {
    const ref = { ...actor, id };
    const row = await this.sessions.read(ref);
    if (!row) return failed(MODEL_OAUTH_NOT_FOUND);
    if (row.status === "failed") return failed(row.error ?? MODEL_OAUTH_INTERRUPTED);
    if (row.status !== "connected")
      return row.leaseExpiresAt && row.leaseExpiresAt.getTime() <= Date.now()
        ? failed(MODEL_OAUTH_INTERRUPTED)
        : pending;
    const result = ModelCredentialSchema.safeParse(row.result);
    if (!result.success || !(await this.sessions.consume(ref, "connected")))
      return failed(MODEL_OAUTH_NOT_FOUND);
    return { status: "connected" as const, value: result.data };
  }

  cancel(id: string, actor: ModelOAuthActor, signal?: AbortSignal) {
    return this.track(
      this.cancelAttempt(
        id,
        actor,
        signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal,
      ),
    );
  }

  private async cancelAttempt(id: string, actor: ModelOAuthActor, signal: AbortSignal) {
    const ref = { ...actor, id };
    await waitForModelOAuthSave(() => this.sessions.cancel(ref), signal);
    await this.local.cancel(id, actor);
    const active = this.running.get(id);
    if (active && active.lease.userId === actor.userId && active.lease.spaceId === actor.spaceId)
      this.release(active);
  }

  private async save(
    row: Session,
    lease: ModelOAuthLease & { provider: string },
    login: PiOAuthConnected,
    persist: SaveSubscription,
  ) {
    const active = this.running.get(row.id);
    if (!active) return;
    if (this.stopped) {
      await this.fail(active, MODEL_OAUTH_INTERRUPTED);
      return;
    }
    active.saving = true;
    try {
      if (!(await this.sessions.markSaving(lease))) return;
      await runAsTenant(lease, () =>
        persist(login, {
          ...lease,
          credentialId: row.credentialId,
          credentialRevision: row.credentialRevision,
        }),
      );
    } catch {
      await this.sessions.fail(lease);
    } finally {
      this.release(active);
    }
  }

  private hold(lease: ModelOAuthLease) {
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      if (abort.signal.aborted) return;
      if (active.renewing) return;
      active.renewing = true;
      this.track(
        this.sessions
          .renew(lease)
          .then(async (valid) => {
            if (!valid && !active.saving) {
              abort.abort();
              this.release(active);
              await this.local.cancel(lease.id, lease);
            }
          })
          .finally(() => {
            active.renewing = false;
          }),
      ).catch(() => getLogger().warn("Could not renew subscription sign-in"));
    }, MODEL_OAUTH_LEASE_RENEW_MS);
    heartbeat.unref?.();
    const active = { lease, abort, heartbeat, saving: false, renewing: false };
    this.running.set(lease.id, active);
    return active;
  }

  private release(active: NonNullable<ReturnType<ModelOAuth["hold"]>>) {
    clearInterval(active.heartbeat);
    if (this.running.get(active.lease.id) === active) this.running.delete(active.lease.id);
    active.abort.abort();
  }

  private async fail(active: NonNullable<ReturnType<ModelOAuth["hold"]>>, message?: string) {
    if (this.running.get(active.lease.id) !== active) return;
    this.release(active);
    await this.sessions.fail(active.lease, message);
  }

  private assertRunning() {
    if (this.stopped)
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: MODEL_OAUTH_INTERRUPTED });
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  async stop() {
    this.stopped = true;
    this.shutdown.abort();
    clearInterval(this.cleanupTimer);
    const pending = [...this.running.values()].filter((active) => !active.saving);
    await Promise.all(
      pending.map((active) =>
        this.fail(active, MODEL_OAUTH_INTERRUPTED).catch(() =>
          getLogger().warn("Could not interrupt subscription sign-in"),
        ),
      ),
    );
    while (this.tasks.size) await Promise.allSettled(this.tasks);
    this.local.abortAll();
  }
}
