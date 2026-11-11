import type {
  AccountSecurity,
  BotCredentialRevisionInput,
  BotLoginFieldMetadata,
  BotSecretPutInput,
  RevealedBotCredential,
  SpaceBotCredentials,
} from "@rakazo/contracts";
import {
  BotSecretName,
  commandVariableName,
  commandVariableProblem,
  encodeEditedLoginSecret,
  isIdentityConfirmationRequired,
  LOGIN_FIELD_LIMIT,
  LOGIN_VALUE_TOO_LONG,
  NamedLoginSecretValue,
} from "@rakazo/contracts";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MenuPicker, MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { confirmIdentity, fetchAccountSecurity, requestIdentityCode } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { useSpaceSettings, useSpaceSettingsKey } from "../../lib/space-settings";
import { continueWithSso } from "../../lib/sso";

type Row = SpaceBotCredentials["credentials"][number] & { botId: string; botName: string };
type Auth = NonNullable<Row["auth"]>;
type Sheet =
  | { kind: "edit"; row?: Row; fields?: BotLoginFieldMetadata }
  | { kind: "confirm"; row: Row }
  | { kind: "show"; row: Row; credential: RevealedBotCredential };

const receipt = (row: Row): BotCredentialRevisionInput => ({
  botId: row.botId,
  name: row.name,
  expectedRevision: row.revision,
});

export default function SpaceCredentials() {
  const { spaceId, botId } = useLocalSearchParams<{ spaceId?: string; botId?: string }>();
  const target = typeof spaceId === "string" ? spaceId : undefined;
  const key = useSpaceSettingsKey(target);
  return (
    <Credentials
      key={key}
      spaceId={target}
      defaultBotId={typeof botId === "string" ? botId : undefined}
    />
  );
}

function Credentials({ spaceId, defaultBotId }: { spaceId?: string; defaultBotId?: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { rpc, isCurrent, captureApiRequestContext } = useSpaceSettings(spaceId);
  const [groups, setGroups] = useState<SpaceBotCredentials[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const attempt = useRef(0);
  const listRequest = useRef(0);
  const focused = useRef(false);

  const close = useCallback(() => {
    attempt.current++;
    setSheet(null);
    setBusy(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!spaceId || !isCurrent()) return;
    const request = ++listRequest.current;
    const current = () => focused.current && isCurrent() && request === listRequest.current;
    try {
      const rows = await rpc<SpaceBotCredentials[]>("botSecrets/listForSpace");
      if (current()) {
        setGroups(rows);
        setError("");
      }
    } catch {
      if (current()) setError(t("Could not load credentials."));
    }
  }, [isCurrent, rpc, spaceId, t]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void refresh();
      return () => {
        focused.current = false;
        listRequest.current++;
        close();
      };
    }, [close, refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") close();
    });
    return () => subscription.remove();
  }, [close]);

  useEffect(() => {
    if (sheet?.kind !== "show") return;
    const timer = setTimeout(close, 30_000);
    return () => clearTimeout(timer);
  }, [close, sheet]);

  function current(operation: number) {
    return focused.current && isCurrent() && attempt.current === operation;
  }

  async function show(row: Row, confirmed = false) {
    if (!isCurrent() || !focused.current) return;
    close();
    const operation = attempt.current;
    setBusy(true);
    setError("");
    try {
      const credential = await rpc<RevealedBotCredential>("botSecrets/reveal", receipt(row));
      if (current(operation)) setSheet({ kind: "show", row, credential });
    } catch (cause) {
      if (!current(operation)) return;
      if (!confirmed && isIdentityConfirmationRequired(cause)) setSheet({ kind: "confirm", row });
      else setError(t("Could not show the credential"));
    } finally {
      if (current(operation)) setBusy(false);
    }
  }

  async function edit(row: Row) {
    if (!row.auth || !isCurrent() || !focused.current) return;
    close();
    const operation = attempt.current;
    setBusy(true);
    try {
      const fields =
        row.auth.type === "login"
          ? await rpc<BotLoginFieldMetadata>("botSecrets/loginFieldsForEdit", receipt(row))
          : undefined;
      if (current(operation)) setSheet({ kind: "edit", row, fields });
    } catch {
      if (current(operation)) setError(t("Could not load credentials."));
    } finally {
      if (current(operation)) setBusy(false);
    }
  }

  async function remove(row: Row) {
    if (!isCurrent() || !focused.current) return;
    listRequest.current++;
    setBusy(true);
    try {
      await rpc("botSecrets/removeForEdit", receipt(row));
      if (isCurrent() && focused.current) {
        setGroups(
          (old) =>
            old?.map((bot) =>
              bot.botId === row.botId
                ? {
                    ...bot,
                    credentials: bot.credentials.filter(
                      (credential) => credential.name !== row.name,
                    ),
                  }
                : bot,
            ) ?? null,
        );
        setError("");
      }
    } catch {
      await refresh();
      if (isCurrent() && focused.current) setError(t("Could not remove the credential"));
    } finally {
      if (isCurrent() && focused.current) setBusy(false);
    }
  }

  async function save(input: BotSecretPutInput) {
    if (!isCurrent() || !focused.current) throw new Error(t("Could not save the credential"));
    const operation = attempt.current;
    listRequest.current++;
    try {
      const saved = await rpc<SpaceBotCredentials["credentials"][number]>(
        "botSecrets/putForEdit",
        input,
      );
      if (current(operation)) {
        setGroups(
          (old) =>
            old?.map((bot) =>
              bot.botId === input.botId
                ? {
                    ...bot,
                    credentials: [
                      ...bot.credentials.filter((entry) => entry.name !== saved.name),
                      saved,
                    ],
                  }
                : bot,
            ) ?? null,
        );
      }
    } catch (error) {
      const stale =
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error.code === "CONFLICT" || error.code === "NOT_FOUND");
      if (stale && current(operation)) {
        close();
        await refresh();
        if (isCurrent() && focused.current) setError(t("The saved credential changed. Try again."));
      }
      throw error;
    }
    if (current(operation)) close();
    await refresh();
  }

  const rows = (groups ?? [])
    .flatMap(({ botId, botName, credentials }) =>
      credentials.map((entry) => ({ ...entry, botId, botName })),
    )
    .sort((left, right) => (left.origin || left.name).localeCompare(right.origin || right.name));
  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {error || !spaceId ? (
          <>
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error || t("Could not load credentials.")}
            </Text>
            {spaceId ? (
              <NativeActionButton label={t("Retry")} onPress={() => void refresh()} />
            ) : null}
          </>
        ) : groups === null ? (
          <ActivityIndicator />
        ) : null}
        {groups && rows.length === 0 ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {t("No credentials saved in this Space.")}
          </Text>
        ) : null}
        <SettingsGroup>
          {rows.map((row) => {
            const readable = row.auth !== null && BotSecretName.safeParse(row.name).success;
            return (
              <MenuPickerMenu
                key={JSON.stringify([row.botId, row.name])}
                label={row.name}
                value=""
                choices={[
                  ...(readable
                    ? [
                        { key: "show", label: t("Show value") },
                        { key: "edit", label: t("Replace value") },
                      ]
                    : []),
                  { key: "remove", label: t("Remove") },
                ]}
                onChange={(action) => {
                  if (busy) return;
                  if (action === "show") void show(row);
                  if (action === "edit") void edit(row);
                  if (action === "remove")
                    Alert.alert(
                      t("Remove {name}?", { name: row.name }),
                      t("{bot} will no longer be able to use this credential.", {
                        bot: row.botName,
                      }),
                      [
                        { text: t("Cancel"), style: "cancel" },
                        {
                          text: t("Remove"),
                          style: "destructive",
                          onPress: () => void remove(row),
                        },
                      ],
                    );
                }}
              >
                <SettingsRow
                  title={row.origin || row.name}
                  detail={row.origin ? `${row.name} · ${row.botName}` : row.botName}
                  chevron="down"
                />
              </MenuPickerMenu>
            );
          })}
        </SettingsGroup>
        {groups?.length ? (
          <NativeActionButton
            label={t("Add credential")}
            disabled={busy}
            onPress={() => setSheet({ kind: "edit" })}
          />
        ) : null}
      </ScrollView>
      {sheet?.kind === "edit" && groups ? (
        <CredentialEditor
          bots={groups}
          defaultBotId={defaultBotId}
          row={sheet.row}
          fieldLayout={sheet.fields}
          onClose={close}
          onSave={save}
        />
      ) : null}
      {sheet?.kind === "confirm" ? (
        <IdentitySheet
          onClose={close}
          onConfirm={() => void show(sheet.row, true)}
          settings={{ captureApiRequestContext, isCurrent }}
        />
      ) : null}
      {sheet?.kind === "show" ? (
        <CredentialSheet title={sheet.row.origin || sheet.row.name} onClose={close}>
          <Text style={{ color: tokens.mutedForeground }}>{sheet.row.botName}</Text>
          {("value" in sheet.credential
            ? [{ label: t("Value"), value: sheet.credential.value }]
            : sheet.credential.fields
          ).map(({ label, value }) => (
            <View key={label} style={styles.fieldGroup}>
              <Text style={{ color: tokens.mutedForeground }}>{label}</Text>
              <Text selectable style={{ color: tokens.foreground }}>
                {value}
              </Text>
            </View>
          ))}
        </CredentialSheet>
      ) : null}
    </SafeAreaView>
  );
}

function CredentialSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView
        accessibilityViewIsModal
        edges={Platform.OS === "ios" ? ["bottom"] : ["top", "bottom"]}
        style={{ flex: 1, backgroundColor: tokens.background }}
      >
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <NativeActionButton label={t("Close")} onPress={onClose} prominence="plain" />
          <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 20 }}>
            {title}
          </Text>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Field({
  label,
  value,
  setValue,
  hidden = false,
  oneTimeCode = false,
  autoFill,
  maxLength,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  hidden?: boolean;
  oneTimeCode?: boolean;
  autoFill?: "username" | "email" | "new-password" | "current-password";
  maxLength: number;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={styles.fieldGroup}>
      <Text style={{ color: tokens.mutedForeground }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={setValue}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={hidden}
        autoComplete={oneTimeCode ? "one-time-code" : (autoFill ?? "off")}
        textContentType={
          oneTimeCode
            ? "oneTimeCode"
            : autoFill === "new-password"
              ? "newPassword"
              : autoFill === "current-password"
                ? "password"
                : autoFill === "email"
                  ? "emailAddress"
                  : (autoFill ?? "none")
        }
        inputMode={oneTimeCode ? "numeric" : "text"}
        style={[styles.input, { color: tokens.foreground, borderColor: tokens.border }]}
      />
    </View>
  );
}

function CredentialEditor({
  bots,
  defaultBotId,
  row,
  fieldLayout,
  onClose,
  onSave,
}: {
  bots: SpaceBotCredentials[];
  defaultBotId?: string;
  row?: Row;
  fieldLayout?: BotLoginFieldMetadata;
  onClose: () => void;
  onSave: (input: BotSecretPutInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [botId, setBotId] = useState(
    row?.botId ??
      bots.find((entry) => entry.botId === defaultBotId)?.botId ??
      (bots.length === 1 ? bots[0]!.botId : ""),
  );
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [type, setType] = useState<Auth["type"]>(row?.auth?.type ?? "bearer");
  const [parameter, setParameter] = useState("");
  const [value, setValue] = useState("");
  const [fields, setFields] = useState<NamedLoginSecretValue["fields"]>(() =>
    (
      fieldLayout ?? [
        { label: t("Username"), hidden: false },
        { label: t("Password"), hidden: true },
      ]
    ).map((field) => ({ ...field, value: "" })),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const login = NamedLoginSecretValue.safeParse({ fields });
  const tooLong =
    !login.success && login.error.issues.some((issue) => issue.message === LOGIN_VALUE_TOO_LONG);
  const reserved = type === "command" && commandVariableProblem(commandVariableName(name.trim()));
  const ready =
    !busy &&
    !!botId &&
    (type === "login" ? login.success : !!value) &&
    (row ||
      (BotSecretName.safeParse(name.trim()).success &&
        !reserved &&
        (type === "command" || !!origin.trim()) &&
        ((type !== "basic" && type !== "header") || !!parameter.trim())));
  const auth: Auth =
    row?.auth ??
    (type === "basic"
      ? { type, username: parameter.trim() }
      : type === "header"
        ? { type, name: parameter.trim() }
        : { type });
  const clear = () => {
    setValue("");
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
  };
  async function save() {
    if (!ready) return;
    const destination = {
      name: row?.name ?? name.trim(),
      origin: type === "command" ? "" : (row?.origin ?? origin.trim()),
      auth,
    };
    const plaintext =
      type === "login" && login.success
        ? encodeEditedLoginSecret(login.data, !!row && !row.namedLogin)
        : value;
    clear();
    setBusy(true);
    setError("");
    try {
      await onSave({
        botId,
        destination,
        value: plaintext,
        expectedRevision: row?.revision ?? null,
      });
    } catch {
      setError(t("Could not save the credential"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CredentialSheet
      title={row?.origin || row?.name || t("Add credential")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {row ? (
        <Text style={{ color: tokens.mutedForeground }}>{row.botName}</Text>
      ) : (
        <>
          <MenuPicker
            label={t("Bot")}
            choices={[
              { key: "", label: t("Choose a Bot") },
              ...bots.map((bot) => ({ key: bot.botId, label: bot.botName })),
            ]}
            value={botId}
            onChange={(next) => {
              if (!busy) {
                clear();
                setBotId(next);
              }
            }}
          />
          <Field label={t("Name")} value={name} setValue={setName} maxLength={64} />
          <MenuPicker
            label={t("Type")}
            choices={[
              { key: "bearer", label: t("Bearer token") },
              { key: "header", label: t("Custom header") },
              { key: "basic", label: t("Basic auth") },
              { key: "login", label: t("Website login") },
              { key: "command", label: t("Command variable") },
            ]}
            value={type}
            onChange={(next) => {
              if (!busy) {
                clear();
                setType(next as Auth["type"]);
                setParameter("");
              }
            }}
          />
          {type !== "command" ? (
            <Field label={t("Site")} value={origin} setValue={setOrigin} maxLength={2048} />
          ) : null}
          {type === "header" || type === "basic" ? (
            <Field
              label={type === "header" ? t("Header name") : t("Username")}
              value={parameter}
              setValue={setParameter}
              maxLength={256}
            />
          ) : null}
        </>
      )}
      {type === "login" ? (
        <>
          {fields.map((field, index) => {
            const change = (patch: Partial<typeof field>) =>
              setFields((old) =>
                old.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
              );
            return (
              <View key={index} style={styles.fieldGroup}>
                <Field
                  label={t("Field label")}
                  value={field.label}
                  setValue={(label) => change({ label })}
                  maxLength={64}
                />
                <Field
                  label={field.label || t("Value")}
                  value={field.value}
                  setValue={(value) => change({ value })}
                  maxLength={4096}
                  hidden={field.hidden}
                  autoFill={
                    field.hidden && /^password$/i.test(field.label)
                      ? "new-password"
                      : !field.hidden && /^(username|user name)$/i.test(field.label)
                        ? "username"
                        : !field.hidden && /^(email|e-mail|email address)$/i.test(field.label)
                          ? "email"
                          : undefined
                  }
                />
                <View style={styles.row}>
                  <Text style={{ flex: 1, color: tokens.foreground }}>{t("Hide value")}</Text>
                  <NativeSwitch
                    accessibilityLabel={t("Hide {label}", { label: field.label })}
                    value={field.hidden}
                    onValueChange={(hidden) => change({ hidden })}
                  />
                  {fields.length > 1 ? (
                    <NativeActionButton
                      label={t("Remove field")}
                      prominence="plain"
                      onPress={() => setFields((old) => old.filter((_, i) => i !== index))}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
          {tooLong ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {t("These login values are too long together. Shorten one or more fields.")}
            </Text>
          ) : null}
          {fields.length < LOGIN_FIELD_LIMIT ? (
            <NativeActionButton
              label={t("Add field")}
              prominence="plain"
              onPress={() => setFields((old) => [...old, { label: "", value: "", hidden: true }])}
            />
          ) : null}
        </>
      ) : (
        <Field label={t("Value")} value={value} setValue={setValue} maxLength={16_384} hidden />
      )}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Save")}
        disabled={!ready}
        busy={busy}
        onPress={() => void save()}
      />
    </CredentialSheet>
  );
}

function IdentitySheet({
  settings,
  onClose,
  onConfirm,
}: {
  settings: Pick<ReturnType<typeof useSpaceSettings>, "captureApiRequestContext" | "isCurrent">;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { captureApiRequestContext, isCurrent } = settings;
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [proof, setProof] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    void captureApiRequestContext()
      .then(fetchAccountSecurity)
      .then((value) => {
        if (active.current && isCurrent()) setSecurity(value);
      })
      .catch(() => {
        if (active.current && isCurrent()) setError(t("Could not load sign-in options"));
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [captureApiRequestContext, isCurrent, t]);

  const passwordEnabled = security?.passwordChangeEnabled && security.hasPassword;
  const emailEnabled = security?.passwordChangeEnabled && security.emailDeletion;
  async function action(kind: "confirm" | "email" | "sso") {
    if (busy || !isCurrent()) return;
    const value = proof;
    setProof("");
    setError("");
    setBusy(true);
    try {
      if (kind === "sso") {
        const confirmed = await continueWithSso("reauthenticate");
        if (confirmed && active.current) onClose();
        return;
      }
      const context = await captureApiRequestContext();
      if (!active.current || !isCurrent()) return;
      if (kind === "email") {
        await requestIdentityCode(context, lifetime.current?.signal);
        if (active.current && isCurrent()) setSent(true);
      } else {
        await confirmIdentity(
          passwordEnabled ? { password: value } : { code: value },
          context,
          lifetime.current?.signal,
        );
        if (active.current && isCurrent()) onConfirm();
      }
    } catch {
      if (active.current && isCurrent()) setError(t("Could not confirm your identity"));
    } finally {
      if (active.current && isCurrent()) setBusy(false);
    }
  }

  return (
    <CredentialSheet title={t("Confirm it's you")} onClose={onClose}>
      {passwordEnabled || sent ? (
        <>
          <Field
            label={passwordEnabled ? t("Password") : t("Code")}
            value={proof}
            setValue={setProof}
            hidden={passwordEnabled}
            autoFill={passwordEnabled ? "current-password" : undefined}
            oneTimeCode={!passwordEnabled}
            maxLength={passwordEnabled ? 128 : 6}
          />
          <NativeActionButton
            label={t("Continue")}
            disabled={!proof || busy}
            busy={busy}
            onPress={() => void action("confirm")}
          />
        </>
      ) : null}
      {security && !passwordEnabled && security.sso && security.ssoLinked ? (
        <NativeActionButton
          label={t("Sign in again")}
          disabled={busy}
          onPress={() => void action("sso")}
        />
      ) : null}
      {!passwordEnabled && emailEnabled ? (
        <NativeActionButton
          label={t("Email me a code")}
          disabled={busy}
          onPress={() => void action("email")}
        />
      ) : null}
      {error || (security && !passwordEnabled && !emailEnabled && !security.ssoLinked) ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error || t("Could not continue")}
        </Text>
      ) : null}
    </CredentialSheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12 },
  fieldGroup: { gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
});
