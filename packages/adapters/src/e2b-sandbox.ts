import type { CommandResult } from "@e2b/desktop";
import {
  ApiClient,
  CommandExitError,
  ConnectionConfig,
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
} from "@e2b/desktop";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxPowerState,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  StreamedPortableFile,
  TerminalRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import { SandboxCommandExitError, SandboxUnavailableError } from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { sandboxIdleMs } from "./computer-idle.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import type { LinuxDesktopHost } from "./linux-desktop.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { withAbort } from "./web-ssrf.js";
import { streamWorkspaceBody } from "./workspace-save-policy.js";

const E2B_WORKSPACE = "/home/user/rakazo-home";
const E2B_BROWSER_PROFILES = `${E2B_WORKSPACE}/.browser-profiles`;

export interface E2BSandboxSdk {
  create(options: ReturnType<typeof e2bCreateOptions>): Promise<Sandbox>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Sandbox>;
  connectWithStartReceipt?(
    id: string,
    options: { apiKey: string; timeoutMs: number },
  ): Promise<{ desktop: Sandbox; started: boolean }>;
  pause(
    id: string,
    options: { apiKey: string; signal: AbortSignal },
  ): Promise<boolean> | Promise<void>;
  kill?(id: string, options: { apiKey: string; signal: AbortSignal }): Promise<boolean>;
  getInfo?(
    id: string,
    options: { apiKey: string; signal: AbortSignal },
  ): Promise<{
    sandboxId: string;
    state: string;
  }>;
  attachRunning?(
    id: string,
    options: { apiKey: string; signal: AbortSignal },
  ): Promise<Sandbox | undefined>;
}

class RetainedE2BSandbox extends Sandbox {
  constructor(
    options: ConstructorParameters<typeof Sandbox>[0] & {
      sandboxDomain?: string;
      envdAccessToken?: string;
      trafficAccessToken?: string;
    },
  ) {
    super(options);
  }

  static async connectWithStartReceipt(
    id: string,
    options: { apiKey: string; timeoutMs: number },
  ): Promise<{ desktop: Sandbox; started: boolean }> {
    // Retrying after a lost response could turn a resume receipt into "already running".
    const config = new ConnectionConfig({ ...options, retries: 0 });
    const result = await new ApiClient(config).api.POST("/sandboxes/{sandboxID}/connect", {
      params: { path: { sandboxID: id } },
      body: { timeout: Math.ceil(options.timeoutMs / 1000) },
      signal: config.getSignal(),
    });
    const status = result.response.status;
    if (status === 404 && result.error?.code === 404) {
      throw new SandboxNotFoundError("E2B sandbox not found");
    }
    if (
      (status !== 200 && status !== 201) ||
      result.data?.sandboxID !== id ||
      !result.data.envdVersion
    ) {
      throw new SandboxUnavailableError({ cause: new Error(`E2B connect failed (${status})`) });
    }
    return {
      // This is the active handle. Keep the SDK defaults for long file transfers.
      desktop: new RetainedE2BSandbox({
        ...options,
        sandboxId: id,
        sandboxDomain: result.data.domain ?? undefined,
        envdVersion: result.data.envdVersion,
        envdAccessToken: result.data.envdAccessToken,
        trafficAccessToken: result.data.trafficAccessToken ?? undefined,
      }),
      // The API distinguishes reattaching to a live sandbox from resuming it.
      started: status === 201,
    };
  }

  static async attachRunning(
    id: string,
    options: { apiKey: string; signal: AbortSignal },
  ): Promise<Sandbox | undefined> {
    const config = new ConnectionConfig({ ...options, requestTimeoutMs: 15_000, retries: 0 });
    const result = await new ApiClient(config).api.GET("/sandboxes/{sandboxID}", {
      params: { path: { sandboxID: id } },
      signal: config.getSignal(undefined, options.signal),
    });
    if (result.response.status === 404) return undefined;
    if (!result.response.ok || !result.data) {
      throw new Error(`E2B retained-screen state lookup failed (${result.response.status})`);
    }
    if (result.data.state === "paused") return undefined;
    if (result.data.state !== "running") {
      throw new Error("E2B retained-screen state is unknown");
    }
    // All computers created by this integration explicitly opt out. Older API
    // responses can omit lifecycle. Never infer policy for an unmarked sandbox.
    const autoResume =
      result.data.lifecycle?.autoResume ??
      (result.data.metadata?.rakazo === "computer" && result.data.metadata.botId
        ? false
        : undefined);
    if (autoResume !== false) {
      throw new Error("E2B retained-screen cleanup requires auto-resume to be disabled");
    }
    if (result.data.sandboxID !== id || !result.data.envdVersion) {
      throw new Error("E2B retained-screen state is incomplete");
    }
    // connect() resumes paused sandboxes. The SDK's internal constructor only builds
    // an envd handle; keep this no-resume path covered when upgrading the SDK.
    return new RetainedE2BSandbox({
      ...options,
      sandboxId: id,
      sandboxDomain: result.data.domain ?? undefined,
      envdVersion: result.data.envdVersion,
      envdAccessToken: result.data.envdAccessToken,
      requestTimeoutMs: 15_000,
      retries: 0,
    });
  }
}

export function e2bCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: { botId, rakazo: "computer" },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
  };
}

// How the E2B SDK words a sandbox that no longer exists. It does not always say "not found":
// an expired sandbox surfaces as a TimeoutError about the *sandbox* timeout (502 / Unavailable
// from envd), which used to read as a live sandbox and left every later call throwing forever.
const SANDBOX_GONE_MESSAGE =
  /probably not running anymore|likely due to sandbox timeout|killed or reached its end of life|sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// The same words from a live sandbox: a missing binary or a missing file inside it.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;
/** Only provider-specific evidence of sandbox loss permits automatic replacement. */
export function isSandboxGoneError(error: unknown): boolean {
  const message = errorMessage(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  const seen = new Set<Error>();
  let sandboxGone = false;
  for (
    let current: unknown = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (current instanceof FileNotFoundError) return false;
    if (current.name === "SandboxNotFoundError") sandboxGone = true;
  }
  return sandboxGone || SANDBOX_GONE_MESSAGE.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class E2BSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly desktops = new LinuxDesktop(this.desktopHost((computer) => this.box(computer)));

  private desktopHost(box: (computer: ComputerRef) => Promise<Sandbox>): LinuxDesktopHost {
    return {
      environment: async () => ({
        homeDir: "/home/user",
        workspaceDir: E2B_WORKSPACE,
        browserProfilesDir: E2B_BROWSER_PROFILES,
        displayStart: 20,
        portStart: 6100,
      }),
      run: async (computer, command, context) => {
        const result = await this.runSetupCommand(await box(computer), command, context.signal);
        return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
      screenUrl: async (computer, port) =>
        `https://${(await box(computer)).getHost(port)}/vnc.html`,
    };
  }
  private readonly boxes = new Map<string, Sandbox>();
  private readonly connections = new Map<string, Promise<Sandbox>>();
  private readonly startReceipts = new WeakSet<Sandbox>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly computerOperations = new Map<string, { pending: number }>();

  constructor(
    private readonly apiKey: string,
    private readonly sdk: E2BSandboxSdk = RetainedE2BSandbox as unknown as E2BSandboxSdk,
  ) {}

  describe() {
    return {
      id: "e2b",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private async box(computer: ComputerRef, explicitProvision = false): Promise<Sandbox> {
    const id = computer.providerRef || computer.id;
    const operation = this.beginOperation(id);
    try {
      for (;;) {
        const existing = this.boxes.get(id);
        if (existing && (!explicitProvision || !this.sdk.connectWithStartReceipt)) {
          const lastTouched = this.lastTouchedAt.get(id) ?? 0;
          if (Date.now() - lastTouched < 60_000) return existing;
          // A cached handle to a sandbox E2B already killed keeps throwing on every call, and the
          // process never reconnects. The keepalive is the cheapest place to notice and drop it.
          const gone = await existing.setTimeout(sandboxIdleMs()).then(
            () => false,
            (error: unknown) => isSandboxGoneError(error),
          );
          if (this.computerOperations.get(id) !== operation) {
            throw new Error("computer connection stopped during teardown");
          }
          if (this.boxes.get(id) !== existing) continue;
          if (!gone) {
            this.lastTouchedAt.set(id, Date.now());
            return existing;
          }
          this.forgetCached(id);
        }
        const pending = this.connections.get(id);
        if (pending) {
          const connected = await pending;
          if (this.computerOperations.get(id) !== operation) {
            throw new Error("computer connection stopped during teardown");
          }
          return connected;
        }
        const options = { apiKey: this.apiKey, timeoutMs: sandboxIdleMs() };
        const connecting = this.sdk.connectWithStartReceipt
          ? this.sdk.connectWithStartReceipt(id, options).then(({ desktop, started }) => {
              if (started) this.startReceipts.add(desktop);
              else this.startReceipts.delete(desktop);
              return desktop;
            })
          : this.sdk.connect(id, options);
        let connection!: Promise<Sandbox>;
        connection = connecting
          .then(
            (connected) => {
              if (
                this.computerOperations.get(id) !== operation ||
                this.connections.get(id) !== connection
              ) {
                throw new Error("computer connection stopped during teardown");
              }
              this.boxes.set(connected.sandboxId, connected);
              this.lastTouchedAt.set(connected.sandboxId, Date.now());
              return connected;
            },
            (error: unknown) => {
              if (
                this.computerOperations.get(id) !== operation ||
                this.connections.get(id) !== connection
              ) {
                throw new Error("computer connection stopped during teardown");
              }
              if (isSandboxGoneError(error) && this.boxes.get(id) === existing) {
                this.forgetCached(id);
              }
              throw error;
            },
          )
          .finally(() => {
            if (this.connections.get(id) === connection) this.connections.delete(id);
          });
        this.connections.set(id, connection);
        const connected = await connection;
        if (this.computerOperations.get(id) !== operation) {
          throw new Error("computer connection stopped during teardown");
        }
        return connected;
      }
    } catch (error) {
      if (this.computerOperations.get(id) !== operation) {
        throw new Error("computer connection stopped during teardown");
      }
      throw error;
    } finally {
      this.endOperation(id, operation);
    }
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    const id = request.providerKind === "e2b" ? request.providerRef : undefined;
    const operation = id ? this.beginOperation(id) : undefined;
    const assertCurrent = () => {
      if (id && this.computerOperations.get(id) !== operation) {
        throw new Error("computer connection stopped during teardown");
      }
    };
    try {
      if (id) {
        // Before dispatch only. Once sent, keep the receipt available for lifecycle recovery.
        _context.signal.throwIfAborted();
        try {
          const ref = { id, providerRef: id, kind: "e2b" as const, botId: request.botId };
          const desktop = await this.box(ref, true);
          assertCurrent();
          return {
            id: desktop.sandboxId,
            botId: request.botId,
            kind: "e2b",
            providerRef: desktop.sandboxId,
            fresh: false,
            ...(this.startReceipts.has(desktop) ? { started: true } : {}),
          };
        } catch (error) {
          assertCurrent();
          // A transport failure says nothing about the workspace still on the server.
          if (!isSandboxGoneError(error)) throw error;
          if (this.boxes.has(id) || this.connections.has(id)) {
            throw new Error("computer connection stopped during teardown");
          }
          this.forgetCached(id);
        }
      }
      // The generation must survive box's rejection handoff until this dispatch decision.
      assertCurrent();
      if (id) _context.signal.throwIfAborted();
      const desktop = await this.sdk.create(e2bCreateOptions(request.botId, this.apiKey));
      this.boxes.set(desktop.sandboxId, desktop);
      this.lastTouchedAt.set(desktop.sandboxId, Date.now());
      // A create already sent before teardown still returns its handle for caller cleanup.
      return {
        id: desktop.sandboxId,
        botId: request.botId,
        kind: "e2b",
        providerRef: desktop.sandboxId,
        fresh: true,
      };
    } finally {
      if (id && operation) this.endOperation(id, operation);
    }
  }

  async prepare(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const desktop = await this.box(computer);
    if (computer.fresh) await desktop.files.makeDir(E2B_WORKSPACE);
    const result = await this.runSetupCommand(desktop, PREPARE_LINUX_DESKTOP, _context.signal);
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "could not prepare computer desktop tools");
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    // Cancellation checks the live sandbox without joining an execution connection that can resume it.
    const desktop = context.cancelRunWork
      ? await this.attachRunningBox(computer, context.signal)
      : await this.box(computer);
    if (context.cancelRunWork) context.signal.throwIfAborted();
    if (!desktop) {
      yield { type: "exit", code: 0 };
      return;
    }
    const cmd = sandboxCommandArgv(request).map(shellQuote).join(" ");
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await desktop.commands.run(cmd, {
        cwd: e2bCwd(request.cwd),
        envs: request.env,
        signal: context.signal,
        timeoutMs,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield {
        type: "exit",
        code: result.exitCode ?? 0,
        ...(Number.isInteger(result.exitCode) ? { terminalStateVerified: true } : {}),
      };
    } catch (error) {
      if (error instanceof TimeoutError) {
        yield {
          type: "stderr",
          data: `command timed out after ${timeoutMs} ms\n`,
        };
        yield { type: "exit", code: 124 };
        return;
      }
      if (
        error instanceof CommandExitError &&
        Number.isInteger(error.exitCode) &&
        error.exitCode !== 0
      ) {
        throw new SandboxCommandExitError(error.exitCode, error);
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    if (!request.onlyIfRunning) return this.desktops.connectScreen(computer, request, context);
    const desktop = await this.attachRunningBox(computer, context.signal);
    if (!desktop) return { url: null, mimeType: "text/html", close: async () => undefined };
    return this.desktops.connectScreen(
      computer,
      request,
      context,
      this.desktopHost(async () => desktop),
    );
  }
  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, context);
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    if (!interactive && controlToken && this.sdk.attachRunning) {
      const desktop = await this.attachRunningBox(computer, context.signal);
      if (!desktop) return;
      return this.desktops.setScreenControl(
        computer,
        interactive,
        context,
        controlToken,
        this.desktopHost(async () => desktop),
      );
    }
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const desktop = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, relative), {
      signal: context.signal,
    });
    return entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "dir") return [];
      return [
        {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: entry.type,
          size: entry.size,
          ...(entry.type === "file" && entry.mode & 0o100 ? { executable: true } : {}),
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const desktop = await this.box(computer);
    const target = workspacePath(E2B_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const info = await desktop.files.getInfo(target, {
        signal: context.signal,
      });
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    return desktop.files.read(target, {
      format: "bytes",
      signal: context.signal,
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const desktop = await this.box(computer);
    await writeE2BFiles(desktop, [file], context);
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext): AsyncIterable<PortableFile>;
  exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile | StreamedPortableFile>;
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile | StreamedPortableFile> {
    const desktop = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
    yield* keepingAwake(desktop, walkE2BWorkspace(desktop, "", context, limits), context.signal);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await writeE2BFiles(desktop, batch, context);
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      if (
        batch.length >= 32 ||
        batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    // Imported browser profiles remain dormant until their owning bot needs a desktop.
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef, options?: { onlyIfRunning?: boolean }): Promise<void> {
    if (options?.onlyIfRunning && !this.sdk.attachRunning) {
      throw new Error("E2B SDK cannot attach a computer without resuming it");
    }
    const id = computer.providerRef || computer.id;
    const attendance = options?.onlyIfRunning ? this.beginOperation(id) : undefined;
    const cached = this.boxes.get(id);
    const pending = this.connections.get(id);
    const attendanceIsCurrent = () =>
      this.computerOperations.get(id) === attendance &&
      this.boxes.get(id) === cached &&
      this.connections.get(id) === pending;
    try {
      const desktop = options?.onlyIfRunning
        ? await this.sdk.attachRunning!(id, {
            apiKey: this.apiKey,
            signal: AbortSignal.timeout(15_000),
          }).catch((error: unknown) => {
            if (!attendanceIsCurrent()) return undefined;
            throw error;
          })
        : await this.box(computer);
      if (!desktop || (options?.onlyIfRunning && !attendanceIsCurrent())) return;
      let gone = false;
      try {
        await desktop.setTimeout(sandboxIdleMs());
      } catch (error) {
        gone = isSandboxGoneError(error);
      }
      if (
        options?.onlyIfRunning
          ? !attendanceIsCurrent()
          : this.boxes.get(desktop.sandboxId) !== desktop
      )
        return;
      // Heartbeats refresh lastTouchedAt; if we swallow a gone error here, box() never
      // reaches its 60s probe and keeps handing back the dead cached handle.
      if (gone) {
        this.forgetCached(desktop.sandboxId);
        return;
      }
      this.lastTouchedAt.set(desktop.sandboxId, Date.now());
    } finally {
      if (attendance) this.endOperation(id, attendance);
    }
  }

  async releaseScreen(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { onlyIfRunning?: boolean },
  ): Promise<void> {
    if (!options?.onlyIfRunning) return this.desktops.releaseScreen(computer, context);
    const desktop = await this.attachRunningBox(computer, context.signal);
    if (!desktop) return;
    return this.desktops.releaseScreen(
      computer,
      context,
      {
        environment: async () => ({
          homeDir: "/home/user",
          workspaceDir: E2B_WORKSPACE,
          browserProfilesDir: E2B_BROWSER_PROFILES,
          displayStart: 20,
          portStart: 6100,
        }),
        run: async (_computer, command, cleanupContext) => {
          cleanupContext.signal.throwIfAborted();
          const result = await this.runSetupCommand(desktop, command, cleanupContext.signal);
          return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        },
      },
      { preserveActiveControl: true },
    );
  }

  private async attachRunningBox(computer: ComputerRef, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.sdk.attachRunning) {
      throw new Error("E2B SDK cannot attach a retained computer without resuming it");
    }
    return withAbort(
      this.sdk.attachRunning(computer.providerRef || computer.id, { apiKey: this.apiKey, signal }),
      signal,
    );
  }

  async inspectPowerState(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<SandboxPowerState> {
    const id = computer.providerRef || computer.id;
    if (!this.sdk.getInfo) return "unknown";
    try {
      const current = await this.sdk.getInfo(id, { apiKey: this.apiKey, signal: context.signal });
      if (current.sandboxId !== id) return "unknown";
      if (current.state === "paused") return "stopped";
      return current.state === "running" ? "running" : "unknown";
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return "gone";
      throw error;
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<"gone" | undefined> {
    const id = computer.providerRef || computer.id;
    this.forget(id);
    try {
      await this.sdk.pause(id, { apiKey: this.apiKey, signal: context.signal });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return "gone";
      throw error;
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const cached = this.boxes.get(id);
    this.forget(id);
    if (this.sdk.kill) {
      await this.sdk.kill(id, { apiKey: this.apiKey, signal: context.signal });
    } else if (cached) {
      await cached.kill();
    } else {
      throw new Error("E2B cannot confirm teardown without its kill-by-ID endpoint");
    }
  }

  private beginOperation(id: string): { pending: number } {
    const operation = this.computerOperations.get(id) ?? { pending: 0 };
    operation.pending += 1;
    this.computerOperations.set(id, operation);
    return operation;
  }

  private endOperation(id: string, operation: { pending: number }): void {
    operation.pending -= 1;
    if (operation.pending === 0 && this.computerOperations.get(id) === operation) {
      this.computerOperations.delete(id);
    }
  }

  private forgetCached(id: string): void {
    // Resource loss permits sibling recovery; explicit teardown invalidates their operation slot.
    this.boxes.delete(id);
    this.lastTouchedAt.delete(id);
  }

  private forget(id: string): void {
    this.computerOperations.delete(id);
    this.connections.delete(id);
    this.forgetCached(id);
  }

  /** Apply the deployment timeout (SDK default is 60s) and return failed results instead of throwing. */
  private async runSetupCommand(
    desktop: Sandbox,
    command: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    try {
      // E2B's outer login shell can fail its logout hook under `set -e`, even after `exit 0`.
      return await desktop.commands.run(`bash -c ${shellQuote(command)}`, {
        ...(signal ? { signal } : {}),
        timeoutMs: boundedSandboxCommandTimeoutMs(undefined),
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        return {
          exitCode: 124,
          stdout: "",
          stderr: error.message,
          error: error.message,
        };
      }
      const result = (error as { result?: CommandResult }).result;
      if (result) return result;
      throw error;
    }
  }
}

async function writeE2BFiles(
  desktop: Sandbox,
  files: readonly PortableFile[],
  context: AdapterContext,
) {
  if (!files.length) return;
  await desktop.files.write(
    files.map((file) => ({
      path: workspacePath(E2B_WORKSPACE, file.path),
      data: toArrayBuffer(file.content),
    })),
    { signal: context.signal },
  );
  const executable = files
    .filter((file) => file.executable)
    .map((file) => shellQuote(workspacePath(E2B_WORKSPACE, file.path)));
  if (executable.length) {
    await desktop.commands.run(`chmod 700 -- ${executable.join(" ")}`, {
      signal: context.signal,
    });
  }
}

/** Extend an active export's captured sandbox timeout until its reader finishes. */
export async function* keepingAwake<T>(
  desktop: Pick<Sandbox, "setTimeout">,
  items: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const idleMs = sandboxIdleMs();
  let extending = false;
  const extend = async () => {
    if (extending || signal?.aborted) return;
    extending = true;
    try {
      await desktop.setTimeout(idleMs);
    } catch {
      // Extending is best effort; preserve the export's own success or failure.
    } finally {
      extending = false;
    }
  };
  signal?.throwIfAborted();
  await extend();
  signal?.throwIfAborted();
  const timer = setInterval(() => void extend(), Math.min(60_000, idleMs / 2));
  const stop = () => clearInterval(timer);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const item of items) {
      signal?.throwIfAborted();
      yield item;
      signal?.throwIfAborted();
    }
  } finally {
    stop();
    signal?.removeEventListener("abort", stop);
  }
}

async function* walkE2BWorkspace(
  desktop: Sandbox,
  directory: string,
  context: AdapterContext,
  limits?: WorkspaceExportLimits,
): AsyncIterable<PortableFile | StreamedPortableFile> {
  const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, directory), {
    signal: context.signal,
  });
  const files: Array<{ relative: string; mode: number }> = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (shouldSkipPortableWorkspaceFile(relative, entry.type === "dir")) continue;
    if (entry.type === "dir") directories.push(relative);
    else if (entry.type === "file") files.push({ relative, mode: entry.mode });
  }
  if (limits) {
    for (const { relative, mode } of files) {
      const file = { path: relative, executable: Boolean(mode & 0o100) };
      const read = () =>
        desktop.files.read(workspacePath(E2B_WORKSPACE, relative), {
          format: "stream",
          signal: context.signal,
        });
      if (!relative.startsWith(".browser-profiles/")) {
        yield { ...file, body: streamWorkspaceBody(read) };
        continue;
      }
      // A profile file may disappear after listing. Omit it before staging creates a file.
      const body = await read().catch((error: unknown) => {
        context.signal.throwIfAborted();
        if (error instanceof FileNotFoundError) return null;
        throw error;
      });
      if (body === null) continue;
      try {
        yield { ...file, body: streamWorkspaceBody(async () => body) };
      } finally {
        // Staging can reject the file on limits before it starts consuming the body.
        if (!body.locked) void body.cancel().catch(() => undefined);
      }
    }
    for (const relative of directories) yield* walkE2BWorkspace(desktop, relative, context, limits);
    return;
  }
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async ({ relative, mode }) => {
        const content = await desktop.files
          .read(workspacePath(E2B_WORKSPACE, relative), {
            format: "bytes",
            signal: context.signal,
          })
          .catch((error) => {
            if (relative.startsWith(".browser-profiles/")) return undefined;
            throw error;
          });
        if (!content) return undefined;
        return { path: relative, content, executable: Boolean(mode & 0o100) };
      }),
    );
    for (const file of batch) {
      if (file) yield file;
    }
  }
  for (const relative of directories) yield* walkE2BWorkspace(desktop, relative, context);
}

function e2bCwd(cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === E2B_WORKSPACE
  ) {
    return E2B_WORKSPACE;
  }
  const relative = cwd.startsWith(`${E2B_WORKSPACE}/`)
    ? cwd.slice(E2B_WORKSPACE.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return workspacePath(E2B_WORKSPACE, relative);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
