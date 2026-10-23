import type { SearchHit } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { InboxSpace } from "./inbox-spaces";
import { searchSheetRows } from "./search-sheet";

vi.mock("./i18n", () => ({ t: (value: string) => value }));

const bot = {
  id: "bot-a",
  name: "Scout",
  title: "Research",
  preview: "A **note**",
  status: "idle",
};
const spaces = [{ id: "space-a", bots: [bot], groups: [] }] as unknown as InboxSpace[];
const message: SearchHit = {
  kind: "message",
  botId: "absent-bot",
  botName: "Writer",
  title: "Found",
  snippet: "A **matching** line",
  messageId: "message-a",
};

describe("search sheet result destinations", () => {
  it("keeps verified query provenance for a hit absent from the roster", () => {
    const rows = searchSheetRows(spaces, "matching", [message], "space-query");
    expect(rows).toEqual([
      expect.objectContaining({
        spaceId: "space-query",
        destination: {
          pathname: "/thread",
          params: { botId: "absent-bot", name: "Writer", messageId: "message-a" },
        },
      }),
    ]);
  });

  it("does not advertise unscoped remote results and keeps known local rows usable", () => {
    const rows = searchSheetRows(spaces, "Scout", [message]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "bot-bot-a", spaceId: "space-a" });
  });
});

it("keeps local conversations unique and distinct links from one message while sanitizing previews", () => {
  const first: SearchHit = {
    kind: "link",
    botId: "bot-a",
    botName: "Scout",
    title: "A",
    snippet: "A **note** data:image/png;base64,AAAA",
    messageId: "message-a",
    url: "https://example.test/a",
  };
  const second = { ...first, title: "B", url: "https://example.test/b" };
  const rows = searchSheetRows(
    spaces,
    "Scout",
    [{ ...message, kind: "conversation", botId: "bot-a" }, first, first, second],
    "space-a",
  );
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  expect(rows.filter((row) => row.kind === "link").map((row) => row.preview)).toEqual([
    "Scout · A note",
    "Scout · A note",
  ]);
  expect(rows.every((row) => row.spaceId === "space-a")).toBe(true);
});
