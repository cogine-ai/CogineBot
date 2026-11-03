import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { AgentRunModel, ConnectorRoute } from "@rakazo/adapter-kit";
import type { ToolResultProvenance } from "./context-selection.js";
import {
  markToolResultContent,
  toolResultContentProvenance,
  validatedToolResultHistoryReference,
} from "./context-selection.js";
import { withoutThinkingFrom } from "./thinking-signatures.js";
import { mcpToolResultRoute } from "./verbatim-mcp-result.js";

/** Server-owned result identity; it is never inferred from tool text or model arguments. */
export interface CheckpointMcpResultRoute {
  messageIndex: number;
  route: ConnectorRoute;
}

/** Internal, versioned transcript; never a client event payload. */
export interface TurnCheckpoint {
  version: 1;
  provider: string;
  model: string;
  systemPrompt: string;
  pendingToolCallId: string;
  messages: Message[];
  historyMessageIds?: string[];
  /** The instructions the saved system prompt was built from; own writes resume guarding on it. */
  ownInstructionsBaseline?: string;
  /** Executor-assigned occurrences include canonical arguments and the paused call. */
  effectOccurrences?: Array<{ executionId: string; fingerprint: string; occurrence: number }>;
  /** Only explicit sequential checkpoints guarantee an unstarted tail. */
  executionMode?: "parallel" | "sequential";
  /** Private route ownership must survive the JSON round trip separately from result data. */
  mcpResultRoutes?: CheckpointMcpResultRoute[];
  /** Adapter-owned envelopes and original-history references, kept outside provider data. */
  resultMetadata?: Array<{ messageIndex: number; metadata: ToolResultProvenance }>;
}

export function serializeTurnCheckpoint(checkpoint: TurnCheckpoint): string {
  const routes = checkpoint.messages.flatMap((message, messageIndex) => {
    const route = message.role === "toolResult" ? mcpToolResultRoute(message.content) : undefined;
    return route?.connectorId === "mcp" && route.resourceId ? [{ messageIndex, route }] : [];
  });
  const metadata = checkpoint.messages.flatMap((message, messageIndex) => {
    const owned =
      message.role === "toolResult" ? toolResultContentProvenance(message.content) : undefined;
    return owned ? [{ messageIndex, metadata: owned }] : [];
  });
  const {
    mcpResultRoutes: _previousRoutes,
    resultMetadata: _previousMetadata,
    ...body
  } = checkpoint;
  return JSON.stringify({
    ...body,
    ...(routes.length ? { mcpResultRoutes: routes } : {}),
    ...(metadata.length ? { resultMetadata: metadata } : {}),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validContent(value: unknown, assistant: boolean): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!record(part)) return false;
    if (part.type === "text") return typeof part.text === "string";
    if (part.type === "image")
      return !assistant && typeof part.data === "string" && typeof part.mimeType === "string";
    if (part.type === "thinking") return assistant && typeof part.thinking === "string";
    return (
      assistant &&
      part.type === "toolCall" &&
      typeof part.id === "string" &&
      part.id.length > 0 &&
      typeof part.name === "string" &&
      part.name.length > 0 &&
      record(part.arguments)
    );
  });
}

function validMessage(message: unknown): boolean {
  if (!record(message)) return false;
  if (message.role === "system") {
    const text =
      typeof message.content === "string" ||
      (Array.isArray(message.content) &&
        message.content.every(
          (part) => record(part) && part.type === "text" && typeof part.text === "string",
        ));
    return (
      text &&
      (message.sections === undefined ||
        (record(message.sections) &&
          Object.values(message.sections).every(
            (value) => value === null || typeof value === "string",
          ))) &&
      (message.toolsAdded === undefined ||
        (Array.isArray(message.toolsAdded) &&
          message.toolsAdded.every(
            (tool) =>
              record(tool) &&
              typeof tool.name === "string" &&
              typeof tool.description === "string" &&
              record(tool.parameters),
          ))) &&
      (message.toolsRemoved === undefined ||
        (Array.isArray(message.toolsRemoved) &&
          message.toolsRemoved.every((tool) => record(tool) && typeof tool.name === "string")))
    );
  }
  if (message.role === "user")
    return typeof message.content === "string" || validContent(message.content, false);
  if (message.role === "assistant") return validContent(message.content, true);
  return (
    message.role === "toolResult" &&
    typeof message.toolCallId === "string" &&
    typeof message.toolName === "string" &&
    validContent(message.content, false)
  );
}

function validRoutes(value: unknown, messages: unknown[]): boolean {
  if (value === undefined) return true;
  const seen = new Set<number>();
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (
        !record(entry) ||
        !Number.isSafeInteger(entry.messageIndex) ||
        seen.has(entry.messageIndex as number)
      )
        return false;
      seen.add(entry.messageIndex as number);
      const message = messages[entry.messageIndex as number];
      const route = entry.route;
      return (
        record(message) &&
        message.role === "toolResult" &&
        record(route) &&
        route.connectorId === "mcp" &&
        typeof route.resourceId === "string" &&
        route.resourceId.length > 0 &&
        typeof route.toolName === "string" &&
        route.toolName.length > 0 &&
        (route.connectionId === undefined || typeof route.connectionId === "string") &&
        (route.catalogGroup === undefined || typeof route.catalogGroup === "string") &&
        (route.resourceRevision === undefined ||
          (typeof route.resourceRevision === "string" && route.resourceRevision.length > 0) ||
          (Number.isSafeInteger(route.resourceRevision) && (route.resourceRevision as number) > 0))
      );
    })
  );
}

function validMetadata(value: unknown, messages: unknown[]): boolean {
  if (value === undefined) return true;
  const seen = new Set<number>();
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (
        !record(entry) ||
        !Number.isSafeInteger(entry.messageIndex) ||
        seen.has(entry.messageIndex as number)
      )
        return false;
      seen.add(entry.messageIndex as number);
      const message = messages[entry.messageIndex as number];
      if (
        !record(message) ||
        message.role !== "toolResult" ||
        !record(entry.metadata) ||
        typeof entry.metadata.wrapped !== "boolean"
      )
        return false;
      const reference = entry.metadata.historyReference;
      return (
        reference === undefined || Boolean(validatedToolResultHistoryReference(reference as never))
      );
    })
  );
}

export function restoreTurnCheckpoint(
  blob: string,
  model: Pick<AgentRunModel, "provider" | "id">,
): TurnCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(blob);
  } catch {
    throw new Error("Unsupported turn checkpoint");
  }
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.systemPrompt !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.pendingToolCallId !== "string" ||
    !value.pendingToolCallId ||
    !Array.isArray(value.messages) ||
    !value.messages.every(validMessage) ||
    (value.historyMessageIds !== undefined &&
      (!Array.isArray(value.historyMessageIds) ||
        !value.historyMessageIds.every((id) => typeof id === "string"))) ||
    (value.ownInstructionsBaseline !== undefined &&
      typeof value.ownInstructionsBaseline !== "string") ||
    (value.executionMode !== undefined &&
      value.executionMode !== "parallel" &&
      value.executionMode !== "sequential") ||
    (value.effectOccurrences !== undefined &&
      (!Array.isArray(value.effectOccurrences) ||
        !value.effectOccurrences.every(
          (entry) =>
            record(entry) &&
            typeof entry.executionId === "string" &&
            typeof entry.fingerprint === "string" &&
            Number.isSafeInteger(entry.occurrence) &&
            (entry.occurrence as number) >= 0,
        ))) ||
    !validRoutes(value.mcpResultRoutes, value.messages) ||
    !validMetadata(value.resultMetadata, value.messages)
  ) {
    throw new Error("Unsupported turn checkpoint");
  }
  const checkpoint = value as unknown as TurnCheckpoint;
  const messages = [...checkpoint.messages];
  for (const entry of checkpoint.resultMetadata ?? []) {
    const message = messages[entry.messageIndex];
    if (message?.role === "toolResult") markToolResultContent(message.content, entry.metadata);
  }
  while (messages.at(-1)?.role === "assistant") {
    const tail = messages.at(-1)!;
    if (tail.role !== "assistant" || (tail.stopReason !== "aborted" && tail.stopReason !== "error"))
      break;
    messages.pop();
  }
  return {
    ...checkpoint,
    messages:
      checkpoint.provider === model.provider && checkpoint.model === model.id
        ? messages
        : withoutThinkingFrom(messages, 0),
  };
}

/** Match results in transcript order: wire IDs may repeat in later responses. */
export function unresolvedTurnCheckpointCalls(messages: Message[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.content) if (call.type === "toolCall") pending.set(call.id, call);
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  return [...pending.values()];
}
