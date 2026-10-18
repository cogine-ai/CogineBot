import { useLingui } from "@lingui/react/macro";
import { BotSectionNameSchema } from "@rakazo/contracts";
import { Input } from "@rakazo/ui-web";
import { useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";

export type InlineSectionNameProps = {
  defaultValue?: string;
  onConfirm: (name: string) => Promise<void>;
  onCancel: () => void;
  existingNames?: readonly string[];
  reservedNames?: readonly string[];
};

export function InlineSectionName({
  defaultValue = "",
  onConfirm,
  onCancel,
  existingNames = [],
  reservedNames = [],
}: InlineSectionNameProps) {
  const { t } = useLingui();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const completedRef = useRef(false);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState(defaultValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    if (pendingRef.current || completedRef.current) return;
    completedRef.current = true;
    onCancel();
  }

  function showError(message: string) {
    setError(message);
    inputRef.current?.focus();
  }

  async function save() {
    if (pendingRef.current || completedRef.current || composingRef.current) return;
    const name = draft.trim();
    if (!name) {
      showError(t`Section name is required`);
      return;
    }
    if (name === defaultValue.trim()) {
      cancel();
      return;
    }
    if (!BotSectionNameSchema.safeParse(name).success) {
      showError(
        name.length > 60
          ? t`Section names can be up to 60 characters`
          : t`Choose another group name`,
      );
      return;
    }
    const normalized = name.toLowerCase();
    if (
      [t`Unassigned`, ...reservedNames].some((value) => value.trim().toLowerCase() === normalized)
    ) {
      showError(t`Choose another group name`);
      return;
    }
    if (existingNames.some((value) => value.trim().toLowerCase() === normalized)) {
      showError(t`A section with this name already exists`);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm(name);
      completedRef.current = true;
    } catch (cause) {
      showError(errorText(cause, t`Could not save section`));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="relative min-w-0 px-1">
      <Input
        ref={inputRef}
        autoFocus
        dir="auto"
        value={draft}
        maxLength={60}
        aria-label={t`Section name`}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        aria-busy={pending}
        readOnly={pending}
        onFocus={(event) => event.target.select()}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onBlur={() => {
          if (!defaultValue.trim() && !draft.trim()) cancel();
          else void save();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current)
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          } else if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }
        }}
        className="h-8 text-xs md:text-xs"
      />
      {error ? (
        <p id={errorId} role="alert" className="px-1 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
