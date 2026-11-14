import type { Bot, SpaceMemoryConfig, SpaceNavigation } from "@rakazo/contracts";
import { createSemanticMemorySettings } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { MobileMe } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";
import { createSpaceSettingsClient } from "./space-settings";

export function useSemanticMemorySession(spaceId?: string, botId?: string) {
  const scope = useSyncExternalStore(subscribeMobileScope, mobileScopeKey);
  const key = JSON.stringify([scope, spaceId, botId]);
  const generation = useRef(0);
  const [bound, setBound] = useState<{
    key: string;
    id: number;
    session: ReturnType<typeof createSemanticMemorySettings>;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      const origin = captureMobileScope();
      let target = spaceId ?? origin.spaceId;
      const controller = new AbortController();
      const current = () => !controller.signal.aborted && isMobileScopeCurrent(origin);
      let client: ReturnType<typeof createSpaceSettingsClient> | undefined;
      async function getClient() {
        if (!current()) throw new Error("Settings closed");
        if (!target) {
          const context = await captureApiRequestContext();
          if (!current()) throw new Error("Settings closed");
          const me = await rpc<MobileMe>(
            "me",
            {},
            {
              requestContext: { ...context, isCurrent: current },
              signal: controller.signal,
            },
          );
          if (!current()) throw new Error("Settings closed");
          target = me.spaceId;
        }
        client ??= createSpaceSettingsClient(target);
        return client;
      }
      async function call(procedure: string, input: unknown = {}) {
        return (await getClient()).rpc(procedure, input);
      }
      const session = createSemanticMemorySettings(
        {
          async read() {
            const client = await getClient();
            const me = await client.rpc<MobileMe>("me");
            const navigation = await client.rpc<SpaceNavigation>("spaces/list");
            if (me.spaceId !== target || navigation.current.id !== target)
              throw new Error("Space changed");
            const config = await client.rpc<SpaceMemoryConfig | null>("memory/providerConfig");
            const bot = botId ? await client.rpc<Bot>("bots/get", { botId }) : null;
            if (bot && (bot.id !== botId || bot.spaceId !== target)) throw new Error("Bot changed");
            return {
              config,
              bot,
              // This existing capability is granted only to the Space owner. The server
              // independently authorizes every write, including private endpoint ownership.
              canManage: navigation.spaces.find((space) => space.id === target)?.canRename === true,
            };
          },
          connect: (input) => call("memory/connectProvider", input),
          disconnect: () => call("memory/disconnectProvider"),
          setDefault: (defaultMemoryScope) =>
            call("memory/setDefaultScope", { defaultMemoryScope }),
          setBot: (id, memoryScope) => call("bots/update", { botId: id, memoryScope }),
        },
        current,
      );
      setBound({ key, id: ++generation.current, session });
      void session.refresh();
      return () => {
        controller.abort();
        client?.dispose();
        session.dispose();
        setBound(null);
      };
    }, [key, spaceId, botId]),
  );
  return bound?.key === key ? bound : null;
}
