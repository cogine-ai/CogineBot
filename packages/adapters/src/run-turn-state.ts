import type { ConnectorTool } from "@rakazo/adapter-kit";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { dropRunTurnCheckpoint, saveRunTurnCheckpoint } from "@rakazo/db";
import { approvedEffectOccurrence } from "./approval-effect.js";
import { FIND_TOOL, USE_TOOL } from "./builtin-tool-bridge.js";
import { namedAgentTools, partitionRuntimeTools } from "./pi-runtime.js";
import type { TurnCheckpoint } from "./turn-checkpoint.js";
import { restoreTurnCheckpoint, unresolvedTurnCheckpointCalls } from "./turn-checkpoint.js";

export type TurnEffectOccurrence = NonNullable<TurnCheckpoint["effectOccurrences"]>[number];

export interface RunTurnCheckpointState {
  blob?: string;
  stored: boolean;
  ownInstructionsBaseline?: string;
  counts: Map<string, number>;
  occurrences: TurnEffectOccurrence[];
  restoredPending?: TurnEffectOccurrence;
  pendingCaptures: Map<string, () => string>;
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
  const state: RunTurnCheckpointState = {
    blob: input.blob,
    stored: input.blob !== undefined,
    ownInstructionsBaseline: input.instructionsBaseline,
    counts: input.counts ?? new Map(),
    occurrences: [],
    pendingCaptures: new Map(),
  };
  if (input.blob === undefined) return state;
  const saved = restoreTurnCheckpoint(input.blob, input.model);
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
  for (const call of unresolved) {
    if (saved.executionMode !== "sequential" && call.id !== saved.pendingToolCallId) continue;
    const tool = available.get(call.name);
    if (!tool || !realTool(tool, call.arguments))
      throw new Error("Pending checkpoint tool is no longer available");
  }
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
): Promise<void> {
  const capture = executionId ? state.pendingCaptures.get(executionId) : undefined;
  if (capture) {
    const saved = JSON.parse(capture());
    saved.effectOccurrences = state.occurrences;
    saved.ownInstructionsBaseline = state.ownInstructionsBaseline;
    await saveRunTurnCheckpoint(
      prisma,
      run,
      leaseOwner,
      leaseFence,
      JSON.stringify(saved),
      pendingSecretEffectId,
    );
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
