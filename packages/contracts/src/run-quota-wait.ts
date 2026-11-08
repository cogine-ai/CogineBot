import * as z from "zod";

export const RUN_QUOTA_WAIT_MAX_RESUMES = 3;
export const RUN_QUOTA_WAIT_MAX_MS = 24 * 60 * 60_000;

/** Server-only identity of the provider target that refused the model request. */
export const runQuotaTargetSchema = z
  .strictObject({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    modelCredentialId: z.string().min(1).nullable(),
    connectionRevision: z.number().int().positive().nullable(),
    endpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
    costOwner: z.enum(["user", "deployment"]),
    backup: z.literal(true).optional(),
  })
  .refine(({ modelCredentialId, connectionRevision, costOwner, backup }) => {
    const deployment = modelCredentialId === null;
    return (
      deployment === (connectionRevision === null) &&
      deployment === (costOwner === "deployment") &&
      !(deployment && backup)
    );
  });
export type RunQuotaTarget = z.infer<typeof runQuotaTargetSchema>;

/** The first wait fixes the lifetime. Each reservation permits one fenced dispatch. */
export const runQuotaWaitStateSchema = z
  .strictObject({
    revision: z.number().int().min(1).max(RUN_QUOTA_WAIT_MAX_RESUMES),
    beganAt: z.iso.datetime({ precision: 3 }),
    until: z.iso.datetime({ precision: 3 }),
    target: runQuotaTargetSchema,
    dispatchedFence: z.number().int().positive().nullable(),
    humanResume: z.enum(["input", "takeover", "takeover-skipped", "takeover-held"]).optional(),
  })
  .refine(({ beganAt, until, dispatchedFence, humanResume }) => {
    const duration = Date.parse(until) - Date.parse(beganAt);
    return (
      duration > 0 &&
      duration <= RUN_QUOTA_WAIT_MAX_MS &&
      (!humanResume || dispatchedFence !== null)
    );
  });
export type RunQuotaWaitState = z.infer<typeof runQuotaWaitStateSchema>;
