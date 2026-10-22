// @vitest-environment jsdom

import { modelOptionKey } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../lib/rpc", () => ({ rpc: { models: { credentials: vi.fn(), list: vi.fn() } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
}));
vi.mock("./RoutineNativeEvents", () => ({ RoutineNativeEvents: () => null }));
vi.mock("./RoutineRunHistory", () => ({ RoutineRunHistory: () => null }));
vi.mock("./RoutineSchedule", () => ({ RoutineSchedule: () => null }));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuTrigger: Pass,
  };
});

import { rpc } from "../lib/rpc";
import { emptyRoutineDraft, RoutineEditor } from "./RoutineEditor";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("captures a connection revision in the routine draft and clears it when inheriting the bot model", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.models.credentials).mockResolvedValue([
    {
      id: "connection-a",
      provider: "openai-compatible",
      label: "Server",
      hasKey: true,
      isDefault: true,
      modelId: "shared",
      enabledModelIds: ["shared", "second"],
      connectionRevision: 4,
    },
  ]);
  vi.mocked(rpc.models.list).mockResolvedValue([]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let draft = emptyRoutineDraft();
  const render = () =>
    root.render(
      <RoutineEditor
        draft={draft}
        onChange={(next) => {
          draft = next;
          render();
        }}
        editing={null}
        timezone="UTC"
        webhook={{ path: "/test", secret: null, configured: false }}
        githubPath="/test"
        messageProviders={[]}
        connectionsRevision={0}
        scopeKey="space-a"
        onOpenApplications={() => undefined}
        saving={false}
        running={false}
        error={null}
        onBack={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        onTestRun={() => undefined}
        onDelete={() => undefined}
        onEnsureWebhook={async () => undefined}
      />,
    );
  await act(async () => {
    render();
    await Promise.resolve();
  });
  const model = container.querySelector<HTMLSelectElement>('select[aria-label="Routine model"]');
  if (!model) throw new Error("Missing Routine model picker");
  const pick = async (key: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(model, key);
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  await pick(modelOptionKey("openai-compatible", "second", "connection-a"));
  expect(draft).toMatchObject({ modelRevision: 4, modelDirty: true, thinkingLevel: "" });
  expect(draft.nativeTriggersDirty).toBe(false);
  await pick("");
  expect(draft).toMatchObject({ modelKey: "", modelDirty: true });
  expect(draft.modelRevision).toBeUndefined();
});
