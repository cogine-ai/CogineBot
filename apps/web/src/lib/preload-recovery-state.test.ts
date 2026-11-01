import { afterEach, describe, expect, it } from "vitest";
import {
  consumePreloadRecoverySnapshot,
  currentPreloadRecoverySnapshot,
  PRELOAD_RECOVERY_STATE_KEY,
  preparePreloadRecoverySnapshot,
  readPreloadRecoverySnapshot,
  registerPreloadRecoverySnapshot,
} from "./preload-recovery-state";

const scope = { apiOrigin: "https://app.example.test", accountId: "user-1", spaceId: "space-1" };
const snapshot = {
  ...scope,
  version: 1 as const,
  overlayKind: "settings" as const,
  targetId: "space:space-2",
  section: "models" as const,
};
function storage(value: unknown, recovery = true) {
  const values = new Map([[PRELOAD_RECOVERY_STATE_KEY, JSON.stringify(value)]]);
  if (recovery) values.set("rk:preload-recovery", "1");
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
  };
}
afterEach(() => {
  registerPreloadRecoverySnapshot(null, () => false);
});

describe("preload recovery panel positions", () => {
  it("consumes a verified safe snapshot only once and preserves its selected settings Space", () => {
    const saved = storage(snapshot);
    preparePreloadRecoverySnapshot(saved);
    expect(saved.values.has(PRELOAD_RECOVERY_STATE_KEY)).toBe(false);
    expect(consumePreloadRecoverySnapshot(scope)).toEqual(snapshot);
    expect(consumePreloadRecoverySnapshot(scope)).toBeNull();
  });
  it.each([
    { ...scope, accountId: "other" },
    { ...scope, spaceId: "other" },
    { ...scope, apiOrigin: "https://other.example.test" },
  ])("discards a snapshot at an identity boundary", (other) => {
    preparePreloadRecoverySnapshot(storage(snapshot));
    expect(consumePreloadRecoverySnapshot(other)).toBeNull();
    expect(consumePreloadRecoverySnapshot(scope)).toBeNull();
  });
  it.each([
    { ...snapshot, version: 2 },
    { ...snapshot, overlayKind: "create" },
    { ...snapshot, overlayKind: "confirmation" },
    { ...snapshot, overlayKind: "peerConversation" },
    { ...snapshot, section: "password" },
    { ...snapshot, key: "fake-private-value" },
    { ...snapshot, draft: "never persist an editor" },
    { ...snapshot, apiOrigin: "https://user:fake-secret@app.example.test" },
    { ...snapshot, targetId: "/app?secret=fake" },
    { ...snapshot, overlayKind: "mcp", section: "models" },
    [],
    null,
  ])("rejects damaged, sensitive or executable state", (value) => {
    const saved = storage(value);
    expect(readPreloadRecoverySnapshot(saved)).toBeNull();
    expect(saved.values.has(PRELOAD_RECOVERY_STATE_KEY)).toBe(false);
  });
  it("does not recover a snapshot from an ordinary visit", () => {
    preparePreloadRecoverySnapshot(storage(snapshot, false));
    expect(consumePreloadRecoverySnapshot(scope)).toBeNull();
  });
  it("captures immutable fields only while their editor binding is current", () => {
    let current = true;
    const value = { ...snapshot };
    const cleanup = registerPreloadRecoverySnapshot(value, () => current);
    value.targetId = "space:other";
    expect(currentPreloadRecoverySnapshot()?.targetId).toBe("space:space-2");
    current = false;
    expect(currentPreloadRecoverySnapshot()).toBeNull();
    const next = registerPreloadRecoverySnapshot(snapshot, () => true);
    cleanup();
    expect(currentPreloadRecoverySnapshot()).toEqual(snapshot);
    next();
    expect(currentPreloadRecoverySnapshot()).toBeNull();
  });
  it("ignores malformed and unreadable storage", () => {
    const bad = storage(snapshot);
    bad.values.set(PRELOAD_RECOVERY_STATE_KEY, "{");
    expect(readPreloadRecoverySnapshot(bad)).toBeNull();
    expect(
      readPreloadRecoverySnapshot({
        getItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {},
      }),
    ).toBeNull();
  });
});

it("restores the collaboration settings position without persisting a policy draft", () => {
  const value = { ...snapshot, section: "collaboration" as const };
  preparePreloadRecoverySnapshot(storage(value));
  expect(consumePreloadRecoverySnapshot(scope)).toEqual(value);
  expect(
    readPreloadRecoverySnapshot(storage({ ...value, allowBotCollaboration: false })),
  ).toBeNull();
});
