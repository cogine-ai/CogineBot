import { describe, expect, it } from "vitest";
import { mergeConnectionSelections } from "./connection-selection.js";

const references = [
  { id: "gmail-1", connectorId: "pipedream", provider: "gmail" },
  { id: "gmail-2", connectorId: "composio", provider: "gmail" },
  { id: "gmail-3", connectorId: "pipedream", provider: "gmail" },
  { id: "gmail-composio", connectorId: "composio", provider: "gmail" },
  { id: "calendar-1", connectorId: "pipedream", provider: "googlecalendar" },
  { id: "slack-1", connectorId: "composio", provider: "slack" },
];

describe("mergeConnectionSelections", () => {
  it("applies consumed batches in order, replacing the same known app across sources", () => {
    const previous = ["gmail-1", "calendar-1", "gmail-composio"];
    const batches = [["gmail-2"], ["slack-1"], ["gmail-3"]];
    expect(mergeConnectionSelections(previous, batches, references)).toEqual([
      "calendar-1",
      "slack-1",
      "gmail-3",
    ]);
    expect(previous).toEqual(["gmail-1", "calendar-1", "gmail-composio"]);
    expect(batches).toEqual([["gmail-2"], ["slack-1"], ["gmail-3"]]);
  });

  it("preserves multiple explicit accounts in one message until a later message replaces that app", () => {
    expect(
      mergeConnectionSelections(
        ["gmail-1", "calendar-1"],
        [["gmail-2", "gmail-3", "gmail-2"]],
        references,
      ),
    ).toEqual(["calendar-1", "gmail-2", "gmail-3"]);
    expect(
      mergeConnectionSelections(["gmail-2", "gmail-3", "calendar-1"], [["gmail-1"]], references),
    ).toEqual(["calendar-1", "gmail-1"]);
  });

  it("replaces a previous Pipedream Gmail choice with explicitly selected Composio Gmail", () => {
    expect(
      mergeConnectionSelections(["gmail-1", "calendar-1"], [["gmail-composio"]], references),
    ).toEqual(["calendar-1", "gmail-composio"]);
    expect(
      mergeConnectionSelections(["calendar-1"], [["gmail-1", "gmail-composio"]], references),
    ).toEqual(["calendar-1", "gmail-1", "gmail-composio"]);
  });

  it("keeps absent target IDs instead of substituting an available sibling", () => {
    expect(
      mergeConnectionSelections(
        ["deleted-target", "calendar-1"],
        [["unavailable-target"]],
        references,
      ),
    ).toEqual(["deleted-target", "calendar-1", "unavailable-target"]);
    expect(mergeConnectionSelections([], [["unavailable-target"]], references)).toEqual([
      "unavailable-target",
    ]);
  });

  it("leaves prior choices intact when the user does not mention another account", () => {
    expect(mergeConnectionSelections(["gmail-1", "calendar-1"], [[], []], references)).toEqual([
      "gmail-1",
      "calendar-1",
    ]);
  });

  it("keeps unknown apps scoped to their exact source and slug without guessing aliases", () => {
    const refs = [
      { id: "a", connectorId: "pipedream", provider: "private_crm" },
      { id: "b", connectorId: "composio", provider: "private_crm" },
      { id: "c", connectorId: "pipedream", provider: "private_crm" },
      { id: "d", connectorId: "pipedream", provider: "private-crm" },
    ];
    expect(mergeConnectionSelections(["a", "b", "d"], [["c"]], refs)).toEqual(["b", "d", "c"]);
  });
});
