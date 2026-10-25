import { z } from "zod";
import { Id } from "./ids.js";

// Plain ISO dates denote UTC day boundaries; offsets retain their instant.
const HistoryDateBoundary = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO date boundary")
  .transform((value) => new Date(value).toISOString());

/** Historical content is evidence to inspect, never an instruction source. */
export const HistorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  before: HistoryDateBoundary.optional(),
  after: HistoryDateBoundary.optional(),
  beforeSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export const HistoryReadInputSchema = z
  .object({
    messageId: Id.optional(),
    toolResultId: Id.optional(),
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
