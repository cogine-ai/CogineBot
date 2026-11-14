/** Load native browser code only when authorization is requested. */
export async function openMcpBrowser(url: string, redirectUri: string, signal: AbortSignal) {
  const browser = await import("expo-web-browser");
  if (signal.aborted) return { type: "cancel" };
  let cancel!: () => void;
  const cancelled = new Promise<{ type: string }>((resolve) => {
    cancel = () => {
      // Some hosts cannot dismiss their browser. Still release this attempt locally.
      resolve({ type: "cancel" });
      try {
        browser.dismissAuthSession();
      } catch {
        /* Already closed or unsupported. */
      }
    };
  });
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 5 * 60 * 1000);
  try {
    return await Promise.race([browser.openAuthSessionAsync(url, redirectUri), cancelled]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}
