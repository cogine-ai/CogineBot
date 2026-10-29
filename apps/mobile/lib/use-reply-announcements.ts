import {
  replyAnnouncementsVisible,
  subscribeReplyAnnouncementVisibility,
} from "@rakazo/chat-ui/announcement-visibility";
import type { AnnouncementEvent, AnnouncementSnapshot } from "@rakazo/core";
import { ReplyAnnouncements } from "@rakazo/core";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";
import { useAppActive } from "./app-active";

export function useReplyAnnouncements(
  scope: string,
  snapshot: AnnouncementSnapshot | null,
  hidden = false,
) {
  const exposed = useSyncExternalStore(
    subscribeReplyAnnouncementVisibility,
    replyAnnouncementsVisible,
    replyAnnouncementsVisible,
  );
  const observer = useRef(new ReplyAnnouncements());
  const [revision, setRevision] = useState(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const focused = useIsFocused();
  const active = useAppActive();
  useEffect(() => {
    for (const text of observer.current.update(
      scope,
      focused && active && !hidden && replyAnnouncementsVisible(),
      snapshot,
    ))
      AccessibilityInfo.announceForAccessibility(text);
  }, [scope, snapshot, focused, active, hidden, exposed, revision]);
  const stop = useCallback(() => {
    if (currentScope.current !== scope) return;
    observer.current.update(
      scope,
      focused && active && !hidden && replyAnnouncementsVisible(),
      snapshot,
    );
    const runs = [...(snapshot?.activeRuns ?? []), ...(snapshot?.run ? [snapshot.run] : [])];
    observer.current.stop(
      scope,
      runs.map((run) => run.id),
    );
  }, [scope, snapshot, focused, active, hidden]);

  const observe = useCallback(
    (event: AnnouncementEvent) => {
      if (currentScope.current !== scope) return;
      observer.current.observe(
        scope,
        focused && active && !hidden && replyAnnouncementsVisible(),
        event,
      );
      if (event.type === "run.completed") setRevision((value) => value + 1);
    },
    [scope, focused, active, hidden],
  );
  return [stop, observe] as const;
}
