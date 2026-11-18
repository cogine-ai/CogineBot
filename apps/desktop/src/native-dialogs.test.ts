import { describe, expect, it, vi } from "vitest";
import { nativeDialogCandidates, visibleNativeDialogs } from "../e2e/native-dialogs.js";

describe("native dialog observation", () => {
  it("includes an untitled GTK window only for the requested application process", () => {
    const list = [
      "0x00400003  0 110   fixture CogineBot Dev",
      "0x00600007  0 110   fixture ",
      "0x00800007  0 220   fixture ",
      "0x00a00003  0 220   fixture Other application",
      "0x00b00003  0 0   fixture CogineBot Dev",
      "0x00c00007  0 0   fixture ",
    ].join("\n");
    expect(nativeDialogCandidates(list, "CogineBot Dev").map((window) => window.id)).toEqual([
      "0x00400003",
      "0x00600007",
      "0x00b00003",
    ]);
  });
  it("retains the launched process through a failed document title and closed parent", () => {
    const list =
      "0x1  0 110 fixture Development fixture unavailable\n0x2  0 110 fixture \n0x3  0 220 fixture \n";
    expect(nativeDialogCandidates(list, "CogineBot Dev", 110).map((window) => window.id)).toEqual([
      "0x2",
    ]);
    expect(
      nativeDialogCandidates("0x2  0 110 fixture \n", "CogineBot Dev", 110).map(
        (window) => window.id,
      ),
    ).toEqual(["0x2"]);
  });
  it("retains exact Error selection and supports untitled cleanup windows", () => {
    const list = "0x1  0 110 fixture Error\n0x2  0 110 fixture \n";
    expect(nativeDialogCandidates(list, "Error").map((window) => window.id)).toEqual(["0x1"]);
    expect(nativeDialogCandidates(list).map((window) => window.id)).toEqual(["0x1", "0x2"]);
  });
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

  it("rejects a case-insensitive search match with a different actual title", async () => {
    const exec = vi.fn(async (file: string) => ({
      stdout:
        file === "xdotool"
          ? "42\n"
          : 'WM_NAME(STRING) = "coginebot dev"\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_MODAL',
    }));
    await expect(visibleNativeDialogs(exec, "CogineBot Dev")).resolves.toEqual([]);
    await expect(visibleNativeDialogs(exec, "coginebot dev")).resolves.toEqual(["42"]);
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
