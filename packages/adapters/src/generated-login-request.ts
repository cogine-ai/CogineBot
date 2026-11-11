import { createHmac } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { GenerateSecretInput } from "@rakazo/contracts";
import { resolveEncryptionKey } from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runLoginGenerationKind, withTransactionRetry } from "@rakazo/db";
import { approvedEffectOccurrence } from "./approval-effect.js";
import { persistPreparedSecret } from "./secret-persistence.js";

type LoginGeneration = Extract<GenerateSecretInput, { type: "login" }>;
type LoginRun = { id: string; userId: string; spaceId: string };
type LoginEffectRequest = { type: "login"; name: string; origin: string; inputId: string };

export function loginGenerationEffectArgs(runId: string, args: LoginGeneration) {
  const username = createHmac("sha256", resolveEncryptionKey())
    .update(JSON.stringify(["login-generation-username-v1", runId, args.username]))
    .digest("hex");
  return { ...args, username };
}

export function readLoginEffectRequest(value: unknown): LoginEffectRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const { type, name, origin, inputId } = value as Record<string, unknown>;
  if (
    type === "login" &&
    typeof name === "string" &&
    typeof origin === "string" &&
    typeof inputId === "string" &&
    inputId.length > 0
  )
    return { type, name, origin, inputId };
}

function protectedInputScope(run: LoginRun, effectKey: string) {
  return {
    userId: run.userId,
    spaceId: run.spaceId,
    kind: runLoginGenerationKind(run.id, effectKey),
  };
}

export async function createLoginGenerationEffect(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  context: AdapterContext;
  run: LoginRun;
  args: LoginGeneration;
  data: Prisma.ExternalEffectUncheckedCreateInput;
  lockRun: (tx: Prisma.TransactionClient) => Promise<boolean>;
}) {
  const { prisma, secretStore, context, run, args, data } = input;
  const staged = await secretStore.put(JSON.stringify(args), context, { ephemeral: true });
  return persistPreparedSecret(prisma, secretStore, staged, () =>
    withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        if (!(await input.lockRun(tx)))
          throw new Error("The run no longer owns this credential request.");
        await tx.secret.create({
          data: {
            ...protectedInputScope(run, data.idempotencyKey),
            id: staged.id,
            ciphertext: staged.ciphertext,
          },
        });
        const request: LoginEffectRequest = {
          type: "login",
          name: args.name,
          origin: args.origin,
          inputId: staged.id,
        };
        return tx.externalEffect.create({ data: { ...data, request } });
      }),
    ),
  );
}

export async function loadLoginGenerationInput(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  run: LoginRun;
  effectKey: string;
  request: LoginEffectRequest;
  signal: AbortSignal;
}): Promise<LoginGeneration | undefined> {
  const { prisma, secretStore, run, effectKey, request, signal } = input;
  try {
    const stored = await prisma.secret.findFirst({
      where: { ...protectedInputScope(run, effectKey), id: request.inputId },
      select: { id: true, ciphertext: true },
    });
    if (!stored) return;
    const plaintext = await secretStore.load(stored.ciphertext, { recordId: stored.id, signal });
    const parsed = GenerateSecretInput.safeParse(JSON.parse(plaintext));
    if (
      parsed.success &&
      parsed.data.type === "login" &&
      parsed.data.name === request.name &&
      parsed.data.origin === request.origin &&
      Number.isSafeInteger(
        approvedEffectOccurrence(
          effectKey,
          approvalEffectKey(
            run.id,
            "generate_secret",
            loginGenerationEffectArgs(run.id, parsed.data),
          ),
        ),
      )
    )
      return parsed.data;
  } catch {
    signal.throwIfAborted();
  }
}
