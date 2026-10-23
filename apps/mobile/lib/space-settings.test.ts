import { beforeEach, expect, it, vi } from "vitest";
import { createSpaceSettingsClient } from "./space-settings";

const state = vi.hoisted(() => ({ rpc: vi.fn(), generation: 0, target: "space-b" }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({
    apiBase: "https://api.example.test",
    sessionGeneration: 1,
    headers: { authorization: "Bearer fake-token", "x-rakazo-space-id": "space-a" },
  }),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ generation: state.generation }),
  isMobileScopeCurrent: (scope: { generation: number }) => scope.generation === state.generation,
  mobileScopeKey: () => String(state.generation),
  subscribeMobileScope: () => () => {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  state.generation = 0;
  state.target = "space-b";
  state.rpc
    .mockReset()
    .mockImplementation(async (procedure: string) =>
      procedure === "me" ? { userId: "user-1", spaceId: state.target } : [],
    );
});

it("verifies the target membership before dispatching settings reads or writes", async () => {
  const verified = deferred<{ userId: string; spaceId: string }>();
  state.rpc.mockImplementation((name: string) => (name === "me" ? verified.promise : []));
  const client = createSpaceSettingsClient("space-b");
  const read = client.rpc("models/credentials");
  const write = client.rpc("voice/setVoice", { voiceId: "voice-b" });
  await vi.waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
  expect(state.rpc.mock.calls[0]?.[0]).toBe("me");
  verified.resolve({ userId: "user-1", spaceId: "space-b" });
  await Promise.all([read, write]);
  for (const [, , options] of state.rpc.mock.calls)
    expect(options.requestContext.headers["x-rakazo-space-id"]).toBe("space-b");
});

it.each(["denied", "fallback"])(
  "does not fall back to the current Space when target verification is %s",
  async (failure) => {
    state.rpc.mockImplementation(async () => {
      if (failure === "denied") throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return { userId: "user-1", spaceId: "space-a" };
    });
    await expect(createSpaceSettingsClient("space-b").rpc("models/credentials")).rejects.toThrow();
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["me"]);
  },
);

it("fences a late request after an owner ABA change", async () => {
  const late = deferred<string[]>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string) =>
    name === "models/list" ? late.promise : normal(name),
  );
  const client = createSpaceSettingsClient("space-b");
  const read = client.rpc("models/list");
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() =>
    expect(state.rpc.mock.calls.some(([name]) => name === "models/list")).toBe(true),
  );
  state.generation += 2;
  late.resolve(["old models"]);
  await rejected;
  await expect(client.rpc("models/setDefault")).rejects.toThrow();
  expect(state.rpc.mock.calls.some(([name]) => name === "models/setDefault")).toBe(false);
});

it("aborts in-flight requests but cancels a late OAuth login on its original context", async () => {
  const late = deferred<{ loginId: string }>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string) =>
    name === "models/beginOAuth" ? late.promise : normal(name),
  );
  const client = createSpaceSettingsClient("space-b");
  const begin = client.rpc("models/beginOAuth");
  const rejected = expect(begin).rejects.toThrow();
  await vi.waitFor(() =>
    expect(state.rpc.mock.calls.some(([name]) => name === "models/beginOAuth")).toBe(true),
  );
  const signal = state.rpc.mock.calls.find(([name]) => name === "models/beginOAuth")?.[2].signal;
  client.dispose();
  expect(signal.aborted).toBe(true);
  state.target = "space-c";
  late.resolve({ loginId: "old-b-login" });
  await rejected;
  await vi.waitFor(() =>
    expect(state.rpc.mock.calls.some(([name]) => name === "models/cancelOAuth")).toBe(true),
  );
  const canceled = state.rpc.mock.calls.find(([name]) => name === "models/cancelOAuth");
  expect(canceled?.[1]).toEqual({ loginId: "old-b-login" });
  expect(canceled?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-b");
});

it("keeps known OAuth cancellation in the original target after unmount", async () => {
  const client = createSpaceSettingsClient("space-b");
  await client.rpc("models/beginOAuth");
  client.dispose();
  await client.cancelOAuth("old-login");
  expect(state.rpc.mock.lastCall?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-b");
});

it("does not let a previous effect lifetime claim a reactivated form", async () => {
  const late = deferred<string[]>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string) =>
    name === "models/list" ? late.promise : normal(name),
  );
  const client = createSpaceSettingsClient("space-b");
  const read = client.rpc("models/list");
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() =>
    expect(state.rpc.mock.calls.some(([name]) => name === "models/list")).toBe(true),
  );
  client.dispose();
  client.activate();
  late.resolve(["old models"]);
  await rejected;
  await expect(client.rpc("models/credentials")).resolves.toEqual([]);
});
