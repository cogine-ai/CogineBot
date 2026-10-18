import type { MouseEvent, PointerEvent } from "react";
import { useEffect, useRef } from "react";
import type { ContextMenuPosition } from "../BotContextMenu";

/** Adds the touch equivalent of right-click without intercepting scrolling or mouse dragging. */
export function useContextPress<T extends HTMLElement>(
  onOpen: (element: T, position: ContextMenuPosition) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  function clear() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pointerRef.current = null;
  }

  useEffect(() => clear, []);

  return {
    onPointerDown(event: PointerEvent<T>) {
      clear();
      suppressClickRef.current = false;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const element = event.currentTarget;
      const position = { x: event.clientX, y: event.clientY };
      pointerRef.current = { id: event.pointerId, ...position };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        suppressClickRef.current = true;
        onOpenRef.current(element, position);
      }, 500);
    },
    onPointerMove(event: PointerEvent<T>) {
      const pointer = pointerRef.current;
      if (
        pointer?.id === event.pointerId &&
        Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10
      ) {
        clear();
      }
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClickCapture(event: MouseEvent<T>) {
      if (!suppressClickRef.current || event.detail === 0) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
