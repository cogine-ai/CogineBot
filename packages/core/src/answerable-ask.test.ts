import { describe, expect, it, vi } from "vitest";
import {
  latestAnswerableAskMessageId,
  reconcileWebsiteLoginAnswer,
  resolveAskChoice,
  selectedAskActionLabel,
  WebsiteLoginAnswerUnconfirmed,
} from "./answerable-ask.js";

it("checks the same card again without resubmitting when the first read fails", async () => {
  const original = {
    id: "message-1",
    runId: "run-1",
    blocks: [{ kind: "ask", status: "pending", loginRequestEffectId: "effect-1" }],
  };
  const answered = {
    ...original,
    blocks: [{ ...original.blocks[0]!, status: "answered" }],
  };
  const responses = [
    [{ ...answered, runId: "different-run" }],
    [
      {
        ...answered,
        blocks: [{ ...answered.blocks[0]!, loginRequestEffectId: "different-effect" }],
      },
    ],
    [original],
    [answered],
  ];
  let reads = 0;
  const confirmed = vi.fn();
  const receipt = await reconcileWebsiteLoginAnswer(
    original,
    async () => {
      if (reads++ === 0) throw new Error("Read unavailable");
      return responses[reads - 2]!;
    },
    { confirmed },
  ).catch((error: unknown) => error);
  expect(receipt).toBeInstanceOf(WebsiteLoginAnswerUnconfirmed);
  if (!(receipt instanceof WebsiteLoginAnswerUnconfirmed)) throw new Error("Receipt fixture");
  await expect(receipt.check()).rejects.toThrow("original protected login card");
  await expect(receipt.check()).rejects.toThrow("original protected login card");
  await expect(receipt.check()).resolves.toBe(false);
  await expect(receipt.check()).resolves.toBe(true);
  expect(confirmed).toHaveBeenCalledOnce();
  await expect(
    reconcileWebsiteLoginAnswer(original, async () => [original]),
  ).rejects.toBeInstanceOf(WebsiteLoginAnswerUnconfirmed);
  await expect(
    reconcileWebsiteLoginAnswer(original, async () => [original], {
      rejection: { status: 400 },
    }),
  ).resolves.toBe(false);
});

describe("latestAnswerableAskMessageId", () => {
  it("finds a waiting prompt even when a newer group run is active", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-newer", status: "running" },
        activeRuns: [
          { id: "run-newer", status: "running" },
          { id: "run-waiting", status: "waiting_input" },
        ],
        messages: [
          {
            id: "ask-1",
            runId: "run-waiting",
            blocks: [{ kind: "ask", status: "pending" }],
          },
        ],
      }),
    ).toBe("ask-1");
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "running" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] }],
      }),
    ).toBeNull();
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "answered" }] }],
      }),
    ).toBeNull();
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("resolveAskChoice", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ];

  it("matches an offered choice by id or label", () => {
    expect(resolveAskChoice("choice-2", actions)).toEqual({ id: "choice-2", label: "Seoul" });
    expect(resolveAskChoice(" seoul ", actions)).toEqual({ id: "choice-2", label: "Seoul" });
  });

  it("leaves unmatched free-text as a custom answer", () => {
    expect(resolveAskChoice("Toronto", actions)).toBeUndefined();
  });
});
