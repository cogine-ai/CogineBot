// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { PagesProvider, usePageDetail, usePagesForChat } from "./pages";
import { selectSpace, synchronizeRpcSession } from "./rpc";

const requests = vi.hoisted(() =>
  vi.fn(async () => ({ id: "page-1", code: "Private page ready" })),
);
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("./rpc", async (original) => ({
  ...(await original<typeof import("./rpc")>()),
  createSpaceRpc: () => ({ pages: { get: requests } }),
}));

it("reads a private page after the parent commits a session over a persisted Space", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  selectSpace("space-1");
  synchronizeRpcSession("anonymous");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  function Reader() {
    const page = usePageDetail("page-1");
    return <p>{page.data?.code ?? "Loading"}</p>;
  }
  function Pages() {
    const pages = usePagesForChat("owner-a:space-1:chat-1", "space-1");
    return (
      <PagesProvider value={pages}>
        <Reader />
      </PagesProvider>
    );
  }
  function Owner() {
    useLayoutEffect(() => {
      synchronizeRpcSession("authenticated", "owner-a", "session-a");
    }, []);
    return <Pages />;
  }
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Owner />
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toBe("Private page ready");
  expect(requests).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps a drawn private page during a same-page focus refresh, then hides it on a denied read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.mockClear();
  selectSpace("space-1");
  synchronizeRpcSession("authenticated", "owner-a", "session-a");
  let rejectRefresh!: (error: Error) => void;
  requests.mockResolvedValueOnce({ id: "page-1", code: "Private page ready" });
  requests.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
  );
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  function Reader() {
    const page = usePageDetail("page-1");
    return <p>{page.error ? "Read denied" : (page.data?.code ?? "Loading")}</p>;
  }
  function Owner() {
    const pages = usePagesForChat("owner-a:space-1:chat-1", "space-1");
    return (
      <PagesProvider value={pages}>
        <Reader />
      </PagesProvider>
    );
  }
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <Owner />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toBe("Private page ready");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(requests).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Private page ready");
    await act(async () => rejectRefresh(new Error("FORBIDDEN")));
    expect(container.textContent).toBe("Read denied");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["page", "version", "account", "space"] as const)(
  "hides the old page on a %s change and ignores its late refresh",
  async (change) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    requests.mockClear();
    selectSpace("space-1");
    synchronizeRpcSession("authenticated", "owner-a", "session-a");
    let finishOld!: (value: { id: string; code: string }) => void;
    let finishNew!: (value: { id: string; code: string }) => void;
    requests.mockResolvedValueOnce({ id: "page-1", code: "Private page ready" });
    requests.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    requests.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    function Reader({ changed }: { changed: boolean }) {
      const page = usePageDetail(
        changed && change === "page" ? "page-2" : "page-1",
        changed && change === "version" ? 2 : undefined,
      );
      return <p>{page.data?.code ?? "Loading"}</p>;
    }
    function Owner({ changed }: { changed: boolean }) {
      const owner = changed && change === "account" ? "owner-b" : "owner-a";
      const space = changed && change === "space" ? "space-2" : "space-1";
      useLayoutEffect(() => {
        selectSpace(space);
        synchronizeRpcSession(
          "authenticated",
          owner,
          owner === "owner-a" ? "session-a" : "session-b",
        );
      }, [owner, space]);
      const pages = usePagesForChat(`${owner}:${space}:chat-1`, space);
      return (
        <PagesProvider value={pages}>
          <Reader changed={changed} />
        </PagesProvider>
      );
    }
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <Owner changed={false} />
          </MemoryRouter>,
        ),
      );
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () =>
        root.render(
          <MemoryRouter>
            <Owner changed />
          </MemoryRouter>,
        ),
      );
      expect(container.textContent).toBe("Loading");
      await act(async () => finishOld({ id: "page-1", code: "Late private page" }));
      expect(container.textContent).toBe("Loading");
      await act(async () => finishNew({ id: "page-2", code: "New private page" }));
      expect(container.textContent).toBe("New private page");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
