import * as z from "zod";
import { AgentBackupMcpEntriesSchema } from "./agent-backup-mcp.js";
import { AgentBackupModelSchema } from "./agent-backup-model.js";
import {
  AGENT_BACKUP_MAX_FILES,
  AgentBackupOmissionsSchema,
  isAgentBackupPath,
} from "./agent-backup-omissions.js";

export * from "./agent-backup-mcp.js";
export * from "./agent-backup-model.js";
export * from "./agent-backup-omissions.js";

import {
  BOT_PACKAGE_MAX_BYTES,
  BotPackageSkillFilesSchema,
  botPackageUtf8Bytes,
} from "./bot-package.js";

export const AGENT_BACKUP_MAX_FILE_LENGTH = 100_000;
export const AGENT_BACKUP_MAX_TOTAL_LENGTH = 4_000_000;
export const AGENT_BACKUP_FORMAT = "agent-backup/v1";
export const isBackupSkill = (path: string) =>
  /^(?:\.agents\/)?skills\/(?:[^/]+\/){1,4}SKILL\.md$/.test(path);

export function countAgentBackupFiles(files: readonly { references?: readonly unknown[] }[]) {
  return files.reduce((sum, { references }) => sum + 1 + (references?.length ?? 0), 0);
}

export const AgentBackupSourceSchema = z.enum(["openclaw", "hermes"]);
export type AgentBackupSource = z.infer<typeof AgentBackupSourceSchema>;

export const AgentBackupDocumentSchema = z
  .strictObject({
    format: z.literal(AGENT_BACKUP_FORMAT),
    source: AgentBackupSourceSchema,
    files: z
      .array(
        z.strictObject({
          path: z.string().refine(isAgentBackupPath),
          content: z
            .string()
            .max(AGENT_BACKUP_MAX_FILE_LENGTH)
            .refine((value) => !value.includes("\0")),
          references: BotPackageSkillFilesSchema.optional(),
          referenceLimitExceeded: z.literal(true).optional(),
        }),
      )
      .max(AGENT_BACKUP_MAX_FILES),
    excludedMemoryCount: z.int().min(0).max(AGENT_BACKUP_MAX_FILES).default(0),
    incompleteSkills: z
      .array(z.string().refine(isAgentBackupPath))
      .max(AGENT_BACKUP_MAX_FILES)
      .default([]),
    routineOmissions: AgentBackupOmissionsSchema.optional(),
    mcp: AgentBackupMcpEntriesSchema.optional(),
    model: z.union([AgentBackupModelSchema, z.literal("unavailable")]).optional(),
  })
  .superRefine(({ files, excludedMemoryCount }, ctx) => {
    const paths = new Set(files.map(({ path }) => path.toLowerCase()));
    const contentFiles = files.flatMap((file) => [file, ...(file.references ?? [])]);
    const chars = contentFiles.reduce((sum, { content }) => sum + content.length, 0);
    const bytes = contentFiles.reduce((sum, { content }) => sum + botPackageUtf8Bytes(content), 0);
    if (
      contentFiles.length + excludedMemoryCount > AGENT_BACKUP_MAX_FILES ||
      files.some(
        ({ path, references, referenceLimitExceeded }) =>
          (references || referenceLimitExceeded) && !isBackupSkill(path),
      ) ||
      paths.size !== files.length ||
      chars > AGENT_BACKUP_MAX_TOTAL_LENGTH ||
      bytes > BOT_PACKAGE_MAX_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "The backup contains duplicate paths or exceeds the size limit.",
      });
  });

export type AgentBackupDocument = z.infer<typeof AgentBackupDocumentSchema>;
