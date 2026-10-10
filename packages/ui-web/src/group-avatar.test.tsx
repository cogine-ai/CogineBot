import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvatarStyleProvider } from "./avatar-style.js";
import { GroupAvatar } from "./group-avatar.js";

describe("GroupAvatar", () => {
  it("renders fallback squad icon when no members provided", () => {
    const html = renderToString(<GroupAvatar members={[]} />);
    expect(html).toContain("<svg");
  });

  it("renders single BotAvatar when 1 member", () => {
    const html = renderToString(<GroupAvatar members={[{ name: "Harry", color: "#8B5CF6" }]} />);
    expect(html).toContain("rakazo-bot-avatar");
  });

  it("renders 2 overlapping bot avatars for 2 members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
        ]}
      />,
    );
    const count = (html.match(/data-working=/g) || []).length;
    expect(count).toBe(2);
    expect(html).toContain('data-working="false"');
  });

  it("renders a working member inside a group avatar", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6", status: "running" },
          { name: "Elon", color: "#06B6D4", status: "idle" },
        ]}
      />,
    );
    expect(html).toContain('data-working="true"');
    expect(html).toContain("rakazo-bot-avatar");
  });

  it("renders 3 mini bot avatars for 3 members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
          { name: "Penny", color: "#EC4899" },
        ]}
      />,
    );
    const count = (html.match(/data-working=/g) || []).length;
    expect(count).toBe(3);
  });

  it("renders 2 mini avatars + overflow count for 4+ members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "Sherlock", color: "#8B5CF6" },
          { name: "Elon", color: "#06B6D4" },
          { name: "Penny", color: "#EC4899" },
          { name: "Harry", color: "#10B981" },
        ]}
      />,
    );
    expect(html).toContain("+2");
  });

  it("inherits portrait defaults and keeps uploaded member images in a fixed square frame", () => {
    const html = renderToString(
      <AvatarStyleProvider value="robot" portraitDefaults>
        <GroupAvatar
          size={40}
          members={[
            { botId: "bot-a", color: "#8B5CF6" },
            { botId: "bot-b", color: "data:image/png;base64,abc" },
          ]}
        />
      </AvatarStyleProvider>,
    );
    expect(html).toContain("min-width:40px;min-height:40px;flex:none;aspect-ratio:1");
    expect(html).toContain("rakazo-bot-portrait");
    expect(html).toContain('src="data:image/png;base64,abc"');
    expect(html).toContain("min-width:26px;min-height:26px;flex:none;aspect-ratio:1");
    expect(html.match(/<img /g)).toHaveLength(2);
  });
});
