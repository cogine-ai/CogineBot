/** Repeat a visible surface's attendance check without overlapping requests or retaining hidden work.
 * The caller confirms the current target is running before sending provider attendance. */
export function createComputerHeartbeat(options: {
  ping: (signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
}) {
  let enabled = false;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function ping() {
    if (disposed || !enabled || pending) return;
    const requestGeneration = generation;
    const request = new AbortController();
    pending = request;
    try {
      await options.ping(request.signal);
    } catch {
      // A transient attendance failure does not change computer or control ownership.
    } finally {
      pending = undefined;
      if (!disposed && enabled) {
        if (requestGeneration !== generation) {
          // Wait out transports that ignored abort before attending the new visible epoch.
          void ping();
        } else {
          timer = setTimeout(() => void ping(), options.intervalMs ?? 60_000);
        }
      }
    }
  }

  function setEnabled(value: boolean) {
    if (disposed || enabled === value) return;
    enabled = value;
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    if (enabled) void ping();
    else pending?.abort();
  }

  return {
    setEnabled,
    dispose() {
      setEnabled(false);
      disposed = true;
    },
  };
}
