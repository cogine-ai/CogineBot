import { useCallback, useEffect, useState } from "react";

export const DESKTOP_SIDEBAR_WIDTH = 280;
export const COMPACT_SIDEBAR_WIDTH = 88;
export const MIN_CHAT_WIDTH = 320;
export const MIN_PANEL_WIDTH = 320;
export const DEFAULT_PANEL_WIDTH = 384;
export const MAX_PANEL_WIDTH = 1000;
const PANEL_WIDTH_STORAGE_KEY = "rakazo:right-panel-width";

export type DesktopWorkspaceLayout = {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  panelWidth: number;
  panelMinWidth: number;
  panelMaxWidth: number;
  panelOverlay: boolean;
  chatWidth: number;
};

export function clampPanelPreference(width: number): number {
  return Math.max(
    MIN_PANEL_WIDTH,
    Math.min(MAX_PANEL_WIDTH, Number.isFinite(width) ? width : DEFAULT_PANEL_WIDTH),
  );
}

/** Budget the whole workspace before applying any individual pane minimum. */
export function calculateDesktopWorkspaceLayout({
  viewportWidth,
  sidebarCollapsed,
  panelOpen,
  preferredPanelWidth = DEFAULT_PANEL_WIDTH,
}: {
  viewportWidth: number;
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  preferredPanelWidth?: number;
}): DesktopWorkspaceLayout {
  const viewport = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const requestedSidebarWidth = sidebarCollapsed ? COMPACT_SIDEBAR_WIDTH : DESKTOP_SIDEBAR_WIDTH;
  const requiredContentWidth = MIN_CHAT_WIDTH + (panelOpen ? MIN_PANEL_WIDTH : 0);
  const effectiveCollapsed =
    sidebarCollapsed || viewport - requestedSidebarWidth < requiredContentWidth;
  const sidebarWidth = effectiveCollapsed ? COMPACT_SIDEBAR_WIDTH : DESKTOP_SIDEBAR_WIDTH;
  const contentWidth = Math.max(0, viewport - sidebarWidth);
  const panelOverlay = panelOpen && contentWidth < MIN_CHAT_WIDTH + MIN_PANEL_WIDTH;
  const panelMaxWidth = Math.min(
    MAX_PANEL_WIDTH,
    Math.max(0, panelOverlay ? contentWidth : contentWidth - MIN_CHAT_WIDTH),
  );
  const panelMinWidth = Math.min(MIN_PANEL_WIDTH, panelMaxWidth);
  const panelWidth = panelOpen
    ? Math.max(panelMinWidth, Math.min(panelMaxWidth, clampPanelPreference(preferredPanelWidth)))
    : 0;

  return {
    sidebarCollapsed: effectiveCollapsed,
    sidebarWidth,
    panelWidth,
    panelMinWidth,
    panelMaxWidth,
    panelOverlay,
    chatWidth: Math.max(0, contentWidth - (panelOverlay ? 0 : panelWidth)),
  };
}

function readPreferredPanelWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
    if (saved >= MIN_PANEL_WIDTH) return clampPanelPreference(saved);
  } catch {
    // Storage may be disabled; resizing still works in memory.
  }
  return DEFAULT_PANEL_WIDTH;
}

/** Responsive fitting never changes the user's stored sidebar or panel preference. */
export function useDesktopWorkspaceLayout({
  sidebarCollapsed,
  panelOpen,
}: {
  sidebarCollapsed: boolean;
  panelOpen: boolean;
}) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [preferredPanelWidth, setPreferredPanelWidth] = useState(readPreferredPanelWidth);
  const layout = calculateDesktopWorkspaceLayout({
    viewportWidth,
    sidebarCollapsed,
    panelOpen,
    preferredPanelWidth,
  });

  useEffect(() => {
    function syncViewport() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(preferredPanelWidth));
    } catch {
      // Storage may be disabled; resizing still works in memory.
    }
  }, [preferredPanelWidth]);

  const resizePanel = useCallback(
    (next: number) => {
      setPreferredPanelWidth(clampPanelPreference(Math.min(layout.panelMaxWidth, next)));
    },
    [layout.panelMaxWidth],
  );

  return { layout, resizePanel, isDesktop: viewportWidth >= 768 };
}
