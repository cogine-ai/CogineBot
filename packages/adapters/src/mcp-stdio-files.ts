import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import {
  MCP_STDIO_OAUTH_FIELDS,
  MCP_STDIO_OAUTH_REFERENCE,
  McpStdioFilesSchema,
} from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { isMap, isSeq, parseAllDocuments } from "yaml";
import { mcpCredentialValueVariants } from "./mcp-credential-redaction.js";

export type McpStdioOAuthField = (typeof MCP_STDIO_OAUTH_FIELDS)[number];
export type McpStdioOAuthValues = Partial<Record<McpStdioOAuthField, string>>;

export function renderMcpStdioTemplate(template: string, values: McpStdioOAuthValues): string {
  return template.replaceAll(MCP_STDIO_OAUTH_REFERENCE, (_reference, name: string) =>
    oauthValue(name, values),
  );
}

function oauthValue(name: string, values: McpStdioOAuthValues): string {
  const field = name.trim();
  if ((MCP_STDIO_OAUTH_FIELDS as readonly string[]).includes(field)) {
    const value = values[field as McpStdioOAuthField];
    if (value) return value;
  }
  throw new Error("A required MCP OAuth value is unavailable");
}

/** JSON strings need escaping. Only the expiry can be interpolated as a bare number. */
export function renderMcpStdioFile(template: string, values: McpStdioOAuthValues): string {
  const first = template.trimStart()[0];
  if (first !== "{" && first !== "[" && first !== '"')
    return renderMcpStdioTemplate(template, values);
  try {
    JSON.parse(template.replaceAll(MCP_STDIO_OAUTH_REFERENCE, "0"));
  } catch {
    return renderMcpStdioTemplate(template, values);
  }
  // Match complete JSON string literals before matching bare references. The
  // replacement never scans an injected value as a second template.
  return template.replace(
    /"(?:[^"\\]|\\[\s\S])*"|\{\{\s*oauth\.([^{}]*)\}\}/g,
    (chunk, name: string | undefined, offset: number) => {
      if (name === undefined) {
        return chunk.replaceAll(MCP_STDIO_OAUTH_REFERENCE, (_reference, field: string) =>
          JSON.stringify(oauthValue(field, values)).slice(1, -1),
        );
      }
      const value = oauthValue(name, values);
      const before = template.slice(0, offset).trimEnd().at(-1);
      const after = template.slice(offset + chunk.length).trimStart()[0];
      if (
        name.trim() !== "expires_at" ||
        !/^[1-9]\d*$/.test(value) ||
        ![":", ",", "["].includes(before ?? "") ||
        ![",", "]", "}"].includes(after ?? "")
      ) {
        throw new Error("MCP JSON credentials require OAuth values inside strings");
      }
      return value;
    },
  );
}

const opaqueCredential = /^[A-Za-z0-9_.~+/-]+=*$/;

function credentialFileValues(content: string): unknown[] {
  try {
    return [JSON.parse(content)];
  } catch {
    // Check the other supported formats.
  }
  try {
    const documents = parseAllDocuments(content, { logLevel: "silent" });
    if (
      documents.length &&
      documents.every((doc) => !doc.errors.length && (isMap(doc.contents) || isSeq(doc.contents)))
    )
      return documents.map((doc) => doc.toJS({ maxAliasCount: 50 }));
  } catch {
    // Assignment files do not need to be valid YAML.
  }
  const text = content.trim();
  const [, authorization] = mcpCredentialValueVariants(text);
  if (
    !text ||
    opaqueCredential.test(text) ||
    (authorization && opaqueCredential.test(authorization))
  )
    return [text];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[#;]/.test(line) && !/^\[[\w. -]+\]$/.test(line));
  const values: string[] = [];
  for (const line of lines) {
    const assigned = line.match(/^(?:export\s+)?[\w.-]+\s*=\s*(.*)$/)?.[1];
    if (assigned === undefined)
      throw new Error(
        "Unsupported MCP credential file format. Use JSON, YAML, assignment lines, or a single token.",
      );
    values.push(assigned);
    const quoted = assigned.match(/^(["'])(.*?)\1(?:\s*[;#].*)?$/);
    if (quoted) {
      const [, quote, value] = quoted as [string, string, string];
      values.push(value);
      if (quote === '"') values.push(value.replaceAll("\\n", "\n").replaceAll("\\r", "\r"));
    } else {
      values.push(assigned.replace(/(?<!\\)[;#].*$/, "").trimEnd());
    }
  }
  return [...values, ...Object.values(parseEnv(lines.join("\n")))];
}

/** A server can echo part of a credential file instead of its whole contents. */
export function mcpCredentialFileSecrets(content: string): string[] {
  const secrets = new Set<string>([content]);
  const pending = credentialFileValues(content);
  // Credential field names are arbitrary. Collect every decoded scalar.
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const child of Object.values(value)) pending.push(child);
    } else if (value !== undefined) {
      secrets.add(String(value));
    }
  }
  for (const value of [...secrets]) {
    for (const variant of mcpCredentialValueVariants(value)) secrets.add(variant);
  }
  secrets.delete("");
  return [...secrets];
}

export async function writeMcpStdioCredentialFiles(
  files: Record<string, string>,
  signal: AbortSignal,
  root = tmpdir(),
): Promise<{ env: Record<string, string>; secrets: string[]; remove: () => Promise<void> }> {
  if (!McpStdioFilesSchema.safeParse(files).success)
    throw new Error("Invalid MCP credential files");
  signal.throwIfAborted();
  const secrets = Object.values(files).flatMap(mcpCredentialFileSecrets);
  const directory = await mkdtemp(join(root, "mcp-credentials-")).catch((error: unknown) => {
    throw new Error("Could not write MCP credential files", { cause: error });
  });
  let removing: Promise<void> | undefined;
  const remove = () => {
    removing ??= (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(directory, { recursive: true, force: true });
          return;
        } catch {
          if (attempt === 2) {
            removing = undefined;
            getLogger().warn("MCP credential file cleanup failed");
            return;
          }
          await delay(50 * (attempt + 1));
        }
      }
    })();
    return removing;
  };
  try {
    const env: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const path = join(directory, name);
      await writeFile(path, content, { flag: "wx", mode: 0o600, signal });
      env[name] = path;
    }
    signal.throwIfAborted();
    return { env, secrets, remove };
  } catch (error) {
    await remove();
    signal.throwIfAborted();
    throw new Error("Could not write MCP credential files", { cause: error });
  }
}
