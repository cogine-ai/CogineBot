import type { ConnectorTool } from "@rakazo/adapter-kit";
import { AGENT_CONNECTION_RESPONSE_TOOL } from "@rakazo/core";
import {
  isToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { dropRunTurnCheckpoint, saveRunTurnCheckpoint } from "@rakazo/db";
import { approvedEffectOccurrence } from "./approval-effect.js";
import { FIND_TOOL, isDeferredTool, USE_TOOL } from "./builtin-tool-bridge.js";
import { preparePageToolRequest, SAVE_PAGE_TOOL } from "./page-tool-request.js";
import { namedAgentTools, partitionRuntimeTools } from "./pi-runtime.js";
import { createProtectedToolTranscriptSanitizer } from "./protected-tool-checkpoint.js";
import type { TurnCheckpoint } from "./turn-checkpoint.js";
import { restoreTurnCheckpoint, unresolvedTurnCheckpointCalls } from "./turn-checkpoint.js";

export type TurnEffectOccurrence = NonNullable<TurnCheckpoint["effectOccurrences"]>[number];

const CONNECTION_APPROVAL_CHECKPOINT = "connection-approval-v1:";
const SHARED_PAGE_APPROVAL_CHECKPOINT = "shared-page-approval-v1:";
const REQUEST_DIGEST = /^[a-f0-9]{64}$/;

export interface SharedPageApprovalCheckpointBinding {
  effectKey: string;
  requestDigest: string;
}

function assignedEffectKey({ fingerprint, occurrence }: TurnEffectOccurrence): string {
  return occurrence ? `${fingerprint}:${occurrence}` : fingerprint;
}

export function readConnectionApprovalCheckpoint(blob: string) {
  if (!blob.startsWith(CONNECTION_APPROVAL_CHECKPOINT)) return undefined;
  const value: unknown = JSON.parse(blob.slice(CONNECTION_APPROVAL_CHECKPOINT.length));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported connection approval checkpoint");
  const { effectKey, transcript } = value as Record<string, unknown>;
  if (
    typeof effectKey !== "string" ||
    !effectKey ||
    (transcript !== undefined && typeof transcript !== "string")
  ) {
    throw new Error("Unsupported connection approval checkpoint");
  }
  return { effectKey, transcript };
}

function readSharedPageApprovalCheckpoint(blob: string, runId: string) {
  if (!blob.startsWith(SHARED_PAGE_APPROVAL_CHECKPOINT)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(blob.slice(SHARED_PAGE_APPROVAL_CHECKPOINT.length));
  } catch {
    throw new Error("Unsupported shared Page approval checkpoint");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported shared Page approval checkpoint");
  const { effectKey, requestDigest, transcript, ...extra } = value as Record<string, unknown>;
  if (
    Object.keys(extra).length ||
    typeof effectKey !== "string" ||
    !isToolEffectIdempotencyKey(effectKey, runId, SAVE_PAGE_TOOL) ||
    typeof requestDigest !== "string" ||
    !REQUEST_DIGEST.test(requestDigest) ||
    (transcript !== undefined && typeof transcript !== "string")
  ) {
    throw new Error("Unsupported shared Page approval checkpoint");
  }
  return { binding: { effectKey, requestDigest }, transcript };
}

export interface RunTurnCheckpointState {
  blob?: string;
  stored: boolean;
  connectionApprovalEffectKey?: string;
  sharedPageApproval?: SharedPageApprovalCheckpointBinding;
  ownInstructionsBaseline?: string;
  counts: Map<string, number>;
  occurrences: TurnEffectOccurrence[];
  restoredPending?: TurnEffectOccurrence;
  pendingExecutionId?: string;
  pendingToolName?: string;
  pendingCaptures: Map<string, () => string>;
  hasBuiltinBridge?: true;
}

/** Restore saved assignments and tool availability; execution still rechecks parameters and policy. */
export function createRunTurnCheckpointState(input: {
  runId: string;
  blob?: string;
  model: { provider: string; id: string };
  tools: readonly ConnectorTool[];
  instructionsBaseline: string;
  counts?: Map<string, number>;
}): RunTurnCheckpointState {
  const connectionApproval =
    input.blob === undefined ? undefined : readConnectionApprovalCheckpoint(input.blob);
  const sharedPageApproval =
    input.blob === undefined
      ? undefined
      : readSharedPageApprovalCheckpoint(input.blob, input.runId);
  const approval = connectionApproval ?? sharedPageApproval;
  const transcript = approval ? approval.transcript : input.blob;
  const state: RunTurnCheckpointState = {
    blob: transcript,
    stored: input.blob !== undefined,
    connectionApprovalEffectKey: connectionApproval?.effectKey,
    ...(sharedPageApproval ? { sharedPageApproval: sharedPageApproval.binding } : {}),
    ownInstructionsBaseline: input.instructionsBaseline,
    counts: input.counts ?? new Map(),
    occurrences: [],
    pendingCaptures: new Map(),
    ...(input.tools.some((tool) => isDeferredTool(tool.name)) ? { hasBuiltinBridge: true } : {}),
  };
  if (transcript === undefined) return state;
  const saved = restoreTurnCheckpoint(transcript, input.model);
  state.pendingExecutionId = JSON.stringify(["pi-tool", "main", saved.pendingToolCallId]);
  const unresolved = new Set(unresolvedTurnCheckpointCalls(saved.messages));
  if (![...unresolved].some((call) => call.id === saved.pendingToolCallId))
    throw new Error("Unsupported turn checkpoint");
  const { listed, deferred } = partitionRuntimeTools(input.tools);
  const namedTools = namedAgentTools(listed);
  const available = new Map(namedTools.map(({ name, tool }) => [name, tool]));
  const runnable = new Map(
    [
      ...namedTools.map(({ name, tool }) => [name, tool] as const),
      ...deferred.map((tool) => [tool.name, tool] as const),
    ].filter(([name]) => name !== FIND_TOOL && name !== USE_TOOL),
  );
  const isBridge = (tool: ConnectorTool) =>
    tool.name === USE_TOOL && tool.route?.connectorId === "builtin";
  const realTool = (tool: ConnectorTool, args: Record<string, unknown>) =>
    isBridge(tool) ? (typeof args.name === "string" ? runnable.get(args.name) : undefined) : tool;
  let pendingPageFingerprint: string | undefined;
  for (const call of unresolved) {
    if (saved.executionMode !== "sequential" && call.id !== saved.pendingToolCallId) continue;
    const tool = available.get(call.name);
    if (!tool || !realTool(tool, call.arguments))
      throw new Error("Pending checkpoint tool is no longer available");
    if (call.id !== saved.pendingToolCallId) continue;
    state.pendingToolName = realTool(tool, call.arguments)!.name;
    if (sharedPageApproval && state.pendingToolName === SAVE_PAGE_TOOL && !call.argumentsError) {
      const args = isBridge(tool) ? call.arguments.arguments : call.arguments;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const prepared = preparePageToolRequest(args as Record<string, unknown>, []);
        if (prepared.ok && prepared.mode === "write") {
          pendingPageFingerprint = toolEffectIdempotencyKey(
            input.runId,
            SAVE_PAGE_TOOL,
            prepared.args,
          );
        }
      }
    }
  }
  if (connectionApproval && state.pendingToolName !== AGENT_CONNECTION_RESPONSE_TOOL)
    throw new Error("Unsupported connection approval checkpoint");
  if (saved.effectOccurrences) {
    state.occurrences.push(...saved.effectOccurrences);
    const pendingExecutionId = JSON.stringify(["pi-tool", "main", saved.pendingToolCallId]);
    state.restoredPending = saved.effectOccurrences.findLast(
      (entry) => entry.executionId === pendingExecutionId,
    );
    for (const { fingerprint, occurrence } of saved.effectOccurrences) {
      state.counts.set(fingerprint, Math.max(state.counts.get(fingerprint) ?? 0, occurrence + 1));
    }
  } else {
    // Older snapshots reserve completed calls before assigning their pending occurrence.
    for (const message of saved.messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.content) {
        if (call.type !== "toolCall" || unresolved.has(call)) continue;
        const tool = available.get(call.name);
        const real = tool ? realTool(tool, call.arguments) : undefined;
        const args = tool && isBridge(tool) ? call.arguments.arguments : call.arguments;
        if (
          real &&
          real.name !== "request_secret" &&
          real.name !== "connect_app" &&
          args &&
          typeof args === "object" &&
          !Array.isArray(args)
        ) {
          claimTurnEffectOccurrence(
            state,
            input.runId,
            real.name,
            args as Record<string, unknown>,
            JSON.stringify(["pi-tool", "main", call.id]),
          );
        }
      }
    }
  }
  if (sharedPageApproval) {
    const occurrence = state.restoredPending;
    const binding = sharedPageApproval.binding;
    if (
      !occurrence ||
      !pendingPageFingerprint ||
      occurrence.fingerprint !== pendingPageFingerprint ||
      binding.effectKey !== assignedEffectKey(occurrence)
    ) {
      throw new Error("Unsupported shared Page approval checkpoint");
    }
  }
  // The saved prompt owns this baseline; an older missing baseline stays unknown.
  state.ownInstructionsBaseline = saved.ownInstructionsBaseline;
  return state;
}

/** A paused or approved action keeps its occurrence; a new identical action gets the next one. */
export function claimTurnEffectOccurrence(
  state: RunTurnCheckpointState,
  runId: string,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  approvedKey?: string,
): number {
  const fingerprint = toolEffectIdempotencyKey(runId, name, args);
  const approved = approvedKey ? approvedEffectOccurrence(approvedKey, fingerprint) : undefined;
  const previous = state.restoredPending;
  if (previous?.executionId === executionId) {
    state.restoredPending = undefined;
    if (previous.fingerprint === fingerprint && approved === undefined) return previous.occurrence;
  }
  const occurrence = approved ?? state.counts.get(fingerprint) ?? 0;
  state.occurrences.push({ executionId, fingerprint, occurrence });
  state.counts.set(fingerprint, Math.max(state.counts.get(fingerprint) ?? 0, occurrence + 1));
  return occurrence;
}

/** Save the actual pause's capture, or fence the removal of a previous turn's transcript. */
export async function persistRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  leaseOwner: string,
  leaseFence: number,
  state: RunTurnCheckpointState,
  executionId?: string,
  pendingSecretEffectId?: string,
  connectionApprovalEffectKey?: string,
  runSecrets: string[] = [],
  sharedPageApproval?: SharedPageApprovalCheckpointBinding,
): Promise<void> {
  const capture = executionId ? state.pendingCaptures.get(executionId) : undefined;
  if (sharedPageApproval && connectionApprovalEffectKey)
    throw new Error("Only one approval can be bound to a turn checkpoint");
  if (sharedPageApproval) {
    const assigned = state.occurrences.findLast((entry) => entry.executionId === executionId);
    if (
      !assigned ||
      assignedEffectKey(assigned) !== sharedPageApproval.effectKey ||
      !isToolEffectIdempotencyKey(sharedPageApproval.effectKey, run.id, SAVE_PAGE_TOOL) ||
      !REQUEST_DIGEST.test(sharedPageApproval.requestDigest)
    ) {
      throw new Error("Unsupported shared Page approval checkpoint");
    }
  }
  const withApproval = (transcript?: string) => {
    if (sharedPageApproval)
      return `${SHARED_PAGE_APPROVAL_CHECKPOINT}${JSON.stringify({ ...sharedPageApproval, transcript })}`;
    if (connectionApprovalEffectKey)
      return `${CONNECTION_APPROVAL_CHECKPOINT}${JSON.stringify({ effectKey: connectionApprovalEffectKey, transcript })}`;
    return transcript;
  };
  if (capture) {
    const saved = JSON.parse(capture()) as TurnCheckpoint;
    const unresolved =
      saved.executionMode === "sequential" ? unresolvedTurnCheckpointCalls(saved.messages) : [];
    const pendingIndex = unresolved.findIndex((call) => call.id === saved.pendingToolCallId);
    const unstartedCalls = new Set(
      pendingIndex >= 0 ? unresolved.slice(pendingIndex + 1).map((call) => call.id) : [],
    );
    saved.messages = saved.messages.map(
      createProtectedToolTranscriptSanitizer(
        state.hasBuiltinBridge === true,
        () => runSecrets,
        unstartedCalls,
      ),
    );
    saved.effectOccurrences = state.occurrences;
    saved.ownInstructionsBaseline = state.ownInstructionsBaseline;
    await saveRunTurnCheckpoint(
      prisma,
      run,
      leaseOwner,
      leaseFence,
      withApproval(JSON.stringify(saved)),
      pendingSecretEffectId,
    );
    state.stored = true;
  } else if (sharedPageApproval || connectionApprovalEffectKey) {
    // A helper cannot capture a top-level transcript. Keep its exact receipt and
    // refuse older executors, whose restore reader cannot resume this checkpoint.
    await saveRunTurnCheckpoint(prisma, run, leaseOwner, leaseFence, withApproval());
    state.stored = true;
  } else if (pendingSecretEffectId !== undefined) {
    await saveRunTurnCheckpoint(
      prisma,
      run,
      leaseOwner,
      leaseFence,
      undefined,
      pendingSecretEffectId,
    );
    state.stored = true;
  } else {
    await dropRunTurnCheckpoint(prisma, run, leaseOwner, leaseFence);
    state.stored = false;
  }
}
