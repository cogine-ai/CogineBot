import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { BotAvatar, Button, Input } from "@rakazo/ui-web";
import { Check, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/user-error";
import { DeleteItemDialog } from "./shell/dialogs";

function validSelection(name: string, selected: readonly string[]) {
  return (
    Boolean(name.trim()) &&
    selected.length >= GROUP_MEMBER_MIN &&
    selected.length <= GROUP_MEMBER_MAX
  );
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function MemberPicker({
  bots,
  selected,
  onChange,
  maxHeight,
  disabled,
}: {
  bots: Bot[];
  selected: string[];
  onChange: (selected: string[]) => void;
  maxHeight: "max-h-[240px]" | "max-h-[280px]";
  disabled: boolean;
}) {
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  function toggle(botId: string) {
    if (disabled) return;
    if (selected.includes(botId)) {
      onChange(selected.filter((id) => id !== botId));
    } else if (selected.length < GROUP_MEMBER_MAX) {
      onChange([...selected, botId]);
    }
  }

  return (
    <div className={`mt-2 ${maxHeight} space-y-1 overflow-y-auto`}>
      {selectable.map((bot) => {
        const checked = selected.includes(bot.id);
        return (
          <button
            key={bot.id}
            type="button"
            aria-pressed={checked}
            disabled={disabled}
            onClick={() => toggle(bot.id)}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start ${
              checked ? "bg-muted" : "hover:bg-accent"
            }`}
          >
            <BotAvatar color={bot.color} identity={bot.id} size={32} status={bot.status} />
            <span className="flex-1 text-[15px] text-foreground" dir="auto">
              {bot.name}
            </span>
            {checked ? <Check size={14} className="text-muted-foreground" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function GroupSettings({
  group,
  bots,
  onSave,
  onRemove,
  onClose,
  covered = false,
}: {
  group: Group;
  bots: Bot[];
  onSave: (input: { name?: string; botIds?: string[] }) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
  covered?: boolean;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (covered || confirmingDelete) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        !containerRef.current?.contains(document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, covered, confirmingDelete]);

  async function mutate(kind: "save" | "remove", action: () => Promise<void>) {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await action();
      if (kind === "save" && mountedRef.current) onClose();
    } catch (cause) {
      if (mountedRef.current) {
        setError(
          errorText(cause, kind === "save" ? t`Could not save group` : t`Could not remove group`),
        );
      }
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }

  function save() {
    return onSave({
      name: name.trim() !== group.name ? name.trim() : undefined,
      botIds: sameMembers(
        selected,
        group.members.map((member) => member.botId),
      )
        ? undefined
        : selected,
    });
  }

  return (
    <div ref={containerRef}>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          disabled={pending !== null}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[240px]"
        disabled={pending !== null}
      />
      <Button
        className="mt-5 w-full"
        disabled={pending !== null || !validSelection(name, selected)}
        onClick={() => void mutate("save", save)}
      >
        {pending === "save" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
      <Button
        variant="destructive"
        className="mt-4 w-full"
        disabled={pending !== null}
        onClick={() => setConfirmingDelete(true)}
      >
        {pending === "remove" ? <Trans>Deleting…</Trans> : <Trans>Delete group</Trans>}
      </Button>
      {confirmingDelete ? (
        <DeleteItemDialog
          item={group}
          noun="group"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onRemove}
        />
      ) : null}
    </div>
  );
}

export function memberName(
  members: Group["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}
