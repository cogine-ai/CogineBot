import type { SlackInstallationInputs, SlackInstallationOutputs } from "@rakazo/contracts";

export type SlackWorkspace = SlackInstallationOutputs["list"]["workspaces"][number];
export type SlackWorkspaceState = {
  list: SlackInstallationOutputs["list"] | null;
  attempt: SlackInstallationOutputs["start"] | null;
  busy: boolean;
  readFailed: boolean;
  error: boolean;
  outcome: SlackInstallationOutputs["attempt"]["status"] | null;
};
type Api = {
  [K in keyof SlackInstallationInputs]: (
    input: SlackInstallationInputs[K],
  ) => Promise<SlackInstallationOutputs[K]>;
};

export function slackAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== "https://slack.com" ||
    url.pathname !== "/oauth/v2/authorize" ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Slack authorization URL");
  return url.href;
}

/** One instance belongs to one user/Space. Writes never optimistically change server state. */
export function createSlackWorkspaces(options: {
  api: Api;
  current: () => boolean;
  changed: (state: SlackWorkspaceState) => void;
  openBrowser: (url: string) => Promise<string | null | undefined>;
}) {
  let state: SlackWorkspaceState = {
    list: null,
    attempt: null,
    busy: false,
    readFailed: false,
    error: false,
    outcome: null,
  };
  let disposed = false;
  let generation = 0;
  let reading = false;
  let cancelledAttempt: string | null = null;
  const current = () => !disposed && options.current();
  const activeAttempt = () => state.attempt;
  const publish = (patch: Partial<SlackWorkspaceState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    options.changed(state);
  };
  async function read() {
    const request = ++generation;
    try {
      const attempt = state.attempt;
      const outcome = attempt ? await options.api.attempt({ attemptId: attempt.attemptId }) : null;
      if (!current()) return;
      const list = await options.api.list(undefined);
      if (!current() || request !== generation) return;
      publish({
        list,
        readFailed: false,
        ...(outcome && outcome.status !== "pending"
          ? {
              attempt: null,
              outcome:
                outcome.status === "expired" && cancelledAttempt === attempt?.attemptId
                  ? "cancelled"
                  : outcome.status,
              error: outcome.status === "failed",
            }
          : {}),
      });
    } catch {
      if (request === generation) publish({ readFailed: true });
    }
  }
  async function refresh() {
    if (!current() || state.busy || reading) return;
    reading = true;
    try {
      await read();
    } finally {
      reading = false;
    }
  }
  const locked = () => !current() || state.busy || state.readFailed || !state.list;
  async function perform(work: () => Promise<void>) {
    if (locked()) return;
    ++generation;
    publish({ busy: true, error: false, outcome: null });
    try {
      await work();
    } catch {
      publish({ error: true });
    } finally {
      // Even a rejected transport may have committed. A failed read keeps every write locked.
      if (current()) await read();
      publish({ busy: false });
    }
  }
  async function cancel() {
    const attempt = state.attempt;
    if (!attempt || !current() || state.busy) return;
    publish({ readFailed: false });
    await perform(async () => {
      await options.api.cancel({ attemptId: attempt.attemptId });
      cancelledAttempt = attempt.attemptId;
    });
  }
  return {
    state: () => state,
    refresh,
    async start(botId: string, workspace?: SlackWorkspace) {
      if (!botId || state.attempt || !state.list?.available || workspace?.status === "unavailable")
        return;
      let issued: SlackInstallationOutputs["start"] | undefined;
      await perform(async () => {
        const attempt = await options.api.start({
          botId,
          returnTo: "mobile",
          ...(workspace
            ? {
                reconnect: { id: workspace.id, expectedRevision: workspace.revision },
              }
            : {}),
        });
        if (!current()) return;
        issued = attempt;
        cancelledAttempt = null;
        publish({ attempt });
      });
      const attempt = issued;
      if (!attempt || !current() || activeAttempt()?.attemptId !== attempt.attemptId) return;
      try {
        const result = await options.openBrowser(slackAuthorizationUrl(attempt.url));
        if (!current() || activeAttempt()?.attemptId !== attempt.attemptId) return;
        if (result === null) {
          await cancel();
          return;
        }
        if (result === undefined) return;
        const callback = new URL(result);
        const expectedState = new URL(attempt.url).searchParams.get("state");
        if (
          callback.protocol !== "coginebot:" ||
          callback.host !== "slack-workspaces" ||
          (callback.pathname && callback.pathname !== "/") ||
          callback.username ||
          callback.password ||
          !expectedState ||
          callback.searchParams.getAll("state").length !== 1 ||
          callback.searchParams.get("state") !== expectedState ||
          callback.searchParams.getAll("code").length > 1
        )
          throw new Error("Invalid Slack callback");
        // This one-shot completion is authenticated by the captured App context.
        // A lost response is reconciled, never replayed with the OAuth code.
        publish({ readFailed: false });
        await perform(async () => {
          await options.api.completeMobile({
            state: expectedState,
            code: callback.searchParams.get("code") ?? undefined,
          });
        });
      } catch {
        publish({ error: true });
        await refresh();
      }
    },
    cancel,
    async pause(row: SlackWorkspace) {
      if (state.attempt || !state.list?.available || !["active", "paused"].includes(row.status))
        return;
      await perform(async () => {
        await options.api.pause({
          id: row.id,
          expectedRevision: row.revision,
          paused: row.status === "active",
        });
      });
    },
    async remove(row: SlackWorkspace) {
      if (state.attempt) return;
      await perform(async () => {
        await options.api.remove({ id: row.id, expectedRevision: row.revision });
      });
    },
    dispose() {
      disposed = true;
      ++generation;
    },
  };
}
