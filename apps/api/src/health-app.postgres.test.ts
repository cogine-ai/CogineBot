import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as database from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("database readiness app wiring", () => {
  const options = (dataDir: string) => ({
    databaseUrl: process.env.DATABASE_URL!,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    wakeupDriver: "memory",
  });

  it("owns one probe, uses it for requests and closes it during shutdown", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "readiness-app-"));
    const createProbe = database.createReadinessProbe;
    const owned: Array<{
      check: ReturnType<typeof vi.fn<() => Promise<void>>>;
      close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    }> = [];
    const factory = vi.spyOn(database, "createReadinessProbe").mockImplementation((url) => {
      const probe = createProbe(url);
      const tracked = { check: vi.fn(probe.check), close: vi.fn(probe.close) };
      owned.push(tracked);
      return tracked;
    });
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp(options(dataDir));
      expect(factory).toHaveBeenCalledExactlyOnceWith(process.env.DATABASE_URL);
      expect(owned[0]!.check).not.toHaveBeenCalled();
      expect((await handles.app.request("/health")).status).toBe(200);
      expect(owned[0]!.check).not.toHaveBeenCalled();
      for (let poll = 0; poll < 2; poll += 1) {
        const response = await handles.app.request("/ready");
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true, degraded: false });
      }
      expect(owned[0]!.check).toHaveBeenCalledTimes(2);
      await handles.stop();
      handles = undefined;
      expect(owned[0]!.close).toHaveBeenCalledTimes(1);
      await expect(owned[0]!.check()).rejects.toThrow();
    } finally {
      await handles?.stop();
      factory.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not open a hidden pool for an injected database", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "readiness-injected-"));
    const created = database.createDb(process.env.DATABASE_URL!);
    const factory = vi.spyOn(database, "createReadinessProbe");
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp({ ...options(dataDir), prisma: created.prisma });
      expect((await handles.app.request("/ready")).status).toBe(200);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await handles?.stop();
      await created.prisma.$disconnect();
      await created.pool.end();
      factory.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("uses an explicit check with database injection %s", async (inject) => {
    const dataDir = await mkdtemp(join(tmpdir(), "readiness-override-"));
    const created = inject ? database.createDb(process.env.DATABASE_URL!) : undefined;
    const factory = vi.spyOn(database, "createReadinessProbe");
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp({
        ...options(dataDir),
        ...(created ? { prisma: created.prisma } : {}),
        readinessCheck: check,
      });
      const failed = await handles.app.request("/ready");
      expect(failed.status).toBe(503);
      await expect(failed.json()).resolves.toEqual({
        ok: false,
        degraded: false,
        database: "unreachable",
      });
      expect((await handles.app.request("/ready")).status).toBe(200);
      expect(check).toHaveBeenCalledTimes(2);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await handles?.stop();
      await created?.prisma.$disconnect();
      await created?.pool.end();
      factory.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
