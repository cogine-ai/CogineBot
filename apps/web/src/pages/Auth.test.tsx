// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { clearSpaceSelection } from "../lib/rpc";
import { AuthPage } from "./Auth";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant,
    size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button data-variant={variant ?? "default"} data-size={size} {...props}>
      {children}
    </button>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { social: vi.fn(async () => ({})), email: vi.fn(async () => ({})) },
    signUp: { email: vi.fn(async () => ({})) },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
const capabilities: AuthCapabilities = {
  passwordAuth: false,
  sso: { name: "Example", availability: "unavailable" },
  passwordReset: false,
  resetUrl: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete window.rakazoDesktop;
});
async function render(mode: "in" | "up" | "forgot" = "in", path = "/sign-in") {
  await act(async () =>
    root.render(
      <MemoryRouter key={path} initialEntries={[path]}>
        <AuthPage mode={mode} />
      </MemoryRouter>,
    ),
  );
}
it("retains the same native attempt after an SSO cancellation or error and retry", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockResolvedValue({
    data: null,
    error: { message: "Cancelled", status: 400, statusText: "Bad Request" },
  });
  const kickoff = `/api/connectors/oauth/start?state=${"a".repeat(43)}`;
  const signIn = `/sign-in?next=${encodeURIComponent(kickoff)}`;
  for (const path of [signIn, `${signIn}&error=access_denied`]) {
    await render("in", path);
    const sso = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Continue with"),
    )!;
    await act(async () => sso.click());
    expect(authClient.signIn.social).toHaveBeenLastCalledWith(
      expect.objectContaining({ callbackURL: kickoff, errorCallbackURL: signIn }),
    );
  }
  expect(authClient.signIn.social).toHaveBeenCalledTimes(2);
});
it("shows no credential form while capabilities load", async () => {
  vi.mocked(fetchAuthCapabilities).mockReturnValue(new Promise(() => undefined));
  await render();
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Loading…");
});
it.each(["in", "up"] as const)("offers SSO and hides credentials on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render(mode);
  expect(host.textContent).toContain("Continue with Example");
  expect(host.querySelector("input")).toBeNull();
  const sso = host.querySelector("button")!;
  expect(sso.dataset.variant).toBe("default");
  expect(sso.className).toContain("w-full");
});
it("retries failed capabilities without exposing a password form", async () => {
  vi.mocked(fetchAuthCapabilities)
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(capabilities);
  await render();
  expect(host.textContent).toContain("Could not load sign-in options");
  expect(host.querySelector("input")).toBeNull();
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(fetchAuthCapabilities).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Continue with Example");
});
it.each(["in", "up"] as const)("puts quiet SSO below the primary action on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render(mode);
  const email = host.querySelector('input[name="email"]')!;
  const password = host.querySelector('input[type="password"]')!;
  const submit = host.querySelector('button[type="submit"]')!;
  const sso = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Continue with Example",
  )!;
  for (const [first, second] of [
    [email, password],
    [password, submit],
    [submit, sso],
  ] as const) {
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(submit.getAttribute("data-variant")).toBe("default");
  expect(sso.dataset.variant).toBe("link");
  expect(sso.dataset.size).toBe("sm");
});

it("hides SSO in password recovery", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render("forgot");
  expect(host.textContent).not.toContain("Continue with Example");
});

it("selects a non-redirecting SSO request on desktop", async () => {
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  window.rakazoDesktop = {} as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockResolvedValue({
    data: null,
    error: { message: "Unavailable", status: 503, statusText: "Unavailable" },
  });
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(authClient.signIn.social).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "oidc", disableRedirect: true }),
  );
});

it("keeps SSO available for retry while an authorization request is pending", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockReturnValue(new Promise(() => undefined));
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  )!;
  await act(async () => button.click());
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(authClient.signIn.social).toHaveBeenCalledTimes(2);
});

it.each([
  { mode: "in" as const, native: false },
  { mode: "in" as const, native: true },
  { mode: "up" as const, native: true },
])(
  "keeps the original Space only for Native email sign-in, not ordinary login/signup: %j",
  async ({ mode, native }) => {
    const storageKey = "rakazo:space-id";
    window.localStorage.setItem(storageKey, "space-original");
    vi.mocked(clearSpaceSelection).mockImplementation(() => {
      window.localStorage.removeItem(storageKey);
    });
    vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: { user: { id: "original-user" } },
      error: null,
    } as never);
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      data: { user: { id: "new-user" } },
      error: null,
    } as never);
    const destination = `/api/connectors/oauth/start?state=${"a".repeat(43)}`;
    const path = mode === "in" ? "/sign-in" : "/sign-up";
    await render(mode, native ? `${path}?next=${encodeURIComponent(destination)}` : path);
    for (const [name, value] of [
      ["email", "fixture@example.test"],
      ["password", "fixture-password"],
    ]) {
      const input = host.querySelector(`input[name="${name}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mode === "in" ? authClient.signIn.email : authClient.signUp.email).toHaveBeenCalledTimes(
      1,
    );
    if (native && mode === "in") {
      expect(window.localStorage.getItem(storageKey)).toBe("space-original");
      expect(clearSpaceSelection).not.toHaveBeenCalled();
    } else {
      expect(window.localStorage.getItem(storageKey)).toBeNull();
      expect(clearSpaceSelection).toHaveBeenCalledOnce();
    }
    vi.mocked(clearSpaceSelection).mockReset();
    window.localStorage.removeItem(storageKey);
  },
);
