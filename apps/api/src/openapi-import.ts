import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  OpenApiCompileError,
  persistPreparedSecret,
  prepareOpenApiInstall,
} from "@rakazo/adapters";
import type {
  Actor,
  CapabilityInstall,
  OpenApiImportConfirmation,
  OpenApiImportConfirmInput,
  OpenApiImportDiagnostic,
  OpenApiImportInput,
  OpenApiImportPreview,
} from "@rakazo/contracts";
import { containsSecret } from "@rakazo/core";
import type { CapabilityInstall as InstallRow, Prisma } from "@rakazo/db";
import { Prisma as Sql } from "@rakazo/db";
import { z } from "zod";
import type { RouterDeps } from "./router.js";

const POLICY = "openapi-v1";
const REVIEW_MS = 15 * 60_000;
const LEASE_MS = 60_000;
const ClaimsSchema = z
  .object({
    policy: z.literal(POLICY),
    id: z.string().uuid(),
    userId: z.string().min(1).max(200),
    spaceId: z.string().min(1).max(200),
    requestBinding: z.string().regex(/^[a-f0-9]{64}$/),
    planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    privateEndpointsAllowed: z.boolean(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Claims = z.infer<typeof ClaimsSchema>;
type Context = {
  actor: Actor;
  signal?: AbortSignal;
  sessionId?: string;
  stillAuthorized?: () => Promise<boolean>;
};
type Dependencies = Pick<
  RouterDeps,
  "prisma" | "secrets" | "remoteConnectors" | "env" | "openApiNow" | "openApiPreviewKey"
>;
type Receipt = Prisma.OpenApiImportReceiptGetPayload<{ include: { install: true } }>;
type Prepared = Awaited<ReturnType<typeof prepareOpenApiInstall>>;
type Lease = { owner: string; generation: number };
class LostLease extends Error {}
class ChangedReview extends Error {}
class CredentialInPublicPlan extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalize(input: OpenApiImportInput): OpenApiImportInput {
  const config = input.config ?? {};
  if (Object.keys(config).some((key) => !["auth", "headers", "openApi", "openapi"].includes(key)))
    throw new Error("Invalid import configuration");
  if (["openApi", "openapi"].some((key) => config[key] !== undefined && config[key] !== true))
    throw new Error("Invalid import configuration");
  if (config.auth !== undefined) {
    if (!config.auth || typeof config.auth !== "object" || Array.isArray(config.auth))
      throw new Error("Invalid authentication configuration");
    if (
      Object.entries(config.auth).some(
        ([key, value]) =>
          !["type", "name"].includes(key) || typeof value !== "string" || value.length > 120,
      )
    )
      throw new Error("Invalid authentication configuration");
  }
  if (config.headers !== undefined) {
    if (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers))
      throw new Error("Invalid headers");
    const headers = Object.entries(config.headers);
    if (
      headers.length > 100 ||
      headers.some(
        ([key, value]) => key.length > 120 || typeof value !== "string" || value.length > 2048,
      )
    )
      throw new Error("Invalid headers");
  }
  const normalized = {
    name: input.name.trim(),
    source: input.source.trim(),
    config,
    credential: input.credential?.trim() || undefined,
  };
  if (
    !normalized.name ||
    !normalized.source ||
    Buffer.byteLength(canonical(config), "utf8") > 2_000_000
  )
    throw new Error("Invalid import configuration");
  assertNoCredential(normalized.credential, { source: normalized.source, config });
  return normalized;
}

function assertNoCredential(credential: string | undefined, value: unknown): void {
  if (!credential) return;
  const variants = [
    credential,
    Buffer.from(credential).toString("base64"),
    Buffer.from(credential).toString("base64url"),
  ];
  try {
    variants.push(encodeURIComponent(credential));
  } catch {
    /* The raw value is still checked. */
  }
  if (containsSecret(value, variants))
    throw new CredentialInPublicPlan("Credential is not public configuration");
}

function installView(row: InstallRow): CapabilityInstall {
  return {
    id: row.id,
    kind: row.kind as CapabilityInstall["kind"],
    name: row.name,
    source: row.source,
    version: row.version,
    digest: row.digest,
    secretConfigured: Boolean(row.secretId),
    config: row.config as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

function invalidPreview(code: OpenApiImportDiagnostic["code"]): OpenApiImportPreview {
  return {
    status: "invalid",
    target: null,
    operations: [],
    diagnostics: [{ scope: "document", code }],
    counts: { discovered: 0, accepted: 0, rejected: 0, omittedDiagnostics: 0 },
    reviewToken: null,
    expiresAt: null,
  };
}

function terminal(
  status: "pending" | "stale" | "expired" | "removed" | "invalid",
): OpenApiImportConfirmation {
  return { status, diagnostics: [], ...(status === "pending" ? { retryAfterMs: 0 } : {}) };
}

export function createOpenApiImportService(deps: Dependencies) {
  const key = deps.openApiPreviewKey || randomBytes(32).toString("base64url");
  const now = deps.openApiNow ?? Date.now;
  const mac = (purpose: string, value: string) =>
    createHmac("sha256", key).update(`openapi/${purpose}/v1\0${value}`).digest();
  const binding = (input: OpenApiImportInput) => mac("request", canonical(input)).toString("hex");
  const fingerprint = (input: OpenApiImportInput, prepared: Prepared) =>
    `sha256:${createHash("sha256")
      .update(
        canonical({
          policy: POLICY,
          name: input.name,
          document: input.source,
          source: prepared.source,
          config: prepared.config,
          diagnostics: prepared.diagnostics,
          counts: prepared.counts,
        }),
      )
      .digest("hex")}`;
  function encode(claims: Claims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${mac("review", payload).toString("base64url")}`;
  }
  function decode(token: string, actor: Actor): Claims | null {
    try {
      if (!token || token.length > 4096) return null;
      const parts = token.split(".");
      if (
        parts.length !== 2 ||
        !/^[A-Za-z0-9_-]+$/.test(parts[0]!) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)
      )
        return null;
      const actual = Buffer.from(parts[1]!, "base64url");
      const expected = mac("review", parts[0]!);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const claims = ClaimsSchema.parse(
        JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
      );
      return claims.userId === actor.userId && claims.spaceId === actor.spaceId ? claims : null;
    } catch {
      return null;
    }
  }
  async function sessionAuthorized(context: Context): Promise<void> {
    context.signal?.throwIfAborted();
    if (context.stillAuthorized && !(await context.stillAuthorized()))
      throw new ORPCError("UNAUTHORIZED");
  }
  async function scope(context: Context, tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? deps.prisma;
    const { userId, spaceId } = context.actor;
    if (tx) {
      // Parent-before-child locks also fence concurrent membership/Space/session removal.
      const users = await tx.$queryRaw<Array<{ id: string }>>(
        Sql.sql`SELECT id FROM "user" WHERE id=${userId} FOR SHARE`,
      );
      const spaces = await tx.$queryRaw<Array<{ id: string; deletingAt: Date | null }>>(
        Sql.sql`SELECT id, "deletingAt" FROM spaces WHERE id=${spaceId} FOR SHARE`,
      );
      const members = await tx.$queryRaw<Array<{ id: string }>>(
        Sql.sql`SELECT id FROM space_members WHERE "spaceId"=${spaceId} AND "userId"=${userId} FOR SHARE`,
      );
      if (!users.length || !spaces.length || spaces[0]!.deletingAt || !members.length)
        throw new ORPCError("FORBIDDEN");
      if (context.sessionId) {
        const sessions = await tx.$queryRaw<Array<{ id: string }>>(
          Sql.sql`SELECT id FROM "session" WHERE id=${context.sessionId} AND "userId"=${userId} AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR SHARE`,
        );
        if (!sessions.length) throw new ORPCError("UNAUTHORIZED");
      }
    } else {
      await sessionAuthorized(context);
      const membership = await db.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId } },
        select: { space: { select: { deletingAt: true } } },
      });
      if (!membership || membership.space.deletingAt) throw new ORPCError("FORBIDDEN");
    }
    const settings = tx
      ? (
          await tx.$queryRaw<Array<{ ownerUserId: string | null }>>(
            Sql.sql`SELECT "ownerUserId" FROM deployment_settings WHERE id='default' FOR SHARE`,
          )
        )[0]
      : await db.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { ownerUserId: true },
        });
    return deps.env.mcpAllowPrivateEndpoint === true || settings?.ownerUserId === userId;
  }
  const find = (context: Context, claims: Claims) =>
    deps.prisma.openApiImportReceipt.findFirst({
      where: { id: claims.id, userId: context.actor.userId, spaceId: context.actor.spaceId },
      include: { install: true },
    });
  function matches(row: Receipt, claims: Claims): boolean {
    return row.requestBinding === claims.requestBinding && row.planDigest === claims.planDigest;
  }
  async function outcome(context: Context, claims: Claims): Promise<OpenApiImportConfirmation> {
    await scope(context);
    const row = await find(context, claims);
    if (!row) return terminal(claims.expiresAt <= now() ? "expired" : "pending");
    if (!matches(row, claims)) return terminal("invalid");
    if (row.state === "installed") {
      if (!row.install) return terminal("removed");
      if (
        row.install.spaceId !== context.actor.spaceId ||
        row.install.userId !== context.actor.userId ||
        row.install.digest !== claims.planDigest
      )
        return terminal("stale");
      return { status: "installed", install: installView(row.install), replayed: true };
    }
    if (row.state === "stale" || row.state === "invalid") return terminal(row.state);
    return {
      status: "pending",
      diagnostics: [],
      retryAfterMs: Math.max(
        0,
        Math.min(LEASE_MS, (row.leaseExpiresAt?.getTime() ?? 0) - Date.now()),
      ),
    };
  }
  async function settle(
    context: Context,
    claims: Claims,
    lease: Lease,
    state: "pending" | "stale" | "invalid",
  ) {
    await deps.prisma.openApiImportReceipt.updateMany({
      where: {
        id: claims.id,
        spaceId: context.actor.spaceId,
        userId: context.actor.userId,
        state: "pending",
        generation: lease.generation,
        leaseOwner: lease.owner,
      },
      data: { state, leaseOwner: null, leaseExpiresAt: null },
    });
  }
  async function live(
    context: Context,
    claims: Claims,
    lease: Lease,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const db = tx ?? deps.prisma;
    const rows = await db.$queryRaw<Array<{ id: string }>>(Sql.sql`
      SELECT id FROM openapi_import_receipts
      WHERE id=${claims.id} AND "userId"=${context.actor.userId} AND "spaceId"=${context.actor.spaceId}
        AND state='pending' AND generation=${lease.generation} AND "leaseOwner"=${lease.owner}
        AND "leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC') ${tx ? Sql.sql`FOR UPDATE` : Sql.empty}
    `);
    return rows.length === 1;
  }
  async function claim(context: Context, claims: Claims): Promise<Lease | null> {
    const owner = randomUUID();
    return deps.prisma.$transaction(async (tx) => {
      if ((await scope(context, tx)) !== claims.privateEndpointsAllowed) throw new ChangedReview();
      const existing = await tx.openApiImportReceipt.findFirst({
        where: { id: claims.id, userId: context.actor.userId, spaceId: context.actor.spaceId },
      });
      if (!existing) {
        if (claims.expiresAt <= now()) return null;
        // Expiration is checked by the actual insert as well as before acquiring a connection.
        const rows = await tx.$queryRaw<Array<{ generation: number }>>(Sql.sql`
          INSERT INTO openapi_import_receipts
            (id,"spaceId","userId","requestBinding","planDigest",state,generation,"leaseOwner","leaseExpiresAt","reviewExpiresAt","createdAt","updatedAt")
          SELECT ${claims.id},${context.actor.spaceId},${context.actor.userId},${claims.requestBinding},${claims.planDigest},'pending',1,${owner},(clock_timestamp() AT TIME ZONE 'UTC')+interval '60 seconds',${new Date(claims.expiresAt)},(clock_timestamp() AT TIME ZONE 'UTC'),(clock_timestamp() AT TIME ZONE 'UTC')
          WHERE ${new Date(claims.expiresAt)}::timestamp>(clock_timestamp() AT TIME ZONE 'UTC')
          ON CONFLICT DO NOTHING RETURNING generation
        `);
        return rows[0] ? { owner, generation: rows[0].generation } : null;
      }
      if (
        existing.state !== "pending" ||
        existing.requestBinding !== claims.requestBinding ||
        existing.planDigest !== claims.planDigest
      )
        return null;
      const rows = await tx.$queryRaw<Array<{ generation: number }>>(Sql.sql`
        UPDATE openapi_import_receipts SET generation=generation+1,"leaseOwner"=${owner},
          "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '60 seconds',"updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
        WHERE id=${claims.id} AND "userId"=${context.actor.userId} AND "spaceId"=${context.actor.spaceId}
          AND state='pending' AND generation=${existing.generation}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC'))
        RETURNING generation
      `);
      return rows[0] ? { owner, generation: rows[0].generation } : null;
    });
  }
  async function prepare(
    context: Context,
    input: OpenApiImportInput,
    allowPrivateEndpoint: boolean,
  ): Promise<Prepared> {
    return prepareOpenApiInstall({
      source: input.source,
      config: input.config,
      credential: input.credential,
      signal: context.signal,
      remote: deps.remoteConnectors,
      allowPrivateEndpoint,
    });
  }
  return {
    async preview(context: Context, raw: OpenApiImportInput): Promise<OpenApiImportPreview> {
      const privateEndpointsAllowed = await scope(context);
      try {
        const input = normalize(raw);
        const prepared = await prepare(context, input, privateEndpointsAllowed);
        if ((await scope(context)) !== privateEndpointsAllowed)
          return invalidPreview("invalid_review");
        assertNoCredential(input.credential, prepared);
        const common = {
          target: prepared.source,
          operations: prepared.config.operations.map((operation) => ({
            id: operation.id,
            method: operation.method,
            path: operation.path,
            readOnly: operation.readOnly,
          })),
          diagnostics: prepared.diagnostics,
          counts: prepared.counts,
        };
        if (!prepared.operationCount)
          return { ...common, status: "invalid", reviewToken: null, expiresAt: null };
        const expiresAt = now() + REVIEW_MS;
        const claims: Claims = {
          policy: POLICY,
          id: randomUUID(),
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          requestBinding: binding(input),
          planDigest: fingerprint(input, prepared),
          privateEndpointsAllowed,
          expiresAt,
        };
        return {
          ...common,
          status: "ready",
          reviewToken: encode(claims),
          expiresAt: new Date(expiresAt).toISOString(),
        };
      } catch (error) {
        if (error instanceof ORPCError) throw error;
        return invalidPreview(
          error instanceof OpenApiCompileError ? error.code : "invalid_document",
        );
      }
    },
    async receipt(context: Context, token: string): Promise<OpenApiImportConfirmation> {
      const claims = decode(token, context.actor);
      if (!claims) return terminal("invalid");
      return outcome(context, claims);
    },
    async confirm(
      context: Context,
      raw: OpenApiImportConfirmInput,
    ): Promise<OpenApiImportConfirmation> {
      const claims = decode(raw.reviewToken, context.actor);
      if (!claims) return terminal("invalid");
      let input: OpenApiImportInput;
      try {
        input = normalize(raw);
      } catch {
        return terminal("invalid");
      }
      if (binding(input) !== claims.requestBinding) return terminal("stale");
      await scope(context);
      const existing = await find(context, claims);
      if (existing && (existing.state !== "pending" || !matches(existing, claims)))
        return outcome(context, claims);
      if (!existing && claims.expiresAt <= now()) return terminal("expired");
      let lease: Lease | null;
      try {
        lease = await claim(context, claims);
      } catch (error) {
        if (error instanceof ChangedReview) return terminal("stale");
        throw error;
      }
      if (!lease) return outcome(context, claims);
      try {
        const allowed = await scope(context);
        if (allowed !== claims.privateEndpointsAllowed) throw new ChangedReview();
        if (!(await live(context, claims, lease))) return outcome(context, claims);
        const prepared = await prepare(context, input, allowed);
        assertNoCredential(input.credential, prepared);
        if (!prepared.operationCount || fingerprint(input, prepared) !== claims.planDigest)
          throw new ChangedReview();
        if ((await scope(context)) !== claims.privateEndpointsAllowed) throw new ChangedReview();
        if (!(await live(context, claims, lease))) return outcome(context, claims);
        const written = input.credential
          ? await deps.secrets.put(input.credential, {
              operationId: "capabilities.confirmOpenApi",
              traceId: claims.id,
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        return await persistPreparedSecret(deps.prisma, deps.secrets, written, async () => {
          await sessionAuthorized(context);
          const row = await deps.prisma.$transaction(async (tx) => {
            if ((await scope(context, tx)) !== claims.privateEndpointsAllowed)
              throw new ChangedReview();
            if (!(await live(context, claims, lease!, tx))) throw new LostLease();
            context.signal?.throwIfAborted();
            if (written)
              await tx.secret.create({
                data: {
                  id: written.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  kind: "connector",
                  ciphertext: written.ciphertext,
                },
              });
            const install = await tx.capabilityInstall.create({
              data: {
                id: claims.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "api",
                name: input.name,
                source: prepared.source,
                config: prepared.config as Prisma.InputJsonValue,
                digest: claims.planDigest,
                secretId: written?.id,
                version: "1.0.0",
              },
            });
            const settled = await tx.openApiImportReceipt.updateMany({
              where: {
                id: claims.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                state: "pending",
                generation: lease!.generation,
                leaseOwner: lease!.owner,
              },
              data: {
                state: "installed",
                installId: install.id,
                leaseOwner: null,
                leaseExpiresAt: null,
              },
            });
            if (settled.count !== 1) throw new LostLease();
            return install;
          });
          return { status: "installed", install: installView(row), replayed: false } as const;
        });
      } catch (error) {
        const invalid = error instanceof CredentialInPublicPlan;
        const changed =
          error instanceof ChangedReview ||
          (error instanceof OpenApiCompileError && error.code !== "fetch_failed");
        try {
          await settle(context, claims, lease, invalid ? "invalid" : changed ? "stale" : "pending");
        } catch {
          /* A disconnected database leaves the bounded lease recoverable. */
        }
        const current = await outcome(context, claims);
        if (changed || error instanceof LostLease || current.status !== "pending") return current;
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }
    },
  };
}
