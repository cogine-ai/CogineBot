export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  /** Backing behind a link's site icon. White in both themes so dark logos stay visible. */
  faviconPlate: string;
  success: string;
  warning: string;
  statusWorking: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

export const darkTokens = {
  background: "#0B0C0E",
  foreground: "#ECECEE",
  card: "#141518",
  cardForeground: "#ECECEE",
  popover: "#141518",
  popoverForeground: "#ECECEE",
  primary: "#F1F1EF",
  primaryForeground: "#0B0C0E",
  secondary: "#18191E",
  secondaryForeground: "#ECECEE",
  chatUser: "#22242B",
  chatUserForeground: "#ECECEE",
  muted: "#141518",
  mutedForeground: "#85858A",
  accent: "#1A1B20",
  accentForeground: "#ECECEE",
  destructive: "#EF4444",
  destructiveForeground: "#FFFFFF",
  border: "#1E2026",
  input: "#18191E",
  ring: "#3B82F6",
  sidebar: "#111215",
  sidebarForeground: "#ECECEE",
  sidebarBorder: "#1C1D22",
  sidebarAccent: "#1A1B20",
  sidebarAccentForeground: "#ECECEE",
  link: "#3B82F6",
  faviconPlate: "#FFFFFF",
  success: "#4ECB71",
  warning: "#E9C46A",
  statusWorking: "#3B82F6",
  overlay: "rgba(4, 4, 5, 0.72)",
  scrollbar: "#1E2026",
  scrollbarHover: "#2E313A",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FAFAF8",
  foreground: "#1A1A1A",
  card: "#FFFFFF",
  cardForeground: "#1A1A1A",
  popover: "#FFFFFF",
  popoverForeground: "#1A1A1A",
  primary: "#1A1A1A",
  primaryForeground: "#F1F1EF",
  secondary: "#F0F0ED",
  secondaryForeground: "#1A1A1A",
  chatUser: "#E2E2DC",
  chatUserForeground: "#1A1A1A",
  muted: "#F0F0ED",
  mutedForeground: "#6C6C70",
  accent: "#EAEAE6",
  accentForeground: "#1A1A1A",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#F0F0ED",
  input: "#EAEAE6",
  ring: "#6C6C70",
  sidebar: "#F7F7F4",
  sidebarForeground: "#1A1A1A",
  sidebarBorder: "#E8E8E4",
  sidebarAccent: "#E8E9E5",
  sidebarAccentForeground: "#1A1A1A",
  link: "#2563EB",
  faviconPlate: "#FFFFFF",
  success: "#228B3B",
  warning: "#B7791F",
  statusWorking: "#2563EB",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
} as const satisfies ColorTokens;

/** Web states extend the shared palette for the PageKit theme. */
export type WebColorTokens = ColorTokens & {
  destructiveFill: string;
  primaryHover: string;
  primaryDisabled: string;
};

export const webDarkTokens = {
  ...darkTokens,
  destructiveFill: "#E5484D",
  primaryHover: "#DBDBDB",
  primaryDisabled: "#F5F5F521",
} as const satisfies WebColorTokens;

export const webLightTokens = {
  ...lightTokens,
  destructiveFill: "#E5484D",
  primaryHover: "#363636",
  primaryDisabled: "#1C1C1C26",
} as const satisfies WebColorTokens;

/**
 * Bot-built pages: data series and status tones, a step deeper on white. Kept out of tokens.css
 * because only the sandboxed page document uses them, never the app's own chrome.
 */
export const pageKitPalette = {
  dark: {
    c1: "#1084FE",
    c2: "#FF9800",
    c3: "#00BCA6",
    c4: "#69D290",
    c5: "#E76265",
    rest: "#084382",
    area: ".24",
    other: "#777777",
    negative: "#FF263C",
    seq1: "#084382",
    seq2: "#0C64C1",
    seq3: "#1084FE",
    seq4: "#459FFE",
    seq5: "#80BEFE",
    success: "#38D591",
    warning: "#FFAF38",
    danger: "#FF5667",
    accent: "#459FFE",
    accentDeep: "#80befe",
    successDeep: "#78e2b4",
    warningDeep: "#ffc878",
    dangerDeep: "#ff8c98",
    div1: "#FF5667",
    div2: "#82131F",
    div3: "#262626",
    div4: "#084382",
    div5: "#459FFE",
    fillStrong: "rgba(119,119,119,.17)",
    cardSurface: "#181818",
    cardShadowNear: "#0006",
    cardShadowFar: "#0000004d",
    controlFill: "#7777772c",
    controlHoverFill: "#77777747",
    buttonFill: "#fafafa",
    buttonHoverFill: "#d5d5d5",
    buttonInk: "#141414",
    optionFill: "#181818",
    checkedFill: "#5a5a5a",
  },
  light: {
    c1: "#1084FE",
    c2: "#FF9800",
    c3: "#00BCA6",
    c4: "#009957",
    c5: "#C21D2E",
    rest: "#80BEFE",
    area: ".16",
    other: "#777777",
    negative: "#FF263C",
    seq1: "#80BEFE",
    seq2: "#459FFE",
    seq3: "#1084FE",
    seq4: "#0C64C1",
    seq5: "#084382",
    // Tone inks are text too, so on white and on their own tint they hold 4.5:1.
    success: "#006B3C",
    warning: "#8A5100",
    danger: "#B01A2A",
    accent: "#0A58AB",
    accentDeep: "#084382",
    successDeep: "#00673a",
    warningDeep: "#824e00",
    dangerDeep: "#82131f",
    div1: "#C21D2E",
    div2: "#FF8C98",
    div3: "#E8E8E8",
    div4: "#80BEFE",
    div5: "#0C64C1",
    fillStrong: "rgba(119,119,119,.11)",
    cardSurface: "#fcfcfc",
    cardShadowNear: "#0000000f",
    cardShadowFar: "#00000012",
    controlFill: "#77777717",
    controlHoverFill: "#77777726",
    buttonFill: "#070707",
    buttonHoverFill: "#2f2f2f",
    buttonInk: "#fcfcfc",
    optionFill: "#fcfcfc",
    checkedFill: "#a5a5a5",
  },
  // The same in both themes: ink on colour, the print paper and shadows.
  shared: {
    onColor: "#fcfcfc",
    onTone: "#121212",
    onDeepTone: "#fff",
    paper: "#fff",
    mask: "#000",
    tipShadow: "rgba(0,0,0,.18)",
    dotShadow: "#00000059",
  },
} as const;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

/** Companion artwork colors stay fixed across themes to preserve identity. */
export const GAZE_INK_COLOR = "#18252D";
export const GAZE_BOT_COLORS = [
  "#F5A15D",
  "#62A8EC",
  "#A78BE4",
  "#56C4B7",
  "#E88EB1",
  "#9BA5AE",
  "#EF6E65",
  "#E4C05D",
] as const;

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof WebColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: WebColorTokens) {
  const lines = (Object.keys(palette) as (keyof WebColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @rakazo/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", webDarkTokens),
    renderBlock('[data-theme="light"]', "light", webLightTokens),
  ].join("\n\n")}\n`;
}
