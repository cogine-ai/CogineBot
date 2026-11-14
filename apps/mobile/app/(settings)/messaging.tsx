import type {
  AutomatedSenderPolicyMode,
  Bot,
  ExternalConversation,
  ExternalConversationPolicy,
} from "@rakazo/contracts";
import { ExternalConversationPolicySchema } from "@rakazo/contracts";
import type { createMessagingSettings } from "@rakazo/core";
import { currentSpaceMessagingIdentities, validConnectionVersion } from "@rakazo/core";
import { useState, useSyncExternalStore } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { useMessagingSession } from "../../lib/messaging-settings";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";

type Session = ReturnType<typeof createMessagingSettings>;

export default function Messaging() {
  const bound = useMessagingSession();
  return bound ? <MessagingContent key={bound.id} session={bound.session} /> : null;
}

function MessagingContent({ session }: { session: Session }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const data = state.data;
  const identities = data ? currentSpaceMessagingIdentities(data.status, data.bots) : [];
  const conversation = data?.conversations.find((row) => row.id === selected);
  const bot = data?.bots.find((row) => row.id === conversation?.botId);
  const button = (label: string, action: () => void, disabled = false) => (
    <NativeActionButton
      label={label}
      disabled={state.busy || disabled}
      onPress={action}
      fill={false}
      prominence="secondary"
    />
  );
  const statusLabel = (status: string) => {
    switch (status) {
      case "invited":
      case "pending":
        return t("Pending");
      case "approved":
        return t("Connected");
      case "declined":
        return t("Declined");
      case "left":
        return t("Left channel");
      case "revoked":
        return t("Revoked");
      default:
        return "";
    }
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {state.error ? (
          <View style={styles.card}>
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {state.error === "expired"
                ? t("Link code expired. Try again.")
                : state.error === "poll"
                  ? t("Could not check the connection.")
                  : state.error === "load"
                    ? t("Couldn't load messaging settings")
                    : t("Couldn't update messaging settings")}
            </Text>
            {button(t("Retry"), () => void session.refresh())}
          </View>
        ) : null}
        {!data && !state.error ? <Text style={styles.secondary}>{t("Loading…")}</Text> : null}
        {data ? (
          <>
            <View style={styles.card}>
              <Text style={styles.title}>{t("Chat apps")}</Text>
              {!identities.length ? (
                <Text style={styles.secondary}>{t("No chat apps linked yet.")}</Text>
              ) : null}
              {identities.map((identity) => (
                <View key={identity.id} style={styles.row}>
                  <Text style={styles.text}>
                    {identity.provider} · {identity.address} → {identity.botName}
                  </Text>
                  {button(
                    t("Unlink"),
                    () =>
                      void session.mutate("messaging/identities/unlink", {
                        identityId: identity.id,
                      }),
                  )}
                </View>
              ))}
              <MenuPicker
                label={t("Bot to link")}
                value={state.botId}
                choices={[
                  { key: "", label: t("Choose a bot…") },
                  ...data.bots
                    .filter((row) => !row.archivedAt)
                    .map((row) => ({ key: row.id, label: row.name })),
                ]}
                onChange={session.selectBot}
              />
              {button(
                t("Link a chat app"),
                () => void session.startLink(),
                !state.botId || !data.status.providers.length,
              )}
              {state.link ? (
                <Text selectable style={styles.text}>
                  {t("Send {code} to the line from your chat app before {time}.", {
                    code: state.link.code,
                    time: new Date(state.link.expiresAt).toLocaleTimeString(dateLocaleForUi()),
                  })}
                </Text>
              ) : null}
            </View>
            <View style={styles.card}>
              <Text style={styles.title}>{t("Channels")}</Text>
              {!data.channels.length ? (
                <Text style={styles.secondary}>{t("No group chats yet.")}</Text>
              ) : null}
              {data.channels.map((channel) => (
                <View key={channel.id} style={styles.row}>
                  <Text style={styles.text}>
                    {channel.name ?? t("Group")} · {channel.provider} ·{" "}
                    {
                      data.status.identities.find((identity) => identity.id === channel.identityId)
                        ?.botName
                    }{" "}
                    · {statusLabel(channel.status)}
                  </Text>
                  {channel.status === "invited" ? (
                    <View style={styles.actions}>
                      {button(
                        t("Approve"),
                        () =>
                          void session.mutate("messaging/channels/respond", {
                            membershipId: channel.id,
                            accept: true,
                          }),
                      )}
                      {button(
                        t("Decline"),
                        () =>
                          void session.mutate("messaging/channels/respond", {
                            membershipId: channel.id,
                            accept: false,
                          }),
                      )}
                    </View>
                  ) : channel.status === "approved" ? (
                    button(
                      t("Leave"),
                      () =>
                        void session.mutate("messaging/channels/leave", {
                          membershipId: channel.id,
                        }),
                    )
                  ) : null}
                </View>
              ))}
            </View>
            <View style={styles.card}>
              <Text style={styles.title}>{t("Agent connections")}</Text>
              {!data.connections.length ? (
                <Text style={styles.secondary}>{t("No agent connections yet.")}</Text>
              ) : null}
              {data.connections.map((connection) => (
                <View key={connection.id} style={styles.row}>
                  <Text style={styles.text}>
                    {connection.peerOwnerLabel} · {connection.peerBotName} ·{" "}
                    {statusLabel(connection.status)}
                  </Text>
                  <View style={styles.actions}>
                    {connection.status === "pending" && connection.incoming ? (
                      <>
                        {button(
                          t("Approve"),
                          () =>
                            void session.mutate("messaging/connections/respond", {
                              connectionId: connection.id,
                              requestVersion: connection.requestVersion,
                              accept: true,
                            }),
                          !validConnectionVersion(connection),
                        )}
                        {button(
                          t("Decline"),
                          () =>
                            void session.mutate("messaging/connections/respond", {
                              connectionId: connection.id,
                              requestVersion: connection.requestVersion,
                              accept: false,
                            }),
                          !validConnectionVersion(connection),
                        )}
                      </>
                    ) : null}
                    {connection.status === "approved" ||
                    (connection.status === "pending" && !connection.incoming)
                      ? button(
                          t("Revoke"),
                          () =>
                            void session.mutate("messaging/connections/revoke", {
                              connectionId: connection.id,
                              requestVersion: connection.requestVersion,
                            }),
                          !validConnectionVersion(connection),
                        )
                      : null}
                  </View>
                </View>
              ))}
            </View>
            <View style={styles.card}>
              <Text style={styles.title}>{t("Team conversations")}</Text>
              {!data.conversations.length ? (
                <Text style={styles.secondary}>{t("No team conversations yet.")}</Text>
              ) : null}
              <MenuPicker
                label={t("External conversation")}
                value={selected ?? ""}
                choices={[
                  { key: "", label: t("Choose…") },
                  ...data.conversations.map((row) => ({
                    key: row.id,
                    label: `${row.displayName ?? t("External conversation")} · ${row.provider}`,
                  })),
                ]}
                onChange={(id) => setSelected(id || null)}
                disabled={state.busy}
              />
              {conversation && bot ? (
                <PolicyEditor
                  key={conversation.id}
                  conversation={conversation}
                  bot={bot}
                  busy={state.busy}
                  save={(policy) => session.savePolicy(conversation.id, policy)}
                />
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function PolicyEditor({
  conversation,
  bot,
  busy,
  save,
}: {
  conversation: ExternalConversation;
  bot: Bot;
  busy: boolean;
  save: (policy: ExternalConversationPolicy) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [policy, setPolicy] = useState<ExternalConversationPolicy>(() => ({
    teamChatAmbientEnabled: conversation.teamChatAmbientEnabled,
    teamChatRules: conversation.teamChatRules,
    automatedSenderPolicies: conversation.automatedSenderPolicies,
  }));
  const [saved, setSaved] = useState(false);
  const [hours, setHours] = useState<Record<string, string>>({});
  function update(next: ExternalConversationPolicy) {
    setPolicy(next);
    setSaved(false);
  }
  const senders = [
    ...new Map([
      ...Object.entries(policy.automatedSenderPolicies).map(
        ([id, entry]) => [id, { id, name: entry.name }] as const,
      ),
      ...conversation.automatedSenders.map((sender) => [sender.id, sender] as const),
    ]).values(),
  ];
  const invalidHours = Object.entries(hours).some(
    ([id, value]) =>
      policy.automatedSenderPolicies[id]?.mode === "rollup" &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 720),
  );
  return (
    <View style={styles.row}>
      <Text style={styles.secondary}>
        {bot.name} · {conversation.participantNames.join(", ")}
      </Text>
      <MenuPicker
        label={t("Listening")}
        disabled={busy}
        value={
          policy.teamChatAmbientEnabled === null
            ? "inherit"
            : policy.teamChatAmbientEnabled
              ? "listen"
              : "mentions"
        }
        choices={[
          { key: "inherit", label: t("{name} default", { name: bot.name }) },
          { key: "listen", label: t("Listen") },
          { key: "mentions", label: t("Mentions only") },
        ]}
        onChange={(mode) =>
          update({
            ...policy,
            teamChatAmbientEnabled: mode === "inherit" ? null : mode === "listen",
          })
        }
      />
      <Text style={styles.title}>{t("Room guidance")}</Text>
      {policy.teamChatRules === null ? (
        <Text style={styles.secondary}>{t("{name} default", { name: bot.name })}</Text>
      ) : (
        <NativeActionButton
          label={t("Use default guidance")}
          disabled={busy}
          fill={false}
          prominence="secondary"
          onPress={() => update({ ...policy, teamChatRules: null })}
        />
      )}
      <TextInput
        accessibilityLabel={t("Room guidance")}
        editable={!busy}
        multiline
        maxLength={4000}
        style={styles.input}
        value={policy.teamChatRules ?? bot.teamChatRules}
        onChangeText={(value) => update({ ...policy, teamChatRules: value })}
      />
      <Text style={styles.title}>{t("Automated senders")}</Text>
      {!senders.length ? (
        <Text style={styles.secondary}>
          {t("Automated senders will appear after they post here.")}
        </Text>
      ) : null}
      {senders.map((sender) => {
        const entry = policy.automatedSenderPolicies[sender.id];
        return (
          <View key={sender.id} style={styles.row}>
            <MenuPicker
              label={sender.name}
              disabled={busy}
              value={entry?.mode ?? "default"}
              choices={[
                { key: "default", label: t("Default") },
                { key: "ignore", label: t("Ignore") },
                { key: "rollup", label: t("Group updates") },
                { key: "action", label: t("Always act") },
                { key: "user", label: t("Treat like a person") },
              ]}
              onChange={(mode) => {
                const policies = { ...policy.automatedSenderPolicies };
                if (mode === "default") delete policies[sender.id];
                else
                  policies[sender.id] = {
                    name: sender.name,
                    mode: mode as AutomatedSenderPolicyMode,
                    ...(mode === "rollup" ? { rollupHours: entry?.rollupHours ?? 6 } : {}),
                  };
                setHours((values) => {
                  const next = { ...values };
                  delete next[sender.id];
                  return next;
                });
                update({ ...policy, automatedSenderPolicies: policies });
              }}
            />
            {entry?.mode === "rollup" ? (
              <>
                <Text style={styles.secondary}>{t("Rollup hours (1–720)")}</Text>
                <TextInput
                  accessibilityLabel={t("{name} rollup hours", { name: sender.name })}
                  editable={!busy}
                  keyboardType="number-pad"
                  style={styles.input}
                  value={hours[sender.id] ?? String(entry.rollupHours ?? 6)}
                  onChangeText={(value) => {
                    setHours((values) => ({ ...values, [sender.id]: value }));
                    update({
                      ...policy,
                      automatedSenderPolicies: {
                        ...policy.automatedSenderPolicies,
                        [sender.id]: { ...entry, rollupHours: Number(value) },
                      },
                    });
                  }}
                />
              </>
            ) : null}
          </View>
        );
      })}
      <NativeActionButton
        label={t("Save")}
        busy={busy}
        disabled={invalidHours || !ExternalConversationPolicySchema.safeParse(policy).success}
        onPress={() => {
          setSaved(false);
          void save(policy).then(setSaved);
        }}
      />
      {saved ? (
        <Text accessibilityLiveRegion="polite" style={styles.secondary}>
          {t("Saved")}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 16 },
    card: { padding: 16, gap: 12, borderRadius: 16, backgroundColor: native.fill },
    row: { gap: 10 },
    title: { color: native.label, fontSize: 16, fontWeight: "600" },
    text: { color: native.label, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    input: {
      minHeight: 48,
      color: native.label,
      backgroundColor: native.fillPressed,
      borderRadius: 12,
      padding: 12,
      fontSize: 15,
    },
  });
}
