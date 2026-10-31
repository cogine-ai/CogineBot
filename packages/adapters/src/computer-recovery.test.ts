import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer, replaceComputer } from "./computer-lifecycle.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "recovery",
  traceId: "recovery",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: "fake" | "desktop" = "fake") {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-recovery-"));
  roots.push(root);
  const sandbox: SandboxProvider =
    provider === "desktop" ? new DesktopSandboxProvider({ root }) : new FakeSandboxProvider();
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  const first = await sandbox.provision({ botId: "bot", homePath: root }, context);
  await home.writeFile("bot", "notes.txt", "checkpoint", context);
  await sandbox.writeFile(
    first,
    { path: "notes.txt", content: new TextEncoder().encode("live work") },
    context,
  );
  const row = {
    id: "computer",
    homeKey: "bot",
    scope: "dedicated",
    state: "running",
    providerRef: first.providerRef as string | null,
    kind: first.kind,
    controlHolder: "none",
    controlLeaseId: null,
    maintenanceId: null as string | null,
    homeRevision: "saved",
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };
  // Model the atomic scalar predicates used by claims, including stale references
  // and the updatedAt claim stamp used for booting reclaim / end-of-boot writes.
  const computer = {
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }) => {
      const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
        (key) => !(key in where) || where[key] === row[key as keyof typeof row],
      );
      if (!matches) return { count: 0 };
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) =>
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data),
    ),
  };
  const deps = {
    prisma: {
      computer,
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient,
    sandbox,
    home,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: root,
  };
  return { deps, row, computer, first, root };
}

describe("computer recovery preserves live work", () => {
  it("blocks competing maintenance and boots while an update owns the computer", async () => {
    const { deps, row } = await fixture();
    row.maintenanceId = "other-update";
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    for (const mode of ["update", "recover", "reset"] as const) {
      await expect(replaceComputer(deps, row.id, mode, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("claims a running computer before concurrent workers can create competing replacements", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    // Both workers read the original row before either claims it; later reads
    // (claim stamp, activation) must see the live row so updatedAt fencing works.
    const original = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) return { ...original };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const results = await Promise.allSettled([
      provisionComputer(deps, row.id, context),
      provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
    expect(provision).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(row.providerRef).toBe(successful[0]?.value.providerRef);
    expect(row.state).toBe("running");
  });

  it("rejects a delayed reconnect whose original reference was already replaced", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    const stale = { ...row };
    const winner = await provisionComputer(deps, row.id, context);
    await deps.sandbox.writeFile(
      winner,
      { path: "notes.txt", content: new TextEncoder().encode("winner work") },
      context,
    );
    computer.findUniqueOrThrow.mockResolvedValue(stale);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(winner.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(winner, "notes.txt", context)),
    ).toBe("winner work");
  });

  it("claims an abandoned booting computer only once when callers have no screenLeaseId", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "booting";
    row.providerRef = null;
    const observed = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      // First two reads are the concurrent observations before either claims.
      if (reads <= 2) return { ...observed };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      const results = await Promise.allSettled([
        provisionComputer(deps, row.id, context),
        provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
      expect(provision).toHaveBeenCalledOnce();
      expect(row.state).toBe("running");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves the reference and workspace through an uncertain reconnect and a retry", async () => {
    const { deps, row, first } = await fixture();
    const error = new Error("fetch failed");
    vi.spyOn(deps.sandbox, "provision").mockRejectedValueOnce(error);
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBe(error);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
    expect(restore).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("live work");
  });

  it.each(["running", "error", "stopped", "suspended"])(
    "reconnects desktop files after an adapter restart from %s without importing an old checkpoint",
    async (state) => {
      const { deps, row, root, first } = await fixture("desktop");
      row.state = state;
      deps.sandbox = new DesktopSandboxProvider({ root });
      const restore = vi.spyOn(deps.sandbox, "importWorkspace");
      const reconnected = await provisionComputer(deps, row.id, context);
      expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
      expect(restore).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
      ).toBe("live work");
    },
  );

  it("restores the checkpoint when a desktop workspace is actually absent after restart", async () => {
    const { deps, row, root, first } = await fixture("desktop");
    expect(first.fresh).toBe(true);
    await rm(first.providerRef, { recursive: true });
    deps.sandbox = new DesktopSandboxProvider({ root });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: true });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it.each([
    "Path notes.txt not found",
    "404: file not found",
    "command not found",
    "checkpoint directory does not exist",
    "export process killed",
    "ECONNRESET",
  ])("aborts update and its retry when checkpoint fails with %s", async (message) => {
    const { deps, row, first } = await fixture();
    const error = new Error(message);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw error;
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(error);
      expect(row).toMatchObject({
        state: "running",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it("continues update from the last revision when checkpoint finds the sandbox gone", async () => {
    const { deps, row } = await fixture();
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw Object.assign(new Error("Sandbox not found"), { name: "SandboxNotFoundError" });
    });
    const updated = await replaceComputer(deps, row.id, "update", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it.each(["running", "error"])(
    "updates a %s computer only after saving its current workspace",
    async (state) => {
      const { deps, row } = await fixture();
      row.state = state;
      const updated = await replaceComputer(deps, row.id, "update", context);
      expect(updated.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it.each([
    { label: "storage", gone: false },
    { label: "gone-shaped storage", gone: true },
  ])(
    "blocks recovery and its retry after a complete export on $label failure",
    async ({ gone }) => {
      const { deps, row, first } = await fixture();
      const failure = new Error("Synthetic home commit failure");
      if (gone) failure.name = "SandboxNotFoundError";
      const exportWorkspace = deps.sandbox.exportWorkspace.bind(deps.sandbox);
      let completedExports = 0;
      const exported = vi
        .spyOn(deps.sandbox, "exportWorkspace")
        .mockImplementation(async function* (...args) {
          yield* exportWorkspace(...args);
          completedExports += 1;
        });
      const commit = vi.spyOn(deps.home, "commit").mockRejectedValue(failure);
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      const provision = vi.spyOn(deps.sandbox, "provision");
      for (let attempt = 1; attempt <= 2; attempt++) {
        await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
        expect(completedExports).toBe(attempt);
        expect(commit).toHaveBeenCalledTimes(attempt);
        expect(row).toMatchObject({
          state: "running",
          providerRef: first.providerRef,
          homeRevision: "saved",
        });
        expect(destroy).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        expect(
          new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
        ).toBe("live work");
        expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
      }
      commit.mockRestore();
      const recovered = await replaceComputer(deps, row.id, "recover", context);
      expect(recovered.fresh).toBe(true);
      expect(exported).toHaveBeenCalledTimes(3);
      expect(destroy).toHaveBeenCalledOnce();
      expect(provision).toHaveBeenCalledOnce();
      expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it("blocks recovery and its retry when the committed home revision cannot be recorded", async () => {
    const { deps, row, computer, first } = await fixture();
    const failure = new Error("Synthetic home revision record failure");
    const update = computer.updateMany.getMockImplementation();
    if (!update) throw new Error("Expected the fixture's fenced computer update");
    computer.updateMany.mockImplementation(async (input) => {
      if ("homeRevision" in input.data) throw failure;
      return update(input);
    });
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    const commit = vi.spyOn(deps.home, "commit");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
      expect(exported).toHaveBeenCalledTimes(attempt);
      expect(commit).toHaveBeenCalledTimes(attempt);
      expect(row).toMatchObject({
        state: "running",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
      ).toBe("live work");
      // Storage succeeded even though its revision was not durably recorded on the computer.
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    }
    computer.updateMany.mockImplementation(update);
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(row.homeRevision).not.toBe("saved");
    expect(destroy).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
  });

  it.each([
    { state: "running", stage: "saving" },
    { state: "running", stage: "recreating" },
    { state: "error", stage: "recreating" },
  ] as const)(
    "preserves a $state computer when recovery progress fails at $stage",
    async ({ state, stage }) => {
      const { deps, row, first } = await fixture();
      row.state = state;
      const failure = new Error(`Synthetic ${stage} progress failure`);
      const progress = vi.fn<NonNullable<Parameters<typeof replaceComputer>[5]>>(
        async (current) => {
          if (current === stage) throw failure;
        },
      );
      const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      const provision = vi.spyOn(deps.sandbox, "provision");
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          replaceComputer(deps, row.id, "recover", context, "none", progress),
        ).rejects.toBe(failure);
        expect(row).toMatchObject({ state, providerRef: first.providerRef });
        expect(destroy).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        expect(
          new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
        ).toBe("live work");
        expect(await deps.home.readFile("bot", "notes.txt", context)).toBe(
          state === "running" && stage === "recreating" ? "live work" : "checkpoint",
        );
      }
      if (stage === "saving" || state === "error") expect(exported).not.toHaveBeenCalled();
      else expect(exported).toHaveBeenCalledTimes(2);
      progress.mockImplementation(async () => undefined);
      const recovered = await replaceComputer(deps, row.id, "recover", context, "none", progress);
      expect(recovered.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
      ).toBe(state === "error" ? "checkpoint" : "live work");
    },
  );

  it.each([
    { label: "transport failure", gone: false },
    { label: "gone provider", gone: true },
  ])("recovers the saved home when workspace export stops early with $label", async ({ gone }) => {
    const { deps, row } = await fixture();
    const failure = new Error("Synthetic incomplete workspace export");
    if (gone) failure.name = "SandboxNotFoundError";
    const exportWorkspace = deps.sandbox.exportWorkspace.bind(deps.sandbox);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* (...args) {
      for await (const file of exportWorkspace(...args)) {
        yield file;
        throw failure;
      }
      throw failure;
    });
    const commit = vi.spyOn(deps.home, "commit");
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      state: "running",
      providerRef: recovered.providerRef,
      homeRevision: "saved",
    });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("checkpoint");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it("recovers an error-started computer without exporting its live workspace", async () => {
    const { deps, row } = await fixture();
    row.state = "error";
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    const commit = vi.spyOn(deps.home, "commit");
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(exported).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      state: "running",
      providerRef: recovered.providerRef,
      homeRevision: "saved",
    });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the old reference after ambiguous recovery teardown failure and retries safely", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("Synthetic provider teardown transport failure");
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
    expect(row).toMatchObject({ state: "error", providerRef: first.providerRef });
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    destroy.mockRestore();
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(exported).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
  });

  it("continues recovery when teardown reports the old provider gone", async () => {
    const { deps, row } = await fixture();
    const destroyComputer = deps.sandbox.destroy.bind(deps.sandbox);
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockImplementationOnce(async (...args) => {
      await destroyComputer(...args);
      throw Object.assign(new Error("Synthetic provider already removed"), {
        name: "SandboxNotFoundError",
      });
    });
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
  });

  it("resets a computer stuck suspending after a hung stop", async () => {
    const { deps, row } = await fixture();
    row.state = "suspending";
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("refuses Reset while a suspend claim is still live", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "suspending";
    row.updatedAt = new Date();
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(computer.updateMany).not.toHaveBeenCalled();
    expect(row.state).toBe("suspending");
  });

  it("resets a missing computer after idempotent provider teardown", async () => {
    const { deps, row, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the reference when reset teardown fails ambiguously", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("404: configuration file not found");
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBe(failure);
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(first.providerRef);
  });
});
