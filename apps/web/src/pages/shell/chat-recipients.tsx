import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import { BotAvatar, cn, Input, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export function ChatRecipients({
  bots,
  selectedBotIds,
  onSelectedBotIdsChange,
  disabled = false,
}: {
  bots: Bot[];
  selectedBotIds: string[];
  onSelectedBotIdsChange: (botIds: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const triggerId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    // The closing Create menu restores focus before this next frame.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const selected = useMemo(
    () => selectedBotIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []),
    [bots, selectedBotIds],
  );
  const candidates = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return bots.filter(
      (bot) =>
        !bot.archivedAt &&
        !selectedBotIds.includes(bot.id) &&
        (!needle ||
          bot.name.toLocaleLowerCase().includes(needle) ||
          bot.title.toLocaleLowerCase().includes(needle)),
    );
  }, [bots, search, selectedBotIds]);
  const atLimit = selectedBotIds.length >= GROUP_MEMBER_MAX;
  const dropdownOpen =
    open &&
    !disabled &&
    !atLimit &&
    (candidates.length > 0 || Boolean(search.trim()) || selectedBotIds.length === 0);
  const activeBot = candidates[Math.min(activeIndex, Math.max(0, candidates.length - 1))];

  function select(botId: string) {
    if (disabled || atLimit) return;
    onSelectedBotIdsChange([...selectedBotIds, botId]);
    setSearch("");
    setActiveIndex(0);
    setOpen(selectedBotIds.length + 1 < GROUP_MEMBER_MAX);
    inputRef.current?.focus();
  }

  function remove(botId: string) {
    if (disabled) return;
    onSelectedBotIdsChange(selectedBotIds.filter((id) => id !== botId));
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => {
        if (!candidates.length) return 0;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        return open ? (current + direction + candidates.length) % candidates.length : 0;
      });
    } else if (event.key === "Enter" && open && activeBot) {
      event.preventDefault();
      select(activeBot.id);
    } else if (event.key === "Backspace" && !search && selectedBotIds.length) {
      event.preventDefault();
      const lastBotId = selectedBotIds.at(-1);
      if (lastBotId) remove(lastBotId);
    }
  }

  return (
    <div
      className="app-no-drag flex min-w-0 flex-1 flex-wrap select-text items-center gap-1.5 text-[13px]"
      data-testid="chat-recipients"
    >
      <label htmlFor={inputId} className="me-1 shrink-0 text-muted-foreground">
        <Trans>To:</Trans>
      </label>
      {selected.map((bot) => (
        <span
          key={bot.id}
          data-testid={`recipient-chip-${bot.id}`}
          className="inline-flex max-w-52 shrink-0 items-center gap-1.5 rounded-full bg-muted py-1 ps-1.5 pe-1"
        >
          <BotAvatar color={bot.color} identity={bot.id} size={22} status={bot.status} />
          <span className="min-w-0 truncate text-foreground" dir="auto" title={bot.name}>
            {bot.name}
          </span>
          <button
            type="button"
            disabled={disabled}
            aria-label={t`Remove ${bot.name}`}
            title={t`Remove ${bot.name}`}
            onClick={() => remove(bot.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <Popover
        open={dropdownOpen}
        triggerId={triggerId}
        onOpenChange={(next, details) => {
          if (!next && details.reason === "trigger-press") return;
          setOpen(next);
        }}
      >
        <PopoverTrigger
          id={triggerId}
          nativeButton={false}
          role="presentation"
          tabIndex={-1}
          disabled={disabled || atLimit}
          className="min-w-32 flex-1"
          render={<div />}
        >
          <Input
            id={inputId}
            ref={inputRef}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setActiveIndex(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            disabled={disabled || atLimit}
            placeholder={
              disabled || atLimit ? "" : selected.length ? t`Add someone…` : t`Start a chat with…`
            }
            aria-label={t`Recipients`}
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={
              dropdownOpen && activeBot ? `recipient-option-${activeBot.id}` : undefined
            }
            data-testid="recipient-search"
            className="h-8 rounded-none border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-[13px] dark:bg-transparent dark:disabled:bg-transparent"
          />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          initialFocus={false}
          finalFocus={false}
          className="w-[min(520px,calc(100vw-128px))] gap-0 rounded-2xl p-1.5"
        >
          <div id={listId} role="listbox" className="max-h-80 overflow-y-auto">
            {candidates.map((bot, index) => (
              <button
                key={bot.id}
                id={`recipient-option-${bot.id}`}
                data-testid={`recipient-option-${bot.id}`}
                type="button"
                role="option"
                aria-selected={activeBot?.id === bot.id}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => select(bot.id)}
                className={cn(
                  "flex min-h-10 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start text-[13px] transition-colors hover:bg-muted",
                  activeBot?.id === bot.id && "bg-muted",
                )}
              >
                <BotAvatar color={bot.color} identity={bot.id} size={26} status={bot.status} />
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {bot.name}
                </span>
              </button>
            ))}
            {!candidates.length ? (
              <div className="px-3 py-4 text-[13px] text-muted-foreground">
                {search.trim() ? <Trans>No results</Trans> : <Trans>No bots</Trans>}
              </div>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
