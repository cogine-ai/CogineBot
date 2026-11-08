import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Shared public renderer asset served without account credentials. */
export const PAGE_RUNTIME_PATH = "/api/v1/assets/page-runtime.js";
export const SHARED_PAGE_PATH_PREFIX = "/api/v1/pages/shared/";

/** Classify the sensitive API namespace for credentials and logs, never for authorization. */
export function isPageShareApiPath(pathname: string): boolean {
  return isSensitiveNamespace(pathname, SHARED_PAGE_PATH_PREFIX.slice(0, -1));
}

/** Also recognize aliases a server or proxy could normalize into the document route. */
export function isSensitivePageShareDocumentPath(pathname: string): boolean {
  return isSensitiveNamespace(pathname, "/p");
}

function isSensitiveNamespace(pathname: string, prefix: string): boolean {
  // Decode individual escapes so a malformed suffix cannot hide an encoded namespace.
  const normalized = pathname
    .replace(/%([0-9a-f]{2})/gi, (_, byte: string) =>
      String.fromCharCode(Number.parseInt(byte, 16)),
    )
    .toLowerCase()
    .replace(/[\\/]+/g, "/");
  const matches = (path: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (matches(normalized)) return true;
  return (
    normalized.startsWith("/") &&
    /\/\.{1,2}(?:\/|$)/.test(normalized) &&
    matches(new URL(normalized, "http://localhost").pathname)
  );
}

export function isPageShareDocumentPath(pathname: string): boolean {
  // %70 is the encoded form of the route segment. Encoded separators are not routes.
  return /^\/(?:p|%70)(?:\/|$)/.test(pathname);
}

export const PAGE_TITLE_MAX_LENGTH = 200;
export const PAGE_LIST_MAX_LIMIT = 60;
export const PAGE_LIST_QUERY_MAX_LENGTH = 200;
/** The most UTF-8 a page's source may be, wherever it comes from: a save or an import. */
export const PAGE_SOURCE_MAX_BYTES = 256 * 1024;

export function pageSourceBytes(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

export const PageVisibilitySchema = z.literal("private");
export type PageVisibility = z.infer<typeof PageVisibilitySchema>;

/** Page queries send these identifiers directly to PostgreSQL text filters. */
export const PageInputIdSchema = Id.refine((id) => !id.includes("\0"));

/** 32 random bytes as base64url. */
const PAGE_SHARE_TOKEN_LENGTH = 43;

/** The readable title prefix is decorative. Only the last 43 characters are the token. */
export function pageShareUrl(webOrigin: string, title: string, token: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return new URL(`/p/${slug ? `${slug}-` : ""}${token}`, webOrigin).href;
}

export function pageShareTokenFromSlug(segment: string): string | null {
  const token = segment.slice(-PAGE_SHARE_TOKEN_LENGTH);
  return token.length === PAGE_SHARE_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

/**
 * A page title is one line: control characters and line breaks fold into single spaces, since
 * the title sits in pills, chips and `[title](page:id)` links that a break would cut.
 */
export function normalizePageTitle(title: string): string {
  return title.replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ").trim();
}

export const PageTitleSchema = z
  .string()
  .transform(normalizePageTitle)
  .pipe(z.string().min(1).max(PAGE_TITLE_MAX_LENGTH));

/** The reader may identify a fallback Page; its title is resolved by the server. */
export const PageReplyContextSchema = z.strictObject({ pageId: PageInputIdSchema });
export type PageReplyContext = z.infer<typeof PageReplyContextSchema>;

/** Server-generated provenance for exactly one automatic Page reference in a text block. */
export const PageTextContextSchema = z.strictObject({
  pageId: Id,
  title: z
    .string()
    .min(1)
    .max(PAGE_TITLE_MAX_LENGTH)
    .refine((title) => {
      const parsed = PageTitleSchema.safeParse(title);
      return parsed.success && parsed.data === title;
    }),
});
export type PageTextContext = z.infer<typeof PageTextContextSchema>;

export const PageVersionSchema = z.number().int().min(1).max(2_147_483_647);

export const PageShareInputSchema = z.discriminatedUnion("visibility", [
  z.strictObject({ pageId: PageInputIdSchema, visibility: z.literal("private") }),
  z.strictObject({
    pageId: PageInputIdSchema,
    visibility: z.literal("link"),
    expectedVersion: PageVersionSchema,
    expectedTitle: PageTitleSchema,
  }),
]);
export type PageShareInput = z.infer<typeof PageShareInputSchema>;

/** The owner can revoke a dormant link without retrieving its token. */
export const PageShareStateSchema = z.union([
  z.strictObject({
    visibility: z.literal("private"),
    publishingEnabled: z.boolean(),
    shareUrl: z.null(),
    generation: z.null(),
  }),
  z.strictObject({
    visibility: z.literal("link"),
    publishingEnabled: z.literal(false),
    shareUrl: z.null(),
    generation: z.null(),
  }),
  z.strictObject({
    visibility: z.literal("link"),
    publishingEnabled: z.literal(true),
    shareUrl: z.url(),
    generation: Id,
  }),
]);
export type PageShareState = z.infer<typeof PageShareStateSchema>;

export const SharedPageSchema = z.strictObject({
  title: z.string().max(PAGE_TITLE_MAX_LENGTH),
  code: z.string(),
  version: PageVersionSchema,
  updatedAt: IsoDate,
});
export type SharedPage = z.infer<typeof SharedPageSchema>;

export const SHARED_PAGE_UPDATE_REQUEST_KIND = "shared_page_update";
export const MAX_SHARED_PAGE_APPROVAL_DETAIL_LENGTH = 4_000;
const pageApprovalDigest = z.string().regex(/^[a-f0-9]{64}$/);

export const SharedPageUpdateRequestSchema = z
  .strictObject({
    requestKind: z.literal(SHARED_PAGE_UPDATE_REQUEST_KIND),
    args: z.record(z.string(), z.unknown()),
    page: z.strictObject({
      id: PageInputIdSchema,
      version: PageVersionSchema,
      generation: pageApprovalDigest,
      candidateDigest: pageApprovalDigest,
      title: z.string().min(1).max(PAGE_TITLE_MAX_LENGTH),
      baseTitleDigest: pageApprovalDigest.optional(),
    }),
    detail: z.string().min(1).max(MAX_SHARED_PAGE_APPROVAL_DETAIL_LENGTH),
  })
  .refine((request) => request.args.pageId === request.page.id);
export type SharedPageUpdateRequest = z.infer<typeof SharedPageUpdateRequestSchema>;

export function sharedPageUpdateApprovalTitle(title: string): string {
  return `Update shared page “${title}”?`;
}

export const PageSummarySchema = z.strictObject({
  id: Id,
  title: z.string().max(PAGE_TITLE_MAX_LENGTH),
  botId: Id.nullable(),
  groupId: Id.nullable(),
  visibility: PageVisibilitySchema,
  /** Owner-scoped status only. The link is fetched separately. */
  sharedByLink: z.boolean().optional(),
  currentVersion: PageVersionSchema,
  pinned: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export const PageDetailSchema = z.strictObject({
  ...PageSummarySchema.shape,
  /** The version shown; `currentVersion` is the newest. */
  version: PageVersionSchema,
  /** The version's source compiled for the viewer, which carries no compiler. */
  code: z.string(),
  owner: z.strictObject({ name: z.string(), image: z.string().nullable() }),
});
export type PageDetail = z.infer<typeof PageDetailSchema>;
