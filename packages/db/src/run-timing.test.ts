import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { isRunResponse, readRunTimingFields, runTimingFields } from "./run-timing.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe("run response timing", () => {
  it("includes time before a steering continuation is created, without resetting on retry", () => {
    expect(
      runTimingFields({
        trigger: "follow_up",
        sourceMessage: { createdAt: at(0) },
        createdAt: at(10),
        startedAt: at(12),
        firstResponseAt: at(15),
        completedAt: at(30),
      }),
    ).toEqual({
      "run.trigger": "follow_up",
      "run.pre_run_wait_ms": 10_000,
      "run.queue_wait_ms": 2_000,
      "run.first_response_ms": 15_000,
      "run.total_ms": 30_000,
      "run.execution_wall_ms": 18_000,
    });
  });

  it("does not invent a response or execution time for a silent or never-started run", () => {
    expect(
      runTimingFields({
        trigger: "routine",
        sourceMessage: null,
        createdAt: at(0),
        startedAt: null,
        firstResponseAt: null,
        completedAt: at(10),
      }),
    ).toEqual({ "run.trigger": "routine", "run.pre_run_wait_ms": 0, "run.total_ms": 10_000 });
  });

  it("counts streamed reply text, durable replies and action cards, excluding activity and hidden output", () => {
    expect(isRunResponse("thread.progress", { streaming: true, delta: "reply" })).toBe(true);
    expect(
      isRunResponse("thread.message.created", { role: "bot", blocks: [{ kind: "chart" }] }),
    ).toBe(true);
    expect(isRunResponse("thread.progress", { text: "activity", activity: true })).toBe(false);
    expect(isRunResponse("thread.meta", { activity: { thinking: true } })).toBe(false);
    expect(isRunResponse("thread.meta", { activity: { thinking: false } })).toBe(false);
    expect(isRunResponse("thread.progress", { streaming: true, text: "" })).toBe(false);
    expect(
      isRunResponse("thread.message.created", { role: "bot", blocks: [{ kind: "ask" }] }),
    ).toBe(true);
    expect(
      isRunResponse("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "text", text: "reply" }],
      }),
    ).toBe(true);
    expect(
      isRunResponse("thread.message.created", {
        role: "user",
        blocks: [{ kind: "text", text: "input" }],
      }),
    ).toBe(false);
    expect(
      isRunResponse("thread.message.created", {
        role: "bot",
        blocks: [{ kind: "meta" }, { kind: "steps" }],
      }),
    ).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["thread.progress", { streaming: true, activity: true, delta: "working" }],
    ["thread.progress", { streaming: true, delta: " \n " }],
    ["thread.progress", { streaming: false, delta: "placeholder" }],
    ["thread.message.updated", { role: "bot", blocks: [{ kind: "text", text: "old reply" }] }],
    ["thread.message.created", { role: "system", blocks: [{ kind: "text", text: "notice" }] }],
    ["thread.message.created", { role: "bot", blocks: [null, {}, { kind: "text", text: " " }] }],
    ["thread.message.created", { role: "bot", blocks: [{ kind: "call_request" }] }],
  ])("does not mark non-replies: %s %j", (type, payload) => {
    expect(isRunResponse(type, payload)).toBe(false);
  });

  it.each([
    "card",
    "chart",
    "ask",
    "choice",
    "app_connect",
    "connect",
    "computer",
    "voice_call",
    "image",
    "file",
    "handoff",
    "skill_draft",
    "mcp_approval",
    "child_bot",
    "cloud_agent",
  ])("counts the existing visible %s result block", (kind) => {
    expect(isRunResponse("thread.message.created", { role: "bot", blocks: [{ kind }] })).toBe(true);
  });

  it("clamps skewed timestamps without inventing an end for active work", () => {
    expect(
      runTimingFields({
        trigger: "user",
        createdAt: at(10),
        startedAt: at(9),
        firstResponseAt: at(8),
        completedAt: null,
        sourceMessage: { createdAt: at(11) },
      }),
    ).toEqual({
      "run.trigger": "user",
      "run.pre_run_wait_ms": 0,
      "run.queue_wait_ms": 0,
      "run.first_response_ms": 0,
    });
  });

  it("reads only timing fields and tolerates missing or unreadable rows", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        trigger: "user",
        createdAt: at(0),
        startedAt: at(1),
        firstResponseAt: at(2),
        completedAt: at(3),
        sourceMessage: null,
      })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("fixture disconnected"));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    await expect(readRunTimingFields(prisma, "run-1")).resolves.toMatchObject({
      "run.first_response_ms": 2_000,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-1" },
      select: {
        trigger: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        firstResponseAt: true,
        sourceMessage: { select: { createdAt: true } },
      },
    });
    await expect(readRunTimingFields(prisma, "gone")).resolves.toEqual({});
    await expect(readRunTimingFields(prisma, "unreadable")).resolves.toEqual({});
  });
});
