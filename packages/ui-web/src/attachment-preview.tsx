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
  const type = fileTypes[mimeType];
  const Icon = type?.icon ?? (mimeType.startsWith("image/") ? Image : File);

  return (
    <div
      data-testid="attachment-preview"
      data-kind={showImage ? "image" : "file"}
      title={description ? `${name} · ${description}` : name}
      className={
        description
          ? "group/attachment relative w-20 shrink-0"
          : "group/attachment relative size-12 shrink-0"
      }
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
      {description ? (
        <span className="mt-1 block whitespace-nowrap text-[10px] text-foreground">
          {description}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="absolute start-10 -top-1 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity group-hover/attachment:opacity-100 focus:opacity-100"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
