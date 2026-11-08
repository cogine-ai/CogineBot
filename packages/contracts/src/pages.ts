import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Shared public renderer asset served without account credentials. */
export const PAGE_RUNTIME_PATH = "/api/v1/assets/page-runtime.js";

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

export const PageSummarySchema = z.strictObject({
  id: Id,
  title: z.string().max(PAGE_TITLE_MAX_LENGTH),
  botId: Id.nullable(),
  groupId: Id.nullable(),
  visibility: PageVisibilitySchema,
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
