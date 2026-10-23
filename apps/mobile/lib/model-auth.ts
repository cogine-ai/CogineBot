import { waitForModelOAuthCompletion } from "@rakazo/core";
import { rpc } from "./api";

export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";

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
