import type { ComponentProps, KeyboardEvent, RefObject } from "react";
import { forwardRef, useCallback, useLayoutEffect, useRef } from "react";
import { cn } from "./lib/utils.js";

export function isMessageSendKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

type MessageInputProps = ComponentProps<"textarea"> & {
  onSend?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
  getInlineWidth?: () => number;
  inlineActionsRef?: RefObject<HTMLElement | null>;
};

/** Starts at one row and grows with wrapped or explicit lines, up to six visible rows. */
export const MessageInput = forwardRef<HTMLTextAreaElement, MessageInputProps>(
  function MessageInput(
    {
      className,
      style,
      onSend,
      onExpandedChange,
      getInlineWidth,
      inlineActionsRef,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      ...props
    },
    ref,
  ) {
    const composing = useRef(false);
    const input = useRef<HTMLTextAreaElement | null>(null);
    const measurement = useRef<HTMLTextAreaElement | null>(null);
    const reportedExpanded = useRef<boolean | null>(null);
    const setInput = useCallback(
      (element: HTMLTextAreaElement | null) => {
        input.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      },
      [ref],
    );
    const resize = useCallback(() => {
      const element = input.current;
      if (!element || element.clientWidth === 0) return;
      const computed = getComputedStyle(element);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      const padding =
        Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
      const minHeight = lineHeight + padding;
      const maxHeight = lineHeight * 6 + padding;
      element.style.minHeight = `${minHeight}px`;
      element.style.maxHeight = `${maxHeight}px`;
      // Reset before measuring so removing text can shrink the field as well as grow it.
      element.style.height = `${minHeight}px`;
      const contentHeight = element.value.length === 0 ? minHeight : element.scrollHeight;
      const height = Math.max(minHeight, Math.min(contentHeight, maxHeight));
      element.style.height = `${height}px`;
      element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
      let expanded = height > minHeight + 1;
      if (getInlineWidth && element.value.length > 0) {
        const inlineWidth = getInlineWidth();
        if (inlineWidth > 0 && element.parentElement) {
          let probe = measurement.current;
          if (!probe) {
            probe = element.cloneNode(false) as HTMLTextAreaElement;
            for (const name of [
              "id",
              "name",
              "form",
              "role",
              "data-slot",
              "data-testid",
              "aria-label",
              "aria-labelledby",
              "aria-describedby",
              "aria-controls",
              "aria-expanded",
              "aria-autocomplete",
              "placeholder",
            ]) {
              probe.removeAttribute(name);
            }
            probe.setAttribute("aria-hidden", "true");
            probe.tabIndex = -1;
            probe.disabled = true;
            measurement.current = probe;
            element.parentElement.appendChild(probe);
          }
          probe.className = element.className;
          probe.style.cssText = element.style.cssText;
          Object.assign(probe.style, {
            position: "fixed",
            visibility: "hidden",
            pointerEvents: "none",
            top: "0",
            left: "0",
            width: `${inlineWidth}px`,
            height: `${minHeight}px`,
            minHeight: "0",
            maxHeight: "none",
            overflowY: "hidden",
          });
          probe.dir = element.dir;
          probe.value = element.value;
          // Judge expansion against the compact width, even after the visible
          // field fills the entire row. Otherwise borderline text can oscillate.
          expanded = probe.scrollHeight > minHeight + 1;
        } else {
          expanded = element.value.includes("\n");
        }
      }
      if (reportedExpanded.current !== expanded) {
        reportedExpanded.current = expanded;
        onExpandedChange?.(expanded);
      }
    }, [getInlineWidth, onExpandedChange]);

    useLayoutEffect(resize, [resize, props.value, props.defaultValue]);
    useLayoutEffect(
      () => () => {
        measurement.current?.remove();
        measurement.current = null;
      },
      [],
    );
    useLayoutEffect(() => {
      const element = input.current;
      if (!element) return;
      let width = element.clientWidth;
      let inlineWidth = getInlineWidth?.();
      let frame = 0;
      const observer = new ResizeObserver(() => {
        const nextInlineWidth = getInlineWidth?.();
        if (element.clientWidth === width && nextInlineWidth === inlineWidth) return;
        width = element.clientWidth;
        inlineWidth = nextInlineWidth;
        // Height writes during observer delivery can trigger another notification
        // in the same frame. Measure the new width after delivery has finished.
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(resize);
      });
      observer.observe(element);
      if (inlineActionsRef?.current) observer.observe(inlineActionsRef.current);
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
    }, [resize, getInlineWidth, inlineActionsRef]);

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      // Keep IME confirmation out of both parent mention navigation and send handlers.
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && event.shiftKey) return;
      onKeyDown?.(event);
      if (
        !event.defaultPrevented &&
        onSend &&
        isMessageSendKey({
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.keyCode,
        })
      ) {
        event.preventDefault();
        onSend();
      }
    }
    return (
      <textarea
        {...props}
        ref={setInput}
        rows={1}
        wrap="soft"
        data-slot="message-input"
        onChange={(event) => {
          props.onChange?.(event);
          resize();
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onCompositionEnd?.(event);
        }}
        onKeyDown={handleKeyDown}
        style={{ ...style, height: 22, minHeight: 22, maxHeight: 122 }}
        className={cn(
          "box-border min-w-0 flex-1 resize-none overflow-x-hidden overflow-y-hidden whitespace-pre-wrap [overflow-wrap:anywhere] bg-transparent py-px text-[14px] leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-40",
          className,
        )}
      />
    );
  },
);
