import type { BotSettingsHistory } from "@rakazo/chat-ui/bot-settings";
import { useBotSettingsCard } from "@rakazo/chat-ui/bot-settings";
import type {
  BotSettingsChange,
  MessageBlock,
  UndoBotSettingsInput,
  UndoBotSettingsResult,
} from "@rakazo/contracts";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

const client = {
  captureScope: captureMobileScope,
  isScopeCurrent: isMobileScopeCurrent,
  scopeKey: mobileScopeKey,
  subscribeScope: subscribeMobileScope,
  load: (botId: string, signal: AbortSignal) =>
    rpc<BotSettingsHistory>("bots/settingsHistory", { botId }, { signal }),
  undo: (request: ReturnType<typeof UndoBotSettingsInput.parse>, signal: AbortSignal) =>
    rpc<ReturnType<typeof UndoBotSettingsResult.parse>>("bots/undoSettings", request, { signal }),
};

function SettingsChange({
  change,
  label,
  current = false,
}: {
  change: BotSettingsChange;
  label: string;
  current?: boolean;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const instructions = change.field === "instructions";
  return (
    <View style={{ gap: 4 }}>
      {instructions ? (
        <NativeActionButton
          label={open ? t("Hide instructions") : label}
          prominence="plain"
          onPress={() => setOpen(!open)}
        />
      ) : (
        <Text style={{ fontWeight: "600", color: tokens.foreground }}>{label}</Text>
      )}
      {!instructions || open ? (
        <>
          {!current ? (
            <Text selectable style={{ color: tokens.mutedForeground }}>
              {t("Before")} · {change.before || "—"}
            </Text>
          ) : null}
          <Text selectable style={{ color: tokens.foreground }}>
            {current ? change.after || "—" : `${t("After")} · ${change.after || "—"}`}
          </Text>
        </>
      ) : null}
    </View>
  );
}

export function BotSettingsCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: Extract<MessageBlock, { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const settings = block.botSettings!;
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const activeAnswer = useRef(false);
  const [sending, setSending] = useState(false);
  const [answerFailed, setAnswerFailed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { history, pending, status, viewSettings, undo } = useBotSettingsCard(
    settings.botId,
    client,
  );
  const labels = {
    instructions: t("Instructions"),
    model: t("Model"),
    thinkingLevel: t("Thinking"),
    voice: t("Voice"),
    readAloud: t("Read aloud"),
  };
  const sources = {
    bot: t("This Bot"),
    space: t("This Space"),
    model: t("Model default"),
    system: t("System default"),
  };
  async function answer(choice: "allow" | "deny") {
    if (activeAnswer.current) return;
    activeAnswer.current = true;
    setSending(true);
    setAnswerFailed(false);
    try {
      await onAnswer(choice);
    } catch {
      setAnswerFailed(true);
    } finally {
      activeAnswer.current = false;
      setSending(false);
    }
  }
  const proposal = Boolean(block.approvalEffectId);
  const answered = block.status === "answered";
  const conflict = answered && !proposal && !settings.versionId;
  return (
    <View
      style={{
        width: "94%",
        padding: 14,
        borderWidth: 1,
        borderColor: tokens.border,
        borderRadius: 18,
        backgroundColor: tokens.card,
        gap: 8,
      }}
    >
      <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{block.text}</Text>
      <Text style={{ color: tokens.mutedForeground }}>
        {t("This Bot")} · {settings.botName}
      </Text>
      {settings.changes.map((change) => (
        <SettingsChange
          key={change.field}
          change={change}
          label={labels[change.field]}
          current={conflict}
        />
      ))}
      {!conflict &&
      settings.changes.some(({ field }) => field !== "voice" && field !== "readAloud") ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Applies to new runs.")}</Text>
      ) : null}
      {!conflict && settings.changes.some(({ field }) => field === "readAloud") ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Applies to new playback.")}</Text>
      ) : null}
      {!conflict && settings.changes.some(({ field }) => field === "voice") ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Provider voice applies to new playback.")}
        </Text>
      ) : null}
      {proposal ? (
        answered ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {block.answer === "allow" ? t("Confirmed") : t("Cancelled")}
          </Text>
        ) : canAnswer ? (
          <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
            <NativeActionButton
              label={t("Confirm")}
              disabled={sending}
              onPress={() => void answer("allow")}
            />
            <NativeActionButton
              label={t("Cancel")}
              prominence="plain"
              disabled={sending}
              onPress={() => void answer("deny")}
            />
          </View>
        ) : (
          <Text style={{ color: tokens.mutedForeground }}>{t("No longer active")}</Text>
        )
      ) : (
        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          <NativeActionButton
            label={
              history
                ? t("Refresh settings")
                : conflict
                  ? t("Review current settings")
                  : t("View settings")
            }
            prominence="plain"
            disabled={pending}
            onPress={() => void viewSettings()}
          />
          {settings.versionId &&
          settings.revision !== undefined &&
          status !== "updated" &&
          status !== "changed" &&
          status !== "connection" ? (
            <NativeActionButton
              label={t("Undo")}
              prominence="plain"
              disabled={pending}
              onPress={() => void undo(settings.versionId!, settings.revision!)}
            />
          ) : null}
        </View>
      )}
      {answerFailed ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.destructive }}>
          {t("Could not send answer")}
        </Text>
      ) : null}
      {status ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.mutedForeground }}>
          {status === "updated"
            ? t("Change undone")
            : status === "changed"
              ? t("Settings changed elsewhere.")
              : status === "connection"
                ? t("The previous connection is unavailable.")
                : t("Could not update settings. Try again.")}
        </Text>
      ) : null}
      {history ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
            {t("Current settings")}
          </Text>
          {history.current.map(({ field, after, source }) =>
            field === "instructions" ? (
              <SettingsChange
                key={field}
                label={labels[field]}
                change={{ field, before: after, after }}
                current
              />
            ) : (
              <Text key={field} style={{ color: tokens.foreground }}>
                {labels[field]} · {after} · {sources[source]}
              </Text>
            ),
          )}
          {history.versions.length ? (
            <NativeActionButton
              label={historyOpen ? t("Hide settings history") : t("Settings history")}
              prominence="plain"
              onPress={() => setHistoryOpen(!historyOpen)}
            />
          ) : null}
          {historyOpen
            ? history.versions.map((version) => (
                <View
                  key={version.id}
                  style={{
                    gap: 6,
                    borderTopWidth: 1,
                    borderTopColor: tokens.border,
                    paddingTop: 8,
                  }}
                >
                  <Text style={{ color: tokens.mutedForeground }}>
                    {new Date(version.createdAt).toLocaleString()}
                  </Text>
                  {version.changes.map((change) => (
                    <SettingsChange
                      key={change.field}
                      change={change}
                      label={labels[change.field]}
                    />
                  ))}
                  {version.canUndo ? (
                    <NativeActionButton
                      label={t("Undo")}
                      prominence="plain"
                      disabled={pending}
                      onPress={() => void undo(version.id, history.revision)}
                    />
                  ) : null}
                </View>
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}
