import { beforeEach, describe, expect, it, vi } from "vitest";

const publishMessage = vi.fn();
const { savePageFromTool } = await import("./page-tools.js");

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
});
