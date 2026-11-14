import type { SpaceMemoryConfig } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { serenityConnectionDraft, supermemoryConnectionDraft } from "./memory-connection-draft.js";
import type { SemanticMemorySettingsApi } from "./semantic-memory-settings.js";
import { createSemanticMemorySettings } from "./semantic-memory-settings.js";

function fixture() {
  let current = true;
  const config: SpaceMemoryConfig = {
    provider: "supermemory",
    settings: { mode: "cloud" },
    defaultMemoryScope: "isolated",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const data: Awaited<ReturnType<SemanticMemorySettingsApi["read"]>> = {
    config,
    canManage: true,
    bot: { id: "bot-a", name: "Example", memoryScope: null },
  };
  const api = {
    read: vi.fn(async () => structuredClone(data)),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => {
      data.config = null;
    }),
    setDefault: vi.fn(async (scope: "isolated" | "shared") => {
      config.defaultMemoryScope = scope;
    }),
    setBot: vi.fn(async (_id: string, scope: "isolated" | "shared" | null) => {
      data.bot!.memoryScope = scope;
    }),
  };
  const session = createSemanticMemorySettings(api, () => current);
  return {
    data,
    api,
    session,
    invalidate: () => {
      current = false;
    },
  };
}

describe("semantic memory settings", () => {
  it("retains null inheritance while changing the Space default and explicit overrides", async () => {
    const { session, api } = fixture();
    await session.refresh();
    await session.setDefault("shared");
    expect(session.getSnapshot().data?.bot?.memoryScope).toBeNull();
    expect(api.setBot).not.toHaveBeenCalled();
    await session.setBot("isolated");
    await session.setDefault("isolated");
    await session.setDefault("shared");
    expect(session.getSnapshot().data?.bot?.memoryScope).toBe("isolated");
    await session.setBot(null);
    expect(api.setBot).toHaveBeenLastCalledWith("bot-a", null);
    expect(session.getSnapshot().data?.bot?.memoryScope).toBeNull();
  });
  it("does not turn a successful write with a failed readback into connection success", async () => {
    const { session, api } = fixture();
    await session.refresh();
    api.read.mockRejectedValueOnce(new Error("synthetic secret must never escape"));
    expect(
      await session.connect({
        provider: "serenity",
        settings: {},
        credentials: { token: "fake-token" },
        defaultMemoryScope: "shared",
      }),
    ).toBe(false);
    expect(session.getSnapshot()).toEqual({ data: null, error: true, busy: false });
    expect(JSON.stringify(session.getSnapshot())).not.toContain("synthetic");
    await session.refresh();
    expect(session.getSnapshot().error).toBe(false);
  });
  it("clears uncertain state after permission, connection, or conflict failures", async () => {
    for (const reason of ["FORBIDDEN", "BAD_REQUEST", "CONFLICT"]) {
      const { session, api } = fixture();
      await session.refresh();
      api.setDefault.mockRejectedValueOnce(new Error(reason));
      expect(await session.setDefault("shared")).toBe(false);
      expect(session.getSnapshot().data).toBeNull();
      expect(await session.setDefault("shared")).toBe(false);
      expect(api.setDefault).toHaveBeenCalledTimes(1);
    }
  });
  it("does not grant provider writes to a non-owner, while retaining the Bot boundary", async () => {
    const { session, data, api } = fixture();
    data.canManage = false;
    await session.refresh();
    await session.disconnect();
    await session.setDefault("shared");
    await session.connect({
      provider: "serenity",
      settings: {},
      credentials: {},
      defaultMemoryScope: "isolated",
    });
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.setDefault).not.toHaveBeenCalled();
    await session.setBot(null);
    expect(api.setBot).toHaveBeenCalledWith("bot-a", null);
  });
  it("reads disconnect back and refuses concurrent writes", async () => {
    const { session, api } = fixture();
    await session.refresh();
    let finish!: () => void;
    api.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.disconnect();
    expect(await session.setDefault("shared")).toBe(false);
    finish();
    await pending;
    await session.disconnect();
    expect(session.getSnapshot().data?.config).toBeNull();
  });
  it("ignores late completions and prevents requests after a Space/session switch", async () => {
    const { session, api, invalidate } = fixture();
    await session.refresh();
    let finish!: () => void;
    api.setDefault.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.setDefault("shared");
    invalidate();
    session.dispose();
    finish();
    await pending;
    expect(session.getSnapshot().data).toBeNull();
    expect(await session.refresh()).toBe(false);
    expect(api.read).toHaveBeenCalledTimes(1);
  });
});

it("uses the same provider drafts as Web, with no implicit Serenity endpoint", () => {
  expect(
    serenityConnectionDraft({
      endpoint: " ",
      token: "fake-token",
      brainLabel: "",
      allowWrites: false,
    }),
  ).toEqual({ ok: false, error: "required" });
  expect(
    serenityConnectionDraft({
      endpoint: " https://memory.example.test/mcp ",
      token: " fake-token ",
      brainLabel: " Example ",
      allowWrites: true,
    }),
  ).toEqual({
    ok: true,
    draft: {
      settings: {
        endpoint: "https://memory.example.test/mcp",
        brainLabel: "Example",
        allowWrites: "true",
      },
      credentials: { token: "fake-token" },
    },
  });
  expect(
    supermemoryConnectionDraft({
      mode: "cloud",
      baseUrl: "https://unused.example.test",
      apiKey: " fake-key ",
    }),
  ).toEqual({ settings: { mode: "cloud" }, credentials: { apiKey: "fake-key" } });
  expect(
    supermemoryConnectionDraft({
      mode: "local",
      baseUrl: " http://localhost:6767 ",
      apiKey: "fake-key",
    }).settings,
  ).toEqual({ mode: "local", baseUrl: "http://localhost:6767" });
});
