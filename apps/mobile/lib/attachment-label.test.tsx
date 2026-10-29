// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AttachmentLabel } from "../components/attachment-label";

const rendered = vi.hoisted(() => ({
  text: [] as Array<{
    children?: ReactNode;
    numberOfLines?: number;
    ellipsizeMode?: string;
    style?: unknown;
  }>,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: (props: (typeof rendered.text)[number]) => {
    rendered.text.push(props);
    return <span>{props.children}</span>;
  },
  StyleSheet: { create: (styles: unknown) => styles },
}));

describe("duplicate attachment labels in narrow native rows", () => {
  it("keeps the identity on a separate unlimited line while only the long filename truncates", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    container.style.width = "140px";
    container.style.fontSize = "264.3%";
    const root = createRoot(container);
    const name = `${"同名家庭 👩‍👩‍👧‍👦 ".repeat(12)}.pdf`;
    rendered.text = [];
    try {
      await act(async () =>
        root.render(<AttachmentLabel name={name} description="2 · 10 MiB" color="inherit" />),
      );
      expect(container.textContent).toBe(`${name}2 · 10 MiB`);
      const filename = rendered.text.find((props) => props.children === name)!;
      const identity = rendered.text.find((props) => props.children === "2 · 10 MiB")!;
      expect(filename.numberOfLines).toBe(1);
      expect(filename.ellipsizeMode).toBe("middle");
      expect(identity.numberOfLines).toBeUndefined();
      expect(identity.ellipsizeMode).toBeUndefined();
      // Assert native layout constraints; jsdom does not simulate physical font layout.
      expect(identity.style).toContainEqual({ fontSize: 15, flexShrink: 1 });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
