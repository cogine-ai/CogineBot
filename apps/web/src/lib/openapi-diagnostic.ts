import { t } from "@lingui/core/macro";
import type { OpenApiImportDiagnosticCode } from "@rakazo/contracts";

export function openApiDiagnosticText(code: OpenApiImportDiagnosticCode): string {
  switch (code) {
    case "parse_error":
    case "multiple_documents":
    case "invalid_document":
      return t`Use one JSON or YAML OpenAPI document.`;
    case "unsupported_version":
      return t`This OpenAPI version is not supported.`;
    case "invalid_server":
      return t`The API server is not supported.`;
    case "document_limit":
    case "schema_limit":
      return t`The schema is too large.`;
    case "invalid_operation":
    case "duplicate_operation":
      return t`This operation cannot be imported.`;
    case "unsupported_method":
      return t`This HTTP method is not supported.`;
    case "invalid_parameter":
    case "unsupported_parameter":
      return t`This parameter cannot be sent safely.`;
    case "unsafe_header":
      return t`This header is not allowed.`;
    case "unresolved_reference":
      return t`A reference could not be resolved.`;
    case "external_reference":
      return t`External references are not supported.`;
    case "reference_cycle":
      return t`Circular references are not supported.`;
    case "reference_depth":
      return t`The reference is too deep.`;
    case "unsafe_schema":
      return t`The input constraints cannot be preserved.`;
    case "operation_limit":
      return t`The operation limit was reached.`;
    case "fetch_failed":
      return t`Could not load the OpenAPI document.`;
    case "invalid_review":
      return t`Preview again before adding.`;
  }
}
