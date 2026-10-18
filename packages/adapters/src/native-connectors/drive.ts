import { createHash } from "node:crypto";
import type { NativeAction, NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./drive.contract.json" with { type: "json" };
import { validateNativeInput } from "./validation.js";

type Obj = Record<string, unknown>;
type Access = "metadata" | "read" | "write";
const S = "https://www.googleapis.com/auth/";
const LIMIT = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const FIELDS = contract.fileFields;
const FILE_KEYS = FIELDS.split(",");
const PERMISSION_FIELDS =
  "id,type,role,emailAddress,domain,allowFileDiscovery,deleted,expirationTime,pendingOwner,permissionDetails";
const PERMISSION_KEYS = PERMISSION_FIELDS.split(",");
const enc = (value: unknown) => encodeURIComponent(String(value));
const digest = (value: string | Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(value).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
function invalid(message: string): never {
  throw new NativeActionError("invalid_input", message);
}
function incomplete(message: string): never {
  throw new NativeActionError("incomplete_response", message);
}
function unavailable(message: string): never {
  throw new NativeActionError("resource_unavailable", message);
}
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return incomplete("Drive omitted an expected object.");
  return value as Obj;
}
function identity(value: unknown): string {
  const id = object(value).id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
    return incomplete("Drive omitted a stable resource ID.");
  return id;
}
function pick(value: Obj, fields: readonly string[]): Obj {
  return Object.fromEntries(
    fields
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, structuredClone(value[key])]),
  );
}
function file(value: unknown): Obj {
  const row = object(value);
  if (typeof row.mimeType !== "string" || !row.mimeType || typeof row.name !== "string")
    return incomplete("Drive omitted file metadata.");
  if (row.version !== undefined && (typeof row.version !== "string" || !/^\d+$/.test(row.version)))
    return incomplete("Drive returned an invalid file version.");
  return { ...pick(row, FILE_KEYS), id: identity(row) };
}
function permission(value: unknown): Obj {
  const row = object(value);
  if (typeof row.type !== "string" || typeof row.role !== "string")
    return incomplete("Drive omitted sharing role or type.");
  if (typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(row.id))
    return incomplete("Drive omitted a valid opaque sharing identity.");
  return { ...pick(row, PERMISSION_KEYS), id: row.id };
}
function broad(context: NativeActionContext, access: Access): boolean {
  const scopes =
    access === "metadata"
      ? ["drive.metadata.readonly", "drive.readonly", "drive"]
      : access === "read"
        ? ["drive.readonly", "drive"]
        : ["drive"];
  return scopes.some((scope) => context.principal.scopes.includes(`${S}${scope}`));
}
function authority(value: Obj, context: NativeActionContext, access: Access): void {
  if (!broad(context, access) && value.isAppAuthorized !== true)
    unavailable("Select this file for the application before using it with drive.file permission.");
}
function capability(value: Obj, name: string): void {
  const capabilities =
    value.capabilities && typeof value.capabilities === "object" ? object(value.capabilities) : {};
  if (capabilities[name] !== true)
    unavailable("Drive has not granted this account the required file capability.");
}
function sameIds(a: unknown, b: unknown): boolean {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    [...a].sort().every((item, index) => item === [...b].sort()[index])
  );
}
function recoverable(error: unknown): boolean {
  return (
    !(error instanceof NativeActionError) ||
    error.options.uncertain === true ||
    ["result_unknown", "incomplete_response", "temporarily_unavailable"].includes(error.kind)
  );
}
async function request(
  context: NativeActionContext,
  input: NativeRequest,
  write = false,
): Promise<NativeResponse> {
  try {
    const response = await context.request({ service: "drive", ...input });
    if (
      (response.status >= 200 && response.status < 300) ||
      (input.service === "drive-upload" && response.status === 308)
    )
      return response;
    const details = response.body && typeof response.body === "object" ? object(response.body) : {};
    const error = details.error && typeof details.error === "object" ? object(details.error) : {};
    const reasons = Array.isArray(error.errors)
      ? error.errors.map((item) => object(item).reason)
      : [];
    if (response.status === 401)
      throw new NativeActionError("authorization_expired", "Reconnect this Drive account.");
    if (
      response.status === 429 ||
      (response.status === 403 &&
        reasons.some((reason) =>
          [
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "quotaExceeded",
            "dailyLimitExceeded",
          ].includes(String(reason)),
        ))
    )
      throw new NativeActionError("rate_limited", "Drive quota or rate limit reached.");
    if (response.status === 403)
      throw new NativeActionError(
        "resource_unavailable",
        "This Drive account cannot access or change the selected file.",
      );
    if (response.status === 404 || response.status === 410)
      throw new NativeActionError(
        "resource_unavailable",
        "This Drive resource or upload session is unavailable.",
      );
    if (response.status === 409 || response.status === 412)
      throw new NativeActionError("version_conflict", "This Drive resource changed.");
    if (response.status >= 500 || response.status === 408)
      throw new NativeActionError(
        write ? "result_unknown" : "temporarily_unavailable",
        "Drive did not confirm this operation.",
        { uncertain: write },
      );
    return invalid("Drive rejected these action parameters.");
  } catch (error) {
    if (error instanceof NativeActionError) throw error;
    throw new NativeActionError(
      write ? "result_unknown" : "temporarily_unavailable",
      "Drive response unavailable.",
      { uncertain: write },
    );
  }
}
async function read(
  context: NativeActionContext,
  path: string,
  query?: NativeRequest["query"],
): Promise<unknown> {
  return (await request(context, { method: "GET", path, ...(query ? { query } : {}) })).body;
}
async function existing(
  context: NativeActionContext,
  id: unknown,
  access: Access,
  expectedVersion?: unknown,
): Promise<Obj> {
  const result = file(
    await read(context, `/files/${enc(id)}`, { fields: FIELDS, supportsAllDrives: true }),
  );
  if (result.id !== id) return incomplete("Drive returned a different file identity.");
  authority(result, context, access);
  if (expectedVersion !== undefined && result.version !== expectedVersion)
    throw new NativeActionError(
      "version_conflict",
      "This file changed. Review its current version before continuing.",
    );
  return result;
}
async function parent(context: NativeActionContext, id: unknown): Promise<Obj> {
  const result = await existing(context, id, "write");
  if (result.mimeType !== "application/vnd.google-apps.folder" || result.trashed === true)
    return invalid("The destination must be an accessible active folder.");
  capability(result, "canAddChildren");
  return result;
}
class Write {
  readonly receipt: Obj;
  constructor(
    readonly actionId: string,
    readonly args: Obj,
    readonly context: NativeActionContext,
  ) {
    const binding = {
      version: 1,
      operationId: context.operationId,
      actionId,
      intentHash: digest(
        canonical({ args, subject: context.principal.subject, tenant: context.principal.tenant }),
      ),
    };
    const old = context.recovery;
    if (
      old &&
      Object.keys(old).length &&
      Object.entries(binding).some(([key, value]) => old[key] !== value)
    )
      throw new NativeActionError(
        "version_conflict",
        "This checkpoint belongs to a different approved Drive operation.",
      );
    this.receipt = { ...binding, stage: "prepared", ...structuredClone(old ?? {}) };
  }
  unknown(
    message = "Drive may have completed the original operation. Verify it before proposing another write.",
  ): never {
    // Resumable session identifiers never leave the internal effect checkpoint.
    throw new NativeActionError("result_unknown", message, {
      uncertain: true,
      recovery: pick(this.receipt, [
        "operationId",
        "actionId",
        "stage",
        "fileId",
        "confirmedOffset",
      ]),
    });
  }
  async save(patch: Obj): Promise<void> {
    Object.assign(this.receipt, patch);
    try {
      await this.context.checkpoint(structuredClone(this.receipt));
    } catch (error) {
      if (this.receipt.stage !== "prepared") return this.unknown();
      throw error;
    }
  }
  async resume(upload = false): Promise<Obj | undefined> {
    if (this.receipt.stage === "committed") return structuredClone(object(this.receipt.result));
    if (
      this.receipt.stage !== "prepared" &&
      !(upload && ["uploading", "chunk-dispatching"].includes(String(this.receipt.stage)))
    )
      return this.unknown();
    await this.save({});
    return undefined;
  }
  async committed(result: Obj): Promise<Obj> {
    const output = { ...result, outcome: "succeeded" };
    delete this.receipt.session;
    await this.save({ stage: "committed", result: output });
    return output;
  }
  async dispatch(input: NativeRequest, project: (value: unknown) => Obj): Promise<Obj> {
    await this.save({ stage: "dispatching" });
    try {
      return await this.committed(project((await request(this.context, input, true)).body));
    } catch (error) {
      if (recoverable(error)) return this.unknown();
      await this.save({ stage: "rejected" });
      throw error;
    }
  }
}
async function generateId(context: NativeActionContext): Promise<string> {
  const response = object(
    await read(context, "/files/generateIds", { count: 1, space: "drive", type: "files" }),
  );
  if (
    !Array.isArray(response.ids) ||
    response.ids.length !== 1 ||
    typeof response.ids[0] !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(response.ids[0])
  )
    return incomplete("Drive did not return the requested pre-generated file ID.");
  return response.ids[0];
}
function uploaded(
  value: unknown,
  id: string,
  artifact: { bytes: Uint8Array; mimeType: string },
): Obj {
  const result = file(value);
  if (
    result.id !== id ||
    result.size !== String(artifact.bytes.length) ||
    result.mimeType !== artifact.mimeType ||
    result.md5Checksum !== digest(artifact.bytes, "md5")
  )
    return incomplete(
      "Drive did not confirm this exact file identity, MIME type, size and content checksum.",
    );
  return result;
}
interface Session {
  path: string;
  query: Record<string, string>;
}
function session(value: unknown, id: string | undefined): Session {
  if (typeof value !== "string" || value.length > 8192)
    return incomplete("Drive did not return a resumable upload session.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return incomplete("Drive returned an invalid upload session.");
  }
  const expectedPath = `/upload/drive/v3/files${id ? `/${enc(id)}` : ""}`;
  if (
    url.origin !== "https://www.googleapis.com" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== expectedPath ||
    url.searchParams.getAll("upload_id").length !== 1 ||
    !url.searchParams.get("upload_id") ||
    url.searchParams.get("upload_id")!.length > 4096 ||
    [...url.searchParams.keys()].some((key) => !["uploadType", "upload_id"].includes(key)) ||
    (url.searchParams.has("uploadType") &&
      (url.searchParams.getAll("uploadType").length !== 1 ||
        url.searchParams.get("uploadType") !== "resumable"))
  )
    return incomplete("Drive returned an upload session outside its fixed authority or target.");
  return {
    path: url.pathname.slice("/upload/drive/v3".length),
    query: Object.fromEntries(url.searchParams),
  };
}
function storedSession(value: unknown, id: string | undefined): Session {
  const saved = object(value),
    query = object(saved.query);
  if (typeof saved.path !== "string" || typeof query.upload_id !== "string")
    return incomplete("The saved Drive upload session is invalid.");
  const url = new URL(`https://www.googleapis.com/upload/drive/v3${saved.path}`);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== "string") return incomplete("The saved Drive upload query is invalid.");
    url.searchParams.set(key, value);
  }
  return session(url.toString(), id);
}
function offset(response: NativeResponse, size: number, sentLimit: number): number {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const value = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > size || value > sentLimit)
    return incomplete("Drive returned an inconsistent resumable byte range.");
  return value;
}
async function upload(args: Obj, context: NativeActionContext, run: Write): Promise<Obj> {
  const resumed = await run.resume(true);
  if (resumed) return resumed;
  const updating = run.actionId === "drive.files.update_content";
  const artifact = await context.readArtifact(String(args.artifactId));
  if (artifact.bytes.length > LIMIT)
    return invalid("This artifact exceeds the supported 10 MiB upload size.");
  if (
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(artifact.mimeType) ||
    artifact.mimeType.startsWith("application/vnd.google-apps.")
  )
    return invalid(
      "This action accepts binary MIME uploads, without implicit Google Workspace conversion.",
    );
  const sha256 = digest(artifact.bytes);
  if (
    run.receipt.artifactSha256 !== undefined &&
    (run.receipt.artifactSha256 !== sha256 ||
      run.receipt.artifactSize !== artifact.bytes.length ||
      run.receipt.artifactMimeType !== artifact.mimeType)
  )
    throw new NativeActionError(
      "version_conflict",
      "The artifact changed since this upload was prepared.",
    );
  const restoring = run.receipt.session !== undefined;
  if (restoring && run.receipt.fileId === undefined)
    return run.unknown("The resumable upload lost its frozen target identity.");
  if (!restoring) {
    if (updating) {
      const current = await existing(context, args.fileId, "write", args.expectedVersion);
      capability(current, "canEdit");
      if (String(current.mimeType).startsWith("application/vnd.google-apps."))
        return invalid(
          "Use the document application's editor instead of binary content replacement.",
        );
    } else if (args.parentId) await parent(context, args.parentId);
    const fileId = updating
      ? String(args.fileId)
      : typeof run.receipt.fileId === "string"
        ? run.receipt.fileId
        : await generateId(context);
    await run.save({
      fileId,
      artifactSha256: sha256,
      artifactSize: artifact.bytes.length,
      artifactMimeType: artifact.mimeType,
    });
  }
  const fileId = String(run.receipt.fileId),
    initPath = updating ? `/files/${enc(fileId)}` : "/files";
  if (!restoring) {
    if (artifact.bytes.length === 0) {
      // A metadata-only create is the Drive protocol for a new zero-byte binary file.
      if (updating)
        return run.dispatch(
          {
            service: "drive-upload",
            method: "PATCH",
            path: initPath,
            query: { uploadType: "media", supportsAllDrives: true, fields: FIELDS },
            headers: { "Content-Type": artifact.mimeType },
            body: artifact.bytes,
          },
          (value) => ({ file: uploaded(value, fileId, artifact), artifactSha256: sha256 }),
        );
      return run.dispatch(
        {
          method: "POST",
          path: "/files",
          query: { fields: FIELDS, supportsAllDrives: true },
          body: {
            id: fileId,
            name: args.name,
            mimeType: artifact.mimeType,
            ...(args.parentId ? { parents: [args.parentId] } : {}),
            ...(args.description === undefined ? {} : { description: args.description }),
          },
        },
        (value) => ({ file: uploaded(value, fileId, artifact), artifactSha256: sha256 }),
      );
    }
    await run.save({ stage: "init-dispatching" });
    try {
      const response = await request(
        context,
        {
          service: "drive-upload",
          method: updating ? "PATCH" : "POST",
          path: initPath,
          query: { uploadType: "resumable", supportsAllDrives: true, fields: FIELDS },
          headers: {
            "X-Upload-Content-Type": artifact.mimeType,
            "X-Upload-Content-Length": String(artifact.bytes.length),
          },
          body: updating
            ? { mimeType: artifact.mimeType }
            : {
                id: fileId,
                name: args.name,
                mimeType: artifact.mimeType,
                ...(args.parentId ? { parents: [args.parentId] } : {}),
                ...(args.description === undefined ? {} : { description: args.description }),
              },
        },
        true,
      );
      const target = session(response.headers.get("location"), updating ? fileId : undefined);
      await run.save({ stage: "uploading", session: target, confirmedOffset: 0, sentLimit: 0 });
    } catch (error) {
      if (recoverable(error))
        return run.unknown(
          "Upload session creation was not confirmed; no replacement session will be created automatically.",
        );
      await run.save({ stage: "rejected" });
      throw error;
    }
  }
  const target = storedSession(run.receipt.session, updating ? fileId : undefined);
  const status = async (): Promise<NativeResponse> => {
    try {
      return await request(
        context,
        {
          service: "drive-upload",
          method: "PUT",
          path: target.path,
          query: target.query,
          headers: { "Content-Range": `bytes */${artifact.bytes.length}` },
          body: new Uint8Array(),
        },
        true,
      );
    } catch {
      return run.unknown(
        "The original upload session could not be reconciled; inspect the frozen file before retrying.",
      );
    }
  };
  const complete = async (response: NativeResponse): Promise<Obj> => {
    try {
      return await run.committed({
        file: uploaded(response.body, fileId, artifact),
        artifactSha256: sha256,
      });
    } catch {
      return run.unknown("Drive did not confirm all frozen upload bytes as the expected file.");
    }
  };
  let next = Number(run.receipt.confirmedOffset ?? 0);
  if (!Number.isSafeInteger(next) || next < 0 || next >= artifact.bytes.length)
    return run.unknown("The upload checkpoint has an inconsistent byte offset.");
  if (restoring) {
    const response = await status();
    if (response.status !== 308) return complete(response);
    try {
      next = offset(response, artifact.bytes.length, Number(run.receipt.sentLimit ?? 0));
    } catch {
      return run.unknown("The original upload session returned an inconsistent confirmed range.");
    }
    await run.save({ stage: "uploading", confirmedOffset: next });
  }
  for (let chunks = 0; next < artifact.bytes.length && chunks < 50; chunks++) {
    context.signal.throwIfAborted();
    const end = Math.min(next + CHUNK, artifact.bytes.length);
    await run.save({ stage: "chunk-dispatching", lastStart: next, sentLimit: end });
    let response: NativeResponse;
    try {
      response = await request(
        context,
        {
          service: "drive-upload",
          method: "PUT",
          path: target.path,
          query: target.query,
          headers: {
            "Content-Type": artifact.mimeType,
            "Content-Range": `bytes ${next}-${end - 1}/${artifact.bytes.length}`,
          },
          body: artifact.bytes.slice(next, end),
        },
        true,
      );
    } catch (error) {
      if (!recoverable(error)) throw error;
      response = await status();
    }
    if (response.status !== 308) return complete(response);
    let confirmed: number;
    try {
      confirmed = offset(response, artifact.bytes.length, end);
    } catch {
      return run.unknown("Drive did not confirm a valid range for this upload chunk.");
    }
    if (confirmed <= next || confirmed >= artifact.bytes.length)
      return run.unknown("Drive did not confirm forward upload progress or final completion.");
    next = confirmed;
    await run.save({ stage: "uploading", confirmedOffset: next });
  }
  return run.unknown("This upload stopped before final file confirmation.");
}
async function writeAction(id: string, args: Obj, context: NativeActionContext): Promise<Obj> {
  const run = new Write(id, args, context);
  if (["drive.files.upload", "drive.files.update_content"].includes(id))
    return upload(args, context, run);
  const resumed = await run.resume();
  if (resumed) return resumed;
  if (id === "drive.folders.create") {
    if (args.parentId) await parent(context, args.parentId);
    const fileId =
      typeof run.receipt.fileId === "string" ? run.receipt.fileId : await generateId(context);
    await run.save({ fileId });
    return run.dispatch(
      {
        method: "POST",
        path: "/files",
        query: { fields: FIELDS, supportsAllDrives: true },
        body: {
          id: fileId,
          name: args.name,
          mimeType: "application/vnd.google-apps.folder",
          ...(args.parentId ? { parents: [args.parentId] } : {}),
          ...(args.description === undefined ? {} : { description: args.description }),
        },
      },
      (value) => {
        const result = file(value);
        if (
          result.id !== fileId ||
          result.mimeType !== "application/vnd.google-apps.folder" ||
          result.name !== args.name
        )
          return incomplete("Drive did not confirm the requested folder.");
        return { file: result };
      },
    );
  }
  const current = await existing(context, args.fileId, "write", args.expectedVersion);
  await run.save({ fileId: args.fileId });
  const path = `/files/${enc(args.fileId)}`;
  if (id === "drive.files.copy") {
    capability(current, "canCopy");
    if (current.trashed === true) return invalid("Restore the source file before copying it.");
    if (args.parentId) await parent(context, args.parentId);
    return run.dispatch(
      {
        method: "POST",
        path: `${path}/copy`,
        query: { fields: FIELDS, supportsAllDrives: true },
        body: { name: args.name, ...(args.parentId ? { parents: [args.parentId] } : {}) },
      },
      (value) => {
        const result = file(value);
        if (
          result.id === args.fileId ||
          result.name !== args.name ||
          result.mimeType !== current.mimeType
        )
          return incomplete("Drive did not identify the requested copy.");
        return { file: result };
      },
    );
  }
  if (id === "drive.permissions.create") {
    capability(current, "canShare");
    const input = object(args.permission),
      user = ["user", "group"].includes(String(input.type));
    if (user && (!input.emailAddress || input.domain !== undefined))
      return invalid("User/group sharing requires only an explicit email recipient.");
    if (input.type === "domain" && (!input.domain || input.emailAddress !== undefined))
      return invalid("Domain sharing requires only an explicit domain recipient.");
    if (
      input.type === "anyone" &&
      (args.allowPublic !== true || input.emailAddress !== undefined || input.domain !== undefined)
    )
      return invalid("Public sharing requires an explicit public-sharing choice.");
    if (!user && args.sendNotificationEmail !== false)
      return invalid("Notification email applies only to user/group recipients.");
    return run.dispatch(
      {
        method: "POST",
        path: `${path}/permissions`,
        query: {
          supportsAllDrives: true,
          fields: PERMISSION_FIELDS,
          ...(user ? { sendNotificationEmail: args.sendNotificationEmail as boolean } : {}),
        },
        body: input,
      },
      (value) => {
        const result = permission(value);
        if (
          result.type !== input.type ||
          result.role !== input.role ||
          (input.emailAddress &&
            String(result.emailAddress).toLowerCase() !==
              String(input.emailAddress).toLowerCase()) ||
          (input.domain &&
            String(result.domain).toLowerCase() !== String(input.domain).toLowerCase())
        )
          return incomplete("Drive did not confirm the intended sharing recipient and role.");
        return { fileId: args.fileId, permission: result, notificationDelivery: "not-observed" };
      },
    );
  }
  if (id === "drive.permissions.delete") {
    capability(current, "canShare");
    const selected = permission(
      await read(context, `${path}/permissions/${enc(args.permissionId)}`, {
        supportsAllDrives: true,
        fields: PERMISSION_FIELDS,
      }),
    );
    if (selected.id !== args.permissionId)
      return incomplete("Drive returned a different sharing identity.");
    if (
      !Array.isArray(selected.permissionDetails) ||
      selected.permissionDetails.length === 0 ||
      selected.permissionDetails.some((value) => typeof object(value).inherited !== "boolean")
    )
      return incomplete("Drive did not confirm whether the selected permission is inherited.");
    if (
      selected.role === "owner" ||
      selected.pendingOwner === true ||
      selected.permissionDetails.some((value) => object(value).inherited === true)
    )
      return invalid("Owner, pending owner and inherited access cannot be removed by this action.");
    const about = object(await read(context, "/about", { fields: "user(permissionId)" })),
      self = object(about.user).permissionId;
    if (typeof self !== "string" || !self)
      return incomplete("Drive did not identify this account's permission ID.");
    if (self === args.permissionId)
      return invalid("This action cannot remove the selected account's own access.");
    return run.dispatch(
      {
        method: "DELETE",
        path: `${path}/permissions/${enc(args.permissionId)}`,
        query: { supportsAllDrives: true },
      },
      () => ({ fileId: args.fileId, permissionId: args.permissionId, deleted: true }),
    );
  }
  let body: Obj,
    query: NonNullable<NativeRequest["query"]> = { supportsAllDrives: true, fields: FIELDS };
  if (id === "drive.files.update_metadata") {
    capability(current, "canEdit");
    body = object(args.metadata);
    if (!Object.keys(body).length) return invalid("Specify at least one supported metadata field.");
  } else if (id === "drive.files.move") {
    capability(current, "canMoveItemWithinDrive");
    if (!sameIds(current.parents ?? [], args.expectedParentIds))
      throw new NativeActionError("version_conflict", "This file's parent folder changed.");
    const destination = await parent(context, args.destinationParentId);
    if ((current.driveId ?? null) !== (destination.driveId ?? null))
      return invalid("Cross-drive moves require a separate reviewed operation.");
    if (
      args.destinationParentId === args.fileId ||
      (current.parents as string[] | undefined)?.includes(String(args.destinationParentId))
    )
      return invalid("Choose a different destination folder.");
    query = {
      ...query,
      addParents: String(args.destinationParentId),
      ...((current.parents as string[] | undefined)?.length
        ? { removeParents: (current.parents as string[]).join(",") }
        : {}),
    };
    body = {};
  } else {
    const trash = id === "drive.files.trash";
    capability(current, trash ? "canTrash" : "canUntrash");
    body = { trashed: trash };
  }
  return run.dispatch({ method: "PATCH", path, query, body }, (value) => {
    const result = file(value);
    if (
      result.id !== args.fileId ||
      Object.entries(body).some(([key, expected]) => result[key] !== expected) ||
      (id === "drive.files.move" && !sameIds(result.parents, [args.destinationParentId]))
    )
      return incomplete("Drive did not confirm the requested file change.");
    return { file: result };
  });
}
function page(value: unknown, key: string, args: Obj, transform: (item: unknown) => Obj): Obj {
  const body = object(value),
    rows = body[key] ?? [];
  if (!Array.isArray(rows)) return incomplete("Drive returned an invalid collection page.");
  if (
    body.nextPageToken !== undefined &&
    (typeof body.nextPageToken !== "string" || !body.nextPageToken)
  )
    return incomplete("Drive returned an invalid page cursor.");
  const nextPageToken = body.nextPageToken ?? null,
    incompleteSearch = body.incompleteSearch === true;
  return {
    [key]: rows.map(transform),
    nextPageToken,
    hasMore: nextPageToken !== null,
    allPagesRead: !args.pageToken && nextPageToken === null && !incompleteSearch,
    ...(body.incompleteSearch === undefined ? {} : { incompleteSearch }),
  };
}
function filename(name: unknown): string {
  return typeof name === "string" && name
    ? Array.from(name, (char) =>
        char === "/" || char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
          ? "_"
          : char,
      )
        .join("")
        .slice(0, 240)
    : "download.bin";
}
const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
};
async function readAction(id: string, args: Obj, context: NativeActionContext): Promise<unknown> {
  if (id === "drive.files.search") {
    const result = page(
      await read(context, "/files", {
        spaces: "drive",
        fields: `nextPageToken,incompleteSearch,files(${FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: args.driveId ? "drive" : "user",
        pageSize: (args.pageSize as number) ?? 100,
        ...pick(args, ["q", "pageToken", "orderBy", "driveId"]),
      } as NativeRequest["query"]),
      "files",
      args,
      file,
    );
    if (!broad(context, "metadata"))
      result.files = (result.files as Obj[]).filter((item) => item.isAppAuthorized === true);
    return {
      ...result,
      resourceCollection: broad(context, "metadata") ? "accessible-files" : "app-authorized-files",
    };
  }
  const access = id === "drive.files.get" ? "metadata" : "read";
  const current = await existing(context, args.fileId, access);
  if (id === "drive.files.get") return current;
  const path = `/files/${enc(args.fileId)}`;
  if (id === "drive.permissions.list")
    return page(
      await read(context, `${path}/permissions`, {
        supportsAllDrives: true,
        fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
        pageSize: (args.pageSize as number) ?? 100,
        ...pick(args, ["pageToken"]),
      }),
      "permissions",
      args,
      permission,
    );
  if (id === "drive.revisions.list")
    return {
      ...page(
        await read(context, `${path}/revisions`, {
          fields:
            "nextPageToken,revisions(id,mimeType,modifiedTime,keepForever,published,publishAuto,publishedOutsideDomain,originalFilename,md5Checksum,size)",
          pageSize: (args.pageSize as number) ?? 100,
          ...pick(args, ["pageToken"]),
        }),
        "revisions",
        args,
        (value) => {
          const row = object(value);
          return {
            ...pick(row, [
              "mimeType",
              "modifiedTime",
              "keepForever",
              "published",
              "publishAuto",
              "publishedOutsideDomain",
              "originalFilename",
              "md5Checksum",
              "size",
            ]),
            id: identity(row),
          };
        },
      ),
      revisionCoverage: "provider-visible-only",
      historicalDownloadGuaranteed: false,
    };
  if (!context.writeArtifact)
    throw new NativeActionError("not_configured", "This instance cannot store downloaded files.");
  capability(current, "canDownload");
  let response: NativeResponse,
    mimeType = String(current.mimeType),
    name = filename(current.name);
  if (id === "drive.files.export") {
    if (
      !mimeType.startsWith("application/vnd.google-apps.") ||
      mimeType === "application/vnd.google-apps.folder" ||
      mimeType === "application/vnd.google-apps.shortcut"
    )
      return invalid("Choose a Google Workspace file that supports export.");
    const about = object(await read(context, "/about", { fields: "exportFormats" }));
    const formats = object(about.exportFormats)[mimeType];
    if (!Array.isArray(formats) || !formats.includes(args.mimeType))
      return invalid("Drive does not support this export format for the selected file.");
    mimeType = String(args.mimeType);
    name += EXTENSIONS[mimeType] ?? ".export";
    response = await request(context, {
      method: "GET",
      path: `${path}/export`,
      query: { mimeType },
      responseType: "bytes",
    });
  } else {
    if (mimeType.startsWith("application/vnd.google-apps."))
      return invalid(
        "Use export for native documents, or explicitly select and authorize a shortcut's target.",
      );
    if (
      typeof current.size !== "string" ||
      !/^\d+$/.test(current.size) ||
      !Number.isSafeInteger(Number(current.size)) ||
      Number(current.size) > LIMIT
    )
      return invalid("This file has no supported bounded download size.");
    response = await request(context, {
      method: "GET",
      path,
      query: { alt: "media", supportsAllDrives: true },
      responseType: "bytes",
    });
  }
  if (!(response.body instanceof Uint8Array) || response.body.length > LIMIT)
    return incomplete("Drive returned incomplete or oversized file bytes.");
  const bytes = response.body;
  if (
    id === "drive.files.download" &&
    (bytes.length !== Number(current.size) ||
      (current.md5Checksum !== undefined && current.md5Checksum !== digest(bytes, "md5")))
  )
    return incomplete("Drive download does not match its file size or checksum.");
  const artifact = await context.writeArtifact({ bytes, name, mimeType });
  return {
    fileId: args.fileId,
    artifact,
    sha256: digest(bytes),
    ...(id.endsWith("export") ? { exportedMimeType: mimeType } : {}),
  };
}
export const driveActions: readonly NativeAction[] = contract.actions.map((row) => ({
  id: row.id,
  description: row.id,
  inputSchema: row.inputSchema as Obj,
  readOnly: row.readOnly,
  scopesAnyOf: row.authorization.acceptedAnyOfScopes,
  execute: async (input, context) => {
    validateNativeInput(row.inputSchema as Obj, input);
    if (
      !row.authorization.acceptedAnyOfScopes.some((scope) =>
        context.principal.scopes.includes(scope),
      )
    )
      throw new NativeActionError(
        "insufficient_scope",
        "The selected connection lacks permission for this Drive action.",
      );
    context.signal.throwIfAborted();
    return row.readOnly
      ? readAction(row.id, structuredClone(input), context)
      : writeAction(row.id, structuredClone(input), context);
  },
}));
export const DRIVE_ACTIONS = driveActions;
export const driveContractVersion = contract.frozenAt;
