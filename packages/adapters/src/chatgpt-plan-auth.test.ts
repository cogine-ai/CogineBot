import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ChatGPTPlanAuthorization, ChatGPTPlanCredential } from "./chatgpt-plan-auth.js";
import {
  beginChatGPTPlanAuthorization,
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_PLAN_TERMINAL_REFRESH_ERROR_CODES,
  ChatGPTPlanRotationPendingError,
  chatGPTPlanRotationCheckpoint,
  completeChatGPTPlanAuthorization,
  createChatGPTPlanOAuthAuth,
  isChatGPTPlanRotationPendingError,
  MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES,
  readChatGPTPlanCredential,
  refreshChatGPTPlanCredential,
  revokeChatGPTPlanCredential,
} from "./chatgpt-plan-auth.js";

const NOW = 1_800_000_000_000;
const HOST_ID = "urn:uuid:e61bbe28-07ef-466d-8e5d-a344f94ab305";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const CLIENT_ID = "oaiapp_test_issued";
const SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

function idToken(
  nonce: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const parts = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", ...header })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: CHATGPT_PLAN_ISSUER,
        sub: "test-subject",
        aud: CLIENT_ID,
        exp: NOW / 1000 + 3600,
        iat: NOW / 1000 - 1,
        nonce,
        email: "test@example.com",
        ...claims,
      }),
    ).toString("base64url"),
  ];
  return `${parts.join(".")}.${sign("RSA-SHA256", Buffer.from(parts.join(".")), privateKey).toString("base64url")}`;
}

function callback(transaction: ChatGPTPlanAuthorization, params: Record<string, string> = {}) {
  const url = new URL(transaction.redirectUri);
  url.search = new URLSearchParams({
    state: transaction.state,
    code: "test-code",
    client_id: CLIENT_ID,
    ...params,
  }).toString();
  return url.toString();
}

function fixture(
  options: {
    token?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    registration?: { clientId: string; subject?: string; issuer?: string };
    discovery?: Record<string, unknown>;
    keys?: unknown[];
  } = {},
) {
  const begin = beginChatGPTPlanAuthorization(
    { hostId: HOST_ID, redirectUri: REDIRECT_URI, registration: options.registration },
    { now: () => NOW },
  );
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: CHATGPT_PLAN_ISSUER,
        jwks_uri: `${CHATGPT_PLAN_ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${CHATGPT_PLAN_ISSUER}/oauth/revoke`,
        ...options.discovery,
      });
    }
    if (url.endsWith("/.well-known/jwks.json"))
      return Response.json({ keys: options.keys ?? [JWK] });
    if (url.endsWith("/api/accounts/oauth/token")) {
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: SCOPES,
        id_token: idToken(begin.transaction.nonce, options.claims, options.header),
        ...options.token,
      });
    }
    if (url.endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
    throw new Error("Unexpected fake endpoint");
  }) as typeof fetch;
  return { ...begin, fetch: fakeFetch, requests, now: () => NOW };
}

function savedCredential(): ChatGPTPlanCredential {
  return {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: NOW - 1,
    clientId: CLIENT_ID,
    issuer: CHATGPT_PLAN_ISSUER,
    subject: "test-subject",
    hostId: HOST_ID,
    scopes: SCOPES.split(" "),
    idToken: idToken("old-nonce"),
    email: "test@example.com",
  };
}

describe("ChatGPT plan authorization", () => {
  it("creates fresh independent PKCE, state, nonce and dynamic registration", () => {
    const first = fixture();
    const second = fixture();
    const url = new URL(first.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${CHATGPT_PLAN_ISSUER}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "CogineBot",
      ext_agent_host_id: HOST_ID,
      redirect_uri: REDIRECT_URI,
      resource: CHATGPT_PLAN_RESOURCE,
      scope: SCOPES,
      state: first.transaction.state,
      nonce: first.transaction.nonce,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(first.transaction.verifier).digest("base64url"),
    );
    expect(first.transaction.state).not.toBe(first.transaction.nonce);
    expect(first.transaction.state).not.toBe(second.transaction.state);
    expect(first.transaction.verifier).not.toBe(second.transaction.verifier);
  });

  it("reauthorizes a saved client with retained hints and no new name hint", () => {
    const { authorizationUrl } = beginChatGPTPlanAuthorization({
      hostId: HOST_ID,
      redirectUri: REDIRECT_URI,
      registration: {
        clientId: CLIENT_ID,
        issuer: CHATGPT_PLAN_ISSUER,
        subject: "test-subject",
        email: "test@example.com",
      },
      idTokenHint: "retained-id-token",
      agentName: "CogineBot",
    });
    const params = new URL(authorizationUrl).searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("id_token_hint")).toBe("retained-id-token");
    expect(params.get("login_hint")).toBe("test@example.com");
    expect(params.has("agent_name_hint")).toBe(false);
  });

  it.each([
    "http://localhost:1455/auth/callback",
    "http://127.1:1455/auth/callback",
    "https://127.0.0.1:1455/auth/callback",
    "http://127.0.0.1/auth/callback",
    `${REDIRECT_URI}?x=1`,
    `${REDIRECT_URI}#x`,
  ])("rejects an invalid callback listener URI: %s", (redirectUri) => {
    expect(() => beginChatGPTPlanAuthorization({ hostId: HOST_ID, redirectUri })).toThrow(
      /callback must/,
    );
  });

  it("rejects an unstable host ID and saving dynamic_agent_client as an issued ID", () => {
    expect(() =>
      beginChatGPTPlanAuthorization({ hostId: "test@example.com", redirectUri: REDIRECT_URI }),
    ).toThrow(/stable host/);
    expect(() => fixture({ registration: { clientId: "dynamic_agent_client" } })).toThrow(
      /registration is invalid/,
    );
  });

  it("retains the issued ID before exchange and verifies the signed identity", async () => {
    const f = fixture();
    const onRegistration = vi.fn(() => {
      expect(f.requests).toHaveLength(0);
    });
    const credential = await completeChatGPTPlanAuthorization(
      f.transaction,
      callback(f.transaction),
      { ...f, onRegistration },
    );
    expect(onRegistration).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      issuer: CHATGPT_PLAN_ISSUER,
    });
    expect(credential).toMatchObject({
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: NOW + 3600_000,
      clientId: CLIENT_ID,
      issuer: CHATGPT_PLAN_ISSUER,
      subject: "test-subject",
      hostId: HOST_ID,
      scopes: SCOPES.split(" "),
      email: "test@example.com",
    });
    const exchange = f.requests[0]!;
    expect(Object.fromEntries(exchange.init!.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: "test-code",
      code_verifier: f.transaction.verifier,
      redirect_uri: REDIRECT_URI,
      resource: CHATGPT_PLAN_RESOURCE,
    });
    expect(f.requests.every(({ init }) => init?.redirect === "error")).toBe(true);
    expect(f.requests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("allows callback omission of client_id only for an existing registration", async () => {
    const f = fixture({ registration: { clientId: CLIENT_ID, subject: "test-subject" } });
    const url = new URL(callback(f.transaction));
    url.searchParams.delete("client_id");
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, url.toString(), f),
    ).resolves.toMatchObject({ clientId: CLIENT_ID });
    const first = fixture();
    url.searchParams.set("state", first.transaction.state);
    await expect(
      completeChatGPTPlanAuthorization(first.transaction, url.toString(), first),
    ).rejects.toThrow(/issued client ID/);
  });

  it.each([
    { change: (url: URL) => url.searchParams.set("state", "wrong"), message: /state mismatch/ },
    { change: (url: URL) => url.searchParams.delete("state"), message: /state mismatch/ },
    {
      change: (url: URL) => url.searchParams.set("error", "access_denied"),
      message: /declined or failed/,
    },
    { change: (url: URL) => url.searchParams.delete("code"), message: /authorization code/ },
    { change: (url: URL) => url.searchParams.append("code", "duplicate"), message: /ambiguous/ },
    {
      change: (url: URL) => url.searchParams.set("access_token", "forbidden-secret"),
      message: /must not contain credentials/,
    },
    {
      change: (url: URL) => {
        url.hostname = "localhost";
      },
      message: /does not match/,
    },
    {
      change: (url: URL) => {
        url.port = "1456";
      },
      message: /does not match/,
    },
    {
      change: (url: URL) => {
        url.pathname = "/callback";
      },
      message: /does not match/,
    },
  ])(
    "rejects an unverified callback before any request ($message)",
    async ({ change, message }) => {
      const f = fixture();
      const url = new URL(callback(f.transaction));
      change(url);
      await expect(
        completeChatGPTPlanAuthorization(f.transaction, url.toString(), f),
      ).rejects.toThrow(message);
      expect(f.requests).toHaveLength(0);
    },
  );

  it("rejects a changed returning client and a changed verified account", async () => {
    const f = fixture({ registration: { clientId: CLIENT_ID, subject: "test-subject" } });
    await expect(
      completeChatGPTPlanAuthorization(
        f.transaction,
        callback(f.transaction, { client_id: "oaiapp_other" }),
        f,
      ),
    ).rejects.toThrow(/changed the selected registration/);
    const changed = fixture({ registration: { clientId: CLIENT_ID, subject: "original-subject" } });
    await expect(
      completeChatGPTPlanAuthorization(changed.transaction, callback(changed.transaction), changed),
    ).rejects.toThrow(/account changed/);
  });

  it("does not accept a normalized numeric-loopback alias in a pasted callback", async () => {
    const f = fixture();
    const alias = callback(f.transaction).replace("127.0.0.1", "127.1");
    await expect(completeChatGPTPlanAuthorization(f.transaction, alias, f)).rejects.toThrow(
      /does not match/,
    );
    expect(f.requests).toHaveLength(0);
  });

  it("expires transactions and prevents callback replay", async () => {
    const expired = fixture();
    await expect(
      completeChatGPTPlanAuthorization(expired.transaction, callback(expired.transaction), {
        ...expired,
        now: () => NOW + 15 * 60_000,
      }),
    ).rejects.toThrow(/expired/);
    const f = fixture();
    await completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f);
    const count = f.requests.length;
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
    ).rejects.toThrow(/already used/);
    expect(f.requests).toHaveLength(count);
  });

  it.each([
    { iss: "https://other.example.com" },
    { aud: "oaiapp_other" },
    { nonce: "wrong" },
    { exp: NOW / 1000 - 6 },
    { exp: null },
    { iat: NOW / 1000 + 6 },
    { iat: null },
    { nbf: NOW / 1000 + 6 },
    { sub: "" },
    { aud: [CLIENT_ID, "other"] },
    { azp: "other" },
  ])("rejects invalid signed ID-token claims: %j", async (claims) => {
    const f = fixture({ claims });
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
    ).rejects.toThrow(/ID token claims/);
  });

  it("accepts multiple audiences only with the matching authorized party", async () => {
    const f = fixture({ claims: { aud: [CLIENT_ID, "other"], azp: CLIENT_ID } });
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
    ).resolves.toBeDefined();
  });

  it("rejects invalid signatures, unsupported algorithms and unknown signing keys", async () => {
    const invalid = fixture({
      token: { id_token: `${idToken("unused").split(".").slice(0, 2).join(".")}.AAAA` },
    });
    await expect(
      completeChatGPTPlanAuthorization(invalid.transaction, callback(invalid.transaction), invalid),
    ).rejects.toThrow(/signature is invalid/);
    const algorithm = fixture({ header: { alg: "none" } });
    await expect(
      completeChatGPTPlanAuthorization(
        algorithm.transaction,
        callback(algorithm.transaction),
        algorithm,
      ),
    ).rejects.toThrow(/algorithm is invalid/);
    const key = fixture({ header: { kid: "unknown" } });
    await expect(
      completeChatGPTPlanAuthorization(key.transaction, callback(key.transaction), key),
    ).rejects.toThrow(/signing key is invalid/);
  });

  it.each([
    { ...JWK, use: "enc" },
    { ...JWK, alg: "HS256" },
    { ...JWK, key_ops: ["encrypt"] },
  ])("rejects a JWKS key with unsuitable use or algorithm", async (key) => {
    const f = fixture({ keys: [key] });
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
    ).rejects.toThrow(/signing key is invalid/);
  });

  it("rejects discovery issuer or endpoint substitution", async () => {
    for (const discovery of [
      { issuer: "https://attacker.example.com" },
      { jwks_uri: "https://attacker.example.com/keys" },
    ]) {
      const f = fixture({ discovery });
      await expect(
        completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
      ).rejects.toThrow(/discovery/);
      expect(f.requests.some(({ url }) => url.includes("attacker"))).toBe(false);
    }
  });

  it.each([
    { scope: "openid profile" },
    { access_token: "" },
    { refresh_token: "" },
    { expires_in: 0 },
    { expires_in: "3600" },
    { token_type: "other" },
  ])("rejects incomplete token response: %j", async (token) => {
    const f = fixture({ token });
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
    ).rejects.toThrow(/valid plan credentials/);
  });

  it("keeps an issued client ID after invalid_grant without exposing response secrets", async () => {
    const f = fixture();
    const onRegistration = vi.fn();
    const fakeFetch = vi.fn(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "private-token-secret" },
        { status: 400 },
      ),
    ) as typeof fetch;
    const failure = completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), {
      ...f,
      fetch: fakeFetch,
      onRegistration,
    });
    await expect(failure).rejects.toThrow("ChatGPT OAuth request failed (400) invalid_grant.");
    expect(onRegistration).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      issuer: CHATGPT_PLAN_ISSUER,
    });
    await expect(failure).rejects.not.toThrow("private-token-secret");
  });

  it("caps token responses declared or streamed beyond the limit", async () => {
    for (const headers of [
      { "content-length": String(MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES + 1) },
      {},
    ] as Record<string, string>[]) {
      const f = fixture();
      const fakeFetch = vi.fn(
        async () =>
          new Response(new Uint8Array(MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES + 1), { headers }),
      ) as typeof fetch;
      await expect(
        completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), {
          ...f,
          fetch: fakeFetch,
        }),
      ).rejects.toThrow(/too large/);
    }
  });

  it("honors cancellation even when the transport ignores the signal", async () => {
    const f = fixture();
    const abort = new AbortController();
    const fakeFetch = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;
    const operation = completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), {
      ...f,
      fetch: fakeFetch,
      signal: abort.signal,
    });
    abort.abort(new Error("cancelled sign-in"));
    await expect(operation).rejects.toThrow("cancelled sign-in");
  });
});

describe("ChatGPT plan refresh and revocation", () => {
  it.each(CHATGPT_PLAN_TERMINAL_REFRESH_ERROR_CODES)(
    "retains the safe terminal refresh code %s without response diagnostics",
    async (code) => {
      const fetch = vi.fn(async () =>
        Response.json(
          { error: code, error_description: "private-response-diagnostics" },
          { status: 400 },
        ),
      ) as typeof globalThis.fetch;
      const failure = refreshChatGPTPlanCredential(savedCredential(), undefined, { fetch });
      await expect(failure).rejects.toThrow(`ChatGPT OAuth request failed (400) ${code}.`);
      await expect(failure).rejects.not.toThrow("private-response-diagnostics");
    },
  );

  it("does not promote terminal codes quoted in unknown refresh errors", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: "unknown_error", error_description: "invalid_grant" },
        { status: 400 },
      ),
    ) as typeof globalThis.fetch;
    await expect(
      refreshChatGPTPlanCredential(savedCredential(), undefined, { fetch }),
    ).rejects.toThrow("ChatGPT OAuth request failed (400).");
  });

  it("does not begin rotation when the requesting operation was already cancelled", async () => {
    const abort = new AbortController();
    abort.abort(new Error("request cancelled"));
    const fetch = vi.fn();
    await expect(
      refreshChatGPTPlanCredential(savedCredential(), abort.signal, { fetch }),
    ).rejects.toThrow("request cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the replacement for persistence when cancellation arrives during rotation", async () => {
    const abort = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let complete!: (response: Response) => void;
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }) as typeof globalThis.fetch;
    const operation = refreshChatGPTPlanCredential(savedCredential(), abort.signal, {
      fetch,
      now: () => NOW,
    });
    abort.abort(new Error("request cancelled after refresh began"));
    expect(receivedSignal?.aborted).toBe(false);
    complete(
      Response.json({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
        scope: SCOPES,
      }),
    );
    await expect(operation).resolves.toMatchObject({
      access: "next-access",
      refresh: "next-refresh",
    });
  });

  it("refreshes with the issued client, rotates tokens and preserves account and model metadata", async () => {
    const f = fixture({
      token: {
        id_token: undefined,
        scope: undefined,
        access_token: "next-access",
        refresh_token: "next-refresh",
      },
    });
    const previous = {
      ...savedCredential(),
      models: [{ id: "test-model" }],
      earliestRefreshAt: NOW,
    };
    const next = await refreshChatGPTPlanCredential(previous, undefined, f);
    expect(next).toMatchObject({
      access: "next-access",
      refresh: "next-refresh",
      subject: previous.subject,
      idToken: previous.idToken,
      scopes: previous.scopes,
      models: previous.models,
    });
    expect(Object.fromEntries(f.requests[0]!.init!.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: "old-refresh",
      resource: CHATGPT_PLAN_RESOURCE,
    });
  });

  it("validates refreshed ID tokens before replacing account credentials", async () => {
    const f = fixture({ claims: { sub: "another-subject" } });
    await expect(refreshChatGPTPlanCredential(savedCredential(), undefined, f)).rejects.toThrow(
      ChatGPTPlanRotationPendingError,
    );
    const retained = fixture({ token: { id_token: undefined, refresh_token: undefined } });
    await expect(
      refreshChatGPTPlanCredential(savedCredential(), undefined, retained),
    ).rejects.toThrow(/valid plan credentials/);
  });

  it("does not rotate before the server's earliest refresh time", async () => {
    const fetch = vi.fn();
    await expect(
      refreshChatGPTPlanCredential(
        { ...savedCredential(), earliestRefreshAt: NOW + 1 },
        undefined,
        {
          fetch,
          now: () => NOW,
        },
      ),
    ).rejects.toThrow(/renewal is not available yet/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checkpoints a received rotation after JWKS failure and promotes it without another exchange", async () => {
    const f = fixture({ token: { earliest_refresh_at: NOW / 1000 + 7200 } });
    let jwksAvailable = false;
    let clock = NOW;
    let tokenRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/oauth/token")) tokenRequests += 1;
      if (url.endsWith("/.well-known/jwks.json") && !jwksAvailable)
        throw new Error("private upstream diagnostics");
      return f.fetch(input, init);
    }) as typeof globalThis.fetch;
    const auth = createChatGPTPlanOAuthAuth({ fetch, now: () => clock });
    const failure: unknown = await auth
      .refresh(savedCredential(), new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatGPTPlanRotationPendingError);
    expect(isChatGPTPlanRotationPendingError(failure)).toBe(true);
    expect(isChatGPTPlanRotationPendingError(new Error("other"))).toBe(false);
    const checkpoint = chatGPTPlanRotationCheckpoint(failure)!;
    expect(checkpoint).toMatchObject({
      access: "old-access",
      refresh: "old-refresh",
      subject: "test-subject",
      pendingRotation: {
        receivedAt: NOW,
        response: { access_token: "test-access", refresh_token: "test-refresh" },
      },
    });
    expect(JSON.stringify(failure)).not.toContain("test-access");
    expect(JSON.stringify(failure)).not.toContain("test-refresh");
    expect(String(failure)).not.toContain("private upstream diagnostics");
    expect(Object.hasOwn(failure as object, "cause")).toBe(false);
    const restored = readChatGPTPlanCredential(JSON.parse(JSON.stringify(checkpoint)))!;
    await expect(auth.toAuth(restored)).rejects.toThrow(/identity verification before use/);
    clock += 60_000;
    jwksAvailable = true;
    const promoted = await auth.refresh(
      { ...restored, earliestRefreshAt: clock + 3600_000 },
      new AbortController().signal,
    );
    expect(tokenRequests).toBe(1);
    expect(promoted).toMatchObject({
      access: "test-access",
      refresh: "test-refresh",
      expires: NOW + 3600_000,
    });
    expect(promoted).not.toHaveProperty("pendingRotation");
    await expect(auth.toAuth(promoted)).resolves.toEqual({ apiKey: "test-access" });
  });

  it("revokes the replacement refresh token while identity verification remains pending", async () => {
    const f = fixture({ claims: { sub: "another-subject" } });
    const failure: unknown = await refreshChatGPTPlanCredential(
      savedCredential(),
      undefined,
      f,
    ).catch((error: unknown) => error);
    const checkpoint = chatGPTPlanRotationCheckpoint(failure)!;
    await expect(revokeChatGPTPlanCredential(checkpoint, undefined, f)).resolves.toEqual({
      confirmed: true,
    });
    const revocation = f.requests.find(({ url }) => url.endsWith("/oauth/revoke"))!;
    expect((revocation.init!.body as URLSearchParams).get("token")).toBe("test-refresh");
  });

  it("finds pending rotations through bounded, cycle-safe provider error chains", async () => {
    const f = fixture({ claims: { sub: "another-subject" } });
    const failure: unknown = await refreshChatGPTPlanCredential(
      savedCredential(),
      undefined,
      f,
    ).catch((error: unknown) => error);
    const checkpoint = chatGPTPlanRotationCheckpoint(failure);
    expect(checkpoint).toBeDefined();
    const wrapped = new Error("OAuth refresh failed for chatgpt-plan", {
      cause: new Error("Provider authentication failed", { cause: failure }),
    });
    expect(chatGPTPlanRotationCheckpoint(wrapped)).toBe(checkpoint);
    expect(isChatGPTPlanRotationPendingError(wrapped)).toBe(true);
    expect(JSON.stringify(wrapped)).not.toContain("test-refresh");

    const cycle = new Error("Cyclic provider error");
    cycle.cause = new Error("Another provider error", { cause: cycle });
    expect(chatGPTPlanRotationCheckpoint(cycle)).toBeUndefined();
    expect(isChatGPTPlanRotationPendingError(cycle)).toBe(false);

    let tooDeep = failure;
    for (let depth = 0; depth < 12; depth += 1) {
      tooDeep = new Error("Provider error wrapper", { cause: tooDeep });
    }
    expect(chatGPTPlanRotationCheckpoint(tooDeep)).toBeUndefined();
  });

  it("rejects malformed encrypted pending rotation records", async () => {
    const valid = {
      ...savedCredential(),
      pendingRotation: {
        receivedAt: NOW,
        response: {
          access_token: "pending-access",
          refresh_token: "pending-refresh",
          id_token: "pending-id",
          expires_in: 3600,
          scope: SCOPES,
        },
      },
    };
    expect(readChatGPTPlanCredential(valid)).toBeDefined();
    for (const pendingRotation of [
      null,
      { ...valid.pendingRotation, receivedAt: 0 },
      {
        ...valid.pendingRotation,
        response: { ...valid.pendingRotation.response, refresh_token: "" },
      },
      {
        ...valid.pendingRotation,
        response: { ...valid.pendingRotation.response, scope: "openid" },
      },
      {
        ...valid.pendingRotation,
        response: {
          ...valid.pendingRotation.response,
          id_token: "x".repeat(MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES + 1024),
        },
      },
    ])
      expect(readChatGPTPlanCredential({ ...valid, pendingRotation })).toBeUndefined();
  });

  it.each([
    { wire: NOW / 1000 + 60, expected: NOW + 60_000 },
    { wire: new Date(NOW + 60_000).toISOString(), expected: NOW + 60_000 },
  ])("saves the server's earliest refresh time ($wire)", async ({ wire, expected }) => {
    const f = fixture({ token: { earliest_refresh_at: wire } });
    const credential = await completeChatGPTPlanAuthorization(
      f.transaction,
      callback(f.transaction),
      f,
    );
    expect(credential.earliestRefreshAt).toBe(expected);
    const refresh = fixture({ token: { earliest_refresh_at: wire, id_token: undefined } });
    expect(
      (await refreshChatGPTPlanCredential(savedCredential(), undefined, refresh)).earliestRefreshAt,
    ).toBe(expected);
  });

  it.each([
    null,
    0,
    -1,
    Number.NaN,
    "not-a-timestamp",
    "2026-10-28",
    "1790000000",
    "2026-02-31T00:00:00Z",
    "2026-10-28T24:00:00Z",
  ])("rejects malformed earliest refresh time: %j", async (wire) => {
    const f = fixture({ token: { earliest_refresh_at: wire } });
    await expect(
      completeChatGPTPlanAuthorization(f.transaction, callback(f.transaction), f),
    ).rejects.toThrow(/earliest refresh time/);
  });

  it("rechecks scopes returned by refresh", async () => {
    const f = fixture({ token: { scope: "openid profile", id_token: undefined } });
    await expect(refreshChatGPTPlanCredential(savedCredential(), undefined, f)).rejects.toThrow(
      /valid plan credentials/,
    );
  });

  it("revokes the renewable session through the discovered endpoint and accepts empty 200", async () => {
    const f = fixture();
    await expect(revokeChatGPTPlanCredential(savedCredential(), undefined, f)).resolves.toEqual({
      confirmed: true,
    });
    const request = f.requests.find(({ url }) => url.endsWith("/oauth/revoke"))!;
    expect(Object.fromEntries(request.init!.body as URLSearchParams)).toEqual({
      token: "old-refresh",
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    });
  });

  it("reports unconfirmed revocation for network failures or absent endpoint", async () => {
    const f = fixture({ discovery: { revocation_endpoint: undefined } });
    await expect(revokeChatGPTPlanCredential(savedCredential(), undefined, f)).resolves.toEqual({
      confirmed: false,
    });
    await expect(
      revokeChatGPTPlanCredential(savedCredential(), undefined, {
        fetch: vi.fn().mockRejectedValue(new Error("network details")),
      }),
    ).resolves.toEqual({ confirmed: false });
  });

  it("retries a transient revocation failure with the original refresh token", async () => {
    const f = fixture();
    let attempts = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/oauth/revoke")) {
        expect((init!.body as URLSearchParams).get("token")).toBe("old-refresh");
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 503 : 200 });
      }
      return f.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      revokeChatGPTPlanCredential(savedCredential(), undefined, { ...f, fetch }),
    ).resolves.toEqual({ confirmed: true });
    expect(attempts).toBe(2);
  });

  it("does not retry a permanent revocation rejection or a cancelled request", async () => {
    const f = fixture();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      return String(input).endsWith("/oauth/revoke")
        ? new Response(null, { status: 400 })
        : f.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      revokeChatGPTPlanCredential(savedCredential(), undefined, { ...f, fetch }),
    ).resolves.toEqual({ confirmed: false });
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/oauth/revoke")),
    ).toHaveLength(1);
    const abort = new AbortController();
    abort.abort();
    const cancelled = vi.fn();
    await expect(
      revokeChatGPTPlanCredential(savedCredential(), abort.signal, { fetch: cancelled }),
    ).resolves.toEqual({ confirmed: false });
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe("ChatGPT plan credential validation and Pi adapter", () => {
  it("retains complete credentials but rejects corrupt or incomplete registrations", () => {
    expect(readChatGPTPlanCredential(savedCredential())).toEqual(savedCredential());
    for (const patch of [
      { clientId: "dynamic_agent_client" },
      { issuer: "https://other.example.com" },
      { subject: "" },
      { hostId: "email@example.com" },
      { idToken: "" },
      { scopes: [] },
      { expires: Number.NaN },
      { earliestRefreshAt: -1 },
      { refresh: "" },
    ])
      expect(readChatGPTPlanCredential({ ...savedCredential(), ...patch })).toBeUndefined();
  });

  it("adapts the complete browser callback through Pi 0.87 interaction", async () => {
    let authorize: URL | undefined;
    const f = fixture();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/accounts/oauth/token")) {
        return Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          expires_in: 3600,
          scope: SCOPES,
          id_token: idToken(authorize!.searchParams.get("nonce")!),
        });
      }
      return f.fetch(input, init);
    }) as typeof globalThis.fetch;
    const onRegistration = vi.fn();
    const auth = createChatGPTPlanOAuthAuth({
      fetch,
      now: () => NOW,
      getLoginContext: () => ({ hostId: HOST_ID, redirectUri: REDIRECT_URI, onRegistration }),
    });
    const interaction: AuthInteraction = {
      signal: new AbortController().signal,
      notify(event) {
        if (event.type === "auth_url") authorize = new URL(event.url);
      },
      async prompt() {
        return `${REDIRECT_URI}?${new URLSearchParams({ state: authorize!.searchParams.get("state")!, code: "code", client_id: CLIENT_ID })}`;
      },
    };
    const credential = await auth.login({ ...interaction, signal: interaction.signal! });
    expect(credential).toMatchObject({ clientId: CLIENT_ID, subject: "test-subject" });
    expect(await auth.toAuth(credential)).toEqual({ apiKey: "test-access" });
    expect(onRegistration).toHaveBeenCalledOnce();
  });

  it("refreshes cached signing keys once when OpenAI rotates to an unfamiliar kid", async () => {
    let authorize: URL | undefined;
    let kid = "test-key";
    let keyRequests = 0;
    const f = fixture();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) {
        keyRequests += 1;
        return Response.json({ keys: [{ ...JWK, kid }] });
      }
      if (url.endsWith("/api/accounts/oauth/token")) {
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: SCOPES,
          id_token: idToken(authorize!.searchParams.get("nonce")!, {}, { kid }),
        });
      }
      return f.fetch(input, init);
    }) as typeof globalThis.fetch;
    const auth = createChatGPTPlanOAuthAuth({
      fetch,
      now: () => NOW,
      getLoginContext: () => ({ hostId: HOST_ID, redirectUri: REDIRECT_URI }),
    });
    const interaction = {
      signal: new AbortController().signal,
      notify(event: Parameters<AuthInteraction["notify"]>[0]) {
        if (event.type === "auth_url") authorize = new URL(event.url);
      },
      async prompt() {
        return `${REDIRECT_URI}?${new URLSearchParams({ code: "code", state: authorize!.searchParams.get("state")!, client_id: CLIENT_ID })}`;
      },
    };
    await auth.login(interaction);
    kid = "rotated-key";
    await expect(auth.login(interaction)).resolves.toMatchObject({ subject: "test-subject" });
    expect(keyRequests).toBe(2);
    expect(
      f.requests.filter(({ url }) => url.endsWith("/.well-known/openid-configuration")),
    ).toHaveLength(1);
  });
});
