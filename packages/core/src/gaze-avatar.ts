import { avatarIdentitySeed } from "./avatar-shape.js";

export { GAZE_BOT_COLORS, GAZE_INK_COLOR } from "@rakazo/ui-tokens";

/** Static Gaze artwork, derived from DiceBear's CC0 Gaze definition.
 * Source: https://www.dicebear.com/styles/gaze/ (styles 10.6.0).
 */
export const GAZE_VIEWBOX = "10 10 80 80";

export const GAZE_SHAPE_KEYS = [
  "circle",
  "square",
  "triangle",
  "pentagon",
  "hexagon",
  "octagon",
  "diamond",
  "pill",
  "column",
  "egg",
  "arch",
] as const;

export type GazeShapeKey = (typeof GAZE_SHAPE_KEYS)[number];
export type GazeShape = { readonly path: string; readonly eyeTransform: string };

export const GAZE_SHAPES = {
  circle: {
    path: "M50 16a34 34 0 1 1 0 68a34 34 0 1 1 0-68Z",
    eyeTransform: "translate(20 46)",
  },
  square: {
    path: "M16 31q0-15 15-15h38q15 0 15 15v38q0 15-15 15H31q-15 0-15-15Z",
    eyeTransform: "translate(20 46)",
  },
  triangle: {
    path: "M43.51 23.27Q50 12 56.49 23.27l25.02 43.46Q88 78 75 78H25q-13 0-6.51-11.27Z",
    eyeTransform: "matrix(.86 0 0 .86 24.2 51.12)",
  },
  pentagon: {
    path: "M39.48 21.64Q50 14 60.52 21.64l15.1 10.98q10.52 7.64 6.5 20l-5.77 17.76q-4.01 12.36-17.01 12.36H40.66q-13 0-17.01-12.36l-5.77-17.76q-4.02-12.36 6.5-20Z",
    eyeTransform: "matrix(.95 0 0 .95 21.5 48.4)",
  },
  hexagon: {
    path: "M39.61 19Q50 13 60.39 19l11.26 6.5q10.39 6 10.39 18v13q0 12-10.39 18L60.39 81Q50 87 39.61 81l-11.26-6.5q-10.39-6-10.39-18v-13q0-12 10.39-18Z",
    eyeTransform: "translate(20 45)",
  },
  octagon: {
    path: "M40.76 17.83q9.24-3.83 18.48 0l6.98 2.89q9.24 3.82 13.06 13.06l2.89 6.98q3.83 9.24 0 18.48l-2.89 6.98q-3.82 9.24-13.06 13.06l-6.98 2.89Q50 86 40.76 82.17l-6.98-2.89q-9.24-3.82-13.06-13.06l-2.89-6.98Q14 50 17.83 40.76l2.89-6.98q3.82-9.24 13.06-13.06Z",
    eyeTransform: "translate(20 45)",
  },
  diamond: {
    path: "M39.39 21.61Q50 11 60.61 21.61l17.78 17.78Q89 50 78.39 60.61L60.61 78.39Q50 89 39.39 78.39L21.61 60.61Q11 50 21.61 39.39Z",
    eyeTransform: "matrix(.82 0 0 .82 25.4 46.44)",
  },
  pill: {
    path: "M36 25h28a25 25 0 0 1 0 50H36a25 25 0 0 1 0-50Z",
    eyeTransform: "matrix(1.1 0 0 1.1 17 43.2)",
  },
  column: {
    path: "M50 11a22 22 0 0 1 22 22v34a22 22 0 0 1-44 0V33a22 22 0 0 1 22-22Z",
    eyeTransform: "matrix(.85 0 0 .85 24.5 43.2)",
  },
  egg: {
    path: "M50 13c19 0 29 19 29 37 0 22-13 36-29 36S21 72 21 50c0-18 10-37 29-37",
    eyeTransform: "matrix(.92 0 0 .92 22.4 47.64)",
  },
  arch: {
    path: "M18 84V46c0-18 14-32 32-32s32 14 32 32v38c0 2.2-1.8 4-4 4H22c-2.2 0-4-1.8-4-4",
    eyeTransform: "matrix(.95 0 0 .95 21.5 47.4)",
  },
} as const satisfies Record<GazeShapeKey, GazeShape>;

export type GazeEyes = {
  readonly path: string;
  readonly fill: "ink" | "none";
  readonly strokeWidth?: number;
};

export const GAZE_EYES = {
  beans: {
    path: "M8 1.4a3.7 3.7 0 0 1 3.7 3.7v5.8a3.7 3.7 0 0 1-7.4 0V5.1A3.7 3.7 0 0 1 8 1.4Z",
    fill: "ink",
  },
  dots: {
    path: "M8 2.6a5.4 5.4 0 1 1 0 10.8a5.4 5.4 0 1 1 0-10.8Z",
    fill: "ink",
  },
  happy: { path: "M2 10.2q6-6.6 12 0", fill: "none", strokeWidth: 3.4 },
  tall: {
    path: "M8 1.2a4.6 6.8 0 1 1 0 13.6a4.6 6.8 0 1 1 0-13.6Z",
    fill: "ink",
  },
} as const satisfies Record<string, GazeEyes>;

const GAZE_EYE_KEYS = ["beans", "dots", "happy", "tall"] as const;
export type GazeEyeKey = (typeof GAZE_EYE_KEYS)[number];

export type ResolvedGazeAvatar = {
  seed: number;
  shapeIndex: number;
  shapeKey: GazeShapeKey;
  shapePath: string;
  eyeTransform: string;
  eyesKey: GazeEyeKey;
  eyes: GazeEyes;
};

/** Shape and expression remain stable when activity, color, or rendering size changes. */
export function resolveGazeAvatar(identity: string, explicitIndex?: number): ResolvedGazeAvatar {
  const seed = avatarIdentitySeed(identity);
  const index =
    Number.isSafeInteger(explicitIndex) && (explicitIndex ?? -1) >= 0
      ? (explicitIndex ?? 0) % GAZE_SHAPE_KEYS.length
      : seed % GAZE_SHAPE_KEYS.length;
  const shapeKey = GAZE_SHAPE_KEYS[index] ?? "circle";
  const shape = GAZE_SHAPES[shapeKey];
  const eyesKey =
    GAZE_EYE_KEYS[Math.floor(seed / GAZE_SHAPE_KEYS.length) % GAZE_EYE_KEYS.length] ?? "beans";
  return {
    seed,
    shapeIndex: index,
    shapeKey,
    shapePath: shape.path,
    eyeTransform: shape.eyeTransform,
    eyesKey,
    eyes: GAZE_EYES[eyesKey],
  };
}
