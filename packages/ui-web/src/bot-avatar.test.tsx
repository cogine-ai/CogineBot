import { ACTIVE_RUN_STATUSES, GAZE_SHAPE_KEYS, resolveGazeAvatar } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BotAvatar,
  DEFAULT_GROK_BOT_COLOR,
  defaultBotAvatarValue,
  GazeShapePreview,
  parseBotAvatar,
} from "./bot-avatar.js";

describe("companion avatars", () => {
  it.each([...ACTIVE_RUN_STATUSES])("uses existing active Run status %s", (status) => {
    const html = renderToString(
      <BotAvatar color="#62A8EC" identity="companion-a" status={status} />,
    );
    expect(html).toContain('data-working="true"');
    // Server rendering always includes the static identity; animation starts only in a visible browser.
    expect(html).toContain("rakazo-gaze-avatar");
  });
  it.each([undefined, "idle", "completed", "failed", "waiting_approval"])(
    "keeps %s static",
    (status) => {
      const html = renderToString(
        <BotAvatar color="#62A8EC" identity="companion-a" status={status} />,
      );
      expect(html).toContain('data-working="false"');
      expect(html).not.toContain("rakazo-avatar-activity");
      expect(html).not.toContain("<animate");
      expect(html).not.toContain("rakazo-bot-avatar-ring");
    },
  );
  it("preserves identity geometry at every size and across color/activity changes", () => {
    const expected = resolveGazeAvatar("companion-a");
    for (const size of [14, 17, 24, 26, 38, 72, 120]) {
      for (const status of [undefined, "running"]) {
        const html = renderToString(
          <BotAvatar color="#F5A15D" identity="companion-a" size={size} status={status} />,
        );
        expect(html).toContain(`data-shape="${expected.shapeKey}"`);
        expect(html).toContain(`data-eyes="${expected.eyesKey}"`);
        expect(html).toContain('viewBox="10 10 80 80"');
        expect(html).toContain(`min-width:${size}px;min-height:${size}px;flex:none;aspect-ratio:1`);
        expect(html).toContain('fill="#F5A15D"');
      }
    }
  });
  it.each(GAZE_SHAPE_KEYS.map((key, index) => [key, index] as const))(
    "renders persisted %s without wrapping the last choices",
    (key, index) => {
      const value = `#A78BE4::shape_${index}`;
      expect(parseBotAvatar(value).shapeIndex).toBe(index);
      expect(renderToString(<BotAvatar color={value} identity="companion-a" />)).toContain(
        `data-shape="${key}"`,
      );
      const preview = renderToString(
        <GazeShapePreview color="#A78BE4" shapeIndex={index} selected />,
      );
      expect(preview).toContain(`aria-label="${key}"`);
      expect(preview).toContain('aria-pressed="true"');
      expect(preview).toContain(`data-shape="${key}"`);
    },
  );
  it.each(["running", "idle"])("keeps uploaded images static for a %s Run", (status) => {
    const html = renderToString(
      <BotAvatar
        color="data:image/webp;base64,abc"
        identity="companion-a"
        status={status}
        size={32}
      />,
    );
    expect(html).toContain('src="data:image/webp;base64,abc"');
    expect(html).toContain(`data-working="${status === "running"}"`);
    expect(html).not.toContain("rakazo-avatar-activity");
    expect(html).not.toContain("rakazo-gaze-avatar");
    expect(html).not.toContain('class="avatar-activity');
    expect(html).not.toContain("rakazo-bot-avatar-ring");
    expect(html).not.toContain("box-shadow");
    expect(html).toContain('draggable="false"');
  });
  it("does not turn arbitrary persisted values into remote image requests", () => {
    const parsed = parseBotAvatar("https://example.invalid/avatar.png");
    expect(parsed.isImage).toBe(false);
    expect(parsed.imageUrl).toBeUndefined();
    const html = renderToString(
      <BotAvatar color="https://example.invalid/avatar.png" identity="companion-a" />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("example.invalid");
    expect(html).not.toContain('fill="https:');
  });
  it("normalizes malformed indices and keeps Reset as identity-derived silhouette with existing color", () => {
    for (const suffix of ["-1", "3junk", "", "999999999999999999999"]) {
      expect(parseBotAvatar(`#62A8EC::shape_${suffix}`).shapeIndex).toBe(0);
    }
    expect(parseBotAvatar("#62A8EC::shape_12").shapeIndex).toBe(1);
    expect(defaultBotAvatarValue("#62A8EC::shape_10")).toBe("#62A8EC");
    expect(defaultBotAvatarValue("data:image/png;base64,abc")).toBe(DEFAULT_GROK_BOT_COLOR);
    expect(defaultBotAvatarValue("#zzzzzz::shape_1")).toBe(DEFAULT_GROK_BOT_COLOR);
    const html = renderToString(
      <BotAvatar color={defaultBotAvatarValue("#62A8EC::shape_10")} identity="companion-a" />,
    );
    expect(html).toContain(`data-shape="${resolveGazeAvatar("companion-a").shapeKey}"`);
  });
});
