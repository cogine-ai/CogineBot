import type { AdapterContext } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SerenityClient from "./serenity-client.js";
import { forgetSerenity, recallSerenity } from "./serenity-client.js";
import {
  SerenityMemoryProvider,
  serenityBotEntity,
  serenitySpaceEntity,
} from "./serenity-memory-provider.js";

vi.mock("./serenity-client.js", async (original) => ({
  ...(await original<typeof SerenityClient>()),
  recallSerenity: vi.fn(),
  forgetSerenity: vi.fn(),
}));

const context: AdapterContext = {
  operationId: "memory-operation",
  traceId: "memory-trace",
  spaceId: "space-one",
  userId: "user-one",
  botId: "bot-one",
  signal: new AbortController().signal,
};
const owner = { scope: "isolated" as const, botId: "bot-one" };
const recalled = vi.mocked(recallSerenity);
const forgotten = vi.mocked(forgetSerenity);

function provider(allowWrites = true) {
  return new SerenityMemoryProvider({
    endpoint: "http://127.0.0.1:8787/mcp",
    token: "synthetic-memory-token",
    brainLabel: "",
    allowWrites,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  recalled.mockResolvedValue({ ok: true, value: [] });
  forgotten.mockResolvedValue({
    ok: true,
    value: { id: "fact-one", expired: true, reason: null },
  });
});

describe("semantic fact ownership", () => {
  it.each([
    serenityBotEntity("another-bot"),
    serenitySpaceEntity("another-space"),
    serenitySpaceEntity("space-one"),
  ])("rejects a citation outside the allowed isolated entity: %s", async (entity) => {
    const result = await provider().forget({ ...owner, id: "fact-one", entity }, context);
    expect(result.ok).toBe(false);
    expect(recalled).not.toHaveBeenCalled();
    expect(forgotten).not.toHaveBeenCalled();
  });

  it("does not delete an arbitrary fact id absent from the allowed entity", async () => {
    const result = await provider().forget({ ...owner, id: "foreign-fact" }, context);
    expect(result.ok).toBe(false);
    expect(forgotten).not.toHaveBeenCalled();
  });

  it("fails closed when the ownership lookup fails", async () => {
    recalled.mockResolvedValue({ ok: false, error: "lookup unavailable" });
    const result = await provider().forget({ ...owner, id: "fact-one" }, context);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("lookup unavailable"),
    });
    expect(forgotten).not.toHaveBeenCalled();
  });

  it("confirms an uncited fact in the current Bot before deletion", async () => {
    recalled.mockResolvedValue({
      ok: true,
      value: [{ factId: "fact-one", fact: "Keep reports brief.", provenance: "synthetic" }],
    });
    const result = await provider().forget({ ...owner, id: " fact-one " }, context);
    expect(result.ok).toBe(true);
    expect(recalled).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ entity: serenityBotEntity("bot-one") }),
    );
    expect(forgotten).toHaveBeenCalledWith("fact-one", expect.any(Object), expect.any(Object));
  });

  it("allows a shared fact only after checking the permitted Space citation", async () => {
    recalled.mockResolvedValue({
      ok: true,
      value: [{ factId: "fact-one", fact: "Use metric units.", provenance: "synthetic" }],
    });
    const entity = serenitySpaceEntity("space-one");
    const result = await provider().forget(
      { ...owner, scope: "shared", id: "fact-one", entity },
      context,
    );
    expect(result.ok).toBe(true);
    expect(recalled).toHaveBeenCalledOnce();
    expect(recalled).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ entity }));
    expect(forgotten.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("rejects an empty fact id without contacting the provider", async () => {
    expect((await provider().forget({ ...owner, id: "  " }, context)).ok).toBe(false);
    expect(recalled).not.toHaveBeenCalled();
    expect(forgotten).not.toHaveBeenCalled();
  });

  it("keeps the read-only setting authoritative", async () => {
    expect((await provider(false).forget({ ...owner, id: "fact-one" }, context)).ok).toBe(false);
    expect(recalled).not.toHaveBeenCalled();
    expect(forgotten).not.toHaveBeenCalled();
  });
});

it("ranks combined candidates before applying the requested limit", async () => {
  recalled.mockImplementation(async (_connection, options) => ({
    ok: true,
    value:
      options?.entity === serenitySpaceEntity("space-one")
        ? [
            { factId: "recent", fact: "Prefer short status reports.", provenance: "synthetic" },
            { factId: "older", fact: "The garden uses drip irrigation.", provenance: "synthetic" },
          ]
        : [{ factId: "bot-fact", fact: "Prefer complete sentences.", provenance: "synthetic" }],
  }));
  const result = await provider().recall(
    { ...owner, scope: "shared", query: "garden irrigation", limit: 1 },
    context,
  );
  expect(result.ok && result.value.map((fact) => fact.id)).toEqual(["older"]);
  expect(result.ok && result.value[0]?.entity).toBe(serenitySpaceEntity("space-one"));
});
