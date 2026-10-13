import { useLingui } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

type ConversationRowProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  avatar: ReactNode;
  name: string;
  preview: string;
  compact: boolean;
  selected: boolean;
  unread: boolean;
  approvalPending?: boolean;
  bot?: boolean;
};

/** Bot and group conversations share the same navigation presentation. */
export function ConversationRow({
  avatar,
  name,
  preview,
  compact,
  selected,
  unread,
  approvalPending,
  bot,
  className,
  ...buttonProps
}: ConversationRowProps) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      {...buttonProps}
      aria-label={
        approvalPending ? t`${name} (approval pending)` : unread ? t`${name} (unread)` : name
      }
      aria-current={selected ? "page" : undefined}
      title={compact ? name : undefined}
      data-sidebar-compact={compact ? "true" : "false"}
      className={cn(
        "flex w-full items-center rounded-xl text-start transition-colors hover:bg-sidebar-accent",
        compact ? "min-h-14 justify-center py-2" : "min-h-16 gap-3 px-2 py-2.5",
        selected && "bg-sidebar-accent",
        className,
      )}
    >
      <span className="relative flex size-10 shrink-0 items-center justify-center">
        {avatar}
        {approvalPending || unread ? (
          <span
            data-conversation-attention={approvalPending ? "approval" : "unread"}
            data-roster-unread={approvalPending ? undefined : ""}
            aria-hidden="true"
            className={cn(
              "absolute end-0.5 bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
              approvalPending ? "bg-warning" : "bg-link",
            )}
          />
        ) : null}
      </span>
      {!compact ? (
        <span className="min-w-0 flex-1">
          <span
            data-roster-bot-name={bot ? "" : undefined}
            dir="auto"
            className="block truncate text-[13px] font-medium text-sidebar-foreground"
          >
            {name}
          </span>
          <span
            data-roster-preview
            dir="auto"
            className="mt-0.5 block truncate text-[11.5px] font-normal text-muted-foreground"
          >
            {preview || "\u00a0"}
          </span>
        </span>
      ) : null}
    </button>
  );
}
