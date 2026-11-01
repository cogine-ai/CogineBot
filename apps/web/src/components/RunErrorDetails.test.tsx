// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RunErrorDetails } from "./RunErrorDetails";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../lib/run-error", () => ({ translateRunError: (message: string) => message }));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shows computer retry advice without model connection actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<RunErrorDetails error="Too many computer requests. Try again later." />),
    );
    expect(container.textContent).toContain("Too many computer requests. Try again later.");
    expect(container.textContent).not.toContain("model provider");
    expect(container.querySelector("a")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["subscription_sharing_usage_limit_exceeded", true],
  ["insufficient_quota", false],
  ["rate_limit_exceeded", false],
])("offers the fixed ChatGPT usage action only for scoped code %s", async (code, expected) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <RunErrorDetails
          error={JSON.stringify({ error: { code, message: "https://untrusted.example/usage" } })}
        />,
      ),
    );
    const link = container.querySelector("a");
    if (expected) {
      expect(link?.textContent).toBe("Manage usage");
      expect(link?.getAttribute("href")).toBe("https://chatgpt.com/settings/usage");
      expect(link?.getAttribute("rel")).toBe("noreferrer");
    } else {
      expect(link).toBeNull();
    }
    expect(container.querySelector('a[href="https://untrusted.example/usage"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("opens the supplied model settings action once without sending or following diagnostics", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const addKey = vi.fn();
  try {
    await act(async () =>
      root.render(<RunErrorDetails error="platform_model_forbidden" onAddKey={addKey} />),
    );
    expect(container.textContent).toContain("Add your own API key to continue.");
    const action = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add API key",
    );
    expect(action).toBeDefined();
    expect(addKey).not.toHaveBeenCalled();
    await act(async () => action!.click());
    expect(addKey).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")).toBeNull();
    await act(async () =>
      root.render(<RunErrorDetails error="403: forbidden" onAddKey={addKey} />),
    );
    expect(container.textContent).not.toContain("Add API key");
    await act(async () => root.render(<RunErrorDetails error="platform_model_forbidden" />));
    expect(container.textContent).not.toContain("Add API key");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
