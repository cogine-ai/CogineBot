import { cn } from "./lib/utils.js";
import { accountPortraitUrl } from "./portrait-assets.js";

export function AccountAvatar({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex overflow-hidden rounded-full select-none", className)}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        flex: "none",
        aspectRatio: "1",
      }}
    >
      <img
        src={accountPortraitUrl}
        alt=""
        draggable={false}
        className="block h-full w-full object-cover"
      />
    </span>
  );
}
