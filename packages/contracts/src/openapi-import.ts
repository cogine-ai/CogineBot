import { z } from "zod";
import { CapabilityInstallSchema } from "./domain.js";

export const OpenApiImportDiagnosticCodeSchema = z.enum([
  "parse_error",
  "multiple_documents",
  "invalid_document",
  "unsupported_version",
  "invalid_server",
  "document_limit",
  "invalid_operation",
  "duplicate_operation",
  "unsupported_method",
  "invalid_parameter",
  "unsupported_parameter",
  "unsafe_header",
  "unresolved_reference",
  "external_reference",
  "reference_cycle",
  "reference_depth",
  "schema_limit",
  "unsafe_schema",
  "operation_limit",
  "fetch_failed",
  "invalid_review",
]);
export type OpenApiImportDiagnosticCode = z.infer<typeof OpenApiImportDiagnosticCodeSchema>;

export const OpenApiImportDiagnosticSchema = z.object({
  scope: z.enum(["document", "operation"]),
  code: OpenApiImportDiagnosticCodeSchema,
  operationId: z.string().max(160).optional(),
  method: z.string().max(16).optional(),
  path: z.string().max(2048).optional(),
  pointer: z.string().max(2048).optional(),
});
export type OpenApiImportDiagnostic = z.infer<typeof OpenApiImportDiagnosticSchema>;

export const OpenApiImportCountsSchema = z.object({
  discovered: z.number().int().nonnegative(),
  accepted: z.number().int().min(0).max(100),
  rejected: z.number().int().nonnegative(),
  omittedDiagnostics: z.number().int().nonnegative(),
});
export type OpenApiImportCounts = z.infer<typeof OpenApiImportCountsSchema>;

export const OpenApiImportInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(2048),
  config: z.record(z.string(), z.unknown()).default({}),
  credential: z.string().max(16_384).optional(),
});
export type OpenApiImportInput = z.infer<typeof OpenApiImportInputSchema>;

export const OpenApiOperationSummarySchema = z.object({
  id: z.string().min(1).max(160),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(2048),
  readOnly: z.boolean(),
});

const preview = {
  target: z.string().nullable(),
  operations: z.array(OpenApiOperationSummarySchema).max(100),
  diagnostics: z.array(OpenApiImportDiagnosticSchema).max(100),
  counts: OpenApiImportCountsSchema,
};
export const OpenApiImportPreviewSchema = z.discriminatedUnion("status", [
  z.object({
    ...preview,
    status: z.literal("ready"),
    reviewToken: z.string(),
    expiresAt: z.string(),
  }),
  z.object({
    ...preview,
    status: z.literal("invalid"),
    reviewToken: z.null(),
    expiresAt: z.null(),
  }),
]);
export type OpenApiImportPreview = z.infer<typeof OpenApiImportPreviewSchema>;

export const OpenApiImportConfirmInputSchema = OpenApiImportInputSchema.extend({
  reviewToken: z.string().min(1).max(4096),
});
export type OpenApiImportConfirmInput = z.infer<typeof OpenApiImportConfirmInputSchema>;
export const OpenApiImportReceiptInputSchema = z.object({
  reviewToken: z.string().min(1).max(4096),
});

export const OpenApiImportConfirmationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("installed"),
    install: CapabilityInstallSchema,
    replayed: z.boolean(),
  }),
  z.object({
    status: z.enum(["pending", "stale", "expired", "removed", "invalid"]),
    diagnostics: z.array(OpenApiImportDiagnosticSchema).max(100),
    retryAfterMs: z.number().int().min(0).max(60_000).optional(),
  }),
]);
export type OpenApiImportConfirmation = z.infer<typeof OpenApiImportConfirmationSchema>;
