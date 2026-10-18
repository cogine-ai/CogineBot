import { describe, expect, it, vi } from "vitest";
import type { NativeOAuthStore } from "../oauth.js";
import { ensureDriveChangesWatch } from "./google-watch.js";
import { nativeGoogleWatchBinding, withNativeGoogleWatchApi } from "./transport.js";
import type { NativeSourceReadContext } from "./worker.js";

const NOW = Date.parse("2026-10-18T00:00:00Z"),
  DF = "https://www.googleapis.com/auth/drive.file";
function fixture() {
  const context = {
    scope: { userId: "owner-a", spaceId: "space-a" },
    row: {
      id: "trigger-a",
      version: 1,
      connectionId: "account-a",
      authorizationRevision: "auth-a",
      grantId: "grant-a",
      authGeneration: 1,
      configId: "config-a",
      configRevision: 1,
      kind: "drive.file_changed",
      spec: { kind: "drive.file_changed", fileId: "file-a" },
      state: { ready: true },
    },
    signal: new AbortController().signal,
  } as NativeSourceReadContext;
  const bound = {
    connection: {
      id: "account-a",
      userId: "owner-a",
      spaceId: "space-a",
      connectorId: "native",
      provider: "google-drive",
      metadata: { authRevision: "auth-a" },
    },
    grant: { id: "grant-a", authGeneration: 1, scopes: [DF] },
    config: {
      id: "config-a",
      revision: 1,
      config: { scopes: [DF], capabilities: [], knowledgeBaseIds: [] },
    },
    auth: {
      tokens: { accessToken: "synthetic-drive-token" },
      identity: { subject: "google-user-a", context: {} },
    },
  } as unknown as Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
  const calls: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      headers = new Headers(init?.headers),
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(headers.get("authorization")).toBe("Bearer synthetic-drive-token");
    expect(init?.redirect).toBe("manual");
    calls.push({ path: url.pathname, headers, body });
    if (url.pathname.endsWith("/channels/stop")) return new Response(null, { status: 204 });
    expect(url.pathname).toBe("/drive/v3/changes/watch");
    expect(url.searchParams.get("pageToken")).toBe("cursor-a");
    return Response.json({
      kind: "api#channel",
      id: body.id,
      resourceId: `resource-${calls.length}`,
      resourceUri: "https://www.googleapis.com/drive/v3/changes",
      expiration: body.expiration,
    });
  });
  const network = { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] };
  const authorization = vi.fn(async () => structuredClone(bound));
  const run = (now = NOW) =>
    withNativeGoogleWatchApi(
      { authorization },
      context,
      (request) =>
        ensureDriveChangesWatch(
          {
            bindingKey: nativeGoogleWatchBinding(context),
            state: context.row.state as Record<string, unknown>,
            request,
            persistState: async (state) => {
              context.row.state = structuredClone(state);
            },
          },
          { apiUrl: "https://api.example.test", pageToken: "cursor-a" },
          now,
        ),
      network,
    );
  return { context, bound, network, authorization, calls, fetch, run };
}
describe("Drive watch through actual fenced native transport", () => {
  it("registers the fixed changes endpoint and persists no raw channel token", async () => {
    const f = fixture(),
      result = await f.run();
    expect(result.registered).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.authorization.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(result.state)).not.toContain(f.calls[0]!.body.token);
    expect(f.calls[0]!.body.address).toBe("https://api.example.test/api/connectors/events/drive");
  });
  it("renews first and stops the old channel using the same fixed authorization", async () => {
    const f = fixture();
    expect((await f.run()).registered).toBe(true);
    const active = (
      f.context.row.state as { driveWatch: { channels: Array<{ expiration: number }> } }
    ).driveWatch.channels[0]!;
    expect((await f.run(active.expiration - 60_000)).registered).toBe(true);
    expect(f.calls.map((call) => call.path)).toEqual([
      "/drive/v3/changes/watch",
      "/drive/v3/changes/watch",
      "/drive/v3/channels/stop",
    ]);
  });
  it("rejects stale authorization generations before any request", async () => {
    const f = fixture();
    f.bound.grant.authGeneration++;
    await expect(f.run()).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects arbitrary provider operations and alternate service selectors", async () => {
    const f = fixture();
    await expect(
      withNativeGoogleWatchApi(
        { authorization: f.authorization },
        f.context,
        (request) => request({ method: "POST", path: "/changes/watch", service: "drive-upload" }),
        f.network,
      ),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
