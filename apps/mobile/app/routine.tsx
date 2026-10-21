import type { ModelCatalogEntry, ModelCredential, Routine, ThinkingLevel } from "@rakazo/contracts";
import {
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
} from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import {
  captureApiRequestContext,
  currentApiBase,
  currentSpaceSelectionGeneration,
  rpc,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { routineStatusLine } from "../lib/routine";
import { currentSessionGeneration } from "../lib/session";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const { botId, botName, routineId } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
  }>();
  const router = useRouter();
  const activeRef = useRef(true);
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [modelKey, setModelKey] = useState("");
  const [modelRevision, setModelRevision] = useState<number | undefined>();
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const modelOptions = connectedModelChoices(credentials, catalog);
  const selectedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedCredential = credentialForModel(
    credentials,
    selectedModel?.provider,
    selectedModel?.modelId,
    selectedModel?.modelCredentialId,
  );
  const selectedEntry = catalog.find(
    (entry) => entry.provider === selectedModel?.provider && entry.id === selectedModel?.modelId,
  );
  const thinkingOptions = (
    selectedCredential?.thinkingLevels ??
    selectedEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  useEffect(() => {
    activeRef.current = true;
    if (!botId || !routineId) {
      setError(t("Routine link is incomplete"));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    void (async () => {
      const requestContext = await captureApiRequestContext();
      const [routines, nextCatalog, nextCredentials] = await Promise.all([
        rpc<Routine[]>("routines/list", { botId }, { requestContext }),
        rpc<ModelCatalogEntry[]>("models/list", {}, { requestContext }),
        rpc<ModelCredential[]>("models/credentials", {}, { requestContext }),
      ]);
      if (
        spaceGeneration !== currentSpaceSelectionGeneration() ||
        sessionGeneration !== currentSessionGeneration() ||
        requestContext.apiBase !== currentApiBase()
      )
        return;
      if (!cancelled) {
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
      }
      return routines;
    })()
      .then((routines) => {
        if (cancelled || !routines) return;
        const match = routines.find((item) => item.id === routineId);
        if (match) {
          setRoutine(match);
          setModelKey(
            match.modelProvider && match.modelId
              ? modelOptionKey(match.modelProvider, match.modelId, match.modelCredentialId)
              : "",
          );
          setThinkingLevel(match.thinkingLevel ?? "");
        } else setError(t("This routine no longer exists"));
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(errorText(loadError, t("Could not load routine")));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      activeRef.current = false;
    };
  }, [botId, routineId]);

  async function saveModel() {
    if (!routine || savingModel) return;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    setSavingModel(true);
    setError(null);
    try {
      const requestContext = await captureApiRequestContext();
      const current = () =>
        activeRef.current &&
        spaceGeneration === currentSpaceSelectionGeneration() &&
        sessionGeneration === currentSessionGeneration() &&
        requestContext.apiBase === currentApiBase();
      if (!current()) return;
      const saved = await rpc<Routine>(
        "routines/update",
        {
          routineId: routine.id,
          modelProvider: selectedModel?.provider ?? null,
          modelId: selectedModel?.modelId ?? null,
          modelCredentialId: selectedModel?.modelCredentialId ?? null,
          thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
          expectedRevision: selectedModel ? modelRevision : undefined,
        },
        { requestContext },
      );
      if (!current()) return;
      setRoutine(saved);
    } catch (err) {
      if (
        activeRef.current &&
        spaceGeneration === currentSpaceSelectionGeneration() &&
        sessionGeneration === currentSessionGeneration()
      )
        setError(errorText(err, t("Could not save")));
    } finally {
      setSavingModel(false);
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 24, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(routine?.name ?? t("Routine"))} />
      {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
      {routine ? (
        <>
          <View
            style={{
              borderRadius: 16,
              backgroundColor: native.fill,
              padding: 18,
            }}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
              {routineStatusLine(routine)}
            </Text>
          </View>
          <View style={{ gap: 8 }}>
            <Text
              style={{ color: tokens.mutedForeground, fontSize: 13, textTransform: "uppercase" }}
            >
              {t("Prompt")}
            </Text>
            <Text
              selectable
              style={{
                color: tokens.foreground,
                fontSize: 15,
                lineHeight: 23,
                borderRadius: 16,
                backgroundColor: native.fill,
                padding: 18,
              }}
            >
              {routine.prompt}
            </Text>
          </View>
          <View style={{ backgroundColor: native.fill, borderRadius: 16 }}>
            <MenuPicker
              label={t("Model")}
              value={modelKey}
              choices={[
                { key: "", label: t("Bot model") },
                ...(modelKey && !modelOptions.some((entry) => entry.key === modelKey)
                  ? [{ key: modelKey, label: selectedModel?.modelId ?? modelKey }]
                  : []),
                ...modelOptions.map((entry) => ({ key: entry.key, label: entry.label })),
              ]}
              onChange={(key) => {
                if (savingModel) return;
                setModelKey(key);
                setModelRevision(
                  modelOptions.find((entry) => entry.key === key)?.connectionRevision,
                );
                setThinkingLevel("");
              }}
            />
            {thinkingOptions.length ? (
              <MenuPicker
                label={t("Thinking")}
                value={thinkingLevel}
                choices={[
                  { key: "", label: t("Default") },
                  ...thinkingOptions.map((level) => ({ key: level, label: t(level) })),
                ]}
                onChange={(level) => {
                  if (savingModel) return;
                  setThinkingLevel(level);
                  setModelRevision(modelRevision ?? selectedCredential?.connectionRevision);
                }}
                divider
              />
            ) : null}
          </View>
          <NativeActionButton
            label={savingModel ? t("Saving…") : t("Save model")}
            disabled={
              savingModel ||
              ((selectedModel?.provider ?? null) === routine.modelProvider &&
                (selectedModel?.modelId ?? null) === routine.modelId &&
                (selectedModel?.modelCredentialId ?? null) ===
                  (routine.modelCredentialId ?? null) &&
                (thinkingLevel || null) === routine.thinkingLevel)
            }
            onPress={() => void saveModel()}
          />
          <NativeActionButton
            label={t("Open conversation")}
            onPress={() =>
              router.push({
                pathname: "/thread",
                params: { botId: botId ?? "", name: botName ?? t("Bot") },
              })
            }
          />
        </>
      ) : null}
    </ScrollView>
  );
}
