// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const voice = vi.hoisted(() => ({
  catalog: vi.fn(),
  credentials: vi.fn(),
  status: vi.fn(),
  voices: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setVoice: vi.fn(),
  setSpeechModel: vi.fn(),
}));
const scope = vi.hoisted(() => ({
  target: "space-b",
  generation: 0,
  calls: [] as Array<[string, string, unknown]>,
  clients: new Map(),
}));
const playback = vi.hoisted(() => ({ speak: vi.fn(), state: {} as { error?: string } }));
vi.mock("../lib/tts.js", () => ({ speaker: playback }));
vi.mock("../lib/space-rpc", () => {
  function binding() {
    const target = scope.target;
    const generation = scope.generation;
    const key = `${target}:${generation}`;
    if (!scope.clients.has(key))
      scope.clients.set(key, {
        client: {
          voice: Object.fromEntries(
            Object.entries(voice).map(([name, call]) => [
              name,
              (...args: unknown[]) => {
                scope.calls.push([target, name, args[0]]);
                return call(...args);
              },
            ]),
          ),
        },
        current: () => target === scope.target && generation === scope.generation,
      });
    return scope.clients.get(key);
  }
  return {
    useBoundSpaceId: () => scope.target,
    useSpaceRpc: () => binding().client,
    useSpaceRpcCurrent: () => binding().current,
  };
});

vi.mock("../lib/rpc", () => ({ rpc: { voice } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogTitle: Container,
    Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

beforeEach(() => {
  scope.target = "space-b";
  scope.generation = 0;
  scope.calls = [];
  scope.clients.clear();
  for (const call of Object.values(voice)) call.mockReset();
  playback.speak.mockReset().mockResolvedValue(undefined);
  playback.state = {};
});

const fish = {
  id: "cred-fish",
  provider: "fish-audio",
  hasKey: true,
  isDefault: true,
  voiceId: "voice-1",
  speechModel: "",
  transcribe: true,
};
const eleven = {
  id: "cred-eleven",
  provider: "elevenlabs",
  hasKey: true,
  isDefault: false,
  voiceId: "rachel",
  speechModel: "",
  transcribe: true,
};

function speechModelInput(container: HTMLElement): HTMLInputElement | undefined {
  return [...container.querySelectorAll("input")].find((input) => {
    const label = container.querySelector(`label[for="${input.id}"]`);
    return label?.textContent === "Speech model";
  });
}

it("uses the explicit settings client for voice reads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog.mockResolvedValue([]);
  voice.credentials.mockResolvedValue([]);
  voice.status.mockResolvedValue({ configured: false, ready: false, provider: null, voiceId: "" });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    expect(scope.calls.map(([target, procedure]) => [target, procedure])).toEqual([
      ["space-b", "catalog"],
      ["space-b", "credentials"],
      ["space-b", "status"],
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("saves a Fish speech model on the existing provider pane", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog.mockResolvedValue([
    { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
    { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
  ]);
  voice.credentials.mockResolvedValue([fish, eleven]);
  voice.status.mockResolvedValue({
    configured: true,
    ready: true,
    transcribe: true,
    provider: "fish-audio",
    voiceId: "voice-1",
  });
  voice.voices.mockImplementation(async ({ provider }: { provider?: string }) =>
    provider === "elevenlabs"
      ? [{ id: "rachel", label: "Rachel" }]
      : [{ id: "voice-1", label: "Aria" }],
  );
  voice.setSpeechModel.mockImplementation(async ({ speechModel }: { speechModel: string }) => ({
    ...fish,
    speechModel,
  }));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await act(async () => {
      root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const input = speechModelInput(container);
    expect(input).toBeTruthy();
    expect(input?.placeholder).toBe("Optional");

    await act(async () => {
      button("ElevenLabs").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(speechModelInput(container)).toBeUndefined();

    await act(async () => {
      button("Fish Audio").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const fishInput = speechModelInput(container);
    if (!fishInput) throw new Error("Missing speech model field");
    await act(async () => {
      fishInput.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(fishInput, "s1");
      fishInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      fishInput.blur();
    });

    expect(voice.setSpeechModel).toHaveBeenCalledWith(
      {
        provider: "fish-audio",
        speechModel: "s1",
      },
      { signal: expect.any(AbortSignal) },
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

function configuredVoice() {
  voice.catalog.mockResolvedValue([
    { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
  ]);
  voice.credentials.mockResolvedValue([{ ...fish, speechModel: "stable-model" }]);
  voice.status.mockResolvedValue({
    configured: true,
    ready: true,
    transcribe: true,
    provider: "fish-audio",
    voiceId: "voice-1",
  });
  voice.voices.mockResolvedValue([{ id: "voice-1", label: "Aria" }]);
}

function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.startsWith(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("retains the last legal voice settings when a read fails and retries the same target", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configuredVoice();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    expect(speechModelInput(container)?.value).toBe("stable-model");
    voice.credentials.mockRejectedValueOnce(new Error("Settings temporarily unavailable"));
    await act(async () => button(container, "Fish Audio").click());
    expect(container.textContent).toContain("Settings temporarily unavailable");
    expect(speechModelInput(container)?.value).toBe("stable-model");
    await act(async () => button(container, "Retry").click());
    expect(container.textContent).not.toContain("Settings temporarily unavailable");
    expect(speechModelInput(container)?.value).toBe("stable-model");
    expect(scope.calls.every(([target]) => target === "space-b")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("ignores old target metadata after another target commits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configuredVoice();
  const late = deferred<Array<typeof fish>>();
  voice.credentials.mockImplementation(() => (scope.target === "space-b" ? late.promise : []));
  voice.catalog.mockImplementation(async () =>
    scope.target === "space-b"
      ? [{ id: "fish-audio", name: "Old provider", description: "", transcribe: true }]
      : [],
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    scope.target = "space-c";
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    await act(async () => late.resolve([fish]));
    expect(container.textContent).not.toContain("Old provider");
    expect(container.querySelector("input")).toBeNull();
    expect(
      scope.calls.filter(([target, name]) => target === "space-b" && name === "voices"),
    ).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("does not refresh or publish a late connection result into a new target", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configuredVoice();
  const save = deferred<typeof fish>();
  voice.connect.mockReturnValue(save.promise);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        secret,
        "fake-replacement-key",
      );
      secret.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Replace key").click());
    scope.target = "space-c";
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    await act(async () => save.resolve(fish));
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    expect(
      scope.calls.filter(([target, name]) => target === "space-b" && name === "credentials"),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("Connected Fish Audio");
    expect(button(container, "Replace key").disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("gives the sample the target and aborts its lifetime on target change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configuredVoice();
  const sample = deferred<void>();
  playback.speak.mockReturnValue(sample.promise);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    await act(async () => button(container, "Hear a sample").click());
    const options = playback.speak.mock.lastCall?.[1];
    expect(options.spaceId).toBe("space-b");
    expect(options.signal.aborted).toBe(false);
    scope.target = "space-c";
    await act(async () => root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />));
    expect(options.signal.aborted).toBe(true);
    expect(options.isCurrent()).toBe(false);
    await act(async () => sample.resolve());
    expect(container.textContent).not.toContain("If you heard that, voice is ready.");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
