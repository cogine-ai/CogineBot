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
import { thinkingLevelLabel } from "../lib/model-catalog";
import { native, useMobileTokens } from "../lib/native";
import { routineStatusLine } from "../lib/routine";
import { currentSessionGeneration } from "../lib/session";
import { errorText } from "../lib/user-error";

type RoutineScope = {
  generation: number;
  apiBase: string;
  spaceGeneration: number;
  sessionGeneration: number;
};

export default function RoutineDetail() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const { botId, botName, routineId } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
  }>();
  const router = useRouter();
  const routeGeneration = useRef(0);
  const scopeRef = useRef<RoutineScope | null>(null);
  const modelRequest = useRef(0);
  const saveRequest = useRef(0);
  // A dispatched save must settle before another route can write.
  const saveInFlight = useRef(false);
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsReady, setModelsReady] = useState(false);
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

  function current(scope: RoutineScope): boolean {
    return (
      scopeRef.current === scope &&
      scope.generation === routeGeneration.current &&
      scope.spaceGeneration === currentSpaceSelectionGeneration() &&
      scope.sessionGeneration === currentSessionGeneration() &&
      scope.apiBase === currentApiBase()
    );
  }

  async function loadModels(scope: RoutineScope) {
    if (!current(scope)) return;
    const request = ++modelRequest.current;
    const eligible = () => current(scope) && request === modelRequest.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const requestContext = await captureApiRequestContext();
      if (!eligible()) return;
      const [nextCatalog, nextCredentials] = await Promise.all([
        rpc<ModelCatalogEntry[]>("models/list", {}, { requestContext }),
        rpc<ModelCredential[]>("models/credentials", {}, { requestContext }),
      ]);
      if (!eligible()) return;
      setCatalog(nextCatalog);
      setCredentials(nextCredentials);
      setModelsReady(true);
    } catch (loadError) {
      if (eligible()) setModelsError(errorText(loadError, t("Could not load models")));
    } finally {
      if (eligible()) setModelsLoading(false);
    }
  }

  useEffect(() => {
    const scope: RoutineScope = {
      generation: ++routeGeneration.current,
      apiBase: currentApiBase(),
      spaceGeneration: currentSpaceSelectionGeneration(),
      sessionGeneration: currentSessionGeneration(),
    };
    scopeRef.current = scope;
    setRoutine(null);
    setError(null);
    setCredentials([]);
    setCatalog([]);
    setModelsReady(false);
    setModelsError(null);
    setModelsLoading(true);
    setModelKey("");
    setModelRevision(undefined);
    setThinkingLevel("");
    if (!botId || !routineId) {
      setError(t("Routine link is incomplete"));
      setLoading(false);
    } else {
      setLoading(true);
      void loadModels(scope);
      void (async () => {
        const requestContext = await captureApiRequestContext();
        if (!current(scope)) return;
        const routines = await rpc<Routine[]>("routines/list", { botId }, { requestContext });
        if (!current(scope)) return;
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
      })()
        .catch((loadError) => {
          if (current(scope)) setError(errorText(loadError, t("Could not load routine")));
        })
        .finally(() => {
          if (current(scope)) setLoading(false);
        });
    }
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [botId, routineId]);

  const shownScope = scopeRef.current;
  async function saveModel() {
    const scope = shownScope;
    if (
      !scope ||
      !current(scope) ||
      !routine ||
      saveInFlight.current ||
      !modelsReady ||
      modelsLoading ||
      modelsError
    )
      return;
    const request = ++saveRequest.current;
    const eligible = () => current(scope) && request === saveRequest.current;
    saveInFlight.current = true;
    setSavingModel(true);
    setError(null);
    try {
      const requestContext = await captureApiRequestContext();
      if (!eligible()) return;
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
      if (eligible()) setRoutine(saved);
    } catch (err) {
      if (eligible()) setError(errorText(err, t("Could not save")));
    } finally {
      saveInFlight.current = false;
      if (scopeRef.current) setSavingModel(false);
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
          {modelsLoading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
          {modelsError ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: tokens.destructive, fontSize: 15 }}>{modelsError}</Text>
              <NativeActionButton
                label={t("Retry")}
                disabled={modelsLoading}
                onPress={() => {
                  if (shownScope) void loadModels(shownScope);
                }}
              />
            </View>
          ) : null}
          {modelsReady && !modelsLoading && !modelsError ? (
            <>
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
                    if (!shownScope || !current(shownScope) || savingModel) return;
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
                      ...thinkingOptions.map((level) => ({
                        key: level,
                        label: thinkingLevelLabel(level, t),
                      })),
                    ]}
                    onChange={(level) => {
                      if (!shownScope || !current(shownScope) || savingModel) return;
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
            </>
          ) : null}
          <NativeActionButton
            label={t("Open conversation")}
            onPress={() => {
              if (!shownScope || !current(shownScope)) return;
              router.push({
                pathname: "/thread",
                params: { botId: botId ?? "", name: botName ?? t("Bot") },
              });
            }}
          />
        </>
      ) : null}
    </ScrollView>
  );
}
