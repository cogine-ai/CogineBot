import type { ScriptedRuntimeState, ScriptedTurn } from "@rakazo/adapter-kit";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it } from "vitest";
import type { StoredScriptedState } from "./scripted-state.js";
import {
  parseScriptedState,
  parseStoredScriptedState,
  scriptedStateDigest,
  scriptedStateJson,
  sealScriptedState,
} from "./scripted-state.js";

const RUN_ID = "run-scripted-resume";
const ERROR = "Invalid scripted continuation state";
const FIRST = "steering-first";
const SECOND = "steering-second";
const FIRST_ARGS = { path: "notes.txt", content: "prefix" };
const PENDING_ARGS = { account: "fixture", payload: { city: "Paris", count: 2 } };
const FIRST_KEY = approvalEffectKey(RUN_ID, "write_file", FIRST_ARGS);
const PENDING_KEY = approvalEffectKey(RUN_ID, "native_execute_tool", PENDING_ARGS);

function fixture(): ScriptedRuntimeState {
  const script: ScriptedTurn[] = [
    {
      assistant: "Prepare the notes.",
      toolCalls: [{ name: "write_file", args: FIRST_ARGS }],
      memory: [{ scope: "bot", path: "notes.md", content: "remember the prefix" }],
    },
    {
      assistant: "Choose a destination.",
      ask: {
        text: "Which city?",
        detail: "Choose one city.",
        actions: [{ id: "paris", label: "Paris" }],
      },
      files: [{ path: "prefix.txt", content: "retain this deferred prefix" }],
    },
    {
      toolCalls: [{ name: "native_execute_tool", args: PENDING_ARGS }],
      takeover: { reason: "Sign in to continue." },
      files: [{ path: "suffix.txt", content: "retain this unexecuted suffix" }],
      complete: true,
    },
  ];
  return {
    version: 1,
    runId: RUN_ID,
    batch: [
      { id: FIRST, messageId: "message-first", contentDigest: scriptedStateDigest("first") },
      { id: SECOND, messageId: "message-second", contentDigest: scriptedStateDigest("second") },
    ],
    script,
    scriptDigest: scriptedStateDigest(script),
    owners: [FIRST, FIRST, SECOND],
    cursor: { turn: 2, tool: 0, ordinal: 1, phase: "tool" },
  };
}

function storedFixture(): StoredScriptedState {
  return sealScriptedState({
    kind: "scripted-state",
    version: 1,
    runId: RUN_ID,
    attemptId: "attempt-paused",
    fence: 3,
    state: fixture(),
    effectOccurrences: [
      [FIRST_KEY, 1],
      [PENDING_KEY, 0],
    ],
    consumedEffectIds: ["effect-completed-prefix"],
    pendingEffect: {
      id: "effect-pending",
      kind: "native_execute_tool",
      idempotencyKey: PENDING_KEY,
      requestDigest: scriptedStateDigest(PENDING_ARGS),
    },
  });
}

function reseal(value: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, pause, ...body } = value;
  return { ...body, digest: scriptedStateDigest(body), ...(pause === undefined ? {} : { pause }) };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]),
    );
  }
  return value;
}

describe("scripted continuation state", () => {
  it("retains the full owned script across a JSONB object-key reorder", () => {
    const value = fixture();
    const reordered = reverseObjectKeys(value);
    expect(scriptedStateDigest(reordered)).toBe(scriptedStateDigest(value));
    expect(parseScriptedState(reordered, RUN_ID)).toEqual(value);
  });

  it.each([
    { turn: 0, tool: 0, ordinal: 0, phase: "turn" },
    { turn: 0, tool: 1, ordinal: 1, phase: "after-tools" },
    { turn: 1, tool: 0, ordinal: 1, phase: "ask" },
    { turn: 2, tool: 0, ordinal: 1, phase: "tool" },
    { turn: 2, tool: 1, ordinal: 2, phase: "takeover" },
    { turn: 3, tool: 0, ordinal: 2, phase: "complete" },
  ] as const)("accepts the $phase boundary at turn $turn", (cursor) => {
    const value = { ...fixture(), cursor };
    expect(parseScriptedState(value, RUN_ID)).toEqual(value);
  });

  const corruptions: Array<[string, (value: ScriptedRuntimeState) => unknown]> = [
    ["unknown version", (value) => ({ ...value, version: 2 })],
    ["another run", (value) => ({ ...value, runId: "run-other" })],
    ["empty batch", (value) => ({ ...value, batch: [] })],
    ["duplicate owner IDs", (value) => ({ ...value, batch: [value.batch[0], value.batch[0]] })],
    [
      "duplicate source messages",
      (value) => ({
        ...value,
        batch: [value.batch[0], { ...value.batch[1], messageId: value.batch[0]!.messageId }],
      }),
    ],
    [
      "empty source ID",
      (value) => ({ ...value, batch: [{ ...value.batch[0], id: "" }, value.batch[1]] }),
    ],
    [
      "invalid content digest",
      (value) => ({
        ...value,
        batch: [{ ...value.batch[0], contentDigest: "unhashed" }, value.batch[1]],
      }),
    ],
    [
      "uppercase content digest",
      (value) => ({
        ...value,
        batch: [{ ...value.batch[0], contentDigest: "A".repeat(64) }, value.batch[1]],
      }),
    ],
    ["missing second owner segment", (value) => ({ ...value, owners: [FIRST, FIRST, FIRST] })],
    ["reversed owner segments", (value) => ({ ...value, owners: [SECOND, SECOND, FIRST] })],
    ["reopened first owner segment", (value) => ({ ...value, owners: [FIRST, SECOND, FIRST] })],
    ["unknown owner", (value) => ({ ...value, owners: [FIRST, FIRST, "steering-other"] })],
    ["missing turn owner", (value) => ({ ...value, owners: [FIRST, SECOND] })],
    ["wrong script digest", (value) => ({ ...value, scriptDigest: "0".repeat(64) })],
    [
      "changed frozen prefix",
      (value) => ({
        ...value,
        script: [{ ...value.script[0], assistant: "changed" }, ...value.script.slice(1)],
      }),
    ],
    ["unknown state field", (value) => ({ ...value, resumeApproved: true })],
    [
      "unknown source field",
      (value) => ({ ...value, batch: [{ ...value.batch[0], consumed: true }, value.batch[1]] }),
    ],
    ["unknown cursor field", (value) => ({ ...value, cursor: { ...value.cursor, skip: true } })],
  ];

  it.each(corruptions)("rejects %s before work can be skipped", (_label, corrupt) => {
    expect(() => parseScriptedState(corrupt(fixture()), RUN_ID)).toThrow(ERROR);
  });

  it.each([
    { turn: -1, tool: 0, ordinal: 0, phase: "turn" },
    { turn: 0.5, tool: 0, ordinal: 0, phase: "turn" },
    { turn: 4, tool: 0, ordinal: 2, phase: "complete" },
    { turn: 2, tool: -1, ordinal: 0, phase: "tool" },
    { turn: 2, tool: 0.5, ordinal: 1.5, phase: "tool" },
    { turn: 2, tool: 2, ordinal: 3, phase: "tool" },
    { turn: 2, tool: 1, ordinal: 2, phase: "tool" },
    { turn: 2, tool: 1, ordinal: 2, phase: "turn" },
    { turn: 2, tool: 0, ordinal: 1, phase: "after-tools" },
    { turn: 2, tool: 1, ordinal: 2, phase: "ask" },
    { turn: 1, tool: 0, ordinal: 1, phase: "takeover" },
    { turn: 2, tool: 0, ordinal: 0, phase: "tool" },
    { turn: 2, tool: 0, ordinal: Number.MAX_SAFE_INTEGER + 1, phase: "tool" },
    { turn: 2, tool: 0, ordinal: 1, phase: "complete" },
    { turn: 3, tool: 0, ordinal: 2, phase: "turn" },
    { turn: 3, tool: 1, ordinal: 2, phase: "complete" },
    { turn: 3, tool: 0, ordinal: 1, phase: "complete" },
    { turn: 2, tool: 0, ordinal: 1, phase: "resume" },
  ])("rejects an inconsistent cursor %j", (cursor) => {
    expect(() => parseScriptedState({ ...fixture(), cursor }, RUN_ID)).toThrow(ERROR);
  });

  it.each([
    { assistant: "hello", skipTools: true },
    { toolCalls: [{ name: "write_file", args: {}, approved: true }] },
    { toolCalls: [{ name: "write_file", args: [] }] },
    { ask: { text: "Continue?", answered: true } },
    { ask: { text: "Choose", actions: [{ id: "yes", label: "Yes", approved: true }] } },
    { takeover: { reason: "Sign in", released: true } },
    { files: [{ path: "notes.txt", content: "notes", applied: true }] },
    { memory: [{ scope: "bot", path: "notes.md", content: "notes", applied: true }] },
    { memory: [{ scope: "global", path: "notes.md", content: "notes" }] },
  ])("rejects a sealed script with an invalid or unknown turn field %j", (invalidTurn) => {
    const value = fixture();
    const script = [invalidTurn, ...value.script.slice(1)];
    expect(() =>
      parseScriptedState({ ...value, script, scriptDigest: scriptedStateDigest(script) }, RUN_ID),
    ).toThrow(ERROR);
  });
});

describe("stored scripted continuation envelope", () => {
  it("round-trips normalized occurrence keys, legacy consumed IDs and a pending effect", () => {
    const value = storedFixture();
    const reordered = reverseObjectKeys(scriptedStateJson(value));
    expect(parseStoredScriptedState(reordered, RUN_ID)).toEqual(value);
    const repeated = reseal({
      ...value,
      pendingEffect: {
        ...value.pendingEffect,
        idempotencyKey: toolEffectIdempotencyKey(RUN_ID, "native_execute_tool", PENDING_ARGS, 2),
      },
    });
    expect(parseStoredScriptedState(repeated, RUN_ID)).toEqual(repeated);
  });

  it("accepts only same-attempt input and takeover pause receipts", () => {
    const value = storedFixture();
    const input = {
      ...value,
      pause: {
        kind: "input",
        attemptId: value.attemptId,
        fence: value.fence,
        messageId: "ask-exact",
      },
    };
    expect(parseStoredScriptedState(input, RUN_ID)).toEqual(input);
    const takeover = {
      ...reseal({
        ...value,
        pendingEffect: undefined,
        effectOccurrences: [
          [FIRST_KEY, 1],
          [PENDING_KEY, 1],
        ],
        state: {
          ...value.state,
          cursor: { turn: 2, tool: 1, ordinal: 2, phase: "takeover" },
        },
      }),
      pause: { kind: "takeover", attemptId: value.attemptId, fence: value.fence, eventSeq: 42 },
    };
    expect(parseStoredScriptedState(takeover, RUN_ID)).toEqual(takeover);
  });

  const corruptions: Array<[string, (value: StoredScriptedState) => Record<string, unknown>]> = [
    ["another envelope kind", (value) => ({ ...value, kind: "other" })],
    ["another envelope version", (value) => ({ ...value, version: 2 })],
    ["another envelope run", (value) => ({ ...value, runId: "run-other" })],
    ["empty writer attempt", (value) => ({ ...value, attemptId: "" })],
    ["zero lease fence", (value) => ({ ...value, fence: 0 })],
    ["fractional lease fence", (value) => ({ ...value, fence: 1.5 })],
    ["unknown envelope field", (value) => ({ ...value, approved: true })],
    [
      "another occurrence run",
      (value) => ({ ...value, effectOccurrences: [[FIRST_KEY.replace(RUN_ID, "run-other"), 1]] }),
    ],
    [
      "unhashed occurrence fingerprint",
      (value) => ({ ...value, effectOccurrences: [[`${RUN_ID}:write_file:unhashed`, 1]] }),
    ],
    [
      "empty occurrence kind",
      (value) => ({ ...value, effectOccurrences: [[`${RUN_ID}::${"a".repeat(64)}`, 1]] }),
    ],
    [
      "occurrence-suffixed fingerprint",
      (value) => ({ ...value, effectOccurrences: [[`${FIRST_KEY}:1`, 2]] }),
    ],
    [
      "duplicate occurrence fingerprints",
      (value) => ({
        ...value,
        effectOccurrences: [
          [FIRST_KEY, 1],
          [FIRST_KEY, 2],
        ],
      }),
    ],
    ["negative next occurrence", (value) => ({ ...value, effectOccurrences: [[FIRST_KEY, -1]] })],
    [
      "fractional next occurrence",
      (value) => ({ ...value, effectOccurrences: [[FIRST_KEY, 0.5]] }),
    ],
    [
      "unsafe next occurrence",
      (value) => ({ ...value, effectOccurrences: [[FIRST_KEY, Number.MAX_SAFE_INTEGER + 1]] }),
    ],
    [
      "extra occurrence tuple member",
      (value) => ({ ...value, effectOccurrences: [[FIRST_KEY, 1, 2]] }),
    ],
    [
      "duplicate consumed legacy effect",
      (value) => ({ ...value, consumedEffectIds: ["effect-prefix", "effect-prefix"] }),
    ],
    ["empty consumed legacy effect", (value) => ({ ...value, consumedEffectIds: [""] })],
    ["non-string consumed legacy effect", (value) => ({ ...value, consumedEffectIds: [1] })],
    [
      "pending identity from another run",
      (value) => ({
        ...value,
        pendingEffect: {
          ...value.pendingEffect,
          idempotencyKey: PENDING_KEY.replace(RUN_ID, "run-other"),
        },
      }),
    ],
    [
      "pending identity for another kind",
      (value) => ({ ...value, pendingEffect: { ...value.pendingEffect, kind: "write_file" } }),
    ],
    [
      "invalid pending request digest",
      (value) => ({
        ...value,
        pendingEffect: { ...value.pendingEffect, requestDigest: "unhashed" },
      }),
    ],
    [
      "unknown pending approval field",
      (value) => ({ ...value, pendingEffect: { ...value.pendingEffect, approved: true } }),
    ],
    [
      "empty pending effect ID",
      (value) => ({ ...value, pendingEffect: { ...value.pendingEffect, id: "" } }),
    ],
    [
      "empty pending effect kind",
      (value) => ({
        ...value,
        pendingEffect: {
          ...value.pendingEffect,
          kind: "",
          idempotencyKey: `${RUN_ID}::${"a".repeat(64)}`,
        },
      }),
    ],
    [
      "malformed pending effect key",
      (value) => ({
        ...value,
        pendingEffect: {
          ...value.pendingEffect,
          idempotencyKey: `${RUN_ID}:native_execute_tool:unhashed`,
        },
      }),
    ],
  ];

  it.each(corruptions)("rejects %s even with a recomputed envelope digest", (_label, corrupt) => {
    expect(() => parseStoredScriptedState(reseal(corrupt(storedFixture())), RUN_ID)).toThrow(ERROR);
  });

  it.each([
    { kind: "input", attemptId: "attempt-other", fence: 3, messageId: "ask-exact" },
    { kind: "input", attemptId: "attempt-paused", fence: 2, messageId: "ask-exact" },
    { kind: "input", attemptId: "attempt-paused", fence: 3, messageId: "" },
    { kind: "input", attemptId: "attempt-paused", fence: 3, messageId: "ask-exact", eventSeq: 42 },
    { kind: "takeover", attemptId: "attempt-paused", fence: 3, eventSeq: 0 },
    { kind: "takeover", attemptId: "attempt-paused", fence: 3, eventSeq: 1.5 },
    {
      kind: "takeover",
      attemptId: "attempt-paused",
      fence: 3,
      eventSeq: 42,
      messageId: "ask-exact",
    },
    {
      kind: "input",
      attemptId: "attempt-paused",
      fence: 3,
      messageId: "ask-exact",
      approved: true,
    },
    { kind: "approved", attemptId: "attempt-paused", fence: 3, messageId: "ask-exact" },
  ])("rejects a mismatched or malformed atomic pause receipt %j", (pause) => {
    expect(() => parseStoredScriptedState({ ...storedFixture(), pause }, RUN_ID)).toThrow(ERROR);
  });

  it("detects changed effect replay state without resealing", () => {
    const value = storedFixture();
    expect(() =>
      parseStoredScriptedState({ ...value, effectOccurrences: [[FIRST_KEY, 10]] }, RUN_ID),
    ).toThrow(ERROR);
    expect(() => parseStoredScriptedState({ ...value, consumedEffectIds: [] }, RUN_ID)).toThrow(
      ERROR,
    );
    expect(() => parseStoredScriptedState({ ...value, pendingEffect: undefined }, RUN_ID)).toThrow(
      ERROR,
    );
    expect(() => parseStoredScriptedState({ ...value, digest: "0".repeat(64) }, RUN_ID)).toThrow(
      ERROR,
    );
  });
});
