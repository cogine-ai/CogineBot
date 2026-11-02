import { createRouterClient } from "@orpc/server";
import type { SecretContext } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};

describe("MCP list preserves unknown credential status", () => {
  it.each(["not-found", "bad-ref", "aad", "json", "structure"])(
    "isolates a %s secret failure from healthy and credentialless servers",
    async (fault) => {
      const store = new EncryptedSecretStore("fixture-list-status-key");
      const context = {
        ...actor,
        operationId: "fixture-status",
        traceId: "fixture",
        botId: "fixture",
        signal: new AbortController().signal,
      };
      const staticRecord = await store.put(
        JSON.stringify({ headers: { "X-Key": "fixture-key" } }),
        context,
        { recordId: "static" },
      );
      const oauthRecord = await store.put(
        JSON.stringify({
          oauth: { tokens: { access_token: "fixture-token", token_type: "bearer" } },
        }),
        context,
        { recordId: "oauth" },
      );
      const faultyRecord = await store.put(
        fault === "json" ? "not json" : fault === "structure" ? '{"oauth":false}' : "{}",
        context,
        { recordId: fault === "aad" ? "another-record" : "bad" },
      );
      const badRef =
        fault === "not-found"
          ? "remote-missing"
          : fault === "bad-ref"
            ? "v2:broken"
            : faultyRecord.ref;
      const records = [
        { id: "bad", ciphertext: badRef },
        { id: "static", ciphertext: staticRecord.ref },
        { id: "oauth", ciphertext: oauthRecord.ref },
      ];
      const rows = ["bad", "static", "oauth", "no-credential"].map((id) => ({
        id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: id,
        name: id,
        description: "",
        transport: "streamable_http",
        endpoint: `https://tools.example.test/${id}`,
        command: null,
        args: [],
        env: {},
        headers: id === "static" ? { "X-Key": true } : {},
        secretId: id === "no-credential" ? null : id,
        enabled: true,
        allowAllTools: false,
        allowedTools: [],
        revision: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }));
      const secrets = {
        load: vi.fn(async (ref: string, record: SecretContext) => {
          if (ref === "remote-missing") throw new SecretNotFoundError();
          return store.load(ref, record);
        }),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const deps = {
        prisma: {
          mcpServer: { findMany: vi.fn(async () => rows) },
          secret: { findMany: vi.fn(async () => records) },
        },
        secrets,
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fixture",
          sandboxProvider: "fake",
        },
        dataDir: "/tmp/mcp-status-fixture",
      } as unknown as RouterDeps;
      const client = createRouterClient(createRouter(deps), { context: { actor } as never });
      const result = await client.mcp.servers.list();
      expect(result.map(({ id, oauthStatus }) => ({ id, oauthStatus }))).toEqual([
        { id: "bad", oauthStatus: "unknown" },
        { id: "static", oauthStatus: "none" },
        { id: "oauth", oauthStatus: "connected" },
        { id: "no-credential", oauthStatus: "none" },
      ]);
      expect(result[0]).toMatchObject({ revision: 1, enabled: true });
      expect(JSON.stringify(result)).not.toContain("fixture-key");
      expect(JSON.stringify(result)).not.toContain("fixture-token");
      expect(secrets.put).not.toHaveBeenCalled();
    },
  );
});
