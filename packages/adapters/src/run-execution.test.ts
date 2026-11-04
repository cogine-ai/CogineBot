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

  it.each(["physical", "heap"] as const)(
    "shares %s admission across hosts and permits only one recovery execution",
    async (pressure) => {
      cgroupFiles(0);
      if (pressure === "heap") {
        vi.mocked(process.availableMemory).mockReturnValue(GiB);
        vi.mocked(getHeapStatistics).mockReturnValue({
          ...getHeapStatistics(),
          heap_size_limit: GiB,
          used_heap_size: GiB - 1024 ** 2,
        });
      }
      const first = new RunExecutionHost();
      const second = new RunExecutionHost();
      const third = new RunExecutionHost();
      let releaseSecond!: () => void;
      const secondLifetime = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const candidate = vi.fn(async ({ onRunStarted }: { onRunStarted: () => void }) => {
        onRunStarted();
        await secondLifetime;
      });
      try {
        await first.execute(execute);
        await expect(second.execute(candidate, { waitForCapacity: false })).resolves.toBe(false);
        expect(candidate).not.toHaveBeenCalled();
        release();
        await first.stop();
        // Even under pressure an empty process gets one chance to recover.
        await expect(second.execute(candidate, { waitForCapacity: false })).resolves.toBe(true);
        await expect(third.execute(candidate, { waitForCapacity: false })).resolves.toBe(false);
        expect(candidate).toHaveBeenCalledOnce();
      } finally {
        release();
        releaseSecond();
        await Promise.all([first.stop(), second.stop(), third.stop()]);
      }
    },
  );

  it("wakes a capacity waiter when an execution on another host finishes", async () => {
    vi.useFakeTimers();
    cgroupFiles(0);
    const first = new RunExecutionHost();
    const second = new RunExecutionHost();
    const candidate = vi.fn(execute);
    let waiting: Promise<boolean> | undefined;
    try {
      await first.execute(execute);
      waiting = second.execute(candidate);
      void waiting.catch(() => undefined);
      expect(candidate).not.toHaveBeenCalled();
      release();
      await first.stop();
      // No polling timer is advanced: completion must notify the other host.
      await expect(waiting).resolves.toBe(true);
      expect(candidate).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all([first.stop(), second.stop()]);
      await waiting?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("stops and restarts one host without forgetting another host's resident work", async () => {
    cgroupFiles(0);
    const first = new RunExecutionHost();
    const second = new RunExecutionHost();
    const candidate = vi.fn(execute);
    let waiting: Promise<boolean> | undefined;
    try {
      await first.execute(execute);
      waiting = second.execute(candidate);
      void waiting.catch(() => undefined);
      const stopped = second.stop();
      await expect(waiting).rejects.toThrow("Worker is stopping");
      await stopped;
      expect(first.activeCount).toBe(1);
      expect(second.activeCount).toBe(0);
      second.start();
      await expect(second.execute(candidate, { waitForCapacity: false })).resolves.toBe(false);
      expect(candidate).not.toHaveBeenCalled();
      release();
      await first.stop();
      await expect(second.execute(candidate)).resolves.toBe(true);
    } finally {
      release();
      await Promise.all([first.stop(), second.stop()]);
      await waiting?.catch(() => undefined);
    }
  });

  it("allows independent hosts to use available memory without imposing a run quota", async () => {
    cgroupFiles(0);
    vi.mocked(process.availableMemory).mockReturnValue(GiB);
    const hosts = [new RunExecutionHost(), new RunExecutionHost()];
    try {
      for (let index = 0; index < 20; index++)
        expect(await hosts[index % 2]!.execute(execute, { waitForCapacity: false })).toBe(true);
      expect(hosts.map((host) => host.activeCount)).toEqual([10, 10]);
    } finally {
      release();
      await Promise.all(hosts.map((host) => host.stop()));
    }
  });

  it("reserves the empty-process recovery attempt before calling reentrant work", async () => {
    cgroupFiles(0);
    const first = new RunExecutionHost();
    const second = new RunExecutionHost();
    const candidate = vi.fn(execute);
    let reentrant: Promise<boolean> | undefined;
    try {
      await first.execute(({ onRunStarted }) => {
        onRunStarted();
        reentrant = second.execute(candidate, { waitForCapacity: false });
        return released;
      });
      await expect(reentrant).resolves.toBe(false);
      expect(candidate).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  it("registers its resident lifetime before a callback synchronously stops the host", async () => {
    cgroupFiles(0);
    const host = new RunExecutionHost();
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await host.execute(({ onRunStarted }) => {
        stopping = host.stop().then(() => {
          stopped = true;
        });
        onRunStarted();
        return released;
      });
      expect(host.activeCount).toBe(1);
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(stopped).toBe(true);
      expect(host.activeCount).toBe(0);
    } finally {
      release();
      await stopping;
      await host.stop();
    }
  });

  it.each(["synchronous", "before handoff", "after handoff"] as const)(
    "releases process admission after a %s failure",
    async (stage) => {
      cgroupFiles(0);
      const first = new RunExecutionHost();
      const second = new RunExecutionHost();
      const third = new RunExecutionHost();
      const failure = new Error("synthetic execution failure");
      try {
        const failed = first.execute(
          stage === "synchronous"
            ? () => {
                throw failure;
              }
            : async ({ onRunStarted }) => {
                if (stage === "after handoff") onRunStarted();
                await Promise.resolve();
                throw failure;
              },
        );
        if (stage === "after handoff") await expect(failed).resolves.toBe(true);
        else await expect(failed).rejects.toBe(failure);
        await first.stop();
        expect(first.activeCount).toBe(0);
        await expect(second.execute(execute, { waitForCapacity: false })).resolves.toBe(true);
        await expect(third.execute(execute, { waitForCapacity: false })).resolves.toBe(false);
      } finally {
        release();
        await Promise.all([first.stop(), second.stop(), third.stop()]);
      }
    },
  );
});
