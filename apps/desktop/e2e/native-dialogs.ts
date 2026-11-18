type Execute = (file: string, args: string[]) => Promise<{ stdout: string }>;

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
