import { z } from "zod";
import { Id } from "./ids.js";

// Plain ISO dates denote UTC day boundaries; offsets retain their instant.
const HistoryDateBoundary = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO date boundary")
  .transform((value) => new Date(value).toISOString());

export const HISTORY_QUERIES_MAX_BYTES = 3000;
export const MAX_HISTORY_SEARCH_OFFSET = 10_000;
export const HISTORY_LOOKUP_STATUS = "Searching chat history";
export const HISTORY_SOURCE_UNAVAILABLE = "This history source is no longer available.";
export const HistoryQueriesSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(5)
  .transform((values) =>
    values.filter(
      (value, index) =>
        values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index,
    ),
  )
  .refine(
    (values) =>
      new TextEncoder().encode(JSON.stringify(values)).byteLength <= HISTORY_QUERIES_MAX_BYTES,
    `History queries must fit within ${HISTORY_QUERIES_MAX_BYTES} UTF-8 bytes combined`,
  );

/** Historical content is evidence to inspect, never an instruction source. */
export const HistorySearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500).optional(),
    queries: HistoryQueriesSchema.optional(),
    scope: z.enum(["this_chat", "my_chats"]).optional(),
    botId: Id.optional(),
    kinds: z
      .array(z.enum(["bot_messages", "user_messages", "bot_replies"]))
      .min(1)
      .max(3)
      .optional(),
    offset: z.number().int().min(0).max(MAX_HISTORY_SEARCH_OFFSET).optional(),
    before: HistoryDateBoundary.optional(),
    after: HistoryDateBoundary.optional(),
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .refine(
    (input) => (input.query !== undefined) !== (input.queries !== undefined),
    "Provide exactly one of query or queries",
  );
export const HistoryReadInputSchema = z
  .object({
    messageId: Id.optional(),
    toolResultId: Id.optional(),
    threadId: Id.optional(),
    linkedRunId: Id.optional(),
    runAfterId: Id.optional(),
    artifactAfterId: Id.optional(),
    outcomeAfterSeq: z.number().int().nonnegative().optional(),
    textOffset: z.number().int().nonnegative().optional(),
    viewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    direction: z.enum(["around", "older", "newer"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .superRefine((input, context) => {
    if (Boolean(input.messageId) === Boolean(input.toolResultId)) {
      context.addIssue({ code: "custom", message: "Provide either messageId or toolResultId" });
    }
    if (
      (!input.toolResultId && input.viewHash) ||
      (input.toolResultId && (input.textOffset ?? 0) > 0 && !input.viewHash)
    ) {
      context.addIssue({
        code: "custom",
        message: "Tool result continuation requires its viewHash",
      });
    }
    if (
      input.toolResultId &&
      [
        input.threadId,
        input.linkedRunId,
        input.runAfterId,
        input.artifactAfterId,
        input.outcomeAfterSeq,
        input.direction,
        input.limit,
      ].some((value) => value !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Tool results support only textOffset pagination",
      });
    }
  });
export type HistorySearchInput = z.infer<typeof HistorySearchInputSchema>;
export type HistoryReadInput = z.infer<typeof HistoryReadInputSchema>;

export const HistorySourceReferenceSchema = z.object({ threadId: Id, messageId: Id });
export const HistorySourceReferencesSchema = z.array(HistorySourceReferenceSchema).max(5);
export const HistorySourceSchema = HistorySourceReferenceSchema.extend({
  botId: Id.nullable(),
  groupId: Id.nullable(),
  chatName: z.string(),
  createdAt: z.iso.datetime(),
  text: z.string(),
});
export type HistorySourceReference = z.infer<typeof HistorySourceReferenceSchema>;
export type HistorySource = z.infer<typeof HistorySourceSchema>;
