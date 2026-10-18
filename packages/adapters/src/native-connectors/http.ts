import {
  asRecord,
  isSensitiveHeader,
  isTransportHeader,
  readBoundedText,
} from "../connector-http.js";
import { combineSignals } from "../connector-safety.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../remote-mcp.js";
import type { NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import { readNativeBytes } from "./binary.js";
import { createNativeFetch, nativeAbortable } from "./network.js";

export type NativeCredential = { kind: "bearer" | "api_key" | "raw"; value: string };

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
}

function httpError(
  status: number,
  body: unknown,
  retry: number | undefined,
  readOnly: boolean,
): NativeActionError {
  const record = asRecord(body) ?? {};
  const google = asRecord(record.error) ?? {};
  const reasons = Array.isArray(google.errors) ? google.errors : [];
  const reason = reasons
    .map((item) => asRecord(item)?.reason)
    .find((item) => typeof item === "string");
  const additional = asRecord(record.additional_data) ?? {};
  // Only recovery identifiers/protocol hints are retained. Never echo arbitrary
  // upstream bodies (which may contain credentials or private document content).
  const recovery: Record<string, unknown> = { status };
  for (const [key, value] of Object.entries({
    code: record.code,
    reason,
    committed_resource_id: additional.committed_resource_id,
  })) {
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) recovery[key] = value;
  }
  if (Array.isArray(additional.committed_child_ids))
    recovery.committed_child_ids = additional.committed_child_ids
      .filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id))
      .slice(0, 100);
  if (additional.retry_guidance !== undefined)
    recovery.retry_guidance = [
      recovery.committed_resource_id || recovery.committed_child_ids
        ? "verify_committed_resources"
        : "verify_destination",
    ];
  if (status === 401 || record.error === "invalid_grant")
    return new NativeActionError(
      "authorization_expired",
      "This authorization is no longer valid. Reauthorize this account.",
    );
  if (status === 403 && reason === "insufficientPermissions")
    return new NativeActionError(
      "insufficient_scope",
      "This action requires permission not granted to this connection.",
    );
  if (
    status === 403 &&
    ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(String(reason))
  )
    return new NativeActionError("rate_limited", "The service quota or rate limit was reached.", {
      retryAfterSeconds: retry,
      recovery,
    });
  if (status === 403 || status === 404)
    return new NativeActionError(
      "resource_unavailable",
      "This connection cannot access the requested resource.",
      { recovery },
    );
  if (status === 410)
    return new NativeActionError(
      "resource_unavailable",
      "The service cursor or resource expired. Read the current resource before continuing.",
      { recovery: { status: 410 } },
    );
  if (status === 409 || status === 412)
    return new NativeActionError(
      "version_conflict",
      "The resource changed. Read its current version before proposing the change again.",
    );
  if (status === 429)
    return new NativeActionError("rate_limited", "The service rate limit was reached.", {
      retryAfterSeconds: retry,
    });
  if (status === 408 || status >= 500)
    return new NativeActionError(
      readOnly ? "temporarily_unavailable" : "result_unknown",
      readOnly
        ? "The service is temporarily unavailable."
        : "The remote operation may have completed. Verify its original result before trying again.",
      { uncertain: !readOnly, recovery, retryAfterSeconds: retry },
    );
  return new NativeActionError("invalid_input", "The service rejected these action parameters.");
}

/** Pinned DNS and no redirects come from the existing connector transport. */
export class NativeHttpClient {
  private readonly fetch: SafeRemoteFetch;
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly credential: () => Promise<NativeCredential>,
    private readonly options: {
      network?: RemoteTransportDependencies;
      allowPrivateEndpoint?: boolean;
      headers?: Record<string, string>;
      signal: AbortSignal;
      readOnly: boolean;
      /** A trusted action constant, never a model argument. */
      timeoutMs?: number;
      /** Refresh only a definitively rejected token, fenced by its tokenVersion. */
      onUnauthorized?: () => Promise<void>;
      /** Drive upload sessions use 308 as a protocol acknowledgement, without following Location. */
      resumableUpload?: boolean;
    },
  ) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new NativeActionError("invalid_input", "Invalid service API authority.");
    this.base = url.toString().replace(/\/$/, "");
    this.fetch = createNativeFetch(
      options.network,
      { allowPrivateEndpoint: options.allowPrivateEndpoint },
      options.timeoutMs,
      options.resumableUpload ? "google-drive-resumable" : undefined,
    );
  }

  async request(request: NativeRequest): Promise<NativeResponse> {
    if (
      !request.path.startsWith("/") ||
      request.path.startsWith("//") ||
      /[?#\\\s]/.test(request.path)
    )
      throw new NativeActionError(
        "invalid_input",
        "Action paths must stay within the service API authority.",
      );
    const url = new URL(this.base + request.path);
    if (!url.toString().startsWith(`${this.base}/`))
      throw new NativeActionError("invalid_input", "Action path escaped its API authority.");
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const custom = request.headers ?? {};
    if (Object.keys(custom).some((name) => isSensitiveHeader(name) || isTransportHeader(name)))
      throw new NativeActionError(
        "invalid_input",
        "Action parameters cannot supply authentication headers.",
      );
    const readOnly = this.options.readOnly;
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await this.credential();
      const headers = new Headers({ ...this.options.headers, ...custom });
      headers.set(
        auth.kind === "api_key" ? "X-API-Key" : "Authorization",
        auth.kind === "bearer" ? `Bearer ${auth.value}` : auth.value,
      );
      let body: BodyInit | undefined;
      if (request.body !== undefined) {
        if (
          request.body instanceof FormData ||
          request.body instanceof Uint8Array ||
          typeof request.body === "string"
        ) {
          body = request.body as BodyInit;
        } else {
          headers.set("content-type", "application/json");
          body = JSON.stringify(request.body);
        }
      }
      let response: Response;
      const signal = combineSignals(
        this.options.signal,
        AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      );
      try {
        response = await this.fetch(url, { method: request.method, headers, body, signal });
      } catch {
        if (readOnly && attempt === 0 && !this.options.signal.aborted) continue;
        throw new NativeActionError(
          readOnly ? "temporarily_unavailable" : "result_unknown",
          readOnly
            ? "The service could not be reached."
            : "The remote operation may have completed. Verify its original result before trying again.",
          { uncertain: !readOnly },
        );
      }
      if (response.status === 308 && this.options.resumableUpload) {
        await response.body?.cancel();
        return { status: 308, body: null, headers: response.headers };
      }
      const retry = retryAfter(response);
      if (response.status === 401 && attempt === 0 && this.options.onUnauthorized) {
        await response.body?.cancel();
        await this.options.onUnauthorized();
        continue;
      }
      if (
        readOnly &&
        attempt === 0 &&
        (response.status >= 500 || response.status === 429) &&
        (retry === undefined || retry <= 2)
      ) {
        await response.body?.cancel();
        if (retry)
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(this.options.signal.reason);
            };
            const timer = setTimeout(() => {
              this.options.signal.removeEventListener("abort", onAbort);
              resolve();
            }, retry * 1000);
            this.options.signal.addEventListener("abort", onAbort, { once: true });
            if (this.options.signal.aborted) onAbort();
          });
        continue;
      }
      let text: string;
      if (response.ok && request.responseType === "bytes") {
        return {
          status: response.status,
          body: await readNativeBytes(response, signal),
          headers: response.headers,
        };
      }
      try {
        const read = await nativeAbortable(readBoundedText(response, 10_000_000), signal);
        if (read.truncated) throw new Error("incomplete");
        text = read.text;
      } catch {
        if (!response.ok) throw httpError(response.status, {}, retry, readOnly);
        throw new NativeActionError("incomplete_response", "The service response was incomplete.", {
          uncertain: !readOnly,
        });
      }
      let parsed: unknown = text;
      if (request.responseType !== "text" && text.length) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (!response.ok) throw httpError(response.status, {}, retry, readOnly);
          throw new NativeActionError(
            "incomplete_response",
            "The service did not return a valid response.",
            { uncertain: !readOnly },
          );
        }
      }
      if (!response.ok) throw httpError(response.status, parsed, retry, readOnly);
      return { status: response.status, body: parsed, headers: response.headers };
    }
    throw new NativeActionError(
      "temporarily_unavailable",
      "The service is temporarily unavailable.",
    );
  }

  close(): Promise<void> {
    return this.fetch.close();
  }
}
