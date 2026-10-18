import type { NativeAction, NativeActionContext, NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import type { Obj, Schema } from "./helpers.js";
import {
  integer,
  object,
  only,
  pick,
  query,
  request,
  requireCapabilities,
  responseObject,
  shape,
  stringList,
  text,
} from "./helpers.js";
import contract from "./knowai.contract.json" with { type: "json" };

const definitions = contract.definitions as Record<string, Schema>;
const ID = { type: "string", minLength: 1 };
const KB_FIELDS = [
  "id",
  "name",
  "description",
  "type",
  "capabilities",
  "knowledge_count",
  "chunk_count",
  "processing_count",
  "is_processing",
  "created_at",
  "updated_at",
];
const DOC_FIELDS = [
  "id",
  "knowledge_base_id",
  "knowledge_base_name",
  "title",
  "type",
  "source",
  "file_name",
  "file_type",
  "file_size",
  "folder_path",
  "parse_status",
  "summary_status",
  "enable_status",
  "stall_state",
  "last_activity_at",
  "created_at",
  "updated_at",
  "processed_at",
];
const CHUNK_FIELDS = [
  "id",
  "knowledge_id",
  "knowledge_base_id",
  "content",
  "chunk_type",
  "chunk_index",
  "index_status",
  "content_revision",
  "parent_chunk_id",
  "start_at",
  "end_at",
  "source_locators",
];
const RESULT_FIELDS = [
  "id",
  "knowledge_id",
  "knowledge_base_id",
  "content",
  "matched_content",
  "score",
  "knowledge_title",
  "knowledge_filename",
  "knowledge_source",
  "chunk_type",
  "chunk_index",
  "parent_chunk_id",
  "match_type",
  "start_at",
  "end_at",
  "source_locators",
];
const PAGE_FIELDS = ["total", "page", "page_size"];
// VLMConfig includes api_key/base_url; parser/private pipeline maps can carry endpoints.
// These settings stay in provider configuration, never in a model-callable action.
const PROCESS_FIELDS = [
  "chunking_config",
  "summary_enabled",
  "graph_enabled",
  "enable_multimodel",
  "question_generation_config",
  "asr_config",
];
const safeProcessSchema = shape(
  pick(definitionProperties("KnowledgeProcessOverrides"), PROCESS_FIELDS),
);
function frozenCall(id: string) {
  const call = contract.actions.find((action) => action.actionId === id)?.upstream_calls[0];
  if (!call) throw new Error(`Missing frozen Knowai call: ${id}`);
  return call;
}
const fileFormSchema = object(
  object(frozenCall("knowai.ingest.file").request_schema.properties).form,
);
const fileFormProperties = object(fileFormSchema.properties);

function modelSchema(properties: Obj, required: string[] = []): Schema {
  return { ...shape(properties, required), definitions };
}

function definitionProperties(name: string): Obj {
  const definition = definitions[name];
  if (!definition) throw new Error(`Missing frozen Knowai definition: ${name}`);
  return object(definition.properties);
}

function bind(context: NativeActionContext, capabilities: readonly string[]): readonly string[] {
  requireCapabilities(context, capabilities);
  if (!context.principal.tenant || !context.principal.knowledgeBaseIds.length) {
    throw new NativeActionError(
      "not_configured",
      "A restricted Knowai machine connection is required.",
    );
  }
  return context.principal.knowledgeBaseIds;
}

function kb(context: NativeActionContext, value: unknown): string {
  const id = text(value, "knowledgeBaseId");
  if (!context.principal.knowledgeBaseIds.includes(id))
    throw new NativeActionError(
      "insufficient_scope",
      "This knowledge base is outside the connection scope.",
    );
  return id;
}

function pathId(value: unknown, label: string): string {
  const id = text(value, label, 2048);
  if (
    id === "." ||
    id === ".." ||
    /[\\/]/.test(id) ||
    [...id].some((char) => char.charCodeAt(0) < 32)
  )
    throw new NativeActionError("invalid_input", `Invalid ${label}.`);
  return encodeURIComponent(id);
}

function data(value: unknown): unknown {
  const envelope = responseObject(value);
  if (envelope.success !== true || !Object.hasOwn(envelope, "data"))
    throw new NativeActionError("incomplete_response", "Knowai returned an incomplete response.");
  return envelope.data;
}

async function document(context: NativeActionContext, value: unknown): Promise<Obj> {
  bind(context, ["retrieve"]);
  const id = text(value, "knowledgeId");
  const result = responseObject(
    data(
      await request(
        context,
        { method: "GET", path: `/api/v1/knowledge/${pathId(id, "knowledgeId")}` },
        false,
      ),
    ),
  );
  if (result.id !== id)
    throw new NativeActionError(
      "incomplete_response",
      "The document response did not match the requested ID.",
    );
  kb(context, result.knowledge_base_id);
  return result;
}

function safeDocument(value: unknown, context: NativeActionContext, expectedKb?: string): Obj {
  const result = responseObject(value);
  const owning = kb(context, result.knowledge_base_id);
  if (expectedKb && owning !== expectedKb)
    throw new NativeActionError(
      "incomplete_response",
      "The returned document is outside the requested knowledge base.",
    );
  if (typeof result.id !== "string" || !result.id)
    throw new NativeActionError("incomplete_response", "The document ID is unavailable.");
  return pick(result, DOC_FIELDS);
}

function recoveryFor(context: NativeActionContext, actionId: string): Obj | undefined {
  if (context.recovery === undefined) return undefined;
  const recovery = responseObject(context.recovery);
  if (recovery.actionId !== actionId || typeof recovery.phase !== "string") {
    throw new NativeActionError("result_unknown", "The original operation needs verification.", {
      uncertain: true,
    });
  }
  return recovery;
}

async function checkpoint(
  context: NativeActionContext,
  recovery: Obj,
  remoteStarted: boolean,
): Promise<void> {
  try {
    await context.checkpoint(recovery);
  } catch (error) {
    if (!remoteStarted && error instanceof NativeActionError) throw error;
    throw new NativeActionError(
      remoteStarted ? "result_unknown" : "temporarily_unavailable",
      "The operation checkpoint could not be saved.",
      {
        uncertain: remoteStarted,
        recovery,
      },
    );
  }
}

async function resumeSubmission(
  actionId: string,
  args: Obj,
  context: NativeActionContext,
): Promise<Obj | undefined> {
  const recovery = recoveryFor(context, actionId);
  if (!recovery) return undefined;
  const base = kb(context, recovery.knowledgeBaseId);
  if (
    (args.knowledgeBaseId !== undefined && args.knowledgeBaseId !== base) ||
    (args.knowledgeId !== undefined && args.knowledgeId !== recovery.knowledgeId)
  ) {
    throw new NativeActionError(
      "version_conflict",
      "The original resource does not match this operation.",
    );
  }
  if (
    recovery.phase !== "submitted" ||
    typeof recovery.knowledgeId !== "string" ||
    !recovery.knowledgeId
  ) {
    throw new NativeActionError(
      "result_unknown",
      "Verify the original submission before creating another one.",
      { uncertain: true, recovery },
    );
  }
  if (context.principal.capabilities.includes("retrieve")) {
    return safeDocument(await document(context, recovery.knowledgeId), context, base);
  }
  // Ingest-only keys can reuse their acknowledged receipt, but cannot pretend to poll current status.
  const receipt = safeDocument(recovery.result, context, base);
  if (receipt.id !== recovery.knowledgeId)
    throw new NativeActionError(
      "incomplete_response",
      "The acknowledged submission receipt is unavailable.",
      { uncertain: true, recovery },
    );
  return receipt;
}

async function submit(
  actionId: string,
  input: NativeRequest,
  context: NativeActionContext,
  knowledgeBaseId: string,
  knowledgeId?: unknown,
): Promise<Obj> {
  let recovery: Obj = {
    actionId,
    phase: "submission_started",
    knowledgeBaseId,
    ...(knowledgeId ? { knowledgeId } : {}),
  };
  await checkpoint(context, recovery, false);
  try {
    const result = safeDocument(
      data(await request(context, input, true, recovery)),
      context,
      knowledgeBaseId,
    );
    recovery = { actionId, phase: "submitted", knowledgeBaseId, knowledgeId: result.id, result };
    await checkpoint(context, recovery, true); // Persist the acknowledged stable ID before returning.
    return result;
  } catch (error) {
    if (error instanceof NativeActionError)
      throw new NativeActionError(error.kind, error.message, {
        ...error.options,
        recovery: { ...recovery, ...error.options.recovery },
      });
    throw error;
  }
}

function processConfig(value: unknown): Obj | undefined {
  if (value === undefined) return undefined;
  const config = object(value, "process_config");
  only(config, PROCESS_FIELDS);
  return config;
}

type Scope = {
  body: Obj;
  baseIds: Set<string>;
  documentIds: Set<string>;
  documentBases: Map<string, string>;
};

async function scopedBody(args: Obj, context: NativeActionContext): Promise<Scope> {
  const body = pick(args, [
    "knowledge_base_id",
    "knowledge_base_ids",
    "knowledge_ids",
    "tag_ids",
    "mentioned_items",
  ]);
  const baseIds = new Set<string>();
  const documentIds = new Set<string>();
  const documentBases = new Map<string, string>();
  if (args.knowledge_base_id !== undefined) baseIds.add(kb(context, args.knowledge_base_id));
  if (args.knowledge_base_ids !== undefined)
    for (const id of stringList(args.knowledge_base_ids, "knowledge_base_ids"))
      baseIds.add(kb(context, id));
  if (args.knowledge_ids !== undefined)
    for (const id of stringList(args.knowledge_ids, "knowledge_ids")) documentIds.add(id);
  if (args.tag_ids !== undefined) stringList(args.tag_ids, "tag_ids");
  if (args.mentioned_items !== undefined) {
    if (!Array.isArray(args.mentioned_items))
      throw new NativeActionError("invalid_input", "Invalid mentioned_items.");
    for (const value of args.mentioned_items) {
      const item = object(value, "knowledge mention");
      only(item, ["id", "type", "kb_id", "kb_name", "kb_type", "name"]);
      const id = text(item.id, "mention id");
      if (item.type === "kb") baseIds.add(kb(context, id));
      else if (item.type === "file") {
        documentIds.add(id);
        if (item.kb_id !== undefined) kb(context, item.kb_id);
      } else if (item.type === "tag") kb(context, item.kb_id);
      else
        throw new NativeActionError(
          "invalid_input",
          "Only knowledge-base, file and scoped tag mentions are supported.",
        );
    }
  }
  for (const id of documentIds) {
    const doc = await document(context, id);
    documentBases.set(id, String(doc.knowledge_base_id));
    const mentions = Array.isArray(args.mentioned_items) ? args.mentioned_items : [];
    for (const value of mentions) {
      const item = object(value);
      if (
        item.type === "file" &&
        item.id === id &&
        item.kb_id !== undefined &&
        item.kb_id !== doc.knowledge_base_id
      ) {
        throw new NativeActionError(
          "insufficient_scope",
          "The document does not belong to the selected knowledge base.",
        );
      }
    }
  }
  const tagMentions =
    Array.isArray(args.mentioned_items) &&
    args.mentioned_items.some((value) => object(value).type === "tag");
  if (!baseIds.size && !documentIds.size && !tagMentions)
    throw new NativeActionError("invalid_input", "Select an explicit knowledge scope.");
  if (args.tag_ids !== undefined && !baseIds.size && !tagMentions)
    throw new NativeActionError("invalid_input", "Tags require an explicit knowledge-base scope.");
  // Validate, but do not expand a document-only request into all documents of its parent KB.
  return { body, baseIds, documentIds, documentBases };
}

function results(value: unknown, context: NativeActionContext, scope: Scope): Obj[] {
  if (!Array.isArray(value))
    throw new NativeActionError("incomplete_response", "Knowledge results are unavailable.");
  return value.map((item) => {
    const result = responseObject(item);
    const id = typeof result.knowledge_id === "string" ? result.knowledge_id : "";
    const base = result.knowledge_base_id ?? scope.documentBases.get(id);
    const owning = kb(context, base);
    const tagScope =
      Array.isArray(scope.body.mentioned_items) &&
      scope.body.mentioned_items.some((value) => {
        const mention = object(value);
        return mention.type === "tag" && mention.kb_id === owning;
      });
    if (!id || (!scope.baseIds.has(owning) && !scope.documentIds.has(id) && !tagScope)) {
      throw new NativeActionError(
        "incomplete_response",
        "A result is outside the requested knowledge scope.",
      );
    }
    return pick(result, RESULT_FIELDS);
  });
}

function action(
  id: string,
  description: string,
  inputSchema: Schema,
  capabilities: readonly string[],
  execute: NativeAction["execute"],
): NativeAction {
  const frozen = contract.actions.find((item) => item.actionId === id);
  if (!frozen) throw new Error(`Unknown frozen Knowai action: ${id}`);
  return {
    id,
    description,
    inputSchema,
    readOnly: frozen.readOnly,
    capabilities,
    execute: async (args, context) => {
      bind(context, capabilities);
      try {
        return await execute(args, context);
      } catch (error) {
        if (
          !frozen.readOnly &&
          error instanceof NativeActionError &&
          error.kind === "incomplete_response" &&
          !error.options.uncertain
        ) {
          throw new NativeActionError(error.kind, error.message, {
            ...error.options,
            uncertain: true,
            recovery: { operationId: context.operationId, ...error.options.recovery },
          });
        }
        throw error;
      }
    },
  };
}

const scopeProperties = pick(definitionProperties("SearchKnowledgeRequest"), [
  "knowledge_base_id",
  "knowledge_base_ids",
  "knowledge_ids",
  "tag_ids",
  "mentioned_items",
]);
// Do not expose MCP/Skill mention shapes from the shared upstream DTO.
scopeProperties.mentioned_items = {
  type: "array",
  items: shape(
    {
      id: ID,
      type: { enum: ["kb", "file", "tag"] },
      kb_id: ID,
      kb_name: { type: "string" },
      kb_type: { enum: ["document", "faq", "wiki"] },
      name: { type: "string" },
    },
    ["id", "type"],
  ),
};
const searchProperties = { ...definitionProperties("SearchKnowledgeRequest"), ...scopeProperties };
const listQuerySchema = object(
  frozenCall("knowai.documents.list").request_schema.properties.query.properties,
);
const urlProperties = {
  ...definitionProperties("CreateKnowledgeFromURLRequest"),
  process_config: safeProcessSchema,
};
const markdownProperties = {
  ...definitionProperties("ManualKnowledgePayload"),
  process_config: safeProcessSchema,
};
const qaProperties = {
  query: { type: "string", minLength: 1 },
  ...pick(scopeProperties, ["knowledge_base_ids", "knowledge_ids", "tag_ids", "mentioned_items"]),
  title: { type: "string" },
  description: { type: "string" },
};

export const knowaiActions: readonly NativeAction[] = [
  action(
    "knowai.knowledge_bases.list",
    "List the machine connection's permitted knowledge bases.",
    modelSchema({ creator: { enum: ["mine", "others"] } }),
    ["retrieve"],
    async (args, context) => {
      only(args, ["creator"]);
      const value = data(
        await request(
          context,
          { method: "GET", path: "/api/v1/knowledge-bases", query: query(args, ["creator"]) },
          false,
        ),
      );
      if (!Array.isArray(value))
        throw new NativeActionError("incomplete_response", "Knowledge bases are unavailable.");
      return {
        data: value
          .map(responseObject)
          .filter((item) => context.principal.knowledgeBaseIds.includes(String(item.id)))
          .map((item) => pick(item, KB_FIELDS)),
      };
    },
  ),
  action(
    "knowai.knowledge_bases.get",
    "Read safe knowledge-base identity, counts and capabilities.",
    modelSchema({ knowledgeBaseId: ID }, ["knowledgeBaseId"]),
    ["retrieve"],
    async (args, context) => {
      only(args, ["knowledgeBaseId"]);
      const id = kb(context, args.knowledgeBaseId);
      const value = responseObject(
        data(
          await request(
            context,
            { method: "GET", path: `/api/v1/knowledge-bases/${pathId(id, "knowledgeBaseId")}` },
            false,
          ),
        ),
      );
      if (value.id !== id)
        throw new NativeActionError(
          "incomplete_response",
          "The knowledge-base response did not match the requested ID.",
        );
      return pick(value, KB_FIELDS);
    },
  ),
  action(
    "knowai.search",
    "Search explicit permitted knowledge; retain stable references without temporary resource URLs.",
    modelSchema(searchProperties, ["query"]),
    ["retrieve"],
    async (args, context) => {
      only(args, Object.keys(searchProperties));
      text(args.query, "query");
      const scope = await scopedBody(args, context);
      const envelope = responseObject(
        await request(
          context,
          {
            method: "POST",
            path: "/api/v1/knowledge-search",
            query: { resource_urls: "handle" },
            body: { ...args, ...scope.body },
          },
          false,
        ),
      );
      return { data: results(data(envelope), context, scope), meta: envelope.meta };
    },
  ),
  action(
    "knowai.documents.list",
    "List one permitted KB with page numbers and actual parse states.",
    modelSchema({ knowledgeBaseId: ID, ...listQuerySchema }, ["knowledgeBaseId"]),
    ["retrieve"],
    async (args, context) => {
      only(args, ["knowledgeBaseId", ...Object.keys(listQuerySchema)]);
      const id = kb(context, args.knowledgeBaseId);
      if (args.page !== undefined) integer(args.page, "page", 1, Number.MAX_SAFE_INTEGER);
      if (args.page_size !== undefined) integer(args.page_size, "page_size", 1, 1000);
      const envelope = responseObject(
        await request(
          context,
          {
            method: "GET",
            path: `/api/v1/knowledge-bases/${pathId(id, "knowledgeBaseId")}/knowledge`,
            query: query(args, Object.keys(listQuerySchema)),
          },
          false,
        ),
      );
      const items = data(envelope);
      if (!Array.isArray(items))
        throw new NativeActionError("incomplete_response", "Documents are unavailable.");
      return {
        ...pick(envelope, PAGE_FIELDS),
        data: items.map((value) => safeDocument(value, context, id)),
      };
    },
  ),
  action(
    "knowai.documents.get",
    "Read a document only after verifying its owning knowledge base.",
    modelSchema({ knowledgeId: ID }, ["knowledgeId"]),
    ["retrieve"],
    async (args, context) => {
      only(args, ["knowledgeId"]);
      return safeDocument(await document(context, args.knowledgeId), context);
    },
  ),
  action(
    "knowai.documents.chunks",
    "Read a document's text chunks with bounded page size and source locators.",
    modelSchema(
      {
        knowledgeId: ID,
        page: { type: "integer", minimum: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["knowledgeId"],
    ),
    ["retrieve"],
    async (args, context) => {
      only(args, ["knowledgeId", "page", "page_size"]);
      const doc = await document(context, args.knowledgeId);
      if (args.page !== undefined) integer(args.page, "page", 1, Number.MAX_SAFE_INTEGER);
      if (args.page_size !== undefined) integer(args.page_size, "page_size", 1, 100);
      const envelope = responseObject(
        await request(
          context,
          {
            method: "GET",
            path: `/api/v1/chunks/${pathId(doc.id, "knowledgeId")}`,
            query: query(args, ["page", "page_size"]),
          },
          false,
        ),
      );
      const items = data(envelope);
      if (!Array.isArray(items))
        throw new NativeActionError("incomplete_response", "Chunks are unavailable.");
      return {
        ...pick(envelope, PAGE_FIELDS),
        data: items.map((value) => {
          const item = responseObject(value);
          if (
            item.knowledge_id !== doc.id ||
            (item.knowledge_base_id && item.knowledge_base_id !== doc.knowledge_base_id)
          )
            throw new NativeActionError(
              "incomplete_response",
              "The chunk belongs to another document.",
            );
          return pick(item, CHUNK_FIELDS);
        }),
      };
    },
  ),
  action(
    "knowai.ingest.file",
    "Submit an authorized artifact; submission is not completed parsing.",
    modelSchema(
      {
        knowledgeBaseId: ID,
        artifactId: ID,
        ...pick(fileFormProperties, ["fileName", "metadata", "enable_multimodel", "tag_ids"]),
        process_config: safeProcessSchema,
      },
      ["knowledgeBaseId", "artifactId"],
    ),
    ["ingest"],
    async (args, context) => {
      only(args, [
        "knowledgeBaseId",
        "artifactId",
        "fileName",
        "metadata",
        "enable_multimodel",
        "tag_ids",
        "process_config",
      ]);
      const id = kb(context, args.knowledgeBaseId);
      const resumed = await resumeSubmission("knowai.ingest.file", args, context);
      if (resumed) return resumed;
      const artifact = await context.readArtifact(text(args.artifactId, "artifactId"));
      const configured = context.principal.context.maxUploadBytes;
      const limit =
        typeof configured === "number"
          ? integer(configured, "configured upload limit", 1, Number.MAX_SAFE_INTEGER)
          : 50 * 1024 * 1024;
      if (artifact.bytes.byteLength > limit)
        throw new NativeActionError(
          "invalid_input",
          "The artifact exceeds the connection upload limit.",
        );
      const config = processConfig(args.process_config);
      const form = new FormData();
      const name = (
        args.fileName === undefined ? artifact.name : text(args.fileName, "fileName")
      ).replace(/[\\/\r\n]/g, "_");
      form.set(
        "file",
        new Blob([Uint8Array.from(artifact.bytes)], { type: artifact.mimeType }),
        name,
      );
      if (args.fileName !== undefined) form.set("fileName", name);
      for (const key of ["metadata", "enable_multimodel", "tag_ids"])
        if (args[key] !== undefined) form.set(key, String(args[key]));
      if (config) form.set("process_config", JSON.stringify(config));
      return submit(
        "knowai.ingest.file",
        {
          method: "POST",
          path: `/api/v1/knowledge-bases/${pathId(id, "knowledgeBaseId")}/knowledge/file`,
          body: form,
        },
        context,
        id,
      );
    },
  ),
  action(
    "knowai.ingest.url",
    "Submit a policy-checked resource URL into one permitted knowledge base.",
    modelSchema({ knowledgeBaseId: ID, ...urlProperties }, ["knowledgeBaseId", "url"]),
    ["ingest"],
    async (args, context) => {
      only(args, ["knowledgeBaseId", ...Object.keys(urlProperties)]);
      const id = kb(context, args.knowledgeBaseId);
      const resumed = await resumeSubmission("knowai.ingest.url", args, context);
      if (resumed) return resumed;
      const url = text(args.url, "url");
      await context.validateResourceUrl(url);
      processConfig(args.process_config);
      return submit(
        "knowai.ingest.url",
        {
          method: "POST",
          path: `/api/v1/knowledge-bases/${pathId(id, "knowledgeBaseId")}/knowledge/url`,
          body: pick(args, Object.keys(urlProperties)),
        },
        context,
        id,
      );
    },
  ),
  action(
    "knowai.ingest.markdown",
    "Submit explicit draft or published Markdown; indexing may still be pending.",
    modelSchema({ knowledgeBaseId: ID, ...markdownProperties }, [
      "knowledgeBaseId",
      "title",
      "content",
      "status",
    ]),
    ["ingest"],
    async (args, context) => {
      only(args, ["knowledgeBaseId", ...Object.keys(markdownProperties)]);
      const id = kb(context, args.knowledgeBaseId);
      const resumed = await resumeSubmission("knowai.ingest.markdown", args, context);
      if (resumed) return resumed;
      text(args.title, "title");
      const content = text(args.content, "content", 200000);
      if (
        new TextEncoder().encode(content).byteLength > 800000 ||
        !["draft", "publish"].includes(String(args.status))
      )
        throw new NativeActionError("invalid_input", "Invalid Markdown submission.");
      processConfig(args.process_config);
      return submit(
        "knowai.ingest.markdown",
        {
          method: "POST",
          path: `/api/v1/knowledge-bases/${pathId(id, "knowledgeBaseId")}/knowledge/manual`,
          body: pick(args, Object.keys(markdownProperties)),
        },
        context,
        id,
      );
    },
  ),
  action(
    "knowai.ingest.status",
    "Read the same document's actual parse attempt and stage without private trace payloads.",
    modelSchema({ knowledgeId: ID, attempt: { type: "integer", minimum: 1 } }, ["knowledgeId"]),
    ["retrieve"],
    async (args, context) => {
      only(args, ["knowledgeId", "attempt"]);
      const doc = await document(context, args.knowledgeId);
      if (args.attempt !== undefined) integer(args.attempt, "attempt", 1, Number.MAX_SAFE_INTEGER);
      const result = responseObject(
        data(
          await request(
            context,
            {
              method: "GET",
              path: `/api/v1/knowledge/${pathId(doc.id, "knowledgeId")}/stages`,
              query: query(args, ["attempt"]),
            },
            false,
          ),
        ),
      );
      if (result.knowledge_id !== doc.id)
        throw new NativeActionError(
          "incomplete_response",
          "The parse status belongs to another document.",
        );
      return {
        ...pick(result, [
          "knowledge_id",
          "attempt",
          "latest_attempt",
          "parse_status",
          "current_attempt",
          "current_stage",
          "last_activity_at",
          "stall_state",
        ]),
        ...(result.last_error
          ? {
              last_error: pick(responseObject(result.last_error), [
                "code",
                "error_code",
                "stage",
                "name",
                "finished_at",
              ]),
            }
          : {}),
      };
    },
  ),
  action(
    "knowai.ingest.reparse",
    "Reparse one scope-verified document; preserve asynchronous status and do not blindly resubmit.",
    modelSchema({ knowledgeId: ID, process_config: safeProcessSchema }, ["knowledgeId"]),
    ["ingest", "retrieve"],
    async (args, context) => {
      only(args, ["knowledgeId", "process_config"]);
      const resumed = await resumeSubmission("knowai.ingest.reparse", args, context);
      if (resumed) return resumed;
      const doc = await document(context, args.knowledgeId);
      processConfig(args.process_config);
      return submit(
        "knowai.ingest.reparse",
        {
          method: "POST",
          path: `/api/v1/knowledge/${pathId(doc.id, "knowledgeId")}/reparse`,
          body: pick(args, ["process_config"]),
        },
        context,
        String(doc.knowledge_base_id),
        doc.id,
      );
    },
  ),
  action(
    "knowai.qa.ask",
    "Run a knowledge-only remote QA session and aggregate its answer, references and completion.",
    modelSchema(qaProperties, ["query"]),
    ["chat"],
    async (args, context) => {
      only(args, Object.keys(qaProperties));
      text(args.query, "query");
      const scope = await scopedBody(args, context);
      const original = recoveryFor(context, "knowai.qa.ask");
      if (original && original.phase !== "session_created") {
        if (original.phase === "knowledge_qa_complete") {
          const result = responseObject(original.result);
          if (
            result.sessionId !== original.sessionId ||
            result.complete !== true ||
            typeof result.answer !== "string"
          )
            throw new NativeActionError(
              "incomplete_response",
              "The original QA result is unavailable.",
              { uncertain: true, recovery: original },
            );
          results(result.references, context, scope); // Recheck current scope before returning an acknowledged result.
          return result;
        }
        throw new NativeActionError(
          "result_unknown",
          "Verify the original session before submitting another question.",
          { uncertain: true, recovery: original },
        );
      }
      let sessionId: string;
      if (original) sessionId = text(original.sessionId, "checkpoint sessionId");
      else {
        const started = { actionId: "knowai.qa.ask", phase: "session_creation_started" };
        await checkpoint(context, started, false);
        let session: Obj;
        try {
          session = responseObject(
            data(
              await request(
                context,
                {
                  method: "POST",
                  path: "/api/v1/sessions",
                  body: pick(args, ["title", "description"]),
                },
                true,
                started,
              ),
            ),
          );
        } catch (error) {
          if (error instanceof NativeActionError)
            throw new NativeActionError(error.kind, error.message, {
              ...error.options,
              recovery: { ...started, ...error.options.recovery },
            });
          throw error;
        }
        if (typeof session.id !== "string" || !session.id)
          throw new NativeActionError(
            "incomplete_response",
            "The created QA session ID is unavailable.",
            { uncertain: true, recovery: started },
          );
        sessionId = session.id;
        // First operation after ACK: persist its ID on the same fenced ExternalEffect.
        await checkpoint(
          context,
          { actionId: "knowai.qa.ask", phase: "session_created", sessionId },
          true,
        );
      }
      const startedQa = { actionId: "knowai.qa.ask", phase: "knowledge_qa_started", sessionId };
      await checkpoint(context, startedQa, true);
      try {
        const stream = await request(
          context,
          {
            method: "POST",
            path: `/api/v1/knowledge-chat/${pathId(sessionId, "sessionId")}`,
            query: { resource_urls: "handle" },
            responseType: "text",
            body: {
              query: args.query,
              ...scope.body,
              agent_enabled: false,
              web_search_enabled: false,
              local_browser_enabled: false,
              disable_title: true,
              channel: "api",
            },
          },
          true,
          startedQa,
        );
        const result = aggregateKnowledgeSse(stream, sessionId, context, scope);
        await checkpoint(
          context,
          { actionId: "knowai.qa.ask", phase: "knowledge_qa_complete", sessionId, result },
          true,
        );
        return result;
      } catch (error) {
        if (error instanceof NativeActionError)
          throw new NativeActionError(error.kind, error.message, {
            ...error.options,
            recovery: { ...startedQa, ...error.options.recovery },
          });
        throw error;
      }
    },
  ),
];

export function aggregateKnowledgeSse(
  stream: unknown,
  sessionId: string,
  context: NativeActionContext,
  scope: Scope,
): Obj {
  let answer = "";
  let references: Obj[] = [];
  let usage: unknown;
  let requestId: string | undefined;
  let assistantMessageId: string | undefined;
  let finishReason: string | undefined;
  let truncated = false;
  let complete = false;
  const interrupted = (message: string): never => {
    throw new NativeActionError("incomplete_response", message, {
      uncertain: true,
      recovery: {
        operationId: context.operationId,
        sessionId,
        requestId,
        assistantMessageId,
        answer,
        references,
        usage,
        finishReason,
        truncated,
        complete: false,
        phase: "knowledge_qa_started", // Read back; do not POST a second question.
      },
    });
  };
  if (typeof stream !== "string") return interrupted("The QA response stream is unavailable.");
  const normalized = stream.replace(/\r\n/g, "\n");
  const events = normalized.split("\n\n");
  // SSE dispatch requires a blank line; an unterminated tail is not a completed event.
  events.pop();
  for (const event of events) {
    if (context.signal.aborted) return interrupted("The QA response was interrupted.");
    const payload = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!payload) continue; // comments/keepalive
    let frame: Obj;
    try {
      frame = responseObject(JSON.parse(payload));
    } catch {
      return interrupted("The QA response stream was malformed.");
    }
    if (typeof frame.id !== "string" || !frame.id || (requestId && requestId !== frame.id))
      return interrupted("The QA request identity changed.");
    requestId = frame.id;
    if (frame.session_id && frame.session_id !== sessionId)
      return interrupted("The QA session identity changed.");
    if (typeof frame.assistant_message_id === "string")
      assistantMessageId = frame.assistant_message_id;
    if (
      (Array.isArray(frame.tool_calls) && frame.tool_calls.length) ||
      ["tool_call", "tool_result"].includes(String(frame.response_type))
    )
      return interrupted("Unexpected tool activity in knowledge-only QA.");
    if (frame.response_type === "stop" || frame.response_type === "error")
      return interrupted("The QA response did not complete.");
    if (frame.response_type === "answer") {
      if (typeof frame.content !== "string")
        return interrupted("The QA answer frame was incomplete.");
      answer += frame.content;
    }
    if (frame.knowledge_references !== undefined) {
      try {
        references = results(frame.knowledge_references, context, scope);
      } catch {
        return interrupted("A QA reference is outside the requested knowledge scope.");
      }
    }
    if (frame.usage !== undefined) usage = frame.usage;
    const metadata =
      frame.data !== null && typeof frame.data === "object" && !Array.isArray(frame.data)
        ? (frame.data as Obj)
        : undefined;
    truncated = metadata?.truncated === true;
    if (truncated || metadata?.superseded === true || metadata?.suspended)
      return interrupted("The QA response is partial or suspended.");
    if (frame.finish_reason !== undefined) {
      if (typeof frame.finish_reason !== "string")
        return interrupted("The QA finish reason is malformed.");
      const reason = frame.finish_reason.trim().toLowerCase();
      if (reason && !["stop", "end_turn", "stop_sequence"].includes(reason)) {
        finishReason = [
          "incomplete",
          "length",
          "max_tokens",
          "max_output_tokens",
          "content_filter",
          "tool_calls",
          "function_call",
        ].includes(reason)
          ? reason
          : "unsupported";
        return interrupted("The QA response did not finish normally.");
      }
      finishReason = reason || undefined;
    }
    if (frame.response_type === "complete" && frame.done === true) {
      complete = true;
      break;
    }
  }
  if (!complete) return interrupted("The QA response ended before completion.");
  return { sessionId, requestId, assistantMessageId, answer, references, usage, complete: true };
}
