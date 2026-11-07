import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageToolContext } from "./page-tools.js";

import { recoverSavedPageFromTool, savePageFromTool } from "./page-tools.js";

const writeCard = vi.hoisted(() => vi.fn());
vi.mock("./run-messages.js", () => ({ persistMessageInTransaction: writeCard }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  assertRunCanWriteHistory: vi.fn(async () => ({ status: "running", leaseOwner: "worker" })),
}));

const lease = { owner: "worker", fence: 1 };
const lockThread = async () => [{ id: "t-1" }];
const receiptDeliveries = new WeakMap<object, Array<{ nonce?: string }>>();

const source = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Text>Hi</Text>\n  </Page>\n);\nexport default App;\n`;

const newPageCalls = new WeakMap<PageToolContext, (args: Record<string, unknown>) => void>();

function pendingPageEffect() {
  let request: Record<string, unknown> = {};
  let result: unknown = null;
  let call = 0;
  const effect = { id: "not-recorded" };
  return {
    effect,
    externalEffect: {
      findFirst: vi.fn(async () => ({ request, result })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: { result: unknown } }) => {
        result = data.result;
      }),
    },
    record: (args: Record<string, unknown>) => {
      effect.id = `effect-${++call}`;
      request = args;
      result = null;
    },
  };
}

async function saveNewPageCall(ctx: PageToolContext, args: Record<string, unknown>) {
  newPageCalls.get(ctx)!(args);
  return savePageFromTool(ctx, args);
}

function context(
  tx: Record<string, unknown>,
  existing?: { currentVersion: number },
  secrets: string[] = [],
) {
  const pending = pendingPageEffect();
  const prisma = {
    externalEffect: pending.externalEffect,
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
    $transaction: vi.fn(async (work: (client: unknown) => unknown) =>
      work({ ...tx, externalEffect: pending.externalEffect, $queryRaw: lockThread }),
    ),
  };
  const ctx = {
    deps: { prisma },
    effect: pending.effect,
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", trigger: "user" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    secrets,
    state: { tainted: false },
    lease,
  } as unknown as PageToolContext;
  newPageCalls.set(ctx, pending.record);
  return ctx;
}

describe("save_page", () => {
  beforeEach(() => {
    writeCard.mockReset();
    writeCard.mockImplementation(async (tx: object, _run, _role, _blocks, _mark, nonce) => {
      receiptDeliveries.get(tx)?.push({ nonce });
      return { eventSeq: 1, firstResponseRunId: "run-1" };
    });
  });

  it.each(
    [
      {
        name: "group maker in personal chat",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-1",
        group: null,
        allow: false,
      },
      {
        name: "group maker in personal routine",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-1",
        group: null,
        trigger: "routine",
        allow: false,
      },
      {
        name: "group maker in another valid group",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-1",
        group: "group-b",
        allow: false,
      },
      {
        name: "group maker in origin group",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-1",
        group: "group-a",
        allow: true,
      },
      {
        name: "peer in origin group",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-2",
        group: "group-a",
        allow: true,
      },
      {
        name: "orphaned maker in origin group",
        ownerBot: null,
        ownerGroup: "group-a",
        bot: "bot-2",
        group: "group-a",
        allow: true,
      },
      {
        name: "peer outside origin group",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-2",
        group: "group-b",
        allow: false,
      },
      {
        name: "personal maker in origin chat",
        ownerBot: "bot-1",
        ownerGroup: null,
        bot: "bot-1",
        group: null,
        allow: true,
      },
      {
        name: "personal maker in group",
        ownerBot: "bot-1",
        ownerGroup: null,
        bot: "bot-1",
        group: "group-a",
        allow: true,
      },
      {
        name: "personal maker in another group",
        ownerBot: "bot-1",
        ownerGroup: null,
        bot: "bot-1",
        group: "group-b",
        allow: true,
      },
      {
        name: "personal maker in routine",
        ownerBot: "bot-1",
        ownerGroup: null,
        bot: "bot-1",
        group: null,
        trigger: "routine",
        allow: true,
      },
      {
        name: "other bot in shared group",
        ownerBot: "bot-1",
        ownerGroup: null,
        bot: "bot-2",
        group: "group-a",
        allow: false,
      },
      {
        name: "wrong user",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-1",
        group: "group-a",
        user: "other-user",
        allow: false,
      },
      {
        name: "wrong Space",
        ownerBot: "bot-1",
        ownerGroup: "group-a",
        bot: "bot-1",
        group: "group-a",
        space: "other-space",
        allow: false,
      },
      {
        name: "no remaining owner",
        ownerBot: null,
        ownerGroup: null,
        bot: "bot-1",
        group: null,
        allow: false,
      },
    ].flatMap((scope) => ["read", "source", "edits", "title"].map((mode) => ({ ...scope, mode }))),
  )("keeps Page $mode authority for $name", async (scope) => {
    const stored = {
      id: "page-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: scope.ownerBot,
      groupId: scope.ownerGroup,
      title: "Plan",
      currentVersion: 1,
      versions: [{ source: source("Plan") }],
    };
    const update = vi.fn(async () => ({ count: 1 }));
    const version = vi.fn();
    const page = {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; spaceId: string; userId: string; OR: Record<string, unknown>[] };
        }) =>
          where.id === stored.id &&
          where.spaceId === stored.spaceId &&
          where.userId === stored.userId &&
          where.OR.some((branch) =>
            Object.entries(branch).every(
              ([key, value]) => stored[key as keyof typeof stored] === value,
            ),
          )
            ? stored
            : null,
      ),
      updateMany: update,
      findUniqueOrThrow: vi.fn(async () => ({ title: "Plan" })),
    };
    const pending = pendingPageEffect();
    const prisma = {
      page,
      externalEffect: pending.externalEffect,
      $transaction: async <T>(work: (tx: unknown) => Promise<T>) =>
        work({
          page,
          pageVersion: { create: version },
          externalEffect: pending.externalEffect,
          $queryRaw: lockThread,
        }),
    };
    const ctx = {
      deps: { prisma },
      effect: pending.effect,
      run: {
        id: "run-1",
        spaceId: scope.space ?? "space-1",
        userId: scope.user ?? "user-1",
        threadId: "thread-1",
        trigger: scope.trigger ?? "user",
      },
      bot: { id: scope.bot },
      thread: { groupId: scope.group },
      state: { tainted: false },
      secrets: [],
      lease,
    } as unknown as PageToolContext;
    newPageCalls.set(ctx, pending.record);
    const args = {
      pageId: "page-1",
      ...(scope.mode === "source"
        ? { source: source("New") }
        : scope.mode === "edits"
          ? { edits: [{ find: "Hi", replace: "Hello" }] }
          : scope.mode === "title"
            ? { title: "Renamed" }
            : {}),
    };
    const result = await saveNewPageCall(ctx, args);
    if (!scope.allow) {
      expect(result).toEqual({ error: "No page with that pageId belongs to this bot or chat." });
      expect(ctx.state.tainted).toBe(false);
      expect(update).not.toHaveBeenCalled();
      expect(version).not.toHaveBeenCalled();
      expect(writeCard).not.toHaveBeenCalled();
    } else if (scope.mode === "read") {
      expect(result).toMatchObject({ pageId: "page-1", version: 1, source: source("Plan") });
      expect(ctx.state.tainted).toBe(true);
    } else {
      expect(result).toMatchObject({ pageId: "page-1", version: 2 });
      expect(update).toHaveBeenCalledOnce();
      expect(version).toHaveBeenCalledOnce();
      expect(writeCard).toHaveBeenCalledTimes(scope.trigger === "routine" ? 0 : 1);
    }
  });

  it("reports an uncommitted save when the card write fails", async () => {
    writeCard.mockRejectedValueOnce(new Error("run was cancelled"));
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const ctx = context(tx);
    ctx.notify = vi.fn();
    await expect(
      saveNewPageCall(ctx, {
        title: "Plan",
        source: source("Plan"),
      }),
    ).rejects.toThrow("run was cancelled");
    expect(ctx.deps.prisma.externalEffect.update).not.toHaveBeenCalled();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("taints the run when it reads a page's stored source, but not when it saves one", async () => {
    const read = context({}, { currentVersion: 2 });
    const result = (await saveNewPageCall(read, { pageId: "page-1" })) as Record<string, unknown>;
    expect(result.source).toBe(source("Plan"));
    expect((read as { state: { tainted: boolean } }).state.tainted).toBe(true);

    const tx = { page: { create: vi.fn(async () => ({ id: "page-2", title: "New" })) } };
    const save = context(tx);
    await saveNewPageCall(save, { title: "New", source: source("New") });
    expect(tx.page.create).toHaveBeenCalledTimes(1);
    expect((save as { state: { tainted: boolean } }).state.tainted).toBe(false);
  });

  it.each(["before", "during"])(
    "redacts newly learned secrets %s a stored Page read",
    async (when) => {
      const secret = "FAKE_PAGE_READ_SECRET_1764";
      const stored = {
        id: "page-1",
        title: `Keys ${secret}`,
        currentVersion: 2,
        versions: [{ source: source(secret) }],
      };
      const original = JSON.stringify(stored);
      const ctx = context({}, { currentVersion: 2 });
      let release!: (value: typeof stored) => void;
      const pending = new Promise<typeof stored>((resolve) => {
        release = resolve;
      });
      const readPage = vi
        .spyOn(ctx.deps.prisma.page, "findFirst")
        .mockReturnValue(pending as never);
      if (when === "before") ctx.secrets.push(secret);
      const read = saveNewPageCall(ctx, { pageId: "page-1" });
      expect(readPage).toHaveBeenCalledOnce();
      if (when === "during") ctx.secrets.push(secret);
      release(stored);
      const result = await read;
      expect(result).toEqual({
        pageId: "page-1",
        version: 2,
        title: "Keys [redacted]",
        source: source("[redacted]"),
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(stored)).toBe(original);
      expect(ctx.state.tainted).toBe(true);
      expect(ctx.deps.prisma.$transaction).not.toHaveBeenCalled();
      expect(writeCard).not.toHaveBeenCalled();
    },
  );

  it("treats an empty edits list as not sent, as it does a blank title or source", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const created = (await saveNewPageCall(context(tx), {
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
    const read = (await saveNewPageCall(context({}, { currentVersion: 3 }), {
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
      const result = (await saveNewPageCall(context(tx, existing, [secret]), args)) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({ unchanged: true, error: expect.stringMatching(/secret/) });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(tx.page.create).not.toHaveBeenCalled();
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(writeCard).not.toHaveBeenCalled();

    const titled = (await saveNewPageCall(context(tx, undefined, [secret]), {
      title: `Keys ${secret}`,
      source: source("Plan"),
    })) as Record<string, unknown>;
    expect(titled.title).toBe("Keys [redacted]");
    expect(JSON.stringify(tx.page.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(writeCard.mock.calls)).not.toContain(secret);
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
    const result = (await saveNewPageCall(context(tx, { currentVersion: 1 }, [secret]), {
      pageId: "page-1",
      source: source("Plan"),
    })) as Record<string, unknown>;
    expect(result.title).toBe("Keys [redacted]");
    expect(tx.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { title: "Keys [redacted]" },
    });
    expect(JSON.stringify(tx.pageVersion.create.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(writeCard.mock.calls)).not.toContain(secret);
  });

  it("keeps earlier outside provenance after a successful save or help", async () => {
    const tx = { page: { create: vi.fn(async () => ({ id: "page-1", title: "Plan" })) } };
    const ctx = context(tx) as { state: { tainted: boolean } };
    ctx.state.tainted = true;
    await saveNewPageCall(ctx as never, { title: "Plan", source: source("Plan") });
    expect(ctx.state.tainted).toBe(true);
    await saveNewPageCall(ctx as never, { help: true });
    expect(ctx.state.tainted).toBe(true);
  });

  it("preserves a concurrent version instead of publishing a partial save", async () => {
    const tx = {
      page: { updateMany: vi.fn(async () => ({ count: 0 })) },
      pageVersion: { create: vi.fn() },
    };
    const result = await saveNewPageCall(context(tx, { currentVersion: 1 }), {
      pageId: "page-1",
      source: source("Updated"),
    });
    expect(result).toMatchObject({ unchanged: true, error: expect.stringContaining("changed") });
    expect(tx.pageVersion.create).not.toHaveBeenCalled();
    expect(writeCard).not.toHaveBeenCalled();
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
      await saveNewPageCall(ctx as never, { pageId: "page-1", source: source("Updated") }),
    ).toMatchObject({ pageId: "page-1", version: 2 });
    expect(tx.pageVersion.create).toHaveBeenCalledOnce();
    expect(writeCard).not.toHaveBeenCalled();
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
    "recovers only the durable executing %s receipt before and after commit",
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
      { ...receipt, kind: "other_save" },
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

  it("keeps a retried routine update silent and preserves a committed card after notification failure", async () => {
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
    failed.ctx.notify = vi.fn().mockRejectedValue(new Error("notification disconnected"));
    expect(
      await savePageFromTool(failed.ctx, { title: "Plan", source: source("Plan") }),
    ).toMatchObject({
      pageId: "page-1",
    });
    expect(failed.writes).toHaveLength(1);
    expect(failed.deliveries).toHaveLength(1);
  });

  it.each(["retry", "recover", "notify failure"])(
    "redacts current secrets in a committed receipt's %s result",
    async (mode) => {
      const secret = "FAKE[RECEIPT]\\SECRET_7251";
      const f = receiptContext(false);
      const args = { title: `Keys ${secret}`, source: source("Plan") };
      const receipt = {
        kind: "page_save",
        saved: { pageId: "page-1", version: 1, title: `Keys ${secret}` },
        cardEventSeq: mode === "notify failure" ? 1 : null,
        warnings: [`Unknown label ${secret}`],
      };
      const original = JSON.stringify(receipt);
      f.setRequest(args);
      f.setResult(receipt);
      if (mode === "notify failure")
        f.ctx.notify = async () => {
          f.ctx.secrets.push(secret);
          throw new Error(`Cannot publish ${secret}`);
        };
      else f.ctx.secrets.push(secret);
      const result =
        mode === "retry"
          ? await savePageFromTool(f.ctx, args)
          : await recoverSavedPageFromTool(f.ctx, args);
      expect(result).toMatchObject({ pageId: "page-1", version: 1, title: "Keys [redacted]" });
      const text = result as { mention?: string; error?: string };
      expect(text.mention ?? text.error).toContain("[Keys \\[redacted\\]](page:page-1)");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(receipt)).toBe(original);
      expect(f.writes).toHaveLength(0);
      expect(f.page.findFirst).not.toHaveBeenCalled();
    },
  );

  it("redacts a stored secret echoed by a failed edit's validation", async () => {
    const secret = "FAKE_STORED_COMPONENT_7251";
    const ctx = context({}, { currentVersion: 1 }, [secret]);
    const original = `const ${secret} = () => null; export default function App() { return <${secret}/>; }`;
    vi.spyOn(ctx.deps.prisma.page, "findFirst").mockResolvedValue({
      id: "page-1",
      title: "Plan",
      currentVersion: 1,
      versions: [{ source: original }],
    } as never);
    const result = await saveNewPageCall(ctx, {
      pageId: "page-1",
      edits: [{ find: "const ", replace: "" }],
    });
    expect(result).toMatchObject({
      error: "The page has problems; nothing was saved.",
      problems: expect.arrayContaining([expect.stringContaining("[redacted]")]),
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(ctx.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(writeCard).not.toHaveBeenCalled();
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

  it("does not append a version beyond the database integer range", async () => {
    const ctx = context({}, { currentVersion: 2_147_483_647 });
    expect(
      await saveNewPageCall(ctx, {
        pageId: "page-1",
        source: source("Updated"),
      }),
    ).toMatchObject({ unchanged: true, error: expect.stringContaining("version limit") });
    expect(ctx.deps.prisma.externalEffect.update).not.toHaveBeenCalled();
    expect(writeCard).not.toHaveBeenCalled();
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
    $queryRaw: lockThread,
    pageVersion: {
      create: vi.fn(async ({ data }: { data: { source: string; version: number } }) => {
        currentSource = data.source;
        version = data.version;
        writes.push(data);
      }),
    },
  };
  receiptDeliveries.set(tx, deliveries);
  const prisma = {
    ...tx,
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
    lease,
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
