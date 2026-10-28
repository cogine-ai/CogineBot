import type { Server } from "node:http";
import { createServer } from "node:http";
import { FileNotFoundError, Sandbox, SandboxNotFoundError } from "@e2b/desktop";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sleepComputerIfIdle } from "./computer-idle.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";

class FixtureSandbox extends Sandbox {
  constructor(sandboxUrl: string) {
    super({
      sandboxId: "file-error-fixture",
      envdVersion: "0.6.0",
      apiKey: "fake-key",
      sandboxUrl,
      requestTimeoutMs: 1_000,
      retries: 0,
    });
  }
}

let server: Server;
let sandboxUrl: string;
const fileRequests: string[] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname !== "/files") {
      response.writeHead(500).end();
      return;
    }
    fileRequests.push(url.searchParams.get("path") ?? "");
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "sandbox settings.json not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  sandboxUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function readMissingFile(): Promise<FileNotFoundError> {
  const error = await new FixtureSandbox(sandboxUrl).files
    .read("/home/user/rakazo-home/sandbox settings.json", { format: "bytes" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(error).toBeInstanceOf(FileNotFoundError);
  expect(fileRequests.at(-1)).toBe("/home/user/rakazo-home/sandbox settings.json");
  return error as FileNotFoundError;
}

it("keeps SDK file-loss evidence distinct from sandbox-like message text", async () => {
  const error = await readMissingFile();
  expect(error.message).toBe("sandbox settings.json not found");
  expect(isSandboxGoneError(error)).toBe(false);
});

it("preserves nested SDK file-loss evidence after a wrapper repeats its message", async () => {
  const error = await readMissingFile();
  expect(isSandboxGoneError(new Error(`Export failed: ${error.message}`, { cause: error }))).toBe(
    false,
  );
});

it("still accepts native sandbox-loss evidence through a generic wrapper", () => {
  expect(
    isSandboxGoneError(
      new Error("Export failed", {
        cause: new SandboxNotFoundError("Synthetic sandbox unavailable"),
      }),
    ),
  ).toBe(true);
});

it("retains a running computer and saved revision after an SDK file 404 during idle export", async () => {
  vi.stubEnv("SANDBOX_IDLE_MS", undefined);
  const error = await readMissingFile();
  const computer = {
    id: "computer-fixture",
    homeKey: "home-fixture",
    homeRevision: "saved-revision",
    providerRef: "running-sandbox",
    kind: "e2b",
    screenGeneration: 0,
    maintenanceId: null,
    state: "running",
    spaceId: "space-fixture",
    userId: "user-fixture",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
    updatedAt: new Date("2000-01-01"),
  };
  const updateMany = vi.fn(async ({ where, data }) => {
    for (const [field, value] of Object.entries(where)) {
      if (field === "updatedAt") {
        if ((value as Date).getTime() !== computer.updatedAt.getTime()) return { count: 0 };
      } else if (field in computer && Reflect.get(computer, field) !== value) {
        return { count: 0 };
      }
    }
    const previousState = computer.state;
    Object.assign(computer, data);
    if (previousState !== computer.state) computer.screenGeneration += 1;
    return { count: 1 };
  });
  const stop = vi.fn();
  const commit = vi.fn();
  const enqueue = vi.fn();
  const deps = {
    prisma: {
      computer: { findUnique: vi.fn(async () => ({ ...computer })), updateMany },
      run: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient,
    sandbox: {
      inspectBackgroundWork: async () => "idle",
      exportWorkspace: async function* () {
        yield await Promise.reject(error);
      },
      stop,
    } as unknown as SandboxProvider,
    home: { commit } as unknown as AgentHomeStore,
    jobs: { enqueue } as unknown as JobPublisher,
    events: { append: vi.fn() } as unknown as ThreadEvents,
  };
  await expect(sleepComputerIfIdle(deps, computer.id)).rejects.toBe(error);
  expect(computer).toMatchObject({
    state: "running",
    providerRef: "running-sandbox",
    homeRevision: "saved-revision",
  });
  expect(updateMany).toHaveBeenCalledWith({
    where: {
      id: computer.id,
      state: "suspending",
      providerRef: "running-sandbox",
      kind: "e2b",
      screenGeneration: 1,
      maintenanceId: null,
      updatedAt: expect.any(Date),
    },
    data: { state: "running" },
  });
  expect(stop).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledOnce();
});
