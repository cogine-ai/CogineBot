import * as z from "zod";
import { usableModelId } from "./domain.js";

export const AgentBackupModelSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
  modelId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/)
    .refine((value) => usableModelId(value) !== null),
});
export type AgentBackupModel = z.infer<typeof AgentBackupModelSchema>;
