const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;

/** Bound a read without changing the lifetime of its thread subscription. */
export async function readThreadSnapshot<T>(
  parent: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS);
  const signal = AbortSignal.any([parent, timeout]);
  try {
    return await read(signal);
  } catch (error) {
    if (parent.aborted || !timeout.aborted || signal.reason !== timeout.reason) throw error;
    let aborted = false;
    let current = error;
    for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
      const status = (current as { status?: unknown }).status;
      if (typeof status === "number" && status >= 400 && status < 500) throw error;
      aborted ||= current.name === "AbortError";
      current = current.cause;
    }
    // Body decoding can replace the request's timeout reason with AbortError.
    if (aborted) throw timeout.reason;
    throw error;
  }
}
