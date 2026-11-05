import type { Actor } from "@rakazo/contracts";
import { runAsTenant } from "@rakazo/db";

/** Keep the authenticated actor's scope while handling a procedure and reading its stream. */
export async function asTenant<T extends { output: unknown }>(
  actor: Actor,
  next: () => T | PromiseLike<T>,
): Promise<T> {
  const result = await runAsTenant(actor, next);
  const output = result.output;
  if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
  const iterator = output as AsyncIterator<unknown> & AsyncIterable<unknown>;
  const scoped: AsyncIterableIterator<unknown> = {
    next: (...args) => runAsTenant(actor, () => iterator.next(...args)),
    return: (value) =>
      runAsTenant(actor, () => iterator.return?.(value) ?? { done: true as const, value }),
    throw: (error) =>
      runAsTenant(actor, () => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
    [Symbol.asyncIterator]() {
      return scoped;
    },
  };
  return { ...result, output: scoped };
}
