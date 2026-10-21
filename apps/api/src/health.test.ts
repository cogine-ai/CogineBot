import { InfisicalSecretStore } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import { DATABASE_CHECK_TIMEOUT_MS, healthRoutes } from "./health.js";

const app = healthRoutes(() => ({ runtime: "pi", sandbox: "docker", revision: "abc123" }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("health routes", () => {
  it("reports degraded readiness during a store outage and recovers on later reads", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("fake", {
      operationId: "test",
      traceId: "test",
      userId: "test",
      spaceId: "test",
      signal: new AbortController().signal,
    });
    await writer.close();
    fake.offline = true;
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const health = healthRoutes(() => ({ degraded: store.describe().capabilities.degraded }));
    try {
      const response = await health.request("/ready");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
      expect((await health.request("/health")).status).toBe(200);
      fake.offline = false;
      await store.load(record.ref, record.id);
      expect((await health.request("/ready")).status).toBe(200);
    } finally {
      await store.close();
    }
  });
  it("keeps public liveness free of deployment details", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("reports an opaque database failure and recovers on a later check", async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("postgres://private:password@database.invalid/private"))
      .mockResolvedValue(undefined);
    const health = healthRoutes(() => ({ runtime: "pi" }), check);
    const response = await health.request("/ready", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      degraded: false,
      database: "unreachable",
    });
    expect((await health.request("/health")).status).toBe(200);
    const recovered = await health.request("/ready");
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ ok: true, degraded: false });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps degraded secret storage unready even when the database responds", async () => {
    const check = vi.fn(async () => undefined);
    const health = healthRoutes(() => ({ degraded: true }), check);
    const response = await health.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("shares a successful probe between overlapping polls, then checks again", async () => {
    const entered = deferred();
    const pending = deferred();
    const check = vi.fn(() => {
      entered.resolve();
      return pending.promise;
    });
    const health = healthRoutes(() => ({}), check);
    const responses = [
      health.request("/ready"),
      health.request("/ready"),
      health.request("/ready"),
    ];
    await entered.promise;
    expect(check).toHaveBeenCalledTimes(1);
    pending.resolve();
    for (const response of await Promise.all(responses)) expect(response.status).toBe(200);
    expect((await health.request("/ready")).status).toBe(200);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not start new probes after HTTP deadlines until the old check settles", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const check = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const health = healthRoutes(() => ({}), check);
    try {
      const first = health.request("/ready");
      const second = health.request("/ready");
      await expect((await health.request("/health")).json()).resolves.toEqual({ ok: true });
      expect(
        (await health.request("/internal/health", { headers: { forwarded: "for=203.0.113.7" } }))
          .status,
      ).toBe(404);
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          degraded: false,
          database: "unreachable",
        });
      }
      const third = health.request("/ready");
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
      expect((await third).status).toBe(503);
      expect(check).toHaveBeenCalledTimes(1);
      pending.reject(new Error("late database failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect((await health.request("/ready")).status).toBe(200);
      expect(check).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve();
      vi.useRealTimers();
    }
  });

  it("contains a synchronous database-check failure", async () => {
    const health = healthRoutes(
      () => ({}),
      () => {
        throw new Error("private connection details");
      },
    );
    const response = await health.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      degraded: false,
      database: "unreachable",
    });
  });

  it("serves details to direct requests on the API port", async () => {
    const response = await app.request("/internal/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc123",
    });
  });

  it("hides details from requests that came through a reverse proxy", async () => {
    for (const headers of [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
    ]) {
      const response = await app.request("/internal/health", { headers });
      expect(response.status).toBe(404);
    }
  });
});
