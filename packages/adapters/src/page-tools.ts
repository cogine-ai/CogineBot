import type { MessageBlock } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH, PageTitleSchema } from "@rakazo/contracts";
import { containsSecret, redactSecrets } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { checkPageSource, PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import { z } from "zod";

export interface PageToolContext {
  deps: { prisma: PrismaClient };
  run: { id: string; spaceId: string; userId: string; threadId: string; trigger: string };
  bot: { id: string };
  thread: { groupId: string | null };
  state: { tainted: boolean };
  secrets: string[];
  effect: { id: string };
  publish: (blocks: MessageBlock[], clientNonce?: string) => Promise<unknown>;
}

const PageSaveReceiptSchema = z.object({
  kind: z.literal("page_save"),
  saved: z.object({
    pageId: z.string().min(1),
    version: z.number().int().positive(),
    title: z.string(),
  }),
  publish: z.boolean(),
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
  return receipt ? publishSavedPage(ctx, receipt) : undefined;
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
    title = redactSecrets(parsed.data, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
  }
  // Reads retain their source/taint contract. Recover writes before reading the page or
  // applying edits: a later change or deletion must not turn this execution into another save.
  const reading = pageId && !hasSource && !hasEdits && !title;
  const previous = !reading ? await readPageSaveReceipt(ctx, args, deps.prisma) : undefined;
  if (previous) return publishSavedPage(ctx, previous);

  // A bot reuses its personal pages across chats and routines. A group Page belongs to
  // the current group, even when this bot made it; other contexts answer as for a missing page.
  const reachable = thread.groupId
    ? [{ botId: bot.id, groupId: null }, { groupId: thread.groupId }]
    : [{ botId: bot.id, groupId: null }];
  const page = pageId
    ? await deps.prisma.page.findFirst({
        where: { id: pageId, spaceId: run.spaceId, userId: run.userId, OR: reachable },
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
    return { error: "The page has problems; nothing was saved.", problems: check.errors };
  }
  // A page can be shared by link, so it never stores a value this run keeps secret.
  if (containsSecret([source, check.code], ctx.secrets)) {
    return {
      error: "The page contains a secret value; nothing was saved. Remove it and save again.",
      unchanged: true,
    };
  }

  let receipt: PageSaveReceipt;
  try {
    receipt = await deps.prisma.$transaction(async (tx) => {
      // This existing effect row serializes only retries of this save. Its receipt and
      // the Page write commit together, including when a worker loses the commit reply.
      const held = await tx.externalEffect.updateMany({
        where: { ...effectScope, status: { in: ["intended", "executing"] } },
        data: { updatedAt: new Date() },
      });
      if (held.count !== 1) throw new Error("Page execution is no longer writable.");
      const previous = await readPageSaveReceipt(ctx, args, tx);
      if (previous) return previous;
      let saved: PageSaveReceipt["saved"];
      if (!page) {
        const created = await tx.page.create({
          data: {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: bot.id,
            groupId: thread.groupId,
            title: title!,
            versions: { create: { version: 1, title: title!, source, code: check.code } },
          },
        });
        saved = { pageId: created.id, version: 1, title: created.title };
      } else {
        const version = page.currentVersion + 1;
        // Conditional on the version this change was built from, so two saves never interleave.
        // With no new title the page keeps its current one, even a rename made after the read.
        const moved = await tx.page.updateMany({
          where: { id: page.id, currentVersion: page.currentVersion },
          data: { currentVersion: version, title, updatedAt: new Date() },
        });
        if (moved.count === 0) throw new PageChangedError();
        let nextTitle =
          title ??
          (await tx.page.findUniqueOrThrow({ where: { id: page.id }, select: { title: true } }))
            .title;
        // A title saved before this run learned a secret is redacted before it is shown again.
        const kept = redactSecrets(nextTitle, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
        if (kept !== nextTitle) {
          nextTitle = kept;
          await tx.page.update({ where: { id: page.id }, data: { title: kept } });
        }
        await tx.pageVersion.create({
          data: { pageId: page.id, version, title: nextTitle, source, code: check.code },
        });
        saved = { pageId: page.id, version, title: nextTitle };
      }
      const receipt: PageSaveReceipt = {
        kind: "page_save",
        saved,
        publish: !page || run.trigger !== "routine",
        ...(check.warnings?.length ? { warnings: check.warnings } : {}),
      };
      await tx.externalEffect.update({
        where: { id: ctx.effect.id },
        data: { result: receipt },
      });
      return receipt;
    });
  } catch (error) {
    if (error instanceof PageChangedError || isUniqueViolation(error)) {
      return { error: "The page changed while saving; read it again and retry.", unchanged: true };
    }
    throw error;
  }
  return publishSavedPage(ctx, receipt);
}

async function publishSavedPage(ctx: PageToolContext, receipt: PageSaveReceipt) {
  const { saved } = receipt;
  const block: MessageBlock = { kind: "page", ...saved };
  const linkText = saved.title.replace(/[\\[\]]/g, "\\$&");
  try {
    // A routine speaks only through its final reply, which may be silence, so refreshing a
    // page it already showed posts no card; its first save still does.
    if (receipt.publish) {
      const nonce = `page-save:${ctx.effect.id}`;
      const findCard = () =>
        ctx.deps.prisma.message.findUnique({
          where: { threadId_clientNonce: { threadId: ctx.run.threadId, clientNonce: nonce } },
          select: { id: true },
        });
      if (!(await findCard())) {
        try {
          await ctx.publish([block], nonce);
        } catch (error) {
          // Message and event are committed by the existing publisher in one transaction;
          // a concurrent delivery's unique-key loser rolls both back.
          if (!isUniqueViolation(error) || !(await findCard())) throw error;
        }
      }
    }
  } catch (error) {
    // The page is saved; only its card in the chat is missing, so the bot can still link it.
    return {
      ...saved,
      error: `The page was saved, but its card could not be posted in the chat (${
        error instanceof Error ? error.message : "unknown error"
      }). Link it in your reply as [${linkText}](page:${saved.pageId}).`,
    };
  }
  const result = {
    ...saved,
    mention: `Mention it in your reply as [${linkText}](page:${saved.pageId})`,
  };
  return receipt.warnings?.length ? { ...result, warnings: receipt.warnings } : result;
}

class PageChangedError extends Error {}
