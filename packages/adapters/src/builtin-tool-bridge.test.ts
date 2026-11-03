import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  CORE_BUILTIN_TOOL_NAMES,
  FIND_TOOL,
  findTools,
  isDeferredTool,
  partitionTools,
  USE_TOOL,
} from "./builtin-tool-bridge.js";
import { agentConnectionTools, BUILTIN_AGENT_TOOL_NAMES } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";
import { lazyCatalogTools, parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { describeToolActivity } from "./pi-runtime.js";

const ownerOptions = {
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  historyRetrievalEnabled: true,
  messagingChannelRun: false,
};
const ownerChat = selectBuiltinToolsForRun(ownerOptions);

const definitionBytes = (tools: readonly ConnectorTool[]) =>
  Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );

describe("built-in tool bridge", () => {
  it("lists a pinned smaller tool set on an owner chat run", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "ask_user",
      "attach_file",
      "find_tool",
      "list_files",
      "message_user",
      "read_file",
      "read_history",
      "remember",
      "request_secret",
      "request_takeover",
      "run_subagent",
      "schedule_create",
      "schedule_list",
      "search_history",
      "shell",
      "skill_read",
      "update_bot",
      "use_tool",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    expect(definitionBytes(listed)).toBeLessThanOrEqual(30_550);
    expect(definitionBytes(listed)).toBeLessThan(definitionBytes(ownerChat));
    expect(deferred.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["render_plot", "create_space", "list_secrets", "scratchpad_add"]),
    );
  });

  it("lists only core tools the run actually offered", () => {
    const shell = ownerChat.find((tool) => tool.name === "shell")!;
    const chart = ownerChat.find((tool) => tool.name === "render_plot")!;
    expect(partitionTools([shell, chart]).listed.map((tool) => tool.name)).toEqual([
      "shell",
      FIND_TOOL,
      USE_TOOL,
    ]);
    const offered = new Set(ownerChat.map((tool) => tool.name));
    for (const tool of partitionTools(ownerChat).listed) {
      if (tool.name !== FIND_TOOL && tool.name !== USE_TOOL)
        expect(offered.has(tool.name)).toBe(true);
    }
    expect(offered.has("connect_app")).toBe(false);
    expect(partitionTools(ownerChat).listed.some((tool) => tool.name === "connect_app")).toBe(
      false,
    );
  });

  it("classifies only real built-ins and includes separately registered connection tools", () => {
    expect(isDeferredTool("scratchpad_add")).toBe(true);
    expect(isDeferredTool("scratchpad_unknown")).toBe(false);
    expect(isDeferredTool("mcp__memory__save")).toBe(false);
    expect(isDeferredTool("shell")).toBe(false);
    for (const tool of agentConnectionTools) {
      expect(BUILTIN_AGENT_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(isDeferredTool(tool.name)).toBe(true);
    }
    expect(partitionTools(agentConnectionTools).deferred).toEqual(agentConnectionTools);
  });

  it("lists every tool when none is deferred and adds no empty bridge", () => {
    const core = ownerChat.filter((tool) => CORE_BUILTIN_TOOL_NAMES.has(tool.name));
    expect(partitionTools(core)).toEqual({ listed: core, deferred: [] });
    expect(partitionTools([])).toEqual({ listed: [], deferred: [] });
    const external = lazyCatalogTools("connectors", "mcp", "MCP");
    expect(partitionTools(external)).toEqual({ listed: external, deferred: [] });
  });

  it("names deferred tools by area in find_tool without schemas", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
    for (const tool of deferred) expect(description).toContain(tool.name);
    expect(description).toContain("secrets:\n");
    expect(description).not.toContain("inputSchema");
    expect(listed.some((tool) => tool.name === USE_TOOL)).toBe(true);
  });

  it("finds exact names and ranks a query over names, descriptions and parameters", () => {
    const { deferred } = partitionTools(ownerChat);
    const plot = findTools(deferred, { names: ["render_plot", "shell", "nope"] });
    expect(plot.tools.map((tool) => tool.name)).toEqual(["render_plot"]);
    expect(plot.tools[0]).toEqual(
      expect.objectContaining({
        name: "render_plot",
        inputSchema: deferred.find((tool) => tool.name === "render_plot")!.inputSchema,
      }),
    );
    expect(plot.unknown).toEqual(["shell", "nope"]);

    const names = (query: string) => findTools(deferred, { query }).tools.map((tool) => tool.name);
    expect(names("chart")).toContain("render_plot");
    expect(names("new space")[0]).toBe("create_space");
    expect(names("saved credential names")[0]).toBe("list_secrets");
    expect(names("scratchpad add")[0]).toBe("scratchpad_add");
    expect(names("scratchpad")).toHaveLength(3);
    expect(findTools(deferred, { query: "zzzz" })).toEqual({
      tools: [],
      hint: expect.any(String),
    });
    expect(findTools(deferred, {})).toEqual({ tools: [], hint: expect.any(String) });
  });

  it("indexes parameter names but returns the original schema and description", () => {
    const tool: ConnectorTool = {
      name: "scratchpad_add",
      description: "Keep work",
      inputSchema: {
        type: "object",
        properties: { unique_payload: { type: "string", description: "Exact content" } },
        required: ["unique_payload"],
      },
    };
    const result = findTools(partitionTools([tool]).deferred, { query: "unique payload" });
    expect(result).toEqual({ tools: [tool] });
    expect(result.tools[0]!.inputSchema).toBe(tool.inputSchema);
  });

  it("keeps matches and index order stable across offered registration order", () => {
    const first = partitionTools(ownerChat);
    const second = partitionTools([...ownerChat].reverse());
    expect(findTools(first.deferred, { query: "scratchpad" })).toEqual(
      findTools(second.deferred, { query: "scratchpad" }),
    );
    expect(first.listed.find((tool) => tool.name === FIND_TOOL)).toEqual(
      second.listed.find((tool) => tool.name === FIND_TOOL),
    );
  });

  it("declares and validates discovery input limits", () => {
    const tool = partitionTools(ownerChat).listed.find((entry) => entry.name === FIND_TOOL)!;
    expect(tool.inputSchema.properties).toEqual({
      names: { type: "array", items: { type: "string" }, maxItems: 5 },
      query: { type: "string", maxLength: 200, description: "Words describing the task" },
    });
    const names = Array.from({ length: 5 }, () => "render_plot");
    expect(parseConnectorToolArgs(tool.inputSchema, { names, query: "x".repeat(200) })).toEqual({
      names,
      query: "x".repeat(200),
    });
    expect(() =>
      parseConnectorToolArgs(tool.inputSchema, { names: [...names, "extra"] }),
    ).toThrow();
    expect(() => parseConnectorToolArgs(tool.inputSchema, { query: "x".repeat(201) })).toThrow();
  });

  it("keeps external catalog tools listed and out of built-in discovery", () => {
    const external = lazyCatalogTools("connectors", "mcp", "MCP");
    const { listed, deferred } = partitionTools([...ownerChat, ...external]);
    for (const tool of external) expect(listed).toContain(tool);
    expect(findTools(deferred, { names: external.map((tool) => tool.name) })).toEqual({
      tools: [],
      unknown: external.map((tool) => tool.name),
      hint: expect.any(String),
    });
  });

  it("never finds a tool the bot turned off", () => {
    const { listed, deferred } = partitionTools(
      selectBuiltinToolsForRun({ ...ownerOptions, disabledBuiltinTools: ["render_plot"] }),
    );
    expect(findTools(deferred, { names: ["render_plot"] })).toEqual({
      tools: [],
      unknown: ["render_plot"],
      hint: expect.any(String),
    });
    expect(listed.find((tool) => tool.name === FIND_TOOL)!.description).not.toContain(
      "render_plot",
    );
  });

  it("keeps current group, background and memory selection in the offered set", () => {
    const offered = selectBuiltinToolsForRun({
      ...ownerOptions,
      groupId: "group-test",
      trigger: "routine",
      messagingChannelRun: true,
    });
    const { listed, deferred } = partitionTools(offered);
    const absent = ["message_bot", "schedule_create", "scratchpad_add", "remember"];
    expect(listed.some((tool) => tool.name === "message_user")).toBe(true);
    for (const name of absent) {
      expect(listed.some((tool) => tool.name === name)).toBe(false);
      expect(findTools(deferred, { names: [name] }).tools).toEqual([]);
    }
  });

  it("leaves the listed schemas unchanged after discovery", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    const before = JSON.stringify(listed);
    findTools(deferred, { names: ["render_plot"] });
    findTools(deferred, { query: "scratchpad" });
    expect(JSON.stringify(listed)).toBe(before);
  });

  it("shows the real tool as activity", () => {
    expect(
      describeToolActivity(USE_TOOL, { name: "create_space", arguments: { name: "Finance" } }),
    ).toBe("Creating space: Finance");
  });
});
