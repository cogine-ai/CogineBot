import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { appendMemoryFact, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("shell"),
];

describe("appendMemoryFact", () => {
  it.each([
    ["", "first fact", "first fact\n"],
    ["old fact", "new fact", "old fact\nnew fact\n"],
    ["old fact\n", "new fact", "old fact\nnew fact\n"],
    ["old fact  \n\n", "  new fact \n", "old fact  \n\nnew fact\n"],
    ["  old fact\r\n", "new fact\r\nsecond line", "  old fact\r\nnew fact\r\nsecond line\n"],
    ["old fact", "", "old fact"],
    ["old fact\n", " \r\n\t ", "old fact\n"],
    ["", " \n", ""],
    ["same fact", "same fact", "same fact"],
    ["same fact\nother fact\n", "same fact", "same fact\nother fact\n"],
    ["first\nsame fact\nlast\n", "same fact", "first\nsame fact\nlast\n"],
    ["first\nsame fact  \n\n", "same fact", "first\nsame fact  \n\n"],
    ["first\n  same fact  \nlast", " same fact ", "first\n  same fact  \nlast"],
    ["alpha\nbeta\ngamma\n", "alpha\nbeta", "alpha\nbeta\ngamma\n"],
    ["first\nalpha\nbeta\nlast", "alpha\nbeta", "first\nalpha\nbeta\nlast"],
    ["first\nalpha\nbeta\n\n", "alpha\nbeta", "first\nalpha\nbeta\n\n"],
    ["first\r\nalpha\r\nbeta\r\n", "alpha\nbeta", "first\r\nalpha\r\nbeta\r\n"],
    ["alpha\nbeta\n", "alpha\r\nbeta", "alpha\nbeta\n"],
    ["prefix fact suffix\n", "fact", "prefix fact suffix\nfact\n"],
    ["alpha\nother\nbeta\n", "alpha\nbeta", "alpha\nother\nbeta\nalpha\nbeta\n"],
    ["alpha\n beta\n", "alpha\nbeta", "alpha\n beta\nalpha\nbeta\n"],
    ["Alpha\n", "alpha", "Alpha\nalpha\n"],
  ])("preserves existing bytes for %j + %j", (existing, fact, expected) => {
    expect(appendMemoryFact(existing!, fact!)).toBe(expected);
  });
});

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "forget_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});
