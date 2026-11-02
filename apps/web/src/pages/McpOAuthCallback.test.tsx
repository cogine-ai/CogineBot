// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  complete: vi.fn(),
  navigate: vi.fn(),
  post: vi.fn(),
  params: new URLSearchParams("state=session-one&code=fake-code"),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("../lib/rpc", () => ({ rpc: { mcp: { oauth: { complete: api.complete } } } }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => api.navigate,
  useSearchParams: () => [api.params],
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: api.t }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

import { McpOAuthCallbackPage } from "./McpOAuthCallback";

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.complete.mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage = api.post;
      close() {}
    },
  );
  vi.spyOn(window, "close").mockImplementation(() => {});
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  window.name = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["rakazo-mcp-oauth-session-one", "rakazo-mcp-oauth"])(
  "closes the matching %s callback and broadcasts its exact session",
  async (name) => {
    window.name = name;
    await act(async () => root.render(<McpOAuthCallbackPage />));
    expect(api.complete).toHaveBeenCalledWith({
      sessionId: "session-one",
      state: "session-one",
      code: "fake-code",
    });
    expect(api.post).toHaveBeenCalledWith({ type: "mcp-oauth-complete", sessionId: "session-one" });
    expect(window.close).toHaveBeenCalledOnce();
    expect(api.navigate).not.toHaveBeenCalled();
  },
);
it("does not close a different session's named window", async () => {
  window.name = "rakazo-mcp-oauth-session-two";
  await act(async () => root.render(<McpOAuthCallbackPage />));
  expect(window.close).not.toHaveBeenCalled();
  expect(api.navigate).toHaveBeenCalledWith("/app?mcp_oauth=connected", { replace: true });
});
