import { describe, expect, it } from "vitest";
import { McpServerConfigInput, McpServerSchema } from "./domain.js";

describe("MCP whole-result preference contract", () => {
  it.each([
    { transport: "streamable_http", endpoint: "https://mcp.example.test/mcp" },
    { transport: "sse", endpoint: "https://mcp.example.test/sse" },
    { transport: "stdio", command: "fixture-mcp" },
  ])("keeps omission distinct from explicit false for $transport", (transport) => {
    const input = { slug: "fixture", name: "Fixture", ...transport };
    expect(McpServerConfigInput.parse(input).verbatimResults).toBeUndefined();
    for (const verbatimResults of [true, false])
      expect(McpServerConfigInput.parse({ ...input, verbatimResults }).verbatimResults).toBe(
        verbatimResults,
      );
    expect(McpServerConfigInput.safeParse({ ...input, verbatimResults: "true" }).success).toBe(
      false,
    );
  });

  it("reads older server DTOs as disabled without granting any tool access", () => {
    const server = McpServerSchema.parse({
      id: "server",
      spaceId: "space",
      slug: "fixture",
      name: "Fixture",
      description: "",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/mcp",
      command: null,
      args: [],
      envKeys: [],
      headerKeys: [],
      hasSecret: false,
      oauthStatus: "none",
      enabled: true,
      allowAllTools: false,
      allowedTools: [],
      revision: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    expect(server.verbatimResults).toBe(false);
    expect(server.allowAllTools).toBe(false);
    expect(server.allowedTools).toEqual([]);
  });
});
