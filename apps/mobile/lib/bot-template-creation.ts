import type { Bot } from "@rakazo/contracts";
import { BotCreationError, createBotCreation } from "@rakazo/core";
import type { MobileMe } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import type { MobileScope } from "./mobile-scope";
import { isMobileScopeCurrent } from "./mobile-scope";
import { currentReadySessionGeneration } from "./session";

export async function mobileBotCreation(scope: MobileScope, isMounted: () => boolean) {
  const isCurrent = () =>
    isMounted() &&
    isMobileScopeCurrent(scope) &&
    currentReadySessionGeneration() === scope.sessionGeneration;
  const assertCurrent = () => {
    if (!isCurrent()) throw new BotCreationError("closed");
  };
  assertCurrent();
  const context = await captureApiRequestContext(scope.spaceId);
  assertCurrent();
  if (context.apiBase !== scope.apiBase || context.sessionGeneration !== scope.sessionGeneration)
    throw new BotCreationError("closed");
  const me = await rpc<MobileMe>(
    "me",
    {},
    { requestContext: context, skipSpaceAuthRecovery: true },
  );
  assertCurrent();
  if (
    typeof me.userId !== "string" ||
    !me.userId ||
    typeof me.spaceId !== "string" ||
    !me.spaceId ||
    (scope.spaceId && scope.spaceId !== me.spaceId)
  )
    throw new BotCreationError("closed");
  const requestContext = {
    ...context,
    headers: { ...context.headers, "x-rakazo-space-id": me.spaceId },
  };
  const request = async <T>(procedure: string, input: unknown = {}): Promise<T> => {
    assertCurrent();
    const value = await rpc<T>(procedure, input, { requestContext, skipSpaceAuthRecovery: true });
    assertCurrent();
    return value;
  };
  return {
    scope,
    userId: me.userId,
    isCurrent,
    creator: createBotCreation({
      spaceId: me.spaceId,
      create: (input) => request<Bot>("bots/create", input),
      list: async () => {
        const [active, archived] = await Promise.all([
          request<Bot[]>("bots/list"),
          request<Bot[]>("bots/listArchived"),
        ]);
        return [...active, ...archived];
      },
      makeNonce: () =>
        globalThis.crypto?.randomUUID?.() ??
        `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      isCurrent,
      // RPC errors can follow a committed write; only the shared local schema proves prewrite refusal.
      isAmbiguous: () => true,
    }),
  };
}

export type MobileBotCreation = Awaited<ReturnType<typeof mobileBotCreation>>;
