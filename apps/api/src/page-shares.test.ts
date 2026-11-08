import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

function fixture(pageSharingEnabled?: boolean) {
  const findFirst = vi.fn().mockResolvedValue(null);
  const put = vi.fn();
  const load = vi.fn();
  const handler = new RPCHandler(
    createRouter({
      prisma: { page: { findFirst } },
      secrets: { put, load },
      pageSharingEnabled,
      env: { webOrigin: "https://app.example.test" },
    } as unknown as RouterDeps),
  );
  async function call(procedure: string, input: unknown, caller: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request(`https://app.example.test/rpc/pages/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    if (!response) throw new Error("The test RPC did not resolve");
    return { status: response.status, body: (await response.json()).json };
  }
  return { call, findFirst, put, load };
}

describe("Page sharing RPC availability", () => {
  it("lets the owner see dormant link state without reading or issuing a token", async () => {
    const f = fixture();
    const page = { pageId: "page" };
    f.findFirst.mockResolvedValue({ visibility: "link" });
    expect(await f.call("getShare", page)).toEqual({
      status: 200,
      body: { visibility: "link", publishingEnabled: false, shareUrl: null, generation: null },
    });
    expect(
      await f.call("setShare", {
        ...page,
        visibility: "link",
        expectedVersion: 1,
        expectedTitle: "Weekly plan",
      }),
    ).toMatchObject({
      status: 404,
      body: { code: "NOT_FOUND", message: "Page sharing is unavailable" },
    });
    expect(f.findFirst).toHaveBeenCalledTimes(1);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  });

  it("rejects anonymous callers and client-supplied token fields before looking up a Page", async () => {
    const f = fixture(true);
    expect(await f.call("getShare", { pageId: "page" }, null)).toMatchObject({ status: 401 });
    expect(
      await f.call("setShare", {
        pageId: "page",
        visibility: "link",
        expectedVersion: 1,
        expectedTitle: "Weekly plan",
        shareTokenHash: "input",
      }),
    ).toMatchObject({ status: 400 });
    expect(await f.call("setShare", { pageId: "page", visibility: "link" })).toMatchObject({
      status: 400,
    });
    expect(
      await f.call("setShare", { pageId: "page", visibility: "link", expectedVersion: 1 }),
    ).toMatchObject({ status: 400 });
    expect(await f.call("getShare", { pageId: "page\0bad" })).toMatchObject({ status: 400 });
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("uses the authenticated owner and Space to check the target before staging a token", async () => {
    const f = fixture(true);
    expect(
      await f.call("setShare", {
        pageId: "page",
        visibility: "link",
        expectedVersion: 1,
        expectedTitle: "Weekly plan",
      }),
    ).toMatchObject({
      status: 404,
      body: { code: "NOT_FOUND", message: "This page isn't available" },
    });
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page", userId: "owner", spaceId: "space" } }),
    );
    expect(f.put).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
  });
});
