import { createHash } from "node:crypto";
import { NativeBeginInputSchema } from "@rakazo/contracts";
import type { NativeAppConfig } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeAuthorization } from "./authorities.js";
import {
  DRIVE_PICKER_IDENTITY_KIND,
  DRIVE_PICKER_SCOPE,
  drivePickerFileIds,
  NativeOAuthAuthorities,
} from "./authorities.js";

const instances: NativeOAuthAuthorities[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((value) => value.close()));
});
const signal = () => new AbortController().signal;
const config = (scopes = ["openid", "email", DRIVE_PICKER_SCOPE]): NativeAppConfig => ({
  id: "picker-config",
  appId: "google-drive",
  label: "Synthetic Drive",
  ownership: "byo",
  credentialKind: "oauth",
  enabled: true,
  config: { clientId: "fixture-client", scopes, capabilities: [], knowledgeBaseIds: [] },
  callbackUri: "https://api.example.test/api/connectors/oauth/callback",
  revision: 1,
  ciphertext: "opaque",
  secretRecordId: "material",
  createdAt: new Date(),
  updatedAt: new Date(),
});
const token = (extra: Record<string, unknown> = {}) => ({
  access_token: "fixture-narrow-access",
  refresh_token: "fixture-narrow-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: DRIVE_PICKER_SCOPE,
  ...extra,
});
const user = (extra: Record<string, unknown> = {}) => ({
  user: {
    permissionId: "drive-user-123",
    me: true,
    displayName: "Synthetic Drive user",
    emailAddress: "display-only@example.test",
    ...extra,
  },
});
const file = (id = "file_a", extra: Record<string, unknown> = {}) => ({
  id,
  name: `Synthetic ${id}`,
  mimeType: "text/plain",
  isAppAuthorized: true,
  ...extra,
});
function setup(bodies: unknown[]) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const body = bodies.shift();
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  });
  const authority = new NativeOAuthAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  instances.push(authority);
  return { authority, fetch };
}
const exchange = (authority: NativeOAuthAuthorities, ids = "file_a", source = config()) =>
  authority.exchangeDrivePicker(
    source,
    "fixture-secret",
    "fixture-code",
    "verifier",
    ids,
    signal(),
  );
const previous = (): NativeAuthorization => ({
  tokens: { accessToken: "fixture-old", refreshToken: "fixture-old-refresh" },
  identity: {
    authority: "https://www.googleapis.com/drive/v3",
    subject: "drive-permission:drive-user-123",
    tenant: null,
    displayName: "Synthetic Drive user",
    context: {
      identityKind: DRIVE_PICKER_IDENTITY_KIND,
      drivePermissionId: "drive-user-123",
      pickedFiles: [file()],
      pickedFilesVerifiedAtAuthorization: true,
    },
  },
  scopes: [DRIVE_PICKER_SCOPE],
  expiresAt: new Date(0),
});

describe("independent Google Drive file-selection authority", () => {
  it("launches Google's OAuth Picker with only drive.file, consent and bound S256", () => {
    const { authority } = setup([]);
    const url = new URL(authority.drivePickerAuthorizationUrl(config(), "state", "verifier"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: DRIVE_PICKER_SCOPE,
      prompt: "consent",
      trigger_onepick: "true",
      allow_multiple: "true",
      allow_folder_selection: "true",
      access_type: "offline",
      response_type: "code",
      redirect_uri: config().callbackUri,
      state: "state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update("verifier").digest("base64url"),
    });
    for (const key of ["include_granted_scopes", "client_secret", "code_verifier"])
      expect(url.searchParams.has(key)).toBe(false);
    expect(url.searchParams.get("scope")).not.toContain("openid");
  });
  it("preserves the administrator ceiling for a legacy metadata-only configuration", async () => {
    const { authority, fetch } = setup([]);
    const legacy = config([
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ]);
    expect(() => authority.drivePickerAuthorizationUrl(legacy, "state", "verifier")).toThrow(
      /administrator/,
    );
    await expect(exchange(authority, "file_a", legacy)).rejects.toMatchObject({
      kind: "not_configured",
    });
    await expect(authority.refresh(legacy, "secret", previous(), signal())).rejects.toMatchObject({
      kind: "not_configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["gmail", "google-calendar", "notion"])(
    "rejects %s as a Picker source",
    async (appId) => {
      const { authority, fetch } = setup([]);
      await expect(exchange(authority, "file_a", { ...config(), appId })).rejects.toMatchObject({
        kind: "invalid_input",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("verifies permission identity and every file using the same narrow token", async () => {
    const { authority, fetch } = setup([
      token({ id_token: "unsigned.untrusted.payload" }),
      user(),
      file("file_a", { ignored: "untrusted" }),
      file("folder_b", { mimeType: "application/vnd.google-apps.folder" }),
    ]);
    const auth = await exchange(authority, "file_a,folder_b");
    expect(auth.scopes).toEqual([DRIVE_PICKER_SCOPE]);
    expect(auth.identity).toMatchObject({
      authority: "https://www.googleapis.com/drive/v3",
      subject: "drive-permission:drive-user-123",
      tenant: null,
      context: {
        identityKind: DRIVE_PICKER_IDENTITY_KIND,
        drivePermissionId: "drive-user-123",
        displayEmail: "display-only@example.test",
        pickedFilesVerifiedAtAuthorization: true,
      },
    });
    expect(auth.identity.context.email).toBeUndefined();
    expect(auth.identity.context.pickedFiles).toEqual([
      file(),
      file("folder_b", { mimeType: "application/vnd.google-apps.folder" }),
    ]);
    const body = fetch.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("redirect_uri")).toBe(config().callbackUri);
    expect(body.get("code_verifier")).toBe("verifier");
    for (const [target, init] of fetch.mock.calls.slice(1)) {
      const url = new URL(String(target));
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-narrow-access");
      expect(url.pathname).toMatch(/^\/drive\/v3\/(about|files\/)/);
      expect(url.searchParams.get("fields")).toBeTruthy();
    }
    expect(fetch.mock.calls.map(([url]) => String(url)).join(" ")).not.toContain("userinfo");
  });
  it("accepts permission identity without an optional email address", async () => {
    const { authority } = setup([token(), user({ emailAddress: undefined }), file()]);
    expect((await exchange(authority)).identity).toMatchObject({
      displayName: "Synthetic Drive user",
      subject: "drive-permission:drive-user-123",
    });
  });
  it.each([undefined, "", `openid ${DRIVE_PICKER_SCOPE}`, "https://www.googleapis.com/auth/drive"])(
    "rejects a missing or wider granted scope (%s)",
    async (scope) => {
      const { authority, fetch } = setup([token({ scope })]);
      await expect(exchange(authority)).rejects.toMatchObject({
        kind: scope ? "insufficient_scope" : "incomplete_response",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([{ permissionId: undefined }, { permissionId: "../bad" }, { me: false }])(
    "requires a valid authoritative requesting-user identity %j",
    async (change) => {
      const { authority, fetch } = setup([token(), user(change)]);
      await expect(exchange(authority)).rejects.toHaveProperty("kind");
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    { isAppAuthorized: false },
    { isAppAuthorized: undefined },
    { id: "different_file" },
    { name: undefined },
    { mimeType: "" },
  ])("treats callback file IDs only as candidates %j", async (change) => {
    const { authority } = setup([token(), user(), file("file_a", change)]);
    await expect(exchange(authority)).rejects.toMatchObject({ kind: "authorization_required" });
  });
  it("does not adopt a partial selection if one candidate is unauthorized", async () => {
    const { authority } = setup([
      token(),
      user(),
      file(),
      file("file_b", { isAppAuthorized: false }),
    ]);
    await expect(exchange(authority, "file_a,file_b")).rejects.toMatchObject({
      kind: "authorization_required",
    });
  });
  it("verifies large selections in bounded batches of four", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstBatch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    let peak = 0;
    let fileCalls = 0;
    const authority = new NativeOAuthAuthorities({
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (target) => {
        const url = new URL(String(target));
        if (url.pathname === "/token") return Response.json(token());
        if (url.pathname === "/drive/v3/about") return Response.json(user());
        fileCalls++;
        active++;
        peak = Math.max(peak, active);
        if (fileCalls === 4) entered();
        if (fileCalls <= 4) await gate;
        active--;
        return Response.json(file(url.pathname.split("/").at(-1)));
      },
    });
    instances.push(authority);
    const result = exchange(authority, "file_a,file_b,file_c,file_d,file_e");
    await firstBatch;
    try {
      expect(fileCalls).toBe(4);
      expect(peak).toBe(4);
    } finally {
      release();
    }
    expect((await result).identity.context.pickedFiles).toHaveLength(5);
    expect(peak).toBe(4);
  });
  it.each([
    "",
    "file_a,file_a",
    "file_a,",
    "file/a",
    Array.from({ length: 101 }, (_, i) => `file_${i}`).join(","),
  ])("rejects malformed selections before token exchange", async (ids) => {
    const { authority, fetch } = setup([]);
    await expect(exchange(authority, ids)).rejects.toHaveProperty("kind");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds selections to 100 canonical IDs", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `file_${i}`);
    expect(drivePickerFileIds(ids.join(","))).toEqual(ids);
  });
  it("refreshes the Drive permission identity without requiring or impersonating OIDC", async () => {
    const { authority, fetch } = setup([
      token({ scope: undefined, refresh_token: undefined }),
      user({ emailAddress: "renamed@example.test" }),
    ]);
    const auth = await authority.refresh(config(), "secret", previous(), signal());
    expect(auth.tokens.refreshToken).toBe("fixture-old-refresh");
    expect(auth.identity.subject).toBe(previous().identity.subject);
    expect(auth.identity.context.pickedFiles).toEqual([file()]);
    expect(auth.identity.context.email).toBeUndefined();
    expect(auth.scopes).toEqual([DRIVE_PICKER_SCOPE]);
    expect(String(fetch.mock.calls[1]![0])).toContain("/drive/v3/about?");
  });
  it("rejects a changed Drive permission identity after refresh", async () => {
    const { authority } = setup([token(), user({ permissionId: "another-drive-user" })]);
    await expect(authority.refresh(config(), "secret", previous(), signal())).rejects.toMatchObject(
      { kind: "authorization_expired" },
    );
  });
  it("rejects scope widening during refresh before identity lookup", async () => {
    const { authority, fetch } = setup([token({ scope: `${DRIVE_PICKER_SCOPE} openid` })]);
    await expect(authority.refresh(config(), "secret", previous(), signal())).rejects.toMatchObject(
      { kind: "insufficient_scope" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["authority", "subject", "permission", "scopes"])(
    "rejects an inconsistent stored Picker %s before sending a refresh token",
    async (field) => {
      const prior = previous();
      if (field === "authority") prior.identity.authority = "https://accounts.google.com";
      if (field === "subject") prior.identity.subject = "oidc-user-id";
      if (field === "permission") prior.identity.context.drivePermissionId = "different-id";
      if (field === "scopes") prior.scopes.push("openid");
      const { authority, fetch } = setup([]);
      await expect(authority.refresh(config(), "secret", prior, signal())).rejects.toHaveProperty(
        "kind",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("keeps ordinary OIDC authorization separate even when the callback contains selected IDs", async () => {
    const { authority, fetch } = setup([
      token({ scope: `openid email ${DRIVE_PICKER_SCOPE}` }),
      { sub: "oidc-user-id", email: "verified@example.test", email_verified: true },
    ]);
    const auth = await authority.exchange(config(), "secret", "code", "verifier", signal());
    expect(auth.identity.subject).toBe("oidc-user-id");
    expect(auth.identity.authority).toBe("https://accounts.google.com");
    expect(auth.identity.context.identityKind).toBeUndefined();
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo",
    );
  });
  it("allows Picker only as a fresh begin input, while ordinary reconnect retains its target", () => {
    expect(
      NativeBeginInputSchema.safeParse({ configId: "config-a", authorizationFlow: "drive_picker" })
        .success,
    ).toBe(true);
    for (const extra of [{ previousConnectionId: "connection-a" }, { credential: "fixture-token" }])
      expect(
        NativeBeginInputSchema.safeParse({
          configId: "config-a",
          authorizationFlow: "drive_picker",
          ...extra,
        }).success,
      ).toBe(false);
    expect(
      NativeBeginInputSchema.safeParse({
        configId: "config-a",
        previousConnectionId: "connection-a",
      }).success,
    ).toBe(true);
  });
});
