// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerTeaching } from "../components/computer-teaching";

const env = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  inputs: new Map<string, (text: string) => void>(),
  current: true,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => {
    env.inputs.set(props.accessibilityLabel, props.onChangeText);
    return <input aria-label={props.accessibilityLabel} value={props.value} readOnly />;
  },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./api", () => ({ rpc: env.rpc }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({}),
  isMobileScopeCurrent: () => env.current,
}));
vi.mock("./space-request-context", () => ({
  spaceRequestContext: async (_scope: unknown, current: () => boolean) => {
    if (!current()) throw new Error("stale");
    return { headers: { "x-rakazo-space-id": "space-1" } };
  },
}));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (s: string) => s }) }));
vi.mock("./user-error", () => ({ errorText: (error: Error) => error.message }));

const draft = (): TaughtSkill => ({
  id: "skill-1",
  botId: "bot-1",
  name: "Export",
  goal: "Export synthetic list",
  status: "draft",
  playbook: {
    whenToUse: "Weekly",
    inputs: ["List"],
    steps: ["Export"],
    howToCheck: "File exists",
    whatToReturn: "File",
    approvalBoundaries: "Ask",
    failureHandling: "Stop",
  },
  recording: { events: [], snapshots: [] },
  startedAt: null,
  stoppedAt: null,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
let view: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let saved: TaughtSkill;
const onState = vi.fn();
const beforeStop = vi.fn(async () => undefined);
const onChanged = vi.fn(async () => undefined);
const render = (active = true, supported = true) =>
  act(async () =>
    root.render(
      <ComputerTeaching
        botId="bot-1"
        active={active}
        supported={supported}
        onChanged={onChanged}
        onState={onState}
        beforeStop={beforeStop}
      />,
    ),
  );
const button = (name: string) =>
  [...view.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = (name: string) => act(async () => button(name).click());
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  env.inputs.clear();
  env.current = true;
  saved = draft();
  view = document.createElement("div");
  root = createRoot(view);
  env.rpc.mockImplementation(async (path: string, input: Record<string, unknown>) => {
    if (path === "skills/list") return [saved];
    if (path === "skills/updateDraft") {
      saved = {
        ...saved,
        name: input.name as string,
        playbook: input.playbook as TaughtSkill["playbook"],
      };
      return saved;
    }
    if (path === "skills/save") {
      saved = { ...saved, status: "saved" };
      return saved;
    }
    if (path === "skills/get") return saved;
    if (path === "skills/stop") {
      saved = { ...saved, status: "draft" };
      return saved;
    }
    if (path === "skills/testRun") return { runId: "run-1" };
    throw new Error(path);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("mobile computer teaching", () => {
  it("edits all fields, tests current content, reads saved content, and uses the existing routine route", async () => {
    await render();
    await click("Teach a task");
    await click("Edit");
    const fields = [
      "Name",
      "When to use",
      "Inputs",
      "Steps",
      "How to check",
      "What to return",
      "Approval boundaries",
      "Failure handling",
    ];
    for (const label of fields)
      await act(async () =>
        env.inputs.get(label)!(label === "Steps" ? "First\nSecond" : `Changed ${label}`),
      );
    await click("Test");
    expect(saved.name).toBe("Changed Name");
    expect(saved.playbook).toEqual({
      whenToUse: "Changed When to use",
      inputs: ["Changed Inputs"],
      steps: ["First", "Second"],
      howToCheck: "Changed How to check",
      whatToReturn: "Changed What to return",
      approvalBoundaries: "Changed Approval boundaries",
      failureHandling: "Changed Failure handling",
    });
    await click("View result");
    expect(env.push).toHaveBeenCalledWith({ pathname: "/thread", params: { botId: "bot-1" } });
    await click("Save");
    expect(env.rpc).toHaveBeenCalledWith("skills/get", { skillId: "skill-1" }, expect.anything());
    expect(button("Add to routine").disabled).toBe(false);
    await click("Add to routine");
    expect(env.push).toHaveBeenCalledWith({
      pathname: "/routine",
      params: { botId: "bot-1", skillId: "skill-1" },
    });
    await render(false);
    await render(true);
    expect(view.textContent).toContain("Changed Name");
  });
  it("restores recording, drains native input before stop, and presents its draft", async () => {
    saved.status = "recording";
    await render();
    expect(button("Stop teaching").disabled).toBe(false);
    await click("Recording");
    expect(button("Start recording")).toBeUndefined();
    await click("Stop teaching");
    expect(beforeStop).toHaveBeenCalledOnce();
    const stopIndex = env.rpc.mock.calls.findIndex(([path]) => path === "skills/stop");
    expect(beforeStop.mock.invocationCallOrder[0]).toBeLessThan(
      env.rpc.mock.invocationCallOrder[stopIndex]!,
    );
    expect(view.textContent).toContain("Export");
    expect(env.rpc.mock.calls.some(([path]) => path === "skills/start")).toBe(false);
  });
  it("hides start on unsupported computers and hides stale drafts while inactive", async () => {
    await render(true, false);
    await click("Skills");
    expect(button("Start recording")).toBeUndefined();
    await render(false, false);
    expect(button("Test").disabled).toBe(true);
  });
  it("keeps edited fields after a failed save and a reconnect", async () => {
    await render();
    await click("Teach a task");
    await click("Edit");
    await act(async () => env.inputs.get("Steps")!("Unsaved step"));
    env.rpc.mockRejectedValueOnce(new Error("offline"));
    await click("Save");
    await render(false);
    await render(true);
    expect(view.querySelector<HTMLInputElement>('[aria-label="Steps"]')?.value).toBe(
      "Unsaved step",
    );
  });
});

it("invalidates a captured request context across blur/refocus and session changes", async () => {
  await render();
  const context = env.rpc.mock.calls.find(([path]) => path === "skills/list")![2].requestContext;
  expect(context.headers["x-rakazo-space-id"]).toBe("space-1");
  expect(context.isCurrent()).toBe(true);
  await render(false);
  await render(true);
  expect(context.isCurrent()).toBe(false);
  const latest = env.rpc.mock.calls
    .filter(([path]) => path === "skills/list")
    .at(-1)![2].requestContext;
  expect(latest.isCurrent()).toBe(true);
  env.current = false;
  expect(latest.isCurrent()).toBe(false);
});
