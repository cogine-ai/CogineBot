import { describe, expect, it, vi } from "vitest";
import { visibleNativeDialogs } from "../e2e/native-dialogs.js";

describe("native dialog observation", () => {
  it("finds a visible GTK error without EWMH dialog or modal properties", async () => {
    const exec = vi.fn(async (file: string) => ({
      stdout: file === "xdotool" ? "42\n" : 'WM_NAME(STRING) = "Error"\n',
    }));
    await expect(visibleNativeDialogs(exec, "Error")).resolves.toEqual(["42"]);
    expect(exec).toHaveBeenCalledWith("xdotool", ["search", "--onlyvisible", "--name", "^Error$"]);
    expect(exec.mock.calls.some(([file]) => file === "wmctrl")).toBe(false);
  });

  it("excludes ordinary application windows and retains a native modal", async () => {
    const exec = vi.fn(async (file: string, args: string[]) => ({
      stdout:
        file === "xdotool"
          ? "11\n22\n"
          : args[1] === "22"
            ? "_NET_WM_STATE(ATOM) = _NET_WM_STATE_MODAL"
            : 'WM_NAME(STRING) = "Console"',
    }));
    await expect(visibleNativeDialogs(exec)).resolves.toEqual(["22"]);
  });

  it("escapes the entire exact title", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    await visibleNativeDialogs(exec, "App (Dev)+");
    expect(exec).toHaveBeenCalledWith("xdotool", [
      "search",
      "--onlyvisible",
      "--name",
      "^App \\(Dev\\)\\+$",
    ]);
  });

  it("treats only an empty no-match result as no dialog", async () => {
    const noMatch = vi.fn().mockRejectedValue({ code: 1, stderr: "" });
    await expect(visibleNativeDialogs(noMatch)).resolves.toEqual([]);
    const failed = { code: 1, stderr: "Can't open display" };
    await expect(visibleNativeDialogs(vi.fn().mockRejectedValue(failed))).rejects.toBe(failed);
  });

  it("ignores a disappearing window while preserving other inspection errors", async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === "xdotool") return { stdout: "42\n" };
      throw { stderr: "BadWindow (invalid Window parameter)" };
    });
    await expect(visibleNativeDialogs(exec)).resolves.toEqual([]);
    exec.mockImplementation(async (file) => {
      if (file === "xdotool") return { stdout: "42\n" };
      throw new Error("inspection failed");
    });
    await expect(visibleNativeDialogs(exec)).rejects.toThrow("inspection failed");
  });
});
