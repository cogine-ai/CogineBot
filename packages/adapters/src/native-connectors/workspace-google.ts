import { createHash } from "node:crypto";
import type { NativeAction, NativeActionContext, NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import { validateNativeInput } from "./validation.js";

export type Obj = Record<string, unknown>;
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/";
export const enc = (value: unknown) => encodeURIComponent(String(value));
export function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeActionError("incomplete_response", "Google omitted the resource object.");
  return value as Obj;
}
export function invalid(message: string): never {
  throw new NativeActionError("invalid_input", message);
}
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function identity(value: unknown, key: string, expected?: unknown): Obj {
  const body = object(value);
  if (
    typeof body[key] !== "string" ||
    !body[key] ||
    (expected !== undefined && body[key] !== expected)
  )
    throw new NativeActionError(
      "incomplete_response",
      "Google did not confirm the expected resource identity.",
    );
  return body;
}
export async function googleCall(
  context: NativeActionContext,
  request: NativeRequest,
  write = false,
): Promise<unknown> {
  try {
    context.signal.throwIfAborted();
    const response = await context.request(request);
    if (response.status >= 200 && response.status < 300) return response.body;
    if (response.status === 401)
      throw new NativeActionError(
        "authorization_expired",
        "Reconnect the selected Google account.",
      );
    if (response.status === 403) {
      const body = response.body && typeof response.body === "object" ? (response.body as Obj) : {};
      const error = body.error && typeof body.error === "object" ? (body.error as Obj) : {};
      const errors = Array.isArray(error.errors) ? error.errors : [];
      if (
        errors.some(
          (item) =>
            item &&
            typeof item === "object" &&
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "quotaExceeded",
              "dailyLimitExceeded",
            ].includes(String((item as Obj).reason)),
        )
      )
        throw new NativeActionError("rate_limited", "Google quota reached.");
      throw new NativeActionError(
        "insufficient_scope",
        "This Google account cannot perform the operation.",
      );
    }
    if (response.status === 404 || response.status === 410)
      throw new NativeActionError(
        "resource_unavailable",
        "The Google resource or cursor is unavailable.",
      );
    if (response.status === 409 || response.status === 412)
      throw new NativeActionError("version_conflict", "The Google resource changed.");
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      throw new NativeActionError("rate_limited", "Google rate limit reached.", {
        retryAfterSeconds: retry && /^\d+$/.test(retry) ? +retry : undefined,
      });
    }
    if (response.status === 408 || response.status >= 500)
      throw new NativeActionError(
        write ? "result_unknown" : "temporarily_unavailable",
        "Google did not confirm the result.",
        { uncertain: write },
      );
    throw new NativeActionError("invalid_input", "Google rejected these operation parameters.");
  } catch (error) {
    if (error instanceof NativeActionError) throw error;
    throw new NativeActionError(
      write ? "result_unknown" : "temporarily_unavailable",
      "The Google response is unavailable.",
      { uncertain: write },
    );
  }
}
export interface WorkspaceRecovery extends Obj {
  version: number;
  actionId: string;
  operationId: string;
  intentHash: string;
  stage: string;
}
export async function beginWorkspaceWrite(
  actionId: string,
  args: Obj,
  context: NativeActionContext,
): Promise<WorkspaceRecovery> {
  const intentHash = createHash("sha256")
    .update(
      canonical({
        actionId,
        args,
        subject: context.principal.subject,
        tenant: context.principal.tenant,
      }),
    )
    .digest("hex");
  if (context.recovery && Object.keys(context.recovery).length) {
    const saved = context.recovery;
    if (
      saved.version !== 1 ||
      saved.actionId !== actionId ||
      saved.operationId !== context.operationId ||
      saved.intentHash !== intentHash ||
      typeof saved.stage !== "string"
    )
      throw new NativeActionError(
        "version_conflict",
        "Recovery does not match this exact approved operation.",
      );
    return structuredClone(saved) as WorkspaceRecovery;
  }
  const state: WorkspaceRecovery = {
    version: 1,
    actionId,
    operationId: context.operationId,
    intentHash,
    stage: "prepared",
  };
  await context.checkpoint(structuredClone(state));
  return state;
}
export async function saveWorkspace(
  context: NativeActionContext,
  state: WorkspaceRecovery,
  patch: Obj,
): Promise<void> {
  Object.assign(state, patch);
  await context.checkpoint(structuredClone(state));
}
export function workspaceUnknown(state: WorkspaceRecovery): never {
  throw new NativeActionError(
    "result_unknown",
    "The original operation must be reviewed before another write. Do not replay it.",
    {
      uncertain: true,
      recovery: structuredClone(state),
    },
  );
}
export function isUncertain(error: unknown): boolean {
  return (
    !(error instanceof NativeActionError) ||
    error.options.uncertain === true ||
    ["result_unknown", "incomplete_response"].includes(error.kind)
  );
}
export function receipt(state: WorkspaceRecovery): Obj {
  return {
    ...object(state.receipt),
    outcome: state.outcome ?? "succeeded",
    acknowledged: true,
    resourceState: "not-refreshed",
  };
}
/** One dispatch only. An observed matching resource is not proof of a lost create/append/copy ACK. */
export async function workspaceWrite(
  actionId: string,
  args: Obj,
  context: NativeActionContext,
  prepare: () => Promise<NativeRequest>,
  result: (body: unknown) => Obj,
  summarize: (output: Obj) => Obj,
): Promise<Obj> {
  const state = await beginWorkspaceWrite(actionId, args, context);
  if (state.stage === "committed") return receipt(state);
  if (state.stage !== "prepared") return workspaceUnknown(state);
  const request = await prepare();
  await saveWorkspace(context, state, { stage: "dispatching" });
  try {
    const output = result(await googleCall(context, request, true));
    await saveWorkspace(context, state, {
      stage: "committed",
      receipt: summarize(output),
      outcome: output.outcome,
    });
    return output;
  } catch (error) {
    if (isUncertain(error)) return workspaceUnknown(state);
    throw error;
  }
}
/** Scope permission and resource selection are distinct. Never trust a caller's file ID as consent. */
export async function workspaceFile(
  context: NativeActionContext,
  fileId: unknown,
  broadScopes: string[],
): Promise<void> {
  if (broadScopes.some((scope) => context.principal.scopes.includes(GOOGLE_SCOPE + scope))) return;
  if (!context.principal.scopes.includes(`${GOOGLE_SCOPE}drive.file`))
    throw new NativeActionError(
      "insufficient_scope",
      "The selected Google grant lacks the required permission.",
    );
  const file = identity(
    await googleCall(context, {
      service: "drive",
      method: "GET",
      path: `/files/${enc(fileId)}`,
      query: { fields: "id,isAppAuthorized", supportsAllDrives: true },
    }),
    "id",
    fileId,
  );
  if (file.isAppAuthorized !== true)
    throw new NativeActionError(
      "resource_unavailable",
      "Open or select this file for this Google app before using it.",
    );
}
export async function currentRevision(
  context: NativeActionContext,
  resource: "documents" | "presentations",
  id: unknown,
  expected?: unknown,
): Promise<Obj> {
  const key = resource === "documents" ? "documentId" : "presentationId";
  const body = identity(
    await googleCall(context, {
      method: "GET",
      path: `/${resource}/${enc(id)}`,
      ...(resource === "documents"
        ? { query: { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" } }
        : {}),
    }),
    key,
    id,
  );
  if (typeof body.revisionId !== "string" || !body.revisionId)
    throw new NativeActionError(
      "incomplete_response",
      "Google omitted the revision required for a safe edit.",
    );
  if (expected !== undefined && expected !== body.revisionId)
    throw new NativeActionError(
      "version_conflict",
      "Read this resource again before proposing the edit.",
    );
  return body;
}
export function replacements(values: unknown): Obj[] {
  return (values as Obj[]).map((item) => ({
    replaceAllText: {
      containsText: { text: item.find, matchCase: item.matchCase },
      replaceText: item.replace,
    },
  }));
}
/** Copy and fill are separate durable phases; partial copies are retained for inspection. */
export async function workspaceTemplate(
  family: "docs" | "slides",
  args: Obj,
  context: NativeActionContext,
): Promise<Obj> {
  const state = await beginWorkspaceWrite(`${family}.templates.create`, args, context);
  if (state.stage === "committed") return receipt(state);
  if (!["prepared", "copied", "fill-prepared"].includes(state.stage))
    return workspaceUnknown(state);
  const resource = family === "docs" ? "documents" : "presentations";
  const idKey = family === "docs" ? "documentId" : "presentationId";
  const mimeType =
    family === "docs"
      ? "application/vnd.google-apps.document"
      : "application/vnd.google-apps.presentation";
  if (state.stage === "prepared") {
    const source = identity(
      await googleCall(context, {
        service: "drive",
        method: "GET",
        path: `/files/${enc(args.templateId)}`,
        query: { fields: "id,mimeType,version,isAppAuthorized", supportsAllDrives: true },
      }),
      "id",
      args.templateId,
    );
    if (source.mimeType !== mimeType)
      invalid("The selected template has the wrong Google file type.");
    if (
      !context.principal.scopes.includes(`${GOOGLE_SCOPE}drive`) &&
      source.isAppAuthorized !== true
    )
      throw new NativeActionError(
        "resource_unavailable",
        "Select this template for this Google app first.",
      );
    await saveWorkspace(context, state, {
      stage: "copy-dispatching",
      sourceVersion: source.version,
    });
    try {
      const copied = identity(
        await googleCall(
          context,
          {
            service: "drive",
            method: "POST",
            path: `/files/${enc(args.templateId)}/copy`,
            query: { fields: "id,mimeType", supportsAllDrives: true },
            body: { name: args.title },
          },
          true,
        ),
        "id",
      );
      await saveWorkspace(context, state, {
        stage: copied.mimeType === mimeType ? "copied" : "copy-invalid",
        destinationId: copied.id,
      });
      if (copied.mimeType !== mimeType) return workspaceUnknown(state);
    } catch (error) {
      if (isUncertain(error)) return workspaceUnknown(state);
      throw error;
    }
  }
  await workspaceFile(context, state.destinationId, ["drive"]);
  if (state.stage === "copied") {
    const copied = await currentRevision(context, resource, state.destinationId);
    await saveWorkspace(context, state, {
      stage: "fill-prepared",
      destinationRevisionId: copied.revisionId,
    });
  }
  await saveWorkspace(context, state, { stage: "fill-dispatching" });
  try {
    const response = identity(
      await googleCall(
        context,
        {
          method: "POST",
          path: `/${resource}/${enc(state.destinationId)}:batchUpdate`,
          body: {
            requests: replacements(args.replacements),
            writeControl: { requiredRevisionId: state.destinationRevisionId },
          },
        },
        true,
      ),
      idKey,
      state.destinationId,
    );
    if (
      !Array.isArray(response.replies) ||
      response.replies.length !== (args.replacements as Obj[]).length
    )
      return workspaceUnknown(state);
    const output = {
      [idKey]: state.destinationId,
      outcome: "succeeded",
      templateFilled: true,
      sourceVersion: state.sourceVersion,
    };
    await saveWorkspace(context, state, {
      stage: "committed",
      receipt: { [idKey]: state.destinationId, templateFilled: true },
      outcome: "succeeded",
    });
    return output;
  } catch (error) {
    if (isUncertain(error)) return workspaceUnknown(state);
    // The copy already exists even when filling is definitively rejected.
    throw new NativeActionError(
      error instanceof NativeActionError ? error.kind : "result_unknown",
      "A template copy exists; review it before continuing.",
      { recovery: structuredClone(state) },
    );
  }
}
interface WorkspaceContract {
  actions: {
    id: string;
    inputSchema: Obj;
    readOnly: boolean;
    authorization: { acceptedAnyOfScopes: string[] };
  }[];
}
export type WorkspaceImplementation = (args: Obj, context: NativeActionContext) => Promise<Obj>;
export function workspaceActions(
  contract: WorkspaceContract,
  implementations: Record<string, WorkspaceImplementation>,
): readonly NativeAction[] {
  return contract.actions.map((row) => {
    const implementation = implementations[row.id];
    if (!implementation) throw new Error(`Missing frozen Google action: ${row.id}`);
    return {
      id: row.id,
      description: row.id,
      inputSchema: row.inputSchema,
      readOnly: row.readOnly,
      scopesAnyOf: row.authorization.acceptedAnyOfScopes,
      execute: async (input, context) => {
        validateNativeInput(row.inputSchema, input);
        if (
          !row.authorization.acceptedAnyOfScopes.some((scope) =>
            context.principal.scopes.includes(scope),
          )
        )
          throw new NativeActionError(
            "insufficient_scope",
            "The exact selected Google connection lacks a permitted scope.",
          );
        context.signal.throwIfAborted();
        return implementation(structuredClone(input), context);
      },
    };
  });
}
