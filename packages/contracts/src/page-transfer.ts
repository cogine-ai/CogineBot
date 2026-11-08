import * as z from "zod";
import { IsoDate } from "./ids.js";
import {
  PAGE_SOURCE_MAX_BYTES,
  PageInputIdSchema,
  PageTitleSchema,
  PageVersionSchema,
  pageSourceBytes,
} from "./pages.js";

// PostgreSQL text cannot store NUL or an unpaired UTF-16 surrogate.
const pgText = (value: string) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
const id = PageInputIdSchema.refine(pgText);
const title = z.string().refine(pgText).pipe(PageTitleSchema);
const date = IsoDate.refine((value) => Number.isFinite(Date.parse(value)));
const source = z
  .string()
  .refine(
    (value) =>
      value.length <= PAGE_SOURCE_MAX_BYTES &&
      pgText(value) &&
      pageSourceBytes(value) <= PAGE_SOURCE_MAX_BYTES,
  );

/** Portable Page data. Ownership, compiled code and sharing grants belong to one install. */
export const PageTransferRecordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("page"),
    id,
    botId: id.nullable(),
    groupId: id.nullable(),
    title,
    pinnedAt: date.nullable(),
    currentVersion: PageVersionSchema,
    createdAt: date,
    updatedAt: date,
  }),
  z.strictObject({
    type: z.literal("page_version"),
    id,
    pageId: id,
    version: PageVersionSchema,
    title,
    source,
    createdAt: date,
  }),
]);

export type PageTransferRecord = z.infer<typeof PageTransferRecordSchema>;
