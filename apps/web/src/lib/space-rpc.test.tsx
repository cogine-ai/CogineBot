// @vitest-environment jsdom
import type { ReactNode } from "react";
import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { selectSpace } from "./rpc";
import { SpaceRpcProvider, useBoundSpaceId, useSpaceRpc, useSpaceRpcCurrent } from "./space-rpc";

const sessions: Array<{
  client: ReturnType<typeof useSpaceRpc>;
  current: () => boolean;
  target: string | null;
}> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.length = 0;
  localStorage.clear();
});
function Probe({ children }: { children?: ReactNode }) {
  const client = useSpaceRpc();
  const current = useSpaceRpcCurrent();
  const target = useBoundSpaceId();
  useLayoutEffect(() => {
    sessions.push({ client, current, target });
  }, [client, current, target]);
  return (
    <div>
      {target}
      {children}
    </div>
  );
}
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("rakazo:space-id", "space-a");
  const sent: Array<string | null> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_request: Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("x-rakazo-space-id"));
      return Response.json({ json: {} });
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (spaceId = "space-b", ownerKey = "account-a/session-1") => {
    await act(async () =>
      root.render(
        <React.Suspense>
          <SpaceRpcProvider spaceId={spaceId} ownerKey={ownerKey}>
            <Probe />
          </SpaceRpcProvider>
        </React.Suspense>,
      ),
    );
  };
  await render();
  return {
    root,
    container,
    sent,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
it("keeps the target independent of the conversation and invalidates old target/session callbacks", async () => {
  const h = await setup();
  try {
    const first = sessions.at(-1)!;
    expect(first.current()).toBe(true);
    expect(first.target).toBe("space-b");
    await first.client.me();
    expect(h.sent).toEqual(["space-b"]);
    expect(localStorage.getItem("rakazo:space-id")).toBe("space-a");
    await h.render("space-c");
    expect(first.current()).toBe(false);
    await expect(first.client.me()).rejects.toThrow();
    await h.render("space-b");
    expect(first.current()).toBe(false);
    await sessions.at(-1)!.client.me();
    const second = sessions.at(-1)!;
    await h.render("space-b", "account-a/session-2");
    expect(second.current()).toBe(false);
    await expect(second.client.me()).rejects.toThrow();
    expect(h.sent).toEqual(["space-b", "space-b"]);
  } finally {
    await h.close();
  }
});
it("rejects origin selection ABA and unmount without adopting a new global owner", async () => {
  const h = await setup();
  const first = sessions.at(-1)!;
  try {
    selectSpace("space-c");
    selectSpace("space-a");
    expect(first.current()).toBe(false);
    await expect(first.client.me()).rejects.toThrow();
    expect(h.sent).toEqual([]);
  } finally {
    await h.close();
  }
  expect(first.current()).toBe(false);
});
it("does not authorize a suspended replacement render before commit", async () => {
  const h = await setup();
  const first = sessions.at(-1)!;
  const held = new Promise<void>(() => undefined);
  function Suspend(): never {
    throw held;
  }
  try {
    await act(async () =>
      React.startTransition(() =>
        h.root.render(
          <React.Suspense>
            <SpaceRpcProvider spaceId="space-c" ownerKey="account-a/session-1">
              <Probe>
                <Suspend />
              </Probe>
            </SpaceRpcProvider>
          </React.Suspense>,
        ),
      ),
    );
    expect(first.current()).toBe(true);
    await first.client.me();
    expect(h.sent).toEqual(["space-b"]);
  } finally {
    await h.close();
  }
});
