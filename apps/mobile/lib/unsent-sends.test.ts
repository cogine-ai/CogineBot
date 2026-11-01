import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  alert: vi.fn(),
  notDelivered: null as null | ((attempt: { error?: string }) => void),
  retry: vi.fn(),
}));
vi.mock("react-native", () => ({ Alert: { alert: state.alert }, AppState: {} }));
vi.mock("./api", () => ({
  captureApiRequestContext: vi.fn(),
  currentApiBase: vi.fn(),
  isServerReachable: vi.fn(),
  rpc: vi.fn(),
  selectedSpaceId: vi.fn(),
  subscribeServerReachable: vi.fn(),
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: vi.fn() }));
vi.mock("./integrations-cache", () => ({ integrationsCacheScope: vi.fn() }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./outbox-disk", () => ({ outboxDisk: {} }));
vi.mock("./session", () => ({
  currentSessionGeneration: vi.fn(),
  loadSessionToken: vi.fn(),
  loadVerifiedIntegrationsScope: vi.fn(),
}));
vi.mock("./user-error", () => ({ errorText: String }));
vi.mock("./thread-feedback", () => ({
  configureUnsentSends: (config: { notDelivered: typeof state.notDelivered }) => {
    state.notDelivered = config.notDelivered;
  },
  restoreUnsentSends: vi.fn(),
  sendWaitingMessages: state.retry,
}));

import "./unsent-sends";

it.each([
  ["platform_model_forbidden", false],
  ["403: platform_model_forbidden", true],
  ["prefix_platform_model_forbidden_suffix", true],
  ["403: forbidden", true],
  [undefined, true],
] as const)(
  "keeps only the exact policy refusal in the scoped recovery notice: %s",
  (error, alert) => {
    state.alert.mockClear();
    state.retry.mockClear();
    state.notDelivered!({ error });
    if (alert) expect(state.alert).toHaveBeenCalledExactlyOnceWith("Failed to send message", error);
    else expect(state.alert).not.toHaveBeenCalled();
    expect(state.retry).not.toHaveBeenCalled();
  },
);
