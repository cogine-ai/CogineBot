import { t } from "@lingui/core/macro";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import type { DesktopWorkspaceLayout } from "../lib/desktop-workspace-layout";

export function ResizableSidePanel({
  open,
  panel,
  layout,
  onWidthChange,
  children,
}: {
  open: boolean;
  panel: string;
  layout: DesktopWorkspaceLayout;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; direction: number } | null>(null);
  const width = layout.panelWidth;

  function stopDrag(event: PointerEvent<HTMLHRElement>) {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <aside
      data-testid="side-panel"
      data-panel={panel}
      data-panel-overlay={layout.panelOverlay ? "true" : "false"}
      style={{ "--panel-width": `${width}px` } as CSSProperties}
      className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-background ${layout.panelOverlay ? "shadow-xl" : "md:relative"} ${dragging ? "" : "transition-[width] duration-150 ease-out"} ${open ? "w-full max-w-[384px] border-s border-sidebar-border md:w-(--panel-width) md:max-w-none" : "pointer-events-none w-0"}`}
    >
      {open ? (
        <hr
          tabIndex={0}
          aria-label={t`Resize panel`}
          aria-orientation="vertical"
          aria-valuemin={layout.panelMinWidth}
          aria-valuemax={layout.panelMaxWidth}
          aria-valuenow={Math.round(width)}
          className="absolute inset-y-0 start-0 z-30 m-0 hidden h-full w-2 touch-none cursor-col-resize border-0 bg-transparent hover:bg-border focus-visible:bg-border focus-visible:outline-none md:block"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              width,
              direction: document.documentElement.dir === "rtl" ? -1 : 1,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (drag.current)
              onWidthChange(
                drag.current.width + (drag.current.x - event.clientX) * drag.current.direction,
              );
          }}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            const direction = document.documentElement.dir === "rtl" ? -1 : 1;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onWidthChange(width + (event.key === "ArrowLeft" ? 32 : -32) * direction);
            } else if (event.key === "Home") {
              event.preventDefault();
              onWidthChange(layout.panelMinWidth);
            } else if (event.key === "End") {
              event.preventDefault();
              onWidthChange(layout.panelMaxWidth);
            }
          }}
        />
      ) : null}
      {children}
    </aside>
  );
}
