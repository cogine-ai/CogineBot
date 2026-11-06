import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const PAGE_TITLE_MAX_LENGTH = 200;
export const PAGE_LIST_MAX_LIMIT = 60;
/** The most UTF-8 a page's source may be, wherever it comes from: a save or an import. */
export const PAGE_SOURCE_MAX_BYTES = 256 * 1024;

export function pageSourceBytes(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

/** Page source as stored: bounded before anything parses or compiles it. */
export const PageSourceSchema = z
  .string()
  // A string longer in UTF-16 than the limit is over it in UTF-8 too; skip encoding it.
  .max(PAGE_SOURCE_MAX_BYTES, { abort: true })
  .refine(
    (source) => pageSourceBytes(source) <= PAGE_SOURCE_MAX_BYTES,
    `Page source must fit within ${PAGE_SOURCE_MAX_BYTES} UTF-8 bytes`,
  );

export const PageVisibilitySchema = z.enum(["private", "link"]);
export type PageVisibility = z.infer<typeof PageVisibilitySchema>;

/**
 * A page title is one line: control characters and line breaks fold into single spaces, since
 * the title sits in pills, chips and `[title](page:id)` links that a break would cut.
 */
export const PageTitleSchema = z
  .string()
  .transform((title) => title.replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ").trim())
  .pipe(z.string().min(1).max(PAGE_TITLE_MAX_LENGTH));

export const PageSummarySchema = z.strictObject({
  id: Id,
  title: z.string().max(PAGE_TITLE_MAX_LENGTH),
  botId: Id.nullable(),
  groupId: Id.nullable(),
  visibility: PageVisibilitySchema,
  currentVersion: z.number().int().positive(),
  pinned: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export const PageDetailSchema = z.strictObject({
  ...PageSummarySchema.shape,
  /** The version shown; `currentVersion` is the newest. */
  version: z.number().int().positive(),
  /** The version's source compiled for the viewer, which carries no compiler. */
  code: z.string(),
  owner: z.strictObject({ name: z.string(), image: z.string().nullable() }),
  /** Set while anyone with the link can open the page. */
  shareUrl: z.string().nullable(),
});
export type PageDetail = z.infer<typeof PageDetailSchema>;
