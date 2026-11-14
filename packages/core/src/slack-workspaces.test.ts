import type { SlackInstallationOutputs } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSlackWorkspaces, slackAuthorizationUrl } from "./slack-workspaces.js";

const row = {
  id: "workspace",
  botId: "bot",
  workspaceName: "Synthetic workspace",
  installerName: null,
  status: "active" as const,
  revision: 1,
};
const issued = {
  attemptId: "a".repeat(64),
  url: "https://slack.com/oauth/v2/authorize?state=fake",
  expiresAt: "2030-01-01T00:00:00.000Z",
};
function fixture() {
  let current = true;
  const api = {
    list: vi.fn(
      async (): Promise<SlackInstallationOutputs["list"]> => ({
        available: true,
        workspaces: [row],
      }),
    ),
    start: vi.fn(async () => issued),
    attempt: vi.fn(
      async (): Promise<SlackInstallationOutputs["attempt"]> => ({ status: "pending" }),
    ),
    completeMobile: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(async () => ({ ok: true as const })),
    pause: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
  };
  const changed = vi.fn();
  const openBrowser = vi.fn<(url: string) => Promise<string | null | undefined>>(
    async () => undefined,
  );
  const manager = createSlackWorkspaces({ api, current: () => current, changed, openBrowser });
  return {
    api,
    changed,
    openBrowser,
    manager,
    leave: () => {
      current = false;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("Slack workspace reconciliation", () => {
  it("opens only a validated system-browser URL and binds the reconnect revision", async () => {
    const f = fixture();
    await f.manager.refresh();
    await f.manager.start("bot", row);
    expect(f.api.start).toHaveBeenCalledWith({
      botId: "bot",
      returnTo: "mobile",
      reconnect: { id: row.id, expectedRevision: 1 },
    });
    expect(f.openBrowser).toHaveBeenCalledWith(issued.url);
    expect(f.manager.state().attempt).toEqual(issued);
    await f.manager.start("other");
    expect(f.api.start).toHaveBeenCalledTimes(1);
  });
  it.each([
    "https://evil.test/oauth/v2/authorize",
    "https://slack.com.evil.test/oauth/v2/authorize",
    "https://name@slack.com/oauth/v2/authorize",
    "http://slack.com/oauth/v2/authorize",
    "https://slack.com/other",
  ])("rejects unsafe OAuth URL %s", (url) => {
    expect(() => slackAuthorizationUrl(url)).toThrow();
  });
  it("completes a matching native callback once and reads the committed result after a lost response", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.openBrowser.mockResolvedValue("coginebot://slack-workspaces?state=fake&code=synthetic-code");
    f.api.completeMobile.mockImplementationOnce(async () => {
      f.api.attempt.mockResolvedValue({ status: "connected" });
      throw new Error("lost");
    });
    await f.manager.start("bot");
    expect(f.api.completeMobile).toHaveBeenCalledExactlyOnceWith({
      state: "fake",
      code: "synthetic-code",
    });
    expect(f.manager.state()).toMatchObject({
      attempt: null,
      outcome: "connected",
      readFailed: false,
    });
    await f.manager.refresh();
    expect(f.api.completeMobile).toHaveBeenCalledTimes(1);
  });
  it.each([
    "coginebot://slack-workspaces?state=other&code=fake",
    "https://evil.test?state=fake&code=fake",
    "coginebot://slack-workspaces?state=fake&state=other",
    "coginebot://slack-workspaces/other?state=fake",
  ])("rejects mismatched native callback %s", async (callback) => {
    const f = fixture();
    await f.manager.refresh();
    f.openBrowser.mockResolvedValue(callback);
    await f.manager.start("bot");
    expect(f.api.completeMobile).not.toHaveBeenCalled();
    expect(f.manager.state().error).toBe(true);
  });
  it("cancels a dismissed system authorization browser", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.openBrowser.mockResolvedValue(null);
    f.api.cancel.mockImplementationOnce(async () => {
      f.api.attempt.mockResolvedValue({ status: "expired" });
      return { ok: true };
    });
    await f.manager.start("bot");
    expect(f.api.cancel).toHaveBeenCalledOnce();
    expect(f.manager.state()).toMatchObject({ attempt: null, outcome: "cancelled" });
  });
  it("ignores an old browser result after switching user/Space", async () => {
    const f = fixture();
    await f.manager.refresh();
    const browser = deferred<string>();
    f.openBrowser.mockReturnValueOnce(browser.promise);
    const work = f.manager.start("bot");
    await vi.waitFor(() => expect(f.openBrowser).toHaveBeenCalled());
    f.leave();
    browser.resolve("coginebot://slack-workspaces?state=fake&code=synthetic");
    await work;
    expect(f.api.completeMobile).not.toHaveBeenCalled();
  });
  it("reads a committed pause after its response was lost, then resumes with the new revision", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.api.pause.mockImplementationOnce(async () => {
      f.api.list.mockResolvedValue({
        available: true,
        workspaces: [{ ...row, status: "paused", revision: 2 }],
      });
      throw new Error("response lost");
    });
    await f.manager.pause(row);
    expect(f.manager.state().list?.workspaces[0]).toMatchObject({ status: "paused", revision: 2 });
    await f.manager.pause(f.manager.state().list!.workspaces[0]!);
    expect(f.api.pause).toHaveBeenLastCalledWith({
      id: row.id,
      expectedRevision: 2,
      paused: false,
    });
  });
  it("locks every mutation after write/read failure until a successful explicit read", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.api.remove.mockRejectedValueOnce(new Error("response lost"));
    f.api.list.mockRejectedValueOnce(new Error("offline"));
    await f.manager.remove(row);
    expect(f.manager.state().readFailed).toBe(true);
    await f.manager.remove(row);
    await f.manager.pause(row);
    await f.manager.start("bot");
    expect(f.api.remove).toHaveBeenCalledTimes(1);
    expect(f.api.pause).not.toHaveBeenCalled();
    expect(f.api.start).not.toHaveBeenCalled();
    f.api.list.mockResolvedValue({ available: true, workspaces: [] });
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({ readFailed: false, list: { workspaces: [] } });
  });
  it("reads back a conflict instead of replaying the stale revision", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.api.pause.mockRejectedValue(new Error("conflict"));
    f.api.list.mockResolvedValue({ available: true, workspaces: [{ ...row, revision: 5 }] });
    await f.manager.pause(row);
    expect(f.api.pause).toHaveBeenCalledTimes(1);
    expect(f.manager.state().list?.workspaces[0]?.revision).toBe(5);
  });
  it.each(["connected", "cancelled", "failed", "expired"] as const)(
    "reads the list before settling %s and permits an explicit retry",
    async (status) => {
      const f = fixture();
      await f.manager.refresh();
      await f.manager.start("bot");
      f.api.attempt.mockResolvedValue({ status });
      f.api.list.mockRejectedValueOnce(new Error("offline"));
      await f.manager.refresh();
      expect(f.manager.state().attempt).toEqual(issued);
      expect(f.manager.state().readFailed).toBe(true);
      await f.manager.refresh();
      expect(f.manager.state()).toMatchObject({
        attempt: null,
        outcome: status,
        readFailed: false,
      });
      await f.manager.start("bot");
      expect(f.api.start).toHaveBeenCalledTimes(2);
    },
  );
  it("keeps a cancelled attempt until readback, including a lost cancel response", async () => {
    const f = fixture();
    await f.manager.refresh();
    await f.manager.start("bot");
    f.api.cancel.mockImplementationOnce(async () => {
      f.api.attempt.mockResolvedValue({ status: "expired" });
      throw new Error("lost");
    });
    await f.manager.cancel();
    expect(f.api.cancel).toHaveBeenCalledWith({ attemptId: issued.attemptId });
    expect(f.manager.state().attempt).toBeNull();
  });
  it("never launches late authorization after leaving its user/Space", async () => {
    const f = fixture();
    await f.manager.refresh();
    const start = deferred<typeof issued>();
    f.api.start.mockReturnValueOnce(start.promise);
    const pending = f.manager.start("bot");
    f.leave();
    f.changed.mockClear();
    start.resolve(issued);
    await pending;
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
  });
  it("ignores late reads after disposal and does not mutate another scope", async () => {
    const f = fixture();
    const list = deferred<SlackInstallationOutputs["list"]>();
    f.api.list.mockReturnValueOnce(list.promise);
    const pending = f.manager.refresh();
    f.manager.dispose();
    list.resolve({ available: true, workspaces: [row] });
    await pending;
    expect(f.changed).not.toHaveBeenCalled();
    await f.manager.start("bot");
    expect(f.api.start).not.toHaveBeenCalled();
  });
  it("serializes fast repeated writes", async () => {
    const f = fixture();
    await f.manager.refresh();
    const pause = deferred<{ ok: true }>();
    f.api.pause.mockReturnValueOnce(pause.promise);
    const pending = f.manager.pause(row);
    await f.manager.pause(row);
    await f.manager.remove(row);
    expect(f.api.pause).toHaveBeenCalledTimes(1);
    expect(f.api.remove).not.toHaveBeenCalled();
    pause.resolve({ ok: true });
    await pending;
  });
  it("does not let an older in-flight read overwrite a write's readback", async () => {
    const f = fixture();
    await f.manager.refresh();
    const old = deferred<SlackInstallationOutputs["list"]>();
    f.api.list.mockReturnValueOnce(old.promise);
    const reading = f.manager.refresh();
    f.api.list.mockResolvedValue({
      available: true,
      workspaces: [{ ...row, revision: 2, status: "paused" }],
    });
    await f.manager.pause(row);
    old.resolve({ available: true, workspaces: [row] });
    await reading;
    expect(f.manager.state().list?.workspaces[0]?.revision).toBe(2);
  });
  it("recovers a failed mutation readback while the invalidated refresh stays pending", async () => {
    const f = fixture();
    await f.manager.refresh();
    const old = deferred<SlackInstallationOutputs["list"]>();
    f.api.list.mockReturnValueOnce(old.promise);
    const oldRead = f.manager.refresh();
    f.api.list.mockRejectedValueOnce(new Error("readback offline"));
    await f.manager.pause(row);
    expect(f.manager.state()).toMatchObject({ readFailed: true, busy: false });
    const recovered = { ...row, revision: 2, status: "paused" as const };
    f.api.list.mockResolvedValue({ available: true, workspaces: [recovered] });
    await f.manager.refresh();
    expect(f.api.list).toHaveBeenCalledTimes(4);
    expect(f.manager.state()).toMatchObject({
      readFailed: false,
      list: { workspaces: [recovered] },
    });
    await f.manager.pause(recovered);
    expect(f.api.pause).toHaveBeenLastCalledWith({
      id: row.id,
      expectedRevision: 2,
      paused: false,
    });
    old.resolve({ available: true, workspaces: [row] });
    await oldRead;
    expect(f.manager.state().list?.workspaces[0]?.revision).toBe(2);
  });
  it.each(["resolve", "reject"] as const)(
    "an obsolete read's %s cannot release a newer refresh lock or alter state",
    async (settle) => {
      const f = fixture();
      await f.manager.refresh();
      const old = deferred<SlackInstallationOutputs["list"]>();
      f.api.list.mockReturnValueOnce(old.promise);
      const oldRead = f.manager.refresh();
      f.api.list.mockRejectedValueOnce(new Error("readback offline"));
      await f.manager.pause(row);
      const next = deferred<SlackInstallationOutputs["list"]>();
      f.api.list.mockReturnValueOnce(next.promise);
      const retry = f.manager.refresh();
      expect(f.api.list).toHaveBeenCalledTimes(4);
      f.changed.mockClear();
      if (settle === "resolve") old.resolve({ available: false, workspaces: [] });
      else old.reject(new Error("obsolete failure"));
      await oldRead;
      expect(f.changed).not.toHaveBeenCalled();
      await f.manager.refresh();
      expect(f.api.list).toHaveBeenCalledTimes(4);
      expect(f.manager.state().readFailed).toBe(true);
      next.resolve({ available: true, workspaces: [{ ...row, revision: 2, status: "paused" }] });
      await retry;
      expect(f.manager.state()).toMatchObject({
        readFailed: false,
        list: { workspaces: [{ revision: 2, status: "paused" }] },
      });
      await f.manager.refresh();
      expect(f.api.list).toHaveBeenCalledTimes(5);
    },
  );
  it.each(["dispose", "scope"] as const)(
    "invalidates a pending recovery read on %s",
    async (leave) => {
      const f = fixture();
      await f.manager.refresh();
      const old = deferred<SlackInstallationOutputs["list"]>();
      f.api.list.mockReturnValueOnce(old.promise);
      const oldRead = f.manager.refresh();
      f.api.list.mockRejectedValueOnce(new Error("readback offline"));
      await f.manager.pause(row);
      const next = deferred<SlackInstallationOutputs["list"]>();
      f.api.list.mockReturnValueOnce(next.promise);
      const retry = f.manager.refresh();
      expect(f.api.list).toHaveBeenCalledTimes(4);
      if (leave === "dispose") f.manager.dispose();
      else f.leave();
      f.changed.mockClear();
      old.resolve({ available: true, workspaces: [row] });
      next.resolve({ available: true, workspaces: [{ ...row, revision: 2 }] });
      await Promise.all([oldRead, retry]);
      await f.manager.refresh();
      await f.manager.remove(row);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.api.list).toHaveBeenCalledTimes(4);
      expect(f.api.remove).not.toHaveBeenCalled();
    },
  );
  it("preserves Web restrictions when Slack or the bot is unavailable, but permits removal", async () => {
    const f = fixture();
    f.api.list.mockResolvedValue({ available: false, workspaces: [row] });
    await f.manager.refresh();
    await f.manager.start("bot");
    await f.manager.pause(row);
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.api.pause).not.toHaveBeenCalled();
    await f.manager.remove(row);
    expect(f.api.remove).toHaveBeenCalledWith({ id: row.id, expectedRevision: 1 });
    f.api.list.mockResolvedValue({
      available: true,
      workspaces: [{ ...row, status: "unavailable" }],
    });
    await f.manager.refresh();
    await f.manager.start("bot", { ...row, status: "unavailable" });
    await f.manager.pause({ ...row, status: "unavailable" });
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.api.pause).not.toHaveBeenCalled();
  });
  it("reads after a lost start response before permitting another attempt", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.api.start.mockRejectedValueOnce(new Error("lost"));
    f.api.list.mockRejectedValueOnce(new Error("offline"));
    await f.manager.start("bot");
    await f.manager.start("bot");
    expect(f.api.start).toHaveBeenCalledTimes(1);
    await f.manager.refresh();
    await f.manager.start("bot");
    expect(f.api.start).toHaveBeenCalledTimes(2);
  });
});
