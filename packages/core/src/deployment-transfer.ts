import type {
  DeploymentTransferApproveInput,
  DeploymentTransferCancelInput,
  DeploymentTransferCommitInput,
  DeploymentTransferPreviewInput,
  DeploymentTransferProposeInput,
  DeploymentTransferRecent,
  DeploymentTransferStartInput,
  DeploymentTransferStatus,
  DeploymentTransferStatusInput,
} from "@rakazo/contracts";
import {
  DeploymentTransferRecentSchema,
  DeploymentTransferStatusSchema,
  normalizeDeploymentTransferOrigin,
} from "@rakazo/contracts";

export type DeploymentTransferPage =
  | { side: "source"; targetOrigin: string; locator: string }
  | { side: "source" | "target"; clientNonce: string }
  | { side: "source" | "target"; transferId: string };

/** Only local protected transfer pages can survive sign-in or open from native settings. */
export function parseDeploymentTransferPage(path: string): DeploymentTransferPage | null {
  if (
    !path.startsWith("/transfers/") ||
    path.length > 4096 ||
    path.includes("#") ||
    path.includes("\\")
  )
    return null;
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return null;
  }
  let url: URL;
  try {
    url = new URL(path, "https://navigation.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://navigation.invalid" || url.pathname !== path.split("?")[0])
    return null;
  const request = /^\/transfers\/(source|receive)\/request\/([A-Za-z0-9_-]{1,200})$/.exec(
    url.pathname,
  );
  if (request && !url.search)
    return { side: request[1] === "source" ? "source" : "target", clientNonce: request[2]! };
  const existing = /^\/transfers\/(source|receive)\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (existing && !url.search)
    return { side: existing[1] === "source" ? "source" : "target", transferId: existing[2]! };
  if (url.pathname !== "/transfers/source") return null;
  const entries = [...url.searchParams];
  if (
    entries.length !== 2 ||
    url.searchParams.getAll("targetOrigin").length !== 1 ||
    url.searchParams.getAll("locator").length !== 1
  )
    return null;
  const targetOrigin = url.searchParams.get("targetOrigin")!;
  const locator = url.searchParams.get("locator")!;
  try {
    const target = new URL(targetOrigin);
    if (target.protocol !== "https:" || target.origin !== targetOrigin) return null;
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{43}$/.test(locator) ? { side: "source", targetOrigin, locator } : null;
}

export function deploymentTransferStatusPath(
  side: "source" | "target",
  recovery: DeploymentTransferStatusInput,
): string {
  const page = side === "source" ? "source" : "receive";
  const path =
    "transferId" in recovery
      ? `/transfers/${page}/${recovery.transferId}`
      : `/transfers/${page}/request/${recovery.clientNonce}`;
  if (!parseDeploymentTransferPage(path)) throw new Error("Invalid transfer recovery address.");
  return path;
}

export type DeploymentTransferState = {
  snapshot: DeploymentTransferStatus | null;
  selected: string[];
  decisions: Record<string, "keep" | "overwrite">;
  dirty: boolean;
  request: "idle" | "loading" | "saving" | "checking" | "unknown";
  recovery: DeploymentTransferStatusInput | null;
  error: "unavailable" | "not_found" | "invalid_origin" | null;
  recent: DeploymentTransferRecent[];
  recentLoading: boolean;
};
export const initialDeploymentTransferState: DeploymentTransferState = {
  snapshot: null,
  selected: [],
  decisions: {},
  dirty: false,
  request: "idle",
  recovery: null,
  error: null,
  recent: [],
  recentLoading: false,
};
type TransferDeps = {
  side?: "source" | "target";
  start(
    input: DeploymentTransferStartInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus>;
  preview(
    input: DeploymentTransferPreviewInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus>;
  propose(
    input: DeploymentTransferProposeInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus>;
  approve(
    input: DeploymentTransferApproveInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus>;
  commit(
    input: DeploymentTransferCommitInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus>;
  status(
    input: DeploymentTransferStatusInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus | null>;
  cancel(
    input: DeploymentTransferCancelInput,
    signal: AbortSignal,
  ): Promise<DeploymentTransferStatus>;
  recent(botId: string, signal: AbortSignal): Promise<DeploymentTransferRecent[]>;
  newNonce(): string;
  isCurrent(): boolean;
  changed(state: DeploymentTransferState): void;
};

/** A browser or native host owns scope; the server owns the durable plan and every write. */
export function createDeploymentTransfer(deps: TransferDeps) {
  let state = initialDeploymentTransferState;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  let recentGeneration = 0;
  let recentPending: AbortController | null = null;
  let commitBinding: { transferId: string; digest: string; nonce: string } | null = null;
  const active = () => !disposed && deps.isCurrent();
  const current = (version: number) => active() && version === generation;
  const idle = () => active() && state.request === "idle";
  function publish(next: DeploymentTransferState) {
    state = next;
    deps.changed(next);
  }
  function invalidate() {
    generation++;
    pending?.abort();
    pending = null;
  }
  function receive(value: DeploymentTransferStatus, expected: DeploymentTransferStatusInput) {
    let next = DeploymentTransferStatusSchema.parse(value);
    if (
      ("transferId" in expected && next.transferId !== expected.transferId) ||
      ("side" in expected && next.side !== expected.side) ||
      (deps.side !== undefined && next.side !== deps.side)
    )
      throw new Error("Transfer response no longer matches its intent.");
    const before = state.snapshot;
    if (before?.transferId === next.transferId) {
      if (before.side !== next.side) throw new Error("Transfer role changed.");
      if (before.writeRevokedReason === "restore" && next.writeRevokedReason !== "restore") {
        publish({ ...state, request: "idle", recovery: null, error: null });
        return;
      }
      if (next.revision < before.revision && next.writeRevokedReason !== "restore") {
        publish({ ...state, request: "idle", recovery: null, error: null });
        return;
      }
      for (const item of before.items) {
        if (
          next.writeRevokedReason !== "restore" &&
          item.status === "copied" &&
          !next.items.some(
            (candidate) => candidate.itemKey === item.itemKey && candidate.status === "copied",
          )
        )
          throw new Error("An accepted item cannot be withdrawn by a status response.");
      }
    }
    if (next.writeRevokedReason === "restore") {
      const items = new Map(next.items.map((item) => [item.itemKey, item]));
      if (before?.transferId === next.transferId)
        for (const item of before.items) {
          if (item.status !== "copied" || items.get(item.itemKey)?.status === "copied") continue;
          // Copy is a historical fact; a restored database cannot confirm its old target observation.
          const { targetState: _targetState, reason: _reason, ...history } = item;
          items.set(item.itemKey, { ...history, canRecover: false });
        }
      next = {
        ...next,
        phase: "expired",
        canApprove: false,
        canCommit: false,
        canRecover: false,
        items: [...items.values()].map((item) => ({ ...item, canRecover: false })),
      };
      commitBinding = null;
    }
    if (next.side === "source" && next.commitNonce && next.planDigest)
      commitBinding = {
        transferId: next.transferId,
        digest: next.planDigest,
        nonce: next.commitNonce,
      };
    const decisions = Object.fromEntries(
      (next.plan?.items ?? []).map((item) => [
        item.source.itemKey,
        item.action === "overwrite" ? ("overwrite" as const) : ("keep" as const),
      ]),
    );
    publish({
      ...state,
      snapshot: next,
      decisions,
      request: "idle",
      recovery: null,
      dirty: false,
      error: null,
    });
  }
  async function mutate(
    recovery: DeploymentTransferStatusInput,
    operation: (signal: AbortSignal) => Promise<DeploymentTransferStatus>,
  ) {
    invalidate();
    const version = generation;
    const controller = new AbortController();
    pending = controller;
    // Hosts can save this non-secret recovery handle synchronously before dispatch.
    publish({ ...state, request: "saving", recovery, error: null });
    try {
      const value = await operation(controller.signal);
      if (current(version)) receive(value, recovery);
    } catch {
      if (current(version)) publish({ ...state, request: "unknown", error: "unavailable" });
    } finally {
      if (current(version)) pending = null;
    }
  }
  async function readStatus(input: DeploymentTransferStatusInput, restore = false) {
    invalidate();
    const version = generation;
    const controller = new AbortController();
    pending = controller;
    publish({
      ...state,
      ...(restore && !("transferId" in input && state.snapshot?.transferId === input.transferId)
        ? { snapshot: null, selected: [], decisions: {} }
        : {}),
      request: "checking",
      recovery: input,
      error: null,
    });
    try {
      const value = await deps.status(input, controller.signal);
      if (!current(version)) return;
      if (value) receive(value, input);
      else publish({ ...state, request: "unknown", recovery: input, error: "not_found" });
    } catch {
      if (current(version)) publish({ ...state, request: "unknown", error: "unavailable" });
    } finally {
      if (current(version)) pending = null;
    }
  }
  return {
    async startReceive(targetBotId: string, sourceOrigin: string) {
      if (!idle() || state.snapshot) return;
      let origin: string;
      try {
        origin = normalizeDeploymentTransferOrigin(sourceOrigin.trim());
      } catch {
        publish({ ...state, error: "invalid_origin" });
        return;
      }
      const clientNonce = deps.newNonce();
      await mutate({ clientNonce, side: "target" }, async (signal) => {
        const value = await deps.start({ targetBotId, sourceOrigin: origin, clientNonce }, signal);
        if (value.localScope.botId !== targetBotId) throw new Error("Target Bot changed.");
        return value;
      });
    },
    async previewSource(targetOrigin: string, locator: string, sourceBotId: string) {
      if (!idle() || state.snapshot) return;
      const clientNonce = deps.newNonce();
      await mutate({ clientNonce, side: "source" }, async (signal) => {
        const value = await deps.preview(
          { mode: "source", targetOrigin, locator, sourceBotId, clientNonce },
          signal,
        );
        if (value.localScope.botId !== sourceBotId || value.target.origin !== targetOrigin)
          throw new Error("Source selection or destination changed.");
        return value;
      });
    },
    select(itemKey: string, selected: boolean) {
      if (
        !idle() ||
        state.snapshot?.side !== "source" ||
        state.snapshot.phase !== "draft" ||
        !state.snapshot.candidates.some((item) => item.itemKey === itemKey)
      )
        return;
      const keys = new Set(state.selected);
      if (selected) keys.add(itemKey);
      else keys.delete(itemKey);
      publish({ ...state, selected: [...keys], error: null });
    },
    async propose() {
      const snapshot = state.snapshot;
      if (
        !idle() ||
        snapshot?.side !== "source" ||
        snapshot.phase !== "draft" ||
        !state.selected.length
      )
        return;
      const selected = snapshot.candidates
        .filter((item) => state.selected.includes(item.itemKey))
        .map(({ itemKey, revision }) => ({ itemKey, revision }));
      await mutate({ transferId: snapshot.transferId }, (signal) =>
        deps.propose(
          {
            transferId: snapshot.transferId,
            expectedRevision: snapshot.revision,
            selected,
          },
          signal,
        ),
      );
    },
    decide(itemKey: string, action: "keep" | "overwrite") {
      const snapshot = state.snapshot;
      const item = snapshot?.plan?.items.find((entry) => entry.source.itemKey === itemKey);
      if (
        !idle() ||
        snapshot?.side !== "target" ||
        snapshot.phase !== "previewed" ||
        !item ||
        (action === "overwrite" && !item.canOverwrite)
      )
        return;
      publish({
        ...state,
        decisions: { ...state.decisions, [itemKey]: action },
        dirty: true,
        error: null,
      });
    },
    async previewTarget() {
      const snapshot = state.snapshot;
      if (
        !idle() ||
        snapshot?.side !== "target" ||
        !["proposed", "previewed"].includes(snapshot.phase)
      )
        return;
      const decisions = Object.entries(state.decisions).map(([itemKey, action]) => ({
        itemKey,
        action,
      }));
      await mutate({ transferId: snapshot.transferId }, (signal) =>
        deps.preview(
          {
            mode: "target",
            transferId: snapshot.transferId,
            expectedRevision: snapshot.revision,
            decisions,
          },
          signal,
        ),
      );
    },
    async approve() {
      const snapshot = state.snapshot;
      if (
        !idle() ||
        state.dirty ||
        snapshot?.side !== "target" ||
        !snapshot.canApprove ||
        !snapshot.source ||
        !snapshot.plan ||
        !snapshot.planDigest
      )
        return;
      await mutate({ transferId: snapshot.transferId }, (signal) =>
        deps.approve(
          {
            transferId: snapshot.transferId,
            expectedRevision: snapshot.revision,
            planDigest: snapshot.planDigest!,
            expectedSourceFingerprint: snapshot.source!.fingerprint,
          },
          signal,
        ),
      );
    },
    async confirmCopy() {
      const snapshot = state.snapshot;
      if (
        !idle() ||
        snapshot?.side !== "source" ||
        (!snapshot.canCommit && !snapshot.canRecover) ||
        ["completed", "cancelled", "expired"].includes(snapshot.phase) ||
        !snapshot.plan ||
        !snapshot.planDigest
      )
        return;
      if (
        !commitBinding ||
        commitBinding.transferId !== snapshot.transferId ||
        commitBinding.digest !== snapshot.planDigest
      )
        commitBinding = {
          transferId: snapshot.transferId,
          digest: snapshot.planDigest,
          nonce: deps.newNonce(),
        };
      const binding = commitBinding;
      await mutate({ transferId: snapshot.transferId }, (signal) =>
        deps.commit(
          {
            transferId: snapshot.transferId,
            expectedRevision: snapshot.revision,
            planDigest: binding.digest,
            expectedTargetFingerprint: snapshot.target.fingerprint,
            clientNonce: binding.nonce,
          },
          signal,
        ),
      );
    },
    async checkStatus() {
      if (!active() || ["saving", "loading", "checking"].includes(state.request)) return;
      const input = state.snapshot ? { transferId: state.snapshot.transferId } : state.recovery;
      if (input) await readStatus(input);
    },
    async restore(input: DeploymentTransferStatusInput) {
      if (!active()) return;
      commitBinding = null;
      await readStatus(input, true);
    },
    async cancel() {
      const snapshot = state.snapshot;
      if (
        !active() ||
        !snapshot ||
        snapshot.phase === "completed" ||
        snapshot.writeRevokedReason === "restore" ||
        (["cancelled", "expired"].includes(snapshot.phase) &&
          !snapshot.items.some((item) => item.status === "unknown"))
      )
        return;
      await mutate({ transferId: snapshot.transferId }, (signal) =>
        deps.cancel(
          {
            transferId: snapshot.transferId,
            expectedRevision: snapshot.revision,
          },
          signal,
        ),
      );
    },
    async loadRecent(botId: string) {
      if (!active() || state.recentLoading) return;
      const version = ++recentGeneration;
      const controller = new AbortController();
      recentPending = controller;
      publish({ ...state, recentLoading: true });
      try {
        const value = await deps.recent(botId, controller.signal);
        if (active() && version === recentGeneration)
          publish({
            ...state,
            recent: DeploymentTransferRecentSchema.array().max(20).parse(value),
            recentLoading: false,
          });
      } catch {
        if (active() && version === recentGeneration)
          publish({ ...state, recentLoading: false, error: "unavailable" });
      } finally {
        if (active() && version === recentGeneration) recentPending = null;
      }
    },
    dispose() {
      disposed = true;
      invalidate();
      recentGeneration++;
      recentPending?.abort();
      recentPending = null;
    },
  };
}
export type DeploymentTransfer = ReturnType<typeof createDeploymentTransfer>;
