import { useLingui } from "@lingui/react/macro";
import { cn, Input } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { errorText } from "../../lib/user-error";

export function GroupTitle({
  name,
  onRename,
  disabled = false,
  className,
}: {
  name: string;
  onRename: (name: string) => Promise<void>;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  async function save() {
    const next = draft.trim();
    if (savingRef.current || !next) return;
    if (next === name) {
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (cause) {
      setError(errorText(cause, t`Could not save group`));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        data-testid="group-title"
        title={`${name} · ${t`Double-click to rename`}`}
        onDoubleClick={() => {
          setDraft(name);
          setError(null);
          setEditing(true);
        }}
        className={cn("app-no-drag min-w-0 truncate text-start text-[16px] font-medium", className)}
        dir="auto"
      >
        {name}
      </button>
    );
  }

  return (
    <div className={cn("app-no-drag relative min-w-0 select-text", className)}>
      <Input
        autoFocus
        data-testid="group-title-input"
        value={draft}
        maxLength={80}
        aria-label={t`Group name`}
        aria-invalid={Boolean(error) || !draft.trim()}
        aria-busy={saving}
        disabled={saving || disabled}
        onFocus={(event) => event.target.select()}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || saving) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
            setError(null);
          } else if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
        className="h-8 text-[16px] font-medium md:text-[16px]"
        dir="auto"
      />
      {error ? (
        <p
          role="alert"
          className="absolute start-0 top-full z-10 mt-1 max-w-72 rounded-lg bg-popover px-2.5 py-1.5 text-xs text-destructive shadow-sm"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
