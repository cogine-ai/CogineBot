import { readFileSync } from "node:fs";
import { parseSync, traverse } from "@babel/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { authClient } from "./auth";
import {
  clearComposerDrafts,
  makeComposerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";
import type { VerifiedComposerRecoveryTarget } from "./composer-rejected-draft";
import {
  cancelPreparedRejectedComposerDraft,
  discardRejectedComposerDraft,
  prepareRejectedComposerDraft,
  rememberVerifiedComposerRecoveryTarget,
  restoreRejectedComposerDraft,
} from "./composer-rejected-draft";
import { synchronizeComposerSession } from "./composer-session";

type SignOutResult = Awaited<ReturnType<typeof authClient.signOut>>;
const rejected = {
  data: null,
  error: { message: "Unavailable", status: 503, statusText: "Service Unavailable" },
} satisfies SignOutResult;
const accepted = {
  data: { success: true, url: undefined, redirect: undefined },
  error: null,
} satisfies SignOutResult;

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../pages/Shell.tsx", testFileUrl), "utf8");
const parsed = parseSync(source, {
  filename: "Shell.tsx",
  babelrc: false,
  configFile: false,
  parserOpts: { plugins: ["typescript", "jsx"] },
});
if (!parsed) throw new Error("Shell source could not be parsed");
let handler: string | undefined;
traverse(parsed, {
  JSXAttribute(path) {
    const { name, value } = path.node;
    if (
      name.type !== "JSXIdentifier" ||
      name.name !== "onSignIn" ||
      value?.type !== "JSXExpressionContainer"
    )
      return;
    const expression = value.expression;
    if (
      expression.type === "ArrowFunctionExpression" &&
      expression.start != null &&
      expression.end != null
    )
      handler = source.slice(expression.start, expression.end);
  },
});
if (!handler) throw new Error("Shell recovery handler was not found");
const compiled = `return (${handler});`;

const target: VerifiedComposerRecoveryTarget = {
  apiOrigin: "https://chat.example.test",
  userId: "user-a",
  sessionId: "old-session",
  spaceId: "space-a",
  selectionId: null,
  selectionGeneration: 1,
  targetKind: "bot",
  targetId: "bot-a",
  threadId: "thread-a",
};
const key = makeComposerDraftKey(target);

function setup() {
  let resolve!: (value: SignOutResult) => void;
  let reject!: (reason: Error) => void;
  const response = new Promise<SignOutResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const owner = { key: "original-owner" };
  const committedOwner = { current: owner };
  let pending = false;
  const setBootstrapLoad = vi.fn(
    (
      update: (value: { pending: boolean; error: unknown }) => { pending: boolean; error: unknown },
    ) => {
      pending = update({ pending, error: new Error("401") }).pending;
    },
  );
  const navigate = vi.fn();
  const signOut = vi.fn<() => Promise<SignOutResult>>().mockReturnValue(response);
  const bindings = {
    settingsOwner: owner,
    session: { data: { session: { id: target.sessionId } } },
    userId: target.userId,
    groupId: undefined,
    botId: target.targetId,
    prepareRejectedComposerDraft,
    previewMessageText: () => "Reply preview",
    selectedSpaceId: () => target.selectionId,
    currentSpaceSelectionGeneration: () => target.selectionGeneration,
    setBootstrapLoad,
    authClient: { signOut },
    committedSettingsOwner: committedOwner,
    navigate,
    cancelPreparedRejectedComposerDraft,
    discardRejectedComposerDraft,
  };
  const run = new Function(...Object.keys(bindings), compiled)(
    ...Object.values(bindings),
  ) as () => void;
  return {
    run,
    resolve,
    reject,
    committedOwner,
    navigate,
    setBootstrapLoad,
    signOut,
    pending: () => pending,
  };
}

async function settled() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
function laterAuthentication(next = { ...target, sessionId: "new-session" }) {
  synchronizeComposerSession("anonymous", undefined);
  synchronizeComposerSession("authenticated", next.userId, next.sessionId);
  return restoreRejectedComposerDraft(next, makeComposerDraftKey(next), true, () => true);
}

beforeEach(() => {
  vi.stubGlobal("window", { location: { origin: target.apiOrigin } });
  discardRejectedComposerDraft();
  clearComposerDrafts();
  synchronizeComposerSession("anonymous", undefined);
  synchronizeComposerSession("authenticated", target.userId, target.sessionId);
  rememberVerifiedComposerRecoveryTarget(target, key, false);
  writeComposerDraft(key, { text: "Private draft before rejected sign-out" });
});
afterEach(() => {
  discardRejectedComposerDraft();
  clearComposerDrafts();
  vi.unstubAllGlobals();
});

describe("the actual Shell rejected-session sign-in handler", () => {
  it("treats a resolved Better Auth error result as a failure without navigation", async () => {
    const h = setup();
    h.run();
    expect(h.pending()).toBe(true);
    h.resolve(rejected);
    await settled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.pending()).toBe(false);
    expect(readComposerDraft(key).text).toBe("Private draft before rejected sign-out");
  });

  it("discards a resolved-error quarantine before any later unrelated anonymous/sign-in cycle", async () => {
    const h = setup();
    h.run();
    h.resolve(rejected);
    await settled();
    expect(laterAuthentication()).toBe(false);
    expect(readComposerDraft(key).text).toBe("");
  });

  it("cleans a rejected promise without navigating or preserving a later recovery", async () => {
    const h = setup();
    h.run();
    h.reject(new Error("Network unavailable"));
    await settled();
    expect(h.pending()).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(laterAuthentication()).toBe(false);
  });

  it.each(["result", "throw"])(
    "preserves the verified editor for an explicit retry after a %s failure without requiring a new bootstrap",
    async (kind) => {
      const h = setup();
      h.run();
      if (kind === "result") h.resolve(rejected);
      else h.reject(new Error("Sign-out unavailable"));
      await settled();
      expect(h.pending()).toBe(false);
      expect(h.navigate).not.toHaveBeenCalled();
      h.signOut.mockResolvedValue(accepted);
      h.run();
      await settled();
      expect(h.signOut).toHaveBeenCalledTimes(2);
      expect(h.navigate).toHaveBeenCalledExactlyOnceWith("/sign-in", { replace: true });
      expect(laterAuthentication()).toBe(true);
      expect(readComposerDraft(key).text).toBe("Private draft before rejected sign-out");
    },
  );

  it.each(["result", "throw"])(
    "ignores a late old-owner %s failure without clearing a newer owner's prepared draft",
    async (kind) => {
      const h = setup();
      h.run();
      const next = {
        ...target,
        userId: "user-b",
        sessionId: "session-b",
        targetId: "bot-b",
        threadId: "thread-b",
      };
      synchronizeComposerSession("anonymous", undefined);
      synchronizeComposerSession("authenticated", next.userId, next.sessionId);
      h.committedOwner.current = { key: "new-owner" };
      rememberVerifiedComposerRecoveryTarget(next, makeComposerDraftKey(next), false);
      writeComposerDraft(makeComposerDraftKey(next), { text: "New owner's independent draft" });
      expect(prepareRejectedComposerDraft(next, () => "")).toBe(true);
      h.setBootstrapLoad.mockClear();
      if (kind === "result") h.resolve(rejected);
      else h.reject(new Error("Old request unavailable"));
      await settled();
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.setBootstrapLoad).not.toHaveBeenCalled();
      expect(laterAuthentication({ ...next, sessionId: "new-session-b" })).toBe(true);
      expect(readComposerDraft(makeComposerDraftKey(next)).text).toBe(
        "New owner's independent draft",
      );
    },
  );

  it("continues a successful current-owner result with normal anonymous cleanup and one verified editable restore", async () => {
    const h = setup();
    h.run();
    h.resolve(accepted);
    await settled();
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith("/sign-in", { replace: true });
    expect(laterAuthentication()).toBe(true);
    expect(readComposerDraft(key).text).toBe("Private draft before rejected sign-out");
    expect(
      restoreRejectedComposerDraft({ ...target, sessionId: "new-session" }, key, true, () => true),
    ).toBe(false);
  });
});
