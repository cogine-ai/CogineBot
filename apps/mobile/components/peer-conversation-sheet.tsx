import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { PeerMessage } from "@rakazo/core";
import { formatMessageTime } from "@rakazo/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Modal, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { isMobileScopeCurrent, mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import type { PeerConversationState, PeerConversationTarget } from "../lib/peer-conversation";
import { runPeerConversation } from "../lib/peer-conversation";
import { BotAvatar } from "./bot-avatar";
import { NativeActionButton } from "./native-action-button";

export function PeerConversationSheet({
  target,
  scope,
  onClose,
}: {
  target: PeerConversationTarget;
  scope: MobileScope;
  onClose: () => void;
}) {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  if (!isMobileScopeCurrent(scope)) return null;
  return (
    <PeerConversationContent
      key={JSON.stringify([scopeKey, target])}
      target={target}
      scope={scope}
      onClose={onClose}
    />
  );
}

function PeerConversationContent({
  target,
  scope,
  onClose,
}: {
  target: PeerConversationTarget;
  scope: MobileScope;
  onClose: () => void;
}) {
  const tokens = useMobileTokens();
  const { t, locale } = useI18n();
  const [state, setState] = useState<PeerConversationState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void runPeerConversation({ target, scope, signal: abort.signal, onState: setState });
    return () => abort.abort();
  }, [target, scope, attempt]);
  const messages = state.status === "ready" ? (state.conversation?.messages ?? []) : [];
  const peerName =
    state.status === "ready"
      ? (state.conversation?.peerBotName ?? target.peerBotName)
      : target.peerBotName;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.root, { backgroundColor: tokens.background }]}>
        <View style={styles.header}>
          <BotAvatar color={target.botColor} identity={target.botId} size={24} />
          <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
            {target.botName} · {peerName}
          </Text>
          <BotAvatar color={target.peerBotColor} identity={target.peerBotId} size={24} />
          <NativeActionButton label={t("Close chat")} prominence="plain" onPress={onClose} />
        </View>
        {state.status === "loading" ? (
          <ActivityIndicator accessibilityLabel={t("Loading…")} />
        ) : null}
        {state.status === "error" ? (
          <View style={styles.notice}>
            <Text style={{ color: tokens.mutedForeground }}>{t("Could not load this chat.")}</Text>
            <NativeActionButton
              label={t("Retry now")}
              prominence="plain"
              onPress={() => setAttempt((value) => value + 1)}
            />
          </View>
        ) : null}
        {state.status === "ready" && !messages.length ? (
          <Text style={[styles.notice, { color: tokens.mutedForeground }]}>
            {t("No messages with {peerBotName} yet.", { peerBotName: peerName })}
          </Text>
        ) : null}
        <FlatList<PeerMessage>
          testID="peer-conversation-transcript"
          style={styles.root}
          contentContainerStyle={styles.transcript}
          inverted
          data={[...messages].reverse()}
          keyExtractor={(message) => message.id}
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 40 }}
          renderItem={({ item }) => {
            const sent = item.direction === "sent";
            return (
              <View style={styles.message}>
                <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                  {sent ? target.botName : peerName} · {formatMessageTime(item.createdAt, locale)}
                </Text>
                <View style={[styles.bubble, { backgroundColor: tokens.muted }]}>
                  <ChatMarkdown>{item.text}</ChatMarkdown>
                </View>
              </View>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, padding: 16 },
  title: { flex: 1, fontSize: 15, fontWeight: "600" },
  transcript: { padding: 16, gap: 20 },
  message: { gap: 6, alignItems: "flex-start" },
  bubble: { borderRadius: 16, padding: 12, maxWidth: "95%" },
  notice: { padding: 16, alignItems: "center", gap: 8 },
});
