import { useCallback, useEffect, useRef, useState } from "react";

/** Clear before publishing so consecutive identical results are announced again. */
export function useLiveAnnouncement(scope: string) {
  const mounted = useRef(true);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string[]>([]);
  const [announcement, setAnnouncement] = useState({ scope, text: "" });
  const clear = useCallback(() => {
    if (currentScope.current !== scope || !mounted.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = [];
    setAnnouncement({ scope, text: "" });
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    clear();
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pending.current = [];
    };
  }, [clear]);
  const announce = useCallback(
    (text: string) => {
      if (
        !text ||
        !mounted.current ||
        currentScope.current !== scope ||
        document.visibilityState !== "visible"
      )
        return;
      pending.current.push(text);
      if (timer.current !== null) return;
      setAnnouncement({ scope, text: "" });
      timer.current = setTimeout(() => {
        timer.current = null;
        const text = pending.current.join("\n");
        pending.current = [];
        if (
          mounted.current &&
          currentScope.current === scope &&
          document.visibilityState === "visible"
        )
          setAnnouncement({ scope, text });
      }, 0);
    },
    [scope],
  );
  return { text: announcement.scope === scope ? announcement.text : "", announce, clear };
}
