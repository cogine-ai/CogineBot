import { createHash } from "node:crypto";
import type { NativeAction, NativeActionContext } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./coginex.contract.json" with { type: "json" };
import type { Obj, Schema } from "./helpers.js";
import {
  integer,
  object,
  only,
  pick,
  responseObject,
  shape,
  stringList,
  text,
  uuid,
} from "./helpers.js";

const byId = new Map(contract.actions.map((action) => [action.actionId, action]));
const SEARCH_TYPES: Record<string, string> = {
  document: "documents",
  project: "projects",
  email: "emails",
  channel: "channels",
  call: "call_records",
  calendar_event: "calendar_events",
};

function rawSchema(id: string, index = 0): Schema {
  const action = byId.get(id);
  if (!action) throw new Error(`Unknown frozen X action: ${id}`);
  const call = action.upstream_calls[index];
  if (!call) throw new Error(`Missing frozen X call: ${id}/${index}`);
  return structuredClone(call.request_schema) as Schema;
}

function schema(id: string, properties?: Obj, required?: string[]): Schema {
  const raw = rawSchema(id);
  return {
    ...raw,
    ...(properties ? { properties } : {}),
    ...(required ? { required } : {}),
    additionalProperties: false,
    $defs: contract.$defs,
  };
}

function properties(id: string): Obj {
  return object(rawSchema(id).properties);
}

function bound(context: NativeActionContext): Obj {
  if (!context.principal.scopes.includes("mcp")) {
    throw new NativeActionError("insufficient_scope", "CogineX MCP permission is required.");
  }
  const value = responseObject(context.principal.context.xConnectionContext);
  if (
    value.schemaVersion !== 2 ||
    typeof value.accountSubject !== "string" ||
    typeof value.resource !== "string" ||
    (value.organizationId !== null && !Number.isSafeInteger(value.organizationId))
  ) {
    throw new NativeActionError("not_configured", "The verified CogineX identity is unavailable.");
  }
  // The composition root verified issuer/resource/subject when creating this bound context.
  return value;
}

function allowedTypes(context: NativeActionContext, requested: unknown, search: boolean): string[] {
  const configured = context.principal.context.allowedEntityTypes;
  const types =
    configured === undefined ? ["document"] : stringList(configured, "configured entity types");
  const allowed = search
    ? types.flatMap((type) => (SEARCH_TYPES[type] ? [SEARCH_TYPES[type]] : []))
    : types;
  const selected = stringList(requested, "entity types");
  if (!selected.length || selected.some((type) => !allowed.includes(type))) {
    throw new NativeActionError(
      "insufficient_scope",
      "Select an explicitly permitted entity type.",
    );
  }
  return selected;
}

/** Domain-separated, stable mapping of the existing effect key; never a random retry ID. */
export function xOperationId(effectKey: string): string {
  const hex = createHash("sha256")
    .update(`coginebot/native/coginex/v1\0${text(effectKey, "operation key")}`)
    .digest("hex")
    .slice(0, 32);
  const chars = hex.split("");
  chars[12] = "8";
  chars[16] = ((Number.parseInt(hex.charAt(16), 16) & 3) | 8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function call(
  context: NativeActionContext,
  tool: string,
  args: Obj,
  write = false,
): Promise<Obj> {
  bound(context);
  try {
    // This is the trusted, already-bound MCP transport; no model endpoint or tools/list passthrough.
    return responseObject(await context.callMcp(tool, args));
  } catch (error) {
    if (error instanceof NativeActionError) {
      if (write && error.kind === "incomplete_response")
        throw new NativeActionError(error.kind, error.message, {
          ...error.options,
          uncertain: true,
          recovery: { operationId: context.operationId, tool, ...error.options.recovery },
        });
      throw error;
    }
    throw new NativeActionError(
      write ? "result_unknown" : "temporarily_unavailable",
      "CogineX response unavailable.",
      {
        uncertain: write,
        recovery: {
          operationId: context.operationId,
          tool,
          ...(args.operationId ? { upstreamOperationId: args.operationId } : {}),
        },
      },
    );
  }
}

function structuredOutcome(result: Obj, operationId?: string): Obj {
  if (
    result.schemaVersion !== 1 ||
    typeof result.outcome !== "string" ||
    (operationId && result.operationId !== operationId)
  ) {
    throw new NativeActionError("incomplete_response", "CogineX returned an incomplete result.", {
      uncertain: !!operationId,
      recovery: { upstreamOperationId: operationId },
    });
  }
  if (result.outcome === "statusConflict" || result.outcome === "conflict") {
    throw new NativeActionError("version_conflict", "The task changed; review its current state.");
  }
  if (result.outcome === "incomplete") {
    throw new NativeActionError("result_unknown", "Check this operation before trying again.", {
      uncertain: true,
      recovery: { upstreamOperationId: operationId, outcome: result.outcome },
    });
  }
  if (result.outcome === "rejected") {
    const failure = responseObject(result.failure);
    throw new NativeActionError(
      failure.retryable === true ? "temporarily_unavailable" : "resource_unavailable",
      "The task operation is unavailable.",
    );
  }
  return result;
}

function action(
  id: string,
  description: string,
  inputSchema: Schema,
  execute: NativeAction["execute"],
): NativeAction {
  const frozen = byId.get(id);
  if (!frozen) throw new Error(`Unknown frozen X action: ${id}`);
  return { id, description, inputSchema, readOnly: frozen.readOnly, scopesAnyOf: ["mcp"], execute };
}

const listKeys = Object.keys(properties("coginex.entities.list"));
const searchKeys = Object.keys(properties("coginex.search.name"));
const listProperties = properties("coginex.entities.list");
listProperties.includeTypes = { type: "array", minItems: 1, items: { $ref: "#/$defs/ItemType" } };
const nameProperties = properties("coginex.search.name");
nameProperties.entityTypes = {
  type: "array",
  minItems: 1,
  items: { $ref: "#/$defs/UnifiedSearchIndex" },
};
const contentProperties = properties("coginex.search.content");
contentProperties.entityTypes = nameProperties.entityTypes;
const createTaskProperties = properties("coginex.tasks.create");
delete createTaskProperties.operationId;
const setStatusProperties = properties("coginex.tasks.status.set");
delete setStatusProperties.operationId;
const postProperties = properties("coginex.tasks.progress.post");
delete postProperties.operationId;

export const coginexActions: readonly NativeAction[] = [
  action(
    "coginex.entities.list",
    "List permitted CogineX entities; preserve hasMore and truncation.",
    schema("coginex.entities.list", listProperties, ["includeTypes"]),
    async (args, context) => {
      only(args, listKeys);
      const includeTypes = allowedTypes(context, args.includeTypes, false);
      if (args.limit !== undefined && args.limit !== null) integer(args.limit, "limit", 1, 500);
      return call(context, "ListEntities", { ...args, includeTypes });
    },
  ),
  action(
    "coginex.search.name",
    "Find permitted candidate resources by name.",
    schema("coginex.search.name", nameProperties, ["name", "entityTypes"]),
    async (args, context) => {
      only(args, searchKeys);
      text(args.name, "name");
      return call(context, "NameSearch", {
        ...args,
        entityTypes: allowedTypes(context, args.entityTypes, true),
      });
    },
  ),
  action(
    "coginex.search.content",
    "Search permitted content; return candidates without choosing ambiguous targets.",
    schema("coginex.search.content", contentProperties, ["query", "entityTypes"]),
    async (args, context) => {
      only(args, ["query", ...searchKeys.filter((key) => key !== "name")]);
      text(args.query, "query");
      return call(context, "ContentSearch", {
        ...args,
        entityTypes: allowedTypes(context, args.entityTypes, true),
      });
    },
  ),
  action(
    "coginex.documents.read",
    "Read metadata and bounded content from the same document.",
    { ...rawSchema("coginex.documents.read", 1), additionalProperties: false },
    async (args, context) => {
      only(args, ["documentId", "maxChars", "includeComments"]);
      const documentId = uuid(args.documentId, "documentId");
      if (args.maxChars !== undefined && args.maxChars !== null)
        integer(args.maxChars, "maxChars", 1, 32000);
      const metadata = await call(context, "ReadMetadata", { documentId });
      if (responseObject(metadata.documentMetadata).documentId !== documentId)
        throw new NativeActionError(
          "incomplete_response",
          "The metadata belongs to another document.",
        );
      const content = await call(context, "ReadContent", { ...args, documentId });
      return { metadata, content }; // New adapter envelope; upstream version and truncation are preserved.
    },
  ),
  action(
    "coginex.documents.create",
    "Create a plaintext document; lost responses require verification before another create.",
    shape(
      pick(properties("coginex.documents.create"), [
        "documentName",
        "fileContent",
        "fileExtension",
      ]),
      ["documentName", "fileContent", "fileExtension"],
    ),
    async (args, context) => {
      only(args, ["documentName", "fileContent", "fileExtension"]);
      text(args.documentName, "documentName");
      text(args.fileContent, "fileContent");
      text(args.fileExtension, "fileExtension");
      const result = await call(context, "CreateDocument", { ...args, isTask: false }, true);
      if (typeof result.documentId !== "string" || !result.documentId) {
        throw new NativeActionError(
          "incomplete_response",
          "The created document ID is unavailable.",
          { uncertain: true, recovery: { operationId: context.operationId } },
        );
      }
      return result;
    },
  ),
  action(
    "coginex.documents.rename",
    "Rename a document and read back its actual metadata.",
    schema("coginex.documents.rename"),
    async (args, context) => {
      only(args, ["documentId", "documentName"]);
      const documentId = uuid(args.documentId, "documentId");
      const documentName = text(args.documentName, "documentName");
      const result = await call(context, "RenameDocument", { documentId, documentName }, true);
      if (
        result.success !== true ||
        result.documentId !== documentId ||
        typeof result.message !== "string"
      )
        throw new NativeActionError("incomplete_response", "The rename result is unconfirmed.", {
          uncertain: true,
          recovery: { documentId, operationId: context.operationId },
        });
      let metadata: Obj;
      let current: Obj;
      try {
        metadata = await call(context, "ReadMetadata", { documentId });
        current = responseObject(metadata.documentMetadata);
        if (current.documentId !== documentId || typeof current.documentName !== "string")
          throw new NativeActionError("incomplete_response", "Document metadata is incomplete.");
      } catch {
        throw new NativeActionError(
          "incomplete_response",
          "Rename accepted; verification is unavailable.",
          { uncertain: true, recovery: { documentId, operationId: context.operationId } },
        );
      }
      if (current.documentName !== documentName)
        throw new NativeActionError(
          "version_conflict",
          "The document name changed after the rename.",
          { recovery: { documentId } },
        );
      return { result, metadata }; // Upstream has no CAS for RenameDocument.
    },
  ),
  action(
    "coginex.tasks.create",
    "Create a task with explicit visibility, defaulting to selfOnly.",
    schema("coginex.tasks.create", createTaskProperties, ["title"]),
    async (args, context) => {
      only(args, ["title", "visibility"]);
      const title = text(args.title, "title", 200);
      const visibility =
        args.visibility === undefined
          ? { scope: "selfOnly" }
          : object(args.visibility, "visibility");
      if (visibility.scope === "selfOnly") only(visibility, ["scope"]);
      else if (visibility.scope === "teamVisible") {
        only(visibility, ["scope", "expectedTeamId"]);
        const team = responseObject(bound(context).teamContext);
        if (
          team.state !== "available" ||
          uuid(visibility.expectedTeamId, "expectedTeamId") !== team.teamId
        ) {
          throw new NativeActionError(
            "insufficient_scope",
            "The expected team does not match this connection.",
          );
        }
      } else throw new NativeActionError("invalid_input", "Explicit task visibility is required.");
      const operationId = xOperationId(context.operationId);
      const result = structuredOutcome(
        await call(context, "CreateXTask", { title, visibility, operationId }, true),
        operationId,
      );
      const taskId = result.task && responseObject(result.task).id;
      if (
        result.outcome !== "confirmed" ||
        typeof taskId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)
      ) {
        throw new NativeActionError("incomplete_response", "The created task ID is unavailable.", {
          uncertain: true,
          recovery: { upstreamOperationId: operationId },
        });
      }
      return result;
    },
  ),
  action(
    "coginex.tasks.status.get",
    "Read actual task status and its opaque concurrency version.",
    schema("coginex.tasks.status.get"),
    async (args, context) => {
      only(args, ["taskId"]);
      const result = structuredOutcome(
        await call(context, "GetXTaskStatus", { taskId: uuid(args.taskId, "taskId") }),
      );
      if (result.outcome !== "available" || !result.status)
        throw new NativeActionError("incomplete_response", "Task status is unavailable.");
      return result;
    },
  ),
  action(
    "coginex.tasks.status.set",
    "Submit only inProgress → inReview using the exact current status version.",
    schema("coginex.tasks.status.set", setStatusProperties, [
      "taskId",
      "expectedStatus",
      "newStatus",
    ]),
    async (args, context) => {
      only(args, ["taskId", "expectedStatus", "newStatus"]);
      const expectedStatus = object(args.expectedStatus, "expectedStatus");
      only(expectedStatus, ["value", "version"]);
      if (
        args.newStatus !== "inReview" ||
        expectedStatus.value !== "inProgress" ||
        !/^task-status-version\/v1\/[0-9a-f]{16}$/.test(
          text(expectedStatus.version, "status version"),
        )
      ) {
        throw new NativeActionError("invalid_input", "Only inProgress → inReview is supported.");
      }
      const operationId = xOperationId(context.operationId);
      const result = structuredOutcome(
        await call(
          context,
          "SetXTaskStatus",
          {
            taskId: uuid(args.taskId, "taskId"),
            operationId,
            expectedStatus,
            newStatus: "inReview",
          },
          true,
        ),
        operationId,
      );
      const status =
        result.status !== null && typeof result.status === "object" && !Array.isArray(result.status)
          ? (result.status as Obj)
          : undefined;
      if (
        !["updated", "alreadyApplied"].includes(String(result.outcome)) ||
        status?.value !== "inReview" ||
        typeof status.version !== "string" ||
        !/^task-status-version\/v1\/[0-9a-f]{16}$/.test(status.version)
      )
        throw new NativeActionError("incomplete_response", "Task status update is unconfirmed.", {
          uncertain: true,
          recovery: { taskId: args.taskId, upstreamOperationId: operationId },
        });
      return result;
    },
  ),
  action(
    "coginex.tasks.progress.post",
    "Post a task comment, or use a server-issued related-thread reference.",
    schema("coginex.tasks.progress.post", postProperties, ["taskId", "content", "mode"]),
    async (args, context) => {
      only(args, ["taskId", "sourceRef", "content", "mode"]);
      const taskId = uuid(args.taskId, "taskId");
      const content = text(args.content, "content", 4000);
      if (args.mode !== "commit" && args.mode !== "readbackOnly")
        throw new NativeActionError("invalid_input", "Invalid message mode.");
      if (args.sourceRef !== undefined && args.sourceRef !== null) {
        const trusted = context.principal.context.taskThreadSourceRefs;
        // Root supplies taskId → exact server-issued refs from the original trusted read receipt.
        const refs = trusted && typeof trusted === "object" ? (trusted as Obj)[taskId] : undefined;
        if (!Array.isArray(refs) || !refs.includes(args.sourceRef))
          throw new NativeActionError(
            "insufficient_scope",
            "The related-thread reference is unavailable.",
          );
      }
      const operationId = xOperationId(context.operationId);
      const result = structuredOutcome(
        await call(
          context,
          "PostXTaskThreadMessage",
          { ...args, taskId, content, operationId },
          true,
        ),
        operationId,
      );
      if (
        !["posted", "existing"].includes(String(result.outcome)) ||
        !result.message ||
        typeof responseObject(result.message).id !== "string" ||
        !responseObject(result.message).id
      )
        throw new NativeActionError("incomplete_response", "The message result is unconfirmed.", {
          uncertain: true,
          recovery: { taskId, upstreamOperationId: operationId, mode: "readbackOnly" },
        });
      return result;
    },
  ),
  action(
    "coginex.channels.thread.read",
    "Read a bounded channel thread and preserve omission markers.",
    schema("coginex.channels.thread.read"),
    async (args, context) => {
      only(args, Object.keys(properties("coginex.channels.thread.read")));
      uuid(args.channelId, "channelId");
      uuid(args.messageId, "messageId");
      if (args.replyId !== undefined && args.replyId !== null) uuid(args.replyId, "replyId");
      for (const key of ["before", "after", "limit"])
        if (args[key] !== undefined && args[key] !== null) integer(args[key], key, 0, 65535);
      return call(context, "ReadChannelThread", args);
    },
  ),
  action(
    "coginex.channels.message.send",
    "Send one channel message without starting a cross-product Agent run.",
    schema("coginex.channels.message.send"),
    async (args, context) => {
      only(args, ["content", "channel_id", "thread_id"]);
      text(args.content, "content");
      uuid(args.channel_id, "channel_id");
      if (args.thread_id !== undefined && args.thread_id !== null)
        uuid(args.thread_id, "thread_id");
      const result = await call(context, "SendChannelMessage", args, true);
      if (
        typeof result.message_id !== "string" ||
        !result.message_id ||
        result.channel_id !== args.channel_id
      )
        throw new NativeActionError("incomplete_response", "The sent message ID is unavailable.", {
          uncertain: true,
          recovery: { channelId: args.channel_id, operationId: context.operationId },
        });
      return result;
    },
  ),
];
