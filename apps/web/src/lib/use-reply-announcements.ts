import type { AnnouncementSnapshot } from "@rakazo/core";
import { ReplyAnnouncements } from "@rakazo/core";
import { useCallback, useEffect, useRef } from "react";

import { useLiveAnnouncement } from "./use-live-announcement";

export function useReplyAnnouncements(
  scope: string,
  snapshot: AnnouncementSnapshot | null,
  hidden = false,
) {
  const observer = useRef(new ReplyAnnouncements());
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const { text: announcement, announce, clear } = useLiveAnnouncement(scope);
  useEffect(() => {
    const update = () => {
      const visible = !hidden && document.visibilityState === "visible";
      const text = observer.current.update(scope, visible, snapshot).join("\n");
      if (!visible) clear();
      else if (text) announce(text);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [scope, snapshot, hidden, announce, clear]);
  const stop = useCallback(() => {
    if (currentScope.current !== scope) return;
    observer.current.update(scope, !hidden && document.visibilityState === "visible", snapshot);
    const runs = [...(snapshot?.activeRuns ?? []), ...(snapshot?.run ? [snapshot.run] : [])];
    observer.current.stop(
      scope,
      runs.map((run) => run.id),
    );
    clear();
  }, [scope, snapshot, hidden, clear]);
  return [announcement, stop] as const;
}
