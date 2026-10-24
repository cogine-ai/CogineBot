import type { BotCreationDraft, BotTemplateSelection } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TEMPLATES,
  BOT_TITLE_MAX_LENGTH,
  botTemplateDraft,
} from "@rakazo/contracts";
import type { BotCreationReceipt } from "@rakazo/core";
import { BotCreationError } from "@rakazo/core";
import { Stack, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput } from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { NativeActionButton } from "../components/native-action-button";
import { cancelHeaderOptions } from "../components/sheet-header";
import type { MobileBotCreation } from "../lib/bot-template-creation";
import { mobileBotCreation } from "../lib/bot-template-creation";
import { rememberMobileBotExample } from "../lib/bot-template-examples";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { captureMobileScope, mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { native, useMobileTokens } from "../lib/native";
import { currentReadySessionGeneration, subscribeSessionGeneration } from "../lib/session";
import { errorText } from "../lib/user-error";

export default function NewBot() {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [scopeKey]);
  const ready = useSyncExternalStore(
    subscribeSessionGeneration,
    currentReadySessionGeneration,
    currentReadySessionGeneration,
  );
  return ready === scope.sessionGeneration ? (
    <NewBotEditor key={scopeKey} scope={scope} />
  ) : (
    <ActivityIndicator />
  );
}

function NewBotEditor({ scope }: { scope: MobileScope }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [draft, setDraft] = useState(() => botTemplateDraft(null));
  const live = useRef({ draft, version: 0, template: null as BotTemplateSelection | null });
  const [selection, setSelection] = useState<string | null>(null);
  const [client, setClient] = useState<MobileBotCreation | null>(null);
  const [initialization, setInitialization] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<BotCreationReceipt | null>(null);
  const closed = useRef(false);
  useEffect(() => {
    let active = true;
    closed.current = false;
    setClient(null);
    void mobileBotCreation(scope, () => active && !closed.current)
      .then((next) => {
        if (active && next.isCurrent()) setClient(next);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, t("Could not create bot")));
      });
    return () => {
      active = false;
    };
  }, [scope, initialization, t]);

  function update(patch: Partial<BotCreationDraft>) {
    const next = { ...live.current.draft, ...patch };
    live.current = { ...live.current, draft: next, version: live.current.version + 1 };
    setDraft(next);
  }
  function choose(templateId: string | null) {
    const template = BOT_TEMPLATES.find((item) => item.templateId === templateId) ?? null;
    const next = botTemplateDraft(template);
    live.current = {
      draft: next,
      version: live.current.version + 1,
      template: template ? { templateId: template.templateId, version: template.version } : null,
    };
    setSelection(template?.templateId ?? null);
    setDraft(next);
  }
  function close() {
    closed.current = true;
    if (router.canDismiss()) router.dismiss();
    else if (router.canGoBack()) router.back();
    else router.replace("/");
  }
  function open(botReceipt: BotCreationReceipt) {
    if (!client?.isCurrent()) return;
    closed.current = true;
    router.replace({
      pathname: "/thread",
      params: { botId: botReceipt.bot.id, name: botReceipt.bot.name },
    });
  }
  async function create(another = false) {
    if (!client?.isCurrent() || client.creator.status() === "pending") return;
    const retrying = client.creator.status() === "unknown";
    if (!retrying && !live.current.draft.name.trim()) return;
    if (!retrying && live.current.draft.instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
      setError(
        t("Instructions must be at most {count} characters", {
          count: BOT_INSTRUCTIONS_MAX_LENGTH,
        }),
      );
      return;
    }
    if (another) {
      client.creator.startAnother();
      setReceipt(null);
    }
    setPending(true);
    setError(null);
    try {
      const next = await client.creator.submit({
        draft: live.current.draft,
        draftVersion: live.current.version,
        template: live.current.template,
      });
      if (!client.isCurrent()) return;
      rememberMobileBotExample(scope, client.userId, next, client.isCurrent);
      setReceipt(next);
      if (live.current.version === next.submitted.draftVersion) open(next);
    } catch (err) {
      if (!client.isCurrent()) return;
      setError(
        err instanceof BotCreationError && err.code === "archived_recovery"
          ? t("This bot is archived.")
          : errorText(err, t("Could not create bot")),
      );
    } finally {
      if (client.isCurrent()) setPending(false);
    }
  }
  const confirmed = client?.creator.status() === "confirmed";
  const fieldStyle = {
    marginTop: 8,
    backgroundColor: native.fill,
    borderRadius: 11,
    padding: 16,
    color: tokens.foreground,
  };
  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t("Cancel"), close)} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <NativeActionButton
          label={t("Blank bot")}
          selected={selection === null}
          prominence="quiet"
          onPress={() => choose(null)}
        />
        {BOT_TEMPLATES.map((template) => (
          <NativeActionButton
            key={template.templateId}
            label={template.name}
            selected={selection === template.templateId}
            prominence="quiet"
            onPress={() => choose(template.templateId)}
          />
        ))}
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Name")}
        </Text>
        <TextInput
          accessibilityLabel={t("Name this bot")}
          value={draft.name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={(name) => update({ name })}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={fieldStyle}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          accessibilityLabel={t("Describe what this bot does")}
          value={draft.title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={(title) => update({ title })}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={fieldStyle}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          accessibilityLabel={t("What this bot is for")}
          value={draft.description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={(description) => update({ description })}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{ ...fieldStyle, minHeight: 120, textAlignVertical: "top" }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Instructions")}
        </Text>
        <TextInput
          accessibilityLabel={t("Instructions")}
          value={draft.instructions}
          onChangeText={(instructions) => update({ instructions })}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{ ...fieldStyle, minHeight: 120, textAlignVertical: "top" }}
        />
        <ComputerModePicker
          value={draft.computerMode}
          onChange={(computerMode) => update({ computerMode })}
        />
        {selection === "email-draft-v1" ? (
          <>
            <Text style={{ color: tokens.mutedForeground, marginTop: 16 }}>
              {t("Gmail or Outlook (optional)")}
            </Text>
            <NativeActionButton
              label={t("Connect an email account")}
              prominence="quiet"
              disabled={pending}
              onPress={() =>
                router.push({ pathname: "/(settings)/integrations", params: { accountOnly: "1" } })
              }
            />
          </>
        ) : null}
        {receipt ? (
          <Text style={{ color: tokens.foreground, marginTop: 16 }}>
            {t("Bot created. Your edits are kept.")}
          </Text>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        {receipt ? (
          <NativeActionButton
            label={t("Open bot")}
            onPress={() => open(receipt)}
            style={{ marginTop: 16 }}
          />
        ) : null}
        {!client && error ? (
          <NativeActionButton
            label={t("Retry")}
            onPress={() => {
              setError(null);
              setInitialization((n) => n + 1);
            }}
          />
        ) : null}
        <NativeActionButton
          disabled={
            pending || !client || (client.creator.status() !== "unknown" && !draft.name.trim())
          }
          label={
            pending
              ? t("Creating…")
              : confirmed
                ? t("Create another bot")
                : client?.creator.status() === "unknown"
                  ? t("Retry")
                  : t("Create")
          }
          onPress={() => void create(confirmed)}
          style={{ marginTop: 24 }}
        />
      </ScrollView>
    </>
  );
}
