import type {
  ComputerCleanupPlan,
  ComputerDiskUsageInput,
  ComputerDiskUsageResult,
  ConfirmComputerCleanupInput,
  PlanComputerCleanupInput,
  UpdateComputerCleanupInput,
} from "@rakazo/contracts";
import { ComputerCleanupPlanSchema, ComputerDiskUsageResultSchema } from "@rakazo/contracts";
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

/** Bound to one diagnosis and disposed when the dialog or diagnosis changes. */
export function useComputerCleanup(
  diagnosis: ComputerDiskUsageResult,
  api: {
    plan: (input: PlanComputerCleanupInput, signal: AbortSignal) => Promise<unknown>;
    confirm: (input: ConfirmComputerCleanupInput, signal: AbortSignal) => Promise<unknown>;
    cancel: (input: UpdateComputerCleanupInput, signal: AbortSignal) => Promise<unknown>;
  },
  isCurrent: () => boolean,
) {
  const attempt = useRef<AbortController | null>(null);
  const planNonce = useRef<string>(undefined);
  const confirmNonce = useRef<string>(undefined);
  const [selected, setSelected] = useState(new Set<string>());
  const [plan, setPlan] = useState<ComputerCleanupPlan>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const candidates =
    diagnosis.outcome.status === "available" ? diagnosis.outcome.data.candidates : [];
  const canSelect = !!diagnosis.target && candidates.some((file) => file.cleanup);

  useLayoutEffect(
    () => () => {
      const request = attempt.current;
      attempt.current = null;
      request?.abort();
    },
    [],
  );

  function choose(path: string, checked: boolean) {
    if (attempt.current || plan || !isCurrent()) return;
    planNonce.current = undefined;
    setFailed(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function submit(send: (signal: AbortSignal) => Promise<unknown>) {
    if (attempt.current || !isCurrent()) return;
    const request = new AbortController();
    attempt.current = request;
    setBusy(true);
    setFailed(false);
    try {
      const response = ComputerCleanupPlanSchema.parse(await send(request.signal));
      if (response.botId !== diagnosis.botId || (plan && response.id !== plan.id))
        throw new Error("Cleanup selection changed");
      if (attempt.current === request && isCurrent()) {
        if (response.status === "cancelled") {
          planNonce.current = undefined;
          confirmNonce.current = undefined;
          setPlan(undefined);
        } else {
          setPlan(response);
        }
      }
    } catch {
      if (attempt.current === request && isCurrent()) setFailed(true);
    } finally {
      if (attempt.current === request) {
        attempt.current = null;
        if (isCurrent()) setBusy(false);
      }
    }
  }

  function review() {
    const expectedTarget = diagnosis.target;
    if (plan || !expectedTarget || !selected.size) return;
    const files = candidates.flatMap(({ path, cleanup }) =>
      cleanup && selected.has(path) ? [{ path, version: cleanup.version }] : [],
    );
    if (!files.length) return;
    const requestNonce = planNonce.current ?? cleanupNonce();
    planNonce.current = requestNonce;
    return submit((signal) =>
      api.plan(
        {
          botId: diagnosis.botId,
          expectedTarget,
          selected: files,
          requestNonce,
        },
        signal,
      ),
    );
  }

  function finish(action: "confirm" | "cancel") {
    if (plan?.status !== "awaiting_confirmation") return;
    const input = { botId: diagnosis.botId, planId: plan.id, expectedRevision: plan.revision };
    if (action === "cancel") return submit((signal) => api.cancel(input, signal));
    const requestNonce = confirmNonce.current ?? cleanupNonce();
    confirmNonce.current = requestNonce;
    return submit((signal) => api.confirm({ ...input, confirmed: true, requestNonce }, signal));
  }

  return { candidates, canSelect, selected, plan, busy, failed, choose, review, finish };
}

function cleanupNonce() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
