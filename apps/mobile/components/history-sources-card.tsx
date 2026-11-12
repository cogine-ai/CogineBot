import { useHistorySources } from "@rakazo/chat-ui/history-sources";
import type { HistorySource, HistorySourceReference, MessageBlock } from "@rakazo/contracts";
import { useIsFocused, useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { captureMobileScope, isMobileScopeCurrent } from "../lib/mobile-scope";
import { useThemedStyles } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

const historySourceClient = {
  captureScope: captureMobileScope,
  isScopeCurrent: isMobileScopeCurrent,
  load: (references: HistorySourceReference[], signal: AbortSignal) =>
    rpc<HistorySource[]>("threads/historySources", { references }, { signal }),
};

export function HistorySourcesCard({
  block,
}: {
  block: Extract<MessageBlock, { kind: "history_sources" }>;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const styles = useThemedStyles(makeStyles);
  const { sources, unavailable, revalidate } = useHistorySources(
    block.references,
    historySourceClient,
    focused,
  );

  async function open(source: HistorySourceReference) {
    const row = await revalidate(source);
    if (!row) return;
    const { groupId, botId, chatName: name, messageId } = row;
    if (groupId) {
      router.push({ pathname: "/group-thread", params: { groupId, name, messageId } });
    } else if (botId) {
      router.push({ pathname: "/thread", params: { botId, name, messageId } });
    }
  }

  if (!sources.length && !unavailable) return null;
  const date = new Intl.DateTimeFormat(dateLocaleForUi(locale), { dateStyle: "medium" });
  return (
    <View style={styles.card}>
      {sources.map((source) => (
        <View key={source.messageId} style={styles.source}>
          <Text numberOfLines={1} style={styles.title}>
            {source.chatName} · {date.format(new Date(source.createdAt))}
          </Text>
          {source.text ? (
            <Text numberOfLines={3} style={styles.preview}>
              {source.text}
            </Text>
          ) : null}
          <NativeActionButton
            label={t("View original message")}
            prominence="plain"
            onPress={() => void open(source)}
          />
        </View>
      ))}
      {unavailable ? (
        <Text accessibilityLiveRegion="polite" style={styles.preview}>
          {t("This history source is no longer available.")}
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    card: {
      gap: 8,
      padding: 12,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: tokens.border,
      backgroundColor: tokens.card,
    },
    source: { gap: 4 },
    title: { color: tokens.foreground, fontWeight: "600" },
    preview: { color: tokens.mutedForeground },
  });
}
