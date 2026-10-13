// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationRow } from "./conversation-row";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(unread: boolean, approvalPending: boolean, compact = false) {
  act(() =>
    root.render(
      <ConversationRow
        name="Companion"
        preview="Last message"
        avatar={<span role="img" aria-label="Companion portrait" />}
        selected={false}
        compact={compact}
        unread={unread}
        approvalPending={approvalPending}
      />,
    ),
  );
}

it("shows one approval hint while preserving unread for the next render", () => {
  render(true, true);
  expect(container.querySelectorAll("[data-conversation-attention]")).toHaveLength(1);
  expect(
    container
      .querySelector("[data-conversation-attention]")
      ?.getAttribute("data-conversation-attention"),
  ).toBe("approval");
  expect(container.querySelector("button")?.getAttribute("aria-label")).toContain(
    "approval pending",
  );
  render(true, false);
  expect(container.querySelectorAll("[data-conversation-attention]")).toHaveLength(1);
  expect(container.querySelector("[data-roster-unread]")).not.toBeNull();
});

it("shows no attention hint when there is no approval or unread message", () => {
  render(false, false);
  expect(container.querySelector("[data-conversation-attention]")).toBeNull();
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Companion");
});

it("keeps the same single approval hint in the compact row", () => {
  render(true, true, true);
  expect(container.querySelectorAll("[data-conversation-attention]")).toHaveLength(1);
  expect(container.querySelector("[data-roster-preview]")).toBeNull();
  expect(container.querySelector('[role="img"]')).not.toBeNull();
  expect(container.querySelector("button")?.title).toBe("Companion");
});
