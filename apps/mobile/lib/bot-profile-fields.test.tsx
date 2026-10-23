// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";
import NewBot from "../app/new";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  botId: "bot-fixture",
  deviceVoices: vi.fn(),
  voiceForBot: vi.fn(),
  setVoiceForBot: vi.fn(),
  stopVoicePlayback: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
}));
vi.mock("./bot-voices", () => ({
  voiceLabel: (voice: { language: string; name: string }) => `${voice.language} · ${voice.name}`,
  deviceVoices: mocks.deviceVoices,
  voiceForBot: mocks.voiceForBot,
  setVoiceForBot: mocks.setVoiceForBot,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => true }));
vi.mock("./voice", () => ({ stopVoicePlayback: mocks.stopVoicePlayback }));
vi.mock("expo-speech", () => ({ stop: mocks.stop, speak: mocks.speak }));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mocks.back, replace: mocks.replace }),
  useLocalSearchParams: () => ({ botId: mocks.botId }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    style,
    accessibilityLabel,
    accessibilityRole,
    accessibilityValue,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { text: string };
  }) =>
    createElement(
      "div",
      {
        "data-style": JSON.stringify(style),
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-valuetext": accessibilityValue?.text,
      },
      children,
    );
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
    ScrollView: view,
    View: view,
    Text: ({ children, style }: { children?: ReactNode; style: unknown }) =>
      createElement("span", { "data-style": JSON.stringify(style) }, children),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      placeholder,
      maxLength,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel?: string;
      placeholder?: string;
      maxLength?: number;
    }) =>
      createElement("textarea", {
        value,
        "aria-label": accessibilityLabel ?? placeholder,
        maxLength,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
  };
});
vi.mock("./native", () => ({
  native: { tertiaryLabel: "muted" },
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: { name: string }) => text.replace("{name}", values?.name ?? "");
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/computer-mode-picker", () => ({
  ComputerModePicker: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement(
      "select",
      {
        "aria-label": "Computer mode",
        value,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      ...["team", "dedicated"].map((mode) =>
        createElement("option", { key: mode, value: mode }, mode),
      ),
    ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, android }: { ios: string; android: string }) =>
    createElement("i", { "data-ios": ios, "data-android": android }),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: { id: string; title: string; state: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) =>
    createElement(
      "section",
      { "data-menu": title },
      children,
      ...actions.map((action) =>
        createElement(
          "button",
          {
            type: "button",
            key: action.id,
            "data-state": action.state,
            "data-choice": action.id,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));

vi.mock("./focus-prompt", () => ({ allowFocusPrompt: vi.fn(), scheduleFocusPrompt: vi.fn() }));
vi.mock("../components/sheet-header", () => ({ cancelHeaderOptions: () => ({}) }));

const acceptedInstructions = "  Keep rules\n\nindependent.\n";
const acceptedBot = {
  id: "bot-fixture",
  name: "Fixture",
  title: "Research",
  description: "Public role",
  instructions: acceptedInstructions,
  color: "#62A8EC",
  computerMode: "team",
  autoSpeak: false,
};

async function change(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("native profile fields", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.botId = "bot-fixture";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "bots/get") return acceptedBot;
      if (procedure === "bots/create") return acceptedBot;
      if (procedure === "me") return {};
      return [];
    });
    mocks.deviceVoices.mockResolvedValue([]);
    mocks.voiceForBot.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const field = (label: string) =>
    container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  const submit = async (label = "Save") =>
    act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === label)!
        .click(),
    );

  it("keeps public description edits independent from accepted execution rules", async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    await change(field("What this bot is for"), "A new public role");
    await submit();
    expect(mocks.rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot-fixture",
      description: "A new public role",
    });
  });
  it.each(["  New rules\n\nkeep whitespace.\n", ""])(
    "saves raw rules with the original accepted comparison: %j",
    async (instructions) => {
      await act(async () => root.render(<BotSettingsScreen />));
      expect(field("Instructions")?.value).toBe(acceptedInstructions);
      await change(field("Instructions"), instructions);
      await submit();
      expect(mocks.rpc).toHaveBeenCalledWith("bots/update", {
        botId: "bot-fixture",
        instructions,
        expectedInstructions: acceptedInstructions,
      });
    },
  );

  it("creates distinct public and execution fields without trimming rules", async () => {
    await act(async () => root.render(<NewBot />));
    await change(field("Name this bot"), "New bot");
    await change(field("What this bot is for"), "Public role");
    expect(field("Instructions")).not.toBeNull();
    await change(field("Instructions"), "  Private rules\n");
    await submit("Create");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "bots/create",
      expect.objectContaining({ description: "Public role", instructions: "  Private rules\n" }),
    );
  });

  it.each(["create", "edit"])(
    "rejects long pasted rules without truncating the %s draft",
    async (mode) => {
      await act(async () => root.render(mode === "create" ? <NewBot /> : <BotSettingsScreen />));
      if (mode === "create") await change(field("Name this bot"), "New bot");
      const rules = field("Instructions");
      expect(rules.hasAttribute("maxlength")).toBe(false);
      await change(rules, "x".repeat(20_001));
      await submit(mode === "create" ? "Create" : "Save");
      expect(rules.value).toHaveLength(20_001);
      expect(container.textContent).toContain("Instructions must be at most");
      expect(
        mocks.rpc.mock.calls.some(
          ([proc]) =>
            proc === "bots/create" || proc === "bots/update" || proc === "bots/setComputer",
        ),
      ).toBe(false);
    },
  );

  it("keeps the accepted rule comparison and the draft after a conflict", async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    mocks.rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "bots/update")
        throw new Error("Instructions changed. Reload and try again.");
      return [];
    });
    await change(field("Instructions"), "  My replacement\n");
    await submit();
    expect(mocks.back).not.toHaveBeenCalled();
    expect(field("Instructions").value).toBe("  My replacement\n");
    expect(container.textContent).toContain("Instructions changed");
    await submit();
    const updates = mocks.rpc.mock.calls.filter(([proc]) => proc === "bots/update");
    expect(updates).toHaveLength(2);
    for (const [, input] of updates)
      expect(input).toEqual({
        botId: "bot-fixture",
        instructions: "  My replacement\n",
        expectedInstructions: acceptedInstructions,
      });
  });

  it("saves other settings after a classified rule conflict while retaining the raw rule draft", async () => {
    let saves = 0;
    mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === "bots/get") return acceptedBot;
      if (procedure === "bots/update") {
        saves++;
        if (saves === 1)
          throw Object.assign(new Error("Instructions changed"), {
            code: "CONFLICT",
            status: 409,
            data: { reason: "instructions_changed" },
          });
        return { ...acceptedBot, ...input, instructions: "A concurrent writer's accepted rules" };
      }
      if (procedure === "me") return {};
      return [];
    });
    await act(async () => root.render(<BotSettingsScreen />));
    const rawDraft = "  Preserve this draft\n\n";
    await change(field("Instructions"), rawDraft);
    await change(field("What this bot is for"), "A new public role");
    await submit();
    expect(mocks.back).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Save other settings");
    await submit("Save other settings");
    const updates = mocks.rpc.mock.calls.filter(([proc]) => proc === "bots/update");
    expect(updates.map(([, input]) => input)).toEqual([
      {
        botId: "bot-fixture",
        description: "A new public role",
        instructions: rawDraft,
        expectedInstructions: acceptedInstructions,
      },
      { botId: "bot-fixture", description: "A new public role" },
    ]);
    expect(mocks.back).not.toHaveBeenCalled();
    expect(field("Instructions").value).toBe(rawDraft);
    await change(field("What this bot is for"), "One more public role");
    await submit("Save other settings");
    expect(mocks.rpc.mock.calls.filter(([proc]) => proc === "bots/update")[2]![1]).toEqual({
      botId: "bot-fixture",
      description: "One more public role",
    });
    expect(field("Instructions").value).toBe(rawDraft);
  });

  it.each([
    { code: "CONFLICT", status: 409 },
    { code: "CONFLICT", status: 409, data: { reason: "model_changed" } },
    { status: 409, message: "Instructions changed" },
  ])("does not classify an unrelated model conflict as a rule conflict: %j", async (details) => {
    await act(async () => root.render(<BotSettingsScreen />));
    mocks.rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "bots/update")
        throw Object.assign(new Error("Instructions changed"), details);
      return [];
    });
    await change(field("Instructions"), "Unaccepted rules");
    await submit();
    expect(container.textContent).not.toContain("Save other settings");
    expect(field("Instructions").value).toBe("Unaccepted rules");
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "ignores a late rule conflict across changed route ownership (ABA: %s)",
    async (aba) => {
      let rejectOld!: (error: Error) => void;
      let reads = 0;
      mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
        if (procedure === "bots/get")
          return { ...acceptedBot, id: input.botId, instructions: `Accepted rules ${++reads}` };
        if (procedure === "bots/update" && input.instructions === "Old route draft")
          return new Promise((_resolve, reject) => {
            rejectOld = reject;
          });
        if (procedure === "bots/update") return { ...acceptedBot, ...input };
        if (procedure === "me") return {};
        return [];
      });
      await act(async () => root.render(<BotSettingsScreen />));
      await change(field("Instructions"), "Old route draft");
      await submit();
      expect(rejectOld).toBeTypeOf("function");
      mocks.botId = "bot-b";
      await act(async () => root.render(<BotSettingsScreen />));
      if (aba) {
        mocks.botId = "bot-fixture";
        await act(async () => root.render(<BotSettingsScreen />));
      }
      const accepted = field("Instructions").value;
      await act(async () =>
        rejectOld(
          Object.assign(new Error("Old rules changed"), {
            code: "CONFLICT",
            data: { reason: "instructions_changed" },
          }),
        ),
      );
      expect(container.textContent).not.toContain("Save other settings");
      expect(container.textContent).not.toContain("Old rules changed");
      await change(field("Instructions"), "Current route draft");
      await submit();
      expect(mocks.rpc).toHaveBeenLastCalledWith("bots/update", {
        botId: mocks.botId,
        instructions: "Current route draft",
        expectedInstructions: accepted,
      });
    },
  );

  it("records a successful computer change before a rule conflict so recovery does not repeat it", async () => {
    let serverMode = "team";
    let conflict = true;
    mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === "bots/get") return acceptedBot;
      if (procedure === "bots/setComputer") {
        serverMode = String(input.mode);
        return {};
      }
      if (procedure === "bots/update") {
        if (conflict) {
          conflict = false;
          throw Object.assign(new Error("Instructions changed"), {
            code: "CONFLICT",
            data: { reason: "instructions_changed" },
          });
        }
        return { ...acceptedBot, ...input, computerMode: serverMode };
      }
      if (procedure === "me") return {};
      return [];
    });
    await act(async () => root.render(<BotSettingsScreen />));
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Computer mode"]',
      )!;
      select.value = "dedicated";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await change(field("Instructions"), "Rules still unresolved");
    await submit();
    await submit("Save other settings");
    await change(field("What this bot is for"), "Another public role");
    await submit("Save other settings");
    expect(mocks.rpc.mock.calls.filter(([proc]) => proc === "bots/setComputer")).toHaveLength(1);
    expect(field("Instructions").value).toBe("Rules still unresolved");
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it("sends an explicit empty rule field for new bots instead of copying description", async () => {
    await act(async () => root.render(<NewBot />));
    await change(field("Name this bot"), "New bot");
    await change(field("What this bot is for"), "Public role");
    await submit("Create");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "bots/create",
      expect.objectContaining({ description: "Public role", instructions: "" }),
    );
  });
});
