import { createHash } from "node:crypto";
import type {
  PluginMarketplaceEntry,
  PluginSearchInput,
  PluginSearchResult,
} from "@rakazo/contracts";
import { z } from "zod";
import type { PluginTextReader } from "./plugin-connectors.js";
import { parsePluginSource } from "./plugin-connectors.js";
import { fetchSafeWebBytes, withAbort } from "./web-ssrf.js";

const MAX_INDEX_BYTES = 2_000_000;
const PAGE_SIZE = 50;
const REGISTRIES = [
  {
    name: "Cursor",
    repository: "https://github.com/cursor/plugins",
    path: ".cursor-plugin/marketplace.json",
  },
  {
    name: "xAI",
    repository: "https://github.com/xai-org/plugin-marketplace",
    path: ".grok-plugin/marketplace.json",
  },
] as const;

const entrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  keywords: z.array(z.string().max(120)).max(50).optional(),
  source: z.union([
    z.string().max(2048),
    z
      .object({
        source: z.literal("url"),
        url: z.string().max(2048),
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        path: z.string().min(1).max(2048).optional(),
      })
      .strict(),
    z.object({ type: z.literal("local"), path: z.string().startsWith("./").max(2048) }),
  ]),
});

/** Public indexes suggest sources; only the separate fixed-content preview authorizes an install. */
export function parsePluginMarketplace(
  raw: string,
  registry: { name: string; repository: string },
): { entries: PluginMarketplaceEntry[]; skipped: number } {
  if (Buffer.byteLength(raw) > MAX_INDEX_BYTES) throw new Error("Plugin index is too large");
  const index: unknown = JSON.parse(raw);
  if (
    !index ||
    typeof index !== "object" ||
    Array.isArray(index) ||
    !("plugins" in index) ||
    !Array.isArray(index.plugins) ||
    index.plugins.length > 1000
  ) {
    throw new Error("Invalid plugin index");
  }
  const entries: PluginMarketplaceEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const candidate of index.plugins) {
    const parsed = entrySchema.safeParse(candidate);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const entry = parsed.data;
    try {
      const source = entry.source;
      const from =
        typeof source === "string"
          ? source.startsWith("https://")
            ? source
            : `${registry.repository}#${source.replace(/^\.\//, "")}`
          : "type" in source
            ? `${registry.repository}#${source.path.slice(2)}`
            : source.url;
      let ref = parsePluginSource(from);
      if (typeof source !== "string" && "sha" in source && source.path !== undefined) {
        if (
          [...source.path].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new Error("Invalid plugin path");
        const path = source.path.replace(/^\.\//, "");
        if (!path || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) throw new Error("Invalid plugin path");
        const pathRef = parsePluginSource(`${ref.gitUrl}#${path}`);
        if (!pathRef.subdir || (ref.subdir && ref.subdir !== pathRef.subdir))
          throw new Error("Conflicting plugin path");
        ref = { ...ref, subdir: pathRef.subdir };
      }
      if (typeof source !== "string" && "sha" in source && ref.ref && ref.ref !== source.sha)
        throw new Error("Conflicting plugin pin");
      const pin = typeof source !== "string" && "sha" in source ? source.sha : ref.ref;
      const suffix = ref.subdir ? `#${ref.subdir}` : "";
      const installedSource = ref.gitUrl + suffix;
      const installSource = ref.gitUrl + (pin ? `@${pin}` : "") + suffix;
      if (installedSource.length > 2048 || installSource.length > 2048)
        throw new Error("Plugin source is too long");
      if (seen.has(installSource)) {
        skipped++;
        continue;
      }
      seen.add(installSource);
      entries.push({
        id: `${registry.name}:${installSource}`,
        name: entry.name,
        description: entry.description ?? "",
        keywords: entry.keywords ?? [],
        registry: registry.name,
        source: installSource,
        installedSource,
      });
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

export class PluginMarketplaceCursorError extends Error {
  constructor(changed = false) {
    super(
      changed
        ? "The plugin catalog changed. Start a new search."
        : "Invalid plugin search cursor. Start a new search.",
    );
    this.name = "PluginMarketplaceCursorError";
  }
}

const cursorSchema = z
  .object({
    version: z.literal(1),
    query: z.string().regex(/^[a-f0-9]{64}$/),
    catalog: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().positive().max(2000).multipleOf(PAGE_SIZE),
  })
  .strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function readCursor(value: string | undefined, query: string) {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
    if (cursor.query !== digest(query)) throw new Error();
    return cursor;
  } catch {
    throw new PluginMarketplaceCursorError();
  }
}

const publicRead: PluginTextReader = async (url, maxBytes, signal) => {
  const response = await fetchSafeWebBytes(url, {
    maxBytes,
    signal,
    timeoutMs: 15_000,
    maxRedirects: 0,
    allowedPorts: [443],
    userAgent: "CogineBot/plugin-discovery",
  });
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.body);
};

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Public catalog reads share their own deadline; one caller's cancellation cannot poison the cache. */
export function createPluginMarketplace(read: PluginTextReader = publicRead) {
  type RegistryData = ReturnType<typeof parsePluginMarketplace>;
  const cache = new Map<string, { expires: number; data: RegistryData }>();
  const pending = new Map<string, Promise<RegistryData>>();
  async function registryData(registry: (typeof REGISTRIES)[number]) {
    const cached = cache.get(registry.name);
    if (cached && cached.expires > Date.now()) return cached.data;
    const active = pending.get(registry.name);
    if (active) return active;
    const request = (async () => {
      const signal = AbortSignal.timeout(15_000);
      const repo = new URL(registry.repository).pathname;
      const text = await withAbort(
        read(
          `https://raw.githubusercontent.com${repo}/HEAD/${registry.path}`,
          MAX_INDEX_BYTES,
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      const data = parsePluginMarketplace(text, registry);
      cache.set(registry.name, { data, expires: Date.now() + 60_000 });
      return data;
    })();
    pending.set(registry.name, request);
    try {
      return await request;
    } finally {
      pending.delete(registry.name);
    }
  }
  return {
    async search(input: PluginSearchInput, signal?: AbortSignal): Promise<PluginSearchResult> {
      signal?.throwIfAborted();
      const query = input.query.trim().toLowerCase().replace(/\s+/g, " ");
      if (input.query.trim().length > 200) throw new Error("Plugin search query is too long");
      const cursor = readCursor(input.cursor, query);
      const results = await withAbort(Promise.allSettled(REGISTRIES.map(registryData)), signal);
      signal?.throwIfAborted();
      const entries: PluginMarketplaceEntry[] = [];
      const unavailableRegistries: string[] = [];
      let skippedEntries = 0;
      for (const [i, result] of results.entries()) {
        if (result.status === "fulfilled") {
          entries.push(...result.value.entries);
          skippedEntries += result.value.skipped;
        } else unavailableRegistries.push(REGISTRIES[i]!.name);
      }
      entries.sort((left, right) => compare(left.name, right.name) || compare(left.id, right.id));
      const catalog = digest(JSON.stringify({ entries, unavailableRegistries, skippedEntries }));
      const words = query.split(" ").filter(Boolean);
      const matches = entries.filter((entry) => {
        const text =
          `${entry.name} ${entry.description} ${entry.registry} ${entry.keywords.join(" ")}`.toLowerCase();
        return words.every((word) => text.includes(word));
      });
      if (cursor && (cursor.catalog !== catalog || cursor.offset >= matches.length))
        throw new PluginMarketplaceCursorError(true);
      const offset = cursor?.offset ?? 0;
      const next = offset + PAGE_SIZE;
      return {
        entries: matches
          .slice(offset, next)
          .map((entry) => ({ ...entry, keywords: [...entry.keywords] })),
        nextCursor:
          next < matches.length
            ? Buffer.from(
                JSON.stringify({ version: 1, query: digest(query), catalog, offset: next }),
              ).toString("base64url")
            : null,
        unavailableRegistries,
        skippedEntries,
      };
    },
  };
}
