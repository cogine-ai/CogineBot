import { PluginPreviewSchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRead, PluginRepoFile } from "./plugin-connectors.js";
import {
  fetchGitHubPlugin,
  PluginImportError,
  parsePluginDirectory,
  parsePluginSource,
  toPluginPreview,
} from "./plugin-connectors.js";

const SHA = "a".repeat(40);
const SOURCE = `https://github.com/example/plugin/tree/${SHA}`;
const skill =
  "---\nname: example-skill\ndescription: Example skill\nnotes: |+\n  keep\n\n---\n\nOriginal instructions.\n\n";
const files = [
  {
    path: ".cursor-plugin/plugin.json",
    content: JSON.stringify({ name: "example-plugin", description: "Example" }),
  },
  { path: "skills/example/SKILL.md", content: skill },
  {
    path: ".mcp.json",
    content: JSON.stringify({
      mcpServers: {
        example: {
          type: "http",
          url: "https://tools.example.test/mcp",
          headers: { "X-Tenant": "fake-static-header" },
        },
      },
    }),
  },
];

afterEach(() => vi.restoreAllMocks());

describe("bounded immutable GitHub acquisition", () => {
  const TREE = "b".repeat(40);
  function reader(
    entries: Array<Record<string, unknown>> = files.map((f) => ({
      path: f.path,
      type: "blob",
      mode: "100644",
      size: Buffer.byteLength(f.content),
    })),
  ) {
    return vi.fn<PluginRead>(async (url) => {
      if (url.includes("/commits/"))
        return JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } });
      if (url.includes("/git/trees/")) return JSON.stringify({ tree: entries, truncated: false });
      const file = files.find((f) => url.endsWith(`/${f.path}`));
      if (!file) throw new Error("Unexpected fixture URL");
      return file.content;
    });
  }

  it("resolves preview once and returns an immutable source with complete original instructions", async () => {
    const read = reader();
    const preview = toPluginPreview(
      await fetchGitHubPlugin("https://github.com/Example/Plugin", { read }),
    );
    expect(preview.source).toBe(SOURCE);
    expect(preview.sourceSha).toBe(SHA);
    expect(preview.skills[0]?.content).toBe(skill);
    expect(read.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/example/plugin/commits/HEAD",
    );
    expect(read.mock.calls[1]?.[0]).toBe(
      `https://api.github.com/repos/example/plugin/git/trees/${TREE}?recursive=1`,
    );
    expect(
      read.mock.calls
        .slice(2)
        .every(([url]) =>
          url.startsWith(`https://raw.githubusercontent.com/example/plugin/${SHA}/`),
        ),
    ).toBe(true);
    expect(PluginPreviewSchema.safeParse(preview).success).toBe(true);
  });

  it("refetches only the confirmed SHA and rejects an unpinned or conflicting install input before acquisition", async () => {
    const read = reader();
    await fetchGitHubPlugin(SOURCE, { sourceSha: SHA, read });
    expect(read.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/example/plugin/commits/${SHA}`,
    );
    const before = read.mock.calls.length;
    await expect(
      fetchGitHubPlugin("https://github.com/example/plugin", { sourceSha: SHA, read }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(fetchGitHubPlugin(SOURCE, { sourceSha: TREE, read })).rejects.toMatchObject({
      code: "invalid_source",
    });
    expect(read.mock.calls).toHaveLength(before);
  });

  it.each([
    [{ path: "plugin.json", type: "blob", mode: "120000" }],
    [{ path: "skills", type: "commit", mode: "160000" }],
    [{ path: "plugin.json", type: "blob", mode: "160000" }],
    [{ path: "../plugin.json", type: "blob", mode: "100644" }],
    [{ path: "plugin.json", type: "blob", mode: "100644", size: 100001 }],
    Array.from({ length: 201 }, (_, i) => ({ path: `file-${i}`, type: "blob", mode: "100644" })),
  ])("rejects unsafe or oversized tree entries without raw-file reads", async (...entries) => {
    const read = reader(entries);
    await expect(fetchGitHubPlugin(SOURCE, { read })).rejects.toBeInstanceOf(PluginImportError);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects incomplete trees and wrong commit identity", async () => {
    for (const kind of ["truncated", "wrong sha"]) {
      const read = vi.fn<PluginRead>(async (url) =>
        url.includes("commits")
          ? JSON.stringify({
              sha: kind === "wrong sha" ? TREE : SHA,
              commit: { tree: { sha: TREE } },
            })
          : JSON.stringify({ truncated: true, tree: [] }),
      );
      await expect(fetchGitHubPlugin(SOURCE, { read })).rejects.toBeInstanceOf(PluginImportError);
      expect(read).toHaveBeenCalledTimes(kind === "wrong sha" ? 1 : 2);
    }
  });

  it("enforces actual response bytes even when a text-reader reports no metadata limit", async () => {
    const read = reader([
      { path: ".cursor-plugin/plugin.json", type: "blob", mode: "100644", size: 10 },
    ]);
    read.mockImplementation(async (url) =>
      url.includes("commits")
        ? JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } })
        : url.includes("trees")
          ? JSON.stringify({
              tree: [
                { path: ".cursor-plugin/plugin.json", type: "blob", mode: "100644", size: 10 },
              ],
            })
          : "a".repeat(100001),
    );
    await expect(fetchGitHubPlugin(SOURCE, { read })).rejects.toBeInstanceOf(PluginImportError);
  });

  it("aborts a stalled reader and does not continue after its late result", async () => {
    const controller = new AbortController();
    let resolve!: (text: string) => void;
    const read = vi.fn<PluginRead>(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const pending = fetchGitHubPlugin(SOURCE, { read, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    resolve(JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } }));
    await new Promise<void>((done) => setImmediate(done));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares a hard timeout across acquisition even when the reader ignores its signal", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const read = vi.fn<PluginRead>(() => new Promise<string>(() => undefined));
    const pending = fetchGitHubPlugin(SOURCE, { read });
    timeout.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never publishes remote diagnostics or response bodies as import errors", async () => {
    let error: unknown;
    try {
      await fetchGitHubPlugin(SOURCE, {
        read: async () => {
          throw new Error("fake-private-credential and private URL");
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginImportError);
    expect(String(error)).not.toContain("fake-private-credential");
    expect(String(error)).not.toContain("private URL");
  });

  it("rejects redirects and private-address resolution through the existing safe HTTP boundary", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.example.test/private" },
      }),
    );
    await expect(
      fetchGitHubPlugin(SOURCE, {
        fetch: remote,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(PluginImportError);
    expect(remote).toHaveBeenCalledTimes(1);
    remote.mockClear();
    await expect(
      fetchGitHubPlugin(SOURCE, {
        fetch: remote,
        resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(PluginImportError);
    expect(remote).not.toHaveBeenCalled();
  });

  it("scopes acquisition and immutable identity to one plugin subdirectory", async () => {
    const folder = "plugins/one@two";
    const read = reader([
      { path: "outside", mode: "120000", type: "blob" },
      ...files.map((file) => ({
        path: `${folder}/${file.path}`,
        mode: "100644",
        type: "blob",
        size: Buffer.byteLength(file.content),
      })),
    ]);
    const parsed = await fetchGitHubPlugin(`https://github.com/example/plugin#${folder}`, { read });
    expect(parsed.source).toBe(`${SOURCE}/${folder}`);
    expect(parsed.skills[0]?.content).toBe(skill);
    expect(parsePluginSource(parsed.source).subdir).toBe(folder);
  });

  it("preserves UTF-8 BOM and CRLF bytes through the real bounded response decoder", async () => {
    const original = `\ufeff${skill.replaceAll("\n", "\r\n")}`;
    const remote = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob" })),
          }),
        );
      return new Response(
        url.endsWith("/SKILL.md")
          ? Buffer.from(original)
          : files.find((file) => url.endsWith(`/${file.path}`))!.content,
      );
    });
    const parsed = await fetchGitHubPlugin(SOURCE, {
      fetch: remote,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    expect(parsed.skills[0]?.content).toBe(original);
  });

  it("refuses invalid UTF-8 before importing any components", async () => {
    const remote = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([0xff, 0xfe])));
    await expect(
      fetchGitHubPlugin(SOURCE, {
        fetch: remote,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(PluginImportError);
    expect(remote).toHaveBeenCalledTimes(1);
  });
});

describe("bounded source and preview data", () => {
  it.each([
    "https://github.com/example/old/%2e%2e/plugin",
    "https://github.com/example/plugin/tree/main/first#second",
    "https://github.com/example/plugin#../escape",
    "https://user:fake-secret@github.com/example/plugin",
    "https://github.com/example/plugin?token=fake-secret",
    "https://gith\nub.com/example/plugin",
  ])("rejects ambiguous or credential-bearing source input", (source) => {
    expect(() => parsePluginSource(source)).toThrow(PluginImportError);
  });

  it("limits both aggregate content and UTF-8 bytes rather than UTF-16 length", () => {
    expect(() =>
      parsePluginDirectory({
        source: SOURCE,
        sourceSha: SHA,
        files: Array.from({ length: 41 }, (_, i) => ({
          path: `file-${i}`,
          content: "x".repeat(100000),
        })),
      }),
    ).toThrow(PluginImportError);
    const large = `${skill}${"😀".repeat(25000)}`;
    expect(() =>
      parsePluginDirectory({
        source: SOURCE,
        sourceSha: SHA,
        files: [files[0]!, { path: "skills/example/SKILL.md", content: large }],
      }),
    ).toThrow(PluginImportError);
    const good = toPluginPreview(parsePluginDirectory({ source: SOURCE, sourceSha: SHA, files }));
    expect(
      PluginPreviewSchema.safeParse({ ...good, skills: [{ ...good.skills[0], content: large }] })
        .success,
    ).toBe(false);
  });
});

describe("known credential echo refusal", () => {
  const credential = "fake+credential/token-123";
  const token = `Bearer ${credential}`;
  function sourceFiles(where: string, display = "Example") {
    const headers: Record<string, string> = { Authorization: token };
    let name = "remote";
    let endpoint = "https://tools.example.test/mcp";
    let content = skill;
    let description = display;
    if (where === "instructions") content += credential;
    if (where === "base64 instructions") content += Buffer.from(credential).toString("base64");
    if (where === "metadata") description = credential;
    if (where === "endpoint") endpoint += `/${credential}`;
    if (where === "encoded endpoint") endpoint += `?route=${encodeURIComponent(credential)}`;
    if (where === "server name") name = credential;
    if (where === "skipped server") {
      endpoint = "http://tools.example.test/mcp";
      content += credential;
    }
    return [
      {
        path: ".cursor-plugin/plugin.json",
        content: JSON.stringify({ name: "example-plugin", description }),
      },
      { path: "skills/example/SKILL.md", content },
      {
        path: ".mcp.json",
        content: JSON.stringify({
          mcpServers: { [name]: { type: "http", url: endpoint, headers } },
        }),
      },
    ];
  }
  it.each([
    "instructions",
    "base64 instructions",
    "metadata",
    "endpoint",
    "encoded endpoint",
    "server name",
    "skipped server",
  ])(
    "refuses known credential material in %s without altering the original instructions",
    (where) => {
      expect(() =>
        parsePluginDirectory({ files: sourceFiles(where), source: SOURCE, sourceSha: SHA }),
      ).toThrow(PluginImportError);
    },
  );
  it("treats short auth values as credentials too", () => {
    expect(() =>
      parsePluginDirectory({
        source: SOURCE,
        sourceSha: SHA,
        files: [
          files[0]!,
          { path: "skills/example/SKILL.md", content: `${skill}q9` },
          {
            path: ".mcp.json",
            content: JSON.stringify({
              mcpServers: {
                remote: {
                  type: "http",
                  url: "https://tools.example.test/mcp",
                  headers: { "X-Session": "q9" },
                },
              },
            }),
          },
        ],
      }),
    ).toThrow(PluginImportError);
  });
  it("permits noncredential routing and content-type values in ordinary documentation", () => {
    const parsed = parsePluginDirectory({
      source: SOURCE,
      sourceSha: SHA,
      files: [
        files[0]!,
        { path: "skills/example/SKILL.md", content: `${skill}application/json and tenant-group` },
        {
          path: ".mcp.json",
          content: JSON.stringify({
            mcpServers: {
              remote: {
                type: "http",
                url: "https://tools.example.test/mcp",
                headers: { "Content-Type": "application/json", "X-Tenant": "tenant-group" },
              },
            },
          }),
        },
      ],
    });
    expect(toPluginPreview(parsed).skills[0]?.content).toContain(
      "application/json and tenant-group",
    );
  });
});

describe("GitHub plugin preview", () => {
  it("preserves complete skill instructions while withholding header values", () => {
    const parsed = parsePluginDirectory({ files, sourceSha: SHA, source: SOURCE });
    const preview = toPluginPreview(parsed);
    expect(preview.skills[0]?.content).toBe(skill);
    expect(preview.mcpServers[0]?.headerKeys).toEqual(["X-Tenant"]);
    expect(JSON.stringify(preview)).not.toContain("fake-static-header");
    expect(parsed.mcpServers[0]?.headers).toEqual({ "X-Tenant": "fake-static-header" });
  });

  it("rejects non-public-GitHub sources before any acquisition", () => {
    expect(() => parsePluginSource("https://example.test/owner/plugin")).toThrow();
  });

  it("bounds installed components independently of the repository file count", () => {
    const servers = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [
        `server-${i}`,
        { type: "http", url: "https://tools.example.test/mcp" },
      ]),
    );
    expect(() =>
      parsePluginDirectory({
        source: SOURCE,
        sourceSha: SHA,
        files: [files[0]!, { path: ".mcp.json", content: JSON.stringify({ mcpServers: servers }) }],
      }),
    ).toThrow();
  });

  it("skips overlong header names and transport headers without exposing their values", () => {
    const parsed = parsePluginDirectory({
      source: SOURCE,
      sourceSha: SHA,
      files: [
        files[0]!,
        {
          path: ".mcp.json",
          content: JSON.stringify({
            mcpServers: {
              long: {
                type: "http",
                url: "https://tools.example.test/mcp",
                headers: { ["x".repeat(121)]: "fake-private-value" },
              },
              transport: {
                type: "http",
                url: "https://tools.example.test/mcp",
                headers: { Host: "fake-private-value" },
              },
            },
          }),
        },
      ],
    });
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toHaveLength(2);
    expect(JSON.stringify(toPluginPreview(parsed))).not.toContain("fake-private-value");
  });

  it("rejects oversized display metadata before returning a preview", () => {
    expect(() =>
      parsePluginDirectory({
        source: SOURCE,
        sourceSha: SHA,
        files: [
          {
            path: ".cursor-plugin/plugin.json",
            content: JSON.stringify({ name: "example-plugin", description: "x".repeat(4001) }),
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses an oversized skipped-field label instead of returning an invalid public DTO", () => {
    expect(() =>
      parsePluginDirectory({
        source: SOURCE,
        sourceSha: SHA,
        files: [
          {
            path: "plugin.json",
            content: JSON.stringify({
              $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
              name: "example-plugin",
              ["x".repeat(2049)]: true,
            }),
          },
        ],
      }),
    ).toThrow(PluginImportError);
  });
});

describe("portable format compatibility fixtures", () => {
  const SHA = "a".repeat(40);
  const schema = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
  const manifest = {
    $schema: schema,
    name: "example-plugin",
    version: "1.0.0",
    description: "Example",
  };
  const skill =
    "---\nname: example-skill\ndescription: Example skill\n---\n\nFollow these steps.\n";
  function files(
    mcpServers: Record<string, unknown> = {
      remote: { type: "streamable-http", url: "https://tools.example.test/mcp" },
    },
  ): PluginRepoFile[] {
    return [
      { path: "plugin.json", content: JSON.stringify(manifest) },
      { path: "skills/example-skill/SKILL.md", content: skill },
      {
        path: "mcp.json",
        content: JSON.stringify({
          $schema: schema.replace("plugin.schema", "mcp.schema"),
          mcpServers,
        }),
      },
    ];
  }
  const parse = (input = files()) =>
    parsePluginDirectory({
      files: input,
      sourceSha: SHA,
      source: `https://github.com/example/plugin/tree/${SHA}`,
    });

  describe("plugin sources", () => {
    it.each([
      ["https://github.com/example/plugins", { gitUrl: "https://github.com/example/plugins" }],
      ["https://github.com/Example/Plugins", { gitUrl: "https://github.com/example/plugins" }],
      [
        "https://github.com/example/plugins.git@feature/plugins#one",
        { gitUrl: "https://github.com/example/plugins", ref: "feature/plugins", subdir: "one" },
      ],
      [
        "https://github.com/example/plugins/tree/main/one",
        { gitUrl: "https://github.com/example/plugins", ref: "main", subdir: "one" },
      ],
    ])("normalizes %s", (source, expected) => expect(parsePluginSource(source)).toEqual(expected));
    it.each([
      "http://github.com/a/b",
      "https://user:password@github.com/a/b",
      "https://github.com/a/b?token=secret",
      "https://github.com/a/b#../escape",
      "https://github.com/a/b#dir\\file",
      "https://github.com/a/b#%2e%2e/escape",
      "https://github.com/a/b#one#two",
      "not a url",
      "https://github.com:444/a/b",
    ])("rejects unsafe source %s", (source) => expect(() => parsePluginSource(source)).toThrow());
  });

  describe("portable plugin parser", () => {
    it.each(["1.0.0", "1.1.0"])("loads Agent Plugins %s skills and remote MCP", (version) => {
      const entries = files().map((file) => ({
        ...file,
        content: file.content.replaceAll("1.1.0", version),
      }));
      const preview = parse(entries);
      expect(preview).toMatchObject({
        format: "agent-plugins",
        name: "example-plugin",
        sourceSha: SHA,
        source: `https://github.com/example/plugin/tree/${SHA}`,
      });
      expect(preview.skills).toEqual([
        { name: "example-skill", description: "Example skill", content: skill },
      ]);
      expect(preview.mcpServers).toEqual([
        {
          name: "remote",
          transport: "streamable_http",
          endpoint: "https://tools.example.test/mcp",
          headers: {},
        },
      ]);
    });
    it.each([
      [".cursor-plugin/plugin.json", "cursor"],
      [".grok-plugin/plugin.json", "grok"],
    ])("loads legacy %s and http alias", (path, format) => {
      const preview = parse([
        { path, content: JSON.stringify({ name: "example-plugin", skills: "./skills/" }) },
        {
          path: ".mcp.json",
          content: JSON.stringify({
            mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } },
          }),
        },
      ]);
      expect(preview.format).toBe(format);
      expect(preview.mcpServers[0]?.transport).toBe("streamable_http");
    });
    it("keeps loading valid components when siblings are invalid, local or editor-only", () => {
      const preview = parse([
        ...files({
          good: { type: "sse", url: "https://example.test/sse" },
          local: { type: "stdio", command: "sh", args: ["malicious.sh"] },
          invalid: { type: "sse", url: "https://user:password@example.test/" },
          unknown: { type: "other" },
        }),
        { path: "skills/bad/SKILL.md", content: "No frontmatter" },
        { path: "hooks/hook.sh", content: "do not run" },
      ]);
      expect(preview.skills).toHaveLength(1);
      expect(preview.mcpServers.map((s) => s.name)).toEqual(["good"]);
      expect(preview.skipped.map((s) => s.kind)).toEqual(
        expect.arrayContaining([
          "mcp_stdio",
          "mcp_invalid",
          "unsupported_transport",
          "skill_invalid",
          "editor_only",
        ]),
      );
    });
    it("rejects unknown manifest versions/invalid metadata; reports unknown fields", () => {
      expect(() =>
        parse([{ path: "plugin.json", content: JSON.stringify({ name: "example" }) }]),
      ).toThrow(PluginImportError);
      expect(() =>
        parse([
          { path: "plugin.json", content: JSON.stringify({ ...manifest, name: "Bad Name" }) },
        ]),
      ).toThrow(PluginImportError);
      const result = parse([
        { path: "plugin.json", content: JSON.stringify({ ...manifest, custom: true }) },
      ]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: "unsupported_field", name: "custom" }),
      );
    });
    it("disables only MCP on schema mismatch or unknown top-level fields", () => {
      for (const config of [
        { $schema: "unknown", mcpServers: {} },
        { $schema: schema.replace("plugin.schema", "mcp.schema"), mcpServers: {}, extra: true },
      ]) {
        const preview = parse(
          files().map((f) =>
            f.path === "mcp.json" ? { ...f, content: JSON.stringify(config) } : f,
          ),
        );
        expect(preview.skills).toHaveLength(1);
        expect(preview.mcpServers).toEqual([]);
        expect(preview.skipped[0]?.kind).toBe("mcp_invalid");
      }
    });
    it("does not recursively discover skills or silently lose companion resources", () => {
      const preview = parse([
        ...files(),
        { path: "skills/nested/deeper/SKILL.md", content: skill },
        { path: "skills/example-skill/references/guide.md", content: "guide" },
      ]);
      expect(preview.skills).toEqual([]);
      expect(preview.skipped[0]?.reason).toMatch(/companion files/);
    });
    it.each(["../plugin.json", "/plugin.json", "skills/../plugin.json", "dir\\plugin.json"])(
      "rejects escaping path %s",
      (path) => {
        expect(() => parse([{ path, content: "{}" }])).toThrow(PluginImportError);
      },
    );
    it("bounds file count and file size, rejects duplicate paths/names", () => {
      expect(() =>
        parse(Array.from({ length: 201 }, (_, i) => ({ path: `${i}`, content: "" }))),
      ).toThrow(PluginImportError);
      expect(() => parse([{ path: "plugin.json", content: "a".repeat(100_001) }])).toThrow(
        PluginImportError,
      );
      expect(() => parse([...files(), files()[0]!])).toThrow(PluginImportError);
      expect(() => parse([...files(), { path: "skills/second/SKILL.md", content: skill }])).toThrow(
        PluginImportError,
      );
    });
    it("digests all manifest and component content independent of listing order", () => {
      const original = parse();
      expect(parse(files().reverse()).digest).toBe(original.digest);
      expect(parse(files().map((f) => ({ ...f, content: `${f.content}\n` }))).digest).not.toBe(
        original.digest,
      );
    });
    it("shows reviewed instructions but hides header values in public previews", () => {
      const preview = parse(
        files({
          remote: {
            type: "streamable-http",
            url: "https://example.test/mcp",
            headers: { "X-Tenant": "package-tenant" },
          },
        }),
      );
      const dto = toPluginPreview(preview);
      expect(JSON.stringify(dto)).not.toContain("package-tenant");
      expect(JSON.stringify(dto)).toContain("Follow these steps");
      expect(dto.mcpServers[0]?.headerKeys).toEqual(["X-Tenant"]);
    });
    it.each([
      { type: "sse", url: "https://example.test/mcp?api_key=fake-secret" },
      { type: "sse", url: "https://example.test/mcp", headers: { "X-Test": "injected\r\nheader" } },
      {
        type: "sse",
        url: "https://example.test/mcp",
        headers: { "X-Test": "one", "x-test": "two" },
      },
    ])("rejects unsafe queries or headers %j", (server) => {
      expect(parse(files({ remote: server })).mcpServers).toEqual([]);
    });

    it("skips unresolved legacy credential placeholders rather than leaking/substituting", () => {
      expect(
        parse(
          files({
            remote: {
              type: "sse",
              url: "https://example.test/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal untrusted plugin placeholder fixture
              headers: { Authorization: "Bearer ${TOKEN}" },
            },
          }),
        ).mcpServers,
      ).toEqual([]);
    });
  });
});
