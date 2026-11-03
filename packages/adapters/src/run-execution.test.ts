import type * as NodeFs from "node:fs";
import { readFileSync } from "node:fs";
import type * as NodeV8 from "node:v8";
import { getHeapStatistics } from "node:v8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunExecutionHost } from "./run-execution.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: vi.fn(),
}));
vi.mock("node:v8", async (importOriginal) => {
  const original = await importOriginal<typeof NodeV8>();
  return { ...original, getHeapStatistics: vi.fn(original.getHeapStatistics) };
});

const GiB = 1024 ** 3;

function cgroupFiles(inactiveFile: number) {
  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    if (path === "/proc/self/cgroup") return "0::/\n";
    if (path === "/sys/fs/cgroup/memory.stat")
      return `anon 734003200\nfile ${inactiveFile + 4096}\ninactive_file ${inactiveFile}\nactive_file 4096\n`;
    throw new Error(`unexpected read ${path}`);
  }) as unknown as typeof readFileSync);
}

describe("RunExecutionHost memory admission", () => {
  let release: () => void;
  let released: Promise<void>;
  const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
    onRunStarted();
    await released;
  };

  beforeEach(() => {
    released = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(process, "constrainedMemory").mockReturnValue(2 * GiB);
    vi.spyOn(process, "availableMemory").mockReturnValue(1024 ** 2);
    vi.mocked(readFileSync).mockReset();
    vi.mocked(getHeapStatistics).mockReturnValue({
      ...getHeapStatistics(),
      heap_size_limit: 4 * GiB,
      used_heap_size: GiB,
    });
  });
  afterEach(() => {
    release();
    vi.restoreAllMocks();
  });

  it("counts a container's inactive page cache as room for another run", async () => {
    cgroupFiles(GiB);
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(true);
    release();
    await host.stop();
  });

  it("still holds runs back when the container's memory is really in use", async () => {
    cgroupFiles(0);
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(false);
    release();
    await host.stop();
  });

  it("protects heap headroom even when physical memory is available", async () => {
    cgroupFiles(0);
    vi.mocked(process.availableMemory).mockReturnValue(GiB);
    vi.mocked(getHeapStatistics).mockReturnValue({
      ...getHeapStatistics(),
      heap_size_limit: GiB,
      used_heap_size: GiB - 1024 ** 2,
    });
    const host = new RunExecutionHost();
    await host.execute(execute);
    const next = vi.fn(execute);
    await expect(host.execute(next, { waitForCapacity: false })).resolves.toBe(false);
    expect(next).not.toHaveBeenCalled();
    release();
    await host.stop();
  });

  it("falls back to no reclaimed cache when the cgroup files cannot be read", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("fixture unavailable");
    });
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(false);
    release();
    await host.stop();
  });

  it("releases a capacity waiter when its resident execution finishes", async () => {
    cgroupFiles(0);
    const host = new RunExecutionHost();
    await host.execute(execute);
    const next = vi.fn(execute);
    const waiting = host.execute(next);
    expect(next).not.toHaveBeenCalled();
    release();
    await expect(waiting).resolves.toBe(true);
    expect(next).toHaveBeenCalledOnce();
    await host.stop();
    expect(host.activeCount).toBe(0);
  });

  it("rejects capacity waiters while stopping and waits for resident executions", async () => {
    cgroupFiles(0);
    const host = new RunExecutionHost();
    await host.execute(execute);
    const next = vi.fn(execute);
    const waiting = host.execute(next);
    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await expect(waiting).rejects.toThrow("Worker is stopping");
    expect(next).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
    expect(host.activeCount).toBe(1);
    release();
    await stopping;
    expect(host.activeCount).toBe(0);
    host.start();
    await expect(host.execute(next)).resolves.toBe(true);
    await host.stop();
  });
});
