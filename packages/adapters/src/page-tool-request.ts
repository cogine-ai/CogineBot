import {
  normalizePageTitle,
  PAGE_SOURCE_MAX_BYTES,
  PAGE_TITLE_MAX_LENGTH,
  PageInputIdSchema,
  PageTitleSchema,
} from "@rakazo/contracts";
import { containsSecret, redactSecrets } from "@rakazo/core";
import { z } from "zod";

export const SAVE_PAGE_TOOL = "save_page";
export const MAX_PAGE_EDITS = 50;

// JSON can spell a lone surrogate, but PostgreSQL cannot store it in JSONB or text.
const pageUnicode = (text: string) => !text.includes("\0") && !/[\uD800-\uDFFF]/u.test(text);
const pageSourceString = z
  .string()
  .refine((text) => pageUnicode(text) && Buffer.byteLength(text, "utf8") <= PAGE_SOURCE_MAX_BYTES);
const blank = z.string().refine((text) => text.trim().length === 0 && pageUnicode(text));
const requestSchema = z.strictObject({
  help: z.boolean().nullish(),
  pageId: z.union([PageInputIdSchema.refine(pageUnicode), blank]).nullish(),
  title: pageSourceString.nullish(),
  source: pageSourceString.nullish(),
  edits: z
    .union([
      z
        .array(z.strictObject({ find: pageSourceString.min(1), replace: pageSourceString }))
        .max(MAX_PAGE_EDITS),
      blank,
    ])
    .nullish(),
});

export function pageToolSecretError() {
  return {
    error: "The page contains a secret value; nothing was saved. Remove it and save again.",
    unchanged: true as const,
  };
}

/** Validate before hashing, approval, or persistence. Preserve valid serializer blanks and exact JSX. */
export function preparePageToolRequest(
  args: Record<string, unknown>,
  secrets: string[],
):
  | { ok: true; args: Record<string, unknown>; mode: "help" | "read" | "write" }
  | { ok: false; result: { error: string; unchanged: true } } {
  const reject = (error: string) => ({
    ok: false as const,
    result: { error, unchanged: true as const },
  });
  const checked = requestSchema.safeParse(args);
  if (!checked.success)
    return reject("Invalid Page arguments. Check the field types and the Page source size.");
  const { help, pageId, source, edits, title } = checked.data;
  if (containsSecret([pageId, source, edits], secrets)) {
    return { ok: false, result: pageToolSecretError() };
  }

  const titleValue = title?.trim() ? PageTitleSchema.safeParse(title) : undefined;
  if (titleValue && !titleValue.success) return reject("title must be 1 to 200 characters.");
  const safeTitle = titleValue
    ? redactSecrets(normalizePageTitle(redactSecrets(title!, secrets)), secrets)
        .slice(0, PAGE_TITLE_MAX_LENGTH)
        .replace(/[\uD800-\uDBFF]$/u, "")
    : title;
  const prepared = safeTitle === title ? args : { ...args, title: safeTitle };
  if (help) return { ok: true, args: prepared, mode: "help" };

  const writingSource = Boolean(source?.trim());
  const writingEdits = Array.isArray(edits) && edits.length > 0;
  if (writingSource && writingEdits) return reject("Send either source or edits, not both.");
  if (!pageId?.trim()) {
    if (writingEdits) return reject("edits need the pageId of the page to change.");
    if (!writingSource) return reject("A new page needs source.");
    if (!titleValue) return reject("A new page needs a title.");
  }
  const mode = writingSource || writingEdits || titleValue ? "write" : "read";
  return { ok: true, args: prepared, mode };
}

const rejectedScriptedPageArgs = Object.freeze({ help: Object.freeze({}) });

/** Recovered input is either unchanged, or rejected without copying raw data into the next checkpoint. */
export function preparePageToolScriptArguments(
  args: Record<string, unknown>,
  secrets: string[],
  revalidate: boolean,
): Record<string, unknown> {
  if (args === rejectedScriptedPageArgs) return args;
  const prepared = preparePageToolRequest(args, secrets);
  return prepared.ok && (!revalidate || prepared.args === args)
    ? prepared.args
    : rejectedScriptedPageArgs;
}
