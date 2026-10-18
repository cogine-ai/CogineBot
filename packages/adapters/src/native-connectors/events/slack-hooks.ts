import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type {
  NativeSlackBotEvent,
  NativeSlackEventSignal,
  NativeSlackHook,
  NativeSlackHookStatus,
} from "@rakazo/contracts";
import {
  DisableNativeSlackHookInputSchema,
  NativeSlackEventSignalSchema,
  NativeSlackHookStatusInputSchema,
  SaveNativeSlackHookInputSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { persistPreparedSecret } from "../../secret-persistence.js";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { nativeEventWebhookOrigin } from "./notion-hooks.js";
import type { SlackVerifiedHook } from "./slack-signals.js";
import { InvalidNativeSlackSignal, verifySlackEnvelope } from "./slack-signals.js";

interface HookRow {
  id: string;
  configId: string;
  configRevision: number;
  revision: number;
  appId: string;
  teamId: string | null;
  botEvents: NativeSlackBotEvent[];
  secretRecordId: string | null;
  ciphertext: string | null;
  enabled: boolean;
  disabledAt: Date | null;
  ownerConfirmedAt: Date;
  lastVerifiedAt: Date | null;
  currentConfigRevision: number;
  configEnabled: boolean;
  configAppId: string;
  config: unknown;
}
interface InboxRow {
  id: string;
  hookId: string;
  hookRevision: number;
  configRevision: number;
  eventId: string;
  signal: unknown;
  dispatchedAt: Date | null;
}
export type AcceptedNativeSlackHookEvent =
  | { kind: "challenge"; challenge: string }
  | {
      kind: "event";
      inboxId: string;
      hook: SlackVerifiedHook;
      signal: NativeSlackEventSignal;
      alreadyDispatched: boolean;
    }
  | { kind: "ignored" };
const join = () =>
  Prisma.sql`SELECT h.*,a.revision AS "currentConfigRevision",a.enabled AS "configEnabled",a."appId" AS "configAppId",a.config FROM native_slack_hooks h JOIN native_app_configs a ON a.id=h."configId"`;
function configured(row: HookRow): boolean {
  const settings = NativeConfigSettingsSchema.safeParse(row.config);
  return (
    row.configEnabled &&
    row.configAppId === "slack" &&
    row.configRevision === row.currentConfigRevision &&
    settings.success &&
    settings.data.actor === "bot" &&
    (settings.data.tenantId ?? null) === row.teamId
  );
}
function enabled(row: HookRow): boolean {
  return (
    configured(row) &&
    row.enabled &&
    !row.disabledAt &&
    Boolean(row.secretRecordId && row.ciphertext && row.ownerConfirmedAt)
  );
}
function verified(row: HookRow): SlackVerifiedHook {
  return {
    id: row.id,
    configId: row.configId,
    configRevision: row.configRevision,
    revision: row.revision,
    appId: row.appId,
    teamId: row.teamId,
    botEvents: row.botEvents,
    verified: Boolean(row.lastVerifiedAt),
  };
}
function owner(mayConfigure: boolean): void {
  if (!mayConfigure)
    throw new NativeActionError("authorization_required", "Deployment configuration is required.");
}
function conflict(): never {
  throw new NativeActionError("version_conflict", "This Slack event hook changed. Read it again.");
}
export class NativeSlackHookStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly apiUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private dto(row: HookRow): NativeSlackHook {
    const origin = nativeEventWebhookOrigin(this.apiUrl);
    return {
      ...verified(row),
      botEvents: [...row.botEvents],
      enabled: row.enabled,
      configured: Boolean(row.secretRecordId && row.ciphertext),
      phase: !configured(row)
        ? "invalidated"
        : row.disabledAt || !row.enabled
          ? "disabled"
          : row.lastVerifiedAt
            ? "active"
            : "waiting_for_verification",
      webhookUrl: origin
        ? `${origin}/api/connectors/events/slack/${encodeURIComponent(row.id)}`
        : null,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    };
  }
  private rows(id: string, tx: Prisma.TransactionClient = this.prisma): Promise<HookRow[]> {
    return tx.$queryRaw<HookRow[]>(Prisma.sql`${join()} WHERE h.id=${id}`);
  }
  async status(
    raw: unknown,
    _context: AdapterContext,
    mayConfigure: boolean,
  ): Promise<NativeSlackHookStatus> {
    owner(mayConfigure);
    const { configId } = NativeSlackHookStatusInputSchema.parse(raw);
    const app = await this.prisma.nativeAppConfig.findFirst({
      where: { id: configId, appId: "slack" },
      select: { id: true },
    });
    if (!app)
      throw new NativeActionError("not_configured", "Select a Slack application configuration.");
    const rows = await this.prisma.$queryRaw<HookRow[]>(
      Prisma.sql`${join()} WHERE h."configId"=${configId} ORDER BY h."createdAt",h.id`,
    );
    return {
      configId,
      publicHttpsAvailable: Boolean(nativeEventWebhookOrigin(this.apiUrl)),
      hooks: rows.map((row) => this.dto(row)),
    };
  }
  async save(
    raw: unknown,
    context: AdapterContext,
    mayConfigure: boolean,
  ): Promise<NativeSlackHook> {
    owner(mayConfigure);
    const input = SaveNativeSlackHookInputSchema.parse(raw);
    if (!nativeEventWebhookOrigin(this.apiUrl))
      throw new NativeActionError(
        "not_configured",
        "Slack Events requires a public HTTPS API origin.",
      );
    const before = input.id ? (await this.rows(input.id))[0] : undefined;
    if (
      input.id &&
      (!before || before.configId !== input.configId || before.revision !== input.expectedRevision)
    )
      conflict();
    const id = input.id ?? randomBytes(32).toString("base64url"),
      recordId = randomUUID(),
      secret = await this.secrets.put(input.signingSecret, context, { recordId });
    const previous =
      before?.ciphertext && before.secretRecordId
        ? { id: before.secretRecordId, ciphertext: before.ciphertext }
        : undefined;
    return persistPreparedSecret(this.prisma, this.secrets, previous, () =>
      persistPreparedSecret(
        this.prisma,
        this.secrets,
        { id: recordId, ciphertext: secret.ciphertext },
        () =>
          this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM native_app_configs WHERE id=${input.configId} FOR UPDATE`,
            );
            const app = await tx.nativeAppConfig.findUnique({ where: { id: input.configId } }),
              settings = NativeConfigSettingsSchema.safeParse(app?.config);
            if (
              !app?.enabled ||
              app.appId !== "slack" ||
              !settings.success ||
              settings.data.actor !== "bot"
            )
              throw new NativeActionError(
                "not_configured",
                "Configure a Slack bot connection source first.",
              );
            if (before) {
              const current = (
                await tx.$queryRaw<HookRow[]>(
                  Prisma.sql`${join()} WHERE h.id=${id} AND h."configId"=${input.configId} FOR UPDATE OF h`,
                )
              )[0];
              if (
                !current ||
                current.revision !== input.expectedRevision ||
                current.secretRecordId !== before.secretRecordId
              )
                conflict();
              await tx.$executeRaw(
                Prisma.sql`UPDATE native_slack_hooks SET "configRevision"=${app.revision},revision=revision+1,"appId"=${input.appId},"teamId"=${settings.data.tenantId ?? null},"botEvents"=ARRAY[${Prisma.join(input.botEvents)}]::text[],"secretRecordId"=${recordId},ciphertext=${secret.ciphertext},enabled=true,"disabledAt"=NULL,"ownerConfirmedAt"=${this.clock()},"lastVerifiedAt"=NULL,"updatedAt"=${this.clock()} WHERE id=${id} AND revision=${input.expectedRevision}`,
              );
            } else {
              await tx.$executeRaw(
                Prisma.sql`INSERT INTO native_slack_hooks(id,"configId","configRevision","appId","teamId","botEvents","secretRecordId",ciphertext,"ownerConfirmedAt","setupOwnerUserId","setupSpaceId") VALUES(${id},${app.id},${app.revision},${input.appId},${settings.data.tenantId ?? null},ARRAY[${Prisma.join(input.botEvents)}]::text[],${recordId},${secret.ciphertext},${this.clock()},${context.userId},${context.spaceId})`,
              );
            }
            const saved = (await this.rows(id, tx))[0];
            if (!saved) conflict();
            return this.dto(saved);
          }),
      ),
    );
  }
  async disable(
    raw: unknown,
    _context: AdapterContext,
    mayConfigure: boolean,
  ): Promise<NativeSlackHook> {
    owner(mayConfigure);
    const input = DisableNativeSlackHookInputSchema.parse(raw),
      before = (await this.rows(input.id))[0];
    if (!before || before.configId !== input.configId || before.revision !== input.expectedRevision)
      conflict();
    const old =
      before.secretRecordId && before.ciphertext
        ? { id: before.secretRecordId, ciphertext: before.ciphertext }
        : undefined;
    return persistPreparedSecret(this.prisma, this.secrets, old, () =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM native_app_configs WHERE id=${input.configId} FOR UPDATE`,
        );
        const count = await tx.$executeRaw(
          Prisma.sql`UPDATE native_slack_hooks SET enabled=false,"disabledAt"=${this.clock()},"secretRecordId"=NULL,ciphertext=NULL,revision=revision+1,"updatedAt"=${this.clock()} WHERE id=${input.id} AND "configId"=${input.configId} AND revision=${input.expectedRevision}`,
        );
        if (count !== 1) conflict();
        const row = (await this.rows(input.id, tx))[0];
        if (!row) conflict();
        return this.dto(row);
      }),
    );
  }
  async accept(
    id: string,
    raw: Uint8Array,
    signature: string | null,
    timestamp: string | null,
    now = this.clock(),
  ): Promise<AcceptedNativeSlackHookEvent | undefined> {
    const before = (await this.rows(id))[0];
    if (!before || !enabled(before) || !before.secretRecordId || !before.ciphertext)
      return undefined;
    const signingSecret = await this.secrets.load(before.ciphertext, {
      recordId: before.secretRecordId,
    });
    if (!signingSecret)
      throw new NativeActionError("not_configured", "The Slack signing secret is unavailable.");
    const parsed = verifySlackEnvelope(
      raw,
      signature,
      timestamp,
      signingSecret,
      verified(before),
      now,
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM native_app_configs WHERE id=${before.configId} FOR UPDATE`,
      );
      const row = (
        await tx.$queryRaw<HookRow[]>(Prisma.sql`${join()} WHERE h.id=${id} FOR UPDATE OF h`)
      )[0];
      if (
        !row ||
        !enabled(row) ||
        row.revision !== before.revision ||
        row.secretRecordId !== before.secretRecordId
      )
        return undefined;
      if (parsed.kind === "ignored") return parsed;
      await tx.$executeRaw(
        Prisma.sql`UPDATE native_slack_hooks SET "lastVerifiedAt"=${now} WHERE id=${id} AND revision=${row.revision}`,
      );
      if (parsed.kind === "challenge") return parsed;
      const signal = parsed.signal,
        inboxId = randomUUID();
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO native_slack_event_inbox(id,"hookId","hookRevision","configRevision","eventId",signal,"receivedAt") VALUES(${inboxId},${id},${row.revision},${row.configRevision},${signal.eventId},${JSON.stringify(signal)}::jsonb,${now}) ON CONFLICT("hookId","eventId") DO NOTHING`,
      );
      const stored = (
        await tx.$queryRaw<InboxRow[]>(
          Prisma.sql`SELECT * FROM native_slack_event_inbox WHERE "hookId"=${id} AND "eventId"=${signal.eventId}`,
        )
      )[0];
      if (
        !stored ||
        stored.hookRevision !== row.revision ||
        stored.configRevision !== row.configRevision
      )
        return { kind: "ignored" };
      if (stableJsonValue(stored.signal) !== stableJsonValue(signal))
        throw new InvalidNativeSlackSignal();
      return {
        kind: "event",
        inboxId: stored.id,
        hook: { ...verified(row), verified: true },
        signal,
        alreadyDispatched: Boolean(stored.dispatchedAt),
      };
    });
  }
  async load(id: string, revision?: number): Promise<SlackVerifiedHook | undefined> {
    const row = (await this.rows(id))[0];
    return row &&
      enabled(row) &&
      row.lastVerifiedAt &&
      (revision === undefined || row.revision === revision)
      ? verified(row)
      : undefined;
  }
  async loadInbox(
    inboxId: string,
    hookId: string,
    hookRevision: number,
  ): Promise<{ hook: SlackVerifiedHook; signal: NativeSlackEventSignal } | undefined> {
    const hook = await this.load(hookId, hookRevision);
    if (!hook) return undefined;
    const row = (
      await this.prisma.$queryRaw<InboxRow[]>(
        Prisma.sql`SELECT * FROM native_slack_event_inbox WHERE id=${inboxId} AND "hookId"=${hookId} AND "hookRevision"=${hookRevision} AND "configRevision"=${hook.configRevision}`,
      )
    )[0];
    if (!row) return undefined;
    const parsed = NativeSlackEventSignalSchema.safeParse(row.signal);
    if (
      !parsed.success ||
      parsed.data.appId !== hook.appId ||
      (hook.teamId && parsed.data.teamId !== hook.teamId)
    )
      return undefined;
    return { hook, signal: parsed.data };
  }
  async markDispatched(inboxId: string, hookId: string, hookRevision: number): Promise<boolean> {
    const count = await this.prisma.$executeRaw(
      Prisma.sql`UPDATE native_slack_event_inbox i SET "dispatchedAt"=COALESCE(i."dispatchedAt",${this.clock()}) FROM native_slack_hooks h,native_app_configs a WHERE i.id=${inboxId} AND i."hookId"=${hookId} AND i."hookRevision"=${hookRevision} AND h.id=i."hookId" AND h.revision=i."hookRevision" AND h."configRevision"=i."configRevision" AND h.enabled=true AND h."lastVerifiedAt" IS NOT NULL AND h."disabledAt" IS NULL AND a.id=h."configId" AND a.enabled=true AND a.revision=h."configRevision"`,
    );
    return count === 1;
  }
  async pending(
    limit = 100,
  ): Promise<Array<{ inboxId: string; hookId: string; hookRevision: number }>> {
    const size = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.prisma.$queryRaw<Array<{ inboxId: string; hookId: string; hookRevision: number }>>(
      Prisma.sql`SELECT i.id AS "inboxId",i."hookId",i."hookRevision" FROM native_slack_event_inbox i JOIN native_slack_hooks h ON h.id=i."hookId" JOIN native_app_configs a ON a.id=h."configId" WHERE i."dispatchedAt" IS NULL AND h.enabled=true AND h."disabledAt" IS NULL AND h."lastVerifiedAt" IS NOT NULL AND h.revision=i."hookRevision" AND h."configRevision"=i."configRevision" AND a.enabled=true AND a.revision=h."configRevision" ORDER BY i."receivedAt",i.id LIMIT ${size}`,
    );
  }
}
