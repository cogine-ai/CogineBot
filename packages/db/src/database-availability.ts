import { isDatabaseUnavailable } from "./client.js";

/** Only repeat database work that is safe after a lost acknowledgement, such as a fenced write. */
export async function retryWhileDatabaseUnavailable<T>(
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.waitMs ?? 90_000);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        options.signal?.aborted ||
        Date.now() >= deadline ||
        !isDatabaseUnavailable(error, { fromDatabaseConnection: true })
      )
        throw error;
      await sleep(Math.min(5_000, 200 * 2 ** Math.min(attempt, 8)));
      if (options.signal?.aborted) throw error;
    }
  }
}
