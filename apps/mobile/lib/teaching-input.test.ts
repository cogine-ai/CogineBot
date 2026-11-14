import { describe, expect, it, vi } from "vitest";
import { createTeachingInputQueue, teachingKeyboardInputs } from "./teaching-input";

describe("teaching through the existing native keyboard", () => {
  it("maps text, editing, navigation and control chords to recordable server input", () => {
    expect(teachingKeyboardInputs({ type: "text", text: "合成输入" })).toEqual([
      { kind: "clipboard", payload: { text: "合成输入" } },
    ]);
    expect(teachingKeyboardInputs({ type: "backspace", count: 2 })).toEqual(
      Array(2).fill({ kind: "key", payload: { key: "BackSpace" } }),
    );
    expect(teachingKeyboardInputs({ type: "key", name: "Return" })[0]!.payload.key).toBe("Return");
    expect(teachingKeyboardInputs({ type: "key", name: "ArrowLeft" })[0]!.payload.key).toBe("Left");
    expect(teachingKeyboardInputs({ type: "char", text: "a", control: true })[0]!.payload.key).toBe(
      "ctrl+a",
    );
  });
  it("drains input in order before stop and drops work after scope loss", async () => {
    let resolve!: () => void;
    const first = new Promise<void>((done) => {
      resolve = done;
    });
    const send = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    let current = true;
    const queue = createTeachingInputQueue(send, () => current, vi.fn());
    const inputs = teachingKeyboardInputs({ type: "backspace", count: 2 });
    inputs.forEach(queue.push);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const stopped = vi.fn();
    const stopping = queue.flush().then(stopped);
    expect(stopped).not.toHaveBeenCalled();
    current = false;
    resolve();
    await stopping;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not blindly replay uncertain input or send its queued tail", async () => {
    const send = vi.fn().mockRejectedValue(new Error("lost response"));
    const error = vi.fn();
    const queue = createTeachingInputQueue(send, () => true, error);
    teachingKeyboardInputs({ type: "backspace", count: 3 }).forEach(queue.push);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledOnce();
    send.mockResolvedValue(undefined);
    await queue.recover();
    queue.push({ kind: "key", payload: { key: "Return" } });
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
