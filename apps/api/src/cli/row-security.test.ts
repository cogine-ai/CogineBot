import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  urls: vi.fn(),
  create: vi.fn(),
  describe: vi.fn(),
  apply: vi.fn(),
  disconnect: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@rakazo/core/node/load-root-env", () => ({ loadRootEnv: mocks.load }));
vi.mock("@rakazo/db", () => ({
  databaseUrls: mocks.urls,
  createDb: mocks.create,
  describeRowSecurityPolicies: mocks.describe,
  applyRowSecurityPolicies: mocks.apply,
}));

describe("row-security maintenance command", () => {
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const ownerUrl = "postgres://fixture_owner:synthetic-owner@example.test/fixture";
  const runtimeUrl = "postgres://fixture_runtime:synthetic-runtime@example.test/fixture";
  const prisma = { $disconnect: mocks.disconnect };
  const pool = { end: mocks.end };
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  const state = (verified = false) => ({
    expectedTables: 84,
    policyInstalled: verified,
    policyEnabled: verified,
    connectionEnforced: verified,
    deploymentEnforced: false as const,
    guardValid: true,
    legacyPolicyCount: 0,
    tables: [],
    problems: [],
  });
  const output = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join("");

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.argv = ["node", "row-security"];
    process.exitCode = undefined;
    mocks.urls.mockReturnValue({ migrationUrl: ownerUrl, url: runtimeUrl, separate: true });
    mocks.create.mockReturnValue({ prisma, pool });
    mocks.describe.mockResolvedValue(state());
    mocks.apply.mockResolvedValue(state(true));
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  async function run(...args: string[]) {
    process.argv.push(...args);
    await import("./row-security.js");
    await vi.waitFor(() =>
      expect(stdout.mock.calls.length + stderr.mock.calls.length).toBeGreaterThan(0),
    );
  }

  it("defaults to a read-only current-connection inspection", async () => {
    await run();
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(runtimeUrl, {
      poolMax: 1,
      rowSecurity: true,
    });
    expect(mocks.describe).toHaveBeenCalledExactlyOnceWith(prisma);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(output(stdout)).toContain("Row-level isolation: not verified");
    expect(output(stdout)).toContain("Deployment isolation: not verified.");
    expect(output(stderr)).toBe("");
  });

  it("applies only when explicitly requested and still distinguishes deployment proof", async () => {
    await run("apply");
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(ownerUrl, runtimeUrl);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(output(stdout)).toContain("verified for this connection");
    expect(output(stdout)).toContain("Deployment isolation: not verified.");
  });

  it.each([["unknown"], ["status", "extra"], ["apply", "extra"]])(
    "rejects unsupported arguments before opening either database",
    async (...args) => {
      await run(...args);
      expect(mocks.urls).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(output(stderr)).toContain("db:row-security status");
      expect(process.exitCode).toBe(1);
    },
  );

  it("closes the runtime client and pool and redacts a failed inspection", async () => {
    mocks.describe.mockRejectedValue(
      new Error("Synthetic driver failure at " + runtimeUrl, {
        cause: new Error("synthetic-secret-cause"),
      }),
    );
    await run("status");
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(output(stderr)).toContain("Database preparation failed");
    expect(output(stderr)).not.toContain("synthetic-runtime");
    expect(output(stderr)).not.toContain("synthetic-secret-cause");
    expect(output(stderr)).not.toContain("postgres:");
  });

  it("still closes the pool if client disconnection fails", async () => {
    mocks.disconnect.mockRejectedValue(new Error("Synthetic close failure at " + runtimeUrl));
    await run("status");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(output(stderr)).not.toContain("postgres:");
  });

  it("reports a committed installation without exposing the failed probe's cause", async () => {
    mocks.apply.mockRejectedValue(
      new Error("Database policies were committed, but runtime verification failed", {
        cause: new Error("Synthetic authentication failure at " + runtimeUrl),
      }),
    );
    await run("apply");
    expect(process.exitCode).toBe(1);
    expect(output(stderr)).toContain("were committed");
    expect(output(stderr)).toContain("not rolled back");
    expect(output(stderr)).not.toContain("synthetic-runtime");
    expect(output(stderr)).not.toContain("postgres:");
  });

  it("does not promote fully enabled tables when their policies are not verified", async () => {
    mocks.describe.mockResolvedValue({
      ...state(),
      policyEnabled: true,
      tables: [{ table: "memory_documents", enabled: true, problems: ["policy-mismatch"] }],
      problems: ["unexpected-policy"],
    });
    await run("status");
    expect(output(stdout)).toContain("Row-level isolation: not verified");
    expect(output(stdout)).toContain("unexpected-policy");
    expect(output(stdout)).toContain("memory_documents:policy-mismatch");
    expect(output(stdout)).toContain("Deployment isolation: not verified.");
  });
});
