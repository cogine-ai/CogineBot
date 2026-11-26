import type { ComputerDiskUsageInput, ComputerDiskUsageResult } from "@rakazo/contracts";
import { ComputerDiskUsageResultSchema } from "@rakazo/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { coverReplyAnnouncements } from "./announcement-visibility.js";

/** Mount one instance for each committed diagnostic dialog and its Bot/session. */
export function useComputerStorage(
  input: ComputerDiskUsageInput,
  read: (input: ComputerDiskUsageInput, signal: AbortSignal) => Promise<unknown>,
  isCurrent: () => boolean,
) {
  const attempt = useRef<AbortController | null>(null);
  const boundTarget = useRef(input.expectedTarget);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ComputerDiskUsageResult>();
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const reveal = coverReplyAnnouncements();
    return () => {
      const request = attempt.current;
      attempt.current = null;
      request?.abort();
      reveal();
    };
  }, []);

  async function diagnose() {
    if (attempt.current || !isCurrent() || result?.outcome.status === "changed") return;
    const request = new AbortController();
    attempt.current = request;
    setPending(true);
    setFailed(false);
    try {
      const response = ComputerDiskUsageResultSchema.parse(
        await read({ botId: input.botId, expectedTarget: boundTarget.current }, request.signal),
      );
      if (response.botId !== input.botId) throw new Error("Diagnostic target changed");
      if (attempt.current === request && isCurrent()) {
        boundTarget.current ??= response.target ?? undefined;
        setResult(response);
      }
    } catch {
      if (attempt.current === request && isCurrent()) {
        setResult(undefined);
        setFailed(true);
      }
    } finally {
      if (attempt.current === request) {
        attempt.current = null;
        if (isCurrent()) setPending(false);
      }
    }
  }

  return { result, pending, failed, diagnose };
}
