// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

vi.mock("@lingui/core/macro", () => ({ t: String.raw }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => children,
}));

it("names the approved site and preserves the exact Always answer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const answer = vi.fn(async () => {});
  const block: AskBlock = {
    kind: "ask",
    text: "Open this URL?",
    status: "pending",
    approvalEffectId: "effect-1",
    site: "example.com",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ],
  };
  await act(async () => root.render(<AskCard block={block} canAnswer onAnswer={answer} />));
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Always allow example.com",
  );
  expect(button).toBeDefined();
  expect(container.textContent).not.toContain("Always allow this tool");
  await act(async () => button!.click());
  expect(answer).toHaveBeenCalledWith("always", undefined);
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
