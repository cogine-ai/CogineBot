import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  GAZE_BOT_COLORS,
  GAZE_SHAPE_KEYS,
  resolveGazeAvatar,
  resolvePersonaColorDef,
} from "@rakazo/core";
import {
  BotAvatar,
  defaultBotAvatarValue,
  GazeShapePreview,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  parseBotAvatar,
} from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface AvatarStudioPopoverProps {
  value: string;
  identity?: string;
  status?: string;
  size?: number;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function AvatarStudioPopover({
  value,
  identity,
  status,
  size = 72,
  onChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bot" | "upload">("bot");
  const [dragOver, setDragOver] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  const imageAttemptRef = useRef(0);
  const identityRef = useRef(identity);
  const openRef = useRef(false);
  identityRef.current = identity;

  function invalidateImageAttempt() {
    imageAttemptRef.current += 1;
    readerRef.current?.abort();
    readerRef.current = null;
  }

  useEffect(() => {
    setOpen(false);
    openRef.current = false;
    setActiveTab("bot");
    setImageError(null);
    return invalidateImageAttempt;
  }, [identity]);

  const parsed = parseBotAvatar(value, identity);
  const currentColor = resolvePersonaColorDef(identity || "companion", parsed.color).hex;
  const currentShape = resolveGazeAvatar(identity || "companion", parsed.shapeIndex).shapeIndex;

  function changeAvatar(next: string) {
    invalidateImageAttempt();
    setImageError(null);
    onChange(next);
  }

  function selectShape(shapeIndex: number) {
    changeAvatar(`${currentColor}::shape_${shapeIndex}`);
  }

  function selectColor(color: string) {
    changeAvatar(`${color}::shape_${currentShape}`);
  }

  function changeOpen(next: boolean) {
    openRef.current = next;
    setOpen(next);
    setDragOver(false);
    setImageError(null);
    if (!next) invalidateImageAttempt();
  }

  function processImageFile(file: File) {
    invalidateImageAttempt();
    setImageError(null);
    if (!imageTypes.has(file.type)) {
      setImageError(t`Choose an image file`);
      return;
    }

    const attempt = imageAttemptRef.current;
    const botIdentity = identity;
    const isCurrent = () =>
      imageAttemptRef.current === attempt && identityRef.current === botIdentity && openRef.current;
    const failed = () => {
      if (isCurrent()) setImageError(t`Could not open image. Try again.`);
    };
    const reader = new FileReader();
    readerRef.current = reader;
    reader.onerror = failed;
    reader.onload = () => {
      if (!isCurrent() || typeof reader.result !== "string") return;
      const image = new Image();
      image.onerror = failed;
      image.onload = () => {
        if (!isCurrent()) return;
        try {
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context || !image.naturalWidth || !image.naturalHeight) {
            failed();
            return;
          }
          canvas.width = canvas.height = 256;
          const side = Math.min(image.naturalWidth, image.naturalHeight);
          context.drawImage(
            image,
            (image.naturalWidth - side) / 2,
            (image.naturalHeight - side) / 2,
            side,
            side,
            0,
            0,
            256,
            256,
          );
          onChange(canvas.toDataURL("image/webp", 0.9));
          changeOpen(false);
        } catch {
          failed();
        }
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (activeTab !== "upload" || disabled) return;
    const file = [...event.clipboardData.items]
      .find((item) => item.type.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    event.preventDefault();
    processImageFile(file);
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        disabled={disabled}
        className="group relative shrink-0 cursor-pointer rounded-full outline-none active:scale-[.98] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        aria-label={t`Customize bot avatar`}
        data-testid="avatar-studio-trigger"
      >
        <span className="block transition-[filter] group-hover:brightness-55 group-focus-visible:brightness-55 group-disabled:brightness-100">
          <BotAvatar
            color={value}
            identity={identity}
            size={size}
            status={open ? undefined : status}
          />
        </span>
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-primary-foreground opacity-0 dark:text-foreground transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0">
          <Pencil size={22} strokeWidth={1.8} aria-hidden />
        </span>
      </PopoverTrigger>
      <PopoverContent
        sideOffset={12}
        className="w-[286px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-2xl p-0"
        data-testid="avatar-studio"
        onPaste={handlePaste}
      >
        <PopoverTitle className="sr-only">
          <Trans>Customize bot avatar</Trans>
        </PopoverTitle>
        <div className="flex items-center gap-1 border-b border-border p-2.5 text-xs">
          {(["bot", "upload"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setActiveTab(tab);
                setImageError(null);
              }}
              aria-pressed={activeTab === tab}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                activeTab === tab
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "bot" ? <Trans>Bot</Trans> : <Trans>Upload</Trans>}
            </button>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => changeAvatar(defaultBotAvatarValue(value))}
            className="ms-auto rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Trans>Reset</Trans>
          </button>
        </div>
        {activeTab === "bot" ? (
          <div className="px-3 pt-4 pb-5" data-testid="avatar-studio-bot-tab">
            <div className="grid grid-cols-5 place-items-center gap-x-1 gap-y-2">
              {GAZE_SHAPE_KEYS.map((shape, shapeIndex) => (
                <GazeShapePreview
                  key={shape}
                  shapeIndex={shapeIndex}
                  identity={identity}
                  color={currentColor}
                  selected={!parsed.isImage && currentShape === shapeIndex}
                  onClick={() => !disabled && selectShape(shapeIndex)}
                />
              ))}
            </div>
            <div className="mt-5 grid grid-cols-5 place-items-center gap-x-1 gap-y-1">
              {GAZE_BOT_COLORS.map((color) => {
                const selected =
                  currentColor.toLowerCase() === color.toLowerCase() && !parsed.isImage;
                return (
                  <button
                    key={color}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectColor(color)}
                    aria-label={t`Color ${color}`}
                    aria-pressed={selected}
                    className={`grid size-9 place-items-center rounded-full border p-1 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${
                      selected ? "border-muted-foreground" : "border-transparent"
                    }`}
                  >
                    <span className="size-6 rounded-full" style={{ backgroundColor: color }} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-3">
            <fieldset
              aria-label={t`Image upload area`}
              onDragOver={(event) => {
                event.preventDefault();
                if (!disabled) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`rounded-xl border border-dashed transition-colors ${
                dragOver ? "border-foreground bg-muted" : "border-border"
              }`}
              data-testid="avatar-studio-drop-zone"
            >
              <div className="flex min-h-[220px] flex-col items-center justify-center gap-4">
                <p className="text-xs text-muted-foreground">
                  <Trans>Drag, drop, or paste an image</Trans>
                </p>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-accent px-3 py-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Trans>Choose image</Trans>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={disabled}
                  className="hidden"
                  aria-label={t`Avatar image`}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) processImageFile(file);
                    event.target.value = "";
                  }}
                />
              </div>
            </fieldset>
            {imageError ? (
              <p role="status" className="mt-3 text-center text-xs text-destructive">
                {imageError}
              </p>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
