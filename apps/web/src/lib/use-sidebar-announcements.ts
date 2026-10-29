import { useLingui } from "@lingui/react/macro";
import { useCallback, useRef } from "react";
import { useLiveAnnouncement } from "./use-live-announcement";

type DragResult = boolean | "cancelled";
type Drag = { scope: string; name: string; target: string | null; pending: boolean };

export function useSidebarAnnouncements(scope: string) {
  const { t } = useLingui();
  const live = useLiveAnnouncement(scope);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const drag = useRef<Drag | null>(null);
  const start = useCallback(
    (name: string) => {
      drag.current = { scope, name, target: null, pending: false };
      live.announce(t`Moving ${name}`);
    },
    [scope, live.announce, t],
  );
  const target = useCallback(
    (targetName: string) => {
      const current = drag.current;
      if (!current || current.scope !== currentScope.current || current.target === targetName)
        return;
      current.target = targetName;
      const { name } = current;
      live.announce(t`Move ${name} to ${targetName}`);
    },
    [live.announce, t],
  );
  const accept = useCallback(() => {
    const current = drag.current;
    if (!current || current.scope !== currentScope.current) return (_result: DragResult) => {};
    current.pending = true;
    return (result: DragResult) => {
      if (drag.current !== current || current.scope !== currentScope.current) return;
      drag.current = null;
      const { name } = current;
      live.announce(
        result === "cancelled"
          ? t`Move cancelled`
          : result
            ? t`Moved ${name}`
            : t`Could not move ${name}`,
      );
    };
  }, [live.announce, t]);
  const end = useCallback(() => {
    const current = drag.current;
    if (!current || current.scope !== currentScope.current || current.pending) return;
    drag.current = null;
    live.announce(t`Move cancelled`);
  }, [live.announce, t]);
  return { text: live.text, start, target, accept, end };
}
