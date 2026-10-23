// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { Bot } from "@rakazo/contracts";
import { BOT_TEMPLATES } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, createRef, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";
import NewBot from "../app/new";

import type { ThreadComposerHandle } from "../components/thread-composer";
import { ThreadComposer } from "../components/thread-composer";
import { insertMobileBotExample, readMobileBotExample } from "./bot-template-examples";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";

const testFileUrl = import.meta.url;

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  close: () => {},
  scope: {
    apiBase: "https://api.example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: "space-1" as string | null,
    spaceGeneration: 1,
    selectionSeq: 1,
  },
  listeners: new Set<() => void>(),
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
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  captureApiRequestContext: async () => ({
    apiBase: mocks.scope.apiBase,
    sessionGeneration: mocks.scope.sessionGeneration,
    headers: { authorization: "Bearer synthetic", "x-rakazo-space-id": mocks.scope.spaceId },
  }),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ ...mocks.scope }),
  mobileScopeKey: () => JSON.stringify(mocks.scope),
  isMobileScopeCurrent: (scope: unknown) => JSON.stringify(scope) === JSON.stringify(mocks.scope),
  subscribeMobileScope: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => mocks.scope.sessionGeneration,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({
    back: mocks.back,
    replace: mocks.replace,
    push: mocks.push,
    canDismiss: () => false,
    canGoBack: () => true,
  }),
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
    ActivityIndicator: () => null,
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
vi.mock("../components/glass-surface", () => ({
  GlassSurface: ({ children }: { children: ReactNode }) => children,
}));
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
vi.mock("../components/sheet-header", () => ({
  cancelHeaderOptions: (_label: string, close: () => void) => {
    mocks.close = close;
    return {};
  },
}));

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

function createdBot(input: Record<string, unknown>, patch: Partial<Bot> = {}): Bot {
  return {
    id: "created-fixture",
    spaceId: "space-1",
    threadId: "created-thread",
    name: "Fixture",
    title: "",
    description: "",
    instructions: "",
    color: "synthetic",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: "2026-10-24T00:00:00Z",
    createdAt: "2026-10-24T00:00:00Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: String(input.spawnKey),
    ...input,
    ...patch,
  } as Bot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

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
    mocks.scope = {
      apiBase: "https://api.example.test",
      apiGeneration: 1,
      sessionGeneration: mocks.scope.sessionGeneration + 1,
      spaceId: "space-1",
      spaceGeneration: 1,
      selectionSeq: 1,
    };
    mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === "bots/get") return acceptedBot;
      if (procedure === "bots/create") return createdBot(input);
      if (procedure === "me") return { userId: "user-1", spaceId: "space-1" };
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
      expect.objectContaining({
        requestContext: expect.objectContaining({
          headers: expect.objectContaining({ "x-rakazo-space-id": "space-1" }),
        }),
      }),
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
      expect.objectContaining({
        requestContext: expect.objectContaining({
          headers: expect.objectContaining({ "x-rakazo-space-id": "space-1" }),
        }),
      }),
    );
  });

  it.each(BOT_TEMPLATES)(
    "previews $templateId without creating and submits its editable fields explicitly",
    async (template) => {
      await act(async () => root.render(<NewBot />));
      await submit(template.name);
      expect(field("Name this bot").value).toBe(template.name);
      expect(field("Describe what this bot does").value).toBe(template.title);
      expect(field("What this bot is for").value).toBe(template.description);
      expect(field("Instructions").value).toBe(template.instructions);
      expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "bots/create")).toBe(false);
      const raw = `  Edited ${template.instructions}\n`;
      await change(field("Instructions"), raw);
      await submit("Create");
      const creates = mocks.rpc.mock.calls.filter(([procedure]) => procedure === "bots/create");
      expect(creates).toHaveLength(1);
      expect(creates[0]![1]).toEqual({
        name: template.name,
        title: template.title,
        description: template.description,
        instructions: raw,
        computerMode: "team",
        notifyOnFinish: true,
        spawnKey: expect.stringMatching(/^bot-create:/),
      });
      expect(mocks.replace).toHaveBeenCalledWith({
        pathname: "/thread",
        params: { botId: "created-fixture", name: template.name },
      });
      expect(readMobileBotExample("created-fixture")?.text).toBe(template.examplePrompt);
      expect(
        mocks.rpc.mock.calls.some(([procedure]) => /messages\/send|tasks\/create/.test(procedure)),
      ).toBe(false);
    },
  );

  it.each(["template", "blank"] as const)(
    "creates the %s preview without scheduling the legacy focus flow",
    async (mode) => {
      await act(async () => root.render(<NewBot />));
      const template = BOT_TEMPLATES[0]!;
      await submit(mode === "template" ? template.name : "Blank bot");
      if (mode === "blank") await change(field("Name this bot"), "Blank preview");
      const name = field("Name this bot").value;
      await submit("Create");
      expect(mocks.replace).toHaveBeenCalledWith({
        pathname: "/thread",
        params: { botId: "created-fixture", name },
      });
      expect(mocks.rpc.mock.calls.map(([procedure]) => procedure)).toEqual(["me", "bots/create"]);
      expect(allowFocusPrompt).not.toHaveBeenCalled();
      expect(scheduleFocusPrompt).not.toHaveBeenCalled();
    },
  );

  it("offers optional account-only email setup and preserves the preview without creating", async () => {
    await act(async () => root.render(<NewBot />));
    await submit("邮件草稿");
    await change(field("Instructions"), "  My email rules\n");
    await submit("Connect an email account");
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: "/(settings)/integrations",
      params: { accountOnly: "1" },
    });
    expect(field("Instructions").value).toBe("  My email rules\n");
    expect(mocks.rpc.mock.calls.some(([procedure]) => procedure !== "me")).toBe(false);
  });

  it("carries an example across sheet teardown into the actual empty composer only once", async () => {
    await act(async () => root.render(<NewBot />));
    await submit("资料研究");
    await submit("Create");
    const example = readMobileBotExample("created-fixture")!;
    expect(example).not.toBeNull();
    const composer = createRef<ThreadComposerHandle>();
    const send = vi.fn(async () => {});
    await act(async () =>
      root.render(
        <ThreadComposer
          ref={composer}
          agentSkills={[]}
          composerMentionTargets={[]}
          composerPrompt="Message…"
          replyQuote={null}
          attachmentIds={[]}
          botId="created-fixture"
          onCall={false}
          working={false}
          sending={false}
          styles={{ circleButton: {}, composerFill: {} }}
          attachActions={[]}
          attachFrom={() => {}}
          send={send}
          stop={async () => {}}
          startVoiceCall={async () => {}}
          onSlashAction={() => {}}
        />,
      ),
    );
    expect(composer.current!.snapshot().promptText).toBe("");
    expect(readMobileBotExample("created-fixture")).toEqual(example);
    const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
    const start = source.indexOf("  function insertTemplateExample()");
    const end = source.indexOf("  const composerMentionTargets", start);
    const status = source.slice(
      source.indexOf("function isWorkingStatus("),
      source.indexOf("function speakableMessageText("),
    );
    const target = {
      botId: "created-fixture",
      groupId: undefined as string | undefined,
      readOnly: false,
      scope: { ...mocks.scope },
      ready: true,
    };
    const snapshot = {
      botId: "created-fixture",
      run: null as { status: string } | null,
      activeRuns: [] as Array<{ status: string }>,
    };
    const preparingSend = { current: false };
    const dependencies = {
      templateExample: example,
      insertMobileBotExample,
      composerRef: composer,
      exampleTarget: { current: target },
      snapRef: { current: snapshot },
      preparingSend,
      updateExample: vi.fn(),
      isMobileScopeCurrent: (scope: unknown) =>
        JSON.stringify(scope) === JSON.stringify(mocks.scope),
    };
    const insert = new Function(
      ...Object.keys(dependencies),
      ts.transpileModule(`${status}\n${source.slice(start, end)}\nreturn insertTemplateExample;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    )(...Object.values(dependencies));
    for (const state of ["queued", "leased", "running", "waiting_input", "waiting_takeover"]) {
      snapshot.run = { status: state };
      act(() => insert());
      expect(composer.current!.snapshot().promptText).toBe("");
    }
    snapshot.run = null;
    snapshot.activeRuns = [{ status: "running" }];
    act(() => insert());
    expect(composer.current!.snapshot().promptText).toBe("");
    snapshot.activeRuns = [];
    for (const change of [
      { ready: false },
      { readOnly: true },
      { groupId: "group" },
      { botId: "other" },
      { scope: { ...mocks.scope, spaceGeneration: 99 } },
    ]) {
      Object.assign(target, change);
      act(() => insert());
      expect(composer.current!.snapshot().promptText).toBe("");
      Object.assign(target, {
        ready: true,
        readOnly: false,
        groupId: undefined,
        botId: "created-fixture",
        scope: { ...mocks.scope },
      });
    }
    preparingSend.current = true;
    act(() => insert());
    expect(composer.current!.snapshot().promptText).toBe("");
    preparingSend.current = false;
    act(() => insert());
    expect(composer.current!.snapshot().promptText).toBe(BOT_TEMPLATES[0]!.examplePrompt);
    expect(send).not.toHaveBeenCalled();
    act(() => composer.current!.reset());
    expect(insertMobileBotExample(example, () => true)).toBe("gone");
    expect(composer.current!.snapshot().promptText).toBe("");
  });

  it("binds an initially implicit Space to verified Me before explicit creation", async () => {
    mocks.scope.spaceId = null;
    await act(async () => root.render(<NewBot />));
    await submit("文档整理");
    await submit("Create");
    const [, , options] = mocks.rpc.mock.calls.find(([procedure]) => procedure === "bots/create")!;
    expect(options.requestContext.headers["x-rakazo-space-id"]).toBe("space-1");
  });

  it("does not dispatch through a mismatched verified account Space", async () => {
    mocks.rpc.mockResolvedValue({ userId: "user-1", spaceId: "foreign-space" });
    await act(async () => root.render(<NewBot />));
    await submit("资料研究");
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Create",
    )!;
    expect(button.disabled).toBe(true);
    expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "bots/create")).toBe(false);
  });

  it("cancels a preview without creating and ignores a dispatched result after cancel", async () => {
    await act(async () => root.render(<NewBot />));
    await submit("资料研究");
    expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "bots/create")).toBe(false);
    const wait = deferred<Bot>();
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((procedure: string, input: Record<string, unknown>) =>
      procedure === "bots/create" ? wait.promise : original(procedure, input),
    );
    await submit("Create");
    const input = mocks.rpc.mock.calls.find(([procedure]) => procedure === "bots/create")![1];
    act(() => mocks.close());
    await act(async () => wait.resolve(createdBot(input)));
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(readMobileBotExample("created-fixture")).toBeNull();
  });

  it.each(["Open bot", "Create another bot"])(
    "keeps in-flight edits after lost receipt recovery and requires explicit %s",
    async (action) => {
      const wait = deferred<Bot>();
      let submitted: Record<string, unknown> = {};
      let writes = 0;
      mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
        if (procedure === "me") return { userId: "user-1", spaceId: "space-1" };
        if (procedure === "bots/create") {
          writes++;
          if (writes === 1) {
            submitted = input;
            return wait.promise;
          }
          return createdBot(input, { id: "created-second", threadId: "second-thread" });
        }
        if (procedure === "bots/list") return [createdBot(submitted)];
        return [];
      });
      await act(async () => root.render(<NewBot />));
      await submit("资料研究");
      await submit("Create");
      await change(field("Name this bot"), "Retained live name");
      await change(field("Instructions"), "  Retained live rules\n");
      await act(async () => wait.reject(new TypeError("Connection lost")));
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(field("Name this bot").value).toBe("Retained live name");
      expect(field("Instructions").value).toBe("  Retained live rules\n");
      expect(container.textContent).toContain("Bot created. Your edits are kept.");
      expect(writes).toBe(1);
      await submit(action);
      expect(writes).toBe(action === "Open bot" ? 1 : 2);
      if (action === "Create another bot") {
        const second = mocks.rpc.mock.calls.filter(
          ([procedure]) => procedure === "bots/create",
        )[1]![1];
        expect(second).toMatchObject({
          name: "Retained live name",
          instructions: "  Retained live rules\n",
        });
        expect(second.spawnKey).not.toBe(submitted.spawnKey);
      }
      expect(mocks.replace).toHaveBeenCalledOnce();
      expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "bots/update")).toBe(false);
    },
  );

  it("keeps an archived recovery in the preview and explicitly creates another with a new key", async () => {
    let first: Record<string, unknown> = {};
    let writes = 0;
    mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === "me") return { userId: "user-1", spaceId: "space-1" };
      if (procedure === "bots/create") {
        if (++writes === 1) {
          first = input;
          throw new Error("Connection lost");
        }
        return createdBot(input);
      }
      return procedure === "bots/listArchived"
        ? [createdBot(first, { archivedAt: "2026-10-24T00:00:00Z" })]
        : [];
    });
    await act(async () => root.render(<NewBot />));
    await submit("文档整理");
    await submit("Create");
    expect(container.textContent).toContain("This bot is archived.");
    expect(container.textContent).not.toContain("Open bot");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(readMobileBotExample("created-fixture")).toBeNull();
    await change(field("Instructions"), "Edited after archive");
    await submit("Create another bot");
    const input = mocks.rpc.mock.calls.filter(([procedure]) => procedure === "bots/create")[1]![1];
    expect(input.instructions).toBe("Edited after archive");
    expect(input.spawnKey).not.toBe(first.spawnKey);
    expect(mocks.replace).toHaveBeenCalledOnce();
  });

  it("requires both owned rosters before recovering an uncertain receipt and keeps newer edits", async () => {
    let submitted: Record<string, unknown> = {};
    let failedArchive = true;
    mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === "me") return { userId: "user-1", spaceId: "space-1" };
      if (procedure === "bots/create") {
        submitted = input;
        throw new TypeError("Connection lost");
      }
      if (procedure === "bots/list") return [createdBot(submitted)];
      if (procedure === "bots/listArchived" && failedArchive) throw new TypeError("Offline");
      return [];
    });
    await act(async () => root.render(<NewBot />));
    await submit("资料研究");
    await submit("Create");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Create another bot");
    await change(field("Instructions"), "Retained after incomplete recovery");
    failedArchive = false;
    await submit("Retry");
    expect(mocks.rpc.mock.calls.filter(([procedure]) => procedure === "bots/create")).toHaveLength(
      1,
    );
    expect(field("Instructions").value).toBe("Retained after incomplete recovery");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Open bot");
    expect(container.textContent).toContain("Create another bot");
  });

  it.each(["empty name", "oversized rules"])(
    "retries the frozen intent despite newer invalid live %s",
    async (kind) => {
      let writes = 0;
      mocks.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
        if (procedure === "me") return { userId: "user-1", spaceId: "space-1" };
        if (procedure === "bots/create") {
          if (++writes === 1) throw new TypeError("Connection lost");
          return createdBot(input);
        }
        return [];
      });
      await act(async () => root.render(<NewBot />));
      await submit("资料研究");
      await submit("Create");
      const original = mocks.rpc.mock.calls.find(([procedure]) => procedure === "bots/create")![1];
      if (kind === "empty name") await change(field("Name this bot"), "");
      else await change(field("Instructions"), "x".repeat(20_001));
      await submit("Retry");
      expect(
        mocks.rpc.mock.calls
          .filter(([procedure]) => procedure === "bots/create")
          .map(([, input]) => input),
      ).toEqual([original, original]);
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(field(kind === "empty name" ? "Name this bot" : "Instructions").value).toBe(
        kind === "empty name" ? "" : "x".repeat(20_001),
      );
      expect(container.textContent).toContain("Open bot");
    },
  );

  it.each(["Space ABA", "session", "API ABA"])(
    "drops a late creation acknowledgment after %s",
    async (kind) => {
      const wait = deferred<Bot>();
      const original = mocks.rpc.getMockImplementation()!;
      mocks.rpc.mockImplementation((procedure: string, input: Record<string, unknown>) =>
        procedure === "bots/create" ? wait.promise : original(procedure, input),
      );
      await act(async () => root.render(<NewBot />));
      await submit("资料研究");
      await submit("Create");
      const input = mocks.rpc.mock.calls.find(([procedure]) => procedure === "bots/create")![1];
      await act(async () => {
        if (kind === "Space ABA")
          mocks.scope = { ...mocks.scope, spaceGeneration: mocks.scope.spaceGeneration + 2 };
        else if (kind === "session")
          mocks.scope = { ...mocks.scope, sessionGeneration: mocks.scope.sessionGeneration + 1 };
        else mocks.scope = { ...mocks.scope, apiGeneration: mocks.scope.apiGeneration + 2 };
        for (const listener of mocks.listeners) listener();
      });
      await act(async () => wait.resolve(createdBot(input)));
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(readMobileBotExample("created-fixture")).toBeNull();
      expect(field("Name this bot").value).toBe("");
    },
  );
});
