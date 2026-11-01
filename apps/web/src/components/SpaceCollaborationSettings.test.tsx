// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpaceRpcProvider } from "../lib/space-rpc";
import { SpaceCollaborationSettings } from "./SpaceCollaborationSettings";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

const original = {
  id: "space-b",
  name: "Research",
  allowBotCollaboration: true,
  collaborationRevision: 7,
  canManageCollaboration: true,
};
let row: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;
let read: () => Promise<Response>;
let write: (input: Record<string, unknown>) => Promise<Response>;
let writes: Record<string, unknown>[];
let headers: (string | null)[];
const busy = vi.fn();

function response(value: unknown) {
  return Response.json({ json: value });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function button(label: string) {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === label,
  );
  expect(result, `${label} action`).toBeDefined();
  return result!;
}
function toggle() {
  const result = container.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(result).not.toBeNull();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function render(spaceId = "space-b", ownerKey = "account-a/session-a") {
  await act(async () =>
    root.render(
      <SpaceRpcProvider key={`${spaceId}/${ownerKey}`} spaceId={spaceId} ownerKey={ownerKey}>
        <SpaceCollaborationSettings onBusyChange={busy} />
      </SpaceRpcProvider>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("rakazo:space-id", "space-a");
  row = { ...original };
  writes = [];
  headers = [];
  busy.mockReset();
  read = async () => response({ spaces: [row] });
  write = async (input) =>
    response({
      spaceId: input.spaceId,
      allowBotCollaboration: input.allowBotCollaboration,
      collaborationRevision: 8,
      canManageCollaboration: true,
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("x-rakazo-space-id"));
      if (request.url.endsWith("/spaces/list")) return read();
      if (request.url.endsWith("/spaces/update")) {
        const input = (JSON.parse(await request.text()) as { json: Record<string, unknown> }).json;
        writes.push(input);
        return write(input);
      }
      throw new Error(`Unexpected procedure ${new URL(request.url).pathname}`);
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("shows a member the server value without granting write capability", async () => {
  row.canManageCollaboration = false;
  row.isDeploymentOwner = true;
  await render();
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Only the Space owner can change this.");
  expect(container.textContent).not.toContain("Work already running may finish.");
  expect(container.textContent).not.toContain("Save");
  await act(async () => toggle().click());
  expect(writes).toHaveLength(0);
});

for (const field of [
  "allowBotCollaboration",
  "collaborationRevision",
  "canManageCollaboration",
] as const) {
  it(`does not infer missing ${field} from an old Space row`, async () => {
    delete row[field];
    await render();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).toContain("Could not load this setting.");
    expect(button("Refresh").disabled).toBe(false);
    expect(writes).toHaveLength(0);
  });
}

it("keeps the intended value across CAS conflict and requires manual retry with the refreshed revision", async () => {
  write = async () =>
    Response.json(
      { json: { defined: false, code: "CONFLICT", status: 409, message: "Changed" } },
      { status: 409 },
    );
  await render();
  await act(async () => toggle().click());
  await click("Save");
  expect(container.textContent).toContain("This setting changed elsewhere. Refresh before saving.");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(button("Save").disabled).toBe(true);
  row.collaborationRevision = 10;
  await click("Refresh");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(writes).toHaveLength(1);
  write = async (input) =>
    response({ ...input, collaborationRevision: 11, canManageCollaboration: true });
  await click("Save");
  expect(writes[1]).toEqual({
    spaceId: "space-b",
    allowBotCollaboration: false,
    expectedCollaborationRevision: 10,
  });
  expect(container.textContent).toContain("Saved.");
});

for (const receipt of [
  null,
  {
    spaceId: "space-c",
    allowBotCollaboration: false,
    collaborationRevision: 8,
    canManageCollaboration: true,
  },
  {
    spaceId: "space-b",
    allowBotCollaboration: false,
    collaborationRevision: 7,
    canManageCollaboration: true,
  },
  {
    spaceId: "space-b",
    allowBotCollaboration: true,
    collaborationRevision: 8,
    canManageCollaboration: true,
  },
]) {
  it(`preserves intent after an unconfirmed receipt ${JSON.stringify(receipt)}`, async () => {
    write = async () => response(receipt);
    await render();
    await act(async () => toggle().click());
    await click("Save");
    expect(container.textContent).toContain(
      "Could not confirm this change. Refresh before saving.",
    );
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(button("Save").disabled).toBe(true);
    expect(container.textContent).not.toContain("Saved.");
    row.allowBotCollaboration = false;
    row.collaborationRevision = 8;
    await click("Refresh");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(button("Save").disabled).toBe(true);
    expect(writes).toHaveLength(1);
    expect(container.textContent).not.toContain("Saved.");
  });
}

it("does not restore editing from stale policy when a recovery refresh fails", async () => {
  write = async () => {
    throw new Error("offline");
  };
  await render();
  await act(async () => toggle().click());
  await click("Save");
  read = async () => {
    throw new Error("read offline");
  };
  await click("Refresh");
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(button("Save").disabled).toBe(true);
  expect(writes).toHaveLength(1);
});

for (const changed of ["target", "owner"] as const) {
  it(`ignores a late save after the ${changed} changes`, async () => {
    const pending = deferred<Response>();
    write = () => pending.promise;
    await render();
    await act(async () => toggle().click());
    await click("Save");
    expect(button("Saving…").disabled).toBe(true);
    expect(busy).toHaveBeenLastCalledWith(true);
    row = {
      ...original,
      id: changed === "target" ? "space-c" : "space-b",
      allowBotCollaboration: true,
      collaborationRevision: 20,
      canManageCollaboration: false,
    };
    await render(String(row.id), changed === "owner" ? "account-b/session-b" : undefined);
    await act(async () =>
      pending.resolve(
        response({
          spaceId: "space-b",
          allowBotCollaboration: false,
          collaborationRevision: 8,
          canManageCollaboration: true,
        }),
      ),
    );
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).not.toContain("Saved.");
    expect(writes).toHaveLength(1);
  });
}

it("ignores a previous target's read when the replacement target is already loaded", async () => {
  const pending = deferred<Response>();
  read = () => pending.promise;
  await render();
  row = { ...original, id: "space-c", allowBotCollaboration: false, canManageCollaboration: false };
  read = async () => response({ spaces: [row] });
  await render("space-c");
  await act(async () => pending.resolve(response({ spaces: [{ ...original }] })));
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(headers).toEqual(["space-b", "space-c"]);
});

it("admits only one write while a save is pending", async () => {
  const pending = deferred<Response>();
  write = () => pending.promise;
  await render();
  await act(async () => toggle().click());
  await act(async () => {
    button("Save").click();
    button("Save").click();
  });
  expect(writes).toHaveLength(1);
  expect(button("Saving…").disabled).toBe(true);
  await act(async () =>
    pending.resolve(
      response({
        spaceId: "space-b",
        allowBotCollaboration: false,
        collaborationRevision: 8,
        canManageCollaboration: true,
      }),
    ),
  );
  expect(container.textContent).toContain("Saved.");
});

it("shows the fresh server value when recovery removes the owner's write capability", async () => {
  write = async () => {
    throw new Error("Receipt unavailable");
  };
  await render();
  await act(async () => toggle().click());
  await click("Save");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  row.canManageCollaboration = false;
  row.collaborationRevision = 9;
  await click("Refresh");
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(container.textContent).toContain("Only the Space owner can change this.");
  expect(
    [...container.querySelectorAll("button")].some((item) => item.textContent === "Save"),
  ).toBe(false);
  expect(writes).toHaveLength(1);
});
