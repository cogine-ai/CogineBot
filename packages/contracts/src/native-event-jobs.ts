import { z } from "zod";

const Uuid = z.uuid();
export const NativeSourceJobPayloadSchema = z
  .object({ triggerId: z.string().min(1), triggerVersion: z.number().int().positive() })
  .strict();
export const NativeNotionEventSignalSchema = z
  .object({
    id: Uuid,
    timestamp: z.iso.datetime({ offset: true }),
    workspaceId: Uuid,
    integrationId: Uuid,
    subscriptionId: Uuid,
    type: z.enum([
      "page.content_updated",
      "page.created",
      "page.deleted",
      "page.moved",
      "page.undeleted",
      "page.properties_updated",
      "data_source.content_updated",
      "data_source.schema_updated",
      "data_source.created",
      "data_source.deleted",
      "data_source.moved",
      "data_source.undeleted",
      "comment.created",
      "comment.updated",
      "comment.deleted",
    ]),
    apiVersion: z.string().max(32).optional(),
    accessibleBy: z
      .array(z.object({ id: Uuid, type: z.enum(["person", "bot"]) }).strict())
      .max(1000)
      .optional(),
    entity: z
      .object({ id: Uuid, type: z.enum(["page", "block", "database", "data_source", "comment"]) })
      .strict(),
    pageId: Uuid.optional(),
    parent: z
      .object({ id: Uuid, type: z.enum(["page", "block", "database", "data_source", "workspace"]) })
      .strict()
      .optional(),
    propertyIds: z.array(z.string().min(1).max(1024)).max(1000).optional(),
  })
  .strict();
export const NativeNotionSignalJobSchema = z
  .object({
    triggerId: z.string().min(1),
    triggerVersion: z.number().int().positive(),
    hookId: z.string().min(1),
    hookRevision: z.number().int().positive(),
    signal: NativeNotionEventSignalSchema,
  })
  .strict();
export type NativeSourceJobPayload = z.infer<typeof NativeSourceJobPayloadSchema>;
export type NativeNotionSignalJobPayload = z.infer<typeof NativeNotionSignalJobSchema>;
