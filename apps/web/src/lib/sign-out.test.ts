import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn(), getSession: vi.fn(), refetch: vi.fn() }));
vi.mock("./auth", () => ({
  authClient: {
    signOut: auth.signOut,
    getSession: auth.getSession,
    $store: { atoms: { session: { get: () => ({ refetch: auth.refetch }) } } },
  },
}));

import { signOut } from "./sign-out";

afterEach(() => {
  vi.resetAllMocks();
});
it("does not claim logout when the auth request resolves with an error", async () => {
  auth.signOut.mockResolvedValue({ error: { status: 500 } });
  expect(await signOut()).toBe(false);
  expect(auth.getSession).not.toHaveBeenCalled();
});
it("does not clear routing when the server still reports a session", async () => {
  auth.signOut.mockResolvedValue({});
  auth.getSession.mockResolvedValue({ data: { user: { id: "user-new" } } });
  expect(await signOut()).toBe(false);
  expect(auth.refetch).not.toHaveBeenCalled();
});
it("verifies server session absence before refreshing shared auth", async () => {
  auth.signOut.mockResolvedValue({});
  auth.getSession.mockResolvedValue({ data: null });
  auth.refetch.mockResolvedValue(undefined);
  expect(await signOut()).toBe(true);
  expect(auth.getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
  expect(auth.refetch).toHaveBeenCalledOnce();
});
