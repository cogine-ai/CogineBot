type Execute = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** GTK message boxes can be untitled; match them to the named application's process. */
export function nativeDialogCandidates(list: string, title?: string, applicationPid?: number) {
  const windows = list.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+\S+\s+(\d+)\s+\S+\s*(.*)$/.exec(line);
    return match ? [{ id: match[1]!, pid: Number(match[2]), title: match[3]! }] : [];
  });
  const owners = new Set(
    windows
      .filter((window) => window.title === title && window.pid > 0)
      .map((window) => window.pid),
  );
  if (title !== "Error" && applicationPid && applicationPid > 0) owners.add(applicationPid);
  return windows.filter(
    (window) =>
      title === undefined ||
      window.title === title ||
      (title !== "Error" && window.title === "" && owners.has(window.pid)),
  );
}

/** Query visible X11 windows directly; GTK dialogs need not be in the EWMH client list. */
export async function visibleNativeDialogs(exec: Execute, title?: string): Promise<string[]> {
  const pattern = title === undefined ? ".+" : `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  let stdout: string;
  try {
    ({ stdout } = await exec("xdotool", ["search", "--onlyvisible", "--name", pattern]));
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 1 && !failure.stderr) return [];
    throw error;
  }
  const dialogs = await Promise.all(
    stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(async (id) => {
        try {
          const properties = await exec("xprop", [
            "-id",
            id,
            "WM_NAME",
            "_NET_WM_WINDOW_TYPE",
            "_NET_WM_STATE",
          ]);
          if (title !== undefined) {
            const actual = /^WM_NAME[^\n]* = (".*")$/m.exec(properties.stdout)?.[1];
            if (!actual || JSON.parse(actual) !== title) return null;
          }
          return /_NET_WM_WINDOW_TYPE_DIALOG|_NET_WM_STATE_MODAL|^WM_NAME[^\n]* = "Error"$/m.test(
            properties.stdout,
          )
            ? id
            : null;
        } catch (error) {
          if ((error as { stderr?: string }).stderr?.includes("BadWindow")) return null;
          throw error;
        }
      }),
  );
  return dialogs.filter((id): id is string => id !== null);
}
