import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { BotMemberPicker } from "../components/bot-member-picker";
import { NativeActionButton } from "../components/native-action-button";
import type { MobileBot } from "../lib/api";
import { isSpaceSelectionPending, rpc, subscribeSpaceSelectionPending } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { native, useMobileTokens } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";

export default function NewGroup() {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [scopeKey]);
  const selecting = useSyncExternalStore(
    subscribeSpaceSelectionPending,
    isSpaceSelectionPending,
    isSpaceSelectionPending,
  );
  if (selecting) return null;
  return <NewGroupForm key={scopeKey} scope={scope} />;
}

function NewGroupForm({ scope }: { scope: MobileScope }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const current = useCallback(
    () => mounted.current && !isSpaceSelectionPending() && isMobileScopeCurrent(scope),
    [scope],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const creation = useRef<{ signature: string; clientNonce: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const eligible = () => !cancelled && current();
    void (async () => {
      const requestContext = await spaceRequestContext(scope, eligible);
      if (!eligible()) return;
      const nextBots = await rpc<MobileBot[]>("bots/list", {}, { requestContext });
      if (eligible()) setBots(nextBots.filter((bot) => !bot.archivedAt));
    })().catch((err) => {
      if (eligible()) setError(errorText(err, t("Could not load bots")));
    });
    return () => {
      cancelled = true;
    };
  }, [current, scope, t]);

  async function create() {
    if (
      !name.trim() ||
      selected.length < GROUP_MEMBER_MIN ||
      selected.length > GROUP_MEMBER_MAX ||
      inFlight.current ||
      !current()
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const input = { name: name.trim(), botIds: [...selected] };
      const signature = JSON.stringify(input);
      if (creation.current?.signature !== signature) {
        creation.current = { signature, clientNonce: newClientNonce() };
      }
      const requestContext = await spaceRequestContext(scope, current);
      if (!current()) return;
      const group = await rpc<{ id: string; name: string }>(
        "groups/create",
        {
          ...input,
          clientNonce: creation.current.clientNonce,
        },
        { requestContext },
      );
      if (!current()) return;
      if (!group?.id) throw new Error(t("Could not create group"));
      router.replace({
        pathname: "/group-thread",
        params: { groupId: group.id, name: group.name },
      });
    } catch (err) {
      if (current()) setError(errorText(err, t("Could not create group")));
    } finally {
      inFlight.current = false;
      if (current()) setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("New group") }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          editable={!pending}
          onChangeText={(value) => {
            if (!inFlight.current && current()) setName(value);
          }}
          placeholder={t("Name this group")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 14,
            color: tokens.foreground,
            fontSize: 16,
          }}
        />
        <BotMemberPicker
          bots={bots}
          selected={selected}
          onChange={(value) => {
            if (!inFlight.current && current()) setSelected(value);
          }}
          disabled={pending}
          initiallyExpanded
        />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          label={pending ? t("Creating…") : t("Create group")}
          onPress={() => void create()}
          style={{ marginTop: 24 }}
        />
      </ScrollView>
    </>
  );
}

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
