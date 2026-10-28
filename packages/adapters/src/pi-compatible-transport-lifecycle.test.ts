import type * as Undici from "undici";
import type { Agent as UndiciAgent } from "undici";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  agents: [] as UndiciAgent[],
  connect: [] as Array<Record<string, unknown>>,
}));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
        super(options);
        recorded.agents.push(this);
        recorded.connect.push(options?.connect as Record<string, unknown>);
      }
    },
  };
});

import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { MODEL_CONNECT_TIMEOUT_MS } from "./pi-runtime-limits.js";

afterEach(async () => {
  await Promise.all(recorded.agents.splice(0).map((agent) => agent.destroy()));
  recorded.connect.length = 0;
  vi.restoreAllMocks();
});

describe("compatible transport lifecycle", () => {
  it.each(["http://127.0.0.1:8000/v1/models", "https://models.example/v1/models"])(
    "bounds connection setup and closes after the response for %s",
    async (url) => {
      const response = new Response("fixture");
      const transport = vi.fn<typeof fetch>(async () => response);
      const fetch = createOpenAiCompatibleFetch(transport, undefined, { allowPublic: true });
      const received = await fetch(url);
      const agent = recorded.agents[0]!;
      const close = vi.spyOn(agent, "close");
      expect(recorded.connect[0]).toMatchObject({ timeout: MODEL_CONNECT_TIMEOUT_MS });
      expect(recorded.connect[0]?.lookup !== undefined).toBe(!url.includes("127.0.0.1"));
      expect(transport.mock.calls[0]?.[1]).toMatchObject({ dispatcher: agent, redirect: "error" });
      expect(await received.text()).toBe("fixture");
      expect(close).toHaveBeenCalled();
      expect(recorded.agents[0]!.closed).toBe(true);
    },
  );

  it("destroys an agent when the injected transport rejects", async () => {
    const failure = new Error("fixture connection failed");
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    const fetch = createOpenAiCompatibleFetch(async () => {
      throw failure;
    });
    await expect(fetch("http://127.0.0.1:8000/v1/models")).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalled();
    expect(recorded.agents[0]!.destroyed).toBe(true);
    expect(recorded.connect[0]).toMatchObject({ timeout: 30_000 });
  });

  it("cancels the original body and closes on consumer cancellation", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    const fetch = createOpenAiCompatibleFetch(async () => new Response(body));
    const response = await fetch("http://127.0.0.1:8000/v1/models");
    const close = vi.spyOn(recorded.agents[0]!, "close");
    await response.body!.cancel("hidden fixture");
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(recorded.agents[0]!.closed).toBe(true);
  });
});
