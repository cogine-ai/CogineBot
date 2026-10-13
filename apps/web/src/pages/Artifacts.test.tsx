// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSpace: vi.fn(),
  listVersions: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
}));
const bootstrap = vi.hoisted(() => vi.fn());
const artifactOpen = vi.hoisted(() => ({
  decodeArtifactBase64: vi.fn(),
  downloadArtifactBytes: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { artifacts: api } }));
vi.mock("../lib/bootstrap", () => ({ takeInitialBootstrap: bootstrap }));
vi.mock("../lib/artifact-open", () => artifactOpen);
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />;
  return {
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    BotAvatar: () => <span />,
    Button,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    parseBotAvatar: () => ({ color: undefined }),
    resolvePersonaColorDef: () => ({ hex: "#000000" }),
  };
});

import { ArtifactsPage } from "./Artifacts";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  bootstrap.mockResolvedValue({ bots: [] });
  api.listVersions.mockResolvedValue([]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) => ({
    ...artifact("File preview", artifactId),
    contentBase64: "preview content",
  }));
  artifactOpen.decodeArtifactBase64.mockImplementation((content: string) =>
    new TextEncoder().encode(content),
  );
});

function artifact(name: string, id: string, createdAt = new Date().toISOString()) {
  return {
    id,
    botId: null,
    groupId: null,
    runId: null,
    name,
    description: null,
    mimeType: "text/markdown",
    size: 128,
    version: 1,
    createdAt,
    versionCount: 1,
  };
}

function typeSearch(container: HTMLElement, value: string) {
  const input = container.querySelector("input[type='search']");
  if (!(input instanceof HTMLInputElement)) throw new Error("missing search input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buttonNamed(container: HTMLElement, name: string) {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === name || entry.textContent === name,
  );
  if (!button) throw new Error(`missing button: ${name}`);
  return button;
}

function displayedArtifactIds(container: HTMLElement) {
  return [...container.querySelectorAll("[data-artifact-id]")].map((item) =>
    item.getAttribute("data-artifact-id"),
  );
}

function selectVersion(container: HTMLElement, versionId: string) {
  const select = container.querySelector("select[aria-label='Version']");
  if (!(select instanceof HTMLSelectElement)) throw new Error("missing version selector");
  select.value = versionId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function renderArtifacts(path = "/app/artifacts") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/artifacts/:artifactId?" element={<ArtifactsPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("opens the Files screen and lists what listSpace returns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockResolvedValue({
    items: [artifact("Q3 Content Calendar", "artifact-1")],
    nextCursor: null,
  });
  const page = await renderArtifacts();
  try {
    expect(page.container.querySelector("h1")?.textContent).toBe("Files");
    expect(page.container.textContent).toContain("Q3 Content Calendar");
    expect(page.container.querySelector("a[href='/app']")?.textContent).toContain("Bots");
    expect(page.container.querySelector("[data-testid='app-rail']")).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("keeps loading later pages when search hides the current snapshot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockImplementation(async (input: { cursor?: string }) => {
    if (!input.cursor) {
      return { items: [artifact("Alpha notes", "artifact-1")], nextCursor: "artifact-1" };
    }
    return { items: [artifact("Beta report", "artifact-2")], nextCursor: null };
  });
  const page = await renderArtifacts();
  try {
    expect(page.container.textContent).toContain("Alpha notes");
    const filters = [...page.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Filters"),
    );
    expect(filters).toBeTruthy();
    await act(async () => {
      filters?.click();
    });
    await act(async () => {
      typeSearch(page.container, "Beta");
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Beta report");
      });
    });
    expect(page.container.textContent).not.toContain("Alpha notes");
    expect(api.listSpace).toHaveBeenCalledWith(expect.objectContaining({ cursor: "artifact-1" }));
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("still offers Load more when filters match nothing on the loaded page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let releaseSecondPage: (() => void) | undefined;
  const secondPage = new Promise<{
    items: ReturnType<typeof artifact>[];
    nextCursor: string | null;
  }>((resolve) => {
    releaseSecondPage = () =>
      resolve({ items: [artifact("Beta report", "artifact-2")], nextCursor: null });
  });
  api.listSpace.mockImplementation(async (input: { cursor?: string }) => {
    if (!input.cursor) {
      return { items: [artifact("Alpha notes", "artifact-1")], nextCursor: "artifact-1" };
    }
    return secondPage;
  });
  const page = await renderArtifacts();
  try {
    const filters = [...page.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Filters"),
    );
    await act(async () => {
      filters?.click();
    });
    await act(async () => {
      typeSearch(page.container, "Beta");
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toMatch(/Load more|Loading…/);
      });
    });
    expect(page.container.textContent).not.toContain("Beta report");
    await act(async () => {
      releaseSecondPage?.();
      await secondPage;
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Beta report");
      });
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it.each(
  ["grid", "list", "index"].flatMap((view) =>
    ["search", "date"].map((filter) => ({ view, filter })),
  ),
)(
  "shows an older-page failure and retries it in an empty $filter filter in $view view",
  async ({ view, filter }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (view === "list") window.localStorage.setItem("rakazo:artifacts-view-mode", "list");
    const current = artifact("Alpha notes", "current", "2000-01-01T12:00:00.000Z");
    const older = artifact("Beta report", "older", "1999-01-01T12:00:00.000Z");
    const pendingPage = deferred<{
      items: ReturnType<typeof artifact>[];
      nextCursor: string | null;
    }>();
    let olderAttempts = 0;
    api.listSpace.mockImplementation(({ cursor }: { cursor?: string }) => {
      if (!cursor) return Promise.resolve({ items: [current], nextCursor: "current" });
      olderAttempts += 1;
      return olderAttempts === 1
        ? pendingPage.promise
        : Promise.resolve({ items: [older], nextCursor: null });
    });
    const page = await renderArtifacts(
      view === "index" ? "/app/artifacts/current" : "/app/artifacts",
    );
    try {
      await act(async () => buttonNamed(page.container, "Filters").click());
      await act(async () => {
        if (filter === "search") {
          typeSearch(page.container, "Beta");
        } else {
          const select = page.container.querySelector("select[aria-label='Filter by date']");
          if (!(select instanceof HTMLSelectElement)) throw new Error("missing date filter");
          select.value = "today";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      expect(displayedArtifactIds(page.container)).toEqual([]);
      expect(api.listSpace).toHaveBeenCalledTimes(2);
      await act(async () => {
        pendingPage.reject(new Error("Older files are temporarily unavailable"));
        await pendingPage.promise.catch(() => undefined);
      });
      const timeline = page.container.querySelector(
        view === "index" ? "[data-testid='artifacts-index']" : "[data-testid='artifacts-browse']",
      );
      expect(timeline?.textContent).toContain("Older files are temporarily unavailable");
      expect(buttonNamed(page.container, "Load more").disabled).toBe(false);
      await act(async () => buttonNamed(page.container, "Load more").click());
      expect(api.listSpace.mock.calls.slice(1).map(([input]) => input.cursor)).toEqual([
        "current",
        "current",
      ]);
      expect(timeline?.textContent).not.toContain("Older files are temporarily unavailable");
      expect(displayedArtifactIds(page.container)).toEqual(filter === "search" ? ["older"] : []);
      if (filter === "date") expect(timeline?.textContent).toContain("No artifacts found.");
      await act(async () => {
        if (filter === "search") {
          typeSearch(page.container, "");
        } else {
          const select = page.container.querySelector("select[aria-label='Filter by date']");
          if (!(select instanceof HTMLSelectElement)) throw new Error("missing date filter");
          select.value = "all";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      expect(displayedArtifactIds(page.container)).toEqual(["older", "current"]);
      expect(api.listSpace).toHaveBeenCalledTimes(3);
    } finally {
      await page.cleanup();
      vi.unstubAllGlobals();
    }
  },
);

it.each(["grid", "list", "index"])(
  "puts older pages above the complete loaded history in %s view without resorting timestamp ties",
  async (view) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (view === "list") window.localStorage.setItem("rakazo:artifacts-view-mode", "list");
    const createdAt = "2026-10-01T12:00:00.000Z";
    const pages = [
      {
        items: [artifact("First", "a", createdAt), artifact("Second", "z", createdAt)],
        nextCursor: "z",
      },
      {
        items: [artifact("Third", "m", createdAt), artifact("Fourth", "b", createdAt)],
        nextCursor: "b",
      },
      {
        items: [artifact("Fifth", "y", createdAt), artifact("Sixth", "c", createdAt)],
        nextCursor: null,
      },
    ];
    api.listSpace.mockImplementation(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) return pages[0];
      return cursor === "z" ? pages[1] : pages[2];
    });
    const page = await renderArtifacts(view === "index" ? "/app/artifacts/a" : "/app/artifacts");
    try {
      expect(displayedArtifactIds(page.container)).toEqual(["z", "a"]);
      await act(async () => buttonNamed(page.container, "Load more").click());
      expect(displayedArtifactIds(page.container)).toEqual(["b", "m", "z", "a"]);
      await act(async () => buttonNamed(page.container, "Load more").click());
      expect(displayedArtifactIds(page.container)).toEqual(["c", "y", "b", "m", "z", "a"]);
      expect(api.listSpace.mock.calls.map(([input]) => input)).toEqual([
        { botId: undefined, limit: 60 },
        { botId: undefined, cursor: "z", limit: 60 },
        { botId: undefined, cursor: "b", limit: 60 },
      ]);
      expect(
        [...page.container.querySelectorAll("button")].some(
          (button) => button.textContent === "Load more",
        ),
      ).toBe(false);
    } finally {
      await page.cleanup();
      vi.unstubAllGlobals();
    }
  },
);

it("keeps loaded files and retries the same older-page cursor after a failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace
    .mockResolvedValueOnce({ items: [artifact("Latest file", "newest")], nextCursor: "newest" })
    .mockRejectedValueOnce(new Error("Temporary page failure"))
    .mockResolvedValueOnce({ items: [artifact("Older file", "oldest")], nextCursor: null });
  const page = await renderArtifacts();
  try {
    await act(async () => buttonNamed(page.container, "Load more").click());
    expect(displayedArtifactIds(page.container)).toEqual(["newest"]);
    expect(buttonNamed(page.container, "Load more").disabled).toBe(false);
    await act(async () => buttonNamed(page.container, "Load more").click());
    expect(displayedArtifactIds(page.container)).toEqual(["oldest", "newest"]);
    expect(api.listSpace.mock.calls.slice(1).map(([input]) => input.cursor)).toEqual([
      "newest",
      "newest",
    ]);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("retries an initial listing failure with the existing page size and filter", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace
    .mockRejectedValueOnce(new Error("Temporary listing failure"))
    .mockResolvedValueOnce({ items: [artifact("Recovered file", "recovered")], nextCursor: null });
  const page = await renderArtifacts();
  try {
    expect(page.container.textContent).toContain("Temporary listing failure");
    expect(displayedArtifactIds(page.container)).toEqual([]);
    await act(async () => buttonNamed(page.container, "Retry now").click());
    expect(displayedArtifactIds(page.container)).toEqual(["recovered"]);
    expect(api.listSpace.mock.calls.map(([input]) => input)).toEqual([
      { botId: undefined, limit: 60 },
      { botId: undefined, limit: 60 },
    ]);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("ignores an old pending page when switching the existing Bot filter", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bootstrap.mockResolvedValue({ bots: [{ id: "bot-beta", name: "Beta", color: "#62A8EC" }] });
  const olderAllBotsPage = deferred<{
    items: ReturnType<typeof artifact>[];
    nextCursor: string | null;
  }>();
  api.listSpace.mockImplementation(({ botId, cursor }: { botId?: string; cursor?: string }) => {
    if (botId === "bot-beta") {
      return Promise.resolve({
        items: [{ ...artifact("Beta file", "beta-file"), botId }],
        nextCursor: null,
      });
    }
    if (cursor) return olderAllBotsPage.promise;
    return Promise.resolve({
      items: [artifact("All-bot file", "all-file")],
      nextCursor: "all-file",
    });
  });
  const page = await renderArtifacts();
  try {
    await act(async () => buttonNamed(page.container, "Load more").click());
    await act(async () => buttonNamed(page.container, "Filters").click());
    await act(async () => buttonNamed(page.container, "Beta").click());
    expect(displayedArtifactIds(page.container)).toEqual(["beta-file"]);
    await act(async () => {
      olderAllBotsPage.resolve({
        items: [artifact("Late all-bot file", "late-all")],
        nextCursor: "late-all",
      });
      await olderAllBotsPage.promise;
    });
    expect(displayedArtifactIds(page.container)).toEqual(["beta-file"]);
    expect(page.container.textContent).not.toContain("Late all-bot file");
    expect(api.listSpace).toHaveBeenCalledWith({ botId: "bot-beta", limit: 60 });
    expect(
      [...page.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Load more",
      ),
    ).toBe(false);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("previews and downloads exactly the selected file version", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const longName = "A very long project report name with revisions and supporting materials.md";
  const latest = { ...artifact(longName, "version-2"), version: 2, versionCount: 2 };
  const earlier = { ...artifact("Previous report.md", "version-1"), version: 1 };
  api.listSpace.mockResolvedValue({ items: [latest], nextCursor: null });
  api.listVersions.mockResolvedValue([
    { id: latest.id, version: 2, name: latest.name, createdAt: latest.createdAt },
    { id: earlier.id, version: 1, name: earlier.name, createdAt: earlier.createdAt },
  ]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) => ({
    ...(artifactId === latest.id ? latest : earlier),
    contentBase64: artifactId === latest.id ? "latest report" : "earlier report",
  }));
  const page = await renderArtifacts("/app/artifacts/version-2");
  try {
    expect(page.container.textContent).toContain("latest report");
    await act(async () => buttonNamed(page.container, "Download").click());
    expect(artifactOpen.downloadArtifactBytes).toHaveBeenLastCalledWith(
      longName,
      "text/markdown",
      new TextEncoder().encode("latest report"),
    );
    await act(async () => selectVersion(page.container, earlier.id));
    expect(page.container.textContent).toContain("earlier report");
    expect(page.container.textContent).not.toContain("latest report");
    await act(async () => buttonNamed(page.container, "Download").click());
    expect(artifactOpen.downloadArtifactBytes).toHaveBeenLastCalledWith(
      earlier.name,
      "text/markdown",
      new TextEncoder().encode("earlier report"),
    );
    expect(api.getById.mock.calls.map(([input]) => input.artifactId)).toEqual([
      "version-2",
      "version-1",
    ]);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("does not let a late previous-version response replace a newer selection or its download", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const latest = { ...artifact("Current report.md", "version-2"), version: 2, versionCount: 2 };
  const earlier = artifact("Previous report.md", "version-1");
  const previousFetch = deferred<ReturnType<typeof artifact> & { contentBase64: string }>();
  api.listSpace.mockResolvedValue({ items: [latest], nextCursor: null });
  api.listVersions.mockResolvedValue([
    { id: latest.id, version: 2, name: latest.name, createdAt: latest.createdAt },
    { id: earlier.id, version: 1, name: earlier.name, createdAt: earlier.createdAt },
  ]);
  api.getById.mockImplementation(({ artifactId }: { artifactId: string }) =>
    artifactId === earlier.id
      ? previousFetch.promise
      : Promise.resolve({ ...latest, contentBase64: "current report" }),
  );
  const page = await renderArtifacts("/app/artifacts/version-2");
  try {
    await act(async () => selectVersion(page.container, earlier.id));
    expect(
      [...page.container.querySelectorAll("button")].some(
        (button) => button.getAttribute("aria-label") === "Download",
      ),
    ).toBe(false);
    await act(async () => selectVersion(page.container, latest.id));
    await act(async () => {
      previousFetch.resolve({ ...earlier, contentBase64: "late previous report" });
      await previousFetch.promise;
    });
    expect(page.container.textContent).toContain("current report");
    expect(page.container.textContent).not.toContain("late previous report");
    await act(async () => buttonNamed(page.container, "Download").click());
    expect(artifactOpen.downloadArtifactBytes).toHaveBeenLastCalledWith(
      latest.name,
      "text/markdown",
      new TextEncoder().encode("current report"),
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("retries failed content for the selected older version without resetting to the latest version", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const latest = { ...artifact("Current report.md", "version-2"), version: 2, versionCount: 2 };
  const earlier = artifact("Earlier report.md", "version-1");
  let earlierFailed = false;
  api.listSpace.mockResolvedValue({ items: [latest], nextCursor: null });
  api.listVersions.mockResolvedValue([
    { id: latest.id, version: 2, name: latest.name, createdAt: latest.createdAt },
    { id: earlier.id, version: 1, name: earlier.name, createdAt: earlier.createdAt },
  ]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) => {
    if (artifactId === earlier.id && !earlierFailed) {
      earlierFailed = true;
      throw new Error("Temporary content failure");
    }
    return {
      ...(artifactId === earlier.id ? earlier : latest),
      contentBase64:
        artifactId === earlier.id ? "earlier report content" : "current report content",
    };
  });
  const page = await renderArtifacts("/app/artifacts/version-2");
  try {
    await act(async () => selectVersion(page.container, earlier.id));
    expect(page.container.textContent).toContain("Temporary content failure");
    expect(
      page.container.querySelector<HTMLSelectElement>("select[aria-label='Version']")?.value,
    ).toBe(earlier.id);
    expect(
      [...page.container.querySelectorAll("button")].some(
        (button) => button.getAttribute("aria-label") === "Download",
      ),
    ).toBe(false);
    await act(async () => buttonNamed(page.container, "Retry now").click());
    expect(api.listVersions).toHaveBeenCalledTimes(1);
    expect(api.getById.mock.calls.map(([input]) => input.artifactId)).toEqual([
      latest.id,
      earlier.id,
      earlier.id,
    ]);
    expect(
      page.container.querySelector<HTMLSelectElement>("select[aria-label='Version']")?.value,
    ).toBe(earlier.id);
    expect(page.container.textContent).toContain("earlier report content");
    expect(page.container.textContent).not.toContain("current report content");
    await act(async () => buttonNamed(page.container, "Download").click());
    expect(artifactOpen.downloadArtifactBytes).toHaveBeenLastCalledWith(
      earlier.name,
      earlier.mimeType,
      new TextEncoder().encode("earlier report content"),
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("retries version discovery instead of silently downloading the route's root version", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const latest = { ...artifact("Latest report.md", "version-3"), version: 3, versionCount: 3 };
  api.listSpace.mockResolvedValue({ items: [latest], nextCursor: null });
  api.listVersions
    .mockRejectedValueOnce(new Error("Temporary version failure"))
    .mockResolvedValueOnce([
      { id: latest.id, version: 3, name: latest.name, createdAt: latest.createdAt },
      { id: "version-root", version: 1, name: "Initial report.md", createdAt: latest.createdAt },
    ]);
  api.getById.mockResolvedValue({ ...latest, contentBase64: "latest version content" });
  const page = await renderArtifacts("/app/artifacts/version-root");
  try {
    expect(page.container.textContent).toContain("Temporary version failure");
    expect(api.getById).not.toHaveBeenCalled();
    expect(artifactOpen.downloadArtifactBytes).not.toHaveBeenCalled();
    expect(
      [...page.container.querySelectorAll("button")].some(
        (button) => button.getAttribute("aria-label") === "Download",
      ),
    ).toBe(false);
    await act(async () => buttonNamed(page.container, "Retry now").click());
    expect(api.listVersions.mock.calls.map(([input]) => input.familyId)).toEqual([
      "version-root",
      "version-root",
    ]);
    expect(api.getById.mock.calls.map(([input]) => input.artifactId)).toEqual(["version-3"]);
    expect(page.container.textContent).toContain("latest version content");
    await act(async () => buttonNamed(page.container, "Download").click());
    expect(artifactOpen.downloadArtifactBytes).toHaveBeenLastCalledWith(
      latest.name,
      latest.mimeType,
      new TextEncoder().encode("latest version content"),
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("does not close a later preview when deletion from the previous preview completes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = artifact("Previous file.md", "previous");
  const current = artifact("Current file.md", "current");
  const removal = deferred<void>();
  api.listSpace.mockResolvedValue({ items: [current, previous], nextCursor: null });
  api.listVersions.mockImplementation(async ({ familyId }: { familyId: string }) => [
    { id: familyId, version: 1, name: familyId, createdAt: previous.createdAt },
  ]);
  api.getById.mockImplementation(async ({ artifactId }: { artifactId: string }) => ({
    ...(artifactId === previous.id ? previous : current),
    contentBase64: artifactId === previous.id ? "previous preview" : "current preview",
  }));
  api.remove.mockReturnValue(removal.promise);
  const page = await renderArtifacts("/app/artifacts/previous");
  try {
    await act(async () => buttonNamed(page.container, "Delete Previous file.md").click());
    await act(async () => buttonNamed(page.container, "Delete").click());
    const currentLink = page.container.querySelector("a[href='/app/artifacts/current']");
    if (!(currentLink instanceof HTMLAnchorElement)) throw new Error("missing current file link");
    await act(async () => currentLink.click());
    expect(page.container.textContent).toContain("current preview");
    await act(async () => {
      removal.resolve();
      await removal.promise;
    });
    expect(page.container.textContent).toContain("current preview");
    expect(page.container.textContent).not.toContain("previous preview");
    expect(displayedArtifactIds(page.container)).toEqual(["current"]);
    expect(page.container.querySelector("[data-testid='artifacts-index']")).not.toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("keeps a file on delete failure and removes it only after the existing retry succeeds", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = { ...artifact("Report.md", "report"), versionCount: 3, version: 3 };
  api.listSpace.mockResolvedValue({ items: [target], nextCursor: null });
  api.remove
    .mockRejectedValueOnce(new Error("Temporary deletion failure"))
    .mockResolvedValueOnce(undefined);
  const page = await renderArtifacts();
  try {
    await act(async () => buttonNamed(page.container, "Delete Report.md").click());
    expect(page.container.textContent).toContain("This deletes all 3 versions");
    await act(async () => buttonNamed(page.container, "Delete").click());
    expect(displayedArtifactIds(page.container)).toEqual(["report"]);
    expect(page.container.textContent).toContain("Temporary deletion failure");
    expect(buttonNamed(page.container, "Delete").disabled).toBe(false);
    await act(async () => buttonNamed(page.container, "Delete").click());
    expect(displayedArtifactIds(page.container)).toEqual([]);
    expect(api.remove.mock.calls.map(([input]) => input.artifactId)).toEqual(["report", "report"]);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});
