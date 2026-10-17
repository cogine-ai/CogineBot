import type { NativeAppConfig } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeAuthorization } from "./authorities.js";
import { NativeOAuthAuthorities } from "./authorities.js";

const authorities: NativeOAuthAuthorities[] = [];
afterEach(async () => {
  await Promise.all(authorities.splice(0).map((authority) => authority.close()));
});
const signal = () => new AbortController().signal;
const config = (appId = "google-calendar"): NativeAppConfig => ({
  id: "config",
  appId,
  label: "Fixture",
  ownership: "byo",
  credentialKind: "oauth",
  enabled: true,
  config: { clientId: "fake-client", scopes: ["openid"], capabilities: [], knowledgeBaseIds: [] },
  callbackUri: "https://api.example.test/api/connectors/oauth/callback",
  revision: 1,
  ciphertext: "opaque",
  secretRecordId: "material",
  createdAt: new Date(),
  updatedAt: new Date(),
});
const token = (extra = {}) => ({
  access_token: "fake-access",
  token_type: "bearer",
  refresh_token: "fake-refresh",
  expires_in: 3600,
  scope: "openid https://www.googleapis.com/auth/calendar.events",
  ...extra,
});
const notionOwner = {
  workspace_id: "workspace-a",
  workspace_name: "Fixture",
  bot_id: "bot-a",
  owner: { type: "user", user: { id: "user-a" } },
};
function setup(bodies: Array<unknown | Response | Error>) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const body = bodies.shift();
    if (body instanceof Error) throw body;
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  });
  const authority = new NativeOAuthAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  authorities.push(authority);
  return { authority, fetch };
}
const previous: NativeAuthorization = {
  tokens: { accessToken: "fake-old", refreshToken: "fake-old-refresh" },
  identity: {
    authority: "https://accounts.google.com",
    subject: "subject-a",
    tenant: null,
    displayName: "Fixture",
    context: {},
  },
  scopes: ["openid"],
  expiresAt: new Date(0),
};

describe("fixed SaaS OAuth authorities", () => {
  it("binds Google state, callback, scopes and S256 without putting the secret into the URL", () => {
    const { authority } = setup([]);
    const url = new URL(authority.authorizationUrl(config(), "state-a", "verifier-a"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("state-a");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(config().callbackUri);
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(url.searchParams.get("code_verifier")).toBeNull();
  });
  it("does not invent PKCE for Notion's published confidential protocol", () => {
    const { authority } = setup([]);
    const url = new URL(authority.authorizationUrl(config("notion"), "state-b", "unused"));
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });
  it("uses authoritative Google userinfo sub and the registered callback for code exchange", async () => {
    const { authority, fetch } = setup([
      token({ id_token: "unsigned.untrusted.payload" }),
      { sub: "subject-a", email: "member@example.test", email_verified: true },
    ]);
    const auth = await authority.exchange(
      config(),
      "fake-client-secret",
      "fake-code",
      "fake-verifier",
      signal(),
    );
    expect(auth.identity.subject).toBe("subject-a");
    const body = fetch.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("redirect_uri")).toBe(config().callbackUri);
    expect(body.get("code_verifier")).toBe("fake-verifier");
    expect(body.get("client_secret")).toBe("fake-client-secret");
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo",
    );
  });
  it("requires Google's granted identity scope", async () => {
    const { authority, fetch } = setup([
      token({ scope: "https://www.googleapis.com/auth/calendar.events" }),
    ]);
    await expect(
      authority.exchange(config(), "fake-secret", "code", "verifier", signal()),
    ).rejects.toMatchObject({ kind: "insufficient_scope" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed Google subject on refresh", async () => {
    const { authority } = setup([token(), { sub: "different-subject" }]);
    await expect(
      authority.refresh(config(), "fake-secret", previous, signal()),
    ).rejects.toMatchObject({ kind: "authorization_expired" });
  });
  it("retains Google's previous refresh token when a refresh omits it", async () => {
    const next = token();
    delete (next as Partial<typeof next>).refresh_token;
    const { authority } = setup([next, { sub: "subject-a" }]);
    expect(
      (await authority.refresh(config(), "fake-secret", previous, signal())).tokens.refreshToken,
    ).toBe("fake-old-refresh");
  });
  it("binds a Notion grant to workspace, individual user and bot rather than workspace alone", async () => {
    const { authority, fetch } = setup([
      { ...token({ refresh_token: null }), ...notionOwner },
      { id: "bot-a", type: "bot" },
    ]);
    const auth = await authority.exchange(
      config("notion"),
      "fake-secret",
      "code",
      "unused",
      signal(),
    );
    expect(auth.identity.subject).toBe("workspace-a:user-a:bot-a");
    expect(auth.tokens.refreshToken).toBeNull();
    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("fake-client:fake-secret").toString("base64")}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: config().callbackUri,
    });
  });
  it("rejects a Notion token/owner bot mismatch", async () => {
    const { authority } = setup([{ ...token(), ...notionOwner }, { id: "another-bot" }]);
    await expect(
      authority.exchange(config("notion"), "fake-secret", "code", "unused", signal()),
    ).rejects.toMatchObject({ kind: "authorization_required" });
  });
  it("rejects a workspace-wide owner for this individual OAuth branch", async () => {
    const { authority } = setup([
      { ...token(), ...notionOwner, owner: { type: "workspace", workspace: true } },
    ]);
    await expect(
      authority.exchange(config("notion"), "fake-secret", "code", "unused", signal()),
    ).rejects.toMatchObject({ kind: "authorization_required" });
  });
  it("stores Notion's returned nullable refresh token without inventing a lifetime", async () => {
    const { authority } = setup([
      { ...token({ refresh_token: null, expires_in: undefined }), ...notionOwner },
      { id: "bot-a" },
    ]);
    const prior = {
      ...previous,
      identity: {
        authority: "https://api.notion.com",
        subject: "workspace-a:user-a:bot-a",
        tenant: "workspace-a",
        displayName: "",
        context: { botId: "bot-a" },
      },
    };
    const next = await authority.refresh(config("notion"), "fake-secret", prior, signal());
    expect(next.tokens.refreshToken).toBeNull();
    expect(next.expiresAt).toBeNull();
  });
  it("does not echo token-service response content in errors", async () => {
    const { authority } = setup([
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "fake-secret private text" }),
        { status: 400 },
      ),
    ]);
    const error = await authority
      .exchange(config(), "fake-secret", "code", "verifier", signal())
      .catch((error: Error) => error);
    expect(error).toMatchObject({ kind: "authorization_expired" });
    expect(String(error)).not.toContain("fake-secret");
    expect(String(error)).not.toContain("private text");
  });
  it("never retries a lost rotating-token response", async () => {
    const { authority, fetch } = setup([new Error("connection lost after remote commit")]);
    await expect(
      authority.refresh(config(), "fake-secret", previous, signal()),
    ).rejects.toMatchObject({ kind: "temporarily_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
