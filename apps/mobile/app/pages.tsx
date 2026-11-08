import { MenuView } from "@expo/ui/community/menu";
import { PageIcon } from "@rakazo/chat-ui/native";
import type { PageSummary } from "@rakazo/contracts";
import { PAGE_LIST_QUERY_MAX_LENGTH, PAGE_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { useTextEditDialog } from "../components/profile-edit-dialog";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { formatActivityRelativeTime } from "../lib/activity";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { pageScopeKey, pinPage, removePage, renamePage, subscribePageScope } from "../lib/pages";
import { useOpenPrivatePage } from "../lib/use-open-page";
import { usePagedPages } from "../lib/use-paged-pages";

/** The bot's pages, pinned first and then most recently updated. */
export default function PagesScreen() {
  const { botId, groupId } = useLocalSearchParams<{ botId?: string; groupId?: string }>();
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  return (
    <OwnerPages
      key={JSON.stringify([scope, botId, groupId])}
      scope={scope}
      botId={botId}
      groupId={groupId}
    />
  );
}

function OwnerPages({
  scope,
  botId,
  groupId,
}: {
  scope: string;
  botId?: string;
  groupId?: string;
}) {
  const openPage = useOpenPrivatePage();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [query, setQuery] = useState("");
  const { listed, showMore, refresh } = usePagedPages({ botId, groupId }, query);
  const [problem, setProblem] = useState<string | null>(null);
  const rename = useTextEditDialog(
    t("Rename"),
    PAGE_TITLE_MAX_LENGTH,
    () => scope === pageScopeKey(),
  );

  const open = (page: PageSummary) => openPage(page.id);
  // A failed change may still have been made with only its answer lost: the list is read again.
  const failed = (message: string) => () => {
    if (scope !== pageScopeKey()) return;
    setProblem(message);
    refresh();
  };
  const act = (page: PageSummary, action: string) => {
    if (scope !== pageScopeKey()) return;
    setProblem(null);
    if (action === "open") open(page);
    else if (action === "share")
      router.push({ pathname: "/page-share", params: { pageId: page.id } });
    else if (action === "rename") {
      rename.ask(page.title, (title) => {
        if (scope !== pageScopeKey() || !title || title === page.title) return;
        void renamePage(page.id, title).then(refresh, failed(t("Could not rename the page.")));
      });
    } else if (action === "pin") {
      void pinPage(page.id, !page.pinned).then(refresh, failed(t("Could not pin the page.")));
    } else if (action === "delete") {
      Alert.alert(t("Delete {name}?", { name: page.title }), t("This cannot be undone."), [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => {
            if (scope === pageScopeKey())
              void removePage(page.id).then(refresh, failed(t("Could not delete the page.")));
          },
        },
      ]);
    }
  };
  const row = (page: PageSummary) => (
    <MenuView
      key={page.id}
      shouldOpenOnLongPress
      colorScheme={colorScheme}
      title={page.title}
      actions={[
        { id: "open", title: t("Open") },
        { id: "share", title: t("Share") },
        { id: "rename", title: t("Rename") },
        { id: "pin", title: page.pinned ? t("Unpin") : t("Pin") },
        { id: "delete", title: t("Delete"), attributes: { destructive: true } },
      ]}
      onPressAction={(event) => act(page, event.nativeEvent.event)}
    >
      <SettingsRow
        accessibilityRole="button"
        chevron="right"
        title={page.title}
        detail={`${page.sharedByLink ? `${t("Shared")} · ` : ""}${formatActivityRelativeTime(page.updatedAt)}`}
        leading={<PageIcon colors={tokens} width={26} />}
        onPress={() => open(page)}
      />
    </MenuView>
  );
  const items = listed.status === "ready" ? listed.items : [];
  const pinned = items.filter((page) => page.pinned);
  const rest = items.filter((page) => !page.pinned);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <TextInput
        accessibilityLabel={t("Find a page")}
        placeholder={t("Find a page")}
        placeholderTextColor={tokens.mutedForeground}
        value={query}
        maxLength={PAGE_LIST_QUERY_MAX_LENGTH}
        onChangeText={(value) =>
          setQuery(value.slice(0, PAGE_LIST_QUERY_MAX_LENGTH).replace(/[\uD800-\uDBFF]$/u, ""))
        }
        style={[styles.search, { color: tokens.foreground, backgroundColor: tokens.muted }]}
      />
      {listed.status === "loading" ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {listed.status === "error" ? (
        <PageLoadFailure
          error={listed.error}
          fallback={t("Could not load pages.")}
          onRetry={refresh}
        />
      ) : null}
      {listed.status === "ready" && items.length === 0 ? (
        <Text style={[styles.message, { color: tokens.mutedForeground }]}>
          {query.trim()
            ? t("No pages match.")
            : groupId
              ? t("Pages this group builds for you appear here.")
              : t("Pages this bot builds for you appear here.")}
        </Text>
      ) : null}
      {problem ? (
        <Text accessibilityRole="alert" style={[styles.problem, { color: tokens.destructive }]}>
          {problem}
        </Text>
      ) : null}
      {pinned.length ? <SettingsGroup label={t("Pinned")}>{pinned.map(row)}</SettingsGroup> : null}
      {rest.length ? <SettingsGroup>{rest.map(row)}</SettingsGroup> : null}
      {rename.dialog}
      {listed.status === "ready" && listed.nextCursor ? (
        <SettingsGroup>
          <SettingsRow
            key="more"
            accessibilityRole="button"
            title={t("Show more")}
            onPress={() =>
              void showMore().catch(() => {
                if (scope === pageScopeKey()) setProblem(t("Could not load pages."));
              })
            }
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  search: {
    marginHorizontal: 20,
    marginVertical: 12,
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  message: { fontSize: 15, textAlign: "center", padding: 24 },
  problem: { paddingHorizontal: 20, paddingTop: 12, fontSize: 13 },
});
