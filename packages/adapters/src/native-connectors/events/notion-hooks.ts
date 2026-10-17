import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type {
  NativeNotionHook,
  NativeNotionHookStatus,
  RevealedNativeNotionHookToken,
} from "@rakazo/contracts";
import {
  BeginNativeNotionHookSetupInputSchema,
  ConfirmNativeNotionHookSetupInputSchema,
  DisableNativeNotionHookInputSchema,
  NativeNotionHookStatusInputSchema,
  RevealNativeNotionHookTokenInputSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import { persistPreparedSecret } from "../../secret-persistence.js";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import type { NotionEventSignal, NotionVerifiedHook } from "./signals.js";
import {
  InvalidNativeEventSignal,
  verifyNotionSetupIdentity,
  verifyNotionSignal,
} from "./signals.js";

interface HookRow {
  id: string;
  configId: string;
  configRevision: number;
  revision: number;
  integrationId: string | null;
  candidateIntegrationId: string | null;
  subscriptionId: string | null;
  secretRecordId: string | null;
  ciphertext: string | null;
  enabled: boolean;
  disabledAt: Date | null;
  setupOwnerUserId: string;
  setupSpaceId: string;
  setupExpiresAt: Date;
  ownerConfirmedAt: Date | null;
  lastVerifiedAt: Date | null;
  currentConfigRevision?: number;
  configEnabled?: boolean;
  credentialKind?: string;
  appId?: string;
  config?: unknown;
  applicationSecret?: string | null;
  applicationSecretRecordId?: string | null;
}
export interface LoadedNativeNotionHook extends NotionVerifiedHook {
  id: string;
  configId: string;
  revision: number;
}
const SETUP_MS = 15 * 60_000; // Product setup window; never a Notion delivery SLA or callback lifetime.
const Challenge = z.object({ verification_token: z.string().min(16).max(4096) }).strict();
function hookJoinSql() {
  return Prisma.sql`SELECT h.*,a.revision AS "currentConfigRevision",a.enabled AS "configEnabled",a."credentialKind",a."appId",a.config,a.ciphertext AS "applicationSecret",a."secretRecordId" AS "applicationSecretRecordId" FROM native_notion_hooks h JOIN native_app_configs a ON a.id=h."configId"`;
}
export function nativeEventWebhookOrigin(apiUrl: string): string | undefined {
  const url = new URL(apiUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost")
  )
    return undefined;
  return url.origin;
}
function configured(row: HookRow): boolean {
  const settings = NativeConfigSettingsSchema.safeParse(row.config);
  return (
    row.configEnabled === true &&
    row.appId === "notion" &&
    row.credentialKind === "oauth" &&
    row.configRevision === row.currentConfigRevision &&
    Boolean(row.applicationSecret && row.applicationSecretRecordId) &&
    settings.success &&
    Boolean(settings.data.clientId) &&
    settings.data.capabilities.includes("read_content")
  );
}
function setupPending(row: HookRow, now: Date): boolean {
  return (
    configured(row) &&
    !row.enabled &&
    !row.disabledAt &&
    !row.ownerConfirmedAt &&
    row.setupExpiresAt > now
  );
}
function requireOwner(mayConfigure: boolean): void {
  if (!mayConfigure)
    throw new NativeActionError("authorization_required", "Deployment configuration is required.");
}
function conflict(): never {
  throw new NativeActionError("version_conflict", "The webhook setup changed. Read it again.");
}
function json(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new InvalidNativeEventSignal();
  }
}
/** A random app-bound callback stays identical from first challenge through runtime. */
export class NativeNotionHookStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly apiUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private dto(row: HookRow, now = new Date()): NativeNotionHook {
    const origin = nativeEventWebhookOrigin(this.apiUrl);
    const phase = !configured(row)
      ? "invalidated"
      : row.disabledAt
        ? "disabled"
        : row.enabled && row.ownerConfirmedAt
          ? row.subscriptionId
            ? "active"
            : "waiting_for_signed_identity"
          : row.setupExpiresAt <= now
            ? "expired"
            : row.secretRecordId
              ? "waiting_for_owner"
              : "waiting_for_challenge";
    return {
      id: row.id,
      configId: row.configId,
      configRevision: row.configRevision,
      revision: row.revision,
      phase,
      integrationId: row.integrationId,
      candidateIntegrationId: row.candidateIntegrationId,
      subscriptionId: row.subscriptionId,
      configured: Boolean(row.secretRecordId && row.ciphertext),
      enabled: row.enabled,
      webhookUrl: origin
        ? `${origin}/api/connectors/events/notion/${encodeURIComponent(row.id)}`
        : null,
      setupExpiresAt: row.setupExpiresAt.toISOString(),
      ownerConfirmedAt: row.ownerConfirmedAt?.toISOString() ?? null,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    };
  }
  private async rows(id: string): Promise<HookRow[]> {
    return this.prisma.$queryRaw<HookRow[]>(Prisma.sql`${hookJoinSql()} WHERE h.id=${id}`);
  }
  private async current(
    tx: Prisma.TransactionClient,
    id: string,
    configId: string,
  ): Promise<HookRow | undefined> {
    const rows = await tx.$queryRaw<HookRow[]>(
      Prisma.sql`${hookJoinSql()} WHERE h.id=${id} AND h."configId"=${configId} FOR UPDATE OF h`,
    );
    return rows[0];
  }
  private async lockConfig(tx: Prisma.TransactionClient, configId: string): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM native_app_configs WHERE id=${configId} FOR UPDATE`,
    );
  }
  async status(
    raw: unknown,
    _context: AdapterContext,
    mayConfigure: boolean,
  ): Promise<NativeNotionHookStatus> {
    requireOwner(mayConfigure);
    const input = NativeNotionHookStatusInputSchema.parse(raw);
    const config = await this.prisma.nativeAppConfig.findFirst({
      where: { id: input.configId, appId: "notion", credentialKind: "oauth" },
      select: { id: true },
    });
    if (!config)
      throw new NativeActionError(
        "not_configured",
        "Select a public Notion OAuth application configuration.",
      );
    const rows = await this.prisma.$queryRaw<HookRow[]>(
      Prisma.sql`${hookJoinSql()} WHERE h."configId"=${input.configId} ORDER BY h."createdAt",h.id`,
    );
    return {
      configId: input.configId,
      publicHttpsAvailable: Boolean(nativeEventWebhookOrigin(this.apiUrl)),
      hooks: rows.map((row) => this.dto(row)),
    };
  }
  async begin(
    raw: unknown,
    context: AdapterContext,
    mayConfigure: boolean,
    now = new Date(),
  ): Promise<NativeNotionHook> {
    requireOwner(mayConfigure);
    const input = BeginNativeNotionHookSetupInputSchema.parse(raw);
    if (!nativeEventWebhookOrigin(this.apiUrl))
      throw new NativeActionError("not_configured", "A public HTTPS API origin is required.");
    return this.prisma.$transaction(async (tx) => {
      await this.lockConfig(tx, input.configId);
      const app = await tx.nativeAppConfig.findUnique({ where: { id: input.configId } });
      const probe: HookRow = {
        id: "probe",
        configId: input.configId,
        configRevision: app?.revision ?? 0,
        revision: 1,
        integrationId: null,
        candidateIntegrationId: null,
        subscriptionId: null,
        secretRecordId: null,
        ciphertext: null,
        enabled: false,
        disabledAt: null,
        setupOwnerUserId: context.userId,
        setupSpaceId: context.spaceId,
        setupExpiresAt: now,
        ownerConfirmedAt: null,
        lastVerifiedAt: null,
        currentConfigRevision: app?.revision,
        configEnabled: app?.enabled,
        credentialKind: app?.credentialKind,
        appId: app?.appId,
        config: app?.config,
        applicationSecret: app?.ciphertext,
        applicationSecretRecordId: app?.secretRecordId,
      };
      if (!configured(probe))
        throw new NativeActionError(
          "not_configured",
          "Configure public Notion OAuth with read content access first.",
        );
      const pending = await tx.$queryRaw<HookRow[]>(
        Prisma.sql`${hookJoinSql()} WHERE h."configId"=${input.configId} AND h."configRevision"=${probe.configRevision} AND h."setupOwnerUserId"=${context.userId} AND h.enabled=false AND h."disabledAt" IS NULL AND h."ownerConfirmedAt" IS NULL AND h."setupExpiresAt">${now} ORDER BY h."createdAt" LIMIT 1 FOR UPDATE OF h`,
      );
      if (pending[0]) return this.dto(pending[0], now);
      const id = randomBytes(32).toString("base64url");
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO native_notion_hooks(id,"configId","configRevision","setupOwnerUserId","setupSpaceId","setupExpiresAt") VALUES(${id},${input.configId},${probe.configRevision},${context.userId},${context.spaceId},${new Date(now.getTime() + SETUP_MS)})`,
      );
      const row = await this.current(tx, id, input.configId);
      if (!row) conflict();
      return this.dto(row, now);
    });
  }
  /** Anonymous input may fill one untrusted pending slot, never enable a source or replace a secret. */
  async captureChallenge(id: string, raw: Uint8Array, now = new Date()): Promise<boolean> {
    const parsed = Challenge.safeParse(json(raw));
    if (!parsed.success) return false;
    const before = (await this.rows(id))[0];
    if (!before || !setupPending(before, now) || before.secretRecordId) return false;
    const recordId = randomUUID(),
      context: AdapterContext = {
        userId: before.setupOwnerUserId,
        spaceId: before.setupSpaceId,
        operationId: "native-hook-challenge",
        traceId: randomUUID(),
        signal: new AbortController().signal,
      };
    const prepared = await this.secrets.put(parsed.data.verification_token, context, { recordId }),
      material = { id: recordId, ciphertext: prepared.ciphertext };
    return persistPreparedSecret(this.prisma, this.secrets, material, () =>
      this.prisma.$transaction(async (tx) => {
        await this.lockConfig(tx, before.configId);
        const row = await this.current(tx, id, before.configId);
        if (
          !row ||
          row.revision !== before.revision ||
          !setupPending(row, this.clock()) ||
          row.secretRecordId
        )
          return false;
        const count = await tx.$executeRaw(
          Prisma.sql`UPDATE native_notion_hooks SET "secretRecordId"=${recordId},ciphertext=${material.ciphertext},revision=revision+1,"updatedAt"=${now} WHERE id=${id} AND revision=${before.revision} AND "secretRecordId" IS NULL`,
        );
        if (count !== 1) conflict();
        return true;
      }),
    );
  }
  async reveal(
    raw: unknown,
    context: AdapterContext,
    mayConfigure: boolean,
    now = new Date(),
  ): Promise<RevealedNativeNotionHookToken> {
    requireOwner(mayConfigure);
    const input = RevealNativeNotionHookTokenInputSchema.parse(raw),
      row = (await this.rows(input.id))[0];
    if (!row || row.configId !== input.configId || row.revision !== input.expectedRevision)
      conflict();
    if (
      !setupPending(row, now) ||
      row.setupOwnerUserId !== context.userId ||
      !row.secretRecordId ||
      !row.ciphertext
    )
      throw new NativeActionError(
        "authorization_required",
        "This pending token is only available to its setup owner within the setup window.",
      );
    const verificationToken = await this.secrets.load(row.ciphertext, {
      recordId: row.secretRecordId,
    });
    if (!verificationToken)
      throw new NativeActionError(
        "not_configured",
        "The pending verification token is unavailable.",
      );
    const current = (await this.rows(input.id))[0],
      respondAt = this.clock();
    if (
      !current ||
      current.configId !== input.configId ||
      current.revision !== row.revision ||
      current.secretRecordId !== row.secretRecordId ||
      current.ciphertext !== row.ciphertext ||
      current.setupOwnerUserId !== context.userId ||
      !setupPending(current, respondAt)
    )
      throw new NativeActionError(
        "authorization_required",
        "This pending verification token is no longer available.",
      );
    return { hook: this.dto(current, respondAt), verificationToken };
  }
  async confirm(
    raw: unknown,
    context: AdapterContext,
    mayConfigure: boolean,
    now = new Date(),
  ): Promise<NativeNotionHook> {
    requireOwner(mayConfigure);
    const input = ConfirmNativeNotionHookSetupInputSchema.parse(raw);
    return this.prisma.$transaction(async (tx) => {
      await this.lockConfig(tx, input.configId);
      const row = await this.current(tx, input.id, input.configId);
      if (!row || row.revision !== input.expectedRevision) conflict();
      if (
        !setupPending(row, this.clock()) ||
        row.setupOwnerUserId !== context.userId ||
        !row.secretRecordId
      )
        throw new NativeActionError(
          "authorization_required",
          "Complete this setup in Notion within its window first.",
        );
      const integrationId = input.integrationId.toLowerCase();
      if (row.candidateIntegrationId && row.candidateIntegrationId !== integrationId)
        throw new NativeActionError(
          "invalid_input",
          "Check the exact signed integration identity before confirming.",
        );
      const active = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM native_notion_hooks WHERE "configId"=${input.configId} AND enabled=true AND id<>${input.id}`,
      );
      if (active.length)
        throw new NativeActionError(
          "version_conflict",
          "Stop the current webhook explicitly before confirming its replacement.",
        );
      await tx.$executeRaw(
        Prisma.sql`UPDATE native_notion_hooks SET "integrationId"=${integrationId},enabled=true,"ownerConfirmedAt"=${now},revision=revision+1,"updatedAt"=${now} WHERE id=${row.id} AND revision=${row.revision}`,
      );
      const saved = await this.current(tx, row.id, row.configId);
      if (!saved) conflict();
      return this.dto(saved, now);
    });
  }
  async disable(
    raw: unknown,
    _context: AdapterContext,
    mayConfigure: boolean,
    now = new Date(),
  ): Promise<NativeNotionHook> {
    requireOwner(mayConfigure);
    const input = DisableNativeNotionHookInputSchema.parse(raw),
      before = (await this.rows(input.id))[0];
    if (!before || before.configId !== input.configId || before.revision !== input.expectedRevision)
      conflict();
    const material =
      before.ciphertext && before.secretRecordId
        ? { id: before.secretRecordId, ciphertext: before.ciphertext }
        : undefined;
    return persistPreparedSecret(this.prisma, this.secrets, material, () =>
      this.prisma.$transaction(async (tx) => {
        await this.lockConfig(tx, input.configId);
        const row = await this.current(tx, input.id, input.configId);
        if (!row || row.revision !== input.expectedRevision) conflict();
        await tx.$executeRaw(
          Prisma.sql`UPDATE native_notion_hooks SET enabled=false,"disabledAt"=${now},"secretRecordId"=NULL,ciphertext=NULL,revision=revision+1,"updatedAt"=${now} WHERE id=${row.id} AND revision=${row.revision}`,
        );
        const saved = await this.current(tx, row.id, row.configId);
        if (!saved) conflict();
        return this.dto(saved, now);
      }),
    );
  }
  async acceptSigned(
    id: string,
    raw: Uint8Array,
    signature: string | null,
    now = new Date(),
  ): Promise<{ hook: LoadedNativeNotionHook; event: NotionEventSignal | undefined } | undefined> {
    const before = (await this.rows(id))[0];
    if (
      !before ||
      !configured(before) ||
      before.disabledAt ||
      !before.secretRecordId ||
      !before.ciphertext ||
      (!before.enabled && !setupPending(before, now))
    )
      return undefined;
    const token = await this.secrets.load(before.ciphertext, { recordId: before.secretRecordId });
    if (!token)
      throw new NativeActionError("not_configured", "The verification token is unavailable.");
    const identity = verifyNotionSetupIdentity(raw, signature, token);
    const accepted = await this.prisma.$transaction(async (tx) => {
      await this.lockConfig(tx, before.configId);
      const row = await this.current(tx, id, before.configId);
      if (
        !row ||
        !configured(row) ||
        row.disabledAt ||
        row.secretRecordId !== before.secretRecordId
      )
        return undefined;
      if (!row.enabled) {
        if (!setupPending(row, this.clock())) return undefined;
        if (row.candidateIntegrationId && row.candidateIntegrationId !== identity.integrationId)
          throw new InvalidNativeEventSignal();
        if (!row.candidateIntegrationId)
          await tx.$executeRaw(
            Prisma.sql`UPDATE native_notion_hooks SET "candidateIntegrationId"=${identity.integrationId},"lastVerifiedAt"=${now},revision=revision+1,"updatedAt"=${now} WHERE id=${row.id} AND revision=${row.revision}`,
          );
        return undefined; // Candidate display only; no subscription CAS or automation before owner confirmation.
      }
      if (!row.ownerConfirmedAt || row.integrationId !== identity.integrationId)
        throw new InvalidNativeEventSignal();
      if (row.subscriptionId && row.subscriptionId !== identity.subscriptionId)
        throw new InvalidNativeEventSignal();
      if (!row.subscriptionId)
        await tx.$executeRaw(
          Prisma.sql`UPDATE native_notion_hooks SET "subscriptionId"=${identity.subscriptionId},"lastVerifiedAt"=${now},revision=revision+1,"updatedAt"=${now} WHERE id=${row.id} AND "subscriptionId" IS NULL`,
        );
      else
        await tx.$executeRaw(
          Prisma.sql`UPDATE native_notion_hooks SET "lastVerifiedAt"=${now} WHERE id=${row.id} AND revision=${row.revision}`,
        );
      return this.current(tx, row.id, row.configId);
    });
    if (!accepted?.enabled || !accepted.integrationId || !accepted.subscriptionId) return undefined;
    const hook: LoadedNativeNotionHook = {
      id: accepted.id,
      configId: accepted.configId,
      revision: accepted.revision,
      integrationId: accepted.integrationId,
      subscriptionId: accepted.subscriptionId,
      verificationToken: token,
      verified: true,
    };
    return { hook, event: verifyNotionSignal(raw, signature, hook) };
  }
  async load(id: string, revision?: number): Promise<LoadedNativeNotionHook | undefined> {
    const row = (await this.rows(id))[0];
    if (
      !row ||
      !configured(row) ||
      !row.enabled ||
      row.disabledAt ||
      !row.ownerConfirmedAt ||
      !row.integrationId ||
      !row.subscriptionId ||
      !row.secretRecordId ||
      !row.ciphertext ||
      (revision !== undefined && row.revision !== revision)
    )
      return undefined;
    const verificationToken = await this.secrets.load(row.ciphertext, {
      recordId: row.secretRecordId,
    });
    if (!verificationToken)
      throw new NativeActionError("not_configured", "The verification token is unavailable.");
    return {
      id: row.id,
      configId: row.configId,
      revision: row.revision,
      integrationId: row.integrationId,
      subscriptionId: row.subscriptionId,
      verificationToken,
      verified: true,
    };
  }
}
