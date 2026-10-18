import { createHash } from "node:crypto";
import type { NativeAction, NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import { validateNativeInput } from "./validation.js";

export type Data = Record<string, unknown>;
export interface CollaborationDefinition {
  id: string;
  description: string;
  inputSchema: Data;
  readOnly: boolean;
  authorization: { acceptedAnyOfScopes: string[] };
}
export const invalid = (message: string): never => {
  throw new NativeActionError("invalid_input", message);
};
export const incomplete = (message: string): never => {
  throw new NativeActionError("incomplete_response", message);
};
export function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return incomplete("The service returned no usable object.");
  return value as Data;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return incomplete("The service omitted its collection.");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    return incomplete("The service omitted resource identity.");
  return value;
}
export function identity(value: unknown): Data {
  const row = object(value);
  if (
    !(typeof row.id === "string" && row.id) &&
    !(typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0)
  )
    return incomplete("The service omitted stable resource identity.");
  return row;
}
export const segment = (value: unknown): string => {
  if (value === "." || value === "..")
    return invalid("Resource identifiers cannot be URL dot segments.");
  return encodeURIComponent(String(value));
};
export function select(source: Data, keys: readonly string[]): Data {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}
export function scopes(
  context: Pick<NativeActionContext, "principal">,
  alternatives: readonly string[],
): void {
  if (
    alternatives.length &&
    !alternatives.some((scope) => context.principal.scopes.includes(scope))
  )
    throw new NativeActionError(
      "insufficient_scope",
      "This selected account has not granted the required permission.",
    );
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/** A receipt on the existing ExternalEffect, not another action queue or retry mechanism. */
export class CollaborationRun {
  readonly receipt: Data;
  mutated = false;
  private accepted = false;
  constructor(
    readonly definition: CollaborationDefinition,
    readonly context: NativeActionContext,
    args: Data,
  ) {
    const binding = {
      action_id: definition.id,
      operation_id: context.operationId,
      input_sha256: hash(args),
      principal_sha256: hash({
        subject: context.principal.subject,
        tenant: context.principal.tenant,
      }),
    };
    if (!context.principal.subject)
      throw new NativeActionError("authorization_required", "Select an authenticated account.");
    const prior = context.recovery;
    if (
      prior &&
      Object.keys(prior).length &&
      Object.entries(binding).some(([key, value]) => prior[key] !== value)
    )
      invalid("This effect receipt belongs to another action, input or account.");
    this.receipt = { ...structuredClone(prior ?? {}), ...binding };
  }
  unknown(message: string): never {
    throw new NativeActionError("result_unknown", message, {
      uncertain: true,
      recovery: structuredClone(this.receipt),
    });
  }
  async checkpoint(extra: Data): Promise<void> {
    Object.assign(this.receipt, extra);
    await this.context.checkpoint(structuredClone(this.receipt));
  }
  async request(
    request: NativeRequest,
    write = false,
    stage = "dispatching",
    options?: { acceptedStatus: 202 },
  ): Promise<NativeResponse> {
    this.context.signal.throwIfAborted();
    if (options) {
      const paths: Record<string, RegExp> = {
        "outlook.drafts.send": /^\/me\/messages\/[^/?#]+\/send$/,
        "outlook.messages.reply": /^\/me\/messages\/[^/?#]+\/reply$/,
        "outlook_calendar.events.cancel": /^\/me\/events\/[^/?#]+\/cancel$/,
      };
      if (
        options.acceptedStatus !== 202 ||
        !write ||
        request.method !== "POST" ||
        request.service ||
        request.query ||
        !paths[this.definition.id]?.test(request.path)
      )
        invalid("Accepted acknowledgements are only supported by the fixed Microsoft actions.");
    }
    if (write) {
      try {
        await this.checkpoint({ stage, dispatch_state: "in_flight" });
      } catch {
        throw new NativeActionError(
          "temporarily_unavailable",
          "The effect receipt could not be saved; no request was sent.",
        );
      }
    }
    let response: NativeResponse;
    try {
      response = await this.context.request(request);
    } catch (error) {
      if (write && (!(error instanceof NativeActionError) || error.options.uncertain))
        return this.unknown(
          "The remote write may have completed. Reconcile its exact receipt before repeating it.",
        );
      if (error instanceof NativeActionError) throw error;
      throw new NativeActionError(
        "temporarily_unavailable",
        "The service request did not complete.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      if (write && (response.status === 202 || response.status >= 500))
        return this.unknown("The service did not confirm the write outcome.");
      const kind =
        response.status === 401
          ? "authorization_expired"
          : response.status === 403
            ? "insufficient_scope"
            : response.status === 404
              ? "resource_unavailable"
              : response.status === 429
                ? "rate_limited"
                : response.status >= 500
                  ? "temporarily_unavailable"
                  : "invalid_input";
      const retry = Number(response.headers.get("retry-after"));
      throw new NativeActionError(kind, "The service rejected this request.", {
        ...(response.status === 429 && Number.isFinite(retry) && retry > 0
          ? { retryAfterSeconds: retry }
          : {}),
      });
    }
    if (write) {
      if (response.status === 202) {
        if (!options || ![null, undefined, ""].includes(response.body as null | undefined | string))
          return this.unknown(
            "The service accepted the request without a verified acknowledgement.",
          );
        this.accepted = true;
      }
      this.mutated = true;
    }
    return response;
  }
  async finish(output: Data, receipt: Data = {}): Promise<Data> {
    if (!this.definition.readOnly && this.mutated) {
      try {
        await this.checkpoint({
          ...receipt,
          ...(this.accepted
            ? {
                accepted: true,
                accepted_status: 202,
                deliveryVerified: false,
                terminalStateVerified: false,
                write_outcome: "accepted",
              }
            : {}),
          stage: "committed",
          dispatch_state: "acknowledged",
          complete: true,
        });
      } catch {
        return this.unknown(
          "The remote result was confirmed but its receipt could not be saved. Do not repeat the write.",
        );
      }
      return {
        ...output,
        ...(this.accepted
          ? { accepted: true, deliveryVerified: false, terminalStateVerified: false }
          : {}),
        write_outcome: this.accepted ? "accepted" : "confirmed",
      };
    }
    return output;
  }
}
export function collaborationActions(
  definitions: readonly CollaborationDefinition[],
  execute: (args: Data, run: CollaborationRun) => Promise<Data>,
  authorize: (
    definition: CollaborationDefinition,
    context: Pick<NativeActionContext, "principal">,
  ) => void,
): NativeAction[] {
  return definitions.map((definition) => ({
    id: definition.id,
    description: definition.description,
    inputSchema: structuredClone(definition.inputSchema),
    readOnly: definition.readOnly,
    available(principal) {
      try {
        authorize(definition, { principal });
        return true;
      } catch {
        return false;
      }
    },
    async execute(args, context) {
      validateNativeInput(definition.inputSchema, args);
      authorize(definition, context);
      const run = new CollaborationRun(definition, context, args);
      if (!definition.readOnly && run.receipt.dispatch_state) {
        if (run.receipt.complete === true && run.receipt.dispatch_state === "acknowledged")
          return {
            action_id: definition.id,
            ...select(run.receipt, [
              "resource_id",
              "channel",
              "ts",
              "file_id",
              "scheduled_message_id",
              "accepted",
              "deliveryVerified",
              "terminalStateVerified",
            ]),
            write_outcome: run.receipt.write_outcome === "accepted" ? "accepted" : "confirmed",
            recovered_from_exact_ack: true,
            resource_snapshot_current: false,
          };
        return run.unknown(
          "This effect already has a dispatch receipt. Its write will not be automatically repeated.",
        );
      }
      try {
        return await execute(args, run);
      } catch (error) {
        if (
          run.mutated &&
          error instanceof NativeActionError &&
          error.kind === "incomplete_response"
        )
          return run.unknown("The service acknowledged a write but omitted its exact result.");
        throw error;
      }
    },
  }));
}
