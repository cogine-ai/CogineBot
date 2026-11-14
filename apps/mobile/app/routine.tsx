import type { ModelCatalogEntry, ModelCredential, Routine, ThinkingLevel } from "@rakazo/contracts";
import {
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
} from "@rakazo/core";
import { nativeRoutineTriggerInputs } from "@rakazo/core/routine-native-events";
import type { RoutineSaveState } from "@rakazo/core/routine-save";
import { saveRoutineDraft } from "@rakazo/core/routine-save";
import type { RoutineTriggerDraft } from "@rakazo/core/routine-trigger-patch";
import { newRoutineMutationId, routineTriggerPatch } from "@rakazo/core/routine-trigger-patch";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

// Object/creation-intent identity survives blur, but not route or account/Space changes.
type RoutineOwner = {
  key: string;
  mutationError?: string;
  createdRoutineId?: string;
  saveState?: RoutineSaveState;
};

type RoutineScope = MobileScope & {
  generation: number;
  owner: RoutineOwner;
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
  const routeOwner = useRef<RoutineOwner>({ key: routeKey });
  if (routeOwner.current.key !== routeKey) routeOwner.current = { key: routeKey };
  const router = useRouter();
  const routeGeneration = useRef(0);
  const scopeRef = useRef<RoutineScope | null>(null);
  const modelRequest = useRef(0);
  const routineRequest = useRef(0);
  const modelDirty = useRef(false);
  const loadedOwner = useRef<RoutineOwner | null>(null);
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
  // Routine and credential reads can finish in either order. Refresh only the
  // untouched selection; edited drafts retain the revision they were based on.
  useEffect(() => {
    if (!modelDirty.current && selectedCredential?.connectionRevision !== undefined) {
      setModelRevision(selectedCredential.connectionRevision);
    }
  }, [routine, selectedCredential]);

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

  function resumeCreatedRoutine(scope: RoutineScope) {
    const savedId = scope.owner.createdRoutineId;
    if (!savedId || !current(scope)) return;
    routineRequest.current += 1;
    setCreateReady(false);
    setLoading(false);
    router.replace({
      pathname: "/routine",
      params: { botId: botId!, botName: botName ?? "", routineId: savedId, origin: origin ?? "" },
    });
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
      setError(scope.owner.mutationError ?? null);
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
      if (scope.owner.createdRoutineId) {
        resumeCreatedRoutine(scope);
      } else if (!botId || (creating && readOnly)) {
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
    if (
      !scope ||
      !current(scope) ||
      readOnly ||
      saveInFlight.current ||
      scope.owner.createdRoutineId
    )
      return;
    saveInFlight.current = true;
    // A pre-mutation focus read must not overwrite the acknowledged result.
    routineRequest.current += 1;
    setLoading(false);
    setSaving(true);
    delete scope.owner.mutationError;
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
      if (scope.owner === routeOwner.current && isMobileScopeCurrent(scope)) {
        scope.owner.mutationError = errorText(cause, t("Could not save"));
        const activeScope = scopeRef.current;
        if (activeScope && current(activeScope) && activeScope.owner === scope.owner) {
          setError(scope.owner.mutationError);
        }
      }
    } finally {
      saveInFlight.current = false;
      const activeScope = scopeRef.current;
      if (activeScope) setSaving(false);
      if (
        activeScope &&
        current(activeScope) &&
        activeScope !== scope &&
        activeScope.owner.key === scope.owner.key &&
        !activeScope.owner.createdRoutineId
      ) {
        // Read after settlement, invalidate any earlier focus read, and preserve drafts.
        void loadRoutine(activeScope);
      }
    }
  }

  function saveFields(
    name: string,
    prompt: string,
    crons: string[],
    triggers: RoutineTriggerDraft,
    original: Routine | null,
  ) {
    const scope = shownScope;
    void mutate(async (requestContext) => {
      const fields = routineFields(name, prompt, crons, original);
      let triggerFields: ReturnType<typeof routineTriggerPatch>;
      try {
        if (original) triggerFields = routineTriggerPatch(original, triggers);
        else {
          const parsed = nativeRoutineTriggerInputs(triggers.nativeTriggers);
          if (!parsed.success) throw new Error();
          triggerFields = { ...triggers, nativeTriggers: parsed.data };
        }
      } catch {
        throw new Error(t("Check application event fields"));
      }
      if (
        (triggerFields.webhookEnabled || triggerFields.githubEnabled) &&
        scope &&
        current(scope)
      ) {
        const bot = await rpc<{ webhookConfigured: boolean }>(
          "bots/get",
          { botId },
          { requestContext },
        );
        if (!current(scope)) return;
        if (!bot.webhookConfigured)
          await rpc("bots/rotateWebhookSecret", { botId }, { requestContext });
        if (!current(scope)) return;
      }
      if (!scope || !current(scope)) return;
      scope.owner.saveState ??= {};
      const mutationId = newRoutineMutationId();
      const saved = await saveRoutineDraft(
        scope.owner.saveState,
        {
          operation: routine ? "update" : "create",
          input: routine
            ? { routineId: routine.id, ...fields, ...triggerFields, mutationId }
            : {
                botId,
                ...fields,
                ...triggerFields,
                timezone,
                active: true,
                notify: true,
                mutationId,
              },
          triggerKeys: triggers.nativeTriggers.map((t) => t.key),
        },
        original,
        ({ operation, input }) => rpc<Routine>(`routines/${operation}`, input, { requestContext }),
        () => scope.owner === routeOwner.current && isMobileScopeCurrent(scope),
      );
      if (!saved || !scope || scope.owner !== routeOwner.current || !isMobileScopeCurrent(scope))
        return;
      if (!routine) {
        // An acknowledged create belongs to the intent, not the focus that sent it.
        // Retain its identity until navigation replaces this owner; never replay it.
        scope.owner.createdRoutineId = saved.id;
        const activeScope = scopeRef.current;
        if (activeScope?.owner === scope.owner) resumeCreatedRoutine(activeScope);
      } else if (current(scope)) {
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
          access={
            shownScope?.verifiedSpaceId && botId
              ? {
                  botId,
                  scope: shownScope,
                  spaceId: shownScope.verifiedSpaceId,
                  isCurrent: () => current(shownScope),
                }
              : null
          }
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
                  access={
                    shownScope?.verifiedSpaceId && botId
                      ? {
                          botId,
                          scope: shownScope,
                          spaceId: shownScope.verifiedSpaceId,
                          isCurrent: () => current(shownScope),
                        }
                      : null
                  }
                  timezone={routine.timezone}
                  disabled={saving}
                  onSave={saveFields}
                  onCancel={() => {
                    if (routeOwner.current.saveState) routeOwner.current.saveState.discarded = true;
                    setEditing(false);
                  }}
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
