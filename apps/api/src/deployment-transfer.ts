import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type {
  DeploymentTransferPeer,
  SignedTransfer,
  TransferCancel,
  TransferItem,
  TransferPeerIdentity,
  TransferPlan,
  TransferPlanItem,
  TransferProposal,
  TransferReceipt,
  TransferSelection,
  TransferStatusQuery,
} from "@rakazo/adapters";
import {
  adoptPreparedBotSecret,
  BotSecretConflictError,
  DEPLOYMENT_TRANSFER_PROTOCOL,
  deploymentTransferDigest,
  deploymentTransferFingerprint,
  normalizeSecretDestination,
  persistPreparedSecret,
  reconcileSecretWrite,
  SignedTransferCancelSchema,
  SignedTransferChallengeSchema,
  SignedTransferItemSchema,
  SignedTransferProposalSchema,
  SignedTransferReceiptSchema,
  SignedTransferStatusQuerySchema,
  sameSecretDestination,
  signDeploymentTransferMessage,
  TransferGrantDeliverySchema,
  TransferPeerIdentitySchema,
  TransferPlanSchema,
  TransferResourceIdentitySchema,
  validateTransferBotSecret,
  verifyDeploymentTransferMessage,
} from "@rakazo/adapters";
import type {
  DeploymentTransferApproveInput,
  DeploymentTransferCancelInput,
  DeploymentTransferCommitInput,
  DeploymentTransferPreviewInput,
  DeploymentTransferProposeInput,
  DeploymentTransferReason,
  DeploymentTransferScope,
  DeploymentTransferStartInput,
  DeploymentTransferStatus,
  DeploymentTransferStatusInput,
} from "@rakazo/contracts";
import {
  DEPLOYMENT_TRANSFER_TTL_MS,
  DeploymentTransferCandidateSchema,
  DeploymentTransferOmissionSchema,
  DeploymentTransferPhaseSchema,
  DeploymentTransferReasonSchema,
  DeploymentTransferReceiptItemSchema,
  DeploymentTransferStatusSchema,
  normalizeDeploymentTransferOrigin,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { Prisma as Sql } from "@rakazo/db";
import * as z from "zod";
import { cleanupCancelledTransfer } from "./deployment-transfer-cleanup.js";
import type { TransferContext, TransferItemRow, TransferRow } from "./deployment-transfer-store.js";
import {
  assertTransferWrite,
  createTransferStore,
  jsonValue,
  localTransferScope,
  lockTransferRow,
  lockTransferScope,
  transferConflict,
  transferHash,
  transferItems,
  transferNonce,
  transferTokenMatches,
  transferUnavailable,
  transferUser,
} from "./deployment-transfer-store.js";

const protocol = DEPLOYMENT_TRANSFER_PROTOCOL;
const draftSchema = z
  .object({
    challenge: SignedTransferChallengeSchema,
    protectedSourceResources: z.array(TransferResourceIdentitySchema).max(100),
    leftOut: z.array(DeploymentTransferOmissionSchema).max(100),
    sourceBotName: z.string().max(120),
    sourceOwnerName: z.string().max(200),
    sourceSpaceName: z.string().max(200),
  })
  .strict();
type Deps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  origin: string;
  peer: DeploymentTransferPeer;
  now?: () => number;
};
const terminal = new Set(["completed", "partial", "failed", "cancelled", "expired"]);
const blockedAdoptionReasons = new Set([
  "target_changed",
  "destination_conflict",
  "credential_limit",
  "source_resource_shared",
  "resource_unknown",
]);
const publicIdentity = (value: TransferPeerIdentity) => ({
  deploymentId: value.deploymentId,
  origin: value.origin,
  fingerprint: value.fingerprint,
});
const same = (left: unknown, right: unknown) =>
  deploymentTransferDigest("binding", left) === deploymentTransferDigest("binding", right);
const expectedRevision = (row: TransferRow, revision: number) => {
  if (row.revision !== revision) throw transferConflict();
};
class TargetAdmissionConflict extends Error {
  constructor(readonly reason: DeploymentTransferReason) {
    super("The approved target changed.");
  }
}

async function sanitized<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof TargetAdmissionConflict) throw transferConflict();
    throw transferUnavailable();
  }
}

/** Independent one-time credential copying. Ordinary JSON packages never enter this service. */
export function createDeploymentTransferService(deps: Deps) {
  const store = createTransferStore(deps);
  const now = deps.now ?? Date.now;
  const identity = async () => {
    const material = await store.identity();
    return {
      material,
      peer: TransferPeerIdentitySchema.parse({
        origin: material.origin,
        deploymentId: material.deploymentId,
        publicKey: material.publicKey,
        fingerprint: material.fingerprint,
      }),
    };
  };
  const scopeOf = (context: TransferContext, botId: string) => store.currentScope(context, botId);
  const reload = (id: string) =>
    deps.prisma.deploymentTransferSession.findUniqueOrThrow({
      where: { id },
      include: transferItems,
    });
  function peerIdentity(value: unknown, origin: string): TransferPeerIdentity {
    const peer = TransferPeerIdentitySchema.parse(value);
    if (
      peer.origin !== origin ||
      deploymentTransferFingerprint(peer.publicKey) !== peer.fingerprint
    )
      throw transferUnavailable();
    return peer;
  }
  function distinct(source: TransferPeerIdentity, target: TransferPeerIdentity) {
    if (
      source.origin === target.origin ||
      source.deploymentId === target.deploymentId ||
      source.fingerprint === target.fingerprint
    )
      throw transferUnavailable();
  }
  function targetIdentity(row: TransferRow): TransferPeerIdentity {
    return peerIdentity(
      {
        deploymentId: row.targetDeploymentId,
        origin: row.targetOrigin,
        publicKey: row.targetPublicKey,
        fingerprint: row.targetFingerprint,
      },
      row.targetOrigin,
    );
  }
  function sourceIdentity(row: TransferRow): TransferPeerIdentity {
    return peerIdentity(
      {
        deploymentId: row.sourceDeploymentId,
        origin: row.sourceOrigin,
        publicKey: row.sourcePublicKey,
        fingerprint: row.sourceFingerprint,
      },
      row.sourceOrigin,
    );
  }
  function proposal(row: TransferRow): SignedTransfer<TransferProposal> {
    return SignedTransferProposalSchema.parse(row.proposalJson);
  }
  function plan(row: TransferRow): TransferPlan {
    const result = TransferPlanSchema.parse(row.planJson);
    if (deploymentTransferDigest("plan", result) !== row.planDigest) throw transferUnavailable();
    return result;
  }
  function binding(value: {
    transferId: string;
    sourceOrigin: string;
    target: TransferPeerIdentity;
    targetScope: DeploymentTransferScope;
    targetNonce: string;
    expiresAt: string;
  }) {
    return deploymentTransferDigest("binding", value);
  }
  function sign<T>(
    key: string,
    operation: "challenge" | "proposal" | "grant" | "item" | "status" | "cancel" | "receipt",
    payload: T,
  ) {
    return { payload, signature: signDeploymentTransferMessage(key, operation, payload) };
  }
  function verify<T>(
    key: string,
    operation: "challenge" | "proposal" | "grant" | "item" | "status" | "cancel" | "receipt",
    value: SignedTransfer<T>,
  ) {
    if (!verifyDeploymentTransferMessage(key, operation, value.payload, value.signature))
      throw transferUnavailable();
  }
  function credentialKind(auth: unknown): "password" | "api_key" {
    return auth && typeof auth === "object" && "type" in auth && auth.type === "login"
      ? "password"
      : "api_key";
  }
  function candidate(row: TransferItemRow) {
    return DeploymentTransferCandidateSchema.parse({
      itemKey: row.itemKey,
      revision: row.sourceRevision,
      kind: credentialKind(row.auth),
      name: row.targetName,
      origin: row.origin,
      auth: row.auth,
    });
  }
  function publicCandidate(value: TransferSelection) {
    return DeploymentTransferCandidateSchema.parse({
      itemKey: value.itemKey,
      revision: value.revision,
      kind: value.kind,
      name: value.name,
      origin: value.origin,
      auth: value.auth,
    });
  }
  async function sourceRows(
    scope: DeploymentTransferScope,
    client: PrismaClient | Prisma.TransactionClient = deps.prisma,
  ) {
    const rows = await client.botSecret.findMany({
      where: scope,
      orderBy: { id: "asc" },
      take: 101,
    });
    if (rows.length > 100) throw transferUnavailable();
    return rows;
  }
  function resource(ref: string, recordId: string) {
    try {
      return TransferResourceIdentitySchema.parse(
        deps.secrets.resourceIdentity?.(ref, { recordId }) ?? { kind: "unknown" },
      );
    } catch {
      return { kind: "unknown" } as const;
    }
  }
  function resources(rows: Awaited<ReturnType<typeof sourceRows>>) {
    return rows.map((row) => resource(row.ciphertext, row.id));
  }
  async function names(scope: DeploymentTransferScope) {
    const [user, space, bot] = await Promise.all([
      deps.prisma.user.findUniqueOrThrow({ where: { id: scope.userId }, select: { name: true } }),
      deps.prisma.space.findUniqueOrThrow({ where: { id: scope.spaceId }, select: { name: true } }),
      deps.prisma.bot.findUniqueOrThrow({ where: { id: scope.botId }, select: { name: true } }),
    ]);
    return {
      owner: user.name.slice(0, 200),
      space: space.name.slice(0, 200),
      bot: bot.name.slice(0, 120),
    };
  }
  function publicItem(item: TransferItemRow, row: TransferRow) {
    const prior = DeploymentTransferReceiptItemSchema.safeParse(item.receiptJson);
    const known = DeploymentTransferReasonSchema.safeParse(
      item.status !== "accepted" && row.writeRevokedReason === "restore"
        ? "restore"
        : item.reasonCode,
    );
    return {
      itemKey: item.itemKey,
      name: item.targetName,
      kind: credentialKind(item.auth),
      status:
        item.status === "accepted"
          ? ("copied" as const)
          : item.writeState === "claimed" || item.writeState === "stored"
            ? ("unknown" as const)
            : (item.status as DeploymentTransferStatus["items"][number]["status"]),
      revision: item.revision,
      ...(known.success ? { reason: known.data } : {}),
      ...(item.status === "accepted" && prior.success && prior.data.targetState
        ? { targetState: prior.data.targetState }
        : {}),
      canRecover:
        !row.writeRevokedAt &&
        !row.cancelRequestedAt &&
        !terminal.has(row.status) &&
        row.expiresAt.getTime() > now() &&
        (item.writeState === "claimed" || item.writeState === "stored") &&
        !blockedAdoptionReasons.has(item.reasonCode ?? "") &&
        item.cleanupState === "none",
    };
  }
  function withoutTargetObservation(row: TransferRow): TransferRow {
    return {
      ...row,
      items: row.items.map((item) =>
        item.status === "accepted" ? { ...item, receiptJson: null } : item,
      ),
    };
  }
  async function observeAccepted(row: TransferRow) {
    if (row.side !== "target" || !row.items.some((item) => item.status === "accepted")) return row;
    return deps.prisma.$transaction(async (tx) => {
      const current = await lockTransferRow(tx, row.id);
      const accepted = current.items.filter(
        (item) => item.status === "accepted" && item.targetSecretId,
      );
      const found = await tx.botSecret.findMany({
        where: {
          ...localTransferScope(current),
          id: { in: accepted.map((item) => item.targetSecretId!) },
        },
        select: { id: true, revision: true },
      });
      let changed = false;
      for (const item of accepted) {
        const present = found.find((secret) => secret.id === item.targetSecretId);
        const targetState = !present
          ? "removed"
          : present.revision === item.acceptedRevision
            ? "unchanged"
            : "modified";
        const prior = DeploymentTransferReceiptItemSchema.safeParse(item.receiptJson);
        if (prior.success && prior.data.targetState === targetState) continue;
        await tx.deploymentTransferItem.update({
          where: { id: item.id },
          data: {
            receiptJson: jsonValue({
              ...publicItem(item, current),
              targetState,
              revision: item.revision + 1,
            }),
            revision: { increment: 1 },
          },
        });
        changed = true;
      }
      return changed
        ? tx.deploymentTransferSession.update({
            where: { id: row.id },
            data: { revision: { increment: 1 } },
            include: transferItems,
          })
        : current;
    });
  }
  function projection(row: TransferRow): DeploymentTransferStatus {
    const document = row.planJson ? plan(row) : null;
    const signedProposal = SignedTransferProposalSchema.safeParse(row.proposalJson);
    const draft = draftSchema.safeParse(row.proposalJson);
    const expiry =
      row.side === "source"
        ? Math.min(row.expiresAt.getTime(), row.createdAt.getTime() + DEPLOYMENT_TRANSFER_TTL_MS)
        : row.expiresAt.getTime();
    const active = expiry > now() && !row.cancelRequestedAt && !row.writeRevokedAt;
    const p = document
      ? {
          sourceScope: document.sourceScope,
          targetScope: document.targetScope,
          sourceBotName: document.sourceBotName,
          targetBotName: document.targetBotName,
          sourceOwnerName: document.sourceOwnerName,
          sourceSpaceName: document.sourceSpaceName,
          targetOwnerName: document.targetOwnerName,
          targetSpaceName: document.targetSpaceName,
          items: document.items.map((item) => ({
            source: publicCandidate(item.source),
            action: item.action,
            targetRevision:
              item.expectedTarget.kind === "present" ? item.expectedTarget.revision : null,
            canOverwrite: item.canOverwrite,
            ...(item.reason ? { reason: item.reason } : {}),
          })),
        }
      : null;
    const phase =
      row.writeRevokedReason === "restore" || (!active && !terminal.has(row.status))
        ? "expired"
        : row.status;
    return DeploymentTransferStatusSchema.parse({
      transferId: row.id,
      side: row.side,
      phase,
      revision: row.revision,
      expiresAt: new Date(expiry).toISOString(),
      localScope: localTransferScope(row),
      source: row.sourcePublicKey ? publicIdentity(sourceIdentity(row)) : null,
      target: publicIdentity(targetIdentity(row)),
      candidates: row.side === "source" ? row.items.map(candidate) : [],
      plan: p,
      proposalDigest: row.proposalDigest,
      planDigest: row.planDigest,
      commitNonce: row.acceptedNonce,
      items: row.items
        .filter((item) => item.decision !== "skip")
        .map((item) => publicItem(item, row)),
      leftOut: signedProposal.success
        ? signedProposal.data.payload.leftOut
        : draft.success
          ? draft.data.leftOut
          : [],
      grantDelivery: row.grantDelivery,
      canApprove:
        row.side === "target" && active && !terminal.has(row.status) && Boolean(row.planDigest),
      canCommit:
        row.side === "source" &&
        active &&
        !terminal.has(row.status) &&
        Boolean(row.planDigest) &&
        row.grantDelivery === "stored" &&
        row.items.some(
          (item) =>
            item.decision !== "skip" &&
            !["accepted", "kept", "conflict", "failed", "cancelled", "expired", "skipped"].includes(
              item.status,
            ) &&
            !blockedAdoptionReasons.has(item.reasonCode ?? ""),
        ),
      canRecover: active && row.items.some((item) => publicItem(item, row).canRecover),
      ...(row.writeRevokedReason === "restore" ? { writeRevokedReason: "restore" } : {}),
      ...(row.side === "target"
        ? {
            sourcePageUrl: `${row.sourceOrigin}/transfers/source?${new URLSearchParams({ targetOrigin: row.targetOrigin, locator: row.id })}`,
          }
        : {}),
    });
  }
  async function createOnce(
    context: TransferContext,
    scope: DeploymentTransferScope,
    side: "source" | "target",
    nonce: string,
    requestBinding: string,
    create: Prisma.DeploymentTransferSessionCreateInput,
  ) {
    const authorizationBinding = await store.binding(scope, requestBinding);
    const prior = await deps.prisma.deploymentTransferSession.findUnique({
      where: {
        localUserId_side_clientNonce: { localUserId: scope.userId, side, clientNonce: nonce },
      },
      include: transferItems,
    });
    if (prior) {
      if (prior.requestBinding !== authorizationBinding) throw transferConflict();
      return store.owned(context, prior.id);
    }
    try {
      return await deps.prisma.$transaction(async (tx) => {
        await lockTransferScope(tx, scope, transferUser(context).sessionId, true);
        if ((await store.binding(scope, requestBinding, tx)) !== authorizationBinding)
          throw transferConflict();
        return tx.deploymentTransferSession.create({
          data: { ...create, requestBinding: authorizationBinding },
          include: transferItems,
        });
      });
    } catch {
      const winner = await deps.prisma.deploymentTransferSession.findUnique({
        where: {
          localUserId_side_clientNonce: { localUserId: scope.userId, side, clientNonce: nonce },
        },
        include: transferItems,
      });
      if (winner && winner.requestBinding === authorizationBinding)
        return store.owned(context, winner.id);
      throw transferConflict();
    }
  }

  async function start(context: TransferContext, input: DeploymentTransferStartInput) {
    const scope = await scopeOf(context, input.targetBotId);
    const local = await identity();
    const sourceOrigin = normalizeDeploymentTransferOrigin(input.sourceOrigin);
    if (sourceOrigin === local.peer.origin) throw transferUnavailable();
    const id = transferNonce();
    const expiresAt = new Date(now() + DEPLOYMENT_TRANSFER_TTL_MS);
    const targetNonce = transferNonce();
    const requestBinding = deploymentTransferDigest("binding", {
      scope,
      sourceOrigin,
      targetOrigin: local.peer.origin,
    });
    const row = await createOnce(context, scope, "target", input.clientNonce, requestBinding, {
      id,
      side: "target",
      targetTransferId: id,
      localUserId: scope.userId,
      localSpaceId: scope.spaceId,
      localBotId: scope.botId,
      localSessionId: transferUser(context).sessionId,
      sourceOrigin,
      targetOrigin: local.peer.origin,
      targetDeploymentId: local.peer.deploymentId,
      targetPublicKey: local.peer.publicKey,
      targetFingerprint: local.peer.fingerprint,
      localNonce: targetNonce,
      targetBindingDigest: binding({
        transferId: id,
        sourceOrigin,
        target: local.peer,
        targetScope: scope,
        targetNonce,
        expiresAt: expiresAt.toISOString(),
      }),
      clientNonce: input.clientNonce,
      requestBinding,
      expiresAt,
      status: "created",
    });
    return projection(row);
  }

  async function previewSource(
    context: TransferContext,
    input: Extract<DeploymentTransferPreviewInput, { mode: "source" }>,
  ) {
    const scope = await scopeOf(context, input.sourceBotId);
    const local = await identity();
    const targetOrigin = normalizeDeploymentTransferOrigin(input.targetOrigin);
    const challenge = SignedTransferChallengeSchema.parse(
      await deps.peer.challenge(targetOrigin, input.locator, context.signal),
    );
    const target = peerIdentity(challenge.payload.target, targetOrigin);
    verify(target.publicKey, "challenge", challenge);
    distinct(local.peer, target);
    if (
      challenge.payload.transferId !== input.locator ||
      challenge.payload.locatorHash !== transferHash(input.locator) ||
      challenge.payload.sourceOrigin !== local.peer.origin ||
      Date.parse(challenge.payload.expiresAt) <= now() ||
      Date.parse(challenge.payload.expiresAt) > now() + DEPLOYMENT_TRANSFER_TTL_MS + 30_000
    )
      throw transferUnavailable();
    const rows = await sourceRows(scope);
    const labels = await names(scope);
    const selected: Array<{
      row: (typeof rows)[number];
      destination: ReturnType<typeof normalizeSecretDestination>;
      itemKey: string;
    }> = [];
    const leftOut: Array<{ name: string; reason: DeploymentTransferReason }> = [];
    for (const row of rows) {
      try {
        const destination = normalizeSecretDestination(row);
        if (destination.auth.type === "command") throw new Error();
        selected.push({ row, destination, itemKey: randomUUID() });
      } catch {
        leftOut.push({ name: row.name.slice(0, 256), reason: "unsupported_kind" });
      }
    }
    const requestBinding = deploymentTransferDigest("binding", {
      scope,
      targetOrigin,
      locator: input.locator,
    });
    const row = await createOnce(context, scope, "source", input.clientNonce, requestBinding, {
      id: transferNonce(),
      side: "source",
      targetTransferId: input.locator,
      localUserId: scope.userId,
      localSpaceId: scope.spaceId,
      localBotId: scope.botId,
      localSessionId: transferUser(context).sessionId,
      sourceOrigin: local.peer.origin,
      sourceDeploymentId: local.peer.deploymentId,
      sourcePublicKey: local.peer.publicKey,
      sourceFingerprint: local.peer.fingerprint,
      targetOrigin,
      targetDeploymentId: target.deploymentId,
      targetPublicKey: target.publicKey,
      targetFingerprint: target.fingerprint,
      localNonce: transferNonce(),
      peerNonce: challenge.payload.targetNonce,
      targetBindingDigest: challenge.payload.targetBindingDigest,
      clientNonce: input.clientNonce,
      requestBinding,
      expiresAt: new Date(challenge.payload.expiresAt),
      status: "draft",
      proposalJson: jsonValue({
        challenge,
        protectedSourceResources: resources(rows),
        leftOut,
        sourceBotName: labels.bot,
        sourceOwnerName: labels.owner,
        sourceSpaceName: labels.space,
      }),
      items: {
        create: selected.map(({ row, destination, itemKey }) => ({
          id: randomUUID(),
          itemKey,
          sourceBotId: scope.botId,
          sourceSecretId: row.id,
          sourceRevision: row.revision,
          targetName: destination.name,
          origin: destination.origin,
          auth: jsonValue(destination.auth),
          decision: "skip",
          status: "pending",
        })),
      },
    });
    return projection(row);
  }

  async function propose(context: TransferContext, input: DeploymentTransferProposeInput) {
    const prior = await store.owned(context, input.transferId);
    if (prior.side !== "source") throw transferConflict();
    const local = await identity();
    const keys = [...input.selected].sort((a, b) => a.itemKey.localeCompare(b.itemKey));
    if (new Set(keys.map((item) => item.itemKey)).size !== keys.length) throw transferConflict();
    const row = await store.transact(context, prior, true, async (tx, current) => {
      assertTransferWrite(current, now());
      if (current.proposalDigest) {
        if (
          !same(
            proposal(current).payload.selection.map(({ itemKey, revision }) => ({
              itemKey,
              revision,
            })),
            keys,
          )
        )
          throw transferConflict();
        return current;
      }
      expectedRevision(current, input.expectedRevision);
      const draft = draftSchema.parse(current.proposalJson);
      const currentRows = await sourceRows(localTransferScope(current), tx);
      if (!same(resources(currentRows), draft.protectedSourceResources)) throw transferConflict();
      const selection: TransferSelection[] = [];
      for (const key of keys) {
        const item = current.items.find(
          (item) => item.itemKey === key.itemKey && item.sourceRevision === key.revision,
        );
        const secret =
          item &&
          currentRows.find(
            (secret) =>
              secret.id === item.sourceSecretId && secret.revision === item.sourceRevision,
          );
        if (
          !item ||
          !secret ||
          !sameSecretDestination(
            normalizeSecretDestination(secret),
            normalizeSecretDestination(candidate(item)),
          )
        )
          throw transferConflict();
        selection.push({ ...candidate(item), sourceSecretId: item.sourceSecretId });
      }
      const body: TransferProposal = {
        protocol,
        kind: "proposal",
        challenge: draft.challenge,
        source: local.peer,
        sourceScope: localTransferScope(current),
        sourceBotName: draft.sourceBotName,
        sourceOwnerName: draft.sourceOwnerName,
        sourceSpaceName: draft.sourceSpaceName,
        sourceNonce: current.localNonce,
        proposalRevision: current.revision,
        selection,
        protectedSourceResources: draft.protectedSourceResources,
        leftOut: draft.leftOut,
      };
      const message = sign(local.material.privateKey, "proposal", body);
      const digest = deploymentTransferDigest("proposal", body);
      await tx.deploymentTransferItem.updateMany({
        where: { sessionId: current.id },
        data: { status: "skipped" },
      });
      await tx.deploymentTransferItem.updateMany({
        where: { sessionId: current.id, itemKey: { in: keys.map((key) => key.itemKey) } },
        data: { decision: "create", status: "pending" },
      });
      return tx.deploymentTransferSession.update({
        where: { id: current.id },
        data: {
          proposalJson: jsonValue(message),
          proposalDigest: digest,
          status: "proposed",
          localSessionId: transferUser(context).sessionId,
          revision: { increment: 1 },
        },
        include: transferItems,
      });
    });
    try {
      const ack = SignedTransferReceiptSchema.parse(
        await deps.peer.propose(row.targetOrigin, proposal(row), context.signal),
      );
      verify(targetIdentity(row).publicKey, "receipt", ack);
      if (
        ack.payload.proposalDigest !== row.proposalDigest ||
        ack.payload.transferId !== row.targetTransferId ||
        ack.payload.requestNonce !== row.localNonce
      )
        throw transferUnavailable();
    } catch {
      // The proposal may be durable remotely; retain and resend only this exact signed intent.
    }
    return projection(await reload(row.id));
  }

  function storedContext(row: TransferRow, signal?: AbortSignal): TransferContext {
    return {
      actor: null,
      sessionAuthenticated: true,
      sessionId: row.localSessionId,
      sessionUserId: row.localUserId,
      signal,
    };
  }
  async function receipt(row: TransferRow, requestNonce: string, observe = false) {
    row = await observeAccepted(row);
    if (row.side === "source") row = withoutTargetObservation(row);
    const local = await identity();
    const recovery: TransferReceipt["recovery"] = [];
    if (observe && row.side === "target")
      for (const item of row.items) {
        if (item.status === "accepted" || !item.recoveryRef || !item.secretRecordId) continue;
        let state: "found" | "absent" | "unknown" = item.ciphertext ? "found" : "unknown";
        if (!item.ciphertext)
          try {
            state = (
              await reconcileSecretWrite(deps.secrets, item.recoveryRef, {
                recordId: item.secretRecordId,
              })
            ).state;
          } catch {
            /* Observations never mutate, adopt or remove an uncertain write. */
          }
        recovery.push({
          itemKey: item.itemKey,
          writeFence: item.writeFence,
          state,
          inline: resource(item.recoveryRef, item.secretRecordId).kind === "inline",
        });
      }
    const body: TransferReceipt = {
      protocol,
      kind: "receipt",
      transferId: row.targetTransferId,
      proposalDigest: row.proposalDigest!,
      planDigest: row.planDigest,
      requestNonce,
      phase: DeploymentTransferPhaseSchema.parse(projection(row).phase),
      revision: row.revision,
      grantStored: row.side === "source" && row.grantDelivery === "stored",
      items: row.items
        .filter((item) => item.decision !== "skip")
        .map((item) => publicItem(item, row)),
      recovery,
    };
    return sign(local.material.privateKey, "receipt", body);
  }
  async function challenge(locator: string) {
    const local = await identity();
    const row = await deps.prisma.deploymentTransferSession.findFirst({
      where: { id: locator, side: "target" },
      include: transferItems,
    });
    if (!row) throw transferUnavailable();
    assertTransferWrite(row, now());
    if (!same(local.peer, targetIdentity(row))) throw transferUnavailable();
    return sign(local.material.privateKey, "challenge", {
      protocol,
      kind: "challenge" as const,
      transferId: row.id,
      locatorHash: transferHash(row.id),
      sourceOrigin: row.sourceOrigin,
      target: local.peer,
      targetNonce: row.localNonce,
      targetBindingDigest: row.targetBindingDigest,
      expiresAt: row.expiresAt.toISOString(),
    });
  }
  async function receiveProposal(raw: unknown, signal?: AbortSignal) {
    const incoming = SignedTransferProposalSchema.parse(raw);
    const body = incoming.payload;
    const row = await deps.prisma.deploymentTransferSession.findFirst({
      where: { id: body.challenge.payload.transferId, side: "target" },
      include: transferItems,
    });
    if (!row) throw transferUnavailable();
    const local = await identity();
    const remote = peerIdentity(
      await deps.peer.identity(row.sourceOrigin, signal),
      row.sourceOrigin,
    );
    distinct(remote, local.peer);
    if (!same(remote, body.source) || !same(body.challenge, await challenge(row.id)))
      throw transferUnavailable();
    verify(remote.publicKey, "proposal", incoming);
    const digest = deploymentTransferDigest("proposal", body);
    const updated = await store.transact(
      storedContext(row, signal),
      row,
      true,
      async (tx, current) => {
        assertTransferWrite(current, now());
        if (current.proposalDigest) {
          if (current.proposalDigest !== digest) throw transferConflict();
          return current;
        }
        return tx.deploymentTransferSession.update({
          where: { id: current.id },
          data: {
            sourceDeploymentId: remote.deploymentId,
            sourcePublicKey: remote.publicKey,
            sourceFingerprint: remote.fingerprint,
            remoteOwnerId: body.sourceScope.userId,
            remoteSpaceId: body.sourceScope.spaceId,
            remoteBotId: body.sourceScope.botId,
            peerNonce: body.sourceNonce,
            proposalDigest: digest,
            proposalJson: jsonValue(incoming),
            status: "proposed",
            revision: { increment: 1 },
            items: {
              create: body.selection.map((item) => ({
                id: randomUUID(),
                itemKey: item.itemKey,
                sourceBotId: body.sourceScope.botId,
                sourceSecretId: item.sourceSecretId,
                sourceRevision: item.revision,
                targetBotId: current.localBotId,
                targetName: item.name,
                origin: item.origin,
                auth: jsonValue(item.auth),
                decision: "keep",
                status: "pending",
              })),
            },
          },
          include: transferItems,
        });
      },
    );
    return receipt(updated, body.sourceNonce);
  }
  function overwriteReason(
    current: { id: string; ciphertext: string } | null,
    protectedResources: TransferProposal["protectedSourceResources"],
  ): DeploymentTransferReason | undefined {
    if (!current) return undefined;
    const target = resource(current.ciphertext, current.id);
    if (target.kind === "inline") return undefined;
    if (target.kind === "unknown" || protectedResources.some((source) => source.kind === "unknown"))
      return "resource_unknown";
    if (
      protectedResources.some(
        (source) =>
          source.kind === "external" &&
          source.deletionKeyFingerprint === target.deletionKeyFingerprint,
      )
    )
      return "source_resource_shared";
    return undefined;
  }
  async function checkTargetSnapshot(
    tx: Prisma.TransactionClient,
    row: TransferRow,
    item: TransferPlanItem,
  ) {
    const current = await tx.botSecret.findFirst({
      where: { ...localTransferScope(row), name: item.source.name },
    });
    if (item.expectedTarget.kind === "absent") {
      if (current) throw new TargetAdmissionConflict("target_changed");
    } else if (
      !current ||
      current.id !== item.expectedTarget.id ||
      current.revision !== item.expectedTarget.revision
    )
      throw new TargetAdmissionConflict("target_changed");
    if (item.action !== "keep") {
      if (
        current &&
        !sameSecretDestination(
          normalizeSecretDestination(current),
          normalizeSecretDestination(item.source),
        )
      )
        throw new TargetAdmissionConflict("destination_conflict");
      const reason = overwriteReason(current, proposal(row).payload.protectedSourceResources);
      if (reason) throw new TargetAdmissionConflict(reason);
      if (!current && (await tx.botSecret.count({ where: localTransferScope(row) })) >= 100)
        throw new TargetAdmissionConflict("credential_limit");
    }
    return current;
  }
  async function previewTarget(
    context: TransferContext,
    input: Extract<DeploymentTransferPreviewInput, { mode: "target" }>,
  ) {
    const row = await store.owned(context, input.transferId);
    if (row.side !== "target" || !row.proposalDigest || row.tokenHash) throw transferConflict();
    const labels = await names(localTransferScope(row));
    const decisions = new Map(input.decisions.map((item) => [item.itemKey, item.action]));
    if (decisions.size !== input.decisions.length) throw transferConflict();
    const updated = await store.transact(context, row, true, async (tx, current) => {
      assertTransferWrite(current, now());
      expectedRevision(current, input.expectedRevision);
      if (current.tokenHash) throw transferConflict();
      const incoming = proposal(current).payload;
      if (
        [...decisions.keys()].some(
          (key) => !incoming.selection.some((item) => item.itemKey === key),
        )
      )
        throw transferConflict();
      const items: TransferPlanItem[] = [];
      let remainingSlots = Math.max(
        0,
        100 - (await tx.botSecret.count({ where: localTransferScope(current) })),
      );
      for (const source of incoming.selection) {
        const old = await tx.botSecret.findFirst({
          where: { ...localTransferScope(current), name: source.name },
        });
        let reason = overwriteReason(old, incoming.protectedSourceResources);
        try {
          if (
            old &&
            !sameSecretDestination(
              normalizeSecretDestination(old),
              normalizeSecretDestination(source),
            )
          )
            reason = "destination_conflict";
        } catch {
          reason = "destination_conflict";
        }
        if (!old && remainingSlots === 0) reason = "credential_limit";
        const canOverwrite = Boolean(old) && !reason;
        const action = !old
          ? reason
            ? "keep"
            : "create"
          : decisions.get(source.itemKey) === "overwrite" && canOverwrite
            ? "overwrite"
            : "keep";
        if (action === "create") remainingSlots--;
        const item: TransferPlanItem = {
          source,
          action,
          expectedTarget: old
            ? { kind: "present", id: old.id, revision: old.revision }
            : { kind: "absent" },
          canOverwrite,
          ...(reason ? { reason } : {}),
        };
        items.push(item);
        await tx.deploymentTransferItem.update({
          where: { sessionId_itemKey: { sessionId: current.id, itemKey: source.itemKey } },
          data: {
            expectedTargetId: old?.id ?? null,
            expectedTargetRevision: old?.revision ?? null,
            decision: action === "overwrite" ? "replace" : action,
            reasonCode: reason ?? (action === "keep" ? "target_kept" : null),
            revision: { increment: 1 },
          },
        });
      }
      const value: TransferPlan = {
        protocol,
        kind: "plan",
        transferId: current.id,
        proposalDigest: current.proposalDigest!,
        revision: current.revision + 1,
        source: sourceIdentity(current),
        target: targetIdentity(current),
        sourceScope: incoming.sourceScope,
        targetScope: localTransferScope(current),
        sourceBotName: incoming.sourceBotName,
        targetBotName: labels.bot,
        sourceOwnerName: incoming.sourceOwnerName,
        sourceSpaceName: incoming.sourceSpaceName,
        targetOwnerName: labels.owner,
        targetSpaceName: labels.space,
        sourceNonce: incoming.sourceNonce,
        targetNonce: current.localNonce,
        expiresAt: current.expiresAt.toISOString(),
        items,
      };
      return tx.deploymentTransferSession.update({
        where: { id: current.id },
        data: {
          planJson: jsonValue(value),
          planDigest: deploymentTransferDigest("plan", value),
          status: "previewed",
          revision: { increment: 1 },
        },
        include: transferItems,
      });
    });
    return projection(updated);
  }
  async function queryFor(row: TransferRow, kind: "status" | "cancel") {
    const local = await identity();
    const body = {
      protocol,
      kind,
      transferId: row.targetTransferId,
      proposalDigest: row.proposalDigest!,
      planDigest: row.planDigest,
      source: sourceIdentity(row),
      target: targetIdentity(row),
      sourceScope: proposal(row).payload.sourceScope,
      targetBindingDigest: row.targetBindingDigest,
      sourceNonce: row.side === "source" ? row.localNonce : row.peerNonce!,
      targetNonce: row.side === "target" ? row.localNonce : row.peerNonce!,
      requestNonce: transferNonce(),
      messageExpiresAt: new Date(now() + 30_000).toISOString(),
    };
    return sign(local.material.privateKey, kind, body);
  }
  async function deliverGrant(row: TransferRow, signal?: AbortSignal) {
    if (!row.ciphertext || !row.secretRecordId || !row.planDigest) return row;
    const query = await queryFor(row, "status");
    try {
      const known = SignedTransferReceiptSchema.parse(
        await deps.peer.status(row.sourceOrigin, query, signal),
      );
      verify(sourceIdentity(row).publicKey, "receipt", known);
      if (
        known.payload.requestNonce !== query.payload.requestNonce ||
        known.payload.transferId !== row.id ||
        known.payload.planDigest !== row.planDigest
      )
        throw transferUnavailable();
      if (known.payload.grantStored) return acknowledgeGrant(row);
    } catch {
      /* Only exact grant retransmission is permitted after an uncertain delivery. */
    }
    const envelope = TransferGrantDeliverySchema.parse(
      JSON.parse(
        await deps.secrets.load(row.ciphertext, {
          recordId: row.secretRecordId,
          signal,
        }),
      ),
    );
    const ack = SignedTransferReceiptSchema.parse(
      await deps.peer.grant(row.sourceOrigin, envelope, signal),
    );
    verify(sourceIdentity(row).publicKey, "receipt", ack);
    if (
      ack.payload.requestNonce !== envelope.grant.payload.grantNonce ||
      ack.payload.transferId !== row.id ||
      ack.payload.planDigest !== row.planDigest ||
      !ack.payload.grantStored
    )
      throw transferUnavailable();
    return acknowledgeGrant(row);
  }
  async function acknowledgeGrant(row: TransferRow) {
    return deps.prisma.$transaction(async (tx) => {
      const current = await lockTransferRow(tx, row.id);
      if (current.planDigest !== row.planDigest || current.tokenHash !== row.tokenHash)
        throw transferConflict();
      return tx.deploymentTransferSession.update({
        where: { id: row.id },
        data: {
          ciphertext: null,
          secretRecordId: null,
          grantDelivery: "acknowledged",
          status: current.status === "grant_pending" ? "ready" : current.status,
          revision: { increment: 1 },
        },
        include: transferItems,
      });
    });
  }
  async function approve(context: TransferContext, input: DeploymentTransferApproveInput) {
    let row = await store.owned(context, input.transferId);
    if (
      row.side !== "target" ||
      !row.planDigest ||
      row.planDigest !== input.planDigest ||
      row.sourceFingerprint !== input.expectedSourceFingerprint
    )
      throw transferConflict();
    const local = await identity();
    const frozen = plan(row);
    const admission = await store.transact(context, row, true, async (tx, current) => {
      assertTransferWrite(current, now());
      expectedRevision(current, input.expectedRevision);
      if (current.planDigest !== input.planDigest || !same(local.peer, frozen.target))
        throw transferConflict();
      for (const item of frozen.items)
        if (
          !current.items.some(
            (entry) => entry.itemKey === item.source.itemKey && entry.status === "accepted",
          )
        )
          await checkTargetSnapshot(tx, current, item);
      return current;
    });
    if (admission.tokenHash) {
      row = await store.transact(context, admission, true, (tx, current) => {
        assertTransferWrite(current, now());
        return tx.deploymentTransferSession.update({
          where: { id: current.id },
          data: { localSessionId: transferUser(context).sessionId, revision: { increment: 1 } },
          include: transferItems,
        });
      });
    } else {
      const writeToken = transferNonce();
      const grantNonce = transferNonce();
      const envelope = {
        grant: sign(local.material.privateKey, "grant", {
          protocol,
          kind: "grant" as const,
          grantNonce,
          plan: frozen,
          planDigest: input.planDigest,
          tokenHash: transferHash(writeToken),
        }),
        writeToken,
      };
      const recordId = `transfer-grant:${randomUUID()}`;
      const stored = await deps.secrets.put(
        JSON.stringify(envelope),
        {
          userId: row.localUserId,
          spaceId: row.localSpaceId,
          operationId: "transfer.approve",
          traceId: "transfer.approve",
          signal: context.signal ?? new AbortController().signal,
        },
        { recordId, ephemeral: true },
      );
      if (stored.id !== recordId || resource(stored.ciphertext, recordId).kind !== "inline")
        throw transferUnavailable();
      row = await persistPreparedSecret(deps.prisma, deps.secrets, stored, () =>
        store.transact(context, admission, true, async (tx, current) => {
          assertTransferWrite(current, now());
          expectedRevision(current, input.expectedRevision);
          if (current.tokenHash || current.planDigest !== input.planDigest)
            throw transferConflict();
          for (const item of frozen.items) await checkTargetSnapshot(tx, current, item);
          await tx.deploymentTransferItem.updateMany({
            where: { sessionId: current.id, decision: "keep" },
            data: { status: "kept", revision: { increment: 1 } },
          });
          const approved = await tx.deploymentTransferSession.update({
            where: { id: current.id },
            data: {
              localSessionId: transferUser(context).sessionId,
              tokenHash: transferHash(writeToken),
              remoteOwnerGrantNonce: grantNonce,
              ciphertext: stored.ciphertext,
              secretRecordId: recordId,
              grantDelivery: "pending",
              status: "grant_pending",
              revision: { increment: 1 },
            },
            include: transferItems,
          });
          return frozen.items.every((item) => item.action === "keep")
            ? updatePhase(tx, current.id)
            : approved;
        }),
      );
    }
    try {
      row = await deliverGrant(row, context.signal);
    } catch {
      await deps.prisma.deploymentTransferSession.updateMany({
        where: { id: row.id, grantDelivery: "pending" },
        data: { grantDelivery: "unknown", revision: { increment: 1 } },
      });
      row = await reload(row.id);
    }
    return projection(row);
  }
  async function receiveGrant(raw: unknown, signal?: AbortSignal) {
    const envelope = TransferGrantDeliverySchema.parse(raw);
    const incoming = envelope.grant.payload;
    const value = incoming.plan;
    const row = await deps.prisma.deploymentTransferSession.findFirst({
      where: {
        side: "source",
        targetOrigin: value.target.origin,
        targetTransferId: value.transferId,
        localUserId: value.sourceScope.userId,
        localSpaceId: value.sourceScope.spaceId,
        localBotId: value.sourceScope.botId,
      },
      include: transferItems,
    });
    if (
      !row ||
      row.proposalDigest !== value.proposalDigest ||
      incoming.planDigest !== deploymentTransferDigest("plan", value) ||
      !transferTokenMatches(incoming.tokenHash, envelope.writeToken)
    )
      throw transferUnavailable();
    const local = await identity();
    verify(targetIdentity(row).publicKey, "grant", envelope.grant);
    if (
      !same(value.source, local.peer) ||
      !same(value.source, sourceIdentity(row)) ||
      !same(value.target, targetIdentity(row)) ||
      !same(value.sourceScope, localTransferScope(row)) ||
      value.sourceNonce !== row.localNonce ||
      value.targetNonce !== row.peerNonce ||
      value.expiresAt !== row.expiresAt.toISOString() ||
      binding({
        transferId: value.transferId,
        sourceOrigin: row.sourceOrigin,
        target: value.target,
        targetScope: value.targetScope,
        targetNonce: value.targetNonce,
        expiresAt: value.expiresAt,
      }) !== row.targetBindingDigest ||
      !same(
        value.items.map((item) => item.source),
        proposal(row).payload.selection,
      )
    )
      throw transferUnavailable();
    if (row.tokenHash) {
      if (
        row.tokenHash !== incoming.tokenHash ||
        row.planDigest !== incoming.planDigest ||
        row.remoteOwnerGrantNonce !== incoming.grantNonce
      )
        throw transferConflict();
      return receipt(row, incoming.grantNonce);
    }
    await store.transact(storedContext(row, signal), row, true, async (_tx, current) => {
      assertTransferWrite(current, now());
      if (current.tokenHash) throw transferConflict();
    });
    const recordId = `transfer-grant:${randomUUID()}`;
    const stored = await deps.secrets.put(
      JSON.stringify(envelope),
      {
        userId: row.localUserId,
        spaceId: row.localSpaceId,
        operationId: "transfer.grant",
        traceId: "transfer.grant",
        signal: signal ?? new AbortController().signal,
      },
      { recordId, ephemeral: true },
    );
    if (stored.id !== recordId || resource(stored.ciphertext, recordId).kind !== "inline")
      throw transferUnavailable();
    const updated = await persistPreparedSecret(deps.prisma, deps.secrets, stored, () =>
      store.transact(storedContext(row, signal), row, true, async (tx, current) => {
        assertTransferWrite(current, now());
        if (current.tokenHash) {
          if (
            current.tokenHash !== incoming.tokenHash ||
            current.planDigest !== incoming.planDigest
          )
            throw transferConflict();
          return current;
        }
        for (const item of value.items)
          await tx.deploymentTransferItem.update({
            where: { sessionId_itemKey: { sessionId: row.id, itemKey: item.source.itemKey } },
            data: {
              targetBotId: value.targetScope.botId,
              expectedTargetId:
                item.expectedTarget.kind === "present" ? item.expectedTarget.id : null,
              expectedTargetRevision:
                item.expectedTarget.kind === "present" ? item.expectedTarget.revision : null,
              decision: item.action === "overwrite" ? "replace" : item.action,
              status: item.action === "keep" ? "kept" : "pending",
              reasonCode: item.reason ?? null,
              revision: { increment: 1 },
            },
          });
        return tx.deploymentTransferSession.update({
          where: { id: row.id },
          data: {
            planJson: jsonValue(value),
            planDigest: incoming.planDigest,
            remoteOwnerId: value.targetScope.userId,
            remoteSpaceId: value.targetScope.spaceId,
            remoteBotId: value.targetScope.botId,
            remoteOwnerGrantNonce: incoming.grantNonce,
            tokenHash: incoming.tokenHash,
            ciphertext: stored.ciphertext,
            secretRecordId: recordId,
            grantDelivery: "stored",
            status: "ready",
            revision: { increment: 1 },
          },
          include: transferItems,
        });
      }),
    );
    return receipt(updated, incoming.grantNonce);
  }

  async function queryRow(raw: unknown, kind: "status" | "cancel") {
    const signed =
      kind === "status"
        ? SignedTransferStatusQuerySchema.parse(raw)
        : SignedTransferCancelSchema.parse(raw);
    const body = signed.payload;
    if (
      Date.parse(body.messageExpiresAt) <= now() ||
      Date.parse(body.messageExpiresAt) > now() + 60_000
    )
      throw transferUnavailable();
    const candidates = await deps.prisma.deploymentTransferSession.findMany({
      where: {
        targetTransferId: body.transferId,
        proposalDigest: body.proposalDigest,
        targetOrigin: body.target.origin,
        sourceOrigin: body.source.origin,
      },
      include: transferItems,
    });
    const row = candidates.find((row) =>
      row.side === "target"
        ? same(localTransferScope(row), planScope(body, "target", row))
        : same(localTransferScope(row), body.sourceScope),
    );
    if (
      !row ||
      !same(sourceIdentity(row), body.source) ||
      !same(targetIdentity(row), body.target) ||
      !same(proposal(row).payload.sourceScope, body.sourceScope) ||
      row.targetBindingDigest !== body.targetBindingDigest ||
      (row.side === "source" ? row.localNonce : row.peerNonce) !== body.sourceNonce ||
      (row.side === "target" ? row.localNonce : row.peerNonce) !== body.targetNonce ||
      (body.planDigest && row.planDigest !== body.planDigest)
    )
      throw transferUnavailable();
    verify<TransferStatusQuery | TransferCancel>(
      row.side === "target" ? body.source.publicKey : body.target.publicKey,
      kind,
      signed,
    );
    const local = await identity();
    if (!same(local.peer, row.side === "target" ? body.target : body.source))
      throw transferUnavailable();
    return { row, body };
  }
  function planScope(
    _body: TransferStatusQuery | TransferCancel,
    _side: "target",
    row: TransferRow,
  ) {
    return row.planJson ? plan(row).targetScope : localTransferScope(row);
  }
  async function receiveStatus(raw: unknown) {
    const { row, body } = await queryRow(raw, "status");
    return receipt(row, body.requestNonce, true);
  }
  async function cancelRow(context: TransferContext, row: TransferRow, revision?: number) {
    return store.transact(context, row, false, async (tx, current) => {
      if (current.cancelRequestedAt)
        return current.ciphertext
          ? tx.deploymentTransferSession.update({
              where: { id: current.id },
              data: { ciphertext: null, secretRecordId: null, revision: { increment: 1 } },
              include: transferItems,
            })
          : current;
      if (revision !== undefined) expectedRevision(current, revision);
      await tx.deploymentTransferItem.updateMany({
        where: { sessionId: row.id, status: { in: ["pending", "sending"] }, writeState: "none" },
        data: { status: "cancelled", reasonCode: "cancelled", revision: { increment: 1 } },
      });
      return tx.deploymentTransferSession.update({
        where: { id: row.id },
        data: {
          cancelRequestedAt: new Date(now()),
          status: "cancelled",
          ciphertext: null,
          secretRecordId: null,
          revision: { increment: 1 },
        },
        include: transferItems,
      });
    });
  }
  async function receiveCancel(raw: unknown, signal?: AbortSignal) {
    const { row, body } = await queryRow(raw, "cancel");
    const context = storedContext(row, signal);
    const cancelled = await cancelRow(context, row);
    return receipt(
      await cleanupCancelledTransfer({ ...deps, context, row: cancelled }),
      body.requestNonce,
      true,
    );
  }
  async function mergeReceipt(
    row: TransferRow,
    incoming: SignedTransfer<TransferReceipt>,
    requestNonce: string,
  ) {
    verify(targetIdentity(row).publicKey, "receipt", incoming);
    if (
      incoming.payload.transferId !== row.targetTransferId ||
      incoming.payload.proposalDigest !== row.proposalDigest ||
      incoming.payload.planDigest !== row.planDigest ||
      incoming.payload.requestNonce !== requestNonce
    )
      throw transferUnavailable();
    return deps.prisma.$transaction(async (tx) => {
      const current = await lockTransferRow(tx, row.id);
      if (current.planDigest !== row.planDigest) throw transferConflict();
      for (const remote of incoming.payload.items) {
        const item = current.items.find((item) => item.itemKey === remote.itemKey);
        if (!item) continue;
        if (item.status === "accepted" && remote.status !== "copied") continue;
        // A receipt is factual history. Expiry/cancellation cannot erase a copied item.
        const priorReceipt = item.receiptJson as { revision?: number } | null;
        if ((priorReceipt?.revision ?? 0) > remote.revision) continue;
        const provisional = ["pending", "sending", "unknown"].includes(remote.status);
        const localRefusal = ["conflict", "failed", "skipped", "expired", "cancelled"].includes(
          item.status,
        );
        if (
          provisional &&
          (localRefusal ||
            (item.status === "unknown" &&
              item.writeState === "dispatched" &&
              remote.status !== "unknown"))
        )
          continue;
        await tx.deploymentTransferItem.update({
          where: { id: item.id },
          data: {
            status: remote.status === "copied" ? "accepted" : remote.status,
            reasonCode: remote.reason ?? null,
            receiptJson: jsonValue(remote),
            acceptedAt: remote.status === "copied" ? (item.acceptedAt ?? new Date(now())) : null,
            writeState: ["copied", "kept", "cancelled", "conflict", "failed", "expired"].includes(
              remote.status,
            )
              ? "settled"
              : item.writeState,
            revision: { increment: 1 },
          },
        });
      }
      const updated = await updatePhase(tx, current.id);
      if (incoming.payload.phase === "cancelled" || incoming.payload.phase === "expired") {
        const restored = incoming.payload.items.some((item) => item.reason === "restore");
        return tx.deploymentTransferSession.update({
          where: { id: current.id },
          data: {
            status: incoming.payload.phase,
            ...(incoming.payload.phase === "cancelled"
              ? { cancelRequestedAt: updated.cancelRequestedAt ?? new Date(now()) }
              : {}),
            ...(restored
              ? {
                  writeRevokedAt: updated.writeRevokedAt ?? new Date(now()),
                  writeRevokedReason: "restore",
                }
              : {}),
            revision: { increment: 1 },
          },
          include: transferItems,
        });
      }
      return updated;
    });
  }
  async function updatePhase(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.deploymentTransferSession.findUniqueOrThrow({
      where: { id },
      include: transferItems,
    });
    const items = row.items.filter((item) => item.decision !== "skip");
    const settled = items.every((item) =>
      ["accepted", "kept", "conflict", "failed", "skipped", "cancelled", "expired"].includes(
        item.status,
      ),
    );
    const accepted = items.some((item) => item.status === "accepted");
    const status = row.cancelRequestedAt
      ? "cancelled"
      : settled
        ? items.every((item) => ["accepted", "kept", "skipped"].includes(item.status))
          ? "completed"
          : accepted
            ? "partial"
            : "failed"
        : row.writeRevokedAt || row.expiresAt.getTime() <= now() || row.status === "expired"
          ? "expired"
          : items.some(
                (item) =>
                  item.writeState === "claimed" ||
                  item.writeState === "stored" ||
                  item.status === "unknown",
              )
            ? "unknown"
            : row.status;
    return tx.deploymentTransferSession.update({
      where: { id },
      data: {
        status,
        ...(row.side === "source" &&
        ["completed", "partial", "failed", "cancelled"].includes(status)
          ? { ciphertext: null, secretRecordId: null }
          : {}),
        revision: { increment: 1 },
        ...(settled ? { terminalAt: new Date(now()) } : {}),
      },
      include: transferItems,
    });
  }
  async function status(context: TransferContext, input: DeploymentTransferStatusInput) {
    const user = transferUser(context);
    let row: TransferRow;
    if ("transferId" in input) row = await store.owned(context, input.transferId);
    else {
      const found = await deps.prisma.deploymentTransferSession.findUnique({
        where: {
          localUserId_side_clientNonce: {
            localUserId: user.userId,
            side: input.side,
            clientNonce: input.clientNonce,
          },
        },
        include: transferItems,
      });
      if (!found) return null;
      row = await store.owned(context, found.id);
    }
    if (row.ciphertext)
      row = await deps.prisma.$transaction(async (tx) => {
        const current = await lockTransferRow(tx, row.id);
        const expires =
          current.side === "source"
            ? Math.min(
                current.expiresAt.getTime(),
                current.createdAt.getTime() + DEPLOYMENT_TRANSFER_TTL_MS,
              )
            : current.expiresAt.getTime();
        if (!current.ciphertext || expires > now()) return current;
        // Expired inline delivery material can be retired without any provider call.
        await tx.$executeRaw(Sql.sql`UPDATE deployment_transfer_sessions SET ciphertext=NULL, "secretRecordId"=NULL, revision=revision+1, "updatedAt"=CURRENT_TIMESTAMP
        WHERE id=${current.id} AND ciphertext=${current.ciphertext} AND "secretRecordId"=${current.secretRecordId}`);
        return tx.deploymentTransferSession.findUniqueOrThrow({
          where: { id: current.id },
          include: transferItems,
        });
      });
    let observedPeer = false;
    if (row.side === "source" && row.planDigest)
      try {
        const query = await queryFor(row, "status");
        row = await mergeReceipt(
          row,
          SignedTransferReceiptSchema.parse(
            await deps.peer.status(row.targetOrigin, query, context.signal),
          ),
          query.payload.requestNonce,
        );
        observedPeer = true;
      } catch {
        /* Local durable receipts remain readable without a reachable peer or current HTTPS configuration. */
      }
    return projection(
      await observeAccepted(
        row.side === "source" && !observedPeer ? withoutTargetObservation(row) : row,
      ),
    );
  }
  async function recent(context: TransferContext, input: { botId: string }) {
    const scope = await scopeOf(context, input.botId);
    const rows = await deps.prisma.deploymentTransferSession.findMany({
      where: { localUserId: scope.userId, localSpaceId: scope.spaceId, localBotId: scope.botId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: transferItems,
    });
    return rows.map((row) => {
      const p = projection(row);
      return {
        transferId: p.transferId,
        side: p.side,
        phase: p.phase,
        revision: p.revision,
        expiresAt: p.expiresAt,
        localScope: p.localScope,
        source: p.source,
        target: p.target,
      };
    });
  }
  async function cancel(context: TransferContext, input: DeploymentTransferCancelInput) {
    let row = await cancelRow(
      context,
      await store.owned(context, input.transferId),
      input.expectedRevision,
    );
    row = await cleanupCancelledTransfer({ ...deps, context, row });
    let observedPeer = false;
    if (row.proposalDigest)
      try {
        const query = await queryFor(row, "cancel");
        const ack = SignedTransferReceiptSchema.parse(
          await deps.peer.cancel(
            row.side === "source" ? row.targetOrigin : row.sourceOrigin,
            query,
            context.signal,
          ),
        );
        if (row.side === "source") {
          row = await mergeReceipt(row, ack, query.payload.requestNonce);
          observedPeer = true;
        } else {
          verify(sourceIdentity(row).publicKey, "receipt", ack);
          if (
            ack.payload.transferId !== row.targetTransferId ||
            ack.payload.proposalDigest !== row.proposalDigest ||
            ack.payload.planDigest !== row.planDigest ||
            ack.payload.requestNonce !== query.payload.requestNonce
          )
            throw transferUnavailable();
        }
      } catch {
        /* Local cancellation is durable even if peer notification cannot complete. */
      }
    return projection(
      row.side === "source" && !observedPeer
        ? withoutTargetObservation(row)
        : await observeAccepted(row),
    );
  }
  function verifyItem(row: TransferRow, signed: SignedTransfer<TransferItem>, token: string) {
    const body = signed.payload;
    const frozen = plan(row);
    if (
      row.side !== "target" ||
      !row.tokenHash ||
      !transferTokenMatches(row.tokenHash, token) ||
      row.planDigest !== body.planDigest ||
      row.remoteOwnerGrantNonce !== body.grantNonce ||
      !same(body.source, frozen.source) ||
      !same(body.target, frozen.target) ||
      !same(body.sourceScope, frozen.sourceScope) ||
      !same(body.targetScope, frozen.targetScope) ||
      body.sourceNonce !== frozen.sourceNonce ||
      body.targetNonce !== frozen.targetNonce ||
      body.expiresAt !== frozen.expiresAt
    )
      throw transferUnavailable();
    verify(frozen.source.publicKey, "item", signed);
    const item = frozen.items.find(
      (item) =>
        item.source.itemKey === body.itemKey && item.source.revision === body.sourceRevision,
    );
    if (!item || item.action === "keep") throw transferUnavailable();
    return item;
  }
  async function adopt(
    row: TransferRow,
    itemKey: string,
    fence: number,
    ciphertext: string,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    const context = { ...storedContext(row, signal), sessionId };
    return persistPreparedSecret(deps.prisma, deps.secrets, undefined, () =>
      store.transact(context, row, true, async (tx, current) => {
        assertTransferWrite(current, now(), sessionId);
        const item = current.items.find((item) => item.itemKey === itemKey);
        if (!item) throw transferConflict();
        if (item.status === "accepted") return current;
        if (item.writeFence !== fence || !item.secretRecordId || !item.recoveryRef)
          throw transferConflict();
        const planned = plan(current).items.find((entry) => entry.source.itemKey === itemKey)!;
        await checkTargetSnapshot(tx, current, planned);
        const adopted = await adoptPreparedBotSecret(tx, {
          scope: localTransferScope(current),
          destination: normalizeSecretDestination(planned.source),
          recordId: item.secretRecordId,
          ciphertext,
          expected: planned.expectedTarget,
        });
        await tx.deploymentTransferItem.update({
          where: { id: item.id },
          data: {
            status: "accepted",
            writeState: "settled",
            ciphertext: null,
            recoveryRef: null,
            targetSecretId: adopted.id,
            acceptedRevision: adopted.revision,
            acceptedAt: new Date(now()),
            reasonCode: planned.source.auth.type === "login" ? "login_password_only" : null,
            revision: { increment: 1 },
          },
        });
        return updatePhase(tx, row.id);
      }),
    );
  }
  async function receiveItem(token: string, raw: unknown, signal?: AbortSignal) {
    const signed = SignedTransferItemSchema.parse(raw);
    const body = signed.payload;
    let row = await deps.prisma.deploymentTransferSession.findFirst({
      where: { id: body.transferId, side: "target" },
      include: transferItems,
    });
    if (!row) throw transferUnavailable();
    const planned = verifyItem(row, signed, token);
    if (body.kind !== "recover") validateTransferBotSecret(planned.source, body.value);
    const local = await identity();
    if (!same(local.peer, planned ? plan(row).target : targetIdentity(row)))
      throw transferUnavailable();
    const capturedSession = row.localSessionId;
    const context = storedContext(row, signal);
    const claim = await store.transact(context, row, true, async (tx, current) => {
      assertTransferWrite(current, now(), capturedSession);
      verifyItem(current, signed, token);
      if (current.acceptedNonce && current.acceptedNonce !== body.commitNonce)
        throw transferConflict();
      const item = current.items.find((entry) => entry.itemKey === body.itemKey)!;
      if (item.status === "accepted") return { item, dispatch: false };
      if (!current.acceptedNonce || current.grantDelivery !== "acknowledged")
        await tx.deploymentTransferSession.update({
          where: { id: current.id },
          data: {
            acceptedNonce: body.commitNonce,
            consumedAt: new Date(now()),
            grantDelivery: "acknowledged",
            ciphertext: null,
            secretRecordId: null,
            status: "transferring",
            revision: { increment: 1 },
          },
        });
      if (item.status === "conflict" && item.writeState === "settled")
        return { item, dispatch: false };
      try {
        await checkTargetSnapshot(tx, current, planned);
      } catch (error) {
        if (!(error instanceof TargetAdmissionConflict) || item.writeState !== "none") throw error;
        const rejected = await tx.deploymentTransferItem.update({
          where: { id: item.id },
          data: {
            status: "conflict",
            reasonCode: error.reason,
            writeState: "settled",
            revision: { increment: 1 },
          },
        });
        await updatePhase(tx, current.id);
        return { item: rejected, dispatch: false };
      }
      if (item.writeState !== "none") return { item, dispatch: false };
      if (body.kind !== "item") throw transferConflict();
      // Persist the immutable remote dispatch claim before the provider can create anything.
      const recordId =
        planned.expectedTarget.kind === "present" ? planned.expectedTarget.id : randomUUID();
      const recoveryRef = deps.secrets.prepareWrite?.(recordId);
      if (!recoveryRef) throw transferUnavailable();
      const claimed = await tx.deploymentTransferItem.update({
        where: { id: item.id },
        data: {
          secretRecordId: recordId,
          recoveryRef,
          dispatchClaimId: randomUUID(),
          writeFence: { increment: 1 },
          claimedAt: new Date(now()),
          writeState: "claimed",
          status: "unknown",
          revision: { increment: 1 },
        },
      });
      return { item: claimed, dispatch: true };
    });
    if (claim.item.status === "accepted")
      return receipt(await reload(row.id), body.commitNonce, true);
    if (claim.item.status === "conflict" && claim.item.writeState === "settled")
      return receipt(await reload(row.id), body.commitNonce, true);
    let item = claim.item;
    let dispatch = claim.dispatch;
    let foundRef = item.ciphertext;
    if (!dispatch && item.recoveryRef && item.secretRecordId) {
      const observed = foundRef
        ? { state: "found" as const, ref: foundRef }
        : await reconcileSecretWrite(deps.secrets, item.recoveryRef, {
            recordId: item.secretRecordId,
            signal,
          });
      if (observed.state === "found") {
        if (body.kind === "item") return receipt(await reload(row.id), body.commitNonce, true);
        foundRef = observed.ref;
      } else if (
        body.kind === "recover_inline" &&
        observed.state === "absent" &&
        resource(item.recoveryRef, item.secretRecordId).kind === "inline"
      ) {
        item = await store.transact(context, row, true, async (tx, current) => {
          assertTransferWrite(current, now(), capturedSession);
          const latest = current.items.find((entry) => entry.itemKey === body.itemKey)!;
          if (
            latest.status === "accepted" ||
            latest.writeFence !== body.expectedWriteFence ||
            latest.recoveryRef !== item.recoveryRef
          )
            throw transferConflict();
          await checkTargetSnapshot(tx, current, planned);
          return tx.deploymentTransferItem.update({
            where: { id: latest.id },
            data: {
              writeFence: { increment: 1 },
              revision: { increment: 1 },
            },
          });
        });
        dispatch = true;
      } else return receipt(await reload(row.id), body.commitNonce, true);
    }
    if (dispatch) {
      if (body.kind === "recover") throw transferConflict();
      const checked = validateTransferBotSecret(planned.source, body.value);
      try {
        const written = await deps.secrets.put(
          checked.plaintext,
          {
            userId: row.localUserId,
            spaceId: row.localSpaceId,
            operationId: "transfer.item",
            traceId: "transfer.item",
            signal: signal ?? new AbortController().signal,
          },
          { recordId: item.secretRecordId!, recoveryRef: item.recoveryRef! },
        );
        if (written.id !== item.secretRecordId) throw transferUnavailable();
        // Retain a returned reference before any later authorization or adoption can fail.
        await deps.prisma.$transaction(async (tx) => {
          const latest = await lockTransferRow(tx, row!.id);
          const current = latest.items.find((entry) => entry.itemKey === item.itemKey)!;
          if (current.status === "accepted" || current.writeFence !== item.writeFence) return;
          await tx.deploymentTransferItem.update({
            where: { id: current.id },
            data: {
              ciphertext: written.ciphertext,
              writeState: "stored",
              revision: { increment: 1 },
            },
          });
        });
        foundRef = written.ciphertext;
      } catch {
        return receipt(await reload(row.id), body.commitNonce, true);
      }
    }
    if (foundRef)
      try {
        row = await adopt(row, body.itemKey, item.writeFence, foundRef, capturedSession, signal);
      } catch (error) {
        let reason = error instanceof TargetAdmissionConflict ? error.reason : undefined;
        if (!reason && error instanceof BotSecretConflictError)
          try {
            await store.transact(context, row, true, async (tx, current) => {
              assertTransferWrite(current, now(), capturedSession);
              await checkTargetSnapshot(tx, current, planned);
            });
          } catch (observed) {
            if (observed instanceof TargetAdmissionConflict) reason = observed.reason;
          }
        if (reason)
          row = await deps.prisma.$transaction(async (tx) => {
            const current = await lockTransferRow(tx, row!.id);
            const pending = current.items.find((entry) => entry.itemKey === body.itemKey);
            if (!pending || pending.status === "accepted" || pending.writeFence !== item.writeFence)
              return current;
            // The provider write is retained. Only adoption under this old plan is ruled out.
            await tx.deploymentTransferItem.update({
              where: { id: pending.id },
              data: {
                status: "unknown",
                reasonCode: reason,
                revision: { increment: 1 },
              },
            });
            return tx.deploymentTransferSession.update({
              where: { id: current.id },
              data: {
                status: current.cancelRequestedAt ? "cancelled" : "unknown",
                revision: { increment: 1 },
              },
              include: transferItems,
            });
          });
        else row = await reload(row.id);
      }
    return receipt(row, body.commitNonce, true);
  }
  async function sourceSnapshotInTransaction(
    tx: Prisma.TransactionClient,
    current: TransferRow,
    planned: TransferPlanItem,
  ) {
    const rows = await sourceRows(localTransferScope(current), tx);
    if (!same(resources(rows), proposal(current).payload.protectedSourceResources))
      throw transferConflict();
    const secret = rows.find(
      (entry) =>
        entry.id === planned.source.sourceSecretId && entry.revision === planned.source.revision,
    );
    if (
      !secret ||
      !sameSecretDestination(
        normalizeSecretDestination(secret),
        normalizeSecretDestination(planned.source),
      )
    )
      throw transferConflict();
    return secret;
  }
  async function sourceValue(
    context: TransferContext,
    row: TransferRow,
    planned: TransferPlanItem,
  ) {
    const read = await store.transact(context, row, true, async (tx, current) => {
      assertTransferWrite(current, now(), transferUser(context).sessionId);
      return sourceSnapshotInTransaction(tx, current, planned);
    });
    const checked = validateTransferBotSecret(
      planned.source,
      await deps.secrets.load(read.ciphertext, { recordId: read.id, signal: context.signal }),
    );
    return { plaintext: checked.plaintext, ciphertext: read.ciphertext };
  }
  async function commit(context: TransferContext, input: DeploymentTransferCommitInput) {
    let row = await store.owned(context, input.transferId);
    if (
      row.side !== "source" ||
      row.planDigest !== input.planDigest ||
      row.targetFingerprint !== input.expectedTargetFingerprint
    )
      throw transferConflict();
    const historical = ["completed", "partial", "failed", "cancelled"].includes(row.status);
    if (
      historical &&
      (row.acceptedNonce === input.clientNonce ||
        (!row.acceptedNonce &&
          row.status === "completed" &&
          row.items.every((item) => item.decision === "keep" || item.decision === "skip")))
    )
      return projection(withoutTargetObservation(row));
    if (row.grantDelivery !== "stored" || !row.ciphertext || !row.secretRecordId)
      throw transferConflict();
    const local = await identity();
    if (!same(local.peer, plan(row).source)) throw transferConflict();
    row = await store.transact(context, row, true, async (tx, current) => {
      assertTransferWrite(current, now());
      if (current.acceptedNonce && current.acceptedNonce !== input.clientNonce)
        throw transferConflict();
      if (!current.acceptedNonce) expectedRevision(current, input.expectedRevision);
      return tx.deploymentTransferSession.update({
        where: { id: current.id },
        data: {
          acceptedNonce: input.clientNonce,
          consumedAt: current.consumedAt ?? new Date(now()),
          localSessionId: transferUser(context).sessionId,
          status: "transferring",
          revision: { increment: 1 },
        },
        include: transferItems,
      });
    });
    const envelope = TransferGrantDeliverySchema.parse(
      JSON.parse(
        await deps.secrets.load(row.ciphertext!, {
          recordId: row.secretRecordId!,
          signal: context.signal,
        }),
      ),
    );
    if (
      envelope.grant.payload.planDigest !== row.planDigest ||
      !transferTokenMatches(row.tokenHash, envelope.writeToken)
    )
      throw transferUnavailable();
    for (const planned of plan(row).items) {
      if (planned.action === "keep") continue;
      const query = await queryFor(row, "status");
      let remote: SignedTransfer<TransferReceipt>;
      try {
        remote = SignedTransferReceiptSchema.parse(
          await deps.peer.status(row.targetOrigin, query, context.signal),
        );
        row = await mergeReceipt(row, remote, query.payload.requestNonce);
      } catch {
        break;
      }
      if (!projection(row).canCommit) break;
      const item = row.items.find((entry) => entry.itemKey === planned.source.itemKey)!;
      if (item.status === "accepted") continue;
      if (blockedAdoptionReasons.has(item.reasonCode ?? "")) continue;
      const probe = remote.payload.recovery.find((entry) => entry.itemKey === item.itemKey);
      let kind: "item" | "recover" | "recover_inline" = "item";
      if (probe) {
        if (probe.state === "found") kind = "recover";
        else if (probe.state === "absent" && probe.inline) kind = "recover_inline";
        else continue;
      }
      let value: string | undefined;
      let sourceRef: string | undefined;
      try {
        if (kind !== "recover") {
          const loaded = await sourceValue(context, row, planned);
          value = loaded.plaintext;
          sourceRef = loaded.ciphertext;
        }
      } catch {
        await store.transact(context, row, true, async (tx, current) => {
          assertTransferWrite(current, now(), transferUser(context).sessionId);
          await tx.deploymentTransferItem.updateMany({
            where: { sessionId: row.id, itemKey: item.itemKey, status: { not: "accepted" } },
            data: { status: "conflict", reasonCode: "source_changed", revision: { increment: 1 } },
          });
        });
        continue;
      }
      const body = {
        protocol,
        kind,
        transferId: row.targetTransferId,
        planDigest: row.planDigest!,
        grantNonce: row.remoteOwnerGrantNonce!,
        source: plan(row).source,
        target: plan(row).target,
        sourceScope: plan(row).sourceScope,
        targetScope: plan(row).targetScope,
        sourceNonce: row.localNonce,
        targetNonce: row.peerNonce!,
        expiresAt: row.expiresAt.toISOString(),
        commitNonce: input.clientNonce,
        itemKey: item.itemKey,
        sourceRevision: item.sourceRevision,
        ...(kind === "recover_inline" ? { expectedWriteFence: probe!.writeFence } : {}),
        ...(value === undefined ? {} : { value }),
      };
      const message = SignedTransferItemSchema.parse(sign(local.material.privateKey, "item", body));
      try {
        await store.transact(context, row, true, async (tx, current) => {
          assertTransferWrite(current, now(), transferUser(context).sessionId);
          const fresh = await sourceSnapshotInTransaction(tx, current, planned);
          if (sourceRef && fresh.ciphertext !== sourceRef) throw transferConflict();
          await tx.deploymentTransferItem.updateMany({
            where: { sessionId: row.id, itemKey: item.itemKey, status: { not: "accepted" } },
            data: { status: "unknown", writeState: "dispatched", revision: { increment: 1 } },
          });
        });
      } catch {
        await store.transact(context, row, true, async (tx, current) => {
          assertTransferWrite(current, now(), transferUser(context).sessionId);
          await tx.deploymentTransferItem.updateMany({
            where: { sessionId: row.id, itemKey: item.itemKey, status: { not: "accepted" } },
            data: { status: "conflict", reasonCode: "source_changed", revision: { increment: 1 } },
          });
        });
        continue;
      }
      try {
        const result = SignedTransferReceiptSchema.parse(
          await deps.peer.item(row.targetOrigin, envelope.writeToken, message, context.signal),
        );
        row = await mergeReceipt(row, result, input.clientNonce);
      } catch {
        row = await reload(row.id);
      }
    }
    return projection(await deps.prisma.$transaction((tx) => updatePhase(tx, row.id)));
  }

  return {
    start: (context: TransferContext, input: DeploymentTransferStartInput) =>
      sanitized(() => start(context, input)),
    preview: (context: TransferContext, input: DeploymentTransferPreviewInput) =>
      sanitized(() =>
        input.mode === "source" ? previewSource(context, input) : previewTarget(context, input),
      ),
    propose: (context: TransferContext, input: DeploymentTransferProposeInput) =>
      sanitized(() => propose(context, input)),
    approve: (context: TransferContext, input: DeploymentTransferApproveInput) =>
      sanitized(() => approve(context, input)),
    commit: (context: TransferContext, input: DeploymentTransferCommitInput) =>
      sanitized(() => commit(context, input)),
    status: (context: TransferContext, input: DeploymentTransferStatusInput) =>
      sanitized(() => status(context, input)),
    recent: (context: TransferContext, input: { botId: string }) =>
      sanitized(() => recent(context, input)),
    cancel: (context: TransferContext, input: DeploymentTransferCancelInput) =>
      sanitized(() => cancel(context, input)),
    publicIdentity: async () => (await identity()).peer,
    challenge,
    receiveProposal,
    receiveGrant,
    receiveItem,
    receiveStatus,
    receiveCancel,
    close: () => deps.peer.close(),
  };
}
