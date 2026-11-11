import type { LucideIcon } from "lucide-react";
import { Code2, File, FileText, Image, Table2, X } from "lucide-react";
import { useState } from "react";

const fileTypes: Record<string, { label: string; icon: LucideIcon }> = {
  "application/pdf": { label: "PDF", icon: FileText },
  "text/plain": { label: "TXT", icon: FileText },
  "text/markdown": { label: "MD", icon: FileText },
  "text/csv": { label: "CSV", icon: Table2 },
  "text/html": { label: "HTML", icon: Code2 },
  "application/json": { label: "JSON", icon: Code2 },
};

type AttachmentPreviewProps = {
  name: string;
  description?: string;
  mimeType: string;
  previewUrl?: string;
  removeLabel: string;
  onRemove: () => void;
};

export function AttachmentPreview({
  name,
  description,
  mimeType,
  previewUrl,
  removeLabel,
  onRemove,
}: AttachmentPreviewProps) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const showImage = previewUrl && failedPreviewUrl !== previewUrl;
  const caption = mimeType.startsWith("image/")
    ? [name, description].filter(Boolean).join(" · ")
    : description;
  const type = fileTypes[mimeType];
  const Icon = type?.icon ?? (mimeType.startsWith("image/") ? Image : File);

  return (
    <div
      data-testid="attachment-preview"
      data-kind={showImage ? "image" : "file"}
      title={description ? `${name} · ${description}` : name}
      className={caption ? "relative w-28 shrink-0" : "relative size-12 shrink-0"}
    >
      <div className="flex size-12 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[12px] border border-border bg-background text-muted-foreground">
        {showImage ? (
          <img
            src={previewUrl}
            alt={name}
            width={48}
            height={48}
            onError={() => setFailedPreviewUrl(previewUrl)}
            className="size-full object-cover"
          />
        ) : (
          <>
            <Icon size={19} strokeWidth={1.6} aria-hidden="true" />
            {type ? (
              <span className="text-[9px] font-medium leading-3 tracking-wide">{type.label}</span>
            ) : null}
          </>
        )}
      </div>
      {caption ? (
        <span className="mt-1 block break-words text-xs text-foreground">{caption}</span>
      ) : null}
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="absolute start-7 -top-4 grid size-11 place-items-center text-primary-foreground"
      >
        <span className="grid size-5 place-items-center rounded-full bg-primary shadow-sm">
          <X size={11} strokeWidth={2} />
        </span>
      </button>
    </div>
  );
}
