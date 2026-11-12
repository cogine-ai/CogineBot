/** Adapted for bounded Bot identity fields, in OpenClaw's order of preference. */
const DESCRIPTION_LABELS = ["theme", "creature", "vibe"] as const;
const UNUSED_LABELS = { emoji: "Emoji", avatar: "Avatar" } as const;
/** The hints OpenClaw's template leaves in place of a value. */
const PLACEHOLDERS = new Set([
  "not set yet",
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

/** `- Label: value` lines; labels case-insensitive and possibly bold, placeholders ignored. */
export function parseOpenClawIdentity(content: string): {
  name?: string;
  description?: string;
  unused: string[];
} {
  const fields = new Map<string, string>();
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const cleaned = line
      .trim()
      .replace(/^-\s*/, "")
      .replace(/^([*_`]+)([A-Za-z]+):\1/, "$2:");
    const colon = cleaned.indexOf(":");
    if (colon <= 0) continue;
    const label = cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase();
    if (
      label !== "name" &&
      !DESCRIPTION_LABELS.some((field) => field === label) &&
      !Object.hasOwn(UNUSED_LABELS, label)
    )
      continue;
    if (fields.has(label)) continue;
    const value = identityValue(cleaned.slice(colon + 1));
    if (value) fields.set(label, value);
  }
  const description = DESCRIPTION_LABELS.map((label) => fields.get(label)).find(Boolean);
  return {
    ...(fields.get("name") ? { name: fields.get("name") } : {}),
    ...(description ? { description } : {}),
    unused: Object.entries(UNUSED_LABELS).flatMap(([label, title]) =>
      fields.has(label) ? [title] : [],
    ),
  };
}

function identityValue(raw: string): string {
  let value = raw.trim();
  if (value.length > 2_000) return "";
  while (value.length > 2) {
    const marker = value[0];
    if (marker !== "*" && marker !== "_" && marker !== "`") break;
    let start = 1;
    while (value[start] === marker) start++;
    let end = value.length;
    while (end > start && value[end - 1] === marker) end--;
    const width = Math.min(start, value.length - end, marker === "`" ? start : 2);
    if (!width) break;
    value = value.slice(width, -width).trim();
  }
  let hint = value;
  if (hint.startsWith("(") && hint.endsWith(")")) hint = hint.slice(1, -1).trim();
  hint = hint
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!value || PLACEHOLDERS.has(hint) || /^\(.*\)$/.test(value)) return "";
  return value.replace(/\s+/g, " ");
}
