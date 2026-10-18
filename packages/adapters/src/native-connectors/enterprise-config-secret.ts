import { z } from "zod";

const ticket = z
  .object({ value: z.string().min(1).max(8192), issuedAt: z.number().int().positive() })
  .strict();
export const EnterpriseConfigSecretSchema = z
  .object({
    version: z.literal(1),
    clientSecret: z.string().min(1).max(8192),
    verificationToken: z.string().min(1).max(512).optional(),
    encryptionKey: z.string().min(1).max(512).optional(),
    appTicket: ticket.optional(),
    suiteTicket: ticket.optional(),
  })
  .strict();
export type EnterpriseConfigSecret = z.infer<typeof EnterpriseConfigSecretSchema>;
export function enterpriseConfigSecret(value: string): EnterpriseConfigSecret {
  return EnterpriseConfigSecretSchema.parse(JSON.parse(value));
}
