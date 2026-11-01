import { BotAvatar, GroupAvatar, type GroupAvatarMember } from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import { LoadingState } from "./primitives";

/** Lightweight peer event shown without exposing the exchanged message body. */
export function CollaborationMarker({
  ariaLabel,
  color,
  identity,
  label,
  peerName,
  status,
  onClick,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  label: string;
  peerName: string;
  status?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex justify-start ps-8">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={ariaLabel}
        onClick={onClick}
        className="inline-flex min-h-8 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg px-0 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <span className="shrink-0">{label}</span>
        <BotAvatar color={color} identity={identity} size={16} />
        <span dir="auto" className="truncate">
          {peerName}
        </span>
        <ChevronRight size={12} strokeWidth={1.5} className="shrink-0" aria-hidden="true" />
        {status ? <span className="basis-full text-start">{status}</span> : null}
      </button>
    </div>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <LoadingState indicator={<GroupAvatar members={bots} size={28} />} label={label} />
    </div>
  );
}
