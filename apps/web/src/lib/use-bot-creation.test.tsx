// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { BOT_TEMPLATES, botTemplateDraft } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSpaceSelection, selectSpace } from "./rpc";
import { useBotCreation, useBotCreationEditor } from "./use-bot-creation";

const fixture: Bot = {
  id: "bot-a",
  spaceId: "space-a",
  name: "Research",
  title: "",
  description: "",
  instructions: "",
  color: "ink",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-a",
  preview: "",
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: "2026-10-24T00:00:00.000Z",
  createdAt: "2026-10-24T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: [],
  webhookConfigured: false,
  spawnKey: null,
};
let root: Root;
let scope!: ReturnType<typeof useBotCreation>;
let editor!: ReturnType<typeof useBotCreationEditor>;
function Harness(props: { ownerKey: string; spaceId: string; enabled: boolean }) {
  scope = useBotCreation(props);
  editor = useBotCreationEditor({ scope, spaceId: props.spaceId, enabled: props.enabled });
  return null;
}
const initial = { ownerKey: "account-a/session-a", spaceId: "space-a", enabled: true };
const submission = {
  draft: botTemplateDraft(BOT_TEMPLATES[0]!),
  draftVersion: 0,
  template: { templateId: "research-v1", version: 1 },
} as const;
async function render(props = initial) {
  await act(async () => root.render(<Harness {...props} />));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearSpaceSelection();
  selectSpace("space-a");
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearSpaceSelection();
  vi.unstubAllGlobals();
});
it("uses the real authenticated Space RPC and keeps the example after normal editor closure", async () => {
  const fetch = vi.fn(async (request: Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-rakazo-space-id")).toBe("space-a");
    expect(init?.credentials).toBe("include");
    expect(new URL(request.url).pathname).toBe("/rpc/bots/create");
    const input = (await request.json()).json;
    expect(input.instructions).toBe(submission.draft.instructions);
    expect(input).not.toHaveProperty("templateId");
    expect(input).not.toHaveProperty("requiredApps");
    return Response.json({ json: { ...fixture, ...input } });
  });
  vi.stubGlobal("fetch", fetch);
  await render();
  const receipt = await editor!.creation.submit(submission);
  scope.examples.remember({
    scopeKey: scope.scopeKey,
    botId: receipt.bot.id,
    selection: submission.template,
    exampleNonce: receipt.exampleNonce!,
  });
  const savedScope = scope;
  await render({ ...initial, enabled: false });
  expect(scope).toBe(savedScope);
  expect(scope.examples.read(scope.scopeKey, receipt.bot.id)?.text).toBe(
    BOT_TEMPLATES[0]!.examplePrompt,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("recovers a lost reply through complete active and archived lists without another write", async () => {
  let stored = fixture;
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/create")) {
        stored = { ...fixture, ...(await request.json()).json };
        throw new TypeError("reply lost");
      }
      return Response.json({ json: path.endsWith("/listArchived") ? [] : [stored] });
    }),
  );
  await render();
  const receipt = await editor!.creation.submit(submission);
  expect(receipt.source).toBe("recovered");
  expect(receipt.bot.id).toBe("bot-a");
  expect(paths).toEqual(["/rpc/bots/create", "/rpc/bots/list", "/rpc/bots/listArchived"]);
});
it.each(["owner ABA", "Space ABA", "closed editor", "unmounted"])(
  "rejects a late reply after %s without a recovery request",
  async (kind) => {
    const response = deferred<Response>();
    const dispatched = deferred<Record<string, unknown>>();
    const fetch = vi.fn(async (request: Request) => {
      const input = (await request.json()).json;
      dispatched.resolve(input);
      return response.promise;
    });
    vi.stubGlobal("fetch", fetch);
    await render();
    const original = editor!;
    const pending = original.creation.submit(submission).catch((error) => error);
    const input = await dispatched.promise;
    if (kind === "owner ABA") {
      await render({ ...initial, ownerKey: "account-b/session-b" });
      await render();
    } else if (kind === "Space ABA") {
      selectSpace("space-b");
      selectSpace("space-a");
    } else if (kind === "closed editor") await render({ ...initial, enabled: false });
    else {
      await act(async () => root.unmount());
      root = createRoot(document.createElement("div"));
    }
    response.resolve(Response.json({ json: { ...fixture, ...input } }));
    expect((await pending).code).toBe("closed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(original.isCurrent()).toBe(false);
  },
);
it("does not dispatch while selected Space is not the verified bootstrap Space", async () => {
  selectSpace("space-b");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await render();
  await expect(editor!.creation.submit(submission)).rejects.toMatchObject({ code: "closed" });
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts a corrected draft after the server explicitly rolls back a quota refusal", async () => {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (!new URL(request.url).pathname.endsWith("/create")) return Response.json({ json: [] });
      const input = (await request.json()).json;
      writes.push(input);
      return writes.length === 1
        ? Response.json(
            {
              json: {
                defined: false,
                code: "BAD_REQUEST",
                status: 400,
                message: "Computer limit reached",
                data: { reason: "bot_create_not_written" },
              },
            },
            { status: 400 },
          )
        : Response.json({ json: { ...fixture, ...input } });
    }),
  );
  await render();
  await expect(editor!.creation.submit(submission)).rejects.toMatchObject({ status: 400 });
  expect(editor!.creation.status()).toBe("idle");
  const corrected = {
    ...submission,
    draftVersion: 1,
    draft: { ...submission.draft, name: "Corrected name" },
  };
  const receipt = await editor!.creation.submit(corrected);
  expect(receipt.submitted.draft.name).toBe("Corrected name");
  expect(writes).toHaveLength(2);
  expect(writes[1]!.name).toBe("Corrected name");
  expect(writes[1]!.spawnKey).not.toBe(writes[0]!.spawnKey);
});

it.each([400, 408, 409, 429, "malformed 400"])(
  "preserves the original intent after an unmarked %s response",
  async (status) => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (!new URL(request.url).pathname.endsWith("/create")) return Response.json({ json: [] });
        const input = (await request.json()).json;
        writes.push(input);
        if (writes.length > 1) return Response.json({ json: { ...fixture, ...input } });
        return typeof status === "string"
          ? new Response("Gateway rejected response", { status: 400 })
          : Response.json(
              {
                json: {
                  defined: false,
                  code: status === 409 ? "CONFLICT" : "BAD_REQUEST",
                  status,
                  message: "Rejected response",
                },
              },
              { status },
            );
      }),
    );
    await render();
    await expect(editor!.creation.submit(submission)).rejects.toMatchObject({ code: "unknown" });
    const receipt = await editor!.creation.submit({
      ...submission,
      draftVersion: 1,
      draft: { ...submission.draft, name: "New live edit" },
    });
    expect(receipt.submitted.draftVersion).toBe(0);
    expect(writes).toEqual([writes[0], writes[0]]);
  },
);

it("does not discard an earlier uncertain write after a later explicit quota refusal", async () => {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (!new URL(request.url).pathname.endsWith("/create")) return Response.json({ json: [] });
      const input = (await request.json()).json;
      writes.push(input);
      if (writes.length === 1) throw new TypeError("Reply lost");
      if (writes.length === 2)
        return Response.json(
          {
            json: {
              defined: false,
              code: "BAD_REQUEST",
              status: 400,
              message: "Computer limit reached",
              data: { reason: "bot_create_not_written" },
            },
          },
          { status: 400 },
        );
      return Response.json({ json: { ...fixture, ...input } });
    }),
  );
  await render();
  await expect(editor!.creation.submit(submission)).rejects.toMatchObject({ code: "unknown" });
  const edited = {
    ...submission,
    draftVersion: 1,
    draft: { ...submission.draft, name: "New live edit" },
  };
  await expect(editor!.creation.submit(edited)).rejects.toMatchObject({ code: "unknown" });
  expect(editor!.creation.status()).toBe("unknown");
  const receipt = await editor!.creation.submit(edited);
  expect(receipt.submitted.draftVersion).toBe(0);
  expect(writes).toEqual([writes[0], writes[0], writes[0]]);
});
