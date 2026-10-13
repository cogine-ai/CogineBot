import type { ReactNode } from "react";

export function MessageHoverMetadata({
  side,
  pinned = false,
  children,
}: {
  side: "start" | "end";
  pinned?: boolean;
  children: ReactNode;
}) {
  // Narrow chats and touch put the rail below the bubble instead of consuming its side margin.
  const reveal = pinned
    ? "pointer-events-auto opacity-100"
    : "pointer-events-auto opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-within:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100";

  return (
    <div
      data-testid="message-hover-rail"
      className={`absolute top-1/2 z-10 flex -translate-y-1/2 items-center transition-opacity ${reveal} ${
        side === "end" ? "start-full ms-1" : "end-full me-1"
      } @max-[800px]/chat:static @max-[800px]/chat:mt-1 @max-[800px]/chat:w-full @max-[800px]/chat:translate-y-0 [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:w-full [@media(hover:none)]:translate-y-0 ${
        side === "end"
          ? "@max-[800px]/chat:ms-0 @max-[800px]/chat:justify-start [@media(hover:none)]:ms-0 [@media(hover:none)]:justify-start"
          : "@max-[800px]/chat:me-0 @max-[800px]/chat:justify-end [@media(hover:none)]:me-0 [@media(hover:none)]:justify-end"
      }`}
    >
      {children}
    </div>
  );
}
