import { z } from "zod";

// Older clients validate the original candidate shape strictly.
export const COMPUTER_STORAGE_SELECTION_HEADER = "x-rakazo-storage-selection";
export const COMPUTER_DISK_USAGE_TIMEOUT_MS = 10_000;
export const COMPUTER_DISK_USAGE_MAX_RESPONSE_BYTES = 64 * 1024;
export const COMPUTER_DISK_USAGE_MAX_CANDIDATES = 100;
export const COMPUTER_DISK_USAGE_MAX_DEPTH = 3;
export const COMPUTER_DISK_USAGE_MAX_PATH_BYTES = 512;
export const COMPUTER_DISK_USAGE_EXCLUDED_NAMES = [
  "credentials",
  "keys",
  "secrets",
  "db",
  "database",
  "databases",
  "profile",
  "profiles",
  "chromium",
  "chrome",
  "firefox",
];
export const COMPUTER_DISK_USAGE_EXCLUDED_SUFFIXES = [
  ".db",
  ".db-wal",
  ".db-shm",
  ".sqlite",
  ".sqlite3",
  ".sqlite-wal",
  ".sqlite-shm",
  ".sqlite3-wal",
  ".sqlite3-shm",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
];

export const ManagedDiskProbeSchema = z
  .object({
    workspace: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("dedicated") }).strict(),
      z
        .object({
          kind: z.literal("team"),
          botId: z
            .string()
            .max(256)
            .regex(/^[A-Za-z0-9_-]+$/),
        })
        .strict(),
    ]),
    timeoutMs: z.int().positive().max(COMPUTER_DISK_USAGE_TIMEOUT_MS),
  })
  .strict();
export type ManagedDiskProbe = z.infer<typeof ManagedDiskProbeSchema>;

const target = z.string().regex(/^[0-9a-f]{64}$/);
const botId = z.string().min(1).max(256);
const count = z.int().nonnegative();
const volume = z
  .object({ totalBytes: count, availableBytes: count, availableInodes: count.nullable() })
  .strict()
  .refine((value) => value.availableBytes <= value.totalBytes);

// Paths are relative to the selected Bot's workspace, including on a Team computer.
const relativePath = z
  .string()
  .max(COMPUTER_DISK_USAGE_MAX_PATH_BYTES)
  .refine((value) => {
    const segments = value.split("/");
    return (
      segments.length <= COMPUTER_DISK_USAGE_MAX_DEPTH &&
      segments.every((segment) => {
        const lower = segment.toLowerCase();
        return (
          segment.length > 0 &&
          !segment.startsWith(".") &&
          !COMPUTER_DISK_USAGE_EXCLUDED_NAMES.includes(lower) &&
          !COMPUTER_DISK_USAGE_EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
        );
      }) &&
      !/[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
      new TextEncoder().encode(value).length <= COMPUTER_DISK_USAGE_MAX_PATH_BYTES
    );
  });

const cleanupPath = relativePath.refine((value) => !/[?*[\]]/u.test(value));
const fileRevision = z.string().regex(/^[0-9a-f]{64}$/);
const cleanupFingerprint = z
  .object({ version: fileRevision, modifiedAtMs: z.int().min(-8.64e15).max(8.64e15) })
  .strict();
const diskCandidate = z
  .object({ path: relativePath, logicalBytes: count, cleanup: cleanupFingerprint.optional() })
  .strict();

const diskUsageData = z
  .object({
    volume,
    candidates: z
      .array(diskCandidate)
      .max(COMPUTER_DISK_USAGE_MAX_CANDIDATES)
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
    partial: z.boolean(),
  })
  .strict();

export const ComputerDiskProbeOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), data: diskUsageData }).strict(),
  z.object({ status: z.literal("not_running") }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("timeout") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
export type ComputerDiskProbeOutcome = z.infer<typeof ComputerDiskProbeOutcomeSchema>;

export const ComputerDiskUsageInputSchema = z
  .object({ botId, expectedTarget: target.optional() })
  .strict();
export type ComputerDiskUsageInput = z.infer<typeof ComputerDiskUsageInputSchema>;
export const ComputerDiskUsageResultSchema = z
  .object({
    botId,
    target: target.nullable(),
    outcome: z.union([ComputerDiskProbeOutcomeSchema, z.object({ status: z.literal("changed") })]),
  })
  .strict();
export type ComputerDiskUsageResult = z.infer<typeof ComputerDiskUsageResultSchema>;

const requestNonce = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const uniquePaths = <T extends { path: string }>(files: T[]) =>
  new Set(files.map(({ path }) => path)).size === files.length;
const cleanupSelection = z
  .array(z.object({ path: cleanupPath, version: fileRevision }).strict())
  .min(1)
  .max(COMPUTER_DISK_USAGE_MAX_CANDIDATES)
  .refine(uniquePaths);
const cleanupEntry = cleanupFingerprint.extend({ path: cleanupPath, logicalBytes: count });
export const ComputerCleanupEntriesSchema = z
  .array(cleanupEntry)
  .min(1)
  .max(COMPUTER_DISK_USAGE_MAX_CANDIDATES)
  .refine(uniquePaths);
export type ComputerCleanupEntries = z.infer<typeof ComputerCleanupEntriesSchema>;

export const PlanComputerCleanupInputSchema = z
  .object({
    botId,
    expectedTarget: target,
    requestNonce,
    selected: cleanupSelection,
  })
  .strict();
export type PlanComputerCleanupInput = z.infer<typeof PlanComputerCleanupInputSchema>;

export const UpdateComputerCleanupInputSchema = z
  .object({
    botId,
    planId: z.uuid(),
    expectedRevision: z.int().positive(),
  })
  .strict();
export type UpdateComputerCleanupInput = z.infer<typeof UpdateComputerCleanupInputSchema>;

export const ConfirmComputerCleanupInputSchema = UpdateComputerCleanupInputSchema.extend({
  confirmed: z.literal(true),
  requestNonce,
});
export type ConfirmComputerCleanupInput = z.infer<typeof ConfirmComputerCleanupInputSchema>;

export const ComputerCleanupPlanSchema = z
  .object({
    id: z.uuid(),
    botId,
    revision: z.int().positive(),
    expiresAt: z.iso.datetime(),
    status: z.enum(["awaiting_confirmation", "reviewed", "cancelled", "expired"]),
    selected: ComputerCleanupEntriesSchema,
  })
  .strict();
export type ComputerCleanupPlan = z.infer<typeof ComputerCleanupPlanSchema>;

export const ComputerStorageRecoverySchema = z
  .object({
    kind: z.literal("computer_storage"),
    code: z.literal("ENOSPC"),
    botId,
    expectedTarget: target,
  })
  .strict();
export type ComputerStorageRecovery = z.infer<typeof ComputerStorageRecoverySchema>;

export const ManagedWorkspaceFullSchema = z
  .object({
    error: z.literal("ENOSPC"),
    source: z.literal("workspace_write"),
    version: z.literal(1),
  })
  .strict();
