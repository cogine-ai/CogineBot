import { createHash } from "node:crypto";
import type { SharedPageUpdateRequest } from "@rakazo/contracts";
import {
  MAX_SHARED_PAGE_APPROVAL_DETAIL_LENGTH,
  PAGE_TITLE_MAX_LENGTH,
  PageTitleSchema,
  PageVersionSchema,
  SHARED_PAGE_UPDATE_REQUEST_KIND,
  SharedPageUpdateRequestSchema,
} from "@rakazo/contracts";
import { containsSecret, redactSecrets, textBoundary } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { checkPageSource } from "@rakazo/page-kit/validate";
import {
  MAX_PAGE_EDITS,
  pageToolSecretError,
  preparePageToolRequest,
} from "./page-tool-request.js";
import type { PageToolContext } from "./page-tools.js";

type PageCandidateContext = Pick<PageToolContext, "deps" | "run" | "bot" | "thread" | "secrets">;
type PageToolError = { error: string; unchanged?: true; problems?: string[] };
type PageCandidate = { source: string; code: string; warnings?: string[] };
type ToolPage = {
  id: string;
  title: string;
  currentVersion: number;
  visibility: string;
  shareSecretId: string | null;
  shareTokenHash: string | null;
  versions: { source: string; version: number }[];
};

function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

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
  if (value.length > MAX_PAGE_EDITS) return `Send at most ${MAX_PAGE_EDITS} edits at once.`;
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

export function readPageToolInput(args: Record<string, unknown>) {
  const pageId = argumentGiven(args.pageId) ? String(args.pageId) : undefined;
  const hasSource = argumentGiven(args.source);
  // Serializers send unused optional fields blank, an empty list included.
  const hasEdits = Array.isArray(args.edits) ? args.edits.length > 0 : argumentGiven(args.edits);
  if (hasSource && hasEdits) return { error: "Send either source or edits, not both." };
  const title = argumentGiven(args.title) ? PageTitleSchema.safeParse(args.title) : undefined;
  if (title && !title.success) return { error: "title must be 1 to 200 characters." };
  return {
    pageId,
    source: hasSource ? String(args.source) : undefined,
    edits: hasEdits ? args.edits : undefined,
    title: title?.data,
  };
}

type PageToolInput = Exclude<ReturnType<typeof readPageToolInput>, { error: string }>;

export function pageToolScope({ run, bot, thread }: PageCandidateContext) {
  // Personal Pages follow their Bot; group Pages are reachable only in their original group.
  const reachable = thread.groupId
    ? [{ botId: bot.id, groupId: null }, { groupId: thread.groupId }]
    : [{ botId: bot.id, groupId: null }];
  return { spaceId: run.spaceId, userId: run.userId, OR: reachable };
}

export function loadToolPage(
  prisma: Pick<PrismaClient, "page">,
  pageScope: ReturnType<typeof pageToolScope>,
  pageId: string,
): Promise<ToolPage | null> {
  return prisma.page.findFirst({
    where: { id: pageId, ...pageScope },
    select: {
      id: true,
      title: true,
      currentVersion: true,
      visibility: true,
      shareSecretId: true,
      shareTokenHash: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { source: true, version: true } },
    },
  });
}

export function compilePageCandidate(
  input: PageToolInput,
  current: string,
  { secrets, shared }: { secrets: string[]; shared: boolean },
): PageCandidate | { result: PageToolError } {
  let source = input.source ?? current;
  if (input.edits !== undefined) {
    const edits = parseEdits(input.edits);
    if (typeof edits === "string") return { result: { error: edits, unchanged: true } };
    const applied = applyPageEdits(current, edits);
    if (!applied.ok) return { result: { error: applied.error, unchanged: true } };
    source = applied.source;
  }
  // Compiler diagnostics can show only a fragment of their input. A public
  // candidate must reject a known secret before any diagnostic is generated.
  if (shared && containsSecret(source, secrets)) return { result: pageToolSecretError() };
  const check = checkPageSource(source);
  if (!check.ok) {
    return {
      result: {
        error: "The page has problems; nothing was saved.",
        problems: check.errors.map((problem) => redactSecrets(problem, secrets)),
      },
    };
  }
  if (containsSecret([source, check.code], secrets)) return { result: pageToolSecretError() };
  return { source, code: check.code, warnings: check.warnings };
}

export function redactPageTitle(title: string, secrets: string[]): string {
  return redactSecrets(title, secrets)
    .slice(0, PAGE_TITLE_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "");
}

export function pageChangedResult(): PageToolError {
  return { error: "The page changed while saving; read it again and retry.", unchanged: true };
}

function digest(value: unknown) {
  return createHash("sha256").update(stableJsonValue(value)).digest("hex");
}

export function sharedPageGeneration(
  page: Pick<ToolPage, "visibility" | "shareSecretId" | "shareTokenHash">,
) {
  if (page.visibility !== "link" || !page.shareSecretId || !page.shareTokenHash) return undefined;
  return digest([page.shareSecretId, page.shareTokenHash]);
}

function candidateDigest(source: string, code: string, title: string | undefined) {
  return digest([source, code, title ?? null]);
}

export function matchesSharedPageCandidate(
  request: SharedPageUpdateRequest,
  page: ToolPage,
  candidate: { source: string; code: string },
  title: string | undefined,
) {
  const approved = request.page;
  return (
    approved.id === page.id &&
    approved.version === page.currentVersion &&
    page.versions[0]?.version === page.currentVersion &&
    approved.generation === sharedPageGeneration(page) &&
    approved.baseTitleDigest === (title === undefined ? undefined : digest(page.title)) &&
    approved.candidateDigest === candidateDigest(candidate.source, candidate.code, title)
  );
}

export function sharedPageUpdateRequest(value: unknown): SharedPageUpdateRequest | undefined {
  const parsed = SharedPageUpdateRequestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { args, page } = parsed.data;
  const input = preparePageToolRequest(args, []);
  if (!input.ok || input.mode !== "write" || input.args !== args) return undefined;
  const titled = typeof args.title === "string" && args.title.trim().length > 0;
  return titled === (page.baseTitleDigest !== undefined) ? parsed.data : undefined;
}

const CHANGE_CONTEXT = 40;

function literalText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\\]/gu, (character) =>
    character === "\\" ? "\\\\" : `\\u{${character.codePointAt(0)?.toString(16)}}`,
  );
}

/** Keep all changed text, with at most a little unchanged context on either side. */
function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  const next = after.split("\n");
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const removed = old.slice(start, old.length - end).join("\n");
  const added = next.slice(start, next.length - end).join("\n");
  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < added.length - head &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  )
    tail++;
  const cut = Math.max(0, head - CHANGE_CONTEXT);
  const keep = Math.max(0, tail - CHANGE_CONTEXT);
  const block = (lineCount: number, text: string, sign: string) => {
    if (!lineCount) return [];
    const left = textBoundary(text, cut);
    const right = text.length - keep;
    // When a cut falls in a surrogate pair, retain the complete character.
    const inclusiveRight = right + (textBoundary(text, right) === right ? 0 : 1);
    const shortened = text.slice(left, inclusiveRight);
    return shortened.split("\n").map((line, index, lines) => {
      const prefix = left && index === 0 ? "…" : "";
      const suffix = inclusiveRight < text.length && index === lines.length - 1 ? "…" : "";
      return `${sign} ${prefix}${literalText(line)}${suffix}`;
    });
  };
  return [
    ...block(old.length - end - start, removed, "-"),
    ...block(next.length - end - start, added, "+"),
  ];
}

export function protectedSharedPageResult(): PageToolError {
  return {
    error: "The shared page contains a secret. Turn off its link before editing it.",
    unchanged: true,
  };
}

/** The review binds the complete proposed write and current sharing generation. */
export async function prepareSharedPageUpdate(
  ctx: PageCandidateContext,
  args: Record<string, unknown>,
): Promise<
  undefined | { result: PageToolError } | { request: SharedPageUpdateRequest; title: string }
> {
  const prepared = preparePageToolRequest(args, ctx.secrets);
  if (!prepared.ok) return { result: prepared.result };
  if (prepared.mode !== "write") return undefined;
  // The caller already prepared and keyed these arguments. Learning a secret must
  // not silently substitute new arguments beneath that effect identity.
  if (prepared.args !== args) return { result: pageChangedResult() };
  const input = readPageToolInput(args);
  if ("error" in input || !input.pageId) return undefined;
  const page = await loadToolPage(ctx.deps.prisma, pageToolScope(ctx), input.pageId);
  if (page?.visibility !== "link") return undefined;
  const generation = sharedPageGeneration(page);
  const current = page.versions[0];
  if (!generation || current?.version !== page.currentVersion)
    return { result: pageChangedResult() };
  if (!PageVersionSchema.safeParse(page.currentVersion + 1).success) {
    return {
      result: {
        error: "The page reached its version limit; save a new page instead.",
        unchanged: true,
      },
    };
  }
  // Check the whole old source before extracting fragments so a clipped secret cannot leak.
  if (containsSecret([page.title, current.source], ctx.secrets)) {
    return { result: protectedSharedPageResult() };
  }
  const candidate = compilePageCandidate(input, current.source, {
    secrets: ctx.secrets,
    shared: true,
  });
  if ("result" in candidate) return { result: candidate.result };
  const title = input.title === undefined ? undefined : redactPageTitle(input.title, ctx.secrets);
  const lines = [
    ...(title === undefined
      ? []
      : [`- Title: ${literalText(page.title)}`, `+ Title: ${literalText(title)}`]),
    ...changedLines(current.source, candidate.source),
  ];
  const detail = lines.join("\n") || "No source changes.";
  if (detail.length > MAX_SHARED_PAGE_APPROVAL_DETAIL_LENGTH) {
    return {
      result: {
        error: "This change is too long to review. Save it as several smaller edits.",
        unchanged: true,
      },
    };
  }
  const literalTitle = literalText(page.title);
  const reviewTitle = literalTitle.length <= PAGE_TITLE_MAX_LENGTH ? literalTitle : "Shared page";
  if (containsSecret([detail, reviewTitle], ctx.secrets)) {
    return { result: protectedSharedPageResult() };
  }
  const request: SharedPageUpdateRequest = {
    requestKind: SHARED_PAGE_UPDATE_REQUEST_KIND,
    args,
    page: {
      id: page.id,
      version: page.currentVersion,
      generation,
      candidateDigest: candidateDigest(candidate.source, candidate.code, title),
      title: reviewTitle,
      ...(title === undefined ? {} : { baseTitleDigest: digest(page.title) }),
    },
    detail,
  };
  return { request, title: request.page.title };
}
