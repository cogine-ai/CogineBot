import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import type { NativeOAuthStore } from "./oauth.js";
import { NativeConnectorProvider } from "./provider.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((fn) => fn()));
});
async function catalog(
  app: string,
  scopes: string[],
  identity: Record<string, unknown>,
  configuredScopes = scopes,
) {
  const fetch = vi.fn(async () => {
    throw new Error("Catalog discovery must not call business APIs");
  });
  const provider = new NativeConnectorProvider(
    {} as PrismaClient,
    new EncryptedSecretStore("synthetic-catalog-test-key"),
    "https://api.example.test",
    { artifacts: {} as ArtifactStore, network: { fetch } },
  );
  close.push(() => provider.close());
  const selected = {
    id: "account-a",
    connectorId: "native",
    externalId: app,
    displayName: "Same visible label",
    providerRef: "grant-a",
    revision: "auth-a",
  };
  const subject = identity.tokenType === "bot" ? "BOTUSER" : "USER";
  vi.spyOn(provider.oauth, "authorization").mockResolvedValue({
    connection: {
      id: selected.id,
      provider: app,
      providerRef: selected.providerRef,
      displayName: selected.displayName,
      metadata: { authRevision: "auth-a" },
    },
    config: {
      id: "config-a",
      revision: 1,
      appId: app,
      config: { scopes: configuredScopes, capabilities: [], knowledgeBaseIds: [] },
    },
    grant: {
      id: "grant-a",
      subject,
      tenant: app === "github" ? null : "ORG",
      scopes,
      authGeneration: 1,
      tokenVersion: 1,
    },
    auth: { tokens: { accessToken: "synthetic-token" }, identity: { context: identity } },
  } as unknown as Awaited<ReturnType<NativeOAuthStore["authorization"]>>);
  const context = {
    userId: "owner-a",
    spaceId: "space-a",
    operationId: "catalog",
    traceId: "catalog",
    signal: new AbortController().signal,
    connectedConnections: [selected],
  } satisfies AdapterContext;
  const tools = await provider.discoverTools(context);
  expect(fetch).not.toHaveBeenCalled();
  return tools.map((tool) => tool.route?.toolName);
}
describe("credential-aware native collaboration catalog", () => {
  it.each(["user", "app"])(
    "Linear read OAuth %s only publishes granted reads",
    async (actorType) => {
      const names = await catalog("linear", ["read"], {
        actorType,
        credentialType: "oauth",
        organizationId: "ORG",
      });
      expect(names).toContain("linear.issues.get");
      expect(names).not.toContain("linear.issues.create");
      expect(names).not.toContain("linear.issues.update");
    },
  );
  it("does not apply OAuth scope fiction to a verified Linear API key", async () => {
    expect(
      await catalog("linear", [], {
        actorType: "user",
        credentialType: "api_key",
        organizationId: "ORG",
      }),
    ).toContain("linear.issues.create");
  });
  it("intersects actual OAuth grants with the deployment scope ceiling", async () => {
    expect(
      await catalog(
        "linear",
        ["read", "write"],
        { actorType: "user", credentialType: "oauth", organizationId: "ORG" },
        ["read"],
      ),
    ).not.toContain("linear.issues.create");
  });
  it("Slack bot scope publishes sends while excluding search and ungranted history", async () => {
    const names = await catalog("slack", ["chat:write", "search:read"], {
      tokenType: "bot",
      teamId: "ORG",
      botUserId: "BOTUSER",
      slackLegacySearchAllowed: true,
      slackUserDataAllowed: true,
    });
    expect(names).toContain("slack.messages.send");
    expect(names).not.toContain("slack.search.messages");
    expect(names).not.toContain("slack.conversations.history");
  });
  it.each([false, true])(
    "Slack personal collection policy=%s controls catalog visibility",
    async (policy) => {
      const names = await catalog("slack", ["channels:history", "search:read"], {
        tokenType: "user",
        teamId: "ORG",
        userId: "USER",
        slackLegacySearchAllowed: true,
        slackUserDataAllowed: policy,
      });
      expect(names.includes("slack.conversations.history")).toBe(policy);
      expect(names.includes("slack.search.messages")).toBe(policy);
    },
  );
  it("GitHub installations publish only verified installation permissions", async () => {
    const names = await catalog("github", [], {
      actorType: "installation",
      installationId: "123",
      githubPermissions: { issues: "read", checks: "read", statuses: "read" },
    });
    expect(names).toContain("github.issues.get");
    expect(names).toContain("github.ci.status");
    expect(names).not.toContain("github.issues.create");
    expect(names).not.toContain("github.pulls.get");
  });
  it("GitHub PAT directory does not fabricate installation permissions or OAuth scope requirements", async () => {
    expect(await catalog("github", [], { actorType: "fine_grained_pat" })).toContain(
      "github.issues.create",
    );
  });
  it("unknown credential actors publish no tools", async () => {
    expect(
      await catalog("linear", ["read", "write"], {
        actorType: "unknown",
        credentialType: "api_key",
        organizationId: "ORG",
      }),
    ).toEqual([]);
  });
});
