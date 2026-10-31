import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { SandboxKind } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { settleUncertainEffect, uncertainEffectResult } from "./approval-effect.js";
import { ScriptedStateInvalidError, scriptedStateDigest } from "./scripted-state.js";

const KIND = "scripted.file";
const requestSchema = z
  .object({
    version: z.literal(1),
    turnIndex: z.number().int().nonnegative(),
    fileIndex: z.number().int().nonnegative(),
    path: z.string().min(1),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.boolean(),
    target: z
      .object({
        id: z.string().min(1),
        homeKey: z.string().min(1),
        kind: SandboxKind,
        providerRef: z.string(),
      })
      .strict(),
  })
  .strict();
const resultSchema = z
  .object({ written: z.literal(true), fence: z.number().int().nonnegative() })
  .strict();

export interface ScriptedFileInput {
  runId: string;
  spaceId: string;
  workerId: string;
  leaseFence: number;
  turnIndex: number;
  fileIndex: number;
  computer: ComputerRef;
  file: PortableFile;
}

export class ScriptedFileUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super(uncertainEffectResult("write_file").error, options);
    this.name = "ScriptedFileUncertainError";
  }
}

type ScriptedFileContext = AdapterContext & { botId: string };

function retainContext(context: AdapterContext): ScriptedFileContext {
  if (!context.botId) throw new ScriptedStateInvalidError();
  return { ...context, botId: context.botId };
}

function prepare(input: ScriptedFileInput, context: ScriptedFileContext) {
  if (context.spaceId !== input.spaceId || (context.runId && context.runId !== input.runId))
    throw new ScriptedStateInvalidError();
  const file = { ...input.file, content: new Uint8Array(input.file.content) };
  const parsed = requestSchema.safeParse({
    version: 1,
    turnIndex: input.turnIndex,
    fileIndex: input.fileIndex,
    path: file.path,
    contentDigest: createHash("sha256").update(file.content).digest("hex"),
    executable: file.executable ?? false,
    target: {
      id: input.computer.id,
      homeKey: input.computer.botId,
      kind: input.computer.kind,
      providerRef: input.computer.providerRef,
    },
  });
  if (!parsed.success) throw new ScriptedStateInvalidError();
  return {
    file,
    request: parsed.data,
    key: `scripted-file:${input.runId}:${input.turnIndex}:${input.fileIndex}`,
  };
}

async function requireFence(
  tx: Prisma.TransactionClient,
  input: ScriptedFileInput,
  context: ScriptedFileContext,
) {
  await tx.$queryRaw`
    SELECT id FROM runs WHERE id = ${input.runId} AND "spaceId" = ${input.spaceId}
    AND "botId" = ${context.botId} AND "userId" = ${context.userId} FOR UPDATE`;
  const current = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      botId: context.botId,
      userId: context.userId,
      status: "running",
      leaseOwner: input.workerId,
      leaseFence: input.leaseFence,
      leaseExpiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!current) throw new Error("Run lease was lost before saving a scripted file");
}

async function receipt(
  tx: Prisma.TransactionClient,
  input: ScriptedFileInput,
  prepared: ReturnType<typeof prepare>,
) {
  const existing = await tx.externalEffect.findUnique({ where: { idempotencyKey: prepared.key } });
  if (
    existing &&
    (existing.runId !== input.runId ||
      existing.spaceId !== input.spaceId ||
      existing.kind !== KIND ||
      scriptedStateDigest(existing.request) !== scriptedStateDigest(prepared.request))
  )
    throw new ScriptedStateInvalidError();
  const prior = await tx.externalEffect.findMany({
    where: { runId: input.runId, spaceId: input.spaceId, kind: KIND },
  });
  for (const effect of prior) {
    const parsed = requestSchema.safeParse(effect.request);
    if (
      !parsed.success ||
      effect.idempotencyKey !==
        `scripted-file:${input.runId}:${parsed.data.turnIndex}:${parsed.data.fileIndex}` ||
      scriptedStateDigest(parsed.data.target) !== scriptedStateDigest(prepared.request.target)
    )
      throw new ScriptedStateInvalidError();
    if (effect.status === "executing" || effect.status === "uncertain")
      throw new ScriptedFileUncertainError();
    if (effect.status === "completed") {
      const completed = resultSchema.safeParse(effect.result);
      if (!completed.success || (input.computer.fresh && completed.data.fence !== input.leaseFence))
        throw new ScriptedStateInvalidError();
    } else if (effect.status !== "intended") throw new ScriptedStateInvalidError();
  }
  return existing;
}

/** Verify old writes before the resumed runtime can claim or act on fresh steering. */
export async function verifyScriptedFileReceipt(
  prisma: PrismaClient,
  input: ScriptedFileInput,
  context: AdapterContext,
): Promise<"missing" | "intended" | "completed"> {
  context.signal.throwIfAborted();
  const actor = retainContext(context);
  const stable = { ...input, computer: { ...input.computer } };
  const prepared = prepare(stable, actor);
  const result = await prisma.$transaction(async (tx) => {
    await requireFence(tx, stable, actor);
    const saved = await receipt(tx, stable, prepared);
    return saved ? (saved.status as "intended" | "completed") : "missing";
  });
  actor.signal.throwIfAborted();
  return result;
}

/** Record dispatch before crossing the sandbox boundary; never guess after an interrupted write. */
export async function commitScriptedFile(
  prisma: PrismaClient,
  sandbox: Pick<SandboxProvider, "writeFile">,
  input: ScriptedFileInput,
  context: AdapterContext,
): Promise<void> {
  context.signal.throwIfAborted();
  const actor = retainContext(context);
  const stable = { ...input, computer: { ...input.computer } };
  const prepared = prepare(stable, actor);
  const claimed = await prisma.$transaction(async (tx) => {
    await requireFence(tx, stable, actor);
    let saved = await receipt(tx, stable, prepared);
    if (saved?.status === "completed") return undefined;
    if (!saved) {
      saved = await tx.externalEffect.create({
        data: {
          runId: stable.runId,
          spaceId: stable.spaceId,
          kind: KIND,
          idempotencyKey: prepared.key,
          request: prepared.request,
          status: "intended",
        },
      });
    }
    const claim = await tx.externalEffect.updateMany({
      where: { id: saved.id, status: "intended" },
      data: { status: "executing" },
    });
    if (claim.count !== 1) throw new ScriptedFileUncertainError();
    return saved.id;
  });
  if (!claimed) {
    actor.signal.throwIfAborted();
    return;
  }
  try {
    actor.signal.throwIfAborted();
    await prisma.$transaction((tx) => requireFence(tx, stable, actor));
    actor.signal.throwIfAborted();
    await sandbox.writeFile(stable.computer, prepared.file, actor);
    actor.signal.throwIfAborted();
    const completed = await prisma.$transaction(async (tx) => {
      await requireFence(tx, stable, actor);
      return tx.externalEffect.updateMany({
        where: {
          id: claimed,
          runId: stable.runId,
          spaceId: stable.spaceId,
          kind: KIND,
          status: "executing",
          request: { equals: prepared.request },
        },
        data: { status: "completed", result: { written: true, fence: stable.leaseFence } },
      });
    });
    if (completed.count !== 1) throw new ScriptedFileUncertainError();
  } catch (error) {
    try {
      await settleUncertainEffect(prisma, claimed, "write_file");
    } catch (settlementError) {
      throw new ScriptedFileUncertainError({ cause: settlementError });
    }
    throw new ScriptedFileUncertainError({ cause: error });
  }
  actor.signal.throwIfAborted();
}
