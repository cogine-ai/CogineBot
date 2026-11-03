import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConnectorRoute, ConnectorTool } from "@rakazo/adapter-kit";
import { McpServerConfigInput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { catalogExecuteToolName } from "./approval-effect.js";
import { catalogEntries, loadCatalogEntry } from "./lazy-tool-catalog.js";
import {
  copyMcpToolResultRoute,
  isVerbatimMcpResult,
  markMcpToolResultRoute,
  mcpToolResultRoute,
  toolCallIdentity,
  verbatimMcpToolResultIndexes,
} from "./verbatim-mcp-result.js";

type ToolResult = Extract<Message, { role: "toolResult" }>;
function mcpTool(
  resourceId: string,
  slug: string,
  toolName = "search",
): ConnectorTool & { route: ConnectorRoute } {
  return {
    name: `mcp__${slug}__${toolName}`,
    description: "Read synthetic records",
    inputSchema: { type: "object", properties: {} },
    route: { connectorId: "mcp", resourceId, catalogGroup: slug, toolName },
  };
}
const research = mcpTool("server-research", "research");
const notes = mcpTool("server-notes", "research__notes");
const selectedResearch = { ids: ["server-research"], slugs: ["research"] };
const entries = catalogEntries([
  research,
  notes,
  mcpTool("server-research", "research", "search__all"),
  mcpTool("server-notes", "research__notes", "search__all"),
]);
function call(id: string, callId = "reused") {
  return fauxAssistantMessage([
    {
      type: "toolCall",
      id: callId,
      name: catalogExecuteToolName("mcp"),
      arguments: { id, arguments: {} },
    },
  ]);
}
function result(route: ConnectorRoute | undefined, callId = "reused"): ToolResult {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: research.name,
    content: markMcpToolResultRoute(
      [{ type: "text" as const, text: "same synthetic result" }],
      route,
    ),
    details: {
      verbatim: true,
      connectorId: "mcp",
      resourceId: "server-research",
      catalogGroup: "research",
    },
    isError: false,
    timestamp: 1,
  };
}

describe("whole MCP result identities", () => {
  it("retires the destination identity when copying an unowned content array", () => {
    const target = markMcpToolResultRoute([{ type: "text", text: "synthetic" }], research.route);
    copyMcpToolResultRoute([], target);
    expect(mcpToolResultRoute(target)).toBeUndefined();
  });
  it.each(entries)("uses the resolved route for direct and qualified $id", (entry) => {
    const route = entry.tool.route!;
    const slug = route.catalogGroup!;
    const other = route.resourceId === research.route.resourceId ? notes : research;
    const aliases = [
      entry.id,
      `${slug}:${route.toolName}`,
      `  ${slug.toUpperCase()}/${route.toolName}  `,
      `${slug}__${route.toolName}`,
      entry.tool.name,
    ];
    for (const selection of [
      { ids: [route.resourceId!], slugs: [] },
      { ids: [], slugs: [slug] },
    ]) {
      expect(isVerbatimMcpResult(route, selection)).toBe(true);
      expect(isVerbatimMcpResult(other.route, selection)).toBe(false);
      for (const id of aliases) {
        const resolved = loadCatalogEntry(entries, { id });
        expect(resolved.tool).toBe(entry.tool);
        expect(resolved.tool.route).toEqual(route);
        expect(isVerbatimMcpResult(resolved.tool.route, selection)).toBe(true);
        expect(
          isVerbatimMcpResult(resolved.tool.route, {
            ids: [other.route.resourceId!],
            slugs: [other.route.catalogGroup!],
          }),
        ).toBe(false);
      }
    }
  });

  it("does not guess between a nested slug and a tool name containing double underscores", () => {
    const delimiterTool = mcpTool("server-research", "research", "notes__search");
    const overlapping = catalogEntries([notes, delimiterTool]);
    expect(notes.name).toBe(delimiterTool.name);
    for (const id of ["research__notes__search", "mcp__research__notes__search"]) {
      expect(() => loadCatalogEntry(overlapping, { id })).toThrow(/ambiguous/i);
    }
    for (const id of ["server-research:notes__search", "research:notes__search"]) {
      const resolved = loadCatalogEntry(overlapping, { id });
      expect(resolved.tool).toBe(delimiterTool);
      expect(isVerbatimMcpResult(resolved.tool.route, selectedResearch)).toBe(true);
    }
    for (const id of ["server-notes:search", "research__notes:search"]) {
      const resolved = loadCatalogEntry(overlapping, { id });
      expect(resolved.tool).toBe(notes);
      expect(isVerbatimMcpResult(resolved.tool.route, selectedResearch)).toBe(false);
    }
  });

  it("honors a canonical server ID before an overlapping legal selected slug alias", () => {
    const selectedId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    expect(
      McpServerConfigInput.safeParse({
        transport: "streamable_http",
        name: "Synthetic collision fixture",
        slug: otherId,
        endpoint: "https://mcp.example.test/api",
      }).success,
    ).toBe(true);
    const selected = mcpTool(selectedId, otherId);
    const unselected = mcpTool(otherId, "research__notes");
    const collision = catalogEntries([selected, unselected]);
    const servers = { ids: [selectedId], slugs: [otherId] };
    const canonical = loadCatalogEntry(collision, { id: `${otherId}:search` });
    expect(canonical.tool).toBe(unselected);
    expect(isVerbatimMcpResult(canonical.tool.route, servers)).toBe(false);
    expect(isVerbatimMcpResult(canonical.tool.route, { ids: [otherId], slugs: [] })).toBe(true);
    for (const id of [
      `${selectedId}:search`,
      `${otherId}/search`,
      `${otherId}__search`,
      selected.name,
    ]) {
      const resolved = loadCatalogEntry(collision, { id });
      expect(resolved.tool).toBe(selected);
      expect(isVerbatimMcpResult(resolved.tool.route, servers)).toBe(true);
    }
  });

  it("does not let names, arguments or result details override a known unselected route", () => {
    const negative = result(
      loadCatalogEntry(entries, { id: "research__notes__search" }).tool.route,
    );
    const misleading = call("server-research:search");
    expect(negative.toolName).toBe(research.name);
    expect(negative.details).toMatchObject({ verbatim: true, resourceId: "server-research" });
    expect([...verbatimMcpToolResultIndexes([misleading, negative], selectedResearch)]).toEqual([]);
    expect([
      ...verbatimMcpToolResultIndexes([misleading, negative], {
        ids: ["server-notes"],
        slugs: ["research__notes"],
      }),
    ]).toEqual([1]);
  });

  it("fails bounded when route metadata is missing despite preservation claims", () => {
    const unbound = result(undefined);
    expect(mcpToolResultRoute(unbound.content)).toBeUndefined();
    expect(isVerbatimMcpResult(undefined, selectedResearch)).toBe(false);
    expect([
      ...verbatimMcpToolResultIndexes([call("server-research:search"), unbound], selectedResearch),
    ]).toEqual([]);
  });

  it.each([
    {
      connectorId: "native",
      resourceId: "server-research",
      catalogGroup: "research",
      toolName: "search",
    },
    {
      connectorId: "pipedream",
      resourceId: "server-research",
      catalogGroup: "research",
      toolName: "search",
    },
    { connectorId: "mcp", catalogGroup: "research", toolName: "__catalog_execute" },
  ])("does not preserve a non-MCP or unresolved $connectorId/$toolName route", (route) => {
    expect(isVerbatimMcpResult(route, selectedResearch)).toBe(false);
    expect([
      ...verbatimMcpToolResultIndexes(
        [call("server-research:search"), result(route)],
        selectedResearch,
      ),
    ]).toEqual([]);
  });

  it("requires trusted selection even for a bound MCP result", () => {
    expect(isVerbatimMcpResult(research.route, undefined)).toBe(false);
    expect(isVerbatimMcpResult(research.route, { ids: [], slugs: [] })).toBe(false);
    expect(
      isVerbatimMcpResult(research.route, {
        ids: ["server-research-extra"],
        slugs: ["research-extra"],
      }),
    ).toBe(false);
  });

  it("stores a private route snapshot without serializable result fields", () => {
    const route = { ...research.route };
    const content = [{ type: "text", text: "synthetic evidence" }];
    const before = JSON.stringify(content);
    expect(markMcpToolResultRoute(content, route)).toBe(content);
    expect(mcpToolResultRoute(content)).toEqual(research.route);
    expect(mcpToolResultRoute(content)).not.toBe(route);
    route.resourceId = "server-notes";
    route.catalogGroup = "research__notes";
    expect(isVerbatimMcpResult(mcpToolResultRoute(content), selectedResearch)).toBe(true);
    expect(JSON.stringify(content)).toBe(before);
    expect(Object.getOwnPropertySymbols(content)).toEqual([]);
    expect(mcpToolResultRoute({ content })).toBeUndefined();
  });

  it("copies identity onto a labeled view without requiring history-reference metadata", () => {
    const original = markMcpToolResultRoute([{ type: "text", text: "original" }], research.route);
    const view = [{ type: "text", text: "Automated tool output: original" }];
    expect(mcpToolResultRoute(view)).toBeUndefined();
    expect(copyMcpToolResultRoute(original, view)).toBe(view);
    expect(mcpToolResultRoute(view)).toEqual(research.route);
    expect(isVerbatimMcpResult(mcpToolResultRoute(view), selectedResearch)).toBe(true);
    expect(mcpToolResultRoute(structuredClone(original))).toBeUndefined();
    const unboundView = [{ type: "text", text: "selected server-research claims" }];
    copyMcpToolResultRoute({ resourceId: "server-research", verbatim: true }, unboundView);
    expect(mcpToolResultRoute(unboundView)).toBeUndefined();
  });

  it("retires an old copied identity when the executor resolves no route", () => {
    const source = markMcpToolResultRoute([{ type: "text", text: "original" }], research.route);
    const view = copyMcpToolResultRoute(source, [{ type: "text", text: "next execution" }]);
    expect(isVerbatimMcpResult(mcpToolResultRoute(view), selectedResearch)).toBe(true);
    expect(markMcpToolResultRoute(view, undefined)).toBe(view);
    expect(mcpToolResultRoute(view)).toBeUndefined();
    expect(isVerbatimMcpResult(mcpToolResultRoute(view), selectedResearch)).toBe(false);
  });

  it("uses actual call identity without turning names or arguments into metadata", () => {
    const arguments_ = { id: "server-research:search", verbatim: true };
    expect(toolCallIdentity({ name: "actual", arguments: arguments_ }, "fallback")).toEqual({
      name: "actual",
      arguments: arguments_,
    });
    expect(toolCallIdentity(null, "fallback")).toEqual({ name: "fallback" });
    expect(isVerbatimMcpResult(mcpToolResultRoute(arguments_), selectedResearch)).toBe(false);
  });

  it("binds preservation to its own occurrence when a call ID and result text are reused", () => {
    const positive = result(loadCatalogEntry(entries, { id: "server-research:search" }).tool.route);
    const negative = result(loadCatalogEntry(entries, { id: "server-notes:search" }).tool.route);
    expect([
      ...verbatimMcpToolResultIndexes(
        [call("server-research:search"), positive, call("server-notes:search"), negative],
        selectedResearch,
      ),
    ]).toEqual([1]);
    expect([
      ...verbatimMcpToolResultIndexes([call("server-research:search"), positive], undefined),
    ]).toEqual([]);
    expect([
      ...verbatimMcpToolResultIndexes(
        [call("server-notes:search"), negative, call("server-research:search"), positive],
        selectedResearch,
      ),
    ]).toEqual([3]);
  });

  it("keeps fresh executions separate when a provider reuses one content array", () => {
    const shared = [{ type: "text" as const, text: "same shared result" }];
    const selected = result(undefined);
    selected.content = markMcpToolResultRoute(
      shared.map((part) => ({ ...part })),
      research.route,
    );
    const unselected = result(undefined);
    unselected.content = markMcpToolResultRoute(
      shared.map((part) => ({ ...part })),
      notes.route,
    );
    const missing = result(undefined);
    missing.content = shared.map((part) => ({ ...part }));
    expect(mcpToolResultRoute(shared)).toBeUndefined();
    expect(mcpToolResultRoute(missing.content)).toBeUndefined();
    expect([
      ...verbatimMcpToolResultIndexes(
        [call("selected"), selected, call("selected"), unselected, call("selected"), missing],
        selectedResearch,
      ),
    ]).toEqual([1]);
  });

  it("requires an actual matching call in the current assistant occurrence", () => {
    const bound = result(research.route);
    expect([...verbatimMcpToolResultIndexes([bound], selectedResearch)]).toEqual([]);
    expect([
      ...verbatimMcpToolResultIndexes(
        [call("server-research:search", "other-id"), bound],
        selectedResearch,
      ),
    ]).toEqual([]);
    expect([
      ...verbatimMcpToolResultIndexes(
        [
          call("server-research:search"),
          { role: "user", content: "Later user message", timestamp: 2 },
          bound,
        ],
        selectedResearch,
      ),
    ]).toEqual([]);
    expect([
      ...verbatimMcpToolResultIndexes(
        [
          call("server-research:search"),
          fauxAssistantMessage([{ type: "text", text: "Next turn" }]),
          bound,
        ],
        selectedResearch,
      ),
    ]).toEqual([]);
  });

  it("matches out-of-order results without borrowing another call's route", () => {
    const assistant = fauxAssistantMessage([
      { type: "toolCall", id: "positive", name: research.name, arguments: {} },
      { type: "toolCall", id: "negative", name: research.name, arguments: {} },
    ]);
    expect([
      ...verbatimMcpToolResultIndexes(
        [assistant, result(notes.route, "negative"), result(research.route, "positive")],
        selectedResearch,
      ),
    ]).toEqual([2]);
  });
});
