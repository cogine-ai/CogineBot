import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rakazo/ui-web";

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
  return (
    <div className={className}>
      <Select
        value={value}
        items={options}
        disabled={disabled}
        onValueChange={(next) => {
          if (disabled) return;
          const option = options.find((entry) => entry.value === next);
          if (option) onChange(option.value);
        }}
      >
        <SelectTrigger aria-label={label} data-testid={testId} className="h-9 w-full px-3">
          <SelectValue />
        </SelectTrigger>
        <SelectContent aria-label={label} align="start" alignItemWithTrigger={false}>
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
