/** Portable plugin parsing plus a bounded, public-GitHub acquisition adapter.
 * No repository code is executed and no files are written to the host. */
import { createHash } from "node:crypto";
import type { PluginPreview } from "@rakazo/contracts";
import { McpServerConfigInput, PluginPreviewSchema } from "@rakazo/contracts";
import { containsSecret, parseSkillMd } from "@rakazo/core";
import { z } from "zod";
import { assertNoSensitiveQuery, HeaderName } from "./connector-http.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import type { ResolveHostname } from "./web-ssrf.js";
import { fetchSafeWebBytes, withAbort } from "./web-ssrf.js";

export type PluginSourceRef = { gitUrl: string; ref?: string; subdir?: string };
export type PluginRepoFile = { path: string; content: string };
export type PluginRepoFetcher = (
  ref: PluginSourceRef,
  signal?: AbortSignal,
) => Promise<{ files: PluginRepoFile[]; sourceSha: string }>;
export type PluginSkillEntry = { name: string; description: string; content: string };
export type PluginMcpServerEntry = {
  name: string;
  transport: "streamable_http" | "sse";
  endpoint: string;
  headers: Record<string, string>;
};
export type PluginSkippedEntry = {
  kind:
    | "mcp_stdio"
    | "mcp_invalid"
    | "skill_invalid"
    | "editor_only"
    | "unsupported_transport"
    | "unsupported_field";
  name: string;
  reason: string;
};
export type ParsedPlugin = {
  source: string;
  format: "agent-plugins" | "cursor" | "grok";
  name: string;
  version: string | null;
  description: string;
  author: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  keywords: string[];
  sourceSha: string;
  digest: string;
  skills: PluginSkillEntry[];
  mcpServers: PluginMcpServerEntry[];
  skipped: PluginSkippedEntry[];
};

const MAX_FILES = 200;
const MAX_BYTES = 4_000_000;
const MAX_FILE_BYTES = 100_000;
const FULL_SHA = /^[a-f0-9]{40}$/;
const SCHEMAS = new Set([
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
]);
const MANIFESTS = ["plugin.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json"];
const EDITOR_DIRS = new Set([
  "rules",
  "hooks",
  "commands",
  "agents",
  "automations",
  ".claude-plugin",
]);
const manifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  version: z.string().max(128).optional(),
  description: z.string().max(4000).optional(),
  author: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .strict()
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function safePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    /[#?]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    hasControlCharacters(path)
  ) {
    throw new Error("Plugin paths must stay inside the plugin directory");
  }
  return path;
}

/** URL syntax: https://host/owner/repo[.git][@ref][#subdir].
 * GitHub's /tree/ref/subdir form is accepted for single-segment refs. */
export function parsePluginSource(source: string): PluginSourceRef {
  const input = source.trim();
  if (!input || input.length > 2048 || hasControlCharacters(input)) {
    throw new PluginImportError("invalid_source");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PluginImportError("invalid_source");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.port
  ) {
    throw new PluginImportError("invalid_source");
  }
  // Reject traversal in the original input too: URL normalizes dot segments.
  const rawPath =
    input
      .slice(input.indexOf("//") + 2)
      .replace(/^[^/]+/, "")
      .split(/[?#]/, 1)[0] ?? "";
  if (rawPath.includes("%") || rawPath.split("/").some((part) => part === "." || part === ".."))
    throw new PluginImportError("invalid_source");
  const tree = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(
    url.pathname.replace(/\/$/, ""),
  );
  const plain = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:@(.+))?$/.exec(
    url.pathname.replace(/\/$/, ""),
  );
  if (!tree && !plain) throw new PluginImportError("invalid_source");
  const parts = tree ?? plain!;
  const owner = parts[1]!;
  const repo = parts[2]!.replace(/\.git$/i, "");
  const ref = parts[3];
  const subdir = url.hash.slice(1) || tree?.[4] || undefined;
  if (url.hash && tree?.[4] && url.hash.slice(1) !== tree[4])
    throw new PluginImportError("invalid_source");
  if ([owner, repo].some((part) => !part || part === "." || part === ".."))
    throw new PluginImportError("invalid_source");
  if (
    ref !== undefined &&
    (!ref ||
      ref.length > 200 ||
      ref.includes("..") ||
      /[%#?\\\s]/.test(ref) ||
      hasControlCharacters(ref))
  )
    throw new PluginImportError("invalid_source");
  if (subdir) {
    try {
      safePath(subdir);
    } catch {
      throw new PluginImportError("invalid_source");
    }
  }
  return { gitUrl: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`, ref, subdir };
}

function pinnedSource(source: PluginSourceRef, sourceSha: string): string {
  return `${source.gitUrl}/tree/${sourceSha}${source.subdir ? `/${source.subdir}` : ""}`;
}

export class PluginImportError extends Error {
  constructor(
    readonly code: "invalid_source" | "invalid_plugin" | "unavailable" | "aborted" | "timeout",
  ) {
    super(
      code === "invalid_source"
        ? "Enter a public GitHub plugin URL."
        : code === "aborted"
          ? "Plugin import was cancelled."
          : code === "timeout"
            ? "Plugin import timed out."
            : "Could not load a supported plugin from this repository.",
    );
    this.name = "PluginImportError";
  }
}

/** Provider seam for deterministic tests. The default always uses the DNS-pinned,
 * redirect-checked web fetch with per-response byte limits. */
export type PluginTextReader = (
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<string>;
export type PluginRead = PluginTextReader;
const readPublicText: PluginTextReader = async (url, maxBytes, signal) => {
  const response = await fetchSafeWebBytes(url, {
    maxBytes,
    signal,
    timeoutMs: 30_000,
    maxRedirects: 0,
    allowedPorts: [443],
    userAgent: "CogineBot/plugin-import",
  });
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.body);
};

export async function fetchGitHubRepo(
  ref: PluginSourceRef,
  signal?: AbortSignal,
  read: PluginTextReader = readPublicText,
): ReturnType<PluginRepoFetcher> {
  const url = new URL(ref.gitUrl);
  if (url.hostname !== "github.com")
    throw new Error("Only public github.com plugin sources are supported right now");
  const repo = url.pathname;
  const boundedRead: PluginTextReader = async (target, maxBytes, activeSignal) => {
    const value = await withAbort(read(target, maxBytes, activeSignal), activeSignal);
    activeSignal?.throwIfAborted();
    if (Buffer.byteLength(value) > maxBytes)
      throw new Error("Plugin response exceeds its size limit");
    return value;
  };
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  const commit = JSON.parse(
    await boundedRead(
      `https://api.github.com/repos${repo}/commits/${encodeURIComponent(ref.ref ?? "HEAD")}`,
      512_000,
      deadline,
    ),
  ) as { sha?: string; commit?: { tree?: { sha?: string } } };
  const sha = commit.sha;
  if (!sha || !FULL_SHA.test(sha)) throw new Error("Could not resolve plugin commit SHA");
  if (ref.ref && FULL_SHA.test(ref.ref) && ref.ref !== sha)
    throw new Error("Plugin commit SHA did not match the requested pin");
  const treeSha = commit.commit?.tree?.sha;
  if (!treeSha || !FULL_SHA.test(treeSha)) throw new Error("Could not resolve plugin tree");
  const tree = JSON.parse(
    await boundedRead(
      `https://api.github.com/repos${repo}/git/trees/${treeSha}?recursive=1`,
      MAX_BYTES,
      deadline,
    ),
  ) as {
    truncated?: boolean;
    tree?: Array<{ path: string; type: string; mode: string; size?: number }>;
  };
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new Error("Plugin repository tree is incomplete");
  const prefix = ref.subdir ? `${ref.subdir}/` : "";
  const selected = tree.tree.filter((entry) => entry.path.startsWith(prefix));
  const entries = selected.filter((entry) => {
    const path = entry.path.slice(prefix.length);
    safePath(path);
    if (entry.mode === "120000" || entry.mode === "160000" || entry.type === "commit")
      throw new Error("Plugin symlinks and submodules are not supported");
    return entry.type === "blob";
  });
  if (entries.length > MAX_FILES) throw new Error("Plugin directory has too many files");
  let total = 0;
  const files: PluginRepoFile[] = [];
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length);
    // Fetch only component text. Other paths are retained for skipped-part reporting.
    const relevant =
      MANIFESTS.includes(path) ||
      ["mcp.json", ".mcp.json"].includes(path) ||
      /^skills\/[^/]+\/SKILL\.md$/.test(path);
    if (!relevant) {
      files.push({ path: entry.path, content: "" });
      continue;
    }
    if ((entry.size ?? 0) > MAX_FILE_BYTES) throw new Error("Plugin file is too large");
    const body = await boundedRead(
      `https://raw.githubusercontent.com${repo}/${sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
      MAX_FILE_BYTES,
      deadline,
    );
    total += Buffer.byteLength(body);
    if (total > MAX_BYTES) throw new Error("Plugin content is too large");
    files.push({ path: entry.path, content: body });
  }
  deadline.throwIfAborted();
  return { files, sourceSha: sha };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectSkills(
  files: Map<string, string>,
  skipped: PluginSkippedEntry[],
): PluginSkillEntry[] {
  const skills: PluginSkillEntry[] = [];
  const names = new Set<string>();
  for (const [path, content] of files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!match) continue;
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      skipped.push({ kind: "skill_invalid", name: path, reason: "Invalid SKILL.md instructions" });
      continue;
    }
    if (names.has(parsed.name.toLowerCase()))
      throw new Error("Plugin contains duplicate skill names");
    // The current skill store persists SKILL.md text, not companion files. Do not
    // silently install a recipe whose relative references/scripts would be missing.
    if ([...files.keys()].some((p) => p.startsWith(`skills/${match[1]}/`) && p !== path)) {
      skipped.push({
        kind: "skill_invalid",
        name: parsed.name,
        reason: "Skills with companion files are not supported yet",
      });
      continue;
    }
    names.add(parsed.name.toLowerCase());
    skills.push({ name: parsed.name, description: parsed.description, content });
  }
  return skills.sort((a, b) => compare(a.name, b.name));
}

function collectMcpServers(
  files: Map<string, string>,
  schema: string | undefined,
  skipped: PluginSkippedEntry[],
  knownCredentials: string[],
): PluginMcpServerEntry[] {
  const path = schema ? "mcp.json" : files.has("mcp.json") ? "mcp.json" : ".mcp.json";
  const raw = files.get(path);
  if (raw === undefined) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    doc = null;
  }
  if (object(doc) && object(doc.mcpServers)) {
    for (const entry of Object.values(doc.mcpServers)) {
      if (!object(entry) || !object(entry.headers)) continue;
      const headers = Object.fromEntries(
        Object.entries(entry.headers).filter(
          (item): item is [string, string] => typeof item[1] === "string",
        ),
      );
      knownCredentials.push(...oauthMaterialSecrets({ headers }));
    }
  }
  if (
    !object(doc) ||
    !object(doc.mcpServers) ||
    (schema &&
      (doc.$schema !== schema.replace("plugin.schema.json", "mcp.schema.json") ||
        Object.keys(doc).some((key) => !["$schema", "mcpServers"].includes(key))))
  ) {
    skipped.push({
      kind: "mcp_invalid",
      name: path,
      reason: "Invalid or mismatched MCP configuration",
    });
    return [];
  }
  const out: PluginMcpServerEntry[] = [];
  for (const [name, entry] of Object.entries(doc.mcpServers)) {
    if (!name || name.length > 120) {
      skipped.push({ kind: "mcp_invalid", name: "MCP server", reason: "Server name is invalid" });
      continue;
    }
    if (!object(entry)) {
      skipped.push({ kind: "mcp_invalid", name, reason: "Server must be an object" });
      continue;
    }
    const type = entry.type ?? (!schema && entry.command ? "stdio" : undefined);
    if (type === "stdio") {
      skipped.push({ kind: "mcp_stdio", name, reason: "Local MCP execution is disabled" });
      continue;
    }
    if (!["streamable-http", "sse", ...(!schema ? ["http"] : [])].includes(String(type))) {
      skipped.push({ kind: "unsupported_transport", name, reason: "Unsupported MCP transport" });
      continue;
    }
    if (schema && Object.keys(entry).some((key) => !["type", "url", "headers"].includes(key))) {
      skipped.push({ kind: "mcp_invalid", name, reason: "Unknown MCP server field" });
      continue;
    }
    const transport = type === "sse" ? "sse" : "streamable_http";
    const config = McpServerConfigInput.safeParse({
      slug: "plugin-server",
      name: "Plugin server",
      transport,
      endpoint: entry.url,
      headers: entry.headers ?? {},
    });
    // Variables in remote config are not part of Agent Plugins core. Legacy
    // prompting is a later slice; never install unresolved credential templates.
    if (
      !config.success ||
      !("endpoint" in config.data) ||
      /\$\{/.test(JSON.stringify(entry)) ||
      typeof entry.url !== "string" ||
      !entry.url.startsWith("https://")
    ) {
      skipped.push({
        kind: "mcp_invalid",
        name,
        reason: "Invalid endpoint/headers or unresolved credential placeholders",
      });
      continue;
    }
    try {
      assertNoSensitiveQuery(config.data.endpoint);
      const names = Object.keys(config.data.headers).map((key) => key.toLowerCase());
      if (Object.keys(config.data.headers).some((key) => !HeaderName.safeParse(key).success))
        throw new Error("Invalid header name");
      if (new Set(names).size !== names.length) throw new Error("Duplicate headers");
      new Headers(config.data.headers);
    } catch {
      skipped.push({
        kind: "mcp_invalid",
        name,
        reason: "Unsafe endpoint query or invalid headers",
      });
      continue;
    }
    out.push({ name, transport, endpoint: config.data.endpoint, headers: config.data.headers });
  }
  return out.sort((a, b) => compare(a.name, b.name));
}

/** Pure parser; inputs are regular-file content already constrained by acquisition. */
function parsePluginContent(input: {
  source: string;
  files: PluginRepoFile[];
  sourceSha: string;
}): ParsedPlugin {
  if (!FULL_SHA.test(input.sourceSha))
    throw new Error("Plugin requires a full resolved commit SHA");
  if (input.files.length > MAX_FILES) throw new Error("Plugin directory has too many files");
  const source = parsePluginSource(input.source);
  if (source.ref !== input.sourceSha) throw new PluginImportError("invalid_source");
  const files = new Map<string, string>();
  let bytes = 0;
  for (const file of input.files) {
    const path = safePath(file.path);
    bytes += Buffer.byteLength(file.content);
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES || bytes > MAX_BYTES)
      throw new Error("Plugin content is too large");
    if (files.has(path)) throw new Error("Plugin contains duplicate file paths");
    files.set(path, file.content);
  }
  const manifestPath = MANIFESTS.find((path) => files.has(path));
  if (!manifestPath) throw new Error("No plugin manifest found");
  const raw: unknown = JSON.parse(files.get(manifestPath) ?? "");
  if (!object(raw)) throw new Error("Plugin manifest must be an object");
  const format =
    manifestPath === "plugin.json"
      ? "agent-plugins"
      : manifestPath.startsWith(".cursor")
        ? "cursor"
        : "grok";
  const schema = format === "agent-plugins" ? raw.$schema : undefined;
  if (format === "agent-plugins" && (typeof schema !== "string" || !SCHEMAS.has(schema)))
    throw new Error("Unsupported Agent Plugins schema");
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Plugin manifest has invalid metadata or name");
  const manifest = parsed.data;
  const skipped: PluginSkippedEntry[] = [];
  if (schema) {
    for (const key of Object.keys(raw)) {
      if (!["$schema", "extensions", ...Object.keys(manifestSchema.shape)].includes(key)) {
        skipped.push({
          kind: "unsupported_field",
          name: key,
          reason: "Unknown manifest field ignored",
        });
      }
    }
  }
  const editorDirs = new Set(
    [...files.keys()].map((p) => p.split("/")[0] ?? "").filter((p) => EDITOR_DIRS.has(p)),
  );
  for (const name of editorDirs)
    skipped.push({
      kind: "editor_only",
      name: `${name}/`,
      reason: "Editor-only component skipped",
    });
  const skills = collectSkills(files, skipped);
  const knownCredentials: string[] = [];
  const mcpServers = collectMcpServers(
    files,
    typeof schema === "string" ? schema : undefined,
    skipped,
    knownCredentials,
  );
  if (skills.length + mcpServers.length > 200) throw new PluginImportError("invalid_plugin");
  const canonical = [...files.entries()].sort(([a], [b]) => compare(a, b));
  const result: ParsedPlugin = {
    source: pinnedSource(source, input.sourceSha),
    format,
    name: manifest.name,
    version: manifest.version ?? null,
    description: manifest.description ?? "",
    author: manifest.author?.name ?? null,
    homepage: manifest.homepage ?? null,
    repository: manifest.repository ?? null,
    license: manifest.license ?? null,
    keywords: manifest.keywords ?? [],
    sourceSha: input.sourceSha,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`,
    skills,
    mcpServers,
    skipped,
  };
  assertNoCredentialEcho(toPluginPreview(result), knownCredentials);
  return result;
}

export function parsePluginDirectory(input: {
  source: string;
  sourceSha: string;
  files: PluginRepoFile[];
}): ParsedPlugin {
  try {
    return parsePluginContent(input);
  } catch (error) {
    if (error instanceof PluginImportError) throw error;
    throw new PluginImportError("invalid_plugin");
  }
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface GitHubPluginOptions {
  sourceSha?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  read?: PluginTextReader;
}

/** Resolve public GitHub content once for preview, or refetch the exact confirmed SHA. */
export async function fetchGitHubPlugin(
  sourceText: string,
  options: GitHubPluginOptions = {},
): Promise<ParsedPlugin> {
  const settings = { ...options };
  const source = parsePluginSource(sourceText);
  if (
    settings.sourceSha !== undefined &&
    (!FULL_SHA.test(settings.sourceSha) || source.ref !== settings.sourceSha)
  )
    throw new PluginImportError("invalid_source");
  const timeout = AbortSignal.timeout(30_000);
  const signal = AbortSignal.any([timeout, ...(settings.signal ? [settings.signal] : [])]);
  const read: PluginTextReader =
    settings.read ??
    (settings.fetch || settings.resolveHostname
      ? async (url, maxBytes, activeSignal) => {
          const response = await fetchSafeWebBytes(url, {
            fetch: settings.fetch,
            resolveHostname: settings.resolveHostname,
            maxBytes,
            signal: activeSignal,
            timeoutMs: 30_000,
            maxRedirects: 0,
            allowedPorts: [443],
            userAgent: "CogineBot/plugin-import",
          });
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.body);
        }
      : readPublicText);
  try {
    signal.throwIfAborted();
    const repo = await withAbort(fetchGitHubRepo(source, signal, read), signal);
    signal.throwIfAborted();
    if (source.ref && FULL_SHA.test(source.ref) && source.ref !== repo.sourceSha)
      throw new PluginImportError("invalid_source");
    const prefix = source.subdir ? `${source.subdir}/` : "";
    const files = repo.files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ path: file.path.slice(prefix.length), content: file.content }));
    const parsed = parsePluginDirectory({
      files,
      sourceSha: repo.sourceSha,
      source: pinnedSource(source, repo.sourceSha),
    });
    signal.throwIfAborted();
    return parsed;
  } catch (error) {
    if (settings.signal?.aborted) throw new PluginImportError("aborted");
    if (timeout.aborted) throw new PluginImportError("timeout");
    if (error instanceof PluginImportError) throw error;
    throw new PluginImportError("unavailable");
  }
}

/** Only reviewed instructions and header names cross the public preview boundary. */
export function toPluginPreview(plugin: ParsedPlugin): PluginPreview {
  const preview: PluginPreview = {
    source: plugin.source,
    sourceSha: plugin.sourceSha,
    digest: plugin.digest,
    format: plugin.format,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    skills: plugin.skills.map(({ name, description, content }) => ({ name, description, content })),
    mcpServers: plugin.mcpServers.map(({ name, transport, endpoint, headers }) => ({
      name,
      transport,
      endpoint,
      headerKeys: Object.keys(headers),
    })),
    skipped: plugin.skipped.map((entry) => ({ ...entry })),
  };
  const credentials = plugin.mcpServers.flatMap((server) =>
    oauthMaterialSecrets({ headers: server.headers }),
  );
  assertNoCredentialEcho(preview, credentials);
  if (!PluginPreviewSchema.safeParse(preview).success)
    throw new PluginImportError("invalid_plugin");
  return preview;
}

/** Refuse known credential echoes instead of silently changing reviewed instructions. */
function assertNoCredentialEcho(preview: PluginPreview, credentials: string[]) {
  const variants = new Set<string>();
  for (const credential of credentials) {
    variants.add(credential);
    const encoded = encodeURIComponent(credential);
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
    variants.add(Buffer.from(credential).toString("base64"));
    variants.add(Buffer.from(credential).toString("base64url"));
  }
  if (containsSecret(preview, [...variants])) throw new PluginImportError("invalid_plugin");
}
