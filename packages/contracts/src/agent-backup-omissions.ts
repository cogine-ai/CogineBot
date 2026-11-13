import * as z from "zod";

export const AGENT_BACKUP_MAX_FILES = 500;
export const AGENT_BACKUP_MAX_PATH_LENGTH = 300;

export const agentBackupOmissionReasons = {
  invalidSkill: "This Skill is missing valid metadata.",
  missingSkillFiles: "This Skill needs additional files.",
  skillRequirements: "This Skill declares requirements that need review.",
  skillLimit: "This Skill exceeds the Bot limits.",
  stock: "The original template was omitted.",
  instructionLimit: "This instruction file exceeds the Bot limit.",
  memoryLimit: "This note exceeds the Bot memory limits.",
  identity: "This identity file has no supported fields.",
} as const;

const agentBackupOmissionReasonKeys = Object.keys(agentBackupOmissionReasons) as Array<
  keyof typeof agentBackupOmissionReasons
>;
export type AgentBackupOmissionReason = keyof typeof agentBackupOmissionReasons;
export const agentBackupRuntimeOmission = "This runtime file is not used.";

export function isAgentBackupPath(path: string): boolean {
  return (
    path.length <= AGENT_BACKUP_MAX_PATH_LENGTH &&
    !/[\\\p{Cc}]/u.test(path) &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export const AgentBackupOmissionsSchema = z
  .array(
    z.strictObject({
      path: z.string().refine(isAgentBackupPath),
      reason: z.enum(agentBackupOmissionReasonKeys),
    }),
  )
  .max(AGENT_BACKUP_MAX_FILES);
export type AgentBackupOmissions = z.infer<typeof AgentBackupOmissionsSchema>;
