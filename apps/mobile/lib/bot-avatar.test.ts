import { GAZE_INK_COLOR, GAZE_SHAPE_KEYS, resolveGazeAvatar } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { mobileBotAvatarPresentation } from "./bot-avatar.js";

describe("mobile bot avatar presentation", () => {
  it("renders every persisted Gaze shape using the shared web geometry", () => {
    GAZE_SHAPE_KEYS.forEach((_, shapeIndex) => {
      const presented = mobileBotAvatarPresentation(`#8B5CF6::shape_${shapeIndex}`, "bot-1");
      expect(presented).toEqual({
        kind: "shape",
        color: "#8B5CF6",
        eyeColor: GAZE_INK_COLOR,
        ...resolveGazeAvatar("bot-1", shapeIndex),
      });
    });
  });

  it("uses the identity default for plain colors without changing its expression", () => {
    const initial = mobileBotAvatarPresentation("#8B5CF6", "bot-1");
    const recolored = mobileBotAvatarPresentation("#EAB308", "bot-1");
    expect(initial).toMatchObject({ kind: "color", ...resolveGazeAvatar("bot-1") });
    expect(recolored).toMatchObject({ kind: "color", ...resolveGazeAvatar("bot-1") });
  });

  it("preserves uploaded images and does not render remote URLs", () => {
    expect(mobileBotAvatarPresentation("data:image/png;base64,abc")).toEqual({
      kind: "image",
      imageUrl: "data:image/png;base64,abc",
    });
    expect(mobileBotAvatarPresentation("https://evil.example/track.png")).toEqual({
      kind: "other",
      raw: "https://evil.example/track.png",
    });
  });
});
