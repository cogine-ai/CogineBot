import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
function route(readOnly = false, inGroup = false) {
  const binding = { scope: {}, botId: "bot-example", inGroup, readOnly };
  const state = {
    binding,
    committedProfile: { current: binding },
    focused: true,
    current: true,
    pending: false,
    router: { push: vi.fn() },
  };
  const dependencies = {
    ...state,
    navigation: { isFocused: () => state.focused },
    useCallback: (fn: unknown) => fn,
    isMobileScopeCurrent: () => state.current,
    isSpaceSelectionPending: () => state.pending,
  };
  const start = source.indexOf("  const openBotProfile = useCallback(");
  const callback = source.slice(start, source.indexOf("  return openBotProfile;", start));
  const open = new Function(
    ...Object.keys(dependencies),
    ts.transpileModule(`${callback}\nreturn openBotProfile;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(dependencies)) as () => void;
  return {
    ...state,
    open,
    invalidate: () => {
      state.current = false;
    },
    blur: () => {
      state.focused = false;
    },
  };
}

it.each([false, true])(
  "pushes a Bot profile with readonly=%s while retaining the underlying thread",
  (readOnly) => {
    const state = route(readOnly);
    state.open();
    expect(state.router.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-profile",
      params: { botId: "bot-example", ...(readOnly ? { readOnly: "1" } : {}) },
    });
  },
);
it.each(["group", "closed", "owner", "target", "readonly"])(
  "rejects a retained profile callback after %s changes",
  (edge) => {
    const state = route(false, edge === "group");
    if (edge === "closed") state.blur();
    if (edge === "owner") state.invalidate();
    if (edge === "target") state.committedProfile.current = { ...state.binding, botId: "new-bot" };
    if (edge === "readonly") state.committedProfile.current = { ...state.binding, readOnly: true };
    state.open();
    expect(state.router.push).not.toHaveBeenCalled();
  },
);
