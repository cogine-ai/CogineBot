// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useDesktopWorkspaceLayout } from "./desktop-workspace-layout";

describe("desktop workspace layout preference", () => {
  it("fits temporarily without replacing stored panel or sidebar preferences", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.setItem("rakazo:right-panel-width", "700");
    window.localStorage.setItem("rakazo:bots-sidebar-collapsed:user-1", "0");
    let current: ReturnType<typeof useDesktopWorkspaceLayout> | undefined;

    function Workspace({ panelOpen }: { panelOpen: boolean }) {
      current = useDesktopWorkspaceLayout({ sidebarCollapsed: false, panelOpen });
      return null;
    }

    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      await act(async () => root.render(<Workspace panelOpen />));
      expect(current?.layout).toMatchObject({ sidebarCollapsed: true, panelWidth: 392 });
      expect(window.localStorage.getItem("rakazo:right-panel-width")).toBe("700");
      expect(window.localStorage.getItem("rakazo:bots-sidebar-collapsed:user-1")).toBe("0");

      await act(async () => root.render(<Workspace panelOpen={false} />));
      expect(current?.layout).toMatchObject({ sidebarCollapsed: false, panelWidth: 0 });

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        root.render(<Workspace panelOpen />);
      });
      expect(current?.layout).toMatchObject({ sidebarCollapsed: false, panelWidth: 700 });

      await act(async () => current?.resizePanel(500));
      expect(window.localStorage.getItem("rakazo:right-panel-width")).toBe("500");
      expect(current?.layout.panelWidth).toBe(500);

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
      await act(async () => window.dispatchEvent(new Event("resize")));
      expect(current?.isDesktop).toBe(false);
      expect(window.localStorage.getItem("rakazo:right-panel-width")).toBe("500");
    } finally {
      await act(async () => root.unmount());
      if (widthDescriptor) Object.defineProperty(window, "innerWidth", widthDescriptor);
      vi.unstubAllGlobals();
      window.localStorage.clear();
    }
  });
});
