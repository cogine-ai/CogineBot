import type { ParsedBotAvatar } from "@rakazo/contracts";
import { parseBotAvatarValue } from "@rakazo/contracts";
import type { ResolvedGazeAvatar } from "@rakazo/core";
import { GAZE_INK_COLOR, resolveGazeAvatar } from "@rakazo/core";

export type MobileBotAvatarPresentation =
  | Exclude<ParsedBotAvatar, { kind: "shape" } | { kind: "color" }>
  | (ResolvedGazeAvatar & { kind: "shape" | "color"; color: string; eyeColor: string });

/** Use the same persisted shape, identity, and expression on native and web. */
export function mobileBotAvatarPresentation(
  color: string,
  identity = color,
): MobileBotAvatarPresentation {
  const parsed = parseBotAvatarValue(color);
  if (parsed.kind !== "shape" && parsed.kind !== "color") return parsed;
  return {
    kind: parsed.kind,
    color: parsed.color,
    eyeColor: GAZE_INK_COLOR,
    ...resolveGazeAvatar(identity, parsed.kind === "shape" ? parsed.shapeIndex : undefined),
  };
}
