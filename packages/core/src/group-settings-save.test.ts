import { describe, expect, it, vi } from "vitest";
import { createGroupSettingsSave } from "./group-settings-save.js";
import { userErrorMessage } from "./user-error.js";

const group = {
  id: "group-a",
  spaceId: "space-a",
  name: "Team",
  members: [{ botId: "a" }, { botId: "b" }],
};
const input = { name: " Changed ", botIds: ["b", "c"], expectedBotIds: ["a", "b"] };
const desired = { ...group, name: "Changed", members: [{ botId: "b" }, { botId: "c" }] };
const lost = new TypeError("Connection lost");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  let current = true;
  const update = vi.fn().mockResolvedValue(desired);
  const read = vi.fn().mockResolvedValue(desired);
  const save = createGroupSettingsSave({
    group,
    update,
    read,
    isCurrent: () => current,
    isAmbiguous: (error) => error instanceof TypeError,
  });
  return {
    update,
    read,
    save,
    close: () => {
      current = false;
    },
  };
}
describe("group settings save receipts", () => {
  it("keeps internal lifecycle and malformed receipt diagnostics behind caller copy", async () => {
    const copy = { fallback: "Translated save failed", offline: "Translated offline" };
    const closed = setup();
    closed.close();
    const closedError = await closed.save(input).catch((error: unknown) => error);
    expect(userErrorMessage(closedError, copy)).toBe(copy.fallback);
    const busy = setup();
    const pending = deferred<typeof desired>();
    busy.update.mockReturnValueOnce(pending.promise);
    const first = busy.save(input);
    const busyError = await busy.save(input).catch((error: unknown) => error);
    pending.resolve(desired);
    await first;
    expect(userErrorMessage(busyError, copy)).toBe(copy.fallback);
    const malformed = setup();
    malformed.update.mockResolvedValueOnce(undefined);
    malformed.read.mockRejectedValueOnce(new Error("Read failed"));
    const malformedError = await malformed.save(input).catch((error: unknown) => error);
    expect(userErrorMessage(malformedError, copy)).toBe(copy.fallback);
  });
  it("does not turn an unrelated concurrent rename into a membership conflict", async () => {
    const s = setup();
    const renamed = { ...desired, name: "Renamed elsewhere" };
    s.update.mockResolvedValue(renamed);
    await expect(
      s.save({ botIds: input.botIds, expectedBotIds: input.expectedBotIds }),
    ).resolves.toEqual(renamed);
    expect(s.read).not.toHaveBeenCalled();
  });
  it("does not turn unrelated concurrent membership into a name-only save failure", async () => {
    const s = setup();
    const changed = { ...desired, members: [{ botId: "c" }, { botId: "d" }] };
    s.update.mockResolvedValue(changed);
    await expect(s.save({ name: " Changed " })).resolves.toEqual(changed);
    expect(s.read).not.toHaveBeenCalled();
  });
  it("confirms a lost successful receipt without a second mutation", async () => {
    const s = setup();
    s.update.mockRejectedValueOnce(lost);
    await expect(s.save(input)).resolves.toEqual(desired);
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.read).toHaveBeenCalledTimes(1);
  });
  it("keeps an unknown or malformed read retryable without replaying the write", async () => {
    for (const malformed of [
      undefined,
      null,
      {},
      { ...desired, id: "wrong" },
      { ...desired, spaceId: "wrong" },
    ]) {
      const s = setup();
      s.update.mockRejectedValueOnce(lost);
      s.read.mockResolvedValueOnce(malformed).mockResolvedValueOnce(desired);
      await expect(s.save(input)).rejects.toBe(lost);
      await expect(s.save(input)).resolves.toEqual(desired);
      expect(s.update).toHaveBeenCalledTimes(1);
      expect(s.read).toHaveBeenCalledTimes(2);
    }
  });
  it("retries a name-only uncertain intent without inventing membership CAS after unrelated roster changes", async () => {
    const s = setup();
    const concurrent = { ...group, members: [{ botId: "a" }, { botId: "c" }] };
    const renamed = { ...concurrent, name: "Changed" };
    s.update.mockRejectedValueOnce(lost).mockResolvedValueOnce(renamed);
    s.read.mockResolvedValue(concurrent);
    await expect(s.save({ name: " Changed " })).rejects.toBe(lost);
    await expect(s.save({ name: " Changed " })).resolves.toEqual(renamed);
    expect(s.update).toHaveBeenCalledTimes(2);
    expect(s.update.mock.calls[1]?.[0]).toEqual({ name: " Changed " });
  });
  it("checks an unresolved receipt before the next explicit retry", async () => {
    const s = setup();
    s.update.mockRejectedValueOnce(lost);
    s.read.mockRejectedValueOnce(new Error("Read failed"));
    await expect(s.save(input)).rejects.toBe(lost);
    await expect(s.save(input)).resolves.toEqual(desired);
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.read).toHaveBeenCalledTimes(2);
  });
  it("only retries the original immutable CAS after confirming the original roster", async () => {
    const s = setup();
    s.update.mockRejectedValueOnce(lost);
    s.read.mockResolvedValue(group);
    const draft = {
      ...input,
      botIds: [...input.botIds],
      expectedBotIds: [...input.expectedBotIds],
    };
    await expect(s.save(draft)).rejects.toBe(lost);
    draft.botIds[0] = "intruder";
    draft.expectedBotIds[0] = "intruder";
    await expect(s.save(input)).resolves.toEqual(desired);
    expect(s.update).toHaveBeenCalledTimes(2);
    expect(s.update.mock.calls[1]?.[0]).toEqual(input);
  });
  it("does not turn a definitive retry conflict into later readback success", async () => {
    const s = setup();
    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    s.update.mockRejectedValueOnce(lost).mockRejectedValueOnce(conflict);
    s.read.mockResolvedValue(group);
    await expect(s.save(input)).rejects.toBe(lost);
    await expect(s.save(input)).rejects.toBe(conflict);
    s.read.mockResolvedValue(desired);
    await expect(s.save(input)).rejects.toBe(conflict);
    expect(s.update).toHaveBeenCalledTimes(2);
    expect(s.read).toHaveBeenCalledTimes(2);
  });
  it("never heals a definitive conflict or dispatches an authoritative read", async () => {
    const s = setup();
    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    s.update.mockRejectedValue(conflict);
    await expect(s.save(input)).rejects.toBe(conflict);
    expect(s.read).not.toHaveBeenCalled();
  });
  it("does not rebase a different roster or send a changed uncertain intent", async () => {
    const s = setup();
    s.update.mockRejectedValueOnce(lost);
    s.read.mockResolvedValue({ ...group, members: [{ botId: "a" }, { botId: "d" }] });
    await expect(s.save(input)).rejects.toBe(lost);
    await expect(s.save(input)).rejects.toBe(lost);
    await expect(s.save({ ...input, botIds: ["a", "d"] })).rejects.toBe(lost);
    expect(s.update).toHaveBeenCalledTimes(1);
  });
  it("requires the ordered desired members, name, group, and original Space", async () => {
    for (const readback of [
      { ...desired, members: [...desired.members].reverse() },
      { ...desired, name: "Other" },
      { ...desired, id: "other-group" },
      { ...desired, spaceId: "other-space" },
    ]) {
      const s = setup();
      s.update.mockRejectedValueOnce(lost);
      s.read.mockResolvedValue(readback);
      await expect(s.save(input)).rejects.toBe(lost);
      expect(s.update).toHaveBeenCalledTimes(1);
    }
  });
  it("treats a malformed successful response as an uncertain receipt", async () => {
    const s = setup();
    s.update.mockResolvedValueOnce(undefined);
    await expect(s.save(input)).resolves.toEqual(desired);
    expect(s.read).toHaveBeenCalledTimes(1);
  });
  it("does not publish or retry a read after ownership is lost", async () => {
    const s = setup();
    const pending = deferred<typeof desired>();
    s.read.mockReturnValueOnce(pending.promise);
    s.update.mockRejectedValueOnce(lost);
    const result = s.save(input);
    await vi.waitFor(() => expect(s.read).toHaveBeenCalledTimes(1));
    s.close();
    pending.resolve(desired);
    await expect(result).rejects.toThrow();
    await expect(s.save(input)).rejects.toThrow();
    expect(s.update).toHaveBeenCalledTimes(1);
  });
  it("rejects simultaneous saves without allowing a late receipt to unlock another owner", async () => {
    const s = setup();
    const pending = deferred<typeof desired>();
    s.update.mockReturnValueOnce(pending.promise);
    const first = s.save(input);
    await expect(s.save(input)).rejects.toThrow();
    s.close();
    pending.resolve(desired);
    await expect(first).rejects.toThrow();
    expect(s.update).toHaveBeenCalledTimes(1);
  });
});
