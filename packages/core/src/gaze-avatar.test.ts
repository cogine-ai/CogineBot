import { BOT_AVATAR_SHAPE_COUNT, parseBotAvatarValue } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { GAZE_SHAPE_KEYS, GAZE_SHAPES, resolveGazeAvatar } from "./gaze-avatar.js";

describe("shared Gaze avatar geometry", () => {
  it("resolves every persisted shape to the same geometry on every surface", () => {
    expect(GAZE_SHAPE_KEYS).toHaveLength(BOT_AVATAR_SHAPE_COUNT);
    GAZE_SHAPE_KEYS.forEach((key, shapeIndex) => {
      const persisted = parseBotAvatarValue(`#62A8EC::shape_${shapeIndex}`);
      expect(persisted.kind).toBe("shape");
      if (persisted.kind !== "shape") return;
      const resolved = resolveGazeAvatar("bot-1", persisted.shapeIndex);
      expect(resolved.shapeKey).toBe(key);
      expect(resolved.shapePath).toBe(GAZE_SHAPES[key].path);
      expect(resolved.eyeTransform).toBe(GAZE_SHAPES[key].eyeTransform);
    });
  });

  it("keeps an identity's expression while changing shape and restoring its default", () => {
    const initial = resolveGazeAvatar("bot-1");
    for (let shapeIndex = 0; shapeIndex < GAZE_SHAPE_KEYS.length; shapeIndex++) {
      expect(resolveGazeAvatar("bot-1", shapeIndex).eyes).toEqual(initial.eyes);
    }
    expect(resolveGazeAvatar("bot-1")).toEqual(initial);
    const expressions = new Set(
      Array.from({ length: 60 }, (_, index) => resolveGazeAvatar(`bot-${index}`).eyesKey),
    );
    expect(expressions.size).toBe(4);
  });

  it("uses a safe identity default for invalid explicit indices", () => {
    const initial = resolveGazeAvatar("bot-1");
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveGazeAvatar("bot-1", invalid)).toEqual(initial);
    }
  });
});
