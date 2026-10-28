import { afterEach, expect, it, vi } from "vitest";
import { createComputerHeartbeat } from "./computer-heartbeat.js";

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("waits for the visible caller to enable attendance and sends only one heartbeat per interval", async () => {
  vi.useFakeTimers();
  const ping = vi.fn().mockResolvedValue(undefined);
  const heartbeat = createComputerHeartbeat({ ping });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(ping).not.toHaveBeenCalled();
  heartbeat.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(ping).toHaveBeenCalledTimes(1);
  heartbeat.setEnabled(true);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(ping).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(ping).toHaveBeenCalledTimes(2);
  heartbeat.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap requests or burst after a long timer gap", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const ping = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const heartbeat = createComputerHeartbeat({ ping });
  heartbeat.setEnabled(true);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(ping).toHaveBeenCalledTimes(1);
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(ping).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ping).toHaveBeenCalledTimes(2);
  heartbeat.dispose();
});

it("aborts hidden attendance and ignores its late completion after resuming", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const ping = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const heartbeat = createComputerHeartbeat({ ping });
  heartbeat.setEnabled(true);
  const signal = ping.mock.calls[0]![0] as AbortSignal;
  heartbeat.setEnabled(false);
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  heartbeat.setEnabled(true);
  // A transport that ignores abort must still not overlap another request.
  expect(ping).toHaveBeenCalledTimes(1);
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(ping).toHaveBeenCalledTimes(2);
  heartbeat.setEnabled(false);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(ping).toHaveBeenCalledTimes(2);
  heartbeat.dispose();
});

it("recovers after a rejected request and cannot restart after disposal", async () => {
  vi.useFakeTimers();
  const ping = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const heartbeat = createComputerHeartbeat({ ping });
  heartbeat.setEnabled(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ping).toHaveBeenCalledTimes(2);
  heartbeat.dispose();
  heartbeat.setEnabled(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(ping).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps multiple visible viewers independent", async () => {
  vi.useFakeTimers();
  const pingA = vi.fn().mockResolvedValue(undefined);
  const pingB = vi.fn().mockResolvedValue(undefined);
  const a = createComputerHeartbeat({ ping: pingA });
  const b = createComputerHeartbeat({ ping: pingB });
  a.setEnabled(true);
  b.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  a.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pingA).toHaveBeenCalledTimes(1);
  expect(pingB).toHaveBeenCalledTimes(2);
  b.dispose();
});
