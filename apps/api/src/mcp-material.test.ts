import { describe, expect, it } from "vitest";
import {
  buildMcpConnectionMaterial,
  buildMcpUpdateMaterial,
  parseMcpConnectionMaterial,
} from "./mcp-material.js";

describe("MCP connection header patches", () => {
  const material = {
    secret: "fixture-secret",
    env: { KEEP: "fixture-env" },
    headers: { Authorization: "old", "X-Static": "preserved" },
    oauth: { tokens: { access_token: "fixture-token" } },
  };

  it.each([undefined, {}])("keeps the exact credential for an empty patch (%s)", (patch) => {
    expect(buildMcpConnectionMaterial(material, patch)).toEqual({ action: "keep" });
  });

  it("merges case-insensitively without losing other encrypted material or mutating it", () => {
    expect(buildMcpConnectionMaterial(material, { authorization: "new", "X-Key": "key" })).toEqual({
      action: "store",
      material: {
        ...material,
        headers: { authorization: "new", "X-Static": "preserved", "X-Key": "key" },
      },
    });
    expect(material.headers.Authorization).toBe("old");
  });

  it("validates the merged count, including existing headers", () => {
    const headers = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`X-${i}`, "v"]));
    expect(() => buildMcpConnectionMaterial({ headers }, { "X-Next": "v" })).toThrow();
    expect(buildMcpConnectionMaterial({ headers }, { "x-0": "replacement" })).toMatchObject({
      action: "store",
      material: { headers: { "x-0": "replacement" } },
    });
  });

  it.each([
    { Host: "other.example.test" },
    { "Proxy-Authorization": "fixture" },
    { Authorization: "a", authorization: "b" },
    { "X-Key": "fixture\r\ninjected: value" },
    { "X-Key": "x".repeat(4097) },
  ])("rejects unsafe or ambiguous header updates", (headers) => {
    expect(() => buildMcpConnectionMaterial(material, headers)).toThrow();
  });

  it.each(["not json", "null", "[]", '{"headers":{"X-Key":false}}', '{"oauth":false}'])(
    "refuses malformed stored material before writing a patch (%s)",
    (value) => expect(() => parseMcpConnectionMaterial(value)).toThrow(),
  );

  it("preserves provider-neutral OAuth and unrecognized stored metadata", () => {
    const parsed = parseMcpConnectionMaterial(JSON.stringify({ ...material, metadata: { v: 2 } }));
    expect(buildMcpConnectionMaterial(parsed, { "X-Key": "key" })).toMatchObject({
      action: "store",
      material: { metadata: { v: 2 }, oauth: material.oauth },
    });
  });
});

describe("buildMcpUpdateMaterial", () => {
  it("keeps the stored blob untouched when the update carries no credential data", () => {
    expect(
      buildMcpUpdateMaterial(
        {},
        {
          transport: "streamable_http",
          slug: "x",
          name: "x",
          endpoint: "https://mcp.example.test",
          headers: {},
        },
      ),
    ).toEqual({ action: "keep" });
  });

  it("stores a merged blob when a new secret is supplied, preserving OAuth state", () => {
    const existing = { secret: "old-token", oauth: { tokens: { access_token: "t" } } };
    const result = buildMcpUpdateMaterial(existing, {
      transport: "streamable_http",
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
      secret: "new-token",
    });
    expect(result).toEqual({
      action: "store",
      material: { secret: "new-token", oauth: { tokens: { access_token: "t" } }, headers: {} },
    });
  });

  it("persists env/headers even without any static secret (no silent drop)", () => {
    const result = buildMcpUpdateMaterial(
      {},
      {
        transport: "stdio",
        slug: "x",
        name: "x",
        command: "/bin/mcp",
        env: { API_KEY: "k" },
      },
    );
    expect(result).toEqual({ action: "store", material: { env: { API_KEY: "k" } } });
  });

  it("clearing removes static credentials but keeps OAuth state", () => {
    const existing = { secret: "token", env: { A: "b" }, oauth: { tokens: { access_token: "t" } } };
    const result = buildMcpUpdateMaterial(existing, {
      transport: "streamable_http",
      slug: "x",
      name: "x",
      endpoint: "https://mcp.example.test",
      headers: {},
      clearCredential: true,
    });
    expect(result).toEqual({
      action: "store",
      material: { oauth: { tokens: { access_token: "t" } } },
    });
  });

  it("clearing with no OAuth state yields an empty blob so the caller can delete the secret row", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "token" },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: {},
        clearCredential: true,
      },
    );
    expect(result).toEqual({ action: "store", material: {} });
  });

  it("clears endpoint-bound OAuth state while preserving static credentials", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "token", oauth: { tokens: { access_token: "endpoint-token" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://new-mcp.example.test",
        headers: {},
      },
      { clearOAuth: true },
    );
    expect(result).toEqual({
      action: "store",
      material: { secret: "token", headers: {} },
    });
  });

  it("deletes an OAuth-only blob when its endpoint changes", () => {
    const result = buildMcpUpdateMaterial(
      { oauth: { tokens: { access_token: "endpoint-token" } } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://new-mcp.example.test",
        headers: {},
      },
      { clearOAuth: true },
    );
    expect(result).toEqual({ action: "store", material: {} });
  });

  it("replaces headers on update and leaves env untouched when the transport cannot express it", () => {
    const result = buildMcpUpdateMaterial(
      { secret: "s", env: { OLD: "x" }, headers: { Authorization: "a" } },
      {
        transport: "streamable_http",
        slug: "x",
        name: "x",
        endpoint: "https://mcp.example.test",
        headers: { Authorization: "b" },
      },
    );
    expect(result).toEqual({
      action: "store",
      material: { secret: "s", env: { OLD: "x" }, headers: { Authorization: "b" } },
    });
  });
});
