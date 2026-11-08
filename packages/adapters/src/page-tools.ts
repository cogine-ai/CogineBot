import type { MessageBlock, SharedPageUpdateRequest } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH, PageVersionSchema } from "@rakazo/contracts";
import { containsSecret, isBackgroundRunTrigger, redactSecrets } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient, RunLease } from "@rakazo/db";
import { assertRunCanWriteHistory, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import { z } from "zod";
import {
  compilePageCandidate,
  loadToolPage,
  matchesSharedPageCandidate,
  pageChangedResult,
  pageToolScope,
  protectedSharedPageResult,
  readPageToolInput,
  redactPageTitle,
  sharedPageGeneration,
  sharedPageUpdateRequest,
} from "./page-share-update.js";
import { pageToolSecretError } from "./page-tool-request.js";
import { persistMessageInTransaction } from "./run-messages.js";

export interface PageToolContext {
  deps: { prisma: PrismaClient };
  run: { id: string; spaceId: string; userId: string; threadId: string; trigger: string };
  bot: { id: string };
  thread: { groupId: string | null };
  state: { tainted: boolean };
  secrets: string[];
  effect?: { id: string };
  approvedSharedPageRequest?: SharedPageUpdateRequest;
  lease: RunLease;
  notify?: (threadId: string, eventSeq: number, firstResponseRunId?: string) => Promise<void>;
}

const PageSaveReceiptSchema = z.strictObject({
  kind: z.literal("page_save"),
  saved: z.strictObject({
    pageId: z.string().min(1),
    version: PageVersionSchema,
    title: z.string().min(1).max(PAGE_TITLE_MAX_LENGTH),
  }),
  cardEventSeq: z.number().int().nonnegative().nullable(),
  sharedByLink: z.literal(true).optional(),
  warnings: z.array(z.string()).optional(),
});
type PageSaveReceipt = z.infer<typeof PageSaveReceiptSchema>;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function pageEffectScope(ctx: PageToolContext) {
  if (!ctx.effect) throw new Error("Page writes require an execution receipt.");
  return {
    id: ctx.effect.id,
    spaceId: ctx.run.spaceId,
    runId: ctx.run.id,
    kind: "save_page",
    run: { userId: ctx.run.userId, botId: ctx.bot.id, threadId: ctx.run.threadId },
  };
}

class InvalidPageSaveReceipt extends Error {}

async function readPageExecution(
  ctx: PageToolContext,
  args: Record<string, unknown>,
  prisma: Pick<PrismaClient, "externalEffect">,
  status?: "executing",
) {
  const effect = await prisma.externalEffect.findFirst({
    where: { ...pageEffectScope(ctx), ...(status ? { status } : {}) },
    select: { request: true, result: true },
  });
  const bound = sharedPageUpdateRequest(effect?.request);
  if (!effect || stableJsonValue(bound?.args ?? effect.request) !== stableJsonValue(args)) {
    throw new InvalidPageSaveReceipt("Stored page execution does not match this run and request.");
  }
  if (effect.result === null) return { bound };
  const receipt = PageSaveReceiptSchema.safeParse(effect.result);
  if (!receipt.success) {
    throw new InvalidPageSaveReceipt("Stored page execution has no valid save receipt.");
  }
  return { bound, receipt: receipt.data };
}

/** An earlier worker can settle the same receipt while this attempt is recovering it. */
export async function readCompletedPageToolResult(
  ctx: PageToolContext,
  args: Record<string, unknown>,
): Promise<unknown | undefined> {
  if (!ctx.effect) return undefined;
  const stored = await ctx.deps.prisma.externalEffect.findFirst({
    where: { ...pageEffectScope(ctx), status: "completed" },
    select: { request: true, result: true },
  });
  if (!stored) return undefined;
  const request = sharedPageUpdateRequest(stored.request)?.args ?? stored.request;
  if (stableJsonValue(request) !== stableJsonValue(args)) return undefined;
  return stored.result ?? undefined;
}

/** Recover only a committed save; an interrupted approved call must never execute a new write. */
export async function recoverSavedPageFromTool(
  ctx: PageToolContext,
  args: Record<string, unknown>,
) {
  let receipt: PageSaveReceipt | undefined;
  try {
    receipt = (await readPageExecution(ctx, args, ctx.deps.prisma, "executing")).receipt;
  } catch (error) {
    // Missing, mismatched and malformed receipts retain the ordinary uncertain-effect gate.
    // A database read failure propagates: it cannot establish that replay is safe.
    if (error instanceof InvalidPageSaveReceipt) return undefined;
    throw error;
  }
  return receipt ? savedPageResult(ctx, receipt) : undefined;
}

export async function savePageFromTool(ctx: PageToolContext, args: Record<string, unknown>) {
  const { deps, run, bot, thread } = ctx;
  if (args.help === true) return { guide: PAGE_KIT_GUIDE };
  const input = readPageToolInput(args);
  if ("error" in input) return input;
  const { pageId, source: providedSource, edits, title } = input;
  // Recover writes before reading the page or applying edits: a later change or deletion
  // must not turn this execution into another save.
  const reading = pageId && providedSource === undefined && edits === undefined && !title;
  const execution = reading ? undefined : await readPageExecution(ctx, args, deps.prisma);
  if (execution?.receipt) return savedPageResult(ctx, execution.receipt);
  const bound = execution?.bound;
  const claimed = ctx.approvedSharedPageRequest;
  if (stableJsonValue(bound ?? null) !== stableJsonValue(claimed ?? null))
    return pageChangedResult();

  const pageScope = pageToolScope(ctx);
  const page = pageId ? await loadToolPage(deps.prisma, pageScope, pageId) : null;
  if (pageId && !page)
    return bound
      ? pageChangedResult()
      : { error: "No page with that pageId belongs to this bot or chat." };
  const current = page?.versions[0]?.source ?? "";

  if (page && reading) {
    // A stored source may hold outside text an earlier run put in the page.
    ctx.state.tainted = true;
    return {
      pageId: page.id,
      version: page.currentVersion,
      title: redactSecrets(page.title, ctx.secrets),
      ...(sharedPageGeneration(page) ? { sharedByLink: true } : {}),
      source: redactSecrets(current, ctx.secrets),
    };
  }
  if (!page && edits !== undefined)
    return { error: "edits need the pageId of the page to change." };
  if (!page && providedSource === undefined) return { error: "A new page needs source." };
  if (!page && !title) return { error: "A new page needs a title." };
  if (!bound && page?.visibility === "link") {
    return { error: "The shared page needs approval before it can be updated.", unchanged: true };
  }

  const sharedContentProtected = () => page && containsSecret([page.title, current], ctx.secrets);
  if (bound && sharedContentProtected()) return protectedSharedPageResult();
  const candidate = compilePageCandidate(input, current, {
    secrets: ctx.secrets,
    shared: Boolean(bound),
  });
  if ("result" in candidate) return candidate.result;
  const { source, code, warnings } = candidate;
  const containsRunSecret = () => containsSecret([source, code], ctx.secrets);
  const safeTitle = () => (title === undefined ? undefined : redactPageTitle(title, ctx.secrets));
  if (bound && (!page || !matchesSharedPageCandidate(bound, page, candidate, safeTitle()))) {
    return pageChangedResult();
  }

  const effectScope = pageEffectScope(ctx);
  let committed: { receipt: PageSaveReceipt; firstResponseRunId?: string };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        // Take the thread before the run, as the shared history writer does. Both
        // the card and its event use this same transaction and lease fence.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM public.threads
        WHERE id = ${run.threadId} AND "spaceId" = ${run.spaceId}
          AND "userId" = ${run.userId} AND "groupId" IS NOT DISTINCT FROM ${thread.groupId}::text
        FOR UPDATE
      `;
        if (locked.length !== 1) throw new Error("Page execution is no longer writable.");
        // The effect serializes retries and keeps the exact request bound to one receipt.
        const held = await tx.externalEffect.updateMany({
          where: {
            ...effectScope,
            status: bound ? "executing" : { in: ["intended", "executing"] },
          },
          data: { updatedAt: new Date() },
        });
        if (held.count !== 1) throw new Error("Page execution is no longer writable.");
        const currentExecution = await readPageExecution(ctx, args, tx);
        if (currentExecution.receipt) return { receipt: currentExecution.receipt };
        if (stableJsonValue(currentExecution.bound ?? null) !== stableJsonValue(bound ?? null)) {
          throw new PageChangedError();
        }
        const writer = await assertRunCanWriteHistory(tx, run.id, { lease: ctx.lease });
        if (writer?.status !== "running" || writer.leaseOwner !== ctx.lease.owner) {
          throw new Error("Page execution is no longer writable.");
        }
        if (containsRunSecret()) throw new PageContainsSecretError();
        if (bound && sharedContentProtected()) throw new ProtectedSharedPageError();
        const nextRequestedTitle = safeTitle();
        let saved: PageSaveReceipt["saved"];
        if (!page) {
          const created = await tx.page.create({
            data: {
              spaceId: run.spaceId,
              userId: run.userId,
              botId: bot.id,
              groupId: thread.groupId,
              title: nextRequestedTitle!,
              versions: { create: { version: 1, title: nextRequestedTitle!, source, code } },
            },
          });
          saved = { pageId: created.id, version: 1, title: created.title };
        } else {
          const version = page.currentVersion + 1;
          if (!PageVersionSchema.safeParse(version).success) throw new PageVersionLimitError();
          if (bound && !matchesSharedPageCandidate(bound, page, candidate, nextRequestedTitle)) {
            throw new PageChangedError();
          }
          // Sharing changes independently of the version. Fence both together, and fence the
          // old title only if the approval explicitly showed its replacement.
          const moved = await tx.page.updateMany({
            where: {
              id: page.id,
              currentVersion: page.currentVersion,
              ...pageScope,
              ...(bound
                ? {
                    visibility: "link",
                    shareSecretId: page.shareSecretId,
                    shareTokenHash: page.shareTokenHash,
                    ...(nextRequestedTitle === undefined ? {} : { title: page.title }),
                  }
                : { visibility: "private", shareSecretId: null, shareTokenHash: null }),
            },
            data: { currentVersion: version, title: nextRequestedTitle, updatedAt: new Date() },
          });
          if (moved.count === 0) throw new PageChangedError();
          let nextTitle =
            nextRequestedTitle ??
            (await tx.page.findUniqueOrThrow({ where: { id: page.id }, select: { title: true } }))
              .title;
          // A title saved before this run learned a secret is redacted before it is shown again.
          const kept = redactPageTitle(nextTitle, ctx.secrets);
          if (kept !== nextTitle) {
            if (bound) throw new ProtectedSharedPageError();
            nextTitle = kept;
            await tx.page.update({ where: { id: page.id }, data: { title: kept } });
          }
          if (bound && containsRunSecret()) throw new PageContainsSecretError();
          await tx.pageVersion.create({
            data: { pageId: page.id, version, title: nextTitle, source, code },
          });
          saved = { pageId: page.id, version, title: nextTitle };
        }
        // A routine posts its first page only. Internal ticket runs do not post
        // Page cards into the chat, consistent with the ordinary message writer.
        const shouldPost =
          !isBackgroundRunTrigger(run.trigger) && (!page || run.trigger !== "routine");
        const block: MessageBlock = { kind: "page", ...saved };
        const card = shouldPost
          ? await persistMessageInTransaction(
              tx,
              { ...run, botId: bot.id },
              "bot",
              [block],
              undefined,
              `page-save:${effectScope.id}`,
              false,
              ctx.lease,
            )
          : undefined;
        const receipt: PageSaveReceipt = {
          kind: "page_save",
          saved,
          cardEventSeq: card?.eventSeq ?? null,
          ...(bound ? { sharedByLink: true as const } : {}),
          ...(warnings?.length
            ? { warnings: warnings.map((warning) => redactSecrets(warning, ctx.secrets)) }
            : {}),
        };
        await tx.externalEffect.update({
          where: { id: effectScope.id },
          data: { result: receipt },
        });
        return { receipt, firstResponseRunId: card?.firstResponseRunId };
      }),
    );
  } catch (error) {
    if (error instanceof PageContainsSecretError) return pageToolSecretError();
    if (error instanceof ProtectedSharedPageError) return protectedSharedPageResult();
    if (error instanceof PageVersionLimitError)
      return {
        error: "The page reached its version limit; save a new page instead.",
        unchanged: true,
      };
    if (error instanceof PageChangedError || isUniqueViolation(error)) {
      return pageChangedResult();
    }
    throw error;
  }
  return savedPageResult(ctx, committed.receipt, committed.firstResponseRunId);
}

async function savedPageResult(
  ctx: PageToolContext,
  receipt: PageSaveReceipt,
  firstResponseRunId?: string,
) {
  const { saved } = receipt;
  if (receipt.cardEventSeq !== null && ctx.notify) {
    // A lost commit reply can replay the cursor, but cannot create a second card.
    try {
      await ctx.notify(ctx.run.threadId, receipt.cardEventSeq, firstResponseRunId);
    } catch (error) {
      getLogger().error("page card realtime notification", error);
    }
  }
  const title = redactSecrets(saved.title, ctx.secrets);
  const linkText = title.replace(/[\\[\]]/g, "\\$&");
  const result = {
    ...saved,
    title,
    ...(receipt.sharedByLink ? { sharedByLink: true as const } : {}),
    mention: redactSecrets(
      `Mention it in your reply as [${linkText}](page:${saved.pageId})`,
      ctx.secrets,
    ),
  };
  return receipt.warnings?.length
    ? {
        ...result,
        warnings: receipt.warnings.map((warning) => redactSecrets(warning, ctx.secrets)),
      }
    : result;
}

class PageChangedError extends Error {}
class PageContainsSecretError extends Error {}
class ProtectedSharedPageError extends Error {}
class PageVersionLimitError extends Error {}
