import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageToolContext } from "./page-tools.js";

const publishMessage = vi.fn();
const { recoverSavedPageFromTool, savePageFromTool } = await import("./page-tools.js");

const source = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Text>Hi</Text>\n  </Page>\n);\nexport default App;\n`;

function context(
  tx: Record<string, unknown>,
  existing?: { currentVersion: number },
  secrets: string[] = [],
) {
  const prisma = {
    page: {
      findFirst: vi.fn(async () =>
        existing
          ? {
              id: "page-1",
              title: "Plan",
              currentVersion: existing.currentVersion,
              versions: [{ source: source("Plan") }],
            }
          : null,
      ),
    },
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)),
  };
  return {
    deps: { prisma },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "bot-1" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    secrets,
    state: { tainted: false },
    publish: publishMessage,
  } as never;
}

describe("save_page", () => {
  beforeEach(() => publishMessage.mockReset());

  it("keeps a saved page when its chat card cannot be posted, and says how to link it", async () => {
    publishMessage.mockRejectedValueOnce(new Error("run was cancelled"));
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const result = (await savePageFromTool(context(tx), {
      title: "Plan",
      source: source("Plan"),
    })) as Record<string, unknown>;
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pageId: "page-1", version: 1, title: "Plan" });
    expect(result.error).toMatch(/saved, but its card could not be posted/);
    expect(result.error).toContain("[Plan](page:page-1)");
  });

  it("taints the run when it reads a page's stored source, but not when it saves one", async () => {
    const read = context({}, { currentVersion: 2 });
    const result = (await savePageFromTool(read, { pageId: "page-1" })) as Record<string, unknown>;
    expect(result.source).toBe(source("Plan"));
    expect((read as { state: { tainted: boolean } }).state.tainted).toBe(true);

    const tx = { page: { create: vi.fn(async () => ({ id: "page-2", title: "New" })) } };
    const save = context(tx);
    await savePageFromTool(save, { title: "New", source: source("New") });
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect((save as { state: { tainted: boolean } }).state.tainted).toBe(false);
  });

  it("treats an empty edits list as not sent, as it does a blank title or source", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const created = (await savePageFromTool(context(tx), {
      title: "Plan",
      source: source("Plan"),
      edits: [],
    })) as Record<string, unknown>;
    expect(created).toMatchObject({ pageId: "page-1", version: 1 });
    expect(tx.page.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versions: { create: expect.objectContaining({ code: expect.stringContaining("Plan") }) },
      }),
    });
    // Reading a page back with an empty list returns its source rather than an error.
    const read = (await savePageFromTool(context({}, { currentVersion: 3 }), {
      pageId: "page-1",
      edits: [],
      source: "",
    })) as Record<string, unknown>;
    expect(read).toEqual({ pageId: "page-1", version: 3, title: "Plan", source: source("Plan") });
  });

  it("never stores a run secret in a page's source, title or chat card", async () => {
    const secret = "FAKE_PAGE_SECRET_7246";
    const tx = {
      page: {
        create: vi.fn(async ({ data }: { data: { title: string } }) => ({
          id: "page-1",
          title: data.title,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      pageVersion: { create: vi.fn() },
    };
    const refused = [
      { title: "Plan", source: source(secret) },
      { pageId: "page-1", source: source(secret) },
      { pageId: "page-1", edits: [{ find: 'title="Plan"', replace: `title="${secret}"` }] },
    ];
    for (const [index, args] of refused.entries()) {
      const existing = index === 0 ? undefined : { currentVersion: 1 };
      const result = (await savePageFromTool(context(tx, existing, [secret]), args)) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/secret/) });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(tx.page.create).not.toHaveBeenCalled();
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();

    const titled = (await savePageFromTool(context(tx, undefined, [secret]), {
      title: `Keys ${secret}`,
      source: source("Plan"),
    })) as Record<string, unknown>;
    expect(titled.title).toBe("Keys [redacted]");
    expect(JSON.stringify(tx.page.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
  });

  it("redacts a kept title that holds a secret this run learned after it was saved", async () => {
    const secret = "FAKE_PAGE_SECRET_9132";
    const tx = {
      page: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ title: `Keys ${secret}` })),
        update: vi.fn(),
      },
      pageVersion: { create: vi.fn() },
    };
    const result = (await savePageFromTool(context(tx, { currentVersion: 1 }, [secret]), {
      pageId: "page-1",
      source: source("Plan"),
    })) as Record<string, unknown>;
    expect(result.title).toBe("Keys [redacted]");
    expect(tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { title: "Keys [redacted]" },
    });
    expect(JSON.stringify(tx.pageVersion.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(publishMessage.mock.calls)).not.toContain(secret);
  });

  it("keeps earlier outside provenance after a successful save or help", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const ctx = context(tx) as { state: { tainted: boolean } };
    ctx.state.tainted = true;
    await savePageFromTool(ctx as never, { title: "Plan", source: source("Plan") });
    expect(ctx.state.tainted).toBe(true);
    await savePageFromTool(ctx as never, { help: true });
    expect(ctx.state.tainted).toBe(true);
  });

  it("preserves a concurrent version instead of publishing a partial save", async () => {
    const tx = {
      page: { updateMany: vi.fn(async () => ({ count: 0 })) },
      pageVersion: { create: vi.fn() },
    };
    const result = await savePageFromTool(context(tx, { currentVersion: 1 }), {
      pageId: "page-1",
      source: source("Updated"),
    });
    expect(result).toMatchObject({ unchanged: true, error: expect.stringContaining("changed") });
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it("updates a routine's existing page without posting another card", async () => {
    const tx = {
      page: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ title: "Plan" })),
      },
      pageVersion: { create: vi.fn() },
    };
    const ctx = context(tx, { currentVersion: 1 }) as { run: { trigger: string } };
    ctx.run.trigger = "routine";
    expect(
      await savePageFromTool(ctx as never, { pageId: "page-1", source: source("Updated") }),
    ).toMatchObject({ pageId: "page-1", version: 2 });
    expect(tx.pageVersion.create).toHaveBeenCalledOnce();
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it.each(["create", "source", "edits"])(
    "reuses the committed %s after interruption before effect completion",
    async (mode) => {
      const f = receiptContext(mode !== "create");
      const args =
        mode === "create"
          ? { title: "Plan", source: source("Plan") }
          : mode === "source"
            ? { pageId: "page-1", source: source("Updated") }
            : { pageId: "page-1", edits: [{ find: "Hi", replace: "Hi again" }] };
      f.setRequest(args);
      f.interruptAfterCommit();
      await expect(savePageFromTool(f.ctx, args)).rejects.toThrow("worker interrupted");
      const result = await savePageFromTool(f.ctx, args);
      expect(result).toMatchObject({ pageId: "page-1", version: mode === "create" ? 1 : 2 });
      expect(f.writes).toHaveLength(1);
      expect(f.deliveries).toHaveLength(1);
      expect(f.deliveries[0]?.nonce).toBe("page-save:effect-1");
    },
  );

  it.each(["create", "source", "edits"])(
    "recovers only the durable executing %s receipt before and after publication",
    async (mode) => {
      const f = receiptContext(mode !== "create");
      const args =
        mode === "create"
          ? { title: "Plan", source: source("Plan") }
          : mode === "source"
            ? { pageId: "page-1", source: source("Updated") }
            : { pageId: "page-1", edits: [{ find: "Hi", replace: "Hi again" }] };
      f.setRequest(args);
      expect(await recoverSavedPageFromTool(f.ctx, args)).toBeUndefined();
      expect(f.writes).toHaveLength(0);
      f.interruptAfterCommit();
      await expect(savePageFromTool(f.ctx, args)).rejects.toThrow("worker interrupted");
      const pageReads = f.page.findFirst.mock.calls.length;
      const result = await recoverSavedPageFromTool(f.ctx, args);
      expect(result).toMatchObject({ pageId: "page-1", version: mode === "create" ? 1 : 2 });
      expect(await recoverSavedPageFromTool(f.ctx, args)).toEqual(result);
      expect(f.writes).toHaveLength(1);
      expect(f.deliveries).toEqual([{ nonce: "page-save:effect-1" }]);
      expect(f.page.findFirst).toHaveBeenCalledTimes(pageReads);
      expect(f.externalEffect.findFirst).toHaveBeenLastCalledWith({
        where: {
          id: "effect-1",
          spaceId: "space-1",
          runId: "run-1",
          kind: "save_page",
          run: { userId: "user-1", botId: "bot-1", threadId: "t-1" },
          status: "executing",
        },
        select: { request: true, result: true },
      });
    },
  );

  it("does not write or publish for missing, mismatched or malformed executing receipts", async () => {
    const f = receiptContext(false);
    const args = { title: "Plan", source: source("Plan") };
    f.setRequest(args);
    await savePageFromTool(f.ctx, args);
    const receipt = f.externalEffect.update.mock.calls[0]![0].data.result as Record<
      string,
      unknown
    >;
    for (const result of [
      null,
      {},
      { ...receipt, effectId: "another-effect" },
      { ...receipt, requestDigest: "another-request" },
      { ...receipt, saved: { pageId: "page-1", version: 0, title: "Plan" } },
    ]) {
      f.setResult(result);
      expect(await recoverSavedPageFromTool(f.ctx, args)).toBeUndefined();
    }
    f.setResult(receipt);
    f.setRequest({ ...args, title: "Different request" });
    expect(await recoverSavedPageFromTool(f.ctx, args)).toBeUndefined();
    f.setRequest(args);
    // An absent row also covers a scope/kind/run/status mismatch in the scoped query.
    f.externalEffect.findFirst.mockResolvedValueOnce(null as never);
    expect(await recoverSavedPageFromTool(f.ctx, args)).toBeUndefined();
    expect(await recoverSavedPageFromTool({ ...f.ctx, effect: undefined }, args)).toBeUndefined();
    expect(f.writes).toHaveLength(1);
    expect(f.deliveries).toHaveLength(1);
  });

  it("propagates a failed executing-receipt read without attempting a new save", async () => {
    const f = receiptContext(false);
    const args = { title: "Plan", source: source("Plan") };
    f.externalEffect.findFirst.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recoverSavedPageFromTool(f.ctx, args)).rejects.toThrow("database unavailable");
    expect(f.page.findFirst).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
    expect(f.deliveries).toHaveLength(0);
  });

  it("reuses a published card and allows a different effect to save the same input", async () => {
    const f = receiptContext(false);
    const args = { title: "Plan", source: source("Plan") };
    f.setRequest(args);
    const first = await savePageFromTool(f.ctx, args);
    expect(await savePageFromTool(f.ctx, args)).toEqual(first);
    expect(f.writes).toHaveLength(1);
    expect(f.deliveries).toHaveLength(1);
    f.nextEffect();
    await savePageFromTool(f.ctx, args);
    expect(f.writes).toHaveLength(2);
    expect(f.deliveries).toHaveLength(2);
  });

  it("keeps a retried routine update silent and preserves publication failures", async () => {
    const f = receiptContext(true);
    f.ctx.run.trigger = "routine";
    const args = { pageId: "page-1", source: source("Updated") };
    f.setRequest(args);
    await savePageFromTool(f.ctx, args);
    await savePageFromTool(f.ctx, args);
    expect(f.writes).toHaveLength(1);
    expect(f.deliveries).toHaveLength(0);
    const failed = receiptContext(false);
    failed.setRequest({ title: "Plan", source: source("Plan") });
    failed.ctx.publish = async () => {
      throw new Error("run was cancelled");
    };
    expect(
      await savePageFromTool(failed.ctx, { title: "Plan", source: source("Plan") }),
    ).toMatchObject({
      pageId: "page-1",
      error: expect.stringContaining("saved, but its card could not be posted"),
    });
    expect(failed.writes).toHaveLength(1);
  });

  it("validates the exact stored request and scoped Page receipt before replaying", async () => {
    const args = { pageId: "page-1", source: source("Updated") };
    const f = receiptContext(true);
    f.setRequest({ ...args, source: source("Other request") });
    await expect(savePageFromTool(f.ctx, args)).rejects.toThrow("does not match");
    expect(f.page.findFirst).not.toHaveBeenCalled();
    f.setRequest(args);
    for (const receipt of [
      { pageId: "page-1", version: 2 },
      { kind: "page_save", saved: { pageId: "page-1", version: 2, title: "Plan" } },
    ]) {
      f.setResult(receipt);
      await expect(savePageFromTool(f.ctx, args)).rejects.toThrow("no valid save receipt");
    }
    expect(f.externalEffect.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: "effect-1",
        spaceId: "space-1",
        runId: "run-1",
        kind: "save_page",
        run: { userId: "user-1", botId: "bot-1", threadId: "t-1" },
      },
      select: { request: true, result: true },
    });
    expect(f.writes).toHaveLength(0);
    expect(f.deliveries).toHaveLength(0);
  });

  it("does not re-read or reapply a committed edit after the page was changed or deleted", async () => {
    const f = receiptContext(true);
    const args = { pageId: "page-1", edits: [{ find: "Hi", replace: "Hi again" }] };
    f.setRequest(args);
    const result = await savePageFromTool(f.ctx, args);
    f.page.findFirst.mockRejectedValueOnce(new Error("page was removed"));
    expect(await savePageFromTool(f.ctx, args)).toEqual(result);
    expect(f.writes).toHaveLength(1);
    expect(f.page.findFirst).toHaveBeenCalledOnce();
  });

  it("does not persist a receipt when a competing page version wins", async () => {
    const f = receiptContext(true);
    const args = { pageId: "page-1", source: source("Updated") };
    f.setRequest(args);
    f.page.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await savePageFromTool(f.ctx, args)).toMatchObject({ unchanged: true });
    expect(f.externalEffect.update).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
    expect(f.deliveries).toHaveLength(0);
  });

  it("accepts only a confirmed message winner after a publication unique-key race", async () => {
    const f = receiptContext(false);
    const args = { title: "Plan", source: source("Plan") };
    f.setRequest(args);
    f.ctx.publish = async (_blocks, nonce) => {
      f.deliveries.push({ nonce });
      throw Object.assign(new Error("duplicate nonce"), { code: "P2002" });
    };
    expect(await savePageFromTool(f.ctx, args)).toMatchObject({ pageId: "page-1", version: 1 });
    expect(f.deliveries).toHaveLength(1);
    const missing = receiptContext(false);
    missing.setRequest(args);
    missing.ctx.publish = async () => {
      throw Object.assign(new Error("another unique key"), { code: "P2002" });
    };
    expect(await savePageFromTool(missing.ctx, args)).toMatchObject({
      error: expect.stringContaining("another unique key"),
    });
  });
});

function receiptContext(existing: boolean) {
  let version = existing ? 1 : 0;
  let currentSource = source("Plan");
  let result: unknown = null;
  let interrupted = false;
  let effectId = "effect-1";
  let request: unknown;
  const writes: unknown[] = [];
  const deliveries: Array<{ nonce?: string }> = [];
  const externalEffect = {
    findFirst: vi.fn(async () => ({ result, request })),
    findUnique: vi.fn(async () => ({ result, request })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async ({ data }: { data: { result: unknown } }) => {
      result = data.result;
    }),
  };
  const page = {
    findFirst: vi.fn(async () =>
      version > 0
        ? {
            id: "page-1",
            title: "Plan",
            currentVersion: version,
            versions: [{ source: currentSource }],
          }
        : null,
    ),
    create: vi.fn(async ({ data }: { data: { versions: { create: { source: string } } } }) => {
      version++;
      currentSource = data.versions.create.source;
      writes.push(data);
      return { id: "page-1", title: "Plan" };
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: vi.fn(async () => ({ title: "Plan" })),
  };
  const tx = {
    page,
    externalEffect,
    pageVersion: {
      create: vi.fn(async ({ data }: { data: { source: string; version: number } }) => {
        currentSource = data.source;
        version = data.version;
        writes.push(data);
      }),
    },
  };
  const prisma = {
    ...tx,
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          deliveries.find((item) => item.nonce === where.threadId_clientNonce.clientNonce) ?? null,
      ),
    },
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => {
      const value = await work(tx);
      if (interrupted) {
        interrupted = false;
        throw new Error("worker interrupted");
      }
      return value;
    }),
  };
  const ctx = {
    deps: { prisma },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", trigger: "user" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    state: { tainted: false },
    secrets: [],
    get effect() {
      return { id: effectId };
    },
    publish: vi.fn(async (_blocks: unknown, nonce?: string) => {
      deliveries.push({ nonce });
    }),
  } as unknown as PageToolContext;
  return {
    ctx,
    writes,
    deliveries,
    page,
    externalEffect,
    setResult: (value: unknown) => {
      result = value;
    },
    setRequest: (args: unknown) => {
      request = args;
    },
    interruptAfterCommit: () => {
      interrupted = true;
    },
    nextEffect: () => {
      effectId = "effect-2";
      result = null;
    },
  };
}
