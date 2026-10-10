import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export type AvatarStyle = "robot" | "organic";

const AvatarStyleContext = createContext<AvatarStyle>("robot");
const PortraitDefaultsContext = createContext(false);

export function AvatarStyleProvider({
  children,
  value,
  portraitDefaults = false,
}: {
  children: ReactNode;
  value: AvatarStyle;
  portraitDefaults?: boolean;
}) {
  return (
    <AvatarStyleContext value={value}>
      <PortraitDefaultsContext value={portraitDefaults}>{children}</PortraitDefaultsContext>
    </AvatarStyleContext>
  );
}

export function useAvatarStyle(): AvatarStyle {
  return useContext(AvatarStyleContext);
}

export function usePortraitDefaults(): boolean {
  return useContext(PortraitDefaultsContext);
}
