export const PRELOAD_RECOVERY_STATE_KEY = "rk:preload-recovery-state";
const sections = [
  "general",
  "models",
  "memory",
  "voice",
  "confirmations",
  "collaboration",
  "usage",
  "computer",
  "billing",
  "updates",
] as const;
const overlayKinds = ["settings", "messaging", "plugins", "mcp"] as const;
const snapshotKeys = [
  "version",
  "apiOrigin",
  "accountId",
  "spaceId",
  "overlayKind",
  "targetId",
  "section",
];
const id = /^[A-Za-z0-9_-]{1,200}$/;

export type PreloadRecoverySnapshot = {
  version: 1;
  apiOrigin: string;
  accountId: string;
  spaceId: string;
  overlayKind: (typeof overlayKinds)[number];
  targetId: string;
  section: (typeof sections)[number] | null;
};
export type PreloadRecoveryScope = Pick<
  PreloadRecoverySnapshot,
  "apiOrigin" | "accountId" | "spaceId"
>;
let restored: PreloadRecoverySnapshot | null = null;
let active: { snapshot: PreloadRecoverySnapshot; isCurrent: () => boolean } | null = null;

/** A closed runtime schema: unrecognized fields and non-panel targets are rejected. */
function parseSnapshot(value: unknown): PreloadRecoverySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== snapshotKeys.length ||
    Object.keys(record).some((key) => !snapshotKeys.includes(key))
  )
    return null;
  if (
    record.version !== 1 ||
    typeof record.apiOrigin !== "string" ||
    record.apiOrigin.length > 320 ||
    typeof record.accountId !== "string" ||
    !id.test(record.accountId) ||
    typeof record.spaceId !== "string" ||
    !id.test(record.spaceId) ||
    typeof record.overlayKind !== "string" ||
    !overlayKinds.includes(record.overlayKind as PreloadRecoverySnapshot["overlayKind"]) ||
    typeof record.targetId !== "string" ||
    !/^(?:bot|group|space):[A-Za-z0-9_-]{1,200}$/.test(record.targetId) ||
    !(record.section === null || sections.includes(record.section as (typeof sections)[number])) ||
    (record.overlayKind !== "settings" && record.section !== null)
  )
    return null;
  try {
    const url = new URL(record.apiOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== record.apiOrigin) return null;
  } catch {
    return null;
  }
  return {
    version: 1,
    apiOrigin: record.apiOrigin,
    accountId: record.accountId,
    spaceId: record.spaceId,
    overlayKind: record.overlayKind as PreloadRecoverySnapshot["overlayKind"],
    targetId: record.targetId,
    section: record.section as PreloadRecoverySnapshot["section"],
  };
}

/** Recovery state contains panel positions only. Reading always consumes the saved value. */
export function readPreloadRecoverySnapshot(storage: Pick<Storage, "getItem" | "removeItem">) {
  try {
    const raw = storage.getItem(PRELOAD_RECOVERY_STATE_KEY);
    storage.removeItem(PRELOAD_RECOVERY_STATE_KEY);
    if (!raw || raw.length > 2048) return null;
    return parseSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function preparePreloadRecoverySnapshot(storage: Pick<Storage, "getItem" | "removeItem">) {
  const snapshot = readPreloadRecoverySnapshot(storage);
  try {
    restored = storage.getItem("rk:preload-recovery") ? snapshot : null;
  } catch {
    restored = null;
  }
}

/** Called only once an account and its current Space have been verified. */
export function consumePreloadRecoverySnapshot(scope: PreloadRecoveryScope) {
  const snapshot = restored;
  restored = null;
  return snapshot &&
    snapshot.apiOrigin === scope.apiOrigin &&
    snapshot.accountId === scope.accountId &&
    snapshot.spaceId === scope.spaceId
    ? snapshot
    : null;
}

export function registerPreloadRecoverySnapshot(
  snapshot: PreloadRecoverySnapshot | null,
  isCurrent: () => boolean,
) {
  const parsed = parseSnapshot(snapshot);
  const registration = parsed ? { snapshot: parsed, isCurrent } : null;
  active = registration;
  return () => {
    if (active === registration) active = null;
  };
}

export function currentPreloadRecoverySnapshot(): PreloadRecoverySnapshot | null {
  return active?.isCurrent() ? active.snapshot : null;
}
