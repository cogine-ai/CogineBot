// @vitest-environment jsdom
import { LOCAL_SETTINGS_PAGE, LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { selectSpace } from "./rpc";
import { SpaceRpcProvider } from "./space-rpc";
import { useModelOAuthSignIn } from "./use-model-oauth-signin";

type Hook = ReturnType<typeof useModelOAuthSignIn>;
const login = {
  loginId: "login-b",
  mode: "auth-url",
  verificationUri: "https://auth.example.test",
  expiresInSeconds: 600,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.replaceChildren();
  delete window.rakazoDesktop;
  window.history.replaceState({}, "", "/");
});
async function fixture(
  options: { held?: boolean; bound?: boolean; selected?: string | null; local?: boolean } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (options.selected !== null)
    localStorage.setItem("rakazo:space-id", options.selected ?? "space-a");
  vi.spyOn(window, "open").mockReturnValue(null);
  const calls: Array<{
    path: string;
    space: string | null;
    input: unknown;
    signal: AbortSignal | undefined | null;
  }> = [];
  const pending = deferred<unknown>();
  let hold = options.held ?? false;
  let failCancel = false;
  let hook!: Hook;
  const finished = vi.fn();
  const errors = vi.fn();
  async function reply(
    path: string,
    input: unknown,
    space: string | null,
    signal?: AbortSignal | null,
  ) {
    calls.push({ path, space, input, signal });
    if (path.endsWith("cancelOAuth") && failCancel) throw new Error("Cancel failed");
    if (path.endsWith("beginOAuth")) return hold ? await pending.promise : login;
    if (path.endsWith("completeOAuth")) return { status: "ready" };
    if (path.endsWith("finishOAuth"))
      return { id: "credential-b", provider: "subscription", connectionRevision: 1 };
    return { ok: true };
  }
  const fetch = vi.fn(async (request: Request, init?: RequestInit) => {
    const body = await request.text();
    return Response.json({
      json: await reply(
        new URL(request.url).pathname,
        body ? JSON.parse(body).json : undefined,
        new Headers(init?.headers).get("x-rakazo-space-id"),
        init?.signal,
      ),
    });
  });
  vi.stubGlobal("fetch", fetch);
  if (options.local) {
    window.history.replaceState({}, "", LOCAL_SETTINGS_PAGE);
    window.rakazoDesktop = {
      localSettings: {
        request: async (path: string, body: string) => ({
          status: 200,
          body: JSON.stringify({ json: await reply(path, JSON.parse(body).json, null) }),
        }),
      },
    } as never;
  }
  function Probe() {
    const value = useModelOAuthSignIn({ onFinished: finished, onError: errors });
    useLayoutEffect(() => {
      hook = value;
    });
    return <p>{value.oauth?.loginId ?? "No login"}</p>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  async function render(space = "space-b", owner = "user/session-a") {
    const child: ReactNode = <Probe />;
    await act(async () =>
      root.render(
        options.bound === false ? (
          <div key={owner}>{child}</div>
        ) : (
          <SpaceRpcProvider key={`${space}/${owner}`} spaceId={space} ownerKey={owner}>
            {child}
          </SpaceRpcProvider>
        ),
      ),
    );
  }
  await render();
  return {
    calls,
    finished,
    errors,
    container,
    fetch,
    pending,
    render,
    unhold: () => {
      hold = false;
    },
    failCancel: () => {
      failCancel = true;
    },
    get hook() {
      return hook;
    },
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
it("cancels a known login on its original Space after the Provider is revoked", async () => {
  const h = await fixture();
  try {
    await act(async () => h.hook.startSubscriptionSignIn({ provider: "subscription" }));
    const original = h.hook;
    await h.render("space-c");
    await act(async () => original.submitOAuthCode("stale-code"));
    expect(h.calls.filter((call) => call.path.endsWith("cancelOAuth"))).toEqual([
      expect.objectContaining({
        space: "space-b",
        input: { loginId: "login-b" },
        signal: undefined,
      }),
    ]);
    expect(h.container.textContent).toBe("No login");
    expect(h.errors).not.toHaveBeenCalled();
    expect(h.finished).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("cancels a late known login after target replacement without publishing it or continuing sign-in", async () => {
  const h = await fixture({ held: true });
  try {
    let begin!: Promise<void>;
    await act(async () => {
      begin = h.hook.startSubscriptionSignIn({ provider: "subscription" });
    });
    await h.render("space-c");
    await act(async () => {
      h.pending.resolve(login);
      await begin;
    });
    expect(h.calls.map((call) => [call.path, call.space])).toEqual([
      ["/rpc/models/beginOAuth", "space-b"],
      ["/rpc/models/cancelOAuth", "space-b"],
    ]);
    expect(h.container.textContent).toBe("No login");
    expect(h.errors).not.toHaveBeenCalled();
    expect(h.finished).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("does not revive an old attempt when the same target and owner return after ABA", async () => {
  const h = await fixture({ held: true });
  try {
    let begin!: Promise<void>;
    await act(async () => {
      begin = h.hook.startSubscriptionSignIn({ provider: "subscription" });
    });
    await h.render("space-b", "user/session-b");
    await h.render("space-b", "user/session-a");
    await act(async () => {
      h.pending.resolve(login);
      await begin;
    });
    expect(h.calls.filter((call) => call.path.endsWith("cancelOAuth"))).toEqual([
      expect.objectContaining({ space: "space-b", input: { loginId: "login-b" } }),
    ]);
    expect(h.container.textContent).toBe("No login");
    expect(h.finished).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it.each(["space-a", null])(
  "captures an unbound selected/default header %s for cleanup",
  async (selected) => {
    const h = await fixture({ bound: false, selected });
    try {
      await act(async () => h.hook.startSubscriptionSignIn({ provider: "subscription" }));
      selectSpace("space-c");
      await act(async () => h.hook.cancelOAuthAttempt());
      expect(h.calls.map((call) => [call.path, call.space])).toEqual([
        ["/rpc/models/beginOAuth", selected],
        ["/rpc/models/cancelOAuth", selected],
      ]);
    } finally {
      await h.close();
    }
  },
);
it("uses its captured client for submit, polling and finish", async () => {
  const h = await fixture();
  try {
    await act(async () => h.hook.startSubscriptionSignIn({ provider: "subscription" }));
    await act(async () => h.hook.submitOAuthCode("synthetic-code"));
    expect(h.calls.map((call) => [call.path, call.space])).toEqual(
      ["beginOAuth", "submitOAuthCode", "completeOAuth", "finishOAuth"].map((path) => [
        `/rpc/models/${path}`,
        "space-b",
      ]),
    );
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(h.errors).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("contains cleanup rejection without a stale UI error or unmount exception", async () => {
  const h = await fixture();
  try {
    await act(async () => h.hook.startSubscriptionSignIn({ provider: "subscription" }));
    h.failCancel();
    await h.render("space-c");
    expect(h.calls.filter((call) => call.path.endsWith("cancelOAuth"))).toHaveLength(1);
    expect(h.errors).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("keeps cleanup on the existing desktop local settings bridge", async () => {
  const h = await fixture({ bound: false, selected: null, local: true });
  try {
    await act(async () => h.hook.startSubscriptionSignIn({ provider: "subscription" }));
    await act(async () => h.hook.cancelOAuthAttempt());
    expect(h.calls.map((call) => call.path)).toEqual([
      `${LOCAL_SETTINGS_RPC}/models/beginOAuth`,
      `${LOCAL_SETTINGS_RPC}/models/cancelOAuth`,
    ]);
    expect(h.fetch).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("does not let a late cancelled begin unlock or clear a newer attempt", async () => {
  const h = await fixture({ held: true });
  try {
    let old!: Promise<void>;
    await act(async () => {
      old = h.hook.startSubscriptionSignIn({ provider: "subscription" });
    });
    await act(async () => h.hook.cancelOAuthAttempt());
    h.unhold();
    await act(async () => h.hook.startSubscriptionSignIn({ provider: "subscription" }));
    await act(async () => {
      h.pending.resolve({ ...login, loginId: "login-old" });
      await old;
    });
    expect(h.container.textContent).toBe("login-b");
    expect(h.hook.oauthPending).toBe(true);
    expect(h.calls.filter((call) => call.path.endsWith("cancelOAuth"))).toEqual([
      expect.objectContaining({ space: "space-b", input: { loginId: "login-old" } }),
    ]);
    expect(h.finished).not.toHaveBeenCalled();
    expect(h.errors).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
