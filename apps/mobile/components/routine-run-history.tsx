import type { RoutineHistory } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { activityStatusLabel } from "../lib/activity";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { isMobileScopeCurrent } from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";
import { NativeActionButton } from "./native-action-button";
import { RunErrorNotice } from "./run-error-notice";

/** An existing Routine's history is read-only, including its failure diagnostics. */
export function RoutineRunHistory({
  routineId,
  owner,
  spaceId,
  isCurrent,
}: {
  routineId: string;
  owner: MobileScope;
  spaceId: string;
  isCurrent: () => boolean;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [history, setHistory] = useState<RoutineHistory | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const binding = useRef({ owner, spaceId, routineId, isCurrent });
  binding.current = { owner, spaceId, routineId, isCurrent };
  const ownerKey = JSON.stringify(owner);

  async function load(older = false) {
    if (request.current || !binding.current.isCurrent() || !isMobileScopeCurrent(owner)) return;
    const epoch = generation.current;
    const controller = new AbortController();
    request.current = controller;
    const eligible = () =>
      !controller.signal.aborted &&
      epoch === generation.current &&
      binding.current.routineId === routineId &&
      binding.current.spaceId === spaceId &&
      isMobileScopeCurrent(owner) &&
      binding.current.isCurrent();
    setLoading(true);
    try {
      const context = await spaceRequestContext(owner, eligible, spaceId);
      if (!eligible()) return;
      const next = await rpc<RoutineHistory>(
        "routines/history",
        {
          routineId,
          ...(older && history?.nextCursor ? { before: history.nextCursor } : {}),
        },
        { requestContext: context, signal: controller.signal },
      );
      if (!eligible()) return;
      setHistory((current) =>
        older && current
          ? {
              runs: [
                ...current.runs,
                ...next.runs.filter((run) => !current.runs.some((row) => row.id === run.id)),
              ],
              nextCursor: next.nextCursor,
            }
          : next,
      );
      setFailed(false);
    } catch {
      if (eligible()) setFailed(true);
    } finally {
      if (request.current === controller) request.current = null;
      if (eligible()) setLoading(false);
    }
  }

  useEffect(() => {
    generation.current += 1;
    setHistory(null);
    setFailed(false);
    void load();
    return () => {
      generation.current += 1;
      request.current?.abort();
      request.current = null;
    };
  }, [routineId, ownerKey, spaceId, revision]);

  return (
    <View style={{ gap: 8 }}>
      <NativeActionButton
        label={t("Run history")}
        fill={false}
        onPress={() => setExpanded((value) => !value)}
      />
      {failed ? (
        <Text style={{ color: tokens.destructive }}>{t("Could not load run history")}</Text>
      ) : null}
      {history?.runs.length === 0 ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No runs yet")}</Text>
      ) : null}
      {(expanded ? history?.runs : history?.runs.slice(0, 1))?.map((run) => (
        <View
          key={run.id}
          style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderColor: tokens.border }}
        >
          <Text style={{ color: tokens.foreground }}>
            {new Date(run.startedAt ?? run.createdAt).toLocaleString(locale)}
          </Text>
          <Text
            style={{ color: run.status === "failed" ? tokens.destructive : tokens.mutedForeground }}
          >
            {activityStatusLabel(run.status)}
          </Text>
          {run.error ? <RunErrorNotice key={`${ownerKey}:${run.id}`} error={run.error} /> : null}
          {run.messageId ? (
            <NativeActionButton
              label={t("View chat")}
              fill={false}
              onPress={() => {
                if (!binding.current.isCurrent() || !isMobileScopeCurrent(owner)) return;
                router.push({
                  pathname: "/thread",
                  params: {
                    ...(run.groupId ? { groupId: run.groupId } : { botId: run.botId }),
                    messageId: run.messageId!,
                  },
                });
              }}
            />
          ) : null}
        </View>
      ))}
      {loading ? <Text style={{ color: tokens.mutedForeground }}>{t("Loading…")}</Text> : null}
      {expanded || failed ? (
        <NativeActionButton
          label={t("Refresh")}
          fill={false}
          disabled={loading}
          onPress={() => setRevision((value) => value + 1)}
        />
      ) : null}
      {expanded && history?.nextCursor ? (
        <NativeActionButton
          label={t("Load more")}
          fill={false}
          disabled={loading}
          onPress={() => void load(true)}
        />
      ) : null}
    </View>
  );
}
