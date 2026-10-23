import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rakazo/ui-web";
import { useLayoutEffect, useRef, useState } from "react";

/** A compact settings choice using the shared keyboard and focus behavior. */
export function ListboxSelect<T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
  className = "",
  disabled = false,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  testId?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tabbingOutRef = useRef(false);
  const restoreTriggerRef = useRef(false);
  useLayoutEffect(() => {
    if (!open && restoreTriggerRef.current) {
      restoreTriggerRef.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [open]);
  return (
    <div className={className}>
      <Select
        value={value}
        items={options}
        disabled={disabled}
        open={open}
        onOpenChange={(next, details) => {
          restoreTriggerRef.current =
            !next && (details.reason === "escape-key" || details.reason === "item-press");
          if (next) tabbingOutRef.current = false;
          setOpen(next);
        }}
        onValueChange={(next) => {
          if (disabled) return;
          const option = options.find((entry) => entry.value === next);
          if (option) onChange(option.value);
        }}
      >
        <SelectTrigger
          ref={triggerRef}
          aria-label={label}
          data-testid={testId}
          className="h-9 w-full px-3"
          onKeyDown={(event) => {
            // The popup can paint before its queued initial focus reaches an item.
            if (event.key === "Tab" && open) {
              tabbingOutRef.current = true;
              setOpen(false);
            }
          }}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          aria-label={label}
          align="start"
          alignItemWithTrigger={false}
          finalFocus={!tabbingOutRef.current}
        >
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
