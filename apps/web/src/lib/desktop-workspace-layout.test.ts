import { describe, expect, it } from "vitest";
import { calculateDesktopWorkspaceLayout, clampPanelPreference } from "./desktop-workspace-layout";

describe("desktop workspace pane budget", () => {
  it.each([
    { viewportWidth: 800, sidebarCollapsed: true, sidebarWidth: 88, chatWidth: 328 },
    { viewportWidth: 1024, sidebarCollapsed: false, sidebarWidth: 280, chatWidth: 360 },
    { viewportWidth: 1280, sidebarCollapsed: false, sidebarWidth: 280, chatWidth: 616 },
  ])("fits a default panel at $viewportWidth px", (expected) => {
    const layout = calculateDesktopWorkspaceLayout({
      viewportWidth: expected.viewportWidth,
      sidebarCollapsed: false,
      panelOpen: true,
    });
    expect(layout).toMatchObject({
      sidebarCollapsed: expected.sidebarCollapsed,
      sidebarWidth: expected.sidebarWidth,
      panelWidth: 384,
      panelOverlay: false,
      chatWidth: expected.chatWidth,
    });
    expect(layout.sidebarWidth + layout.chatWidth + layout.panelWidth).toBe(expected.viewportWidth);
  });

  it("shrinks a wide panel before temporarily compacting the sidebar", () => {
    const expanded = calculateDesktopWorkspaceLayout({
      viewportWidth: 920,
      sidebarCollapsed: false,
      panelOpen: true,
      preferredPanelWidth: 700,
    });
    expect(expanded).toMatchObject({
      sidebarCollapsed: false,
      panelWidth: 320,
      chatWidth: 320,
      panelOverlay: false,
    });

    const compact = calculateDesktopWorkspaceLayout({
      viewportWidth: 919,
      sidebarCollapsed: false,
      panelOpen: true,
      preferredPanelWidth: 700,
    });
    expect(compact).toMatchObject({
      sidebarCollapsed: true,
      sidebarWidth: 88,
      panelWidth: 511,
      chatWidth: 320,
      panelOverlay: false,
    });
  });

  it("overlays the panel within the content area when even a compact rail cannot fit all panes", () => {
    const layout = calculateDesktopWorkspaceLayout({
      viewportWidth: 700,
      sidebarCollapsed: false,
      panelOpen: true,
      preferredPanelWidth: 800,
    });
    expect(layout).toMatchObject({
      sidebarCollapsed: true,
      sidebarWidth: 88,
      panelOverlay: true,
      panelWidth: 612,
      chatWidth: 612,
    });
    expect(layout.sidebarWidth + layout.panelWidth).toBe(700);
  });

  it("never forces a panel minimum wider than the remaining content area", () => {
    const layout = calculateDesktopWorkspaceLayout({
      viewportWidth: 360,
      sidebarCollapsed: false,
      panelOpen: true,
    });
    expect(layout.panelOverlay).toBe(true);
    expect(layout.sidebarWidth).toBe(88);
    expect(layout.panelMinWidth).toBe(272);
    expect(layout.panelWidth).toBe(272);
    expect(layout.sidebarWidth + layout.panelWidth).toBe(360);
  });

  it("restores the requested expanded sidebar when closing the panel or widening the window", () => {
    const preference = { sidebarCollapsed: false, preferredPanelWidth: 700 };
    expect(
      calculateDesktopWorkspaceLayout({ ...preference, viewportWidth: 800, panelOpen: true })
        .sidebarCollapsed,
    ).toBe(true);
    expect(
      calculateDesktopWorkspaceLayout({ ...preference, viewportWidth: 800, panelOpen: false }),
    ).toMatchObject({ sidebarCollapsed: false, sidebarWidth: 280, panelWidth: 0, chatWidth: 520 });
    expect(
      calculateDesktopWorkspaceLayout({ ...preference, viewportWidth: 1400, panelOpen: true }),
    ).toMatchObject({ sidebarCollapsed: false, panelWidth: 700, chatWidth: 420 });
  });

  it("keeps a requested compact sidebar even when all panes fit", () => {
    expect(
      calculateDesktopWorkspaceLayout({
        viewportWidth: 1280,
        sidebarCollapsed: true,
        panelOpen: false,
      }),
    ).toMatchObject({ sidebarCollapsed: true, sidebarWidth: 88, panelWidth: 0, chatWidth: 1192 });
  });

  it("bounds invalid or out-of-range panel preferences", () => {
    expect(clampPanelPreference(Number.NaN)).toBe(384);
    expect(clampPanelPreference(0)).toBe(320);
    expect(clampPanelPreference(2000)).toBe(1000);
  });
});
