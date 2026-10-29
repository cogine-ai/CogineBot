import type { AnnouncementSnapshot } from "@rakazo/core";
import { ReplyAnnouncements } from "@rakazo/core";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";
import { useAppActive } from "./app-active";

export function useReplyAnnouncements(
  scope: string,
  snapshot: AnnouncementSnapshot | null,
  hidden = false,
) {
  const observer = useRef(new ReplyAnnouncements());
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const focused = useIsFocused();
  const active = useAppActive();
  useEffect(() => {
    for (const text of observer.current.update(scope, focused && active && !hidden, snapshot))
      AccessibilityInfo.announceForAccessibility(text);
  }, [scope, snapshot, focused, active, hidden]);
  return useCallback(() => {
    if (currentScope.current !== scope) return;
    observer.current.update(scope, focused && active && !hidden, snapshot);
    const runs = [...(snapshot?.activeRuns ?? []), ...(snapshot?.run ? [snapshot.run] : [])];
    observer.current.stop(
      scope,
      runs.map((run) => run.id),
    );
  }, [scope, snapshot, focused, active, hidden]);
}
