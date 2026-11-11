// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { ImageInputChoice } from "./image-input-choice";

vi.mock("../../lib/rpc", () => ({ rpc: { threads: { imageInput: vi.fn() } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (s: TemplateStringsArray) => s.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    variant?: string;
  }) => <button {...props}>{children}</button>,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(rpc.threads.imageInput).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const props: ComponentProps<typeof ImageInputChoice> = {
  value: "confirm",
  onChange: vi.fn(),
  target: { botId: "bot-a", text: "Inspect invoice" },
  revision: "first",
  onChooseModel: vi.fn(),
};

it.each([
  ["supported", "Can see images"],
  ["unsupported", "This model cannot see images"],
  ["unknown", "This model's image capability is unconfirmed"],
] as const)("renders %s and preserves an explicit file choice", async (status, message) => {
  vi.mocked(rpc.threads.imageInput).mockResolvedValue({ status });
  const onChange = vi.fn();
  await act(async () => root.render(<ImageInputChoice {...props} onChange={onChange} />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(message);
  const file = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "As file",
  )!;
  act(() => file.click());
  expect(onChange).toHaveBeenCalledWith("file");
  await act(async () => root.render(<ImageInputChoice {...props} value="file" />));
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("ignores a late capability answer after the actual recipient changes", async () => {
  let release: (result: { status: "supported" }) => void = () => {};
  vi.mocked(rpc.threads.imageInput).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => root.render(<ImageInputChoice {...props} />));
  vi.mocked(rpc.threads.imageInput).mockResolvedValue({ status: "unsupported" });
  await act(async () =>
    root.render(
      <ImageInputChoice {...props} target={{ botId: "bot-b", text: "Inspect invoice" }} />,
    ),
  );
  await act(async () => release({ status: "supported" }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "This model cannot see images",
  );
  expect(vi.mocked(rpc.threads.imageInput).mock.calls.at(-1)?.[0]).toMatchObject({
    botId: "bot-b",
  });
});

it("opens settings for the actual blocked group recipient", async () => {
  vi.mocked(rpc.threads.imageInput).mockResolvedValue({ status: "unsupported", botId: "bot-b" });
  const onChooseModel = vi.fn();
  await act(async () =>
    root.render(
      <ImageInputChoice {...props} target={{ groupId: "group-a" }} onChooseModel={onChooseModel} />,
    ),
  );
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Choose model",
  )!;
  act(() => button.click());
  expect(onChooseModel).toHaveBeenCalledWith("bot-b");
});

it("shows the blocked bot while refreshing a stale positive preview", async () => {
  const target = { groupId: "group-a" };
  const onChooseModel = vi.fn();
  vi.mocked(rpc.threads.imageInput).mockResolvedValueOnce({ status: "supported" });
  await act(async () =>
    root.render(<ImageInputChoice {...props} target={target} onChooseModel={onChooseModel} />),
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Can see images");
  vi.mocked(rpc.threads.imageInput).mockImplementationOnce(() => new Promise(() => {}));
  await act(async () =>
    root.render(
      <ImageInputChoice
        {...props}
        revision="refused"
        target={target}
        refusal={{ status: "unsupported", botId: "bot-b" }}
        onChooseModel={onChooseModel}
      />,
    ),
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "This model cannot see images",
  );
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Choose model",
  )!;
  act(() => button.click());
  expect(onChooseModel).toHaveBeenCalledWith("bot-b");
});
