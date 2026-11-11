// @vitest-environment jsdom

import { encodeLoginSecret } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const botSecrets = vi.hoisted(() => ({
  list: vi.fn(),
  listForEdit: vi.fn(),
  listForSpace: vi.fn(),
  loginFieldsForEdit: vi.fn(),
  put: vi.fn(),
  putForEdit: vi.fn(),
  remove: vi.fn(),
  removeForEdit: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({ rpc: { botSecrets } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Checkbox: () => <span />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { BotCredentialsSection } from "./bot-credentials";

const FAKE_VALUE = "fake-value-SENTINEL-1";
const stamp = "2026-09-01T00:00:00.000Z";
const rows = [
  { name: "api", origin: "https://api.example.com", auth: { type: "bearer" } },
  {
    name: "custom",
    origin: "https://svc.example.com",
    auth: { type: "header", name: "X-Api-Key" },
  },
  {
    name: "router",
    origin: "http://192.168.1.20:8080",
    auth: { type: "basic", username: "admin" },
  },
  { name: "portal", origin: "https://portal.example.com", auth: { type: "login" } },
].map((row) => ({ ...row, createdAt: stamp, updatedAt: stamp, revision: `rev-${row.name}` }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render() {
  await act(async () => {
    root.render(<BotCredentialsSection botId="bot-1" />);
  });
  await flush();
}

function byTestId<T extends HTMLElement>(testId: string): T {
  const found = container.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Missing element: ${testId}`);
  return found;
}

async function type(testId: string, value: string) {
  const element = byTestId<HTMLInputElement | HTMLSelectElement>(testId);
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function click(testId: string) {
  await act(async () => {
    byTestId<HTMLButtonElement>(testId).click();
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  botSecrets.list.mockReset();
  botSecrets.listForSpace.mockReset();
  botSecrets.loginFieldsForEdit.mockReset();
  botSecrets.listForEdit.mockReset().mockResolvedValue(rows);
  botSecrets.put.mockReset();
  botSecrets.putForEdit.mockReset();
  botSecrets.remove.mockReset();
  botSecrets.removeForEdit.mockReset().mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BotCredentialsSection", () => {
  it("lists credential metadata and no values", async () => {
    await render();
    expect(botSecrets.listForEdit).toHaveBeenCalledWith({ botId: "bot-1" });
    const text = container.textContent ?? "";
    expect(container.querySelectorAll('[data-testid="bot-credential-row"]')).toHaveLength(4);
    for (const expected of [
      "https://api.example.com",
      "Bearer token",
      'Header "X-Api-Key"',
      "http://192.168.1.20:8080",
      "Basic auth (admin)",
      "Website login",
    ]) {
      expect(text).toContain(expected);
    }
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });

  it("shows an empty state", async () => {
    botSecrets.listForEdit.mockResolvedValue([]);
    await render();
    expect(byTestId("bot-credentials-empty").textContent).toContain("No credentials saved");
  });

  it.each([true, false])(
    "keeps an older server read-only even with an empty list: %s",
    async (empty) => {
      botSecrets.listForEdit.mockRejectedValue({ code: "NOT_FOUND" });
      botSecrets.list.mockResolvedValue(empty ? [] : rows);
      await render();
      expect(botSecrets.list).toHaveBeenCalledWith({ botId: "bot-1" });
      expect(container.textContent).toContain("Credential changes are unavailable on this server.");
      expect(container.querySelector('[data-testid="credential-add"]')).toBeNull();
      expect(container.querySelector('[data-testid="credential-remove-api"]')).toBeNull();
      expect(container.querySelector('[data-testid="credential-replace-api"]')).toBeNull();
    },
  );

  it("does not fall back to unchecked writes when the server changes after the list loaded", async () => {
    botSecrets.listForEdit.mockResolvedValueOnce(rows).mockRejectedValueOnce({ code: "NOT_FOUND" });
    botSecrets.list.mockResolvedValue(rows);
    botSecrets.putForEdit.mockRejectedValueOnce({ code: "NOT_FOUND" });
    await render();
    await click("credential-add");
    await type("credential-name", "api2");
    await type("credential-origin", "https://api.example.com");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");
    expect(botSecrets.putForEdit).toHaveBeenCalledOnce();
    expect(botSecrets.put).not.toHaveBeenCalled();
    expect(botSecrets.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Credential changes are unavailable on this server.");
    expect(container.querySelector('[data-testid="credential-add-form"]')).toBeNull();
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("adds a header credential and clears the value, then refetches", async () => {
    const savedHeader = rows[1];
    if (!savedHeader) throw new Error("missing header fixture");
    let resolvePut: (row: typeof savedHeader) => void = () => undefined;
    botSecrets.putForEdit.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    await render();
    await click("credential-add");
    await type("credential-name", "custom");
    await type("credential-origin", "https://svc.example.com");
    await type("credential-auth-type", "header");
    await type("credential-header-name", "X-Api-Key");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId<HTMLInputElement>("credential-value").type).toBe("password");
    expect(byTestId<HTMLInputElement>("credential-value").autocomplete).toBe("new-password");
    await click("credential-add-save");
    expect(byTestId<HTMLInputElement>("credential-value").value).toBe("");
    expect(container.innerHTML).not.toContain(FAKE_VALUE);

    await act(async () => {
      resolvePut(savedHeader);
    });
    await flush();

    expect(botSecrets.putForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      destination: {
        name: "custom",
        origin: "https://svc.example.com",
        auth: { type: "header", name: "X-Api-Key" },
      },
      value: FAKE_VALUE,
      expectedRevision: null,
    });
    expect(botSecrets.listForEdit).toHaveBeenCalledTimes(2);
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears the value and shows the server error when saving fails", async () => {
    botSecrets.putForEdit.mockRejectedValue(
      new Error("Invalid credential destination — origin: Expected an HTTPS origin"),
    );
    await render();
    await click("credential-add");
    await type("credential-name", "router2");
    await type("credential-origin", "http://192.168.1.21");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(botSecrets.putForEdit).toHaveBeenCalledTimes(1);
    expect(byTestId<HTMLInputElement>("credential-value").value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid credential destination",
    );
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("encodes a website login with encodeLoginSecret", async () => {
    botSecrets.putForEdit.mockResolvedValue(rows[3]);
    await render();
    await click("credential-add");
    await type("credential-name", "portal2");
    await type("credential-origin", "https://portal.example.com");
    await type("credential-auth-type", "login");
    await type("credential-username", " jamie ");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(botSecrets.putForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      destination: {
        name: "portal2",
        origin: "https://portal.example.com",
        auth: { type: "login" },
      },
      value: encodeLoginSecret({ username: "jamie", password: FAKE_VALUE }),
      expectedRevision: null,
    });
  });

  it("replaces a value on the same destination", async () => {
    botSecrets.putForEdit.mockResolvedValue(rows[2]);
    await render();
    await click("credential-replace-router");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");

    expect(botSecrets.putForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      destination: {
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: { type: "basic", username: "admin" },
      },
      value: FAKE_VALUE,
      expectedRevision: "rev-router",
    });
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows an unreadable saved row with remove but no replace", async () => {
    botSecrets.listForEdit.mockResolvedValue([
      {
        name: "Legacy Name",
        origin: "https://legacy.example.com",
        auth: null,
        createdAt: stamp,
        updatedAt: stamp,
        revision: "legacy-revision",
      },
    ]);
    await render();
    const row = byTestId("bot-credential-row");
    expect(row.textContent).toContain("These saved settings can't be read.");
    expect(container.querySelector('[data-testid="credential-replace-Legacy Name"]')).toBeNull();
    await click("credential-remove-Legacy Name");
    expect(container.textContent).toContain("Remove Legacy Name?");
    await click("credential-remove-confirm-Legacy Name");
    expect(botSecrets.removeForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      name: "Legacy Name",
      expectedRevision: "legacy-revision",
    });
    expect(botSecrets.listForEdit).toHaveBeenCalledTimes(2);
  });

  it("hides replace and shows the unreadable row when a readable auth has an invalid name", async () => {
    botSecrets.listForEdit.mockResolvedValue([
      {
        name: "Legacy Name",
        origin: "https://legacy.example.com",
        auth: { type: "bearer" },
        createdAt: stamp,
        updatedAt: stamp,
        revision: "legacy-revision",
      },
    ]);
    await render();
    const row = byTestId("bot-credential-row");
    expect(row.textContent).toContain("These saved settings can't be read.");
    expect(container.querySelector('[data-testid="credential-replace-Legacy Name"]')).toBeNull();
    await click("credential-remove-Legacy Name");
    expect(container.textContent).toContain("Remove Legacy Name?");
    await click("credential-remove-confirm-Legacy Name");
    expect(botSecrets.removeForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      name: "Legacy Name",
      expectedRevision: "legacy-revision",
    });
    expect(botSecrets.listForEdit).toHaveBeenCalledTimes(2);
  });

  it("keeps the add form open when save succeeds but list reload fails", async () => {
    botSecrets.putForEdit.mockResolvedValue(rows[0]);
    botSecrets.listForEdit
      .mockResolvedValueOnce(rows)
      .mockRejectedValueOnce(new Error("list failed"));
    await render();
    await click("credential-add");
    await type("credential-name", "api2");
    await type("credential-origin", "https://api.example.com");
    await type("credential-value", FAKE_VALUE);
    await click("credential-add-save");

    expect(botSecrets.putForEdit).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="credential-add-form"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load credentials.",
    );
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("clears a typed replace value when opening remove on another row", async () => {
    await render();
    await click("credential-replace-api");
    await type("credential-replace-value", FAKE_VALUE);
    expect(byTestId<HTMLInputElement>("credential-replace-value").value).toBe(FAKE_VALUE);
    await click("credential-remove-custom");
    expect(container.querySelector('[data-testid="credential-replace-value"]')).toBeNull();
    expect(container.textContent).toContain("Remove custom?");
    // Protected value must not linger in any live input.
    const leaked = Array.from(container.querySelectorAll("input, textarea")).some((input) =>
      (input as HTMLInputElement).value.includes(FAKE_VALUE),
    );
    expect(leaked).toBe(false);
  });

  it("removes only after an explicit confirm", async () => {
    await render();
    await click("credential-remove-api");
    expect(botSecrets.removeForEdit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remove api?");
    await click("credential-remove-confirm-api");
    expect(botSecrets.removeForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      name: "api",
      expectedRevision: "rev-api",
    });
    expect(botSecrets.listForEdit).toHaveBeenCalledTimes(2);
  });

  it("rechecks the revision after a conflict and requires a fresh remove confirmation", async () => {
    const refreshed = rows.map((row) => (row.name === "api" ? { ...row, revision: "newer" } : row));
    botSecrets.listForEdit.mockResolvedValueOnce(rows).mockResolvedValueOnce(refreshed);
    botSecrets.removeForEdit.mockRejectedValueOnce({
      code: "CONFLICT",
      message: "Credential changed.",
    });
    await render();
    await click("credential-remove-api");
    await click("credential-remove-confirm-api");
    expect(botSecrets.removeForEdit).toHaveBeenCalledTimes(1);
    expect(botSecrets.listForEdit).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="credential-remove-confirm-api"]')).toBeNull();
    await click("credential-remove-api");
    await click("credential-remove-confirm-api");
    expect(botSecrets.removeForEdit).toHaveBeenLastCalledWith({
      botId: "bot-1",
      name: "api",
      expectedRevision: "newer",
    });
  });
});

describe("BotCredentialsSection command variables", () => {
  const commandRow = {
    name: "netbird-setup-key",
    origin: "",
    auth: { type: "command" },
    createdAt: stamp,
    updatedAt: stamp,
    revision: "rev-command",
  };

  it("adds a command variable with no origin and shows its derived name", async () => {
    botSecrets.putForEdit.mockResolvedValue(commandRow);
    await render();
    await click("credential-add");
    await type("credential-origin", "https://leftover.example.com");
    await type("credential-auth-type", "command");
    expect(container.querySelector('[data-testid="credential-origin"]')).toBeNull();
    await type("credential-name", "netbird-setup-key");
    expect(byTestId("credential-command-variable").textContent).toContain("$NETBIRD_SETUP_KEY");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(false);
    await click("credential-add-save");

    expect(botSecrets.putForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
      expectedRevision: null,
    });
    expect(botSecrets.putForEdit.mock.calls[0]![0].destination).not.toHaveProperty("origin");
    expect(container.innerHTML).not.toContain(FAKE_VALUE);
  });

  it("shows the blocklist error and cannot save a reserved name", async () => {
    await render();
    await click("credential-add");
    await type("credential-auth-type", "command");
    await type("credential-name", "ld_preload");
    await type("credential-value", FAKE_VALUE);
    expect(byTestId("credential-command-variable-error").textContent).toContain(
      "$LD_PRELOAD is reserved",
    );
    expect(container.querySelector('[data-testid="credential-command-variable"]')).toBeNull();
    expect(byTestId<HTMLButtonElement>("credential-add-save").disabled).toBe(true);
    await act(async () => {
      byTestId<HTMLFormElement>("credential-add-form").requestSubmit();
    });
    await flush();
    expect(botSecrets.putForEdit).not.toHaveBeenCalled();
  });

  it("lists a command variable with its variable name and replaces its value", async () => {
    botSecrets.listForEdit.mockResolvedValue([commandRow]);
    botSecrets.putForEdit.mockResolvedValue(commandRow);
    await render();
    const row = byTestId("bot-credential-row");
    expect(row.textContent).toContain("Command variable · $NETBIRD_SETUP_KEY");
    await click("credential-replace-netbird-setup-key");
    await type("credential-replace-value", FAKE_VALUE);
    await click("credential-replace-save");
    expect(botSecrets.putForEdit).toHaveBeenCalledWith({
      botId: "bot-1",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
      expectedRevision: "rev-command",
    });
  });
});

describe("Space credential editor", () => {
  const login = { ...rows[3]!, namedLogin: true };

  const groups = (revision = login.revision) => [
    {
      botId: "bot-1",
      botName: "Example Bot",
      credentials: [{ ...login, revision }],
    },
  ];

  async function renderSpace() {
    await act(async () => root.render(<BotCredentialsSection defaultBotId="bot-1" />));
  }

  it("keeps Add disabled while a login replacement is loading", async () => {
    botSecrets.listForSpace.mockResolvedValue(groups());
    let complete!: (fields: { label: string; hidden: boolean }[]) => void;
    botSecrets.loginFieldsForEdit.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await renderSpace();
    await click("credential-replace-portal");
    expect(byTestId<HTMLButtonElement>("credential-add").disabled).toBe(true);
    await click("credential-add");
    await act(async () => complete([{ label: "Password", hidden: true }]));
    expect(container.querySelector('[data-testid="credential-add-form"]')).toBeNull();
    expect(byTestId("credential-replace-save")).toBeDefined();
  });

  it("dismisses an old remove confirmation if a refresh reads a new revision", async () => {
    botSecrets.listForSpace.mockResolvedValue(groups());
    await renderSpace();
    const retry = () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    botSecrets.putForEdit.mockResolvedValue({
      ...login,
      name: "new-token",
      auth: { type: "command" },
      revision: "new-token-revision",
    });
    await click("credential-add");
    await type("credential-name", "new-token");
    await type("credential-auth-type", "command");
    await type("credential-value", FAKE_VALUE);
    botSecrets.listForSpace.mockRejectedValueOnce(new Error("temporary fixture outage"));
    await click("credential-add-save");
    await click("credential-remove-portal");
    expect(byTestId("credential-remove-confirm-portal")).toBeDefined();
    botSecrets.listForSpace.mockResolvedValue(groups("newer-portal-revision"));
    await act(async () => retry()?.click());
    expect(container.querySelector('[data-testid="credential-remove-confirm-portal"]')).toBeNull();
    expect(botSecrets.removeForEdit).not.toHaveBeenCalled();
  });
});
