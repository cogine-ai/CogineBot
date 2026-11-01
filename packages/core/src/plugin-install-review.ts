import type {
  PluginInstallInput,
  PluginInstallReceipt,
  PluginPreview,
  PluginUninstallInput,
} from "@rakazo/contracts";
import { PluginInstallReceiptSchema, PluginPreviewSchema } from "@rakazo/contracts";

export type PluginInstallReviewState = {
  source: string;
  phase: "idle" | "previewing" | "review" | "installing" | "unknown" | "installed" | "terminal";
  preview: PluginPreview | null;
  receipt: PluginInstallReceipt | null;
  installations: PluginInstallReceipt[];
  loading: boolean;
  removingId: string | null;
  removalUnknownId: string | null;
  retryChecked: boolean;
  error: unknown;
  listError: unknown;
};

export function initialPluginInstallReview(): PluginInstallReviewState {
  return {
    source: "",
    phase: "idle",
    preview: null,
    receipt: null,
    installations: [],
    loading: false,
    removingId: null,
    removalUnknownId: null,
    retryChecked: false,
    error: null,
    listError: null,
  };
}

/** Owns an explicit preview, one install nonce and read-only recovery of uncertain writes. */
export function createPluginInstallReview(options: {
  preview(input: { source: string }, signal: AbortSignal): Promise<PluginPreview>;
  install(input: PluginInstallInput, signal: AbortSignal): Promise<PluginInstallReceipt>;
  list(signal: AbortSignal): Promise<PluginInstallReceipt[]>;
  uninstall(input: PluginUninstallInput, signal: AbortSignal): Promise<PluginInstallReceipt>;
  makeNonce(): string;
  isCurrent(): boolean;
  changed(state: PluginInstallReviewState): void;
}) {
  const api = { ...options };
  let state = initialPluginInstallReview();
  let submitted: Readonly<PluginInstallInput> | null = null;
  let reviewed: Omit<PluginInstallInput, "clientNonce"> | null = null;
  let reviewGeneration = 0;
  let listGeneration = 0;
  let closed = false;
  let busy = false;
  let active: AbortController | null = null;
  let listing: AbortController | null = null;
  const current = () => !closed && api.isCurrent();
  function publish(patch: Partial<PluginInstallReviewState>) {
    state = { ...state, ...patch };
    if (current()) api.changed({ ...state });
  }
  function acceptReceipt(receipt: PluginInstallReceipt) {
    listGeneration += 1;
    listing?.abort();
    publish({
      loading: false,
      installations: [receipt, ...state.installations.filter((row) => row.id !== receipt.id)],
    });
  }
  function sameRequest(receipt: PluginInstallReceipt, input: PluginInstallInput) {
    return (
      receipt.clientNonce === input.clientNonce &&
      receipt.source === input.source &&
      receipt.sourceSha === input.sourceSha &&
      receipt.digest === input.digest
    );
  }
  function receiptPhase(receipt: PluginInstallReceipt): PluginInstallReviewState["phase"] {
    return receipt.status === "installing"
      ? "unknown"
      : receipt.status === "installed"
        ? "installed"
        : "terminal";
  }
  function exactReceipt(left: PluginInstallReceipt, right: PluginInstallReceipt) {
    return (
      left.id === right.id &&
      left.revision === right.revision &&
      left.status === right.status &&
      sameRequest(left, right)
    );
  }
  function canUninstall(receipt: PluginInstallReceipt) {
    if (
      !current() ||
      busy ||
      state.removingId ||
      state.removalUnknownId ||
      receipt.status === "removed" ||
      !state.installations.some((row) => exactReceipt(row, receipt))
    )
      return false;
    return (
      state.phase !== "unknown" ||
      (state.receipt?.status === "installing" && exactReceipt(state.receipt, receipt))
    );
  }
  function receive(receipt: PluginInstallReceipt) {
    acceptReceipt(receipt);
    publish({
      receipt,
      phase: receiptPhase(receipt),
      error: null,
      retryChecked: false,
    });
  }
  async function refresh() {
    if (!current()) return null;
    listing?.abort();
    const controller = new AbortController();
    listing = controller;
    const token = ++listGeneration;
    publish({ loading: true, listError: null });
    try {
      const rows = PluginInstallReceiptSchema.array().parse(await api.list(controller.signal));
      if (!current() || token !== listGeneration) return null;
      const confirmedRemoval =
        state.removalUnknownId && rows.some((row) => row.id === state.removalUnknownId);
      publish({
        installations: rows,
        loading: false,
        listError: null,
        ...(confirmedRemoval ? { error: null } : {}),
        removalUnknownId:
          state.removalUnknownId && !rows.some((row) => row.id === state.removalUnknownId)
            ? state.removalUnknownId
            : null,
      });
      const known = state.receipt;
      const latest =
        known &&
        rows.find(
          (row) => row.id === known.id && row.revision >= known.revision && sameRequest(row, known),
        );
      if (latest) publish({ receipt: latest, phase: receiptPhase(latest) });
      return rows;
    } catch (error) {
      if (current() && token === listGeneration) publish({ loading: false, listError: error });
      return null;
    } finally {
      if (listing === controller) listing = null;
    }
  }
  return {
    state: () => ({ ...state }),
    canUninstall,
    refresh,
    changeSource(source: string) {
      if (
        !current() ||
        state.phase === "installing" ||
        state.phase === "unknown" ||
        state.removingId
      )
        return false;
      reviewGeneration += 1;
      active?.abort();
      active = null;
      busy = false;
      reviewed = null;
      submitted = null;
      publish({
        source,
        phase: "idle",
        preview: null,
        receipt: null,
        error: null,
        retryChecked: false,
      });
      return true;
    },
    async preview(source: string) {
      if (!current() || busy || state.phase === "unknown") return;
      const token = ++reviewGeneration;
      const controller = new AbortController();
      active?.abort();
      active = controller;
      busy = true;
      reviewed = null;
      submitted = null;
      publish({
        source,
        phase: "previewing",
        preview: null,
        receipt: null,
        error: null,
        retryChecked: false,
      });
      try {
        const value = PluginPreviewSchema.parse(await api.preview({ source }, controller.signal));
        if (!current() || token !== reviewGeneration) return;
        reviewed = Object.freeze({
          source: value.source,
          sourceSha: value.sourceSha,
          digest: value.digest,
        });
        publish({ preview: value, phase: "review" });
      } catch (error) {
        if (current() && token === reviewGeneration) publish({ phase: "review", error });
      } finally {
        if (active === controller) {
          active = null;
          busy = false;
        }
      }
    },
    async install() {
      if (
        !current() ||
        busy ||
        !reviewed ||
        (state.phase === "unknown" && !state.retryChecked) ||
        (state.phase !== "review" && state.phase !== "unknown")
      )
        return;
      submitted ??= Object.freeze({ ...reviewed, clientNonce: api.makeNonce() });
      const input = submitted;
      const token = reviewGeneration;
      const controller = new AbortController();
      active = controller;
      busy = true;
      publish({ phase: "installing", error: null, retryChecked: false });
      try {
        const receipt = PluginInstallReceiptSchema.parse(
          await api.install({ ...input }, controller.signal),
        );
        if (!current() || token !== reviewGeneration) return;
        if (!sameRequest(receipt, input))
          throw new Error("Installation receipt does not match this request");
        receive(receipt);
      } catch (error) {
        if (current() && token === reviewGeneration) publish({ phase: "unknown", error });
      } finally {
        if (active === controller) {
          active = null;
          busy = false;
        }
      }
    },
    async check() {
      if (!current() || busy || state.phase !== "unknown" || !submitted) return;
      const token = reviewGeneration;
      const input = submitted;
      const rows = await refresh();
      if (!rows || !current() || token !== reviewGeneration) return;
      const receipt = rows.find((row) => row.clientNonce === input.clientNonce);
      if (receipt && !sameRequest(receipt, input)) {
        publish({
          error: new Error("Installation receipt does not match this request"),
          retryChecked: false,
        });
      } else if (receipt) {
        receive(receipt);
      } else {
        publish({ retryChecked: state.receipt?.status !== "installing", error: null });
      }
    },
    async uninstall(receipt: PluginInstallReceipt) {
      if (!canUninstall(receipt)) return;
      const controller = new AbortController();
      active = controller;
      busy = true;
      publish({ removingId: receipt.id, error: null });
      try {
        const result = PluginInstallReceiptSchema.parse(
          await api.uninstall(
            { installId: receipt.id, expectedRevision: receipt.revision },
            controller.signal,
          ),
        );
        if (!current()) return;
        if (
          result.id !== receipt.id ||
          !sameRequest(result, receipt) ||
          result.revision < receipt.revision
        ) {
          throw new Error("Removal receipt does not match this installation");
        }
        acceptReceipt(result);
        publish({
          removalUnknownId: null,
          ...(state.receipt?.id === result.id
            ? { receipt: result, phase: receiptPhase(result), retryChecked: false }
            : {}),
        });
      } catch (error) {
        if (current()) publish({ error, removalUnknownId: receipt.id });
      } finally {
        if (active === controller) {
          active = null;
          busy = false;
          if (current()) publish({ removingId: null });
        }
      }
    },
    dispose() {
      closed = true;
      reviewGeneration += 1;
      listGeneration += 1;
      active?.abort();
      listing?.abort();
    },
  };
}

export type PluginInstallReview = ReturnType<typeof createPluginInstallReview>;
