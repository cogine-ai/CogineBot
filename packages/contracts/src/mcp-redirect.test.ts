import { expect, it } from "vitest";
import { isMcpOAuthRedirectAllowed, MCP_NATIVE_REDIRECT_URI } from "./mcp.js";

it("permits only the exact native callback and configured web callback", () => {
  const origin = "https://app.example.test";
  expect(isMcpOAuthRedirectAllowed(MCP_NATIVE_REDIRECT_URI, origin)).toBe(true);
  expect(isMcpOAuthRedirectAllowed(`${origin}/mcp/oauth/callback`, origin)).toBe(true);
  for (const value of [
    "coginebot://mcp",
    "coginebot:///mcp?next=evil",
    "coginebot:///mcp#fragment",
    "other:///mcp",
    "https://evil.example.test/mcp/oauth/callback",
    `${origin}/mcp/oauth/callback/`,
  ])
    expect(isMcpOAuthRedirectAllowed(value, origin)).toBe(false);
});
