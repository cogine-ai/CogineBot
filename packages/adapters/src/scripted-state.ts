import { createHash } from "node:crypto";
import type { ScriptedRuntimeState, ScriptedTurn } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isToolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { Prisma } from "@rakazo/db";

export class ScriptedStateError extends Error {
  constructor() {
    super("Scripted continuation progress could not be verified");
    this.name = "ScriptedStateError";
  }
}

export class ScriptedStateInvalidError extends ScriptedStateError {
  constructor(message = "Scripted continuation progress could not be verified") {
    super();
    this.message = message;
    this.name = "ScriptedStateInvalidError";
  }
}

const DIGEST = /^[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!object(value)) throw new ScriptedStateInvalidError("Invalid scripted continuation state");
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

export function scriptedStateDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function strings(value: unknown, keys: string[]): boolean {
  return object(value) && keys.every((key) => typeof value[key] === "string");
}

function turn(value: unknown): value is ScriptedTurn {
  if (!object(value)) return false;
  const allowed = new Set([
    "assistant",
    "toolCalls",
    "ask",
    "takeover",
    "files",
    "memory",
    "complete",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.assistant !== undefined && typeof value.assistant !== "string") return false;
  if (value.complete !== undefined && typeof value.complete !== "boolean") return false;
  if (
    value.toolCalls !== undefined &&
    (!Array.isArray(value.toolCalls) ||
      !value.toolCalls.every(
        (call) =>
          strings(call, ["name"]) &&
          object(call) &&
          fields(call, ["name", "args"]) &&
          object(call.args),
      ))
  )
    return false;
  if (
    value.ask !== undefined &&
    (!strings(value.ask, ["text"]) ||
      !object(value.ask) ||
      !fields(value.ask, ["text", "detail", "actions"]) ||
      (value.ask.detail !== undefined && typeof value.ask.detail !== "string") ||
      (value.ask.actions !== undefined &&
        (!Array.isArray(value.ask.actions) ||
          !value.ask.actions.every(
            (action) =>
              strings(action, ["id", "label"]) && object(action) && fields(action, ["id", "label"]),
          ))))
  )
    return false;
  if (
    value.takeover !== undefined &&
    (!strings(value.takeover, ["reason"]) ||
      !object(value.takeover) ||
      !fields(value.takeover, ["reason"]))
  )
    return false;
  if (
    value.files !== undefined &&
    (!Array.isArray(value.files) ||
      !value.files.every(
        (file) =>
          strings(file, ["path", "content"]) && object(file) && fields(file, ["path", "content"]),
      ))
  )
    return false;
  if (
    value.memory !== undefined &&
    (!Array.isArray(value.memory) ||
      !value.memory.every(
        (memory) =>
          strings(memory, ["scope", "path", "content"]) &&
          object(memory) &&
          fields(memory, ["scope", "path", "content"]) &&
          (memory.scope === "bot" || memory.scope === "user"),
      ))
  )
    return false;
  return true;
}

function state(value: unknown, runId: string): value is ScriptedRuntimeState {
  if (!object(value) || value.version !== 1 || value.runId !== runId) return false;
  if (!fields(value, ["version", "runId", "batch", "script", "scriptDigest", "owners", "cursor"]))
    return false;
  const { batch, script, owners, cursor } = value;
  if (
    !Array.isArray(batch) ||
    batch.length === 0 ||
    !batch.every(
      (item) =>
        strings(item, ["id", "messageId", "contentDigest"]) &&
        object(item) &&
        fields(item, ["id", "messageId", "contentDigest"]) &&
        Boolean(item.id) &&
        Boolean(item.messageId) &&
        DIGEST.test(String(item.contentDigest)),
    )
  )
    return false;
  const ids = batch.map((item) => item.id);
  if (
    new Set(ids).size !== ids.length ||
    new Set(batch.map((item) => item.messageId)).size !== batch.length
  )
    return false;
  if (
    !Array.isArray(script) ||
    script.length === 0 ||
    !script.every(turn) ||
    typeof value.scriptDigest !== "string" ||
    !DIGEST.test(value.scriptDigest)
  )
    return false;
  if (scriptedStateDigest(script) !== value.scriptDigest) return false;
  if (
    !Array.isArray(owners) ||
    owners.length !== script.length ||
    !owners.every((id) => typeof id === "string" && ids.includes(id))
  )
    return false;
  const segments = owners.filter((id, index) => index === 0 || id !== owners[index - 1]);
  if (segments.length !== ids.length || segments.some((id, index) => id !== ids[index]))
    return false;
  if (
    !object(cursor) ||
    !fields(cursor, ["turn", "tool", "ordinal", "phase"]) ||
    !["turn", "tool", "ordinal"].every(
      (key) => Number.isSafeInteger(cursor[key]) && Number(cursor[key]) >= 0,
    )
  )
    return false;
  const index = Number(cursor.turn);
  const tool = Number(cursor.tool);
  if (
    index > script.length ||
    !["turn", "tool", "after-tools", "ask", "takeover", "complete"].includes(String(cursor.phase))
  )
    return false;
  if (index === script.length)
    return (
      cursor.phase === "complete" &&
      tool === 0 &&
      Number(cursor.ordinal) ===
        script.reduce((count, item) => count + (item.toolCalls?.length ?? 0), 0)
    );
  const current = script[index]!;
  const calls = current.toolCalls?.length ?? 0;
  if (tool > calls || (cursor.phase === "tool" && tool >= calls) || cursor.phase === "complete")
    return false;
  if (cursor.phase === "turn" && tool !== 0) return false;
  if (cursor.phase === "after-tools" && tool !== calls) return false;
  if (cursor.phase === "ask" && (!current.ask || tool !== calls)) return false;
  if (cursor.phase === "takeover" && (!current.takeover || tool !== calls)) return false;
  return (
    Number(cursor.ordinal) ===
    script.slice(0, index).reduce((count, item) => count + (item.toolCalls?.length ?? 0), 0) + tool
  );
}

export function parseScriptedState(value: unknown, runId: string): ScriptedRuntimeState {
  try {
    if (state(value, runId)) return value;
  } catch {}
  throw new ScriptedStateInvalidError("Invalid scripted continuation state");
}

export function composeScriptedTurns(turns: ScriptedTurn[]): ScriptedTurn[] {
  return turns.map((item, index) =>
    item.complete && index < turns.length - 1 ? { ...item, complete: false } : item,
  );
}

export interface ScriptedOutputState {
  assembled: string;
  currentTextSegment: string;
  messageSegments: MessageBlock[];
  pendingToolNames: string[];
  publishedTerminalSubagent: boolean;
  lastToolOrdinal: number;
}

export interface StoredScriptedState {
  kind: "scripted-state";
  version: 2;
  runId: string;
  attemptId: string;
  fence: number;
  state: ScriptedRuntimeState;
  output: ScriptedOutputState;
  effectOccurrences: Array<[string, number]>;
  consumedEffectIds: string[];
  pendingEffect?: { id: string; kind: string; idempotencyKey: string; requestDigest: string };
  pause?: {
    kind: "input" | "takeover";
    attemptId: string;
    fence: number;
    messageId?: string;
    eventSeq?: number;
  };
  digest: string;
}

export function sealScriptedState(
  value: Omit<StoredScriptedState, "digest" | "pause">,
): StoredScriptedState {
  return { ...value, digest: scriptedStateDigest(value) };
}

export function scriptedStateJson(value: StoredScriptedState): Prisma.InputJsonObject {
  // JSON serialization removes optional undefined fields before the database round trip.
  return JSON.parse(JSON.stringify(value));
}

function stored(value: unknown, runId: string): value is StoredScriptedState {
  try {
    if (
      !object(value) ||
      !fields(value, [
        "kind",
        "version",
        "runId",
        "attemptId",
        "fence",
        "state",
        "output",
        "effectOccurrences",
        "consumedEffectIds",
        "pendingEffect",
        "pause",
        "digest",
      ])
    )
      throw new Error();
    if (
      value.kind !== "scripted-state" ||
      value.version !== 2 ||
      value.runId !== runId ||
      typeof value.attemptId !== "string" ||
      !value.attemptId ||
      !Number.isSafeInteger(value.fence) ||
      Number(value.fence) < 1
    )
      throw new Error();
    const runtime = parseScriptedState(value.state, runId);
    const output = value.output;
    if (
      !object(output) ||
      !fields(output, [
        "assembled",
        "currentTextSegment",
        "messageSegments",
        "pendingToolNames",
        "publishedTerminalSubagent",
        "lastToolOrdinal",
      ]) ||
      typeof output.assembled !== "string" ||
      typeof output.currentTextSegment !== "string" ||
      typeof output.publishedTerminalSubagent !== "boolean" ||
      !Array.isArray(output.messageSegments) ||
      !output.messageSegments.every(
        (block) => object(block) && (block.kind === "text" || block.kind === "steps"),
      ) ||
      !MessageBlockSchema.array().safeParse(output.messageSegments).success ||
      !Array.isArray(output.pendingToolNames) ||
      !output.pendingToolNames.every((name) => typeof name === "string" && name.length > 0) ||
      !Number.isSafeInteger(output.lastToolOrdinal) ||
      Number(output.lastToolOrdinal) < -1 ||
      Number(output.lastToolOrdinal) >
        runtime.cursor.ordinal - (runtime.cursor.phase === "tool" ? 0 : 1)
    )
      throw new Error();
    if (
      !Array.isArray(value.effectOccurrences) ||
      !value.effectOccurrences.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          entry[0].startsWith(`${runId}:`) &&
          entry[0].slice(runId.length + 1).lastIndexOf(":") > 0 &&
          /:[a-f0-9]{64}$/.test(entry[0]) &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0,
      )
    )
      throw new Error();
    if (
      new Set(value.effectOccurrences.map((entry) => entry[0])).size !==
      value.effectOccurrences.length
    )
      throw new Error();
    if (
      !Array.isArray(value.consumedEffectIds) ||
      !value.consumedEffectIds.every((id) => typeof id === "string" && id.length > 0) ||
      new Set(value.consumedEffectIds).size !== value.consumedEffectIds.length
    )
      throw new Error();
    if (value.pendingEffect !== undefined) {
      const pending = value.pendingEffect;
      if (
        !strings(pending, ["id", "kind", "idempotencyKey", "requestDigest"]) ||
        !object(pending) ||
        !fields(pending, ["id", "kind", "idempotencyKey", "requestDigest"]) ||
        !pending.id ||
        !pending.kind ||
        !isToolEffectIdempotencyKey(String(pending.idempotencyKey), runId, String(pending.kind)) ||
        !DIGEST.test(String(pending.requestDigest))
      )
        throw new Error();
    }
    if (value.pause !== undefined) {
      const pause = value.pause;
      if (
        !object(pause) ||
        !fields(pause, ["kind", "attemptId", "fence", "messageId", "eventSeq"]) ||
        pause.attemptId !== value.attemptId ||
        pause.fence !== value.fence
      )
        throw new Error();
      if (pause.kind === "input") {
        if (typeof pause.messageId !== "string" || !pause.messageId || pause.eventSeq !== undefined)
          throw new Error();
      } else if (pause.kind === "takeover") {
        if (
          !Number.isSafeInteger(pause.eventSeq) ||
          Number(pause.eventSeq) < 1 ||
          pause.messageId !== undefined
        )
          throw new Error();
      } else throw new Error();
    }
    const { pause: _pause, digest, ...body } = value;
    if (typeof digest !== "string" || !DIGEST.test(digest) || scriptedStateDigest(body) !== digest)
      throw new Error();
    return true;
  } catch {
    return false;
  }
}

export function parseStoredScriptedState(value: unknown, runId: string): StoredScriptedState {
  if (!stored(value, runId))
    throw new ScriptedStateInvalidError("Invalid scripted continuation state");
  return value;
}
