import { waitForModelOAuthCompletion } from "@rakazo/core";
import { rpc } from "./api";

export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";

export function modelOAuthUnavailableReason(provider: string): string | undefined {
  return provider === "chatgpt-plan"
    ? "Connect your ChatGPT plan from the local desktop app or a browser on the server computer."
    : undefined;
}

type CompleteOAuthResult =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; error: string };

export async function waitForModelOAuth(
  loginId: string,
  signal?: AbortSignal,
  client: typeof rpc = rpc,
) {
  return waitForModelOAuthCompletion(
    () => client<CompleteOAuthResult>("models/completeOAuth", { loginId }, { signal }),
    { signal },
  );
}
