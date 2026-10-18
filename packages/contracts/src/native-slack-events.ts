import { z } from "zod";

const Id = z.string().min(1).max(256);
const SlackId = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+$/)
  .max(64);
const Timestamp = z
  .string()
  .regex(/^[0-9]+\.[0-9]{6}$/)
  .max(32);
export const NativeSlackBotEventSchema = z.enum([
  "app_mention",
  "message.im",
  "message.channels",
  "message.groups",
]);
export const NativeSlackEventSignalSchema = z
  .object({
    eventId: z
      .string()
      .regex(/^Ev[A-Za-z0-9]+$/)
      .max(128),
    appId: SlackId,
    teamId: SlackId,
    enterpriseId: SlackId.nullable(),
    eventTime: z.number().int().nonnegative(),
    type: z.enum(["app_mention", "message"]),
    channelId: SlackId,
    channelType: z.enum(["channel", "group", "im"]).optional(),
    messageTs: Timestamp,
    threadTs: Timestamp.optional(),
    userId: SlackId,
    authorizations: z
      .array(
        z
          .object({
            teamId: SlackId.nullable(),
            enterpriseId: SlackId.nullable(),
            userId: SlackId,
            isBot: z.boolean(),
            isEnterpriseInstall: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const NativeSlackSignalJobSchema = z
  .object({
    triggerId: Id,
    triggerVersion: z.number().int().positive(),
    inboxId: Id,
    hookId: Id,
    hookRevision: z.number().int().positive(),
  })
  .strict();
export const SaveNativeSlackHookInputSchema = z
  .object({
    configId: Id,
    id: Id.optional(),
    expectedRevision: z.number().int().positive().optional(),
    appId: SlackId,
    signingSecret: z.string().min(16).max(4096),
    botEvents: z.array(NativeSlackBotEventSchema).min(1).max(4),
    botSubscriptionsConfirmed: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.id) !== (value.expectedRevision !== undefined))
      ctx.addIssue({ code: "custom", message: "An existing hook requires its current revision." });
    if (new Set(value.botEvents).size !== value.botEvents.length)
      ctx.addIssue({ code: "custom", message: "Duplicate bot subscriptions." });
  });
export const NativeSlackHookStatusInputSchema = z.object({ configId: Id }).strict();
export const DisableNativeSlackHookInputSchema = z
  .object({ configId: Id, id: Id, expectedRevision: z.number().int().positive() })
  .strict();
export const NativeSlackHookSchema = z
  .object({
    id: Id,
    configId: Id,
    configRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    appId: SlackId,
    teamId: SlackId.nullable(),
    botEvents: z.array(NativeSlackBotEventSchema),
    enabled: z.boolean(),
    configured: z.boolean(),
    verified: z.boolean(),
    phase: z.enum(["waiting_for_verification", "active", "disabled", "invalidated"]),
    webhookUrl: z.string().url().nullable(),
    lastVerifiedAt: z.string().nullable(),
  })
  .strict();
export const NativeSlackHookStatusSchema = z
  .object({
    configId: Id,
    publicHttpsAvailable: z.boolean(),
    hooks: z.array(NativeSlackHookSchema),
  })
  .strict();
export type NativeSlackEventSignal = z.infer<typeof NativeSlackEventSignalSchema>;
export type NativeSlackSignalJobPayload = z.infer<typeof NativeSlackSignalJobSchema>;
export type NativeSlackHook = z.infer<typeof NativeSlackHookSchema>;
export type NativeSlackHookStatus = z.infer<typeof NativeSlackHookStatusSchema>;
export type NativeSlackBotEvent = z.infer<typeof NativeSlackBotEventSchema>;
