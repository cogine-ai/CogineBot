import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import type { GroupSettingsSaveInput } from "@rakazo/core";
import { createGroupSettingsSave } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, ScrollView, Text, TextInput } from "react-native";
import { BotMemberPicker } from "../components/bot-member-picker";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import type { MobileBot, MobileGroup } from "../lib/api";
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

export default function GroupSettingsScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [scopeKey]);
  const selecting = useSyncExternalStore(
    subscribeSpaceSelectionPending,
    isSpaceSelectionPending,
    isSpaceSelectionPending,
  );
  if (selecting) return null;
  return (
    <GroupSettingsForm key={JSON.stringify([scopeKey, groupId])} scope={scope} groupId={groupId} />
  );
}

function GroupSettingsForm({ scope, groupId }: { scope: MobileScope; groupId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const saveGroup = useRef<((input: GroupSettingsSaveInput) => Promise<MobileGroup>) | null>(null);
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
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    const eligible = () => !cancelled && current();
    void (async () => {
      const requestContext = await spaceRequestContext(scope, eligible);
      if (!eligible()) return;
      const [groups, nextBots] = await Promise.all([
        rpc<MobileGroup[]>("groups/list", {}, { requestContext }),
        rpc<MobileBot[]>("bots/list", {}, { requestContext }),
      ]);
      if (!eligible()) return;
      const nextGroup = groups.find((row) => row.id === groupId);
      if (!nextGroup || nextGroup.spaceId !== requestContext.headers["x-rakazo-space-id"])
        throw new Error(t("Group not found"));
      saveGroup.current = createGroupSettingsSave({
        group: nextGroup,
        isCurrent: current,
        isAmbiguous: isAmbiguousGroupSave,
        update: async (input) => {
          const context = await spaceRequestContext(scope, current, nextGroup.spaceId);
          return rpc<MobileGroup>(
            "groups/update",
            { groupId, ...input },
            { requestContext: context },
          );
        },
        read: async () => {
          const context = await spaceRequestContext(scope, current, nextGroup.spaceId);
          return rpc<MobileGroup>("groups/get", { groupId }, { requestContext: context });
        },
      });
      setGroup(nextGroup);
      setName(nextGroup.name);
      setSelected(nextGroup.members.map((member) => member.botId));
      setBots(nextBots.filter((bot) => !bot.archivedAt));
    })().catch((err) => {
      if (eligible()) setError(errorText(err, t("Could not load group")));
    });
    return () => {
      cancelled = true;
    };
  }, [groupId, current, scope, t]);

  async function save() {
    if (
      !groupId ||
      !group ||
      !saveGroup.current ||
      inFlight.current ||
      !current() ||
      !name.trim() ||
      selected.length < GROUP_MEMBER_MIN ||
      selected.length > GROUP_MEMBER_MAX
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const input: GroupSettingsSaveInput = {};
      if (name.trim() !== group.name) input.name = name.trim();
      const memberIds = group.members.map((member) => member.botId);
      if (
        selected.length !== memberIds.length ||
        selected.some((id, index) => id !== memberIds[index])
      ) {
        input.botIds = selected;
        input.expectedBotIds = group.members.map((member) => member.botId);
      }
      if (input.name || input.botIds) await saveGroup.current(input);
      if (current()) router.back();
    } catch (err) {
      if (current()) setError(errorText(err, t("Could not save group")));
    } finally {
      inFlight.current = false;
      if (current()) setPending(false);
    }
  }

  function remove() {
    if (!groupId || !group || inFlight.current || !current()) return;
    Alert.alert(group.name, t("Delete this group? Bots and their solo threads are kept."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          if (inFlight.current || !current()) return;
          inFlight.current = true;
          setPending(true);
          void (async () => {
            const requestContext = await spaceRequestContext(scope, current, group.spaceId);
            if (!current()) return;
            await rpc("groups/remove", { groupId }, { requestContext });
            if (current()) router.replace("/");
          })()
            .catch((err) => {
              if (current())
                Alert.alert(t("Could not delete group"), errorText(err, t("Try again.")));
            })
            .finally(() => {
              inFlight.current = false;
              if (current()) setPending(false);
            });
        },
      },
    ]);
  }

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Group settings"))} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          editable={!pending}
          onChangeText={(value) => {
            if (!inFlight.current && current()) setName(value);
          }}
          placeholder={t("Group name")}
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
        {group ? (
          <BotMemberPicker
            key={group.id}
            bots={bots}
            selected={selected}
            onChange={(value) => {
              if (!inFlight.current && current()) setSelected(value);
            }}
            disabled={pending}
          />
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          label={pending ? t("Saving…") : t("Save")}
          onPress={() => void save()}
          style={{ marginTop: 24 }}
        />
        <NativeActionButton
          disabled={pending || !group}
          label={t("Delete group")}
          onPress={remove}
          prominence="destructive"
          style={{ marginTop: 16 }}
        />
      </ScrollView>
    </>
  );
}

function isAmbiguousGroupSave(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name !== "AbortError" &&
    !("status" in error && typeof error.status === "number")
  );
}
