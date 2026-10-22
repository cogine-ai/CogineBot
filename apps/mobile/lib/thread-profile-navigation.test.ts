import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
function route(readOnly = false, inGroup = false) {
  const state = {
    botId: "bot-example",
    inGroup,
    readOnly,
    profileAvailable: { current: true },
    profileOwner: { current: {} },
    profileRoute: { current: { botId: "bot-example", readOnly } },
    current: true,
    router: { push: vi.fn() },
  };
  const dependencies = {
    ...state,
    useCallback: (fn: unknown) => fn,
    isMobileScopeCurrent: () => state.current,
  };
  const callback = source.slice(
    source.indexOf("  const openBotProfile = useCallback("),
    source.indexOf(
      "  useLayoutEffect(() => {\n    navigation.setOptions({\n      title: displayName",
    ),
  );
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
    if (edge === "closed") state.profileAvailable.current = false;
    if (edge === "owner") state.invalidate();
    if (edge === "target") state.profileRoute.current.botId = "new-bot";
    if (edge === "readonly") state.profileRoute.current.readOnly = true;
    state.open();
    expect(state.router.push).not.toHaveBeenCalled();
  },
);
