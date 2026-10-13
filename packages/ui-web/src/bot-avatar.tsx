import { parseBotAvatarValue } from "@rakazo/contracts";
import type { GrokColorDef } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  DEFAULT_GROK_BOT_COLOR,
  GAZE_INK_COLOR,
  GAZE_VIEWBOX,
  GROK_BOT_COLORS,
  GROK_COLOR_LIST,
  resolveGazeAvatar,
  resolvePersonaColorDef,
} from "@rakazo/core";
import type { CSSProperties } from "react";
import { memo } from "react";
import { AvatarActivity } from "./avatar-activity/avatar-activity.js";
import { cn } from "./lib/utils.js";
import "./styles.css";

export type { GrokColorDef };
export { DEFAULT_GROK_BOT_COLOR, GROK_BOT_COLORS, GROK_COLOR_LIST, resolvePersonaColorDef };

const AVATAR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function parseBotAvatar(
  rawColor: string,
  _identity?: string,
): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  const parsed = parseBotAvatarValue(rawColor);
  if (parsed.kind === "image")
    return { color: DEFAULT_GROK_BOT_COLOR, isImage: true, imageUrl: parsed.imageUrl };
  return {
    color: parsed.kind === "other" ? parsed.raw || DEFAULT_GROK_BOT_COLOR : parsed.color,
    shapeIndex: parsed.kind === "shape" ? parsed.shapeIndex : undefined,
    isImage: false,
  };
}

export function defaultBotAvatarValue(rawColor: string): string {
  const parsed = parseBotAvatar(rawColor);
  return !parsed.isImage && AVATAR_HEX.test(parsed.color) ? parsed.color : DEFAULT_GROK_BOT_COLOR;
}

function avatarFrameStyle(size: number): CSSProperties {
  return {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    flex: "none",
    aspectRatio: "1",
  };
}

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 36,
  status,
  identity = "",
  className,
}: BotAvatarProps) {
  const parsed = parseBotAvatar(color);
  const effectiveIdentity = identity || "companion";
  const working = ACTIVE_RUN_STATUSES.some((active) => active === status);
  const bodyColor = resolvePersonaColorDef(effectiveIdentity, parsed.color).hex;
  const gaze = resolveGazeAvatar(effectiveIdentity, parsed.shapeIndex);
  const artwork = (
    <svg
      viewBox={GAZE_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
      className="rakazo-gaze-avatar block size-full"
      data-shape={gaze.shapeKey}
      data-eyes={gaze.eyesKey}
    >
      <path d={gaze.shapePath} fill={bodyColor} />
      <g
        transform={gaze.eyeTransform}
        fill={gaze.eyes.fill === "ink" ? GAZE_INK_COLOR : "none"}
        stroke={gaze.eyes.strokeWidth ? GAZE_INK_COLOR : undefined}
        strokeWidth={gaze.eyes.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={gaze.eyes.path} transform="translate(9.5)" />
        <path d={gaze.eyes.path} transform="translate(34.5)" />
      </g>
    </svg>
  );
  return (
    <div
      className={cn("rakazo-bot-avatar relative shrink-0 select-none", className)}
      data-working={working}
      data-avatar-identity={effectiveIdentity}
      style={
        { ...avatarFrameStyle(size), "--avatar-activity-eye": GAZE_INK_COLOR } as CSSProperties
      }
    >
      {parsed.isImage && parsed.imageUrl ? (
        <img
          src={parsed.imageUrl}
          alt=""
          draggable={false}
          className="block size-full rounded-full object-cover bg-secondary"
        />
      ) : working ? (
        <AvatarActivity identity={effectiveIdentity} color={bodyColor} size={size}>
          {artwork}
        </AvatarActivity>
      ) : (
        artwork
      )}
    </div>
  );
});

export function GazeShapePreview({
  shapeIndex,
  color,
  selected,
  onClick,
  identity = "avatar-shape-preview",
}: {
  shapeIndex: number;
  color: string;
  selected?: boolean;
  onClick?: () => void;
  identity?: string;
}) {
  const shape = resolveGazeAvatar(identity, shapeIndex);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={shape.shapeKey}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-full border transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-muted-foreground" : "border-transparent",
      )}
    >
      <BotAvatar color={`${color}::shape_${shape.shapeIndex}`} identity={identity} size={34} />
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Rakazo
      </span>
    </div>
  );
}
