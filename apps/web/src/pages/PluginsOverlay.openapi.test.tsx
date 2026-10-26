// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  confirm: vi.fn(),
  receipt: vi.fn(),
  list: vi.fn(),
  install: vi.fn(),
  remove: vi.fn(),
  selection: "space-a",
  generation: 1,
}));
vi.mock("../lib/rpc", () => {
  const rpc = {
    connections: { catalog: async () => [], list: async () => [] },
    capabilities: {
      list: api.list,
      catalogSearch: async () => ({ enabled: false, results: [] }),
      previewOpenApi: api.preview,
      confirmOpenApi: api.confirm,
      openApiReceipt: api.receipt,
      install: api.install,
      remove: api.remove,
    },
  };
  return {
    rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => api.selection,
    currentSpaceSelectionGeneration: () => api.generation,
  };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((out, part, i) => out + (i ? values[i - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => {
  const Div = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: () => null,
    AlertDialogAction: Div,
    AlertDialogCancel: Div,
    AlertDialogContent: Div,
    AlertDialogDescription: Div,
    AlertDialogFooter: Div,
    AlertDialogHeader: Div,
    AlertDialogTitle: Div,
    Badge: Div,
    Card: Div,
    CardContent: Div,
    CardHeader: Div,
    CardTitle: Div,
    Dialog: Div,
    DialogContent: Div,
    DialogHeader: Div,
    DialogTitle: Div,
    DialogClose: Div,
    Tabs: Div,
    TabsContent: Div,
    TabsList: Div,
    TabsTrigger: Div,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});
vi.mock("../components/integrations/IntegrationSetup", () => ({ IntegrationSetup: () => null }));
vi.mock("../components/integrations/NativeAccountConnect", () => ({
  NativeAccountConnect: () => null,
}));

import { PluginsOverlay } from "./PluginsOverlay";

const preview = {
  status: "ready",
  target: "https://service.example.test",
  operations: [{ id: "listItems", method: "GET", path: "/items", readOnly: true }],
  diagnostics: [
    {
      scope: "operation",
      code: "external_reference",
      operationId: "unsafeInput",
      path: "/unsafe",
      method: "POST",
      pointer: "#/paths/~1unsafe/post",
    },
  ],
  counts: { discovered: 2, accepted: 1, rejected: 1, omittedDiagnostics: 0 },
  reviewToken: "review-one",
  expiresAt: "2027-01-01T00:00:00.000Z",
};
const install = {
  id: "install-one",
  kind: "api",
  name: "Example API",
  source: "https://example.test/spec.yaml",
  config: {},
  secretConfigured: false,
  version: "1.0.0",
  digest: "digest",
  createdAt: "2026-01-01",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.selection = "space-a";
  api.generation = 1;
  api.preview.mockReset().mockResolvedValue(preview);
  api.confirm.mockReset().mockResolvedValue({ status: "installed", install, replayed: false });
  api.remove.mockReset().mockResolvedValue({ ok: true });
  api.receipt.mockReset();
  api.install.mockReset();
  api.list.mockReset().mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(ownerKey = "actor-session-a") {
  await act(async () =>
    root.render(<PluginsOverlay ownerKey={ownerKey} spaceId="space-a" onClose={() => {}} />),
  );
}
async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((row) => row.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function fill(placeholder: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  expect(input, placeholder).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function begin() {
  await render();
  await press("Add OpenAPI");
  await fill("Display name", "Example API");
  await fill("https://example.com/openapi.json", "https://example.test/spec.yaml");
}

it("reviews accepted and rejected operations before confirming the reviewed input", async () => {
  await begin();
  await press("Preview");
  expect(container.querySelector('[data-testid="openapi-import-review"]')?.textContent).toContain(
    "Ready · 1",
  );
  expect(container.textContent).toContain("listItems");
  expect(container.textContent).toContain("unsafeInput");
  expect(container.textContent).toContain("External references are not supported.");
  expect(api.install).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
  api.list.mockResolvedValue([install]);
  await press("Add");
  expect(api.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Example API",
      source: "https://example.test/spec.yaml",
      reviewToken: "review-one",
    }),
    expect.anything(),
  );
  expect(container.textContent).toContain("Example API");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bearer(value: string) {
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "bearer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await fill("Credential", value);
}

it("invalidates a late preview when the user edits the credential", async () => {
  const pending = deferred<typeof preview>();
  api.preview.mockReturnValue(pending.promise);
  await begin();
  await bearer("old-secret");
  await press("Preview");
  await fill("Credential", "new-secret");
  await act(async () => pending.resolve(preview));
  expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Credential"]')?.value).toBe(
    "new-secret",
  );
  expect(api.confirm).not.toHaveBeenCalled();
});

it("keeps a reopened form and credential when an earlier confirmation finishes", async () => {
  const pending = deferred<{ status: string; install: typeof install; replayed: boolean }>();
  api.confirm.mockReturnValue(pending.promise);
  await begin();
  await bearer("old-secret");
  await press("Preview");
  await press("Add");
  await press("Close");
  await press("Add OpenAPI");
  await bearer("new-secret");
  await fill("Display name", "New draft");
  await act(async () => pending.resolve({ status: "installed", install, replayed: false }));
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.value,
  ).toBe("New draft");
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Credential"]')?.value).toBe(
    "new-secret",
  );
  expect(container.textContent).not.toContain("API · https://example.test/spec.yaml");
});

it("checks an unknown receipt without credentials and retries only the original confirmation", async () => {
  api.confirm.mockRejectedValueOnce(new Error("Lost response"));
  api.receipt.mockResolvedValue({ status: "pending", diagnostics: [], retryAfterMs: 1000 });
  await begin();
  await bearer("kept-secret");
  await press("Preview");
  await press("Add");
  expect(container.textContent).toContain("Could not confirm installation.");
  expect(api.preview).toHaveBeenCalledTimes(1);
  expect(api.confirm).toHaveBeenCalledTimes(1);
  await press("Check status");
  expect(api.receipt).toHaveBeenCalledWith({ reviewToken: "review-one" }, expect.anything());
  expect(api.confirm).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Installation pending.");
  api.list.mockResolvedValue([install]);
  await press("Retry");
  expect(api.confirm).toHaveBeenCalledTimes(2);
  expect(api.confirm.mock.calls[1]![0]).toEqual(api.confirm.mock.calls[0]![0]);
  expect(api.confirm.mock.calls[1]![0].credential).toBe("kept-secret");
  expect(api.preview).toHaveBeenCalledTimes(1);
});

it("shows useful all-invalid diagnostics without a confirmation action", async () => {
  api.preview.mockResolvedValue({
    ...preview,
    status: "invalid",
    operations: [],
    reviewToken: null,
    expiresAt: null,
    counts: { discovered: 1, accepted: 0, rejected: 1, omittedDiagnostics: 4 },
  });
  await begin();
  await press("Preview");
  const review = container.querySelector('[data-testid="openapi-import-review"]');
  expect(review?.textContent).not.toContain("Ready");
  expect(review?.textContent).toContain("Not imported · 1");
  expect(review?.textContent).toContain("Preview again");
  expect(container.textContent).toContain("unsafeInput");
  expect(container.textContent).toContain("Additional diagnostics omitted: 4");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Add"),
  ).toBe(false);
});

it("clears an actor's credential when the committed editor identity changes", async () => {
  await begin();
  await bearer("previous-owner-secret");
  await press("Preview");
  await render("actor-session-b");
  expect(container.querySelector('input[placeholder="Credential"]')).toBeNull();
  expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
});

it("rejects an A to B to A response by selection generation", async () => {
  const pending = deferred<typeof preview>();
  api.preview.mockReturnValue(pending.promise);
  await begin();
  await press("Preview");
  api.generation += 2;
  await render();
  await act(async () => pending.resolve(preview));
  expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
});

it.each(["name", "source", "credential", "header", "auth"])(
  "invalidates the review after a raw %s edit",
  async (field) => {
    await begin();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "header";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await fill("Credential", "secret");
    await press("Preview");
    if (field === "name") await fill("Display name", "Example API ");
    if (field === "source")
      await fill("https://example.com/openapi.json", "https://example.test/spec.yaml ");
    if (field === "credential") await fill("Credential", "secret ");
    if (field === "header") await fill("Header name", "x-other-key");
    if (field === "auth")
      await act(async () => {
        select.value = "none";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
    expect(api.confirm).not.toHaveBeenCalled();
  },
);

it("keeps a successful install when refreshing the source list fails", async () => {
  await begin();
  await press("Preview");
  api.list.mockRejectedValueOnce(new Error("Read failed"));
  await press("Add");
  expect(container.textContent).toContain("Example API");
  expect(container.textContent).not.toContain("Could not confirm installation.");
});

it("locks the submitted credential while a receipt is unknown and keeps recovery actions available", async () => {
  api.confirm.mockRejectedValueOnce(new Error("Lost response"));
  await begin();
  await bearer("kept-secret");
  await press("Preview");
  await press("Add");
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="Credential"]')?.disabled,
  ).toBe(true);
  expect(
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Check status",
    )?.disabled,
  ).toBe(false);
});

it.each(["stale", "expired", "removed", "invalid"])(
  "requires an explicit new preview after a %s confirmation",
  async (status) => {
    api.confirm.mockResolvedValue({ status, diagnostics: [] });
    await begin();
    await press("Preview");
    await press("Add");
    expect(api.preview).toHaveBeenCalledTimes(1);
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Add"),
    ).toBe(false);
    await press("Preview again");
    expect(api.preview).toHaveBeenCalledTimes(2);
  },
);

it("does not restore a removed source from the confirmation's earlier list refresh", async () => {
  await begin();
  await press("Preview");
  const list = deferred<(typeof install)[]>();
  api.list.mockReturnValueOnce(list.promise);
  await press("Add");
  await press("Remove");
  expect(container.textContent).not.toContain("Example API");
  await act(async () => list.resolve([install]));
  expect(container.textContent).not.toContain("Example API");
});

const manualKinds = ["mcp", "graphql", "executor", "treg"] as const;
type ManualKind = (typeof manualKinds)[number];
const manualEntries = {
  mcp: { label: "Add MCP server", url: "https://example.com/mcp", credential: "Credential" },
  graphql: { label: "Add GraphQL", url: "https://example.com/graphql", credential: "Credential" },
  executor: {
    label: "Add Executor",
    url: "https://executor.example/mcp",
    credential: "Executor token",
  },
  treg: { label: "Add Treg", url: null, credential: "Treg token" },
} as const;
async function openManual(kind: ManualKind, name = `Manual ${kind}`) {
  await press(manualEntries[kind].label);
  await fill("Display name", name);
  const sourcePlaceholder = manualEntries[kind].url;
  if (sourcePlaceholder) await fill(sourcePlaceholder, `https://manual.example.test/${kind}`);
  if (kind === "mcp" || kind === "graphql") {
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "header";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await fill("Header name", "x-original-key");
  }
  await fill(manualEntries[kind].credential, "original-secret");
}

it.each(manualKinds)(
  "keeps %s manual installation single-flight through edit attempts and unrelated removal",
  async (kind) => {
    const wait = deferred<typeof install>();
    const installed = {
      ...install,
      id: `manual-${kind}`,
      kind: kind === "graphql" ? "graphql" : "mcp",
      name: `Manual ${kind}`,
    };
    api.list.mockResolvedValue([{ ...install, id: "earlier-source", name: "Earlier source" }]);
    api.install.mockReturnValue(wait.promise);
    await render();
    await openManual(kind);
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Verify and add",
    )!;
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(api.install).toHaveBeenCalledTimes(1);
    const submitted = api.install.mock.calls[0]![0];
    const fields = [
      ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input[placeholder="Display name"], input[type="password"], select, input[placeholder="Header name"]',
      ),
    ];
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.every((field) => field.disabled)).toBe(true);
    await fill("Display name", "Ignored edit");
    await fill(manualEntries[kind].credential, "ignored-secret");
    if (manualEntries[kind].url)
      await fill(manualEntries[kind].url!, "https://ignored.example.test");
    const auth = container.querySelector<HTMLSelectElement>("select");
    if (auth) await fill("Header name", "ignored-key");
    if (auth)
      await act(async () => {
        auth.value = "none";
        auth.dispatchEvent(new Event("change", { bubbles: true }));
      });
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.value,
    ).toBe(`Manual ${kind}`);
    expect(
      container.querySelector<HTMLInputElement>(
        `input[placeholder="${manualEntries[kind].credential}"]`,
      )?.value,
    ).toBe("original-secret");
    await press("Remove");
    expect(submit.disabled).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.disabled,
    ).toBe(true);
    await act(async () => submit.click());
    expect(api.install).toHaveBeenCalledTimes(1);
    if (auth) {
      expect(auth.value).toBe("header");
      expect(
        container.querySelector<HTMLInputElement>('input[placeholder="Header name"]')?.value,
      ).toBe("x-original-key");
    }
    expect(submitted.name).toBe(`Manual ${kind}`);
    expect(submitted.credential).toBe("original-secret");
    api.list.mockResolvedValue([installed]);
    await act(async () => wait.resolve(installed));
    expect(container.querySelector('input[placeholder="Display name"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain(`Manual ${kind}`);
    expect(api.list).toHaveBeenCalledTimes(2);
  },
);

it.each(manualKinds)(
  "does not let a closed %s attempt clear a replacement manual credential or lock",
  async (kind) => {
    const old = deferred<typeof install>();
    const current = deferred<typeof install>();
    api.install.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render();
    await openManual(kind);
    await press("Verify and add");
    await press("Close");
    await openManual(kind, "Replacement draft");
    await fill(manualEntries[kind].credential, "new-secret");
    await press("Verify and add");
    await act(async () => old.resolve(install));
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.value,
    ).toBe("Replacement draft");
    expect(
      container.querySelector<HTMLInputElement>(
        `input[placeholder="${manualEntries[kind].credential}"]`,
      )?.value,
    ).toBe("new-secret");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.disabled,
    ).toBe(true);
    expect(api.list).toHaveBeenCalledTimes(1);
    api.list.mockResolvedValue([{ ...install, name: "Replacement draft" }]);
    await act(async () => current.resolve(install));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2);
  },
);

it.each(["kind", "actor-space"])(
  "abandons manual observation on an explicit %s change without clearing the new draft",
  async (boundary) => {
    const wait = deferred<typeof install>();
    api.install.mockReturnValue(wait.promise);
    await render();
    await openManual("mcp");
    await press("Verify and add");
    if (boundary === "actor-space") {
      api.generation += 2;
      await render("new-actor-session");
    }
    await openManual("graphql", "Next draft");
    await fill("Credential", "next-secret");
    await act(async () => wait.resolve(install));
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.value,
    ).toBe("Next draft");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Credential"]')?.value,
    ).toBe("next-secret");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.disabled,
    ).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(1);
  },
);
