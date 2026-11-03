import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { catalogExecuteToolName } from "./approval-effect.js";
import {
  isVerbatimMcpResult,
  toolCallIdentity,
  verbatimMcpToolResultIndexes,
} from "./verbatim-mcp-result.js";

const servers = { ids: ["server-1"], slugs: ["research__notes"] };

describe("whole MCP result identities", () => {
  it.each([
    "server-1:search",
    "research__notes:search",
    "RESEARCH__NOTES/search",
    "research__notes__search",
    "mcp__research__notes__search",
    "  server-1:search  ",
  ])("recognizes an existing catalog identity: %s", (id) => {
    expect(isVerbatimMcpResult(catalogExecuteToolName("mcp"), { id }, servers)).toBe(true);
  });

  it("matches a direct name without mistaking an overlapping slug for the selected server", () => {
    expect(isVerbatimMcpResult("mcp__research__notes__search", {}, servers)).toBe(true);
    expect(isVerbatimMcpResult("mcp__research__notes_extra__search", {}, servers)).toBe(false);
  });

  it.each([
    undefined,
    null,
    {},
    { id: 7 },
    { id: "server-10:search" },
    { id: "other:search", verbatim: true },
  ])("ignores unmatched or model-supplied preservation flags: %j", (args) => {
    expect(isVerbatimMcpResult(catalogExecuteToolName("mcp"), args, servers)).toBe(false);
  });

  it("requires trusted server selection and the real catalog tool", () => {
    const args = { id: "server-1:search", verbatim: true };
    expect(isVerbatimMcpResult(catalogExecuteToolName("mcp"), args, undefined)).toBe(false);
    expect(isVerbatimMcpResult("unrelated_execute_tool", args, servers)).toBe(false);
    expect(isVerbatimMcpResult(undefined, args, servers)).toBe(false);
  });

  it("uses actual call identity and retains the arguments for catalog matching", () => {
    const arguments_ = { id: "server-1:search" };
    expect(toolCallIdentity({ name: "actual", arguments: arguments_ }, "fallback")).toEqual({
      name: "actual",
      arguments: arguments_,
    });
    expect(toolCallIdentity(null, "fallback")).toEqual({ name: "fallback" });
  });
  it("binds catalog preservation to its own call occurrence when an ID is reused", () => {
    const call = (id: string) =>
      fauxAssistantMessage([
        { type: "toolCall", id: "reused", name: catalogExecuteToolName("mcp"), arguments: { id } },
      ]);
    const result = {
      role: "toolResult",
      toolCallId: "reused",
      toolName: "mcp__research__notes__search",
      content: [{ type: "text", text: "same result" }],
      details: { verbatim: true },
      isError: false,
      timestamp: 1,
    } as Message;
    const messages = [call("server-1:search"), result, call("other:search"), { ...result }];
    expect([...verbatimMcpToolResultIndexes(messages, servers)]).toEqual([1]);
    expect([...verbatimMcpToolResultIndexes(messages, undefined)]).toEqual([]);
    const inverse = [call("other:search"), result, call("server-1:search"), { ...result }];
    expect([...verbatimMcpToolResultIndexes(inverse, servers)]).toEqual([3]);
  });
});
