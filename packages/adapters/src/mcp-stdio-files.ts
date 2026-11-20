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
import { isMap, isSeq, parseAllDocuments, visit } from "yaml";
import {
  mcpCookieCredentialValues,
  mcpCredentialValueVariants,
} from "./mcp-credential-redaction.js";

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

function credentialFileValues(content: string, components: Set<string>): unknown[] {
  try {
    const numberSources: string[] = [];
    const value = JSON.parse(content, (_key, item, context?: { source?: string }) => {
      if (typeof item === "number" && context?.source) numberSources.push(context.source);
      return item;
    });
    return [value, ...numberSources];
  } catch {
    // Check the other supported formats.
  }
  try {
    const documents = parseAllDocuments(content, { intAsBigInt: true, logLevel: "silent" });
    if (
      documents.length &&
      documents.every((doc) => !doc.errors.length && (isMap(doc.contents) || isSeq(doc.contents)))
    ) {
      return documents.flatMap((doc) => {
        const numberSources: string[] = [];
        visit(doc, {
          Scalar(_key, node) {
            if ((typeof node.value === "number" || typeof node.value === "bigint") && node.source)
              numberSources.push(node.source);
            if (typeof node.value === "bigint") numberSources.push(String(Number(node.value)));
          },
        });
        return [doc.toJS({ maxAliasCount: 50 }), ...numberSources];
      });
    }
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
  const assignedValues = credentialAssignmentValues(text, components);
  if (assignedValues) return assignedValues;
  throw new Error(
    "Unsupported MCP credential file format. Use JSON, YAML, assignment lines, or a single token.",
  );
}

function addCookieComponents(components: Set<string>, name: string, value: string) {
  for (const component of mcpCookieCredentialValues(name, value)) components.add(component);
}

function credentialAssignmentValues(text: string, components: Set<string>): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trimStart();
    if (!line || /^[#;]/.test(line) || /^\[[\w. -]+\]\s*$/.test(line)) continue;
    const assignment = line.match(/^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!assignment) return undefined;
    const name = assignment[1]!;
    let assigned = assignment[2]!;
    const quote = assigned[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      while (assigned.indexOf(quote, 1) === -1 && index + 1 < lines.length)
        assigned += `\n${lines[++index]}`;
      const quoted = assigned.match(/^(["'`])([\s\S]*?)\1\s*(?:[;#].*)?$/)?.[2];
      if (quoted === undefined) return undefined;
      values.push(quoted);
      addCookieComponents(components, name, quoted);
      if (quote === '"') values.push(quoted.replaceAll("\\n", "\n").replaceAll("\\r", "\r"));
    } else {
      const beforeComment = assigned.replace(/(?<!\\)[;#].*$/, "").trimEnd();
      values.push(beforeComment);
      addCookieComponents(components, name, beforeComment);
    }
    values.push(assigned);
  }
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (value === undefined) continue;
    values.push(value);
    addCookieComponents(components, name, value);
  }
  return values;
}

/** A server can echo part of a credential file instead of its whole contents. */
export function mcpCredentialFileSecrets(
  content: string,
  metadata?: { literals: Set<string>; components: Set<string> },
): string[] {
  const secrets = new Set<string>([content]);
  const components = new Set<string>();
  const pending = credentialFileValues(content, components);
  // Credential field names are arbitrary. Collect every decoded scalar.
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        pending.push(child);
        for (const scalar of Array.isArray(child) ? child : [child]) {
          if (typeof scalar === "string") addCookieComponents(components, key, scalar);
        }
      }
    } else if (value !== undefined) {
      secrets.add(String(value));
    }
  }
  for (const value of [...secrets]) {
    const variants = mcpCredentialValueVariants(value);
    for (const literal of variants.splice(0, 2)) {
      secrets.add(literal);
      if (literal) metadata?.literals.add(literal);
    }
    for (const component of variants) components.add(component);
  }
  for (const value of components) {
    for (const variant of mcpCredentialValueVariants(value)) {
      secrets.add(variant);
      metadata?.components.add(variant);
    }
  }
  secrets.delete("");
  return [...secrets];
}

export async function writeMcpStdioCredentialFiles(
  files: Record<string, string>,
  signal: AbortSignal,
  root = tmpdir(),
): Promise<{
  env: Record<string, string>;
  secrets: string[];
  metadataLiterals: string[];
  metadataComponents: string[];
  remove: () => Promise<void>;
}> {
  if (!McpStdioFilesSchema.safeParse(files).success)
    throw new Error("Invalid MCP credential files");
  signal.throwIfAborted();
  const metadata = { literals: new Set<string>(), components: new Set<string>() };
  const secrets = Object.values(files).flatMap((content) =>
    mcpCredentialFileSecrets(content, metadata),
  );
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
    return {
      env,
      secrets,
      metadataLiterals: [...metadata.literals],
      metadataComponents: [...metadata.components],
      remove,
    };
  } catch (error) {
    await remove();
    signal.throwIfAborted();
    throw new Error("Could not write MCP credential files", { cause: error });
  }
}
