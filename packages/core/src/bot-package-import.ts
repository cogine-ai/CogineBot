import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  AgentBackupModel,
  BotPackageImportInput,
  BotPackagePreview,
  BotPackagePreviewInput,
  BotPackageReceipt,
  BotPackageRecentReceipt,
} from "@rakazo/contracts";
import {
  AgentBackupModelSchema,
  BOT_PACKAGE_MAX_BYTES,
  BOT_PACKAGE_MAX_ROUTINES,
  botPackageUtf8Bytes,
  isBackupMcpPath,
} from "@rakazo/contracts";
import { agentBackupPreview, botImportJsonObject, isBackupRoutine } from "./agent-backup/index.js";

export class BackupModelKeyUnavailable extends Error {
  constructor() {
    super("Could not read the selected backup model key.");
  }
}

/** The projection excludes credentials and preserves the source kind and reviewed content. */
export function backupModelKeySourceDigest(source: string) {
  return bytesToHex(sha256(new TextEncoder().encode(source)));
}

export type BotPackageImportState = {
  source: string;
  name: string;
  includeMemory: boolean;
  includeBackupModel: boolean;
  importModelKey: boolean;
  excludedBackupPaths: readonly string[];
  includedBackupRoutines: readonly string[];
  includedBackupConnections: readonly string[];
  phase: "editing" | "previewing" | "review" | "importing" | "checking" | "unknown" | "completed";
  preview: BotPackagePreview | null;
  receipt: BotPackageReceipt | null;
  clientNonce: string | null;
  error: unknown | null;
  recent: BotPackageRecentReceipt[];
  recentLoading: boolean;
  recentError: unknown | null;
  canRetry: boolean;
};

export const initialBotPackageImport: BotPackageImportState = {
  source: "",
  name: "",
  includeMemory: false,
  includeBackupModel: false,
  importModelKey: false,
  excludedBackupPaths: [],
  includedBackupRoutines: [],
  includedBackupConnections: [],
  phase: "editing",
  preview: null,
  receipt: null,
  clientNonce: null,
  error: null,
  recent: [],
  recentLoading: false,
  recentError: null,
  canRetry: false,
};

type Deps = {
  preview(input: BotPackagePreviewInput, signal: AbortSignal): Promise<BotPackagePreview>;
  import(input: BotPackageImportInput, signal: AbortSignal): Promise<BotPackageReceipt>;
  status(input: { clientNonce: string }, signal: AbortSignal): Promise<BotPackageReceipt | null>;
  recent(signal: AbortSignal): Promise<BotPackageRecentReceipt[]>;
  resume(
    input: { clientNonce: string; apiKey?: string },
    signal: AbortSignal,
  ): Promise<BotPackageReceipt>;
  readModelKey?(
    model: AgentBackupModel,
    sourceDigest: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  cancel(input: { clientNonce: string }, signal: AbortSignal): Promise<BotPackageReceipt>;
  newNonce(): string;
  isCurrent(): boolean;
  changed(state: BotPackageImportState): void;
};

function settled(receipt: BotPackageReceipt | null): boolean {
  return receipt !== null && ["completed", "cancelled", "removed"].includes(receipt.status);
}

/** A lost response retains its intent until the server settles or cancels that nonce. */
export function createBotPackageImport(deps: Deps) {
  let state = initialBotPackageImport;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  let recentGeneration = 0;
  let recentPending: AbortController | null = null;
  const active = () => !disposed && deps.isCurrent();
  const current = (version: number) => active() && version === generation;
  function publish(next: BotPackageImportState) {
    state = next;
    deps.changed(next);
  }
  function invalidate() {
    generation++;
    pending?.abort();
    pending = null;
  }
  function begin(phase: BotPackageImportState["phase"], clientNonce = state.clientNonce) {
    invalidate();
    const controller = new AbortController();
    pending = controller;
    const version = generation;
    publish({ ...state, phase, clientNonce, error: null, canRetry: false });
    return { controller, version };
  }
  async function readModelKey(
    model: AgentBackupModel,
    sourceDigest: string | null | undefined,
    signal: AbortSignal,
  ) {
    try {
      return sourceDigest ? await deps.readModelKey?.(model, sourceDigest, signal) : undefined;
    } catch {
      return undefined;
    }
  }
  function receive(receipt: BotPackageReceipt, nonce: string) {
    if (receipt.clientNonce !== nonce) throw new Error("Could not confirm this import.");
    if (
      state.receipt !== null &&
      (receipt.importId !== state.receipt.importId || receipt.revision < state.receipt.revision)
    )
      throw new Error("Could not confirm the current import receipt.");
    const digest = state.preview?.digest ?? state.receipt?.digest;
    if (digest && receipt.status !== "cancelled" && receipt.digest !== digest)
      throw new Error("Could not confirm the reviewed package.");
    const done = settled(receipt);
    publish({
      ...state,
      ...(done
        ? {
            source: "",
            name: "",
            includeMemory: false,
            includeBackupModel: false,
            importModelKey: false,
            excludedBackupPaths: [],
            includedBackupRoutines: [],
            includedBackupConnections: [],
            preview: null,
          }
        : {}),
      phase: done ? "completed" : "unknown",
      receipt,
      clientNonce: nonce,
      error: null,
      canRetry: !done,
    });
  }
  async function write(
    nonce: string,
    request: (signal: AbortSignal) => Promise<BotPackageReceipt>,
  ) {
    const { controller, version } = begin("importing", nonce);
    if (!current(version)) return;
    try {
      const receipt = await request(controller.signal);
      if (current(version)) receive(receipt, nonce);
    } catch (error) {
      if (current(version)) publish({ ...state, phase: "unknown", error, canRetry: false });
    } finally {
      if (current(version)) pending = null;
    }
  }
  async function check() {
    const nonce = state.clientNonce;
    if (
      !active() ||
      !nonce ||
      settled(state.receipt) ||
      state.phase === "importing" ||
      state.phase === "checking"
    )
      return;
    const { controller, version } = begin("checking", nonce);
    if (!current(version)) return;
    try {
      const receipt = await deps.status({ clientNonce: nonce }, controller.signal);
      if (!current(version)) return;
      if (receipt) receive(receipt, nonce);
      else if (state.receipt) {
        publish({
          ...state,
          phase: "unknown",
          error: new Error("Could not confirm the existing import receipt."),
          canRetry: false,
        });
      } else {
        // Absence is not a fence against an earlier request arriving later. Keep this nonce locked.
        publish({ ...state, phase: "unknown", receipt: null, error: null, canRetry: true });
      }
    } catch (error) {
      if (current(version)) publish({ ...state, phase: "unknown", error, canRetry: false });
    } finally {
      if (current(version)) pending = null;
    }
  }
  return {
    edit(
      input: Partial<
        Pick<
          BotPackageImportState,
          "source" | "name" | "includeMemory" | "includeBackupModel" | "importModelKey"
        >
      >,
    ) {
      if (!active() || state.clientNonce !== null) return;
      const replacingSource = input.source !== undefined;
      const includeMemory = replacingSource ? false : (input.includeMemory ?? state.includeMemory);
      const includeBackupModel = replacingSource
        ? false
        : (input.includeBackupModel ?? state.includeBackupModel);
      const importModelKey = includeBackupModel && (input.importModelKey ?? state.importModelKey);
      if (
        (input.source === undefined || input.source === state.source) &&
        (input.name === undefined || input.name === state.name) &&
        includeMemory === state.includeMemory &&
        includeBackupModel === state.includeBackupModel &&
        importModelKey === state.importModelKey &&
        !(
          replacingSource &&
          (state.excludedBackupPaths.length ||
            state.includedBackupRoutines.length ||
            state.includedBackupConnections.length)
        )
      )
        return;
      invalidate();
      publish({
        ...state,
        ...input,
        includeMemory,
        includeBackupModel,
        importModelKey,
        ...(replacingSource
          ? { excludedBackupPaths: [], includedBackupRoutines: [], includedBackupConnections: [] }
          : {}),
        phase: "editing",
        preview: null,
        error: null,
        canRetry: false,
      });
    },
    setBackupFileIncluded(path: string, included: boolean) {
      if (!active() || state.clientNonce !== null) return;
      const routine = isBackupRoutine(path);
      const connection = isBackupMcpPath(path);
      const key = connection
        ? "includedBackupConnections"
        : routine
          ? "includedBackupRoutines"
          : "excludedBackupPaths";
      const choices = new Set(state[key]);
      const store = routine || connection ? included : !included;
      if (store === choices.has(path)) return;
      if (routine && store && choices.size >= BOT_PACKAGE_MAX_ROUTINES) return;
      if (store) choices.add(path);
      else choices.delete(path);
      invalidate();
      publish({
        ...state,
        [key]: [...choices],
        phase: "editing",
        preview: null,
        error: null,
        canRetry: false,
      });
    },
    async preview() {
      if (!active() || state.clientNonce !== null || state.phase === "previewing") return;
      if (!state.source.trim() || botPackageUtf8Bytes(state.source) > BOT_PACKAGE_MAX_BYTES) {
        publish({
          ...state,
          phase: "editing",
          preview: null,
          error: new Error("Choose a package of at most 4 MiB."),
        });
        return;
      }
      const { controller, version } = begin("previewing");
      if (!current(version)) return;
      try {
        const projection = agentBackupPreview(
          state.source,
          state.includeMemory,
          state.excludedBackupPaths,
          state.includedBackupRoutines,
          state.includeBackupModel,
          state.includedBackupConnections,
        );
        const model = state.importModelKey
          ? AgentBackupModelSchema.safeParse(botImportJsonObject(projection.source)?.model).data
          : undefined;
        const sourceDigest = model ? backupModelKeySourceDigest(state.source) : null;
        const available = Boolean(
          model && (await readModelKey(model, sourceDigest, controller.signal)),
        );
        const input = {
          ...projection,
          ...(state.name.trim() ? { name: state.name } : {}),
          includeMemory: state.includeMemory,
          ...(state.importModelKey ? { importModelKey: available } : {}),
          ...(available && sourceDigest ? { modelKeySourceDigest: sourceDigest } : {}),
        };
        if (!current(version)) return;
        const preview = await deps.preview(input, controller.signal);
        if (!current(version)) return;
        if (preview.includeMemory !== input.includeMemory)
          throw new Error("Could not confirm the preview options.");
        if (
          preview.modelKey &&
          (!input.importModelKey ||
            preview.modelKey.provider !== model?.provider ||
            preview.modelKey.modelId !== model.modelId)
        )
          throw new Error("Could not confirm the reviewed model key selection.");
        if (
          input.backupRoutines?.length &&
          preview.document.routines.length !== input.backupRoutines.length
        )
          throw new Error("Could not confirm the reviewed schedules.");
        publish({ ...state, phase: "review", preview, receipt: null, error: null });
      } catch (error) {
        if (current(version)) publish({ ...state, phase: "editing", preview: null, error });
      } finally {
        if (current(version)) pending = null;
      }
    },
    async confirm() {
      const preview = state.preview;
      if (
        !active() ||
        !preview ||
        preview.canImport === false ||
        (state.phase !== "review" &&
          !(state.phase === "unknown" && state.canRetry && state.receipt === null))
      )
        return;
      let apiKey: string | undefined;
      if (preview.modelKey) {
        const { controller, version } = begin("previewing");
        apiKey = await readModelKey(
          preview.modelKey,
          backupModelKeySourceDigest(state.source),
          controller.signal,
        );
        if (!current(version)) return;
        pending = null;
        if (!apiKey) {
          publish({
            ...state,
            phase: state.clientNonce ? "unknown" : "review",
            canRetry: state.clientNonce !== null,
            error: new BackupModelKeyUnavailable(),
          });
          return;
        }
      }
      const nonce = state.clientNonce ?? deps.newNonce();
      await write(nonce, (signal) =>
        deps.import(
          {
            previewToken: preview.previewToken,
            clientNonce: nonce,
            ...(apiKey ? { apiKey } : {}),
          },
          signal,
        ),
      );
    },
    check,
    async recover(clientNonce: string) {
      if (
        !active() ||
        state.phase === "importing" ||
        state.phase === "checking" ||
        (state.clientNonce !== null && !settled(state.receipt) && state.clientNonce !== clientNonce)
      )
        return;
      if (state.clientNonce === clientNonce) {
        await check();
        return;
      }
      invalidate();
      publish({
        ...state,
        source: "",
        name: "",
        includeMemory: false,
        includeBackupModel: false,
        importModelKey: false,
        excludedBackupPaths: [],
        includedBackupRoutines: [],
        includedBackupConnections: [],
        preview: null,
        receipt: null,
        clientNonce,
        phase: "unknown",
        error: null,
        canRetry: false,
      });
      await check();
    },
    async resume() {
      const nonce = state.clientNonce;
      if (
        !active() ||
        !nonce ||
        state.phase !== "unknown" ||
        !state.canRetry ||
        !state.receipt ||
        !["importing", "failed"].includes(state.receipt.status)
      )
        return;
      const model = state.receipt.modelKey;
      let apiKey: string | undefined;
      if (model) {
        const { controller, version } = begin("checking");
        apiKey = await readModelKey(model, state.receipt?.modelKeySourceDigest, controller.signal);
        if (!current(version)) return;
        pending = null;
        if (!apiKey) {
          publish({
            ...state,
            phase: "unknown",
            canRetry: true,
            error: new BackupModelKeyUnavailable(),
          });
          return;
        }
      }
      await write(nonce, (signal) =>
        deps.resume({ clientNonce: nonce, ...(apiKey ? { apiKey } : {}) }, signal),
      );
    },
    async cancel() {
      const nonce = state.clientNonce;
      if (!active() || !nonce || settled(state.receipt)) return;
      // Cancellation is a server fence, including for a nonce whose first request is still in transit.
      await write(nonce, (signal) => deps.cancel({ clientNonce: nonce }, signal));
    },
    reset() {
      if (!active() || (state.clientNonce !== null && !settled(state.receipt))) return false;
      invalidate();
      publish({
        ...initialBotPackageImport,
        recent: state.recent,
        recentLoading: state.recentLoading,
        recentError: state.recentError,
      });
      return true;
    },
    async loadRecent() {
      if (!active()) return;
      recentPending?.abort();
      const controller = new AbortController();
      recentPending = controller;
      const version = ++recentGeneration;
      publish({ ...state, recentLoading: true, recentError: null });
      try {
        const recent = await deps.recent(controller.signal);
        if (active() && version === recentGeneration)
          publish({ ...state, recent, recentLoading: false, recentError: null });
      } catch (error) {
        if (active() && version === recentGeneration)
          publish({ ...state, recentLoading: false, recentError: error });
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

export type BotPackageImport = ReturnType<typeof createBotPackageImport>;
