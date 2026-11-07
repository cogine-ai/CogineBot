import type { MessageBlock } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH, PageTitleSchema, PageVersionSchema } from "@rakazo/contracts";
import { containsSecret, isBackgroundRunTrigger, redactSecrets } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient, RunLease } from "@rakazo/db";
import { assertRunCanWriteHistory, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { checkPageSource, PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import { z } from "zod";
import { persistMessageInTransaction } from "./run-messages.js";

export interface PageToolContext {
  deps: { prisma: PrismaClient };
  run: { id: string; spaceId: string; userId: string; threadId: string; trigger: string };
  bot: { id: string };
  thread: { groupId: string | null };
  state: { tainted: boolean };
  secrets: string[];
  effect: { id: string };
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
  warnings: z.array(z.string()).optional(),
});
type PageSaveReceipt = z.infer<typeof PageSaveReceiptSchema>;

function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

const MAX_EDITS = 50;

type PageEdit = { find: string; replace: string };

/** All edits or none: each `find` must occur exactly once in the result of the edits before it. */
function applyPageEdits(
  source: string,
  edits: readonly PageEdit[],
): { ok: true; source: string } | { ok: false; error: string } {
  let next = source;
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    if (!edit.find) return { ok: false, error: `${label}: find is empty.` };
    const at = next.indexOf(edit.find);
    if (at === -1) return { ok: false, error: `${label}: find text was not found in the page.` };
    if (next.indexOf(edit.find, at + 1) !== -1) {
      return {
        ok: false,
        error: `${label}: find text occurs more than once; include more surrounding text.`,
      };
    }
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  }
  return { ok: true, source: next };
}

function parseEdits(value: unknown): PageEdit[] | string {
  if (!Array.isArray(value) || value.length === 0) return "edits must be a non-empty list.";
  if (value.length > MAX_EDITS) return `Send at most ${MAX_EDITS} edits at once.`;
  const edits: PageEdit[] = [];
  for (const [index, item] of value.entries()) {
    const edit = item as Partial<PageEdit> | null;
    if (typeof edit?.find !== "string" || typeof edit.replace !== "string") {
      return `Edit ${index + 1}: needs find and replace strings.`;
    }
    edits.push({ find: edit.find, replace: edit.replace });
  }
  return edits;
}

function pageEffectScope(ctx: PageToolContext) {
  return {
    id: ctx.effect.id,
    spaceId: ctx.run.spaceId,
    runId: ctx.run.id,
    kind: "save_page",
    run: { userId: ctx.run.userId, botId: ctx.bot.id, threadId: ctx.run.threadId },
  };
}

class InvalidPageSaveReceipt extends Error {}

async function readPageSaveReceipt(
  ctx: PageToolContext,
  args: Record<string, unknown>,
  prisma: Pick<PrismaClient, "externalEffect">,
  status?: "executing",
) {
  const effect = await prisma.externalEffect.findFirst({
    where: { ...pageEffectScope(ctx), ...(status ? { status } : {}) },
    select: { request: true, result: true },
  });
  const request = stableJsonValue(args);
  if (!effect || stableJsonValue(effect.request) !== request) {
    throw new InvalidPageSaveReceipt("Stored page execution does not match this run and request.");
  }
  if (effect.result === null) return undefined;
  const receipt = PageSaveReceiptSchema.safeParse(effect.result);
  if (!receipt.success) {
    throw new InvalidPageSaveReceipt("Stored page execution has no valid save receipt.");
  }
  return receipt.data;
}

/** Recover only a committed save; an interrupted approved call must never execute a new write. */
export async function recoverSavedPageFromTool(
  ctx: PageToolContext,
  args: Record<string, unknown>,
) {
  let receipt: PageSaveReceipt | undefined;
  try {
    receipt = await readPageSaveReceipt(ctx, args, ctx.deps.prisma, "executing");
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
  const effectScope = pageEffectScope(ctx);
  const pageId = argumentGiven(args.pageId) ? String(args.pageId) : undefined;
  const hasSource = argumentGiven(args.source);
  // Serializers send unused optional fields blank, an empty list included.
  const hasEdits = Array.isArray(args.edits) ? args.edits.length > 0 : argumentGiven(args.edits);
  if (hasSource && hasEdits) return { error: "Send either source or edits, not both." };
  let title: string | undefined;
  if (argumentGiven(args.title)) {
    const parsed = PageTitleSchema.safeParse(args.title);
    if (!parsed.success) return { error: "title must be 1 to 200 characters." };
    title = parsed.data;
  }
  // Reads retain their source/taint contract. Recover writes before reading the page or
  // applying edits: a later change or deletion must not turn this execution into another save.
  const reading = pageId && !hasSource && !hasEdits && !title;
  const previous = !reading ? await readPageSaveReceipt(ctx, args, deps.prisma) : undefined;
  if (previous) return savedPageResult(ctx, previous);

  // A bot reuses its personal pages across chats and routines. A group Page belongs to
  // the current group, even when this bot made it; other contexts answer as for a missing page.
  const reachable = thread.groupId
    ? [{ botId: bot.id, groupId: null }, { groupId: thread.groupId }]
    : [{ botId: bot.id, groupId: null }];
  const pageScope = { spaceId: run.spaceId, userId: run.userId, OR: reachable };
  const page = pageId
    ? await deps.prisma.page.findFirst({
        where: { id: pageId, ...pageScope },
        select: {
          id: true,
          title: true,
          currentVersion: true,
          versions: { orderBy: { version: "desc" }, take: 1, select: { source: true } },
        },
      })
    : null;
  if (pageId && !page) return { error: "No page with that pageId belongs to this bot or chat." };
  const current = page?.versions[0]?.source ?? "";

  if (page && !hasSource && !hasEdits && !title) {
    // The stored source may hold outside text an earlier run put in the page, so reading it
    // taints this run like any other outside content; saves only confirm this run's own write.
    ctx.state.tainted = true;
    return {
      pageId: page.id,
      version: page.currentVersion,
      title: redactSecrets(page.title, ctx.secrets),
      source: redactSecrets(current, ctx.secrets),
    };
  }
  if (!page && hasEdits) return { error: "edits need the pageId of the page to change." };
  if (!page && !hasSource) return { error: "A new page needs source." };
  if (!page && !title) return { error: "A new page needs a title." };

  let source = hasSource ? String(args.source) : current;
  if (hasEdits) {
    const edits = parseEdits(args.edits);
    if (typeof edits === "string") return { error: edits, unchanged: true };
    const applied = applyPageEdits(current, edits);
    if (!applied.ok) return { error: applied.error, unchanged: true };
    source = applied.source;
  }
  const check = checkPageSource(source);
  if (!check.ok) {
    return {
      error: "The page has problems; nothing was saved.",
      problems: check.errors.map((problem) => redactSecrets(problem, ctx.secrets)),
    };
  }
  // Saved Page source and compiled output must not persist values this run keeps secret.
  const containsRunSecret = () => containsSecret([source, check.code], ctx.secrets);
  if (containsRunSecret()) return secretValueResult();

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
          where: { ...effectScope, status: { in: ["intended", "executing"] } },
          data: { updatedAt: new Date() },
        });
        if (held.count !== 1) throw new Error("Page execution is no longer writable.");
        const previous = await readPageSaveReceipt(ctx, args, tx);
        if (previous) return { receipt: previous };
        const writer = await assertRunCanWriteHistory(tx, run.id, { lease: ctx.lease });
        if (writer?.status !== "running" || writer.leaseOwner !== ctx.lease.owner) {
          throw new Error("Page execution is no longer writable.");
        }
        if (containsRunSecret()) throw new PageContainsSecretError();
        const safeTitle = title === undefined ? undefined : redactPageTitle(title, ctx.secrets);
        let saved: PageSaveReceipt["saved"];
        if (!page) {
          const created = await tx.page.create({
            data: {
              spaceId: run.spaceId,
              userId: run.userId,
              botId: bot.id,
              groupId: thread.groupId,
              title: safeTitle!,
              versions: { create: { version: 1, title: safeTitle!, source, code: check.code } },
            },
          });
          saved = { pageId: created.id, version: 1, title: created.title };
        } else {
          const version = page.currentVersion + 1;
          if (!PageVersionSchema.safeParse(version).success) throw new PageVersionLimitError();
          // Conditional on the version this change was built from, so two saves never interleave.
          // With no new title the page keeps its current one, even a rename made after the read.
          const moved = await tx.page.updateMany({
            where: { id: page.id, currentVersion: page.currentVersion, ...pageScope },
            data: { currentVersion: version, title: safeTitle, updatedAt: new Date() },
          });
          if (moved.count === 0) throw new PageChangedError();
          let nextTitle =
            safeTitle ??
            (await tx.page.findUniqueOrThrow({ where: { id: page.id }, select: { title: true } }))
              .title;
          // A title saved before this run learned a secret is redacted before it is shown again.
          const kept = redactPageTitle(nextTitle, ctx.secrets);
          if (kept !== nextTitle) {
            nextTitle = kept;
            await tx.page.update({ where: { id: page.id }, data: { title: kept } });
          }
          await tx.pageVersion.create({
            data: { pageId: page.id, version, title: nextTitle, source, code: check.code },
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
              `page-save:${ctx.effect.id}`,
              false,
              ctx.lease,
            )
          : undefined;
        const receipt: PageSaveReceipt = {
          kind: "page_save",
          saved,
          cardEventSeq: card?.eventSeq ?? null,
          ...(check.warnings?.length
            ? { warnings: check.warnings.map((warning) => redactSecrets(warning, ctx.secrets)) }
            : {}),
        };
        await tx.externalEffect.update({
          where: { id: ctx.effect.id },
          data: { result: receipt },
        });
        return { receipt, firstResponseRunId: card?.firstResponseRunId };
      }),
    );
  } catch (error) {
    if (error instanceof PageContainsSecretError) return secretValueResult();
    if (error instanceof PageVersionLimitError)
      return {
        error: "The page reached its version limit; save a new page instead.",
        unchanged: true,
      };
    if (error instanceof PageChangedError || isUniqueViolation(error)) {
      return { error: "The page changed while saving; read it again and retry.", unchanged: true };
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

function redactPageTitle(title: string, secrets: string[]): string {
  return redactSecrets(title, secrets)
    .slice(0, PAGE_TITLE_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "");
}

function secretValueResult() {
  return {
    error: "The page contains a secret value; nothing was saved. Remove it and save again.",
    unchanged: true,
  };
}

class PageChangedError extends Error {}
class PageContainsSecretError extends Error {}
class PageVersionLimitError extends Error {}
