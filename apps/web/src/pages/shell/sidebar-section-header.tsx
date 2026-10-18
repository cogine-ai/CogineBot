import { cn } from "@rakazo/ui-web";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

export type SidebarSectionHeaderProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "onClick" | "title"
> & {
  title: string;
  count: number;
  collapsed: boolean;
  collapsible?: boolean;
  onToggle: () => void;
};

export function SidebarSectionHeader({
  title,
  count,
  collapsed,
  collapsible = true,
  onToggle,
  className,
  ...buttonProps
}: SidebarSectionHeaderProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      {...buttonProps}
      aria-expanded={collapsible ? !collapsed : undefined}
      aria-label={
        buttonProps["aria-label"] ?? (collapsible && collapsed ? `${title}, ${count}` : title)
      }
      data-sidebar-section-header
      className={cn(
        "group/section-header flex h-8 w-full items-center gap-2 rounded-lg px-2 text-start text-xs font-normal text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={onToggle}
    >
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {collapsible ? (
        <span
          data-sidebar-section-indicator
          aria-hidden="true"
          className="relative flex size-6 shrink-0 items-center justify-center"
        >
          {collapsed ? (
            <span
              data-sidebar-section-count
              className="absolute inset-0 flex items-center justify-center tabular-nums group-hover/section-header:opacity-0 group-focus-visible/section-header:opacity-0"
            >
              {count}
            </span>
          ) : null}
          <Chevron
            data-sidebar-section-chevron
            className={cn(
              "size-3.5 opacity-0 group-hover/section-header:opacity-100 group-focus-visible/section-header:opacity-100",
              collapsed && "rtl:rotate-180",
            )}
          />
        </span>
      ) : null}
    </button>
  );
}
