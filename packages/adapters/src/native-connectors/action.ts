export interface NativeRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Relative to the adapter's fixed/configured API authority; never a model URL. */
  path: string;
  /** Trusted adapter constant selecting an app-allowlisted fixed API, never business input. */
  service?: "drive" | "drive-upload";
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: "json" | "text" | "bytes";
}

export interface NativeResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

export interface NativeActionContext {
  /** The existing ExternalEffect idempotency key, injected by the executor. */
  operationId: string;
  signal: AbortSignal;
  /** Scoped checkpoint from the same existing ExternalEffect, never model input. */
  recovery?: Record<string, unknown>;
  /** Persist before a side effect and after its acknowledgement; no automatic replay. */
  checkpoint(recovery: Record<string, unknown>): Promise<void>;
  principal: {
    subject: string;
    tenant: string | null;
    scopes: readonly string[];
    capabilities: readonly string[];
    knowledgeBaseIds: readonly string[];
    context: Record<string, unknown>;
  };
  request(request: NativeRequest): Promise<NativeResponse>;
  callMcp(tool: string, args: Record<string, unknown>): Promise<unknown>;
  readArtifact(id: string): Promise<{ bytes: Uint8Array; name: string; mimeType: string }>;
  writeArtifact?(input: { bytes: Uint8Array; name: string; mimeType: string }): Promise<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
  /** Only provider-returned Slack file URLs; the backend pins authority, path and token policy. */
  uploadResource?(input: {
    url: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ status: number }>;
  downloadResource?(input: {
    url: string;
    maxBytes: number;
  }): Promise<{ bytes: Uint8Array; mimeType: string }>;
  validateResourceUrl(url: string): Promise<void>;
}

export type NativeErrorKind =
  | "not_configured"
  | "authorization_required"
  | "authorization_expired"
  | "insufficient_scope"
  | "resource_unavailable"
  | "version_conflict"
  | "rate_limited"
  | "temporarily_unavailable"
  | "invalid_input"
  | "result_unknown"
  | "incomplete_response";

export class NativeActionError extends Error {
  constructor(
    readonly kind: NativeErrorKind,
    message: string,
    readonly options: {
      uncertain?: boolean;
      retryAfterSeconds?: number;
      recovery?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "NativeActionError";
  }
}

export interface NativeAction {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  scopesAnyOf?: readonly string[];
  capabilities?: readonly string[];
  execute(args: Record<string, unknown>, context: NativeActionContext): Promise<unknown>;
}
