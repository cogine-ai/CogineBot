import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { NativeAction, NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./gmail.contract.json" with { type: "json" };
import { validateNativeInput } from "./validation.js";

type Obj = Record<string, unknown>;
const PREFIX = "https://www.googleapis.com/auth/";
const ATTACHMENT_LIMIT = 6 * 1024 * 1024;
const MIME_LIMIT = 35 * 1024 * 1024;
const enc = (value: unknown) => encodeURIComponent(String(value));
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
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
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return incomplete("Gmail omitted an expected object.");
  return value as Obj;
}
function identity(value: unknown, field = "id"): string {
  const id = object(value)[field];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
    return incomplete("Gmail omitted a stable resource identity.");
  return id;
}
function pick(source: Obj, keys: readonly string[]): Obj {
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, structuredClone(source[key])]),
  );
}
function sanitizeFilename(value: string): string {
  return Array.from(value, (char) =>
    char === "/" || char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      ? "_"
      : char,
  ).join("");
}
function headerMap(payload: Obj): Map<string, string> {
  const result = new Map<string, string>();
  if (payload.headers !== undefined && !Array.isArray(payload.headers))
    return incomplete("Gmail message headers are malformed.");
  for (const item of (payload.headers ?? []) as unknown[]) {
    const row = object(item);
    if (typeof row.name !== "string" || typeof row.value !== "string")
      return incomplete("Gmail message header is malformed.");
    const key = row.name.toLowerCase();
    if (result.has(key) && ["from", "subject", "message-id", "reply-to"].includes(key))
      return incomplete("Gmail returned ambiguous message identity headers.");
    const unfolded = row.value.replace(/\r?\n[ \t]+/g, " ");
    result.set(key, result.has(key) ? `${result.get(key)}, ${unfolded}` : unfolded);
  }
  return result;
}
function decodeBase64(value: unknown, maximum: number): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(value) ||
    value.replace(/=+$/, "").length % 4 === 1
  )
    return incomplete("Gmail returned invalid base64url content.");
  if (value.length > Math.ceil(maximum / 3) * 4 + 4)
    return invalid("This Gmail attachment exceeds the supported size.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maximum) return invalid("This Gmail attachment exceeds the supported size.");
  if (bytes.toString("base64url") !== value.replace(/=+$/, ""))
    return incomplete("Gmail returned noncanonical base64url content.");
  return bytes;
}
interface MimeContent {
  text: string;
  attachments: Obj[];
  complete: boolean;
  incompleteReasons: string[];
}
function mimeContent(payload: Obj, maximum: number): MimeContent {
  const plain: string[] = [],
    html: string[] = [],
    attachments: Obj[] = [],
    reasons = new Set<string>();
  let count = 0;
  const visit = (part: Obj, depth: number) => {
    if (++count > 1000 || depth > 20) {
      reasons.add("MIME_TREE_LIMIT");
      return;
    }
    const mime = String(part.mimeType ?? "application/octet-stream").toLowerCase();
    const body = part.body === undefined ? {} : object(part.body);
    const headers = headerMap(part);
    const filename = typeof part.filename === "string" ? part.filename : "";
    const disposition = headers.get("content-disposition") ?? "";
    const attachment = !!filename || /^attachment\b/i.test(disposition);
    if (
      ["multipart/encrypted", "application/pkcs7-mime", "application/x-pkcs7-mime"].includes(mime)
    )
      reasons.add("ENCRYPTED_CONTENT");
    if (
      !attachment &&
      ["text/plain", "text/html"].includes(mime) &&
      typeof body.attachmentId === "string"
    )
      reasons.add("BODY_NOT_INLINE");
    if (mime.startsWith("multipart/")) {
      if (!Array.isArray(part.parts) || part.parts.length === 0) {
        reasons.add("MISSING_MULTIPART_PARTS");
        return;
      }
      for (const child of part.parts) visit(object(child), depth + 1);
      return;
    }
    if (
      attachment ||
      typeof body.attachmentId === "string" ||
      !["text/plain", "text/html"].includes(mime)
    ) {
      if (!attachment && !["text/plain", "text/html"].includes(mime) && Number(body.size) > 0)
        reasons.add("UNSUPPORTED_MIME_BODY");
      if (attachment || Number(body.size) > 0)
        attachments.push({
          partId: typeof part.partId === "string" ? part.partId : null,
          filename: filename || "attachment.bin",
          mimeType: mime,
          size: Number.isSafeInteger(body.size) ? body.size : null,
          inline: /^inline\b/i.test(disposition),
          ...(headers.has("content-id") ? { contentId: headers.get("content-id") } : {}),
          downloadAvailable:
            typeof part.partId === "string" &&
            (typeof body.data === "string" || typeof body.attachmentId === "string"),
        });
      return;
    }
    if (body.data === undefined) {
      if (body.size !== undefined && body.size !== 0) reasons.add("BODY_NOT_INLINE");
      return;
    }
    if (typeof body.data !== "string" || body.data.length > 3_000_000) {
      reasons.add("TEXT_PART_SIZE_LIMIT");
      return;
    }
    const charset =
      /charset\s*=\s*"?([^;"\s]+)/i.exec(headers.get("content-type") ?? "")?.[1] ?? "utf-8";
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(body.data, 2_250_000);
    } catch {
      reasons.add("INVALID_BODY_ENCODING");
      return;
    }
    if (
      body.size !== undefined &&
      (!Number.isSafeInteger(body.size) || body.size !== bytes.length)
    ) {
      reasons.add("BODY_SIZE_MISMATCH");
      return;
    }
    let text: string;
    try {
      text = new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
      reasons.add("UNSUPPORTED_OR_INVALID_CHARSET");
      return;
    }
    if (mime === "text/html") {
      // Fragment parsing never runs scripts or fetches resources; return text only.
      const fragment = JSDOM.fragment(text);
      for (const node of fragment.querySelectorAll(
        "script,style,iframe,object,embed,noscript,template",
      ))
        node.remove();
      for (const node of fragment.querySelectorAll("br,p,div,li,tr,h1,h2,h3,h4")) node.append("\n");
      html.push(fragment.textContent ?? "");
    } else plain.push(text);
  };
  visit(payload, 0);
  const full = (plain.some((text) => text.length) ? plain : html).join("\n");
  if (full.length > maximum) reasons.add("TEXT_TRUNCATED");
  return {
    text: full.slice(0, maximum),
    attachments,
    complete: reasons.size === 0,
    incompleteReasons: [...reasons],
  };
}
function message(value: unknown, maximum = 100_000): Obj {
  const row = object(value);
  const id = identity(row),
    threadId = identity(row, "threadId");
  if (!row.payload) return incomplete("Gmail full message omitted its MIME payload.");
  const headers = headerMap(object(row.payload));
  const safeHeaders = Object.fromEntries(
    [
      "from",
      "to",
      "cc",
      "bcc",
      "subject",
      "date",
      "reply-to",
      "message-id",
      "in-reply-to",
      "references",
    ]
      .filter((key) => headers.has(key))
      .map((key) => [key, headers.get(key)]),
  );
  return {
    ...pick(row, ["labelIds", "snippet", "historyId", "internalDate", "sizeEstimate"]),
    id,
    threadId,
    headers: safeHeaders,
    ...mimeContent(object(row.payload), maximum),
  };
}
function messageReceipt(value: unknown): Obj {
  const row = object(value);
  if (
    row.labelIds !== undefined &&
    (!Array.isArray(row.labelIds) || row.labelIds.some((label) => typeof label !== "string"))
  )
    return incomplete("Gmail returned invalid message labels.");
  return {
    ...pick(row, ["labelIds", "historyId"]),
    id: identity(row),
    threadId: identity(row, "threadId"),
  };
}
function draft(value: unknown, maximum = 100_000): Obj {
  const row = object(value);
  return { id: identity(row), message: message(row.message, maximum) };
}
async function request(
  context: NativeActionContext,
  input: NativeRequest,
  write = false,
): Promise<NativeResponse> {
  try {
    const response = await context.request(input);
    if (response.status >= 200 && response.status < 300) return response;
    const details = response.body && typeof response.body === "object" ? object(response.body) : {};
    const error = details.error && typeof details.error === "object" ? object(details.error) : {};
    const reasons = Array.isArray(error.errors)
      ? error.errors.map((item) => object(item).reason)
      : [];
    if (response.status === 401)
      throw new NativeActionError("authorization_expired", "Reconnect this Gmail account.");
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
      throw new NativeActionError("rate_limited", "Gmail quota or rate limit reached.");
    if (response.status === 403)
      throw new NativeActionError(
        "insufficient_scope",
        "This Gmail account lacks the required permission.",
      );
    if (response.status === 404 || response.status === 410)
      throw new NativeActionError("resource_unavailable", "This Gmail resource is unavailable.");
    if (response.status === 409 || response.status === 412)
      throw new NativeActionError("version_conflict", "This Gmail resource changed.");
    if (response.status >= 500 || response.status === 408)
      throw new NativeActionError(
        write ? "result_unknown" : "temporarily_unavailable",
        "Gmail did not confirm this operation.",
        { uncertain: write },
      );
    return invalid("Gmail rejected these action parameters.");
  } catch (error) {
    if (error instanceof NativeActionError) throw error;
    throw new NativeActionError(
      write ? "result_unknown" : "temporarily_unavailable",
      "Gmail response unavailable.",
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
      intentHash: hash(
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
        "This checkpoint belongs to a different approved Gmail operation.",
      );
    this.receipt = {
      ...binding,
      stage: "prepared",
      mimeDate: new Date(Date.now()).toISOString(),
      ...structuredClone(old ?? {}),
    };
  }
  unknown(): never {
    throw new NativeActionError(
      "result_unknown",
      "Gmail may have completed the original operation. Verify it before proposing another write.",
      {
        uncertain: true,
        recovery: pick(this.receipt, [
          "operationId",
          "actionId",
          "stage",
          "messageId",
          "draftId",
          "rfcMessageId",
        ]),
      },
    );
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
  async resume(): Promise<Obj | undefined> {
    if (this.receipt.stage === "committed") return structuredClone(object(this.receipt.result));
    if (this.receipt.stage !== "prepared") return this.unknown();
    await this.save({});
    return undefined;
  }
  async dispatch(input: NativeRequest, project: (value: unknown) => Obj): Promise<Obj> {
    await this.save({ stage: "dispatching" });
    try {
      const response = await request(this.context, input, true);
      const result = { ...project(response.body), outcome: "succeeded" };
      await this.save({ stage: "committed", result });
      return result;
    } catch (error) {
      if (
        !(error instanceof NativeActionError) ||
        error.options.uncertain ||
        ["result_unknown", "incomplete_response"].includes(error.kind)
      )
        return this.unknown();
      await this.save({ stage: "rejected" });
      throw error;
    }
  }
}
function grantedEmail(context: NativeActionContext): string {
  const email = context.principal.context.email;
  if (typeof email !== "string" || !/^[^\s<>\r\n,;]+@[^\s<>\r\n,;]+$/.test(email))
    throw new NativeActionError(
      "not_configured",
      "This Gmail grant has no verified sending email identity.",
    );
  return email;
}
function address(value: string): string {
  if (!/^[^\s<>\r\n,;]+@[^\s<>\r\n,;]+$/.test(value))
    return invalid("An email address is invalid.");
  return value;
}
function addresses(value: string): string[] {
  if (/[\r\n]/.test(value))
    return invalid("Original recipient headers cannot contain line breaks.");
  const parts: string[] = [];
  let start = 0,
    quote = false,
    angle = false,
    escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (char === '"') quote = !quote;
    if (!quote && char === "<") {
      if (angle) return invalid("Original address header is ambiguous.");
      angle = true;
    }
    if (!quote && char === ">") {
      if (!angle) return invalid("Original address header is ambiguous.");
      angle = false;
    }
    if (!quote && !angle && char === ",") {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || angle) return invalid("Original address header is incomplete.");
  parts.push(value.slice(start));
  return parts
    .filter((part) => part.trim())
    .map((part) => {
      const trimmed = part.trim();
      const match = /<([^<>]+)>\s*$/.exec(trimmed);
      return address(match ? match[1]!.trim() : trimmed);
    });
}
function encodedHeader(value: string): string {
  if (/[\r\n]/.test(value)) return invalid("Email headers cannot contain line breaks.");
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 30) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
}
function decodedSubject(value: string): string {
  const joined = value.replace(/(\?=)[ \t]+(?==\?)/g, "$1");
  return joined.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_word, charset: string, encoding: string, encoded: string) => {
      let bytes: Uint8Array;
      if (encoding.toLowerCase() === "b") {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.replace(/=+$/, "").length % 4 === 1)
          return invalid("The original subject has an invalid encoded word.");
        bytes = Buffer.from(encoded, "base64");
      } else {
        const source = encoded.replaceAll("_", " "),
          output: number[] = [];
        for (let at = 0; at < source.length; at++) {
          if (source[at] === "=") {
            const hex = source.slice(at + 1, at + 3);
            if (!/^[a-f0-9]{2}$/i.test(hex))
              return invalid("The original subject has an invalid encoded word.");
            output.push(parseInt(hex, 16));
            at += 2;
          } else {
            if (source.charCodeAt(at) > 127)
              return invalid("The original encoded subject is invalid.");
            output.push(source.charCodeAt(at));
          }
        }
        bytes = new Uint8Array(output);
      }
      try {
        return new TextDecoder(charset, { fatal: true }).decode(bytes);
      } catch {
        return invalid("The original subject uses an unsupported character encoding.");
      }
    },
  );
}
function base64Lines(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}
function encodedFilename(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
interface ReplyHeaders {
  threadId: string;
  inReplyTo: string;
  references: string[];
}
async function buildMime(input: Obj, write: Write, reply?: ReplyHeaders): Promise<string> {
  const email = grantedEmail(write.context);
  const messageId = `<cogine-${hash(`${write.context.operationId}:${write.actionId}`)}@mail.invalid>`;
  const headers = [`From: ${email}`, `To: ${(input.to as string[]).map(address).join(",\r\n ")}`];
  for (const [key, name] of [
    ["cc", "Cc"],
    ["bcc", "Bcc"],
  ] as const)
    if (Array.isArray(input[key]) && input[key].length)
      headers.push(`${name}: ${(input[key] as string[]).map(address).join(",\r\n ")}`);
  if (input.replyTo) headers.push(`Reply-To: ${address(String(input.replyTo))}`);
  headers.push(
    `Subject: ${encodedHeader(String(input.subject))}`,
    `Date: ${new Date(String(write.receipt.mimeDate)).toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  );
  if (reply)
    headers.push(
      `In-Reply-To: ${reply.inReplyTo}`,
      `References: ${reply.references.join("\r\n ")}`,
    );
  const textPart = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(Buffer.from(String(input.text), "utf8"))}`;
  let content = textPart;
  if (input.html !== undefined) {
    const boundary = `cogine-alt-${hash(write.context.operationId).slice(0, 32)}`;
    content = `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${textPart}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(Buffer.from(String(input.html), "utf8"))}\r\n--${boundary}--`;
  }
  const attachments: string[] = [],
    digests: Obj[] = [];
  let bytesTotal = 0;
  for (const value of (input.attachments ?? []) as unknown[]) {
    const item = object(value);
    const artifact = await write.context.readArtifact(String(item.artifactId));
    bytesTotal += artifact.bytes.length;
    if (artifact.bytes.length > 10 * 1024 * 1024 || bytesTotal > 24 * 1024 * 1024)
      return invalid("These attachments exceed the supported message size.");
    const name = String(item.filename ?? artifact.name);
    if (!name || sanitizeFilename(name) !== name || name.length > 240)
      return invalid("An attachment filename is invalid.");
    const mime = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(artifact.mimeType)
      ? artifact.mimeType
      : "application/octet-stream";
    attachments.push(
      `Content-Type: ${mime}\r\nContent-Disposition: attachment; filename*=UTF-8''${encodedFilename(name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(artifact.bytes)}`,
    );
    digests.push({
      artifactId: item.artifactId,
      sha256: hash(artifact.bytes),
      size: artifact.bytes.length,
    });
  }
  if (attachments.length) {
    const boundary = `cogine-mixed-${hash(write.context.operationId).slice(0, 32)}`;
    content = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${[content, ...attachments].join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--`;
  }
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n${content}\r\n`, "utf8");
  if (raw.length > MIME_LIMIT)
    return invalid("The composed email exceeds Gmail's supported MIME size.");
  if (write.receipt.mimeSha256 && write.receipt.mimeSha256 !== hash(raw))
    throw new NativeActionError(
      "version_conflict",
      "An attachment changed since this operation was prepared.",
    );
  await write.save({ rfcMessageId: messageId, mimeSha256: hash(raw), artifacts: digests });
  return raw.toString("base64url");
}
async function originalDraft(args: Obj, context: NativeActionContext): Promise<Obj> {
  const value = object(
    await read(context, `/users/me/drafts/${enc(args.draftId)}`, { format: "full" }),
  );
  if (identity(value) !== args.draftId || identity(value.message) !== args.expectedMessageId)
    throw new NativeActionError(
      "version_conflict",
      "This draft changed. Review the current draft before continuing.",
    );
  const labels = object(value.message).labelIds;
  if (!Array.isArray(labels) || labels.length !== 1 || labels[0] !== "DRAFT")
    return incomplete("Gmail did not confirm an unsent draft message.");
  return value;
}
async function writeAction(id: string, args: Obj, context: NativeActionContext): Promise<Obj> {
  const run = new Write(id, args, context);
  const resumed = await run.resume();
  if (resumed) return resumed;
  if (["gmail.drafts.update", "gmail.drafts.delete", "gmail.drafts.send"].includes(id))
    await originalDraft(args, context);
  if (id === "gmail.drafts.delete") {
    await run.save({ draftId: args.draftId, messageId: args.expectedMessageId });
    return run.dispatch(
      { method: "DELETE", path: `/users/me/drafts/${enc(args.draftId)}` },
      () => ({ draftId: args.draftId, deleted: true }),
    );
  }
  if (id === "gmail.drafts.send") {
    await run.save({ draftId: args.draftId, messageId: args.expectedMessageId });
    return run.dispatch(
      { method: "POST", path: "/users/me/drafts/send", body: { id: args.draftId } },
      (value) => {
        const sent = messageReceipt(value);
        if (sent.id === args.expectedMessageId)
          return incomplete(
            "Gmail did not identify the new sent message after consuming the draft.",
          );
        return {
          message: sent,
          draftId: args.draftId,
          draftConsumed: true,
          delivery: "not-observed",
        };
      },
    );
  }
  if (["gmail.drafts.create", "gmail.drafts.update", "gmail.messages.send"].includes(id)) {
    const raw = await buildMime(object(args.message), run);
    const isDraft = id.startsWith("gmail.drafts.");
    return run.dispatch(
      {
        method: id.endsWith("update") ? "PUT" : "POST",
        path: isDraft
          ? `/users/me/drafts${id.endsWith("update") ? `/${enc(args.draftId)}` : ""}`
          : "/users/me/messages/send",
        body: isDraft ? { message: { raw } } : { raw },
      },
      (value) => {
        if (!isDraft) return { message: messageReceipt(value), delivery: "not-observed" };
        const row = object(value),
          draftId = identity(row);
        if (id.endsWith("update") && draftId !== args.draftId)
          return incomplete("Gmail did not acknowledge the original draft identity.");
        const saved = messageReceipt(row.message);
        if (id.endsWith("update") && saved.id === args.expectedMessageId)
          return incomplete("Gmail did not identify the replacement draft message.");
        return { draftId, message: saved };
      },
    );
  }
  if (id === "gmail.messages.reply") {
    if (
      ![`${PREFIX}gmail.readonly`, `${PREFIX}gmail.modify`].some((scope) =>
        context.principal.scopes.includes(scope),
      )
    )
      throw new NativeActionError(
        "insufficient_scope",
        "Replying requires permission to read the original email.",
      );
    const source = object(
      await read(context, `/users/me/messages/${enc(args.messageId)}`, { format: "full" }),
    );
    if (
      identity(source) !== args.messageId ||
      identity(source, "threadId") !== args.expectedThreadId
    )
      throw new NativeActionError(
        "version_conflict",
        "The original message does not match the approved thread.",
      );
    const headers = headerMap(object(source.payload));
    const originalId = headers.get("message-id"),
      originalSubject = headers.get("subject");
    if (!originalId || !/^<[^<>\s\r\n]{1,800}>$/.test(originalId) || originalSubject === undefined)
      return invalid("The original email lacks safe reply identity headers.");
    const subject = decodedSubject(originalSubject);
    const self = grantedEmail(context).toLowerCase();
    const from = addresses(headers.get("from") ?? "");
    if (from.length !== 1) return invalid("The original email has no unambiguous sender.");
    let to =
      from[0]!.toLowerCase() === self
        ? addresses(headers.get("to") ?? "")
        : addresses(headers.get("reply-to") ?? headers.get("from")!);
    if (args.replyAll) to = [...to, ...addresses(headers.get("to") ?? "")];
    to = [
      ...new Map(
        to
          .filter((email) => email.toLowerCase() !== self)
          .map((email) => [email.toLowerCase(), email]),
      ).values(),
    ];
    const cc = args.replyAll
      ? [
          ...new Map(
            addresses(headers.get("cc") ?? "")
              .filter(
                (email) =>
                  email.toLowerCase() !== self &&
                  !to.some((target) => target.toLowerCase() === email.toLowerCase()),
              )
              .map((email) => [email.toLowerCase(), email]),
          ).values(),
        ]
      : [];
    if (!to.length || to.length + cc.length > 100)
      return invalid("The reply has no valid recipients or too many recipients.");
    const previous = headers.get("references")?.trim() ?? "";
    if (previous && !/^(?:<[^<>\s\r\n]{1,800}>\s*)+$/.test(previous))
      return invalid("The original References header is unsupported.");
    const references = [...new Set([...(previous.match(/<[^<>\s]+>/g) ?? []), originalId])];
    if (references.join(" ").length > 8000)
      return invalid("The reply reference chain exceeds the supported size.");
    const content = {
      to,
      ...(cc.length ? { cc } : {}),
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: args.text,
      ...(args.html === undefined ? {} : { html: args.html }),
      ...(args.attachments === undefined ? {} : { attachments: args.attachments }),
    };
    const raw = await buildMime(content, run, {
      threadId: String(args.expectedThreadId),
      inReplyTo: originalId,
      references,
    });
    return run.dispatch(
      {
        method: "POST",
        path: "/users/me/messages/send",
        body: { raw, threadId: args.expectedThreadId },
      },
      (value) => {
        const sent = messageReceipt(value);
        if (sent.threadId !== args.expectedThreadId)
          return incomplete("Gmail did not confirm the approved reply thread.");
        return { message: sent, delivery: "not-observed" };
      },
    );
  }
  const suffix = id.split(".").at(-1)!;
  let body: Obj | undefined;
  if (suffix === "modify") {
    const add = (args.addLabelIds ?? []) as string[],
      remove = (args.removeLabelIds ?? []) as string[];
    if (
      !(add.length + remove.length) ||
      add.some((label) => remove.includes(label)) ||
      [...add, ...remove].some((label) => ["DRAFT", "SENT", "TRASH"].includes(label))
    )
      return invalid(
        "Use disjoint supported label changes, and the explicit trash action for trash.",
      );
    body = { addLabelIds: add, removeLabelIds: remove };
  }
  await run.save({ messageId: args.messageId });
  return run.dispatch(
    {
      method: "POST",
      path: `/users/me/messages/${enc(args.messageId)}/${suffix}`,
      ...(body ? { body } : {}),
    },
    (value) => {
      const result = messageReceipt(value);
      if (result.id !== args.messageId)
        return incomplete("Gmail acknowledged a different message identity.");
      if (
        suffix === "modify" &&
        (!Array.isArray(result.labelIds) ||
          ((args.addLabelIds ?? []) as string[]).some(
            (label) => !(result.labelIds as string[]).includes(label),
          ) ||
          ((args.removeLabelIds ?? []) as string[]).some((label) =>
            (result.labelIds as string[]).includes(label),
          ))
      )
        return incomplete("Gmail did not confirm the requested label changes.");
      if (suffix === "trash" && !(result.labelIds as string[] | undefined)?.includes("TRASH"))
        return incomplete("Gmail did not confirm the trash state.");
      if (
        suffix === "untrash" &&
        (!Array.isArray(result.labelIds) || (result.labelIds as string[]).includes("TRASH"))
      )
        return incomplete("Gmail did not confirm restoration.");
      return { message: result };
    },
  );
}
function page(value: unknown, key: "messages" | "drafts", args: Obj): Obj {
  const body = object(value),
    values = body[key] ?? [];
  if (!Array.isArray(values)) return incomplete("Gmail returned an invalid page.");
  if (
    body.nextPageToken !== undefined &&
    (typeof body.nextPageToken !== "string" || !body.nextPageToken)
  )
    return incomplete("Gmail returned an invalid page cursor.");
  const items = values.map((value) => {
    const row = object(value);
    return key === "messages"
      ? { id: identity(row), threadId: identity(row, "threadId") }
      : {
          id: identity(row),
          message: { id: identity(row.message), threadId: identity(row.message, "threadId") },
        };
  });
  const nextPageToken = body.nextPageToken ?? null;
  return {
    [key]: items,
    nextPageToken,
    hasMore: nextPageToken !== null,
    allPagesRead: !args.pageToken && nextPageToken === null,
    ...(body.resultSizeEstimate === undefined
      ? {}
      : { resultSizeEstimate: body.resultSizeEstimate }),
  };
}
async function readAction(id: string, args: Obj, context: NativeActionContext): Promise<unknown> {
  if (id === "gmail.messages.search" || id === "gmail.drafts.list") {
    const key = id.startsWith("gmail.messages") ? "messages" : "drafts";
    const query: NonNullable<NativeRequest["query"]> = {
      maxResults: Number(args.maxResults ?? 100),
      ...(args.pageToken === undefined ? {} : { pageToken: String(args.pageToken) }),
      ...(args.q === undefined ? {} : { q: String(args.q) }),
      ...(args.includeSpamTrash === undefined
        ? {}
        : { includeSpamTrash: args.includeSpamTrash as boolean }),
      ...(args.labelIds === undefined ? {} : { labelIds: args.labelIds as string[] }),
    };
    return page(await read(context, `/users/me/${key}`, query), key, args);
  }
  if (id === "gmail.labels.list") {
    const body = object(await read(context, "/users/me/labels"));
    if (body.labels !== undefined && !Array.isArray(body.labels))
      return incomplete("Gmail label list is malformed.");
    return {
      labels: ((body.labels ?? []) as unknown[]).map((value) => {
        const label = object(value);
        return {
          ...pick(label, [
            "name",
            "type",
            "messageListVisibility",
            "labelListVisibility",
            "color",
            "messagesTotal",
            "messagesUnread",
            "threadsTotal",
            "threadsUnread",
          ]),
          id: identity(label),
        };
      }),
    };
  }
  if (id === "gmail.drafts.get") {
    const result = draft(
      await read(context, `/users/me/drafts/${enc(args.draftId)}`, { format: "full" }),
      Number(args.maxTextChars ?? 100_000),
    );
    if (result.id !== args.draftId) return incomplete("Gmail returned a different draft.");
    return result;
  }
  if (id === "gmail.threads.get") {
    const body = object(
      await read(context, `/users/me/threads/${enc(args.threadId)}`, { format: "full" }),
    );
    if (identity(body) !== args.threadId || !Array.isArray(body.messages))
      return incomplete("Gmail returned an invalid thread.");
    const messages = body.messages.map((value) =>
      message(value, Number(args.maxTextChars ?? 100_000)),
    );
    if (
      messages.some(
        (value) =>
          value.threadId !== args.threadId ||
          typeof value.internalDate !== "string" ||
          !/^\d+$/.test(value.internalDate),
      )
    )
      return incomplete("Gmail thread message identity or order is incomplete.");
    messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    return {
      id: args.threadId,
      ...pick(body, ["historyId", "snippet"]),
      messages,
      complete: messages.every((value) => value.complete === true),
    };
  }
  const body = object(
    await read(context, `/users/me/messages/${enc(args.messageId)}`, { format: "full" }),
  );
  if (identity(body) !== args.messageId) return incomplete("Gmail returned a different message.");
  if (id === "gmail.messages.get") return message(body, Number(args.maxTextChars ?? 100_000));
  if (!context.writeArtifact)
    throw new NativeActionError(
      "not_configured",
      "This instance cannot store downloaded attachments.",
    );
  const found: Obj[] = [];
  let count = 0;
  const find = (part: Obj, depth = 0) => {
    if (++count > 1000 || depth > 20) return invalid("This MIME tree exceeds the supported size.");
    if (part.partId === args.partId) found.push(part);
    if (Array.isArray(part.parts)) for (const child of part.parts) find(object(child), depth + 1);
  };
  find(object(body.payload));
  if (found.length !== 1)
    throw new NativeActionError(
      "resource_unavailable",
      "This message has no unambiguous selected attachment part.",
    );
  const part = found[0]!,
    content = object(part.body);
  if (
    !Number.isSafeInteger(content.size) ||
    Number(content.size) < 0 ||
    Number(content.size) > ATTACHMENT_LIMIT
  )
    return invalid("This attachment exceeds the supported 6 MiB download size.");
  const detached = typeof content.attachmentId === "string";
  const data = detached
    ? object(
        await read(
          context,
          `/users/me/messages/${enc(args.messageId)}/attachments/${enc(content.attachmentId)}`,
        ),
      )
    : content;
  const bytes = decodeBase64(data.data ?? "", ATTACHMENT_LIMIT);
  if (bytes.length !== content.size || (data.size !== undefined && data.size !== bytes.length))
    return incomplete("Gmail attachment size did not match its MIME part.");
  const filename =
    typeof part.filename === "string" && part.filename
      ? sanitizeFilename(part.filename).slice(0, 240)
      : "attachment.bin";
  const mimeType =
    typeof part.mimeType === "string" &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(part.mimeType)
      ? part.mimeType
      : "application/octet-stream";
  const artifact = await context.writeArtifact({ bytes, name: filename, mimeType });
  return { messageId: args.messageId, partId: args.partId, artifact, sha256: hash(bytes) };
}
export const gmailActions: readonly NativeAction[] = contract.actions.map((row) => ({
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
        "The selected connection lacks permission for this Gmail action.",
      );
    context.signal.throwIfAborted();
    return row.readOnly
      ? readAction(row.id, structuredClone(input), context)
      : writeAction(row.id, structuredClone(input), context);
  },
}));
export const GMAIL_ACTIONS = gmailActions;
export const gmailContractVersion = contract.frozenAt;
