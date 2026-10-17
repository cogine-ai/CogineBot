import assert from "node:assert/strict";
import type { NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import type { Obj, Schema } from "./helpers.js";
import { validateNativeInput } from "./validation.js";

export function conforms(schema: Schema, value: unknown): void {
  validateNativeInput(schema, value);
}

export const KB = "11111111-1111-4111-8111-111111111111";
export const DOC = "33333333-3333-4333-8333-333333333333";
export const SESSION = "22222222-2222-4222-8222-222222222222";

export function context(overrides: Partial<NativeActionContext> = {}): NativeActionContext {
  return {
    operationId: "synthetic-effect-key-001",
    signal: new AbortController().signal,
    checkpoint: async () => {},
    principal: {
      subject: "synthetic-machine",
      tenant: "synthetic-tenant",
      scopes: ["mcp"],
      capabilities: ["retrieve", "ingest", "chat"],
      knowledgeBaseIds: [KB],
      context: {
        xConnectionContext: {
          schemaVersion: 2,
          resource: "https://mcp.example.test/mcp",
          accountIssuer: "https://issuer.example.test",
          accountSubject: KB,
          principal: "synthetic",
          organizationId: 1,
          teamContext: { state: "available", teamId: KB },
        },
      },
    },
    request: async () => {
      throw new Error("Unexpected HTTP call");
    },
    callMcp: async () => {
      throw new Error("Unexpected MCP call");
    },
    readArtifact: async () => ({
      bytes: new TextEncoder().encode("Synthetic artifact"),
      name: "synthetic.txt",
      mimeType: "text/plain",
    }),
    validateResourceUrl: async (url) => {
      assert.equal(new URL(url).hostname, "example.test");
    },
    ...overrides,
  };
}

export function reply(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): NativeResponse {
  return { body: structuredClone(body), status, headers: new Headers(headers) };
}

export function pathMatches(template: string, actual: string): boolean {
  return new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(actual);
}

export async function requestEnvelope(template: string, request: NativeRequest): Promise<Obj> {
  const path: Obj = {};
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const regex = new RegExp(`^${template.replace(/\{[^}]+\}/g, "([^/]+)")}$`);
  const match = request.path.match(regex);
  assert.ok(match);
  names.forEach((name, index) => {
    const value = match[index + 1];
    assert.ok(name !== undefined && value !== undefined, "Missing path template capture");
    path[name] = decodeURIComponent(value);
  });
  const envelope: Obj = { path, query: request.query ?? {} };
  if (request.body instanceof FormData) {
    const form: Obj = {};
    for (const [name, value] of request.body.entries()) {
      form[name] =
        name === "file"
          ? "Synthetic multipart bytes"
          : name === "enable_multimodel"
            ? value === "true"
            : value;
    }
    envelope.form = form;
  } else if (request.body !== undefined) envelope.body = request.body;
  return envelope;
}
