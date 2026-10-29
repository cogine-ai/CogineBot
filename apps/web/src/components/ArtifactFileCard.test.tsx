// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ArtifactFileCard } from "./ArtifactFileCard";

const api = vi.hoisted(() => ({ download: vi.fn(async () => {}) }));
vi.mock("../lib/artifact-open", () => ({ downloadArtifact: api.download }));
vi.mock("./PdfViewer", () => ({ PdfViewer: () => null }));
vi.mock("./SandboxedHtmlViewer", () => ({ SandboxedHtmlViewer: () => null }));
vi.mock("@rakazo/chat-ui/web", () => ({ ChatMarkdown: () => null }));
vi.mock("@rakazo/ui-web", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? children : null),
  Button: () => null,
  DialogContent: () => null,
  DialogTitle: () => null,
  DialogClose: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

describe("duplicate artifact identities", () => {
  it.each(["application/pdf", "text/plain"])(
    "preserves a separate visible identity and exact download target for %s",
    async (mimeType) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      container.style.width = "320px";
      const root = createRoot(container);
      const name = `${"同名👩‍👩‍👧‍👦".repeat(20)}.pdf`;
      api.download.mockClear();
      try {
        await act(async () =>
          root.render(
            <ArtifactFileCard
              target={{ botId: "bot" }}
              artifactId="artifact-second"
              name={name}
              description="2 · 10 MiB"
              mimeType={mimeType}
              size={10_485_760}
            />,
          ),
        );
        const identity = [...container.querySelectorAll("span, div")].find(
          (element) => element.textContent === "2 · 10 MiB",
        )!;
        expect(identity).toBeDefined();
        expect(identity.closest(".truncate")).toBeNull();
        expect(identity.className).toContain("wrap-anywhere");
        const download =
          mimeType === "application/pdf"
            ? container.querySelector<HTMLButtonElement>('button[title^="Download"]')!
            : container.querySelector<HTMLButtonElement>("button")!;
        if (mimeType === "application/pdf")
          expect(download.getAttribute("aria-describedby")).toBe(identity.id);
        await act(async () => download.click());
        expect(api.download).toHaveBeenCalledExactlyOnceWith(
          { botId: "bot" },
          "artifact-second",
          name,
          mimeType,
        );
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});
