import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { combineSignals } from "./connector-safety.js";
import { FakeBrowserProvider, type FakeBrowserProviderOptions } from "./fake-browser.js";
import { withAbort } from "./web-ssrf.js";

const DETACHED_MESSAGE =
  "Page browser is not attached to this computer's Chrome. Use computer_act on the desktop browser instead.";

type LivePayload = Partial<PageBrowserResult>;

type PageActionProof = {
  computer: ComputerRef;
  context: AdapterContext;
  binding: string;
  actions: BrowserActRequest["actions"];
  preparationSignal: AbortSignal;
  requestSignal: AbortSignal | undefined;
  rootStop: AbortSignal;
};

function pageActionBinding(computer: ComputerRef, context: AdapterContext): string {
  return JSON.stringify([
    computer.id,
    computer.botId,
    computer.kind,
    computer.providerRef,
    computer.fresh,
    computer.started,
    context.operationId,
    context.traceId,
    context.spaceId,
    context.userId,
    context.botId,
    context.runId,
    context.screenLeaseId,
    context.cancelRunWork,
  ]);
}

export type LivePageBrowserDriver = (
  computer: ComputerRef,
  request: PageBrowserCommand,
  context: AdapterContext,
) => Promise<LivePayload>;

/**
 * Production page-browser adapter for the bot computer.
 *
 * Fake computers (and the fake sandbox) use the in-process DOM session.
 * Real computers drive the live Chrome already on the graphical display via
 * CDP (`rakazo-page-browser`). If that path cannot operate, return
 * `fallback: "computer_act"` — never report success against a detached DOM.
 */
export class ComputerBrowserProvider implements BrowserProvider {
  private readonly fake: FakeBrowserProvider;
  private readonly sandbox?: SandboxProvider;
  private readonly liveDriver?: LivePageBrowserDriver;
  private readonly pageActionProofs = new WeakMap<BrowserActRequest, PageActionProof>();

  constructor(
    options: FakeBrowserProviderOptions & {
      sandbox?: SandboxProvider;
      /** Test seam for the live CDP helper. */
      liveDriver?: LivePageBrowserDriver;
    } = {},
  ) {
    const { sandbox, liveDriver, ...fakeOptions } = options;
    this.sandbox = sandbox;
    this.liveDriver = liveDriver;
    this.fake = new FakeBrowserProvider(fakeOptions);
  }

  describe() {
    return {
      id: "computer",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: Boolean(
          this.liveDriver || this.sandbox?.pageBrowser || this.sandbox?.describe().id === "fake",
        ),
        refs: true,
        keyless: true,
      },
    };
  }

  async supportsPageActions(
    computer: ComputerRef,
    context: AdapterContext,
    request?: BrowserActRequest,
    preparation?: AbortSignal,
  ): Promise<boolean> {
    if (request) this.pageActionProofs.delete(request);
    const binding = pageActionBinding(computer, context);
    const contextSignal = context.signal;
    const requestSignal = request?.signal;
    const rootStop = combineSignals(contextSignal, requestSignal);
    const preparationSignal = combineSignals(rootStop, preparation);
    const result = this.canUseInProcess(computer)
      ? undefined
      : await this.runLive(
          computer,
          { command: "capabilities" },
          { ...context, signal: preparationSignal },
        );
    const capabilities = result?.capabilities;
    const supported = this.canUseInProcess(computer)
      ? await this.fake.supportsPageActions(computer, { ...context, signal: preparationSignal })
      : result?.ok === true &&
        result.fallback === undefined &&
        result.uncertain !== true &&
        capabilities?.protocol === 2 &&
        capabilities.engine === "agent-browser" &&
        capabilities.engineVersion === "0.41.0" &&
        capabilities.refIdentity === "exact-node-v1" &&
        Array.isArray(capabilities.loginFields) &&
        capabilities.loginFields.includes("username") &&
        capabilities.loginFields.includes("password");
    preparationSignal.throwIfAborted();
    if (
      context.signal !== contextSignal ||
      request?.signal !== requestSignal ||
      binding !== pageActionBinding(computer, context)
    )
      return false;
    if (supported && request) {
      this.pageActionProofs.set(request, {
        computer,
        context,
        binding,
        actions: request.actions,
        preparationSignal,
        requestSignal,
        rootStop,
      });
    }
    return supported;
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    context = { ...context, signal: combineSignals(context.signal, request.signal) };
    if (this.canUseInProcess(computer)) {
      return this.fake.navigate(computer, request, context);
    }
    const live = await this.runLive(computer, { command: "navigate", url: request.url }, context);
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: typeof live?.url === "string" ? live.url : request.url,
        title: typeof live?.title === "string" ? live.title : "",
        ...navigationObservation(live),
        uncertain: live?.uncertain !== false || live?.navigationOutcomeKnown !== true,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
      ...navigationObservation(live),
    };
  }

  async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    context = { ...context, signal: combineSignals(context.signal, request.signal) };
    if (this.canUseInProcess(computer)) {
      return this.fake.snapshot(computer, request, context);
    }
    const live = await this.runLive(computer, { command: "snapshot" }, context);
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : [];
    return {
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : formatTree(elements),
      elements,
      ...(typeof live.loading === "boolean" ? { loading: live.loading } : {}),
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    const proof = this.pageActionProofs.get(request);
    this.pageActionProofs.delete(request);
    const sameRequest =
      proof?.computer === computer &&
      proof.context === context &&
      proof.actions === request.actions &&
      proof.requestSignal === request.signal &&
      proof.binding === pageActionBinding(computer, context);
    const signal = combineSignals(
      context.signal,
      request.signal,
      sameRequest ? proof.rootStop : undefined,
    );
    signal.throwIfAborted();
    const verified = sameRequest && !proof.preparationSignal.aborted;
    if (
      request.actions.some(
        (action) =>
          action.kind === "type" ||
          action.kind === "upload" ||
          (action.kind === "fill" && Boolean(action.origin || action.field)),
      ) &&
      !verified
    ) {
      const preparation = {
        ...context,
        signal: AbortSignal.any([signal, AbortSignal.timeout(22_000)]),
      };
      let supported = false;
      try {
        preparation.signal.throwIfAborted();
        supported = await withAbort(
          Promise.resolve().then(() => this.supportsPageActions(computer, preparation)),
          preparation.signal,
        );
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      if (!supported)
        return {
          ok: false,
          completed: 0,
          uncertain: false,
          url: "",
          title: "",
          ...(preparation.signal.aborted ? { timedOut: true } : {}),
          error: "Page browser action is unavailable on this computer.",
        };
    }
    context = { ...context, signal: AbortSignal.any([signal, AbortSignal.timeout(22_000)]) };
    context.signal.throwIfAborted();
    if (this.canUseInProcess(computer)) {
      return withAbort(
        Promise.resolve().then(() => this.fake.act(computer, request, context)),
        context.signal,
      );
    }
    const live = await withAbort(
      Promise.resolve().then(() =>
        this.runLive(computer, { command: "act", actions: request.actions }, context),
      ),
      context.signal,
    );
    const loginProgress =
      typeof live?.loginFieldsFilled === "number"
        ? { loginFieldsFilled: live.loginFieldsFilled }
        : {};
    // A confirmed refusal is settled: a desktop fallback could repeat an earlier step.
    if (live?.ok === false && live.uncertain === false && live.fallback === undefined) {
      return {
        ok: false,
        completed: typeof live.completed === "number" ? live.completed : 0,
        uncertain: false,
        url: typeof live.url === "string" ? live.url : "",
        title: typeof live.title === "string" ? live.title : "",
        ...navigationObservation(live),
        ...loginProgress,
        error: live.error || DETACHED_MESSAGE,
      };
    }
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        ok: false,
        completed: typeof live?.completed === "number" ? live.completed : 0,
        uncertain: live?.uncertain ?? true,
        url: typeof live?.url === "string" ? live.url : "",
        title: typeof live?.title === "string" ? live.title : "",
        ...navigationObservation(live),
        ...loginProgress,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      ok: true,
      completed: typeof live.completed === "number" ? live.completed : request.actions.length,
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      ...navigationObservation(live),
      ...loginProgress,
    };
  }

  private canUseInProcess(computer: ComputerRef): boolean {
    return computer.kind === "fake";
  }

  private async runLive(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<LivePayload> {
    context.signal.throwIfAborted();
    try {
      const result = this.liveDriver
        ? await this.liveDriver(computer, request, context)
        : this.sandbox?.pageBrowser
          ? await this.sandbox.pageBrowser(computer, request, context)
          : {
              ok: false,
              error: DETACHED_MESSAGE,
              fallback: "computer_act" as const,
              uncertain: false,
              navigationOutcomeKnown: true,
            };
      context.signal.throwIfAborted();
      if (result?.ok === true && request.command !== "capabilities") {
        if (typeof result.url !== "string" || typeof result.title !== "string") {
          throw new Error("Incomplete page browser response");
        }
        if (
          request.command === "snapshot" &&
          (typeof result.tree !== "string" || !Array.isArray(result.elements))
        ) {
          throw new Error("Incomplete page snapshot");
        }
        if (
          request.command === "act" &&
          (!Number.isInteger(result.completed) ||
            result.completed !== request.actions.length ||
            result.uncertain)
        ) {
          throw new Error("Unconfirmed page actions");
        }
      }
      if (
        request.command === "act" &&
        result.completed !== undefined &&
        (!Number.isInteger(result.completed) ||
          result.completed < 0 ||
          result.completed > request.actions.length)
      )
        throw new Error("Invalid page action progress");
      return result;
    } catch (error) {
      context.signal.throwIfAborted();
      return {
        uncertain: request.command !== "snapshot",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      };
    }
  }
}

function navigationObservation(live: LivePayload | undefined) {
  const fields: {
    tree?: string;
    elements?: BrowserSnapshotNode[];
    timedOut?: boolean;
    uncertain?: boolean;
    loading?: boolean;
  } = {};
  if (Array.isArray(live?.elements)) {
    fields.elements = live.elements;
    fields.tree = formatTree(live.elements);
  }
  if (typeof live?.tree === "string") fields.tree = live.tree;
  if (typeof live?.timedOut === "boolean") fields.timedOut = live.timedOut;
  if (typeof live?.uncertain === "boolean") fields.uncertain = live.uncertain;
  if (typeof live?.loading === "boolean") fields.loading = live.loading;
  return fields;
}

function formatTree(elements: BrowserSnapshotNode[]): string {
  if (elements.length === 0) return "(no interactive elements)";
  return elements
    .map((el) => {
      const value =
        el.value !== undefined && el.value !== "" ? ` value=${JSON.stringify(el.value)}` : "";
      const options = el.options ? ` options=${JSON.stringify(el.options)}` : "";
      return `- ${el.role} ${JSON.stringify(el.name)} [${el.ref}]${value}${options}`;
    })
    .join("\n");
}
