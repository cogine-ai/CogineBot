import type {
  Bot,
  ExternalConversation,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
} from "@rakazo/contracts";
import { createMessagingSettings } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { captureApiRequestContext, rpc } from "./api";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";

export function useMessagingSession() {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey);
  const focus = useRef(0);
  const [bound, setBound] = useState<{
    scopeKey: string;
    id: number;
    session: ReturnType<typeof createMessagingSettings>;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      const scope = captureMobileScope();
      const controller = new AbortController();
      const current = () => !controller.signal.aborted && isMobileScopeCurrent(scope);
      const context = captureApiRequestContext(scope.spaceId);
      async function call<T>(procedure: string, input: unknown = {}) {
        const captured = await context;
        if (!current()) throw new Error("Request canceled");
        return rpc<T>(procedure, input, {
          signal: controller.signal,
          requestContext: { ...captured, isCurrent: current },
        });
      }
      const next = createMessagingSettings(
        {
          status: () => call<MessagingStatus>("messaging/status"),
          channels: () => call<MessagingChannelMembership[]>("messaging/channels/list"),
          connections: () => call<MessagingAgentConnection[]>("messaging/connections/list"),
          bots: async () => {
            const [active, archived] = await Promise.all([
              call<Bot[]>("bots/list"),
              call<Bot[]>("bots/listArchived"),
            ]);
            return [...active, ...archived];
          },
          conversations: async () => {
            const navigation = await call<{
              current: { id: string; externalConversations: ExternalConversation[] };
            }>("spaces/list");
            if (scope.spaceId && navigation.current.id !== scope.spaceId)
              throw new Error("Space changed");
            return navigation.current.externalConversations;
          },
          link: (botId) => call("messaging/link/start", { botId }),
          mutate: call,
        },
        current,
      );
      setBound({ scopeKey, id: ++focus.current, session: next });
      void next.refresh();
      return () => {
        controller.abort();
        next.dispose();
        setBound(null);
      };
    }, [scopeKey]),
  );
  // Hide the previous scope synchronously, before focus-effect cleanup.
  return bound?.scopeKey === scopeKey ? bound : null;
}
