import type { ModelCatalogEntry, ModelCredential, Routine, ThinkingLevel } from "@rakazo/contracts";
import {
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
} from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineFields } from "../components/routine-fields";
import { RoutineRunHistory } from "../components/routine-run-history";
import { RoutineRunTime } from "../components/routine-run-time";
import type { ApiRequestContext } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { native, useMobileTokens } from "../lib/native";
import { deviceTimeZone, routineStatusLine } from "../lib/routine";
import { needsOneShotTime, routineActivation, routineFields } from "../lib/routine-editor";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";

type RoutineScope = MobileScope & {
  generation: number;
  owner: { key: string };
  verifiedSpaceId?: string;
};

export default function RoutineDetail() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const {
    botId,
    botName,
    routineId,
    origin,
    readOnly: readOnlyParam,
  } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
    origin?: string;
    readOnly?: string;
  }>();
  const creating = !routineId;
  const readOnly = readOnlyParam === "1";
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const routeKey = JSON.stringify([botId, routineId, readOnly, scopeKey]);
  const routeOwner = useRef({ key: routeKey });
  if (routeOwner.current.key !== routeKey) routeOwner.current = { key: routeKey };
  const router = useRouter();
  const routeGeneration = useRef(0);
  const scopeRef = useRef<RoutineScope | null>(null);
  const modelRequest = useRef(0);
  const routineRequest = useRef(0);
  const modelDirty = useRef(false);
  const loadedOwner = useRef<{ key: string } | null>(null);
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
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [createReady, setCreateReady] = useState(false);
  const [timezone, setTimezone] = useState("UTC");
  const [runAt, setRunAt] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
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
      scope.owner === routeOwner.current &&
      scope.generation === routeGeneration.current &&
      isMobileScopeCurrent(scope)
    );
  }

  async function loadModels(scope: RoutineScope, initialContext?: ApiRequestContext) {
    if (readOnly || !current(scope)) return;
    const request = ++modelRequest.current;
    const eligible = () => current(scope) && request === modelRequest.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const requestContext =
        initialContext ?? (await spaceRequestContext(scope, eligible, scope.verifiedSpaceId));
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

  async function loadRoutine(scope: RoutineScope) {
    const request = ++routineRequest.current;
    const eligible = () => current(scope) && request === routineRequest.current;
    setLoading(true);
    try {
      const requestContext = await spaceRequestContext(scope, eligible, scope.verifiedSpaceId);
      if (!eligible()) return;
      if (!readOnly && !creating) void loadModels(scope, requestContext);
      const routines = await rpc<Routine[]>("routines/list", { botId }, { requestContext });
      if (!eligible()) return;
      scope.verifiedSpaceId = requestContext.headers["x-rakazo-space-id"];
      if (creating) {
        const me = await rpc<{ timezone: string | null }>("me", {}, { requestContext });
        if (eligible()) {
          setTimezone(me.timezone ?? deviceTimeZone() ?? "UTC");
          setCreateReady(true);
        }
        return;
      }
      const match = routines.find((item) => item.id === routineId && item.botId === botId);
      if (match) {
        setRoutine(match);
        if (!modelDirty.current) {
          setModelKey(
            match.modelProvider && match.modelId
              ? modelOptionKey(match.modelProvider, match.modelId, match.modelCredentialId)
              : "",
          );
          setThinkingLevel(match.thinkingLevel ?? "");
        }
      } else {
        setRoutine(null);
        setError(t("This routine no longer exists"));
      }
    } catch (loadError) {
      if (eligible()) setError(errorText(loadError, t("Could not load routine")));
    } finally {
      if (eligible()) setLoading(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      const scope: RoutineScope = {
        ...captureMobileScope(),
        generation: ++routeGeneration.current,
        owner: routeOwner.current,
      };
      const sameOwner = loadedOwner.current === scope.owner;
      loadedOwner.current = scope.owner;
      scopeRef.current = scope;
      setSaving(saveInFlight.current);
      setError(null);
      // Refocusing the same object must not unmount its unsaved field draft.
      if (!sameOwner) {
        modelDirty.current = false;
        setRoutine(null);
        setEditing(false);
        setCreateReady(false);
        setRunAt("");
        setCredentials([]);
        setCatalog([]);
        setModelsReady(false);
        setModelsError(null);
        setModelsLoading(!readOnly);
        setModelKey("");
        setModelRevision(undefined);
        setThinkingLevel("");
      }
      if (!botId || (creating && readOnly)) {
        setError(t("Routine link is incomplete"));
        setLoading(false);
      } else {
        void loadRoutine(scope);
      }
      return () => {
        if (scopeRef.current === scope) scopeRef.current = null;
      };
    }, [botId, routineId, readOnly, scopeKey, loadRevision]),
  );

  const shownScope = scopeRef.current;
  async function saveModel() {
    const scope = shownScope;
    if (
      !scope ||
      !current(scope) ||
      !routine ||
      readOnly ||
      saveInFlight.current ||
      !modelsReady ||
      modelsLoading ||
      modelsError
    )
      return;
    await mutate(async (requestContext) => {
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
      const activeScope = scopeRef.current;
      if (activeScope && current(activeScope) && activeScope.owner === scope.owner)
        modelDirty.current = false;
      if (current(scope)) setRoutine(saved);
    });
  }

  async function mutate(action: (requestContext: ApiRequestContext) => Promise<void>) {
    const scope = shownScope;
    if (!scope || !current(scope) || readOnly || saveInFlight.current) return;
    saveInFlight.current = true;
    // A pre-mutation focus read must not overwrite the acknowledged result.
    routineRequest.current += 1;
    setLoading(false);
    setSaving(true);
    setError(null);
    try {
      const requestContext = await spaceRequestContext(
        scope,
        () => current(scope),
        scope.verifiedSpaceId,
      );
      if (!current(scope)) return;
      await action({ ...requestContext, isCurrent: () => current(scope) });
    } catch (cause) {
      const activeScope = scopeRef.current;
      if (
        current(scope) ||
        (activeScope && current(activeScope) && activeScope.owner === scope.owner)
      ) {
        setError(errorText(cause, t("Could not save")));
      }
    } finally {
      saveInFlight.current = false;
      const activeScope = scopeRef.current;
      if (activeScope) setSaving(false);
      if (
        activeScope &&
        current(activeScope) &&
        activeScope !== scope &&
        activeScope.owner.key === scope.owner.key
      ) {
        // Read after settlement, invalidate any earlier focus read, and preserve drafts.
        void loadRoutine(activeScope);
      }
    }
  }

  function saveFields(name: string, prompt: string, crons: string[]) {
    const scope = shownScope;
    void mutate(async (requestContext) => {
      const fields = routineFields(name, prompt, crons);
      const saved = await rpc<Routine>(
        routine ? "routines/update" : "routines/create",
        routine
          ? { routineId: routine.id, ...fields }
          : { botId, ...fields, timezone, active: true, notify: true },
        { requestContext },
      );
      if (!scope || !current(scope)) return;
      if (!routine) {
        router.replace({
          pathname: "/routine",
          params: {
            botId: botId!,
            botName: botName ?? "",
            routineId: saved.id,
            origin: origin ?? "",
          },
        });
      } else {
        setRoutine(saved);
        setEditing(false);
      }
    });
  }

  function toggleActive() {
    const scope = shownScope;
    if (!routine) return;
    void mutate(async (requestContext) => {
      const saved = await rpc<Routine>(
        "routines/update",
        { routineId: routine.id, ...routineActivation(routine, runAt) },
        { requestContext },
      );
      if (scope && current(scope)) {
        setRoutine(saved);
        setRunAt("");
      }
    });
  }

  function confirmDelete() {
    const scope = shownScope;
    if (!routine || !scope || !current(scope) || saveInFlight.current) return;
    Alert.alert(t("Delete routine?"), routine.name, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          if (!current(scope)) return;
          void mutate(async (requestContext) => {
            await rpc("routines/remove", { routineId: routine.id }, { requestContext });
            if (current(scope)) router.back();
          });
        },
      },
    ]);
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
      {!loading && error && !routine && !createReady ? (
        <NativeActionButton
          label={t("Retry")}
          onPress={() => setLoadRevision((value) => value + 1)}
        />
      ) : null}
      {createReady && creating && !readOnly ? (
        <RoutineFields
          key={routeKey}
          routine={null}
          timezone={timezone}
          disabled={saving}
          onSave={saveFields}
          onCancel={() => router.back()}
        />
      ) : null}
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
          {!editing ? (
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
          ) : null}
          {!readOnly ? (
            <>
              {editing ? (
                <RoutineFields
                  key={routeKey}
                  routine={routine}
                  timezone={routine.timezone}
                  disabled={saving}
                  onSave={saveFields}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <NativeActionButton
                  label={t("Edit")}
                  disabled={saving}
                  onPress={() => setEditing(true)}
                />
              )}
              {!routine.active && needsOneShotTime(routine) ? (
                <RoutineRunTime value={runAt} onChange={setRunAt} disabled={saving} />
              ) : null}
              <NativeActionButton
                label={routine.active ? t("Pause") : t("Resume")}
                disabled={saving}
                onPress={toggleActive}
              />
              <NativeActionButton
                label={t("Test run")}
                disabled={saving}
                onPress={() => {
                  const scope = shownScope;
                  void mutate(async (requestContext) => {
                    await rpc("routines/testRun", { routineId: routine.id }, { requestContext });
                    if (scope && current(scope)) setHistoryRevision((value) => value + 1);
                  });
                }}
              />
              <NativeActionButton
                label={t("Delete")}
                prominence="destructive"
                disabled={saving}
                onPress={confirmDelete}
              />
            </>
          ) : null}
          {!readOnly && modelsLoading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
          {!readOnly && modelsError ? (
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
          {!readOnly && modelsReady && !modelsLoading && !modelsError ? (
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
                    if (!shownScope || !current(shownScope) || saving) return;
                    modelDirty.current = true;
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
                      if (!shownScope || !current(shownScope) || saving) return;
                      modelDirty.current = true;
                      setThinkingLevel(level);
                      setModelRevision(modelRevision ?? selectedCredential?.connectionRevision);
                    }}
                    divider
                  />
                ) : null}
              </View>
              <NativeActionButton
                label={saving ? t("Saving…") : t("Save model")}
                disabled={
                  saving ||
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
          {!readOnly && shownScope?.verifiedSpaceId && routineId ? (
            <RoutineRunHistory
              key={`${routeKey}:${historyRevision}`}
              routineId={routineId}
              owner={shownScope}
              spaceId={shownScope.verifiedSpaceId}
              isCurrent={() => current(shownScope)}
            />
          ) : null}
          {origin !== "profile" && !readOnly ? (
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
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
