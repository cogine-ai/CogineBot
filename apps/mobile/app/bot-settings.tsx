import type { ComputerMode, ThinkingLevel } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  isBotInstructionsConflict,
  normalizeCreateBotProfile,
  parseBotAvatarValue,
} from "@rakazo/contracts";
import {
  connectedModelChoices,
  credentialForModel,
  GAZE_BOT_COLORS,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Voice } from "expo-speech";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { glassHeaderOptions } from "../components/glass-title";
import type { MenuPickerChoice } from "../components/menu-picker";
import { MenuPicker, MenuPickerMenu } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSwitch } from "../components/native-switch";
import { NativeSymbol } from "../components/native-symbol";
import { Chevron } from "../components/row-accessories";
import type { MobileBot, MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { deviceVoices, setVoiceForBot, voiceForBot, voiceLabel } from "../lib/bot-voices";
import { COMPUTER_LIFECYCLE_TIMEOUT_MS } from "../lib/computer";
import { loadDeviceVoiceEnabled } from "../lib/device-voice";
import { useI18n } from "../lib/i18n";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { stopVoicePlayback } from "../lib/voice";

type BotSettingsRecord = MobileBot & {
  description?: string;
  instructions?: string;
};

export default function BotSettingsScreen() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState<string>(GAZE_BOT_COLORS[0]);
  const parsedColor = parseBotAvatarValue(color);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelKey, setModelKey] = useState("");
  const [modelRevision, setModelRevision] = useState<number | undefined>();
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [modelMetaError, setModelMetaError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instructionsConflict, setInstructionsConflict] = useState(false);
  const [deviceVoiceEnabled, setDeviceVoiceEnabled] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | undefined>();
  const savedVoiceId = useRef<string | undefined>(undefined);
  const voiceChoice = useRef(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const botLifetime = useRef(0);
  useLayoutEffect(() => {
    botLifetime.current += 1;
    return () => {
      botLifetime.current += 1;
    };
  }, [botId]);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    setBot(null);
    setPending(false);
    setError(null);
    setInstructionsConflict(false);
    void rpc<BotSettingsRecord>("bots/get", { botId })
      .then((next) => {
        if (cancelled) return;
        setBot(next);
        setModelRevision(undefined);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setInstructions(next.instructions ?? "");
        setInstructionsConflict(false);
        setColor(next.color);
        setComputerMode(next.computerMode);
        setModelKey(
          next.modelProvider && next.modelId
            ? modelOptionKey(next.modelProvider, next.modelId, next.modelCredentialId ?? undefined)
            : "",
        );
        setThinkingLevel(next.thinkingLevel ?? "");
        setAutoSpeak(next.autoSpeak);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, t("Could not load bot")));
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextMe, nextCatalog, nextCredentials]) => {
        setMe(nextMe);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
        setModelMetaError(null);
        setModelMetaReady(true);
      })
      .catch((err) => {
        setModelMetaReady(false);
        setModelMetaError(errorText(err, t("Could not load model settings")));
      });
  }, [t]);

  const connectedOptions = useMemo(
    () => connectedModelChoices(credentials, catalog),
    [catalog, credentials],
  );
  const storedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedModel = storedModel
    ? {
        provider: storedModel.provider,
        modelCredentialId: storedModel.modelCredentialId,
        modelId: resolveSelectableModelId(catalog, storedModel.provider, storedModel.modelId),
      }
    : null;
  const selectedModelKey = selectedModel
    ? modelOptionKey(selectedModel.provider, selectedModel.modelId, selectedModel.modelCredentialId)
    : "";

  const effectiveProvider = selectedModel?.provider ?? me?.defaultProvider ?? null;
  const effectiveModelId = selectedModel?.modelId ?? me?.defaultModel ?? null;
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) =>
            entry.provider === effectiveProvider &&
            resolveSelectableModelId(catalog, entry.provider, entry.id) === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = selectedModel
    ? credentialForModel(
        credentials,
        effectiveProvider,
        effectiveModelId,
        selectedModel.modelCredentialId,
      )
    : credentials.find((entry) => entry.isDefault);
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  const spaceDefaultLabel = me?.defaultModel
    ? `${t("Space default")} (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
    : t("Space default");

  const modelChoices: MenuPickerChoice[] = useMemo(() => {
    const choices: MenuPickerChoice[] = [{ key: "", label: spaceDefaultLabel }];
    if (selectedModelKey && !connectedOptions.some((option) => option.key === selectedModelKey)) {
      choices.push({
        key: selectedModelKey,
        label: selectedModel?.modelId ?? selectedModelKey,
      });
    }
    for (const option of connectedOptions) {
      choices.push({ key: option.key, label: option.label });
    }
    return choices;
  }, [connectedOptions, selectedModel?.modelId, selectedModelKey, spaceDefaultLabel]);

  const thinkingChoices: MenuPickerChoice[] = useMemo(
    () => [
      { key: "", label: t("Default (medium)") },
      ...thinkingOptions.map((level) => ({
        key: level,
        label: thinkingLevelLabel(level, t),
      })),
    ],
    [t, thinkingOptions],
  );

  function selectModel(key: string) {
    if (key === selectedModelKey) return;
    setModelRevision(connectedOptions.find((option) => option.key === key)?.connectionRevision);
    setModelKey(key);
    setThinkingLevel("");
  }

  function applyVoices(available: Voice[], assigned: string | undefined) {
    setVoices(available);
    savedVoiceId.current = assigned;
    setVoiceId(assigned);
    setVoiceError(null);
  }

  function failVoices() {
    setVoices([]);
    setVoiceError(t("Could not load voices"));
  }

  useFocusEffect(
    useCallback(() => {
      let current = true;
      void loadDeviceVoiceEnabled()
        .then((enabled) => {
          if (current) setDeviceVoiceEnabled(enabled);
        })
        .catch(() => {
          if (current) setDeviceVoiceEnabled(false);
        });
      return () => {
        current = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!botId || !deviceVoiceEnabled) return;
    let current = true;
    void Promise.all([deviceVoices(), voiceForBot(botId)])
      .then(([available, assigned]) => {
        if (!current) return;
        applyVoices(available, assigned);
      })
      .catch(() => {
        if (!current) return;
        failVoices();
      });
    return () => {
      current = false;
    };
  }, [botId, deviceVoiceEnabled, t]);

  async function chooseVoice(voice: Voice) {
    if (!botId) return;
    // Picking a voice cuts off a reply in progress before the sample starts.
    stopVoicePlayback();
    const choice = ++voiceChoice.current;
    setVoiceId(voice.identifier);
    setError(null);
    try {
      await setVoiceForBot(botId, voice.identifier);
      savedVoiceId.current = voice.identifier;
    } catch {
      if (choice !== voiceChoice.current) return;
      setVoiceId(savedVoiceId.current);
      setError(t("Could not save that voice"));
      return;
    }
    if (choice !== voiceChoice.current) return;
    try {
      const Speech = await import("expo-speech");
      if (choice !== voiceChoice.current) return;
      await Speech.stop();
      if (choice !== voiceChoice.current) return;
      const sampleName = name.trim();
      Speech.speak(
        sampleName ? t("Hi, I'm {name}.", { name: sampleName }) : t("Hi, this is how I'll sound."),
        { voice: voice.identifier },
      );
    } catch {
      // The choice is already saved. A sample that cannot play is not a failed save.
    }
  }

  const currentVoice = voices.find((voice) => voice.identifier === voiceId);
  const currentVoiceLabel = currentVoice ? voiceLabel(currentVoice) : t("Default");

  async function retryDeviceVoices() {
    if (!botId) return;
    try {
      const [available, assigned] = await Promise.all([deviceVoices(), voiceForBot(botId)]);
      applyVoices(available, assigned);
    } catch {
      failVoices();
    }
  }

  async function save() {
    if (!botId || !bot || bot.id !== botId || pending) return;
    if (!instructionsConflict && instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
      setError(
        t("Instructions must be at most {count} characters", {
          count: BOT_INSTRUCTIONS_MAX_LENGTH,
        }),
      );
      return;
    }
    const lifetime = botLifetime.current;
    const current = () => lifetime === botLifetime.current;
    setPending(true);
    setError(null);
    try {
      const profile = normalizeCreateBotProfile({ name, title, description });
      const selected = selectedModel;
      const input: {
        botId: string;
        name?: string;
        title?: string;
        description?: string;
        instructions?: string;
        expectedInstructions?: string;
        color?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        modelCredentialId?: string | null;
        expectedRevision?: number;
        thinkingLevel?: ThinkingLevel | null;
        autoSpeak?: boolean;
      } = { botId };
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
      }
      if (!instructionsConflict && instructions !== (bot.instructions ?? "")) {
        input.instructions = instructions;
        input.expectedInstructions = bot.instructions ?? "";
      }
      if (color !== bot.color) input.color = color;
      const modelChanged =
        (selected?.provider ?? null) !== (bot.modelProvider ?? null) ||
        (selected?.modelId ?? null) !== (bot.modelId ?? null) ||
        (selected?.modelCredentialId ?? null) !== (bot.modelCredentialId ?? null);
      const thinkingChanged = (thinkingLevel || null) !== (bot.thinkingLevel ?? null);
      if (modelChanged || thinkingChanged) {
        input.modelProvider = selected?.provider ?? null;
        input.modelId = selected?.modelId ?? null;
        input.modelCredentialId = selected?.modelCredentialId ?? null;
        input.expectedRevision = selected ? modelRevision : undefined;
      }
      if (modelMetaReady && (modelChanged || thinkingChanged)) {
        input.thinkingLevel = thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null;
      }
      if (autoSpeak !== bot.autoSpeak) input.autoSpeak = autoSpeak;
      if (computerMode !== bot.computerMode) {
        await rpc(
          "bots/setComputer",
          { botId, mode: computerMode },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        );
        if (!current()) return;
        setBot((accepted) =>
          current() && accepted?.id === botId ? { ...accepted, computerMode } : accepted,
        );
      }
      // Use key presence so clearing title/description to "" still persists.
      if (Object.keys(input).length > 1) {
        const saved = await rpc<BotSettingsRecord>("bots/update", input);
        if (!current()) return;
        if (instructionsConflict && saved?.id === botId) {
          setBot((current) =>
            current?.id === botId && lifetime === botLifetime.current
              ? { ...saved, instructions: current.instructions }
              : current,
          );
        }
      }
      // A successful partial save must leave the unresolved rule draft available.
      if (current() && !instructionsConflict) router.back();
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t("Could not save bot")));
      if (isBotInstructionsConflict(err)) setInstructionsConflict(true);
    } finally {
      if (current()) setPending(false);
    }
  }

  const voiceValue = (
    <Text
      numberOfLines={1}
      style={[styles.rowValue, { color: voiceError ? tokens.destructive : tokens.foreground }]}
    >
      {voiceError ?? currentVoiceLabel}
    </Text>
  );
  const voiceRow = (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: tokens.mutedForeground }]}>{t("Device voice")}</Text>
      {!voiceError && voices.length > 1 ? (
        <MenuPickerMenu
          choices={voices.map((voice) => ({
            key: voice.identifier,
            label: voiceLabel(voice),
          }))}
          label={t("Device voice")}
          onChange={(key) => {
            const voice = voices.find((candidate) => candidate.identifier === key);
            if (voice) void chooseVoice(voice);
          }}
          value={voiceId ?? ""}
        >
          <View
            accessibilityLabel={t("Device voice")}
            accessibilityRole="button"
            accessibilityValue={{ text: currentVoiceLabel }}
            accessible
            style={styles.voiceTrigger}
          >
            {voiceValue}
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          </View>
        </MenuPickerMenu>
      ) : (
        voiceValue
      )}
    </View>
  );

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Chat settings"))} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {bot ? (
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <BotAvatar color={color} identity={bot.id} size={64} status={bot.status} />
          </View>
        ) : null}
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Instructions")}
        </Text>
        <TextInput
          accessibilityLabel={t("Instructions")}
          value={instructions}
          onChangeText={setInstructions}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Color")}
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, marginTop: 8 }}
          accessibilityRole="radiogroup"
        >
          {GAZE_BOT_COLORS.map((option, index) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={t("Color {number}", { number: index + 1 })}
              accessibilityState={{
                checked:
                  (parsedColor.kind === "color" || parsedColor.kind === "shape") &&
                  parsedColor.color.toUpperCase() === option,
              }}
              onPress={() =>
                setColor(
                  parsedColor.kind === "shape"
                    ? `${option}::shape_${parsedColor.shapeIndex}`
                    : option,
                )
              }
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: option,
                borderWidth: 3,
                borderColor:
                  (parsedColor.kind === "color" || parsedColor.kind === "shape") &&
                  parsedColor.color.toUpperCase() === option
                    ? tokens.foreground
                    : "transparent",
              }}
            />
          ))}
        </ScrollView>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <View style={[styles.row, { marginTop: 20 }]}>
          <Text style={[styles.rowLabel, { color: tokens.mutedForeground }]}>
            {t("Read replies aloud")}
          </Text>
          <NativeSwitch
            accessibilityLabel={t("Read replies aloud")}
            onValueChange={setAutoSpeak}
            value={autoSpeak}
          />
        </View>
        {deviceVoiceEnabled ? (
          voiceError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Device voice")}
              accessibilityValue={{ text: voiceError }}
              onPress={() => void retryDeviceVoices()}
            >
              {voiceRow}
            </Pressable>
          ) : (
            voiceRow
          )
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Advanced")}
          accessibilityState={{ expanded: advancedOpen }}
          onPress={() => setAdvancedOpen((open) => !open)}
          style={{
            marginTop: 20,
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Advanced")}</Text>
          <Chevron expanded={advancedOpen} />
        </Pressable>
        {advancedOpen ? (
          <View>
            <View
              style={{
                marginTop: 8,
                borderRadius: 14,
                backgroundColor: native.fill,
                overflow: "hidden",
              }}
            >
              <MenuPicker
                choices={modelChoices}
                label={t("Model")}
                onChange={selectModel}
                value={selectedModelKey}
              />
              {thinkingOptions.length ? (
                <MenuPicker
                  choices={thinkingChoices}
                  divider
                  label={t("Thinking")}
                  onChange={(value) => {
                    if (modelRevision === undefined)
                      setModelRevision(effectiveCredential?.connectionRevision);
                    setThinkingLevel(value);
                  }}
                  value={thinkingLevel}
                />
              ) : null}
            </View>
            {modelMetaError ? (
              <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
                {modelMetaError}
              </Text>
            ) : null}
          </View>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={!name.trim() || pending || !bot}
          label={
            pending ? t("Saving…") : instructionsConflict ? t("Save other settings") : t("Save")
          }
          onPress={() => void save()}
          style={{ marginTop: 24 }}
        />
      </ScrollView>
    </>
  );
}

function catalogLabel(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: { fontSize: 14, flex: 1 },
  voiceTrigger: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowValue: { fontSize: 14, flexShrink: 1, textAlign: "right" },
});
