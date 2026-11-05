import type { BillingProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BillingService } from "./billing.js";
import { BILLING_RETURN_PATH } from "./billing.js";
import {
  BILLING_WEBHOOK_MAX_BODY_BYTES,
  BILLING_WEBHOOK_PATH,
  mountBillingRoutes,
} from "./billing-webhook.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

function mount(
  parseWebhook: BillingProvider["parseWebhook"],
  options: {
    sync?: () => Promise<void>;
    actor?: Actor | null;
    authenticate?: (request: Request, spaceId?: string) => Promise<Actor | null>;
  } = {},
) {
  const sync = vi.fn(options.sync ?? (async () => undefined));
  const syncForActor = vi.fn(async () => undefined);
  const app = new Hono();
  mountBillingRoutes(app, {
    billing: { sync, syncForActor } as unknown as BillingService,
    provider: { parseWebhook },
    webOrigin: "https://app.example.com",
    authenticate:
      options.authenticate ?? (async () => (options.actor === undefined ? actor : options.actor)),
  });
  return { app, sync, syncForActor };
}

function post(body: string) {
  return { method: "POST", headers: { "stripe-signature": "t=1,v1=fake" }, body };
}

describe("billing webhook", () => {
  it("syncs only a verified customer in a named system context and restores the caller", async () => {
    const contexts: unknown[] = [];
    const { app } = mount(() => ({ customerId: "cus_verified" }), {
      sync: async () => {
        await Promise.resolve();
        contexts.push(currentDbContext());
      },
    });
    const alien = { spaceId: "space-unrelated", userId: "user-unrelated" };
    await runAsTenant(alien, async () => {
      expect((await app.request(BILLING_WEBHOOK_PATH, post("{}"))).status).toBe(200);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
    });
    expect(contexts).toEqual([{ kind: "system", reason: expect.any(String) }]);
    expect(currentDbContext()).toBeUndefined();
  });
  it("rejects a request whose signature does not verify", async () => {
    const { app, sync } = mount(() => null);
    const res = await app.request(BILLING_WEBHOOK_PATH, post("{}"));
    expect(res.status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before verifying it", async () => {
    const parseWebhook = vi.fn(() => null);
    const { app } = mount(parseWebhook);
    const res = await app.request(
      BILLING_WEBHOOK_PATH,
      post("x".repeat(BILLING_WEBHOOK_MAX_BODY_BYTES + 1)),
    );
    expect(res.status).toBe(413);
    expect(parseWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges events it does not act on", async () => {
    const { app, sync } = mount(() => "ignored");
    const res = await app.request(BILLING_WEBHOOK_PATH, post("{}"));
    expect(res.status).toBe(200);
    expect(sync).not.toHaveBeenCalled();
  });

  it("syncs the customer named by a verified event", async () => {
    const parseWebhook = vi.fn(() => ({ customerId: "cus_1" }));
    const { app, sync } = mount(parseWebhook);
    const res = await app.request(BILLING_WEBHOOK_PATH, post('{"id":"evt_1"}'));
    expect(res.status).toBe(200);
    expect(parseWebhook).toHaveBeenCalledWith('{"id":"evt_1"}', expect.any(Headers));
    expect(sync).toHaveBeenCalledWith("cus_1");
  });

  it("fails the delivery so the provider retries when sync fails", async () => {
    const { app } = mount(() => ({ customerId: "cus_1" }), {
      sync: async () => {
        throw new Error("provider unavailable");
      },
    });
    const res = await app.request(BILLING_WEBHOOK_PATH, post("{}"));
    expect(res.status).toBe(500);
  });
});

describe("billing checkout return", () => {
  it("syncs for the verified actor after authentication and restores the caller context", async () => {
    let authenticated = false;
    const { app, syncForActor } = mount(() => null, {
      authenticate: async () => {
        await Promise.resolve();
        authenticated = true;
        return actor;
      },
    });
    const contexts: unknown[] = [];
    syncForActor.mockImplementation(async () => {
      expect(authenticated).toBe(true);
      await Promise.resolve();
      contexts.push(currentDbContext());
    });
    const alien = { spaceId: "space-unrelated", userId: "user-unrelated" };
    await runAsTenant(alien, async () => {
      const response = await app.request(`${BILLING_RETURN_PATH}?space=unverified-space`);
      expect(response.status).toBe(303);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
    });
    expect(syncForActor).toHaveBeenCalledExactlyOnceWith(actor);
    expect(contexts).toEqual([{ kind: "tenant", spaceId: actor.spaceId, userId: actor.userId }]);
    expect(currentDbContext()).toBeUndefined();
  });
  it("passes the initiating Space to authentication before sync", async () => {
    const authenticate = vi.fn(async (_request: Request, spaceId?: string) => ({
      ...actor,
      spaceId: spaceId!,
    }));
    const { app, syncForActor } = mount(() => null, { authenticate });
    await app.request(`${BILLING_RETURN_PATH}?space=space-other`);
    expect(authenticate).toHaveBeenCalledWith(expect.any(Request), "space-other");
    expect(syncForActor).toHaveBeenCalledWith({ ...actor, spaceId: "space-other" });
  });

  it("does not sync a return target that authentication cannot authorize", async () => {
    const { app, syncForActor } = mount(() => null, { authenticate: async () => null });
    const response = await app.request(`${BILLING_RETURN_PATH}?space=foreign-space`);
    expect(response.status).toBe(303);
    expect(syncForActor).not.toHaveBeenCalled();
  });

  it("syncs the signed-in user's organization and returns to the app", async () => {
    const { app, syncForActor } = mount(() => null);
    const res = await app.request(BILLING_RETURN_PATH);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.example.com/app");
    expect(syncForActor).toHaveBeenCalledWith(actor);
  });

  it("sends a signed-out visitor to the web origin", async () => {
    const { app, syncForActor } = mount(() => null, { actor: null });
    const res = await app.request(BILLING_RETURN_PATH);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.example.com");
    expect(syncForActor).not.toHaveBeenCalled();
  });
});
