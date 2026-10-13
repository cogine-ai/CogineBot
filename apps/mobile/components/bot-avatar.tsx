import type { ResolvedGazeAvatar } from "@rakazo/core";
import { ACTIVE_RUN_STATUSES, GAZE_INK_COLOR, GAZE_VIEWBOX, resolveGazeAvatar } from "@rakazo/core";
import { memo, useEffect } from "react";
import { Image, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";
import { workingAvatarDuration, workingAvatarFrame } from "../lib/avatar-motion";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  status,
  identity,
  muted = false,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const isWorking = ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
  const parsed = mobileBotAvatarPresentation(color, identity);
  const picture =
    parsed.kind === "image" ? (
      <Image
        source={{ uri: parsed.imageUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    ) : (
      <GazeAvatar
        avatar={
          parsed.kind === "shape" || parsed.kind === "color"
            ? parsed
            : resolveGazeAvatar(identity || color)
        }
        color={
          parsed.kind === "shape" || parsed.kind === "color" ? parsed.color : tokens.mutedForeground
        }
        size={size}
        isWorking={isWorking}
      />
    );

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityLabel={isWorking ? t("Working") : undefined}
    >
      {picture}
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: tokens.background,
            backgroundColor: tokens.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color={tokens.foreground}
          />
        </View>
      ) : null}
    </View>
  );
});

/** Native keeps its existing Reanimated activity transform around shared Gaze geometry. */
function GazeAvatar({
  avatar,
  color,
  size,
  isWorking,
}: {
  avatar: ResolvedGazeAvatar;
  color: string;
  size: number;
  isWorking: boolean;
}) {
  const progress = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const seed = avatar.seed;
  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (isWorking && !reducedMotion) {
      progress.value = withRepeat(
        withTiming(1, { duration: workingAvatarDuration(seed), easing: Easing.linear }),
        -1,
      );
    }
    return () => cancelAnimation(progress);
  }, [isWorking, progress, reducedMotion, seed]);

  const bodyStyle = useAnimatedStyle(() => {
    if (!isWorking || reducedMotion) return {};
    const frame = workingAvatarFrame(seed, progress.value);
    return {
      transform: [
        { translateX: (frame.translationX * size) / 120 },
        { translateY: (frame.translationY * size) / 120 },
        { rotate: `${frame.rotation}deg` },
        { scaleX: frame.scaleX },
        { scaleY: frame.scaleY },
      ],
    };
  });

  return (
    <View style={{ width: size, height: size, overflow: "hidden" }}>
      <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
        <Svg width={size} height={size} viewBox={GAZE_VIEWBOX}>
          <Path d={avatar.shapePath} fill={color} />
          <G transform={avatar.eyeTransform}>
            {[9.5, 34.5].map((offset) => (
              <G key={offset} transform={`translate(${offset})`}>
                <Path
                  d={avatar.eyes.path}
                  fill={avatar.eyes.fill === "ink" ? GAZE_INK_COLOR : "none"}
                  stroke={avatar.eyes.strokeWidth ? GAZE_INK_COLOR : undefined}
                  strokeWidth={avatar.eyes.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </G>
            ))}
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}
