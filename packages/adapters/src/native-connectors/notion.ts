import { createHash } from "node:crypto";
import {
  type NativeAction,
  type NativeActionContext,
  NativeActionError,
  type NativeRequest,
  type NativeResponse,
} from "./action.js";
import contractData from "./notion.contract.json" with { type: "json" };
import { validateNativeInput } from "./validation.js";

type Data = Record<string, any>;
const contract: Data = contractData;
const VERSION = "2026-03-11";
const MiB = 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const fail = (message: string): never => {
  throw new NativeActionError("invalid_input", message);
};
const incomplete = (message: string): never => {
  throw new NativeActionError("incomplete_response", message);
};
const object = (value: any): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : incomplete("Notion returned a non-object response.");
const sameId = (a: any, b: any) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();
const id = (value: any): string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value
    : incomplete("Notion returned an invalid stable ID.");
const segment = (value: string) => {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return fail("Malformed encoded resource ID.");
  }
};
const plainText = (value: string) =>
  value === "" ? [] : [{ type: "text", text: { content: value } }];
function safeEvidence(value: Data = {}): Data {
  const details =
    value.additional_data && typeof value.additional_data === "object"
      ? value.additional_data
      : value;
  const output: Data = {};
  for (const key of ["code", "reason", "request_id", "upstream_code"])
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 200);
  if (typeof value.upstream_status === "number") output.upstream_status = value.upstream_status;
  if (
    typeof details.committed_resource_id === "string" &&
    /^[a-f0-9-]{36}$/i.test(details.committed_resource_id)
  )
    output.committed_resource_id = details.committed_resource_id;
  if (
    Array.isArray(details.committed_child_ids) &&
    details.committed_child_ids.length <= 100 &&
    details.committed_child_ids.every(
      (item: any) => typeof item === "string" && /^[a-f0-9-]{36}$/i.test(item),
    )
  )
    output.committed_child_ids = details.committed_child_ids;
  if (Array.isArray(details.retry_guidance))
    output.retry_guidance = details.retry_guidance.filter((item: any) =>
      ["verify_committed_resources", "verify_destination"].includes(item),
    );
  return output;
}
interface Receipt extends Data {
  action_id: string;
  operation_id: string;
  stage: string;
}
class Run {
  readonly receipt: Receipt;
  mutated = false;
  private sources = new Map<string, Data>();
  constructor(
    readonly actionId: string,
    readonly context: NativeActionContext,
    args: Data,
  ) {
    const binding = {
      action_id: actionId,
      operation_id: context.operationId,
      input_sha256: sha256(canonical(args)),
      principal_sha256: sha256(
        canonical({ subject: context.principal.subject, tenant: context.principal.tenant }),
      ),
    };
    const old = context.recovery;
    if (
      old &&
      Object.keys(old).length &&
      Object.entries(binding).some(([key, value]) => old[key] !== value)
    )
      throw new NativeActionError(
        "invalid_input",
        "The saved effect checkpoint does not match this action, principal or input.",
      );
    this.receipt = { ...clone(old ?? {}), ...binding, stage: String(old?.stage ?? "preflight") };
    if (
      old &&
      actionId !== "notion.files.upload" &&
      old.write_state &&
      old.write_state !== "not_dispatched" &&
      !(
        old.action_complete === true &&
        old.write_state === "acknowledged" &&
        (old.committed_resource_id ||
          (Array.isArray(old.created_block_ids) && old.created_block_ids.length))
      )
    )
      this.unknown(
        "This write already has a dispatch receipt. Reconcile it through the existing effect instead of repeating it.",
      );
  }
  require(...capabilities: string[]) {
    if (!this.context.principal.subject)
      throw new NativeActionError(
        "authorization_required",
        "A verified Notion subject is required.",
      );
    for (const capability of capabilities)
      if (!this.context.principal.capabilities.includes(capability))
        throw new NativeActionError(
          "insufficient_scope",
          `Notion capability ${capability} is required.`,
        );
  }
  recovery(extra: Data = {}) {
    return clone({ ...this.receipt, ...extra });
  }
  unknown(message: string, extra: Data = {}): never {
    throw new NativeActionError("result_unknown", message, {
      uncertain: true,
      recovery: this.recovery(extra),
    });
  }
  async save(extra: Data = {}) {
    Object.assign(this.receipt, extra);
    await this.context.checkpoint(this.recovery());
  }
  async call(
    method: NativeRequest["method"],
    path: string,
    body?: any,
    query?: NativeRequest["query"],
    stage = method === "GET" ? "read" : "write",
  ): Promise<Data> {
    if (!path.startsWith("/v1/") || path.includes("://") || /[\r\n?#]/.test(path))
      return fail("Only fixed Notion relative API paths are allowed.");
    this.context.signal.throwIfAborted();
    const write =
      method !== "GET" &&
      !(method === "POST" && (path === "/v1/search" || path.endsWith("/query")));
    const multipart = body instanceof FormData;
    const request: NativeRequest = {
      method,
      path,
      headers: {
        "Notion-Version": VERSION,
        ...(body !== undefined && !multipart ? { "Content-Type": "application/json" } : {}),
      },
      ...(query ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
    };
    if (body !== undefined && !multipart && Buffer.byteLength(JSON.stringify(body)) > 450000)
      return fail("Notion JSON request exceeds the frozen 450000-byte budget.");
    if (write) {
      this.receipt.stage = stage;
      this.receipt.write_state = "in_flight";
      if (stage.startsWith("send_part_"))
        this.receipt.upload.parts[Number(stage.slice(10)) - 1].dispatch_state = "in_flight";
      if (stage === "send_single") this.receipt.send_state = "in_flight";
      if (stage === "complete_upload") this.receipt.complete_state = "in_flight";
      if (stage === "append_children" || stage === "attach_files")
        this.receipt.attachment_state = "in_flight";
      try {
        await this.save();
      } catch {
        throw new NativeActionError(
          "temporarily_unavailable",
          "The effect checkpoint could not be persisted; the request was not dispatched.",
        );
      }
      this.mutated = true;
    }
    let response: NativeResponse;
    try {
      response = await this.context.request(request);
    } catch (error) {
      if (error instanceof NativeActionError && !error.options.uncertain) throw error;
      if (write)
        return this.unknown(
          `The ${stage} response was not received; do not repeat the write.`,
          error instanceof NativeActionError
            ? safeEvidence(error.options.recovery)
            : { reason: "TRANSPORT_RESPONSE_LOST" },
        );
      throw new NativeActionError(
        "temporarily_unavailable",
        "Notion read request did not complete.",
      );
    }
    const data =
      response.body && typeof response.body === "object" && !Array.isArray(response.body)
        ? (response.body as Data)
        : undefined;
    if (response.status >= 200 && response.status < 300 && response.status !== 202) {
      if (!data)
        return write
          ? this.unknown("Notion accepted a write but returned no usable resource object.")
          : incomplete("Notion returned no usable JSON object.");
      if (write) {
        if (
          stage === "create_upload" &&
          (data.object !== "file_upload" ||
            typeof data.id !== "string" ||
            data.status !== "pending")
        )
          return this.unknown("Upload creation returned no confirmed pending upload identity.");
        if (
          (stage.startsWith("send_part_") ||
            stage === "send_single" ||
            stage === "complete_upload") &&
          (data.object !== "file_upload" || !sameId(data.id, this.receipt.upload_id))
        )
          return this.unknown("The upload response did not identify this exact frozen upload.");
        if (stage === "complete_upload" && data.status !== "uploaded")
          return this.unknown("The completion acknowledgement did not confirm uploaded status.");
        this.receipt.write_state = "acknowledged";
        if (typeof data.id === "string") this.receipt.committed_resource_id = id(data.id);
        if (stage === "create_upload") {
          this.receipt.upload_id = id(data.id);
          this.receipt.upload.upload_id = this.receipt.upload_id;
        }
        if (
          stage === "attach_files" &&
          (data.object !== "page" || !sameId(data.id, this.receipt.attachment_target?.page_id))
        )
          return this.unknown("The attachment acknowledgement did not identify the selected page.");
        if (stage.startsWith("send_part_"))
          this.receipt.upload.parts[Number(stage.slice(10)) - 1].dispatch_state = "acknowledged";
        if (stage === "send_single") this.receipt.send_state = "acknowledged";
        if (stage === "complete_upload") this.receipt.complete_state = "acknowledged";
        if (stage === "append_children" && Array.isArray(data.results))
          this.receipt.created_block_ids = data.results.map((item: Data) => id(item.id));
        if (stage === "append_children" || stage === "attach_files")
          this.receipt.attachment_state = "acknowledged";
        try {
          await this.save();
        } catch {
          return this.unknown(
            "The remote write was acknowledged but its checkpoint was not persisted. Do not repeat it.",
          );
        }
      }
      return data;
    }
    const details = safeEvidence({
      upstream_status: response.status,
      upstream_code: data?.code,
      request_id: data?.request_id,
      additional_data: data?.additional_data,
    });
    if (write && (response.status === 202 || (response.status >= 500 && response.status !== 529)))
      return this.unknown(
        "Notion may have committed this write; reconcile its exact IDs before retrying.",
        details,
      );
    const retry = response.headers.get("retry-after") ?? data?.additional_data?.retry_after;
    const retryAfterSeconds = /^\d+$/.test(String(retry)) ? Number(retry) : undefined;
    const kind =
      response.status === 401
        ? "authorization_expired"
        : response.status === 403
          ? "insufficient_scope"
          : response.status === 404
            ? "resource_unavailable"
            : response.status === 409
              ? "version_conflict"
              : response.status === 429 || response.status === 529
                ? "rate_limited"
                : response.status >= 500
                  ? "temporarily_unavailable"
                  : "invalid_input";
    throw new NativeActionError(kind, String(data?.message ?? `Notion HTTP ${response.status}`), {
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      recovery: this.recovery(details),
    });
  }
  async page(pageId: string) {
    const page = await this.call("GET", `/v1/pages/${segment(pageId)}`);
    if (page.object !== "page" || !sameId(page.id, pageId))
      return incomplete("Notion page response does not match its requested ID.");
    return page;
  }
  async block(blockId: string) {
    const block = await this.call("GET", `/v1/blocks/${segment(blockId)}`);
    if (block.object !== "block" || !sameId(block.id, blockId))
      return incomplete("Notion block response does not match its requested ID.");
    return block;
  }
  async source(sourceId: string, fresh = false) {
    if (!fresh && this.sources.has(sourceId)) return this.sources.get(sourceId)!;
    const source = await this.call("GET", `/v1/data_sources/${segment(sourceId)}`);
    if (source.object !== "data_source" || !sameId(source.id, sourceId) || !source.properties)
      return incomplete("Notion data source schema is incomplete.");
    this.sources.set(sourceId, source);
    return source;
  }
  async database(databaseId: string) {
    const database = await this.call("GET", `/v1/databases/${segment(databaseId)}`);
    if (
      database.object !== "database" ||
      !sameId(database.id, databaseId) ||
      !Array.isArray(database.data_sources)
    )
      return incomplete("Notion database container response is incomplete.");
    return database;
  }
  async sourceForPage(page: Data) {
    if (page.parent?.type !== "data_source_id" || !page.parent.data_source_id) return undefined;
    return this.source(id(page.parent.data_source_id));
  }
  precheck(actual: any, expected: any) {
    if (actual !== expected)
      throw new NativeActionError(
        "version_conflict",
        "The resource changed since the approved read.",
      );
  }
  async recoverCreated(error: unknown, type: "page" | "database") {
    if (!(error instanceof NativeActionError) || !error.options.uncertain) throw error;
    const saved = error.options.recovery as Data | undefined;
    const remoteId = saved?.additional_data?.committed_resource_id ?? saved?.committed_resource_id;
    if (typeof remoteId !== "string") throw error;
    this.receipt.resource_id = id(remoteId);
    return type === "page" ? this.page(remoteId) : this.database(remoteId);
  }
}
const complete = (fields: Data, reasons: string[] = []) => ({
  ...fields,
  complete: reasons.length === 0,
  incomplete_reasons: [...new Set(reasons)],
});
const property = (source: Data, propertyId: string): Data => {
  const entry = Object.entries(object(source.properties)).find(([, value]) => {
    try {
      return decodeURIComponent((value as Data).id) === decodeURIComponent(propertyId);
    } catch {
      return false;
    }
  });
  if (!entry) return fail(`Unknown or inaccessible property ID ${propertyId}.`);
  return { ...object(entry[1]), name: entry[0] };
};
const currentPageProperty = (page: Data, propertyId: string) =>
  property({ properties: page.properties }, propertyId);
const unique = (values: string[], label: string) => {
  if (new Set(values).size !== values.length) return fail(`Duplicate ${label}.`);
};
async function relationTarget(run: Run, target: string) {
  const source = await run.source(id(target));
  if (!source.parent?.database_id)
    return incomplete("Relation target has no authoritative database parent.");
  await run.database(id(source.parent.database_id));
  return source;
}
async function mutations(
  run: Run,
  source: Data,
  entries: Data[],
  allowTitle = true,
): Promise<Data> {
  unique(
    entries.map((entry) => entry.property_id),
    "property mutation targets",
  );
  const body = Object.create(null);
  for (const entry of entries) {
    const prop = property(source, entry.property_id);
    if (prop.type !== entry.kind || (!allowTitle && prop.type === "title"))
      return fail("Property mutation does not match the current writable schema.");
    let value: any;
    if (entry.kind === "title" || entry.kind === "rich_text") value = plainText(entry.value);
    else if (["number", "checkbox", "email", "phone_number"].includes(entry.kind))
      value = entry.value;
    else if (entry.kind === "url") {
      if (entry.value) await run.context.validateResourceUrl(entry.value);
      value = entry.value;
    } else if (entry.kind === "date") {
      value = entry.value;
      if (value?.end && Date.parse(value.end) < Date.parse(value.start))
        return fail("Date end precedes date start.");
    } else if (entry.kind === "select" || entry.kind === "status") {
      if (
        entry.option_id !== null &&
        !prop[entry.kind]?.options?.some((option: Data) => option.id === entry.option_id)
      )
        return fail("The selected option is not in the current property schema.");
      value = entry.option_id === null ? null : { id: entry.option_id };
    } else if (entry.kind === "multi_select") {
      unique(entry.option_ids, "select options");
      if (
        entry.option_ids.some(
          (optionId: string) =>
            !prop.multi_select?.options?.some((option: Data) => option.id === optionId),
        )
      )
        return fail("A selected tag is absent from the current schema.");
      value = entry.option_ids.map((optionId: string) => ({ id: optionId }));
    } else if (entry.kind === "people") {
      unique(entry.user_ids, "assignees");
      value = entry.user_ids.map((userId: string) => ({ id: userId }));
    } else if (entry.kind === "relation") {
      if (!prop.relation?.data_source_id)
        return incomplete("The relation destination is not visible to this connection.");
      const target = await relationTarget(run, prop.relation.data_source_id);
      unique(entry.page_ids, "related pages");
      for (const pageId of entry.page_ids) {
        const page = await run.page(pageId);
        if (!sameId(page.parent?.data_source_id, target.id))
          return fail("A related page belongs to another data source.");
      }
      value = entry.page_ids.map((pageId: string) => ({ id: pageId }));
    } else
      return fail("This generated, unsupported or file property cannot be changed by this action.");
    body[prop.id] = { [entry.kind]: value };
  }
  return body;
}
function blockInput(entry: Data) {
  const type = entry.type;
  if (type === "divider") return { object: "block", type, divider: {} };
  return {
    object: "block",
    type,
    [type]: {
      rich_text: plainText(entry.text),
      ...(type === "to_do" ? { checked: entry.checked } : {}),
      ...(type === "code" ? { language: entry.language } : {}),
    },
  };
}
async function safeMarkdown(run: Run, value: string, replacement = false) {
  const outsideCode = value.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  if (
    /<\/?(?:page|database|unknown|custom-block|synced|table_of_contents)\b/i.test(outsideCode) ||
    (!replacement && /<[^>]+>/.test(outsideCode))
  )
    return fail("Unsupported or protected Markdown markup must not be silently rewritten.");
  for (const match of outsideCode.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g))
    await run.context.validateResourceUrl(match[1]!);
}
function nextPage(page: Data) {
  if (
    !Array.isArray(page.results) ||
    typeof page.has_more !== "boolean" ||
    (page.has_more && (typeof page.next_cursor !== "string" || !page.next_cursor.trim())) ||
    (!page.has_more && page.next_cursor != null)
  )
    return incomplete("Notion pagination metadata is inconsistent.");
  return page.has_more ? (page.next_cursor as string) : null;
}
function resultReasons(page: Data) {
  return [
    ...(page.has_more ? ["MORE_PAGES"] : []),
    ...(page.request_status?.type === "incomplete"
      ? [String(page.request_status.incomplete_reason ?? "UPSTREAM_INCOMPLETE").toUpperCase()]
      : []),
  ];
}
async function listed(run: Run, path: string, query: Data, budget = 100) {
  const results: Data[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let request = 0; request < budget; request++) {
    const page = await run.call("GET", path, undefined, {
      ...query,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const next = nextPage(page);
    results.push(...page.results);
    if (!next) return results;
    if (seen.has(next)) return incomplete("Notion returned a repeated pagination cursor.");
    seen.add(next);
    cursor = next;
  }
  return incomplete("The verification read exceeded its pagination budget.");
}
const handlers: Record<string, (args: Data, run: Run) => Promise<any>> = {};
handlers["notion.search"] = async (args, run) => {
  const body = {
    ...(args.query !== undefined ? { query: args.query } : {}),
    ...(args.object_type ? { filter: { property: "object", value: args.object_type } } : {}),
    ...(args.sort_direction
      ? { sort: { direction: args.sort_direction, timestamp: "last_edited_time" } }
      : {}),
    page_size: args.page_size ?? 50,
    ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
  };
  const result = await run.call("POST", "/v1/search", body);
  const cursor = nextPage(result);
  return complete(
    {
      items: result.results.map((item: Data) => ({
        id: id(item.id),
        object: item.object,
        title: (
          item.title ??
          (Object.values(item.properties ?? {}) as Data[]).find((prop) => prop.type === "title")
            ?.title ??
          []
        )
          .map((part: Data) => part.plain_text ?? part.text?.content ?? "")
          .join(""),
        last_edited_time: item.last_edited_time,
      })),
      has_more: result.has_more,
      next_cursor: cursor,
      ...(result.request_status ? { request_status: result.request_status } : {}),
      enumerates_workspace: false,
    },
    ["SEARCH_IS_NOT_EXHAUSTIVE", ...resultReasons(result)],
  );
};
handlers["notion.pages.get"] = async (args, run) => {
  const page = await run.page(args.page_id),
    items: Data = Object.create(null),
    cursors: Data[] = [],
    reasons: string[] = [];
  let requests = 0;
  const budget = args.max_property_requests ?? 25;
  for (const value of Object.values(object(page.properties)) as Data[]) {
    if (!["title", "rich_text", "people", "relation", "rollup", "formula"].includes(value.type))
      continue;
    if (value.type === "relation") {
      try {
        const source = await run.sourceForPage(page);
        if (!source) incomplete("Relation page lacks its authoritative source.");
        const prop = property(source!, value.id);
        await relationTarget(run, prop.relation?.data_source_id);
      } catch (error) {
        reasons.push("RELATION_DEPENDENCY_INACCESSIBLE");
        items[value.id] = { error: error instanceof Error ? error.message : "Unavailable" };
        continue;
      }
    }
    let cursor: string | null = null;
    const all: Data[] = [],
      seen = new Set<string>();
    do {
      if (requests >= budget) {
        cursors.push({ property_id: value.id, next_cursor: cursor });
        reasons.push("PROPERTY_REQUEST_BUDGET");
        break;
      }
      requests++;
      const result = await run.call(
        "GET",
        `/v1/pages/${segment(args.page_id)}/properties/${segment(value.id)}`,
        undefined,
        { page_size: args.property_page_size ?? 50, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      if (result.object === "list") {
        cursor = nextPage(result);
        all.push(...result.results);
        if (result.property_item?.rollup) {
          items[`${value.id}:rollup`] = result.property_item.rollup;
          if (["incomplete", "unsupported"].includes(result.property_item.rollup.type))
            reasons.push("PROPERTY_CALCULATION_INCOMPLETE");
        }
      } else {
        all.push(result);
        cursor = null;
        if (result.formula?.type === "unsupported" || result.rollup?.type === "unsupported")
          reasons.push("PROPERTY_CALCULATION_INCOMPLETE");
      }
      if (cursor && seen.has(cursor)) return incomplete("A property cursor repeated.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    items[value.id] = all;
  }
  return complete(
    {
      page,
      property_items: items,
      property_cursors: cursors,
      properties_complete: reasons.length === 0,
    },
    reasons,
  );
};
handlers["notion.pages.read_content"] = async (args, run) => {
  const format = args.format ?? "markdown",
    budget = args.max_requests ?? 25,
    maxDepth = args.max_depth ?? 10;
  if (format === "markdown") {
    const result = await run.call("GET", `/v1/pages/${segment(args.page_id)}/markdown`, undefined, {
      markdown_version: "v1",
      include_transcript: args.include_transcript ?? false,
    });
    if (
      typeof result.markdown !== "string" ||
      typeof result.truncated !== "boolean" ||
      !Array.isArray(result.unknown_block_ids)
    )
      return incomplete("Markdown read omitted completeness fields.");
    const reasons: string[] = [],
      subtrees: Data[] = [],
      queue = [...result.unknown_block_ids],
      visited = new Set<string>();
    let requests = 1;
    if (result.truncated || queue.length || /<unknown\b/.test(result.markdown))
      reasons.push("TRUNCATED_OR_INACCESSIBLE");
    while (queue.length && requests < budget) {
      const blockId = id(queue.shift());
      if (visited.has(blockId)) continue;
      visited.add(blockId);
      requests++;
      try {
        const subtree = await run.call("GET", `/v1/pages/${segment(blockId)}/markdown`, undefined, {
          markdown_version: "v1",
          include_transcript: args.include_transcript ?? false,
        });
        subtrees.push({ block_id: blockId, ...subtree });
        for (const unknown of subtree.unknown_block_ids ?? [])
          if (!visited.has(unknown)) queue.push(unknown);
      } catch (error) {
        if (!(error instanceof NativeActionError) || error.kind !== "resource_unavailable")
          throw error;
        subtrees.push({ block_id: blockId, error: "RESOURCE_NOT_ACCESSIBLE" });
      }
    }
    if (queue.length) reasons.push("READ_REQUEST_BUDGET");
    return complete(
      {
        page_id: args.page_id,
        format,
        markdown: result.markdown,
        truncated: result.truncated,
        unknown_block_ids: result.unknown_block_ids,
        warnings: result.warnings ?? [],
        subtrees,
        continuation_block_ids: queue,
      },
      reasons,
    );
  }
  const blocks: Data[] = [],
    remaining: Data[] = [],
    reasons: string[] = [],
    queue: Data[] = [{ parent_id: args.page_id, depth: 0 }],
    seen = new Set<string>();
  let requests = 0;
  while (queue.length) {
    const current = queue.shift()!;
    if (requests >= budget || current.depth >= maxDepth) {
      remaining.push(current);
      reasons.push(requests >= budget ? "READ_REQUEST_BUDGET" : "READ_DEPTH_BUDGET");
      continue;
    }
    const key = `${current.parent_id}:${current.cursor ?? ""}`;
    if (seen.has(key)) return incomplete("A block child cursor or ancestor repeated.");
    seen.add(key);
    requests++;
    const page = await run.call(
      "GET",
      `/v1/blocks/${segment(current.parent_id)}/children`,
      undefined,
      { page_size: 100, ...(current.cursor ? { start_cursor: current.cursor } : {}) },
    );
    const cursor = nextPage(page);
    for (const block of page.results) {
      id(block.id);
      blocks.push({ parent_id: current.parent_id, depth: current.depth, block });
      if (block.type === "unsupported") reasons.push("UNSUPPORTED_BLOCK");
      if (block.has_children) queue.push({ parent_id: block.id, depth: current.depth + 1 });
    }
    if (cursor) queue.unshift({ ...current, cursor });
  }
  return complete(
    {
      page_id: args.page_id,
      format,
      blocks,
      unknown_block_ids: blocks
        .filter((item) => item.block.type === "unsupported")
        .map((item) => item.block.id),
      remaining_cursors: remaining,
    },
    reasons,
  );
};
async function blockParent(run: Run, resourceId: string) {
  try {
    return await run.page(resourceId);
  } catch (error) {
    if (
      !(error instanceof NativeActionError) ||
      !["resource_unavailable", "invalid_input"].includes(error.kind)
    )
      throw error;
  }
  const parent = await run.block(resourceId);
  if (
    [
      "unsupported",
      "child_database",
      "child_page",
      "divider",
      "image",
      "file",
      "pdf",
      "audio",
      "video",
      "bookmark",
      "embed",
      "link_preview",
      "equation",
    ].includes(parent.type)
  )
    return fail("This block type cannot be used as an append parent.");
  return parent;
}
async function appended(run: Run, parentId: string, body: Data) {
  let response: Data;
  try {
    response = await run.call(
      "PATCH",
      `/v1/blocks/${segment(parentId)}/children`,
      body,
      undefined,
      "append_children",
    );
  } catch (error) {
    if (!(error instanceof NativeActionError) || !error.options.uncertain) throw error;
    const saved = error.options.recovery as Data | undefined;
    const evidence = saved?.additional_data ?? saved;
    if (
      !sameId(evidence?.committed_resource_id, parentId) ||
      !Array.isArray(evidence?.committed_child_ids) ||
      evidence.committed_child_ids.length !== body.children.length
    )
      throw error;
    const results: Data[] = [];
    for (const childId of evidence.committed_child_ids) results.push(await run.block(id(childId)));
    response = {
      object: "list",
      results,
      has_more: false,
      next_cursor: null,
      recovered_after_503: true,
    };
  }
  const cursor = nextPage(response);
  run.receipt.parent_id = parentId;
  run.receipt.created_block_ids = response.results.map((item: Data) => id(item.id));
  return { response, ids: run.receipt.created_block_ids as string[], cursor };
}
handlers["notion.pages.create"] = async (args, run) => {
  const body: Data = {
    parent: args.parent,
    properties: Object.create(null),
    notifications: { mode: args.notification_mode ?? "silent" },
  };
  if (args.parent.type === "page_id") {
    await run.page(args.parent.page_id);
    if (args.properties?.length) return fail("Only title is writable on a page-parent page.");
    body.properties.title = { title: plainText(args.title) };
  } else {
    const source = await run.source(args.parent.data_source_id);
    const titles = Object.values(object(source.properties)).filter(
      (prop: any) => prop.type === "title",
    ) as Data[];
    const title = titles[0];
    if (titles.length !== 1 || !title)
      return incomplete("The parent data source has no unique title property.");
    body.properties = await mutations(run, source, args.properties ?? [], false);
    body.properties[title.id] = { title: plainText(args.title) };
  }
  if (args.content?.format === "blocks") body.children = args.content.blocks.map(blockInput);
  if (args.content?.format === "markdown") {
    await safeMarkdown(run, args.content.markdown);
    body.markdown = args.content.markdown;
    body.markdown_version = "v1";
    body.allow_async = false;
  }
  let page: Data;
  try {
    page = await run.call("POST", "/v1/pages", body, undefined, "create_page");
  } catch (error) {
    page = await run.recoverCreated(error, "page");
  }
  const pageId = id(page.id);
  run.receipt.resource_id = pageId;
  const read = await run.page(pageId);
  const parentMatches =
    args.parent.type === "page_id"
      ? sameId(read.parent?.page_id, args.parent.page_id)
      : sameId(read.parent?.data_source_id, args.parent.data_source_id);
  const propertiesMatch = Object.entries(body.properties).every(([propertyId, expected]) => {
    try {
      return equalProperty(currentPageProperty(read, propertyId), expected as Data);
    } catch {
      return false;
    }
  });
  return complete(
    {
      page_id: pageId,
      parent: read.parent,
      url: read.url,
      write_outcome: "confirmed",
      readback_verified: parentMatches && propertiesMatch,
    },
    [
      ...(!parentMatches ? ["PARENT_READBACK_MISMATCH"] : []),
      ...(!propertiesMatch ? ["PROPERTY_READBACK_INCOMPLETE_OR_CHANGED"] : []),
    ],
  );
};
function equalProperty(actual: Data, expected: Data) {
  const kind = Object.keys(expected)[0];
  if (kind === undefined) return false;
  const value = expected[kind],
    actualValue = actual[kind];
  if (kind === "title" || kind === "rich_text")
    return (
      (actualValue ?? [])
        .map((part: Data) => part.plain_text ?? part.text?.content ?? "")
        .join("") === value.map((part: Data) => part.text.content).join("")
    );
  if (["people", "relation", "multi_select"].includes(kind))
    return (
      !actual.has_more &&
      Array.isArray(actualValue) &&
      canonical(actualValue.map((item: Data) => item.id).sort()) ===
        canonical(value.map((item: Data) => item.id).sort())
    );
  if (kind === "select" || kind === "status")
    return (actualValue?.id ?? null) === (value?.id ?? null);
  if (kind === "date")
    return value === null
      ? actualValue === null
      : actualValue?.start === value.start && (actualValue.end ?? null) === (value.end ?? null);
  return canonical(actualValue) === canonical(value);
}
handlers["notion.pages.update_properties"] = async (args, run) => {
  const before = await run.page(args.page_id);
  run.precheck(before.last_edited_time, args.expected_last_edited_time);
  const source = (await run.sourceForPage(before)) ?? { properties: before.properties };
  const properties = await mutations(run, source, args.mutations);
  await run.call(
    "PATCH",
    `/v1/pages/${segment(args.page_id)}`,
    { properties },
    undefined,
    "update_properties",
  );
  run.receipt.resource_id = args.page_id;
  const after = await run.page(args.page_id);
  let verified = true;
  for (const [propertyId, wanted] of Object.entries(properties)) {
    try {
      verified &&= equalProperty(currentPageProperty(after, propertyId), wanted as Data);
    } catch {
      verified = false;
    }
  }
  return complete(
    {
      page_id: args.page_id,
      updated_property_ids: Object.keys(properties),
      write_outcome: "confirmed",
      readback_verified: verified,
      last_edited_time: after.last_edited_time,
      concurrency_guarantee: "best_effort_precheck",
    },
    verified ? [] : ["PROPERTY_READBACK_INCOMPLETE_OR_CHANGED"],
  );
};
handlers["notion.pages.update_content"] = async (args, run) => {
  const before = await run.call("GET", `/v1/pages/${segment(args.page_id)}/markdown`, undefined, {
    markdown_version: "v1",
  });
  if (typeof before.markdown !== "string" || before.truncated || before.unknown_block_ids?.length)
    return incomplete("A complete Markdown read is required before content edits.");
  run.precheck(sha256(before.markdown), args.expected_markdown_sha256);
  let body: Data;
  if (args.edits) {
    for (const edit of args.edits) {
      await safeMarkdown(run, edit.old_str, true);
      await safeMarkdown(run, edit.new_str, true);
    }
    body = {
      type: "update_content",
      update_content: {
        content_updates: args.edits.map((edit: Data) => ({
          old_str: edit.old_str,
          new_str: edit.new_str,
          replace_all_matches: edit.replace_all_matches ?? false,
        })),
        allow_deleting_content: false,
      },
      markdown_version: "v1",
      allow_async: false,
    };
  } else {
    await safeMarkdown(run, args.insert_content.content);
    if (args.insert_content.after) {
      const parts = args.insert_content.after.split("...");
      const first = parts[0],
        last = parts.at(-1)!;
      if (
        !first ||
        !last ||
        before.markdown.indexOf(first) < 0 ||
        before.markdown.indexOf(last, before.markdown.indexOf(first)) < 0 ||
        before.markdown.indexOf(first) !== before.markdown.lastIndexOf(first) ||
        before.markdown.indexOf(last) !== before.markdown.lastIndexOf(last)
      )
        return fail("The insertion selector is absent or ambiguous; read and select it again.");
      await safeMarkdown(run, args.insert_content.after, true);
    }
    body = {
      type: "insert_content",
      insert_content: args.insert_content,
      markdown_version: "v1",
      allow_async: false,
    };
  }
  const result = await run.call(
    "PATCH",
    `/v1/pages/${segment(args.page_id)}/markdown`,
    body,
    undefined,
    "update_markdown",
  );
  run.receipt.resource_id = args.page_id;
  if (
    typeof result.markdown !== "string" ||
    typeof result.truncated !== "boolean" ||
    !Array.isArray(result.unknown_block_ids)
  )
    return run.unknown("Markdown write response omitted completeness fields.");
  const warnings = result.warnings ?? [];
  const reasons = [
    ...(warnings.length ? ["UNMATCHED_OR_CHANGED_CONTENT_EDIT"] : []),
    ...(result.truncated || result.unknown_block_ids.length ? ["TRUNCATED_OR_INACCESSIBLE"] : []),
  ];
  return complete(
    {
      page_id: args.page_id,
      markdown: result.markdown,
      write_outcome: warnings.length ? "partial" : "confirmed",
      operation: body.type,
      ...(args.edits
        ? { all_edits_applied: warnings.length === 0 }
        : { insertion_applied: warnings.length === 0 }),
      warnings,
      truncated: result.truncated,
      unknown_block_ids: result.unknown_block_ids,
      concurrency_guarantee: "best_effort_precheck",
    },
    reasons,
  );
};
handlers["notion.blocks.append"] = async (args, run) => {
  await blockParent(run, args.block_id);
  const position =
    args.position?.type === "after_block"
      ? { type: "after_block", after_block: { id: args.position.after_block_id } }
      : (args.position ?? { type: "end" });
  if (position.type === "after_block") {
    const siblings = await listed(run, `/v1/blocks/${segment(args.block_id)}/children`, {
      page_size: 100,
    });
    if (!siblings.some((sibling) => sameId(sibling.id, position.after_block.id)))
      return fail("Insertion sibling does not belong to this parent.");
  }
  const result = await appended(run, args.block_id, {
    children: args.blocks.map(blockInput),
    position,
    notifications: { mode: "silent" },
  });
  return complete(
    {
      parent_id: args.block_id,
      created_block_ids: result.ids,
      write_outcome: "confirmed",
      response_has_more: !!result.cursor,
      response_next_cursor: result.cursor,
      ...(result.response.recovered_after_503
        ? { recovered_after_503: true, automatic_reappend: false }
        : {}),
    },
    result.ids.length !== args.blocks.length || result.cursor ? ["CREATED_IDS_INCOMPLETE"] : [],
  );
};
handlers["notion.blocks.update"] = async (args, run) => {
  const before = await run.block(args.block_id);
  run.precheck(before.last_edited_time, args.expected_last_edited_time);
  if (before.type !== args.change.type)
    return fail("The block type changed; do not coerce it to another type.");
  const fields: Data = {
    ...(args.change.text !== undefined ? { rich_text: plainText(args.change.text) } : {}),
    ...(args.change.checked !== undefined ? { checked: args.change.checked } : {}),
    ...(args.change.language !== undefined ? { language: args.change.language } : {}),
  };
  const body = { [args.change.type]: fields };
  await run.call("PATCH", `/v1/blocks/${segment(args.block_id)}`, body, undefined, "update_block");
  run.receipt.resource_id = args.block_id;
  const after = await run.block(args.block_id);
  const actual = after[args.change.type];
  const verified =
    after.type === args.change.type &&
    Object.keys(fields).every((key) =>
      key === "rich_text"
        ? (actual?.rich_text ?? [])
            .map((part: Data) => part.plain_text ?? part.text?.content ?? "")
            .join("") === args.change.text
        : actual?.[key] === fields[key],
    );
  return complete(
    {
      block_id: args.block_id,
      type: after.type,
      write_outcome: "confirmed",
      readback_verified: verified,
      last_edited_time: after.last_edited_time,
      concurrency_guarantee: "best_effort_precheck",
    },
    verified ? [] : ["BLOCK_READBACK_MISMATCH"],
  );
};
handlers["notion.blocks.set_trash"] = async (args, run) => {
  const before = await run.block(args.block_id);
  if (before.type === "child_page" || before.type === "child_database")
    return fail(
      "Use the page trash action for a page; databases are not a regular block trash target here.",
    );
  let result: Data;
  try {
    result = args.in_trash
      ? await run.call(
          "DELETE",
          `/v1/blocks/${segment(args.block_id)}`,
          undefined,
          undefined,
          "trash_block",
        )
      : await run.call(
          "PATCH",
          `/v1/blocks/${segment(args.block_id)}`,
          { in_trash: false },
          undefined,
          "restore_block",
        );
  } catch (error) {
    if (!(error instanceof NativeActionError) || !error.options.uncertain) throw error;
    try {
      result = await run.block(args.block_id);
    } catch {
      throw error;
    }
    if (result.in_trash !== args.in_trash) throw error;
  }
  if (!sameId(result.id, args.block_id) || result.in_trash !== args.in_trash)
    return run.unknown("Notion did not confirm the exact requested block trash state.");
  return complete({
    block_id: args.block_id,
    in_trash: result.in_trash,
    permanently_deleted: false,
    write_outcome: "confirmed",
  });
};
handlers["notion.pages.set_trash"] = async (args, run) => {
  const before = await run.page(args.page_id);
  run.precheck(before.last_edited_time, args.expected_last_edited_time);
  const result = await run.call(
    "PATCH",
    `/v1/pages/${segment(args.page_id)}`,
    { in_trash: args.in_trash },
    undefined,
    "page_trash_state",
  );
  run.receipt.resource_id = args.page_id;
  if (!sameId(result.id, args.page_id) || result.in_trash !== args.in_trash)
    return run.unknown("The page trash state was not confirmed.");
  return complete({
    page_id: args.page_id,
    in_trash: result.in_trash,
    permanently_deleted: false,
    write_outcome: "confirmed",
    concurrency_guarantee: "best_effort_precheck",
  });
};
handlers["notion.pages.move"] = async (args, run) => {
  const before = await run.page(args.page_id);
  run.precheck(before.last_edited_time, args.expected_last_edited_time);
  if (args.parent.type === "page_id") {
    let targetId = args.parent.page_id;
    const seen = new Set<string>();
    for (let depth = 0; depth < 100; depth++) {
      if (sameId(targetId, args.page_id))
        return fail("A page cannot move beneath itself or a descendant.");
      if (seen.has(targetId)) return incomplete("Destination ancestry contains a cycle.");
      seen.add(targetId);
      const target = await run.page(targetId);
      if (target.parent?.type !== "page_id") break;
      targetId = id(target.parent.page_id);
      if (depth === 99) return incomplete("Destination ancestry verification exceeded its budget.");
    }
  } else {
    const destination = await run.source(args.parent.data_source_id);
    for (const value of Object.values(before.properties ?? {}) as Data[])
      if (value.type !== "title") {
        const match = Object.values(destination.properties ?? {}).find(
          (candidate: any) => candidate.id === value.id && candidate.type === value.type,
        );
        if (!match)
          return fail(
            "Moving would lose an unmapped property; reconcile the destination schema first.",
          );
      }
  }
  await run.call(
    "POST",
    `/v1/pages/${segment(args.page_id)}/move`,
    { parent: args.parent },
    undefined,
    "move_page",
  );
  run.receipt.resource_id = args.page_id;
  const after = await run.page(args.page_id);
  const key = args.parent.type === "page_id" ? "page_id" : "data_source_id";
  const verified = sameId(after.parent?.[key], args.parent[key]);
  return complete(
    {
      page_id: args.page_id,
      parent: after.parent,
      write_outcome: "confirmed",
      readback_verified: verified,
      concurrency_guarantee: "best_effort_precheck",
    },
    verified ? [] : ["PARENT_READBACK_MISMATCH"],
  );
};
handlers["notion.databases.get"] = async (args, run) => {
  const database = await run.database(args.database_id),
    schemas: Data[] = [],
    errors: Data[] = [];
  if (args.include_schemas !== false)
    for (const source of database.data_sources) {
      try {
        schemas.push(await run.source(id(source.id)));
      } catch (error) {
        if (
          !(error instanceof NativeActionError) ||
          !["resource_unavailable", "insufficient_scope"].includes(error.kind)
        )
          throw error;
        errors.push({ data_source_id: source.id, code: "RESOURCE_NOT_ACCESSIBLE" });
      }
    }
  return complete(
    { database, datasource_schemas: schemas, schema_errors: errors },
    errors.length ? ["SOURCE_SCHEMA_INACCESSIBLE"] : [],
  );
};
function compileFilter(source: Data, filter: Data, counter: { leaves: number }, depth = 0): Data {
  if (filter.and || filter.or) {
    if (depth >= 2) return fail("Compound filter nesting exceeds two levels.");
    const key = filter.and ? "and" : "or";
    return {
      [key]: filter[key].map((child: Data) => compileFilter(source, child, counter, depth + 1)),
    };
  }
  if (++counter.leaves > 100) return fail("The filter exceeds 100 leaf conditions.");
  const prop = property(source, filter.property_id);
  if (prop.type !== filter.kind) return fail("A filter does not match the current property type.");
  return { property: prop.id, [filter.kind]: { [filter.operator]: filter.value } };
}
handlers["notion.data_sources.query"] = async (args, run) => {
  const source = await run.source(args.data_source_id),
    body: Data = {
      page_size: args.page_size ?? 50,
      ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
      ...(args.is_archived !== undefined ? { is_archived: args.is_archived } : {}),
    };
  if (args.filter) body.filter = compileFilter(source, args.filter, { leaves: 0 });
  if (args.filters) {
    const key = args.filter_mode === "any" ? "or" : "and";
    body.filter = {
      [key]: args.filters.map((entry: Data) => compileFilter(source, entry, { leaves: 0 })),
    };
  }
  if (args.sorts)
    body.sorts = args.sorts.map((sort: Data) =>
      sort.property_id
        ? { property: property(source, sort.property_id).name, direction: sort.direction }
        : { timestamp: sort.timestamp, direction: sort.direction },
    );
  const result = await run.call(
    "POST",
    `/v1/data_sources/${segment(args.data_source_id)}/query`,
    body,
  );
  const cursor = nextPage(result);
  return complete(
    {
      items: result.results,
      has_more: result.has_more,
      next_cursor: cursor,
      ...(result.request_status ? { request_status: result.request_status } : {}),
      property_values_may_need_item_pagination: true,
    },
    resultReasons(result),
  );
};
async function schemaSettings(run: Run, definition: Data) {
  const kind = definition.kind;
  if (
    [
      "title",
      "rich_text",
      "checkbox",
      "date",
      "url",
      "email",
      "phone_number",
      "people",
      "files",
    ].includes(kind)
  )
    return { [kind]: {} };
  if (kind === "number") return { number: { format: definition.number_format } };
  if (kind === "select" || kind === "multi_select") {
    unique(
      definition.options.map((option: Data) => option.name.trim().toLowerCase()),
      "option names",
    );
    return { [kind]: { options: definition.options } };
  }
  if (kind === "relation") {
    await relationTarget(run, definition.data_source_id);
    return {
      relation: {
        data_source_id: definition.data_source_id,
        type: "single_property",
        single_property: {},
      },
    };
  }
  return fail("Unsupported data source schema type.");
}
function schemaMatches(actual: Data | undefined, wanted: Data): boolean {
  if (!actual) return false;
  return (
    actual.type === wanted.kind &&
    (wanted.kind !== "number" || actual.number?.format === wanted.number_format) &&
    (!["select", "multi_select"].includes(wanted.kind) ||
      canonical(actual[wanted.kind]?.options?.map((option: Data) => option.name).sort()) ===
        canonical(wanted.options.map((option: Data) => option.name).sort())) &&
    (wanted.kind !== "relation" ||
      (sameId(actual.relation?.data_source_id, wanted.data_source_id) &&
        actual.relation?.type === wanted.relation_type &&
        actual.relation.single_property !== null &&
        typeof actual.relation.single_property === "object" &&
        !Array.isArray(actual.relation.single_property)))
  );
}
handlers["notion.databases.create"] = async (args, run) => {
  await run.page(args.parent_page_id);
  unique(
    args.columns.map((column: Data) => column.name),
    "column names",
  );
  if (args.columns.filter((column: Data) => column.schema.kind === "title").length !== 1)
    return fail("Exactly one title column is required.");
  const properties = Object.create(null);
  for (const column of args.columns)
    properties[column.name] = await schemaSettings(run, column.schema);
  const body = {
    parent: { type: "page_id", page_id: args.parent_page_id },
    title: plainText(args.title),
    initial_data_source: { properties },
    is_inline: args.is_inline ?? false,
  };
  let database: Data;
  try {
    database = await run.call("POST", "/v1/databases", body, undefined, "create_database");
  } catch (error) {
    database = await run.recoverCreated(error, "database");
  }
  const databaseId = id(database.id);
  run.receipt.resource_id = databaseId;
  if (!Array.isArray(database.data_sources)) database = await run.database(databaseId);
  const sources: Data[] = [];
  for (const entry of database.data_sources) sources.push(await run.source(id(entry.id)));
  const source = sources.length === 1 ? sources[0] : undefined;
  const verified =
    sameId(database.parent?.page_id, args.parent_page_id) &&
    source !== undefined &&
    sameId(source.parent?.database_id, databaseId) &&
    args.columns.every((column: Data) =>
      schemaMatches(source.properties[column.name], column.schema),
    );
  return complete(
    {
      database_id: databaseId,
      data_source_ids: sources.map((source) => source.id),
      initial_data_source: sources.length === 1 ? sources[0] : null,
      datasource_schemas: sources,
      write_outcome: "confirmed",
      readback_verified: verified,
    },
    verified
      ? []
      : [
          sources.length === 1
            ? "SCHEMA_READBACK_INCOMPLETE_OR_CHANGED"
            : "INITIAL_SOURCE_AMBIGUOUS",
        ],
  );
};
handlers["notion.data_sources.update_schema"] = async (args, run) => {
  const before = await run.source(args.data_source_id, true);
  run.precheck(sha256(canonical(before.properties)), args.expected_schema_sha256);
  unique(
    args.mutations.map((entry: Data) => entry.property_id ?? `new:${entry.definition.name}`),
    "schema mutation targets",
  );
  const properties = Object.create(null),
    existingNames = new Set(Object.keys(before.properties));
  for (const entry of args.mutations) {
    if (entry.op === "add") {
      if (existingNames.has(entry.definition.name))
        return fail("A column with this name already exists.");
      existingNames.add(entry.definition.name);
      properties[entry.definition.name] = await schemaSettings(run, entry.definition.schema);
      continue;
    }
    const prop = property(before, entry.property_id);
    if (entry.op === "rename") {
      if (existingNames.has(entry.name) && entry.name !== prop.name)
        return fail("The new property name collides with another column.");
      properties[prop.id] = { name: entry.name };
    } else if (entry.op === "remove") {
      if (prop.type === "title") return fail("The title property cannot be removed.");
      properties[prop.id] = null;
    } else if (entry.op === "change_type") {
      if (
        prop.type === "title" ||
        prop.type === "place" ||
        entry.target_schema.kind === "title" ||
        entry.target_schema.kind === "place"
      )
        return fail("This property type conversion is protected.");
      properties[prop.id] = await schemaSettings(run, entry.target_schema);
    } else if (entry.op === "set_select_options") {
      if (prop.type !== entry.kind) return fail("Option changes do not match the property type.");
      const options = prop[entry.kind]?.options;
      if (!Array.isArray(options)) return incomplete("Current select options are not visible.");
      unique(
        entry.options.map((option: Data) => option.id ?? `new:${option.name.toLowerCase().trim()}`),
        "option retain entries",
      );
      for (const option of entry.options)
        if (option.id && !options.some((current: Data) => current.id === option.id))
          return fail("An option retain ID is not in this property.");
      properties[prop.id] = { [entry.kind]: { options: entry.options } };
    } else return fail("Unknown schema operation.");
  }
  const predicted = clone(before.properties);
  for (const entry of args.mutations) {
    if (entry.op === "add") {
      predicted[entry.definition.name] = properties[entry.definition.name];
      continue;
    }
    const prop = property(before, entry.property_id);
    if (entry.op === "remove") delete predicted[prop.name];
    else if (entry.op === "rename") {
      const old = predicted[prop.name];
      delete predicted[prop.name];
      predicted[entry.name] = { ...old, name: entry.name };
    } else predicted[prop.name] = { id: prop.id, name: prop.name, ...properties[prop.id] };
  }
  if (Buffer.byteLength(JSON.stringify(predicted)) > 50000)
    return fail("The proposed schema exceeds 50 KB.");
  await run.call(
    "PATCH",
    `/v1/data_sources/${segment(args.data_source_id)}`,
    { properties },
    undefined,
    "update_source_schema",
  );
  run.receipt.resource_id = args.data_source_id;
  const after = await run.source(args.data_source_id, true);
  let verified = true;
  for (const entry of args.mutations) {
    const actual =
      entry.op === "add"
        ? after.properties[entry.definition.name]
        : (Object.values(after.properties).find((prop: any) => prop.id === entry.property_id) as
            | Data
            | undefined);
    if (entry.op === "remove") verified &&= actual === undefined;
    else if (entry.op === "rename") verified &&= actual?.name === entry.name;
    else if (entry.op === "add" || entry.op === "change_type")
      verified &&= schemaMatches(actual, entry.definition?.schema ?? entry.target_schema);
    else {
      const actualOptions = actual?.[entry.kind]?.options;
      verified &&=
        Array.isArray(actualOptions) &&
        actualOptions.length === entry.options.length &&
        entry.options.every((option: Data) =>
          actualOptions.some((item: Data) =>
            option.id
              ? item.id === option.id && (!option.name || item.name === option.name)
              : item.name === option.name,
          ),
        );
    }
  }
  return complete(
    {
      data_source_id: args.data_source_id,
      properties: after.properties,
      write_outcome: "confirmed",
      readback_verified: verified,
      concurrency_guarantee: "best_effort_precheck",
    },
    verified ? [] : ["SCHEMA_READBACK_INCOMPLETE_OR_CHANGED"],
  );
};
handlers["notion.comments.list"] = async (args, run) => {
  const result = await run.call("GET", "/v1/comments", undefined, {
    block_id: args.block_id,
    page_size: args.page_size ?? 50,
    ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
  });
  const cursor = nextPage(result);
  return complete(
    {
      items: result.results,
      has_more: result.has_more,
      next_cursor: cursor,
      scope: "unresolved_comments",
    },
    resultReasons(result),
  );
};
handlers["notion.comments.create"] = async (args, run) => {
  const target = args.target;
  const body: Data = { rich_text: plainText(args.text) };
  if (target.type === "discussion") {
    const comments = await listed(run, "/v1/comments", {
      block_id: target.anchor_block_id,
      page_size: 100,
    });
    if (!comments.some((comment) => sameId(comment.discussion_id, target.discussion_id)))
      return fail("The discussion is not verified under the selected page or block.");
    body.discussion_id = target.discussion_id;
  } else
    body.parent =
      target.type === "page" ? { page_id: target.page_id } : { block_id: target.block_id };
  const comment = await run.call("POST", "/v1/comments", body, undefined, "create_comment");
  run.receipt.comment_id = id(comment.id);
  run.receipt.discussion_id = id(comment.discussion_id);
  return complete({
    comment_id: comment.id,
    discussion_id: comment.discussion_id,
    parent: comment.parent,
    write_outcome: "confirmed",
  });
};

function uploadObject(value: Data, uploadId: string) {
  if (
    value.object !== "file_upload" ||
    !sameId(value.id, uploadId) ||
    !["pending", "uploaded", "expired", "failed"].includes(value.status)
  )
    return incomplete("The file-upload lifecycle response is inconsistent.");
  return value;
}
function preservedFiles(page: Data, source: Data, propertyId: string): Data[] {
  if (property(source, propertyId).type !== "files")
    return fail("The selected stable property is not a files property.");
  const actual = currentPageProperty(page, propertyId);
  if (actual.type !== "files" || !Array.isArray(actual.files) || actual.has_more)
    return incomplete("The complete existing files list is not visible.");
  return actual.files.map((entry: Data) => {
    if (typeof entry.name !== "string") return incomplete("An existing file omitted its name.");
    if (entry.type === "external" && typeof entry.external?.url === "string")
      return { name: entry.name, type: "external", external: { url: entry.external.url } };
    if (entry.type === "file" && typeof entry.file?.url === "string")
      return {
        name: entry.name,
        type: "file",
        file: {
          url: entry.file.url,
          ...(entry.file.expiry_time ? { expiry_time: entry.file.expiry_time } : {}),
        },
      };
    return incomplete("An existing file cannot be preserved using documented fields.");
  });
}
handlers["notion.files.upload"] = async (args, run) => {
  const propertyTarget = args.target.type === "page_files_property";
  run.require(propertyTarget ? "update_content" : "insert_content");
  const artifact = await run.context.readArtifact(args.artifact_ref);
  const bytes = Uint8Array.from(artifact.bytes);
  if (
    !bytes.length ||
    Buffer.byteLength(args.filename, "utf8") > 900 ||
    [...String(args.filename)].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    /[/\\]/.test(args.filename)
  )
    return fail(
      "The artifact must be nonempty and its filename must fit the provider filename rules.",
    );
  const [artifactMime = ""] = String(artifact.mimeType).toLowerCase().split(";");
  if (artifactMime.trim() !== args.content_type.toLowerCase())
    return fail("The requested content type does not match the resolved artifact.");
  const mode =
    args.transfer_mode === "single_part"
      ? "single_part"
      : args.transfer_mode === "multi_part"
        ? "multi_part"
        : bytes.length <= 20 * MiB
          ? "single_part"
          : "multi_part";
  if (mode === "single_part" && bytes.length > 20 * MiB)
    return fail("This artifact requires multipart upload.");
  const plan: Data = {
    upload_id: null,
    artifact_ref: args.artifact_ref,
    artifact_sha256: sha256(bytes),
    byte_length: bytes.length,
    mode,
    number_of_parts: mode === "multi_part" ? Math.ceil(bytes.length / (10 * MiB)) : 1,
    parts: [],
  };
  if (plan.number_of_parts > 1000)
    return fail("The multipart plan exceeds the common documented part-number range.");
  for (let number = 1, offset = 0; number <= plan.number_of_parts; number++) {
    const length =
      mode === "single_part" ? bytes.length : Math.min(10 * MiB, bytes.length - offset);
    plan.parts.push({
      part_number: number,
      byte_offset: offset,
      byte_length: length,
      sha256: sha256(bytes.subarray(offset, offset + length)),
      dispatch_state: "never_dispatched",
    });
    offset += length;
  }
  const saved = run.receipt.upload;
  if (saved) {
    if (!Array.isArray(saved.parts) || saved.upload_id !== (run.receipt.upload_id ?? null))
      return fail("The saved upload identity or parts are inconsistent.");
    const immutable = (value: Data) => ({
      ...value,
      upload_id: null,
      parts: value.parts.map((part: Data) => ({ ...part, dispatch_state: "never_dispatched" })),
    });
    if (
      canonical(immutable(saved)) !== canonical(plan) ||
      saved.parts.some(
        (part: Data) =>
          !["never_dispatched", "in_flight", "acknowledged", "outcome_unknown"].includes(
            part.dispatch_state,
          ),
      )
    )
      return fail("The immutable artifact or multipart segment plan changed since dispatch.");
  } else run.receipt.upload = plan;
  run.receipt.attachment_target = propertyTarget
    ? {
        type: "page_files_property",
        page_id: args.target.page_id,
        property_id: args.target.property_id,
      }
    : { type: "block", parent_id: args.target.block_id };
  const self = await run.call("GET", "/v1/users/me");
  const maximum = self.bot?.workspace_limits?.max_file_upload_size_in_bytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    return incomplete("The actual workspace file-upload limit is unavailable.");
  if (bytes.length > maximum)
    return fail("The artifact exceeds the actual workspace file-upload limit.");
  let originalFiles: Data[] = [];
  if (propertyTarget) {
    const page = await run.page(args.target.page_id);
    if (
      run.receipt.attachment_state === "in_flight" ||
      run.receipt.attachment_state === "outcome_unknown"
    )
      return run.unknown(
        "The files-property attachment response was lost. A filename match cannot prove this exact attachment.",
        { reason: "ATTACHMENT_OUTCOME_UNKNOWN", filename_match_is_proof: false },
      );
    const source = await run.sourceForPage(page);
    if (!source) return fail("A files property needs a visible data-source schema.");
    originalFiles = preservedFiles(page, source, args.target.property_id);
    if (!run.receipt.attachment_state)
      run.precheck(page.last_edited_time, args.target.expected_last_edited_time);
    if (
      run.receipt.attachment_state === "acknowledged" ||
      run.receipt.attachment_state === "confirmed"
    )
      return complete(
        {
          file_upload_id: run.receipt.upload_id,
          upload_mode: mode,
          upload_status: "uploaded",
          attachment: {
            type: "page_files_property",
            page_id: args.target.page_id,
            property_id: args.target.property_id,
          },
          attached: true,
          write_outcome: "confirmed",
          readback_verified: false,
          recovered_from_exact_ack: true,
          resource_snapshot_current: false,
        },
        ["EXACT_ATTACHMENT_HAS_DURABLE_ACK_CURRENT_ASSOCIATION_NOT_PROVEN"],
      );
  } else {
    await blockParent(run, args.target.block_id);
    if (run.receipt.attachment_state && run.receipt.attachment_state !== "not_dispatched") {
      const childIds = run.receipt.created_block_ids;
      if (!Array.isArray(childIds) || childIds.length !== 1)
        return run.unknown(
          "The file-block attachment has no exact committed child ID; do not append it again.",
          { reason: "ATTACHMENT_OUTCOME_UNKNOWN" },
        );
      const block = await run.block(id(childIds[0]));
      if (
        block.type !== "file" ||
        !sameId(block.parent?.page_id ?? block.parent?.block_id, args.target.block_id)
      )
        return run.unknown("The exact committed block does not confirm the attachment target.");
      return complete({
        file_upload_id: run.receipt.upload_id,
        upload_mode: mode,
        upload_status: "uploaded",
        block_id: block.id,
        attached: true,
        write_outcome: "confirmed",
        file: block.file,
        recovered_from_exact_ack: true,
      });
    }
  }
  let upload: Data;
  if (run.receipt.upload_id) {
    upload = uploadObject(
      await run.call("GET", `/v1/file_uploads/${segment(id(run.receipt.upload_id))}`),
      run.receipt.upload_id,
    );
    const uncertainParts = run.receipt.upload.parts.filter((part: Data) =>
      ["in_flight", "outcome_unknown"].includes(part.dispatch_state),
    );
    if (mode === "multi_part" && uncertainParts.length)
      return run.unknown(
        "An individual multipart send lacks an exact acknowledgement; aggregate sent counts cannot identify it.",
        {
          reason: "UPLOAD_PART_OUTCOME_UNKNOWN",
          unknown_part_numbers: uncertainParts.map((part: Data) => part.part_number),
        },
      );
    if (
      mode === "single_part" &&
      run.receipt.send_state === "in_flight" &&
      upload.status !== "uploaded"
    )
      return run.unknown("The single-part send result is not proven; do not repeat it.", {
        reason: "UPLOAD_PART_OUTCOME_UNKNOWN",
      });
    if (run.receipt.complete_state && upload.status !== "uploaded")
      return run.unknown("The completion result is not proven by lifecycle readback.", {
        reason: "UPLOAD_COMPLETION_OUTCOME_UNKNOWN",
      });
  } else {
    if (run.receipt.stage === "create_upload" && run.receipt.write_state)
      return run.unknown(
        "The upload creation response was lost and no stable upload ID is available. Do not create a replacement.",
      );
    upload = await run.call(
      "POST",
      "/v1/file_uploads",
      {
        mode,
        filename: args.filename,
        content_type: args.content_type,
        ...(mode === "multi_part" ? { number_of_parts: plan.number_of_parts } : {}),
      },
      undefined,
      "create_upload",
    );
    run.receipt.upload_id = id(upload.id);
    run.receipt.upload.upload_id = run.receipt.upload_id;
    uploadObject(upload, run.receipt.upload_id);
    await run.save();
  }
  const uploadId = id(run.receipt.upload_id),
    uploadPath = `/v1/file_uploads/${segment(uploadId)}`;
  const lifecycle = async () => uploadObject(await run.call("GET", uploadPath), uploadId);
  if (["expired", "failed"].includes(upload.status))
    throw new NativeActionError(
      "resource_unavailable",
      "This upload is expired or failed; it cannot be attached.",
      { recovery: run.recovery({ reason: "UPLOAD_NOT_ATTACHABLE" }) },
    );
  if (upload.status !== "uploaded") {
    for (const part of run.receipt.upload.parts) {
      if (part.dispatch_state === "acknowledged") continue;
      if (part.dispatch_state !== "never_dispatched")
        return run.unknown("A send has no exact acknowledgement; it cannot be replayed.");
      const slice = bytes.subarray(part.byte_offset, part.byte_offset + part.byte_length);
      if (sha256(slice) !== part.sha256) return fail("The frozen artifact segment digest changed.");
      const form = new FormData();
      form.append("file", new Blob([slice], { type: args.content_type }), args.filename);
      if (mode === "multi_part") form.append("part_number", String(part.part_number));
      try {
        upload = uploadObject(
          await run.call(
            "POST",
            `${uploadPath}/send`,
            form,
            undefined,
            mode === "multi_part" ? `send_part_${part.part_number}` : "send_single",
          ),
          uploadId,
        );
        part.dispatch_state = "acknowledged";
        await run.save();
      } catch (error) {
        if (!(error instanceof NativeActionError) || !error.options.uncertain) throw error;
        part.dispatch_state = "outcome_unknown";
        try {
          await run.save();
        } catch {
          /* The persisted in-flight receipt already prevents replay. */
        }
        upload = await lifecycle();
        if (
          mode === "single_part" &&
          upload.status === "uploaded" &&
          upload.content_length === bytes.length
        ) {
          part.dispatch_state = "acknowledged";
          run.receipt.send_state = "acknowledged";
          await run.save();
          break;
        }
        return run.unknown(
          "The send response was lost. No per-part proof is available, so the part will not be resent or completed.",
          { reason: "UPLOAD_PART_OUTCOME_UNKNOWN", unknown_part_numbers: [part.part_number] },
        );
      }
    }
    if (mode === "multi_part") {
      if (!run.receipt.upload.parts.every((part: Data) => part.dispatch_state === "acknowledged"))
        return run.unknown(
          "Multipart completion requires exact acknowledgements for every segment.",
        );
      try {
        upload = uploadObject(
          await run.call("POST", `${uploadPath}/complete`, undefined, undefined, "complete_upload"),
          uploadId,
        );
      } catch (error) {
        if (!(error instanceof NativeActionError) || !error.options.uncertain) throw error;
        upload = await lifecycle();
        if (upload.status !== "uploaded")
          return run.unknown("Multipart completion remains unknown; do not repeat it.", {
            reason: "UPLOAD_COMPLETION_OUTCOME_UNKNOWN",
          });
        run.receipt.complete_state = "acknowledged";
        await run.save();
      }
    }
  }
  if (upload.status !== "uploaded" || upload.content_length !== bytes.length)
    return run.unknown("The provider did not confirm all frozen bytes as an uploaded file.", {
      reason: "UPLOAD_NOT_ATTACHABLE",
    });
  await run.save({ upload_status: "uploaded" });
  const attachment: Data = propertyTarget
    ? {
        type: "page_files_property",
        page_id: args.target.page_id,
        property_id: args.target.property_id,
      }
    : { type: "block", parent_id: args.target.block_id };
  let file: any,
    blockId: string | undefined,
    readbackVerified = false;
  if (propertyTarget) {
    // Refetch immediately before replacing the whole files value; this remains a best-effort precheck, not CAS.
    const page = await run.page(args.target.page_id),
      source = await run.sourceForPage(page);
    if (!source) return fail("The files-property schema became inaccessible.");
    run.precheck(page.last_edited_time, args.target.expected_last_edited_time);
    originalFiles = preservedFiles(page, source, args.target.property_id);
    for (const entry of originalFiles) await run.context.validateResourceUrl(entry[entry.type].url);
    const files = [
      ...originalFiles,
      { name: args.filename, type: "file_upload", file_upload: { id: uploadId } },
    ];
    try {
      await run.call(
        "PATCH",
        `/v1/pages/${segment(args.target.page_id)}`,
        { properties: { [args.target.property_id]: { files } } },
        undefined,
        "attach_files",
      );
    } catch (error) {
      if (!(error instanceof NativeActionError) || !error.options.uncertain) throw error;
      await run.page(args.target.page_id);
      return run.unknown(
        "The files-property write may have committed. Its same-name readback cannot prove this exact association.",
        { reason: "ATTACHMENT_OUTCOME_UNKNOWN", filename_match_is_proof: false },
      );
    }
    const after = await run.page(args.target.page_id),
      actual = currentPageProperty(after, args.target.property_id);
    file = actual.files;
    readbackVerified =
      actual.type === "files" &&
      Array.isArray(file) &&
      file.length === originalFiles.length + 1 &&
      file.at(-1)?.name === args.filename;
  } else {
    const result = await appended(run, args.target.block_id, {
      children: [
        {
          object: "block",
          type: "file",
          file: { type: "file_upload", file_upload: { id: uploadId } },
        },
      ],
      position: { type: "end" },
      notifications: { mode: "silent" },
    });
    const createdBlockId = result.ids[0];
    if (result.ids.length !== 1 || !createdBlockId || result.cursor)
      return run.unknown("The file append did not identify its exact created child.");
    blockId = createdBlockId;
    const block = await run.block(createdBlockId);
    file = block.file;
    readbackVerified =
      block.type === "file" &&
      sameId(block.parent?.page_id ?? block.parent?.block_id, args.target.block_id);
  }
  await run.save({ attachment_state: "confirmed", ...(blockId ? { block_id: blockId } : {}) });
  if (!propertyTarget) upload = await lifecycle();
  return complete(
    {
      file_upload_id: uploadId,
      upload_mode: mode,
      upload_status: upload.status,
      content_length: upload.content_length,
      expiry_time: upload.expiry_time,
      upload_expiry_time: upload.expiry_time,
      ...(mode === "multi_part"
        ? {
            number_of_parts: plan.number_of_parts,
            acknowledged_part_numbers: run.receipt.upload.parts
              .filter((part: Data) => part.dispatch_state === "acknowledged")
              .map((part: Data) => part.part_number),
          }
        : {}),
      attachment,
      ...(blockId
        ? {
            block_id: blockId,
            attachment_block_id: blockId,
            parent_id: args.target.block_id,
            download_url: file?.file?.url,
            download_url_expiry: file?.file?.expiry_time,
          }
        : {}),
      attached: true,
      file,
      write_outcome: "confirmed",
      readback_verified: readbackVerified,
      ...(propertyTarget ? { concurrency_guarantee: "best_effort_precheck" } : {}),
    },
    readbackVerified ? [] : ["ATTACHMENT_READBACK_INCOMPLETE_OR_CHANGED"],
  );
};

export function createNotionActions(): NativeAction[] {
  return contract.actions.map((definition: Data): NativeAction => {
    const capabilities = [
      ...definition.authorization.upstreamCapabilities,
      ...definition.authorization.adapterAdditionalCapabilities,
    ];
    const handler = handlers[definition.id];
    if (!handler) throw new Error(`Missing frozen Notion implementation: ${definition.id}`);
    return {
      id: definition.id,
      description: definition.description ?? definition.id,
      inputSchema: clone(definition.inputSchema),
      readOnly: definition.readOnly,
      capabilities,
      async execute(args, context) {
        validateNativeInput(definition.inputSchema, args);
        const run = new Run(definition.id, context, args);
        run.require(...capabilities);
        if (
          definition.id === "notion.files.upload" &&
          run.receipt.action_complete === true &&
          run.receipt.attachment_state === "confirmed" &&
          run.receipt.upload_id
        ) {
          run.require(
            (args.target as Data).type === "page_files_property"
              ? "update_content"
              : "insert_content",
          );
          return complete(
            {
              action_id: definition.id,
              file_upload_id: run.receipt.upload_id,
              attachment: run.receipt.attachment_target,
              ...(run.receipt.created_block_ids
                ? { created_block_ids: run.receipt.created_block_ids }
                : {}),
              attached: true,
              write_outcome: run.receipt.write_outcome ?? "confirmed",
              acknowledged: true,
              resource_snapshot_current: false,
              readback_verified: false,
            },
            ["CURRENT_RESOURCE_SNAPSHOT_NOT_READ"],
          );
        }
        if (
          !definition.readOnly &&
          definition.id !== "notion.files.upload" &&
          run.receipt.action_complete === true &&
          run.receipt.write_state === "acknowledged"
        )
          return complete(
            {
              action_id: definition.id,
              write_outcome: run.receipt.write_outcome ?? "confirmed",
              acknowledged: true,
              ...(run.receipt.committed_resource_id
                ? { committed_resource_id: run.receipt.committed_resource_id }
                : {}),
              ...(run.receipt.created_block_ids
                ? { created_block_ids: run.receipt.created_block_ids }
                : {}),
              readback_verified: false,
              resource_snapshot_current: false,
            },
            ["CURRENT_RESOURCE_SNAPSHOT_NOT_READ"],
          );
        const output = await handler(args, run);
        if (!definition.readOnly && run.mutated) {
          try {
            await run.save({ action_complete: true, write_outcome: output.write_outcome });
          } catch {
            return run.unknown(
              "The result was confirmed but the final effect checkpoint could not be persisted.",
            );
          }
        }
        return output;
      },
    };
  });
}
export const notionActions = createNotionActions();
