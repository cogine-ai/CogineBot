import * as z from "zod";
import { BOT_PACKAGE_MAX_BYTES, botPackageUtf8Bytes } from "./bot-package.js";

export const AGENT_BACKUP_MAX_FILES = 500;
export const AGENT_BACKUP_MAX_FILE_LENGTH = 100_000;
export const AGENT_BACKUP_MAX_TOTAL_LENGTH = 4_000_000;
export const AGENT_BACKUP_MAX_PATH_LENGTH = 300;
export const AGENT_BACKUP_FORMAT = "agent-backup/v1";

export const AgentBackupSourceSchema = z.enum(["openclaw", "hermes"]);
export type AgentBackupSource = z.infer<typeof AgentBackupSourceSchema>;

export function isAgentBackupPath(path: string): boolean {
  return (
    path.length <= AGENT_BACKUP_MAX_PATH_LENGTH &&
    !/[\\\p{Cc}]/u.test(path) &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export const AgentBackupDocumentSchema = z
  .strictObject({
    format: z.literal(AGENT_BACKUP_FORMAT),
    source: AgentBackupSourceSchema,
    files: z
      .array(
        z.strictObject({
          path: z.string().refine(isAgentBackupPath),
          content: z.string().max(AGENT_BACKUP_MAX_FILE_LENGTH),
        }),
      )
      .min(1)
      .max(AGENT_BACKUP_MAX_FILES),
    incompleteSkills: z
      .array(z.string().refine(isAgentBackupPath))
      .max(AGENT_BACKUP_MAX_FILES)
      .default([]),
  })
  .superRefine(({ files }, ctx) => {
    const paths = new Set(files.map(({ path }) => path.toLowerCase()));
    const chars = files.reduce((sum, { content }) => sum + content.length, 0);
    const bytes = files.reduce((sum, { content }) => sum + botPackageUtf8Bytes(content), 0);
    if (
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
