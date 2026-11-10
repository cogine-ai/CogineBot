import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxPowerState,
  SandboxProvider,
  ScreenRequest,
  StreamedPortableFile,
  TerminalRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  if (envKind === "docker" && computerHost === "this-mac") return "desktop";
  return envKind;
}

export function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient },
): SandboxProvider {
  const host = new DesktopSandboxProvider({ root: opts.dataDir, hostRoots: [homedir()] });
  const primary = kind === "desktop" ? host : createSandboxProvider(kind, opts);
  const sandbox =
    kind === "docker" && opts.prisma
      ? new HostAwareSandbox(primary, host, async () => {
          const settings = await runAsSystem(
            "read deployment computer host for sandbox routing",
            () =>
              opts.prisma!.deploymentSettings.findUnique({
                where: { id: "default" },
                select: { computerHost: true },
              }),
          );
          return settings?.computerHost === "this-mac";
        })
      : primary;
  const activeKind = primary.describe().id.replace(/-emulator$/, "");
  const configured = new Map<string, SandboxProvider>([[activeKind, primary]]);
  if (opts.dataDir) configured.set("desktop", host);
  const enabled: Partial<Record<ComputerRef["kind"], boolean>> = {
    e2b: Boolean(opts.e2bApiKey?.trim()),
    daytona: Boolean(opts.daytonaApiKey?.trim()),
    createos: Boolean(opts.createosApiKey?.trim()),
    box: Boolean(opts.boxApiKey?.trim()),
    docker: Boolean(opts.supervisorToken?.trim()),
  };
  const authorities: Partial<Record<ComputerRef["kind"], (string | undefined)[]>> = {
    e2b: [opts.e2bApiKey?.trim()],
    daytona: [opts.daytonaApiKey?.trim(), opts.daytonaApiUrl, opts.daytonaTarget],
    createos: [opts.createosApiKey?.trim(), opts.createosBaseUrl],
    box: [opts.boxApiKey?.trim(), opts.boxApiUrl],
    docker: [opts.supervisorToken?.trim(), opts.supervisorUrl ?? "http://127.0.0.1:7091"],
    desktop: [opts.dataDir],
    fake: [],
  };
  return Object.assign(sandbox, {
    providerAuthority(kind: ComputerRef["kind"]): string | undefined {
      const identity = configured.get(kind)?.describe().id;
      const values = identity?.endsWith("-emulator") ? [] : authorities[kind];
      return (
        values &&
        createHash("sha256")
          .update(JSON.stringify([identity ?? kind, ...values]))
          .digest("hex")
      );
    },
    providerForPower(computer: ComputerRef): SandboxProvider | undefined {
      const existing = configured.get(computer.kind);
      if (existing) return existing;
      if (!enabled[computer.kind]) return undefined;
      try {
        const provider = createSandboxProvider(computer.kind, opts);
        if (provider.describe().id !== computer.kind) return undefined;
        configured.set(computer.kind, provider);
        return provider;
      } catch {
        return undefined;
      }
    },
  });
}

export class HostAwareSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: () => Promise<boolean>,
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = (computer, request, context) => {
        const provider = this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  describe() {
    return this.isolated.describe();
  }

  private route(computer: ComputerRef) {
    return computer.kind === "desktop" ? this.host : this.isolated;
  }

  async provisionKind() {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    return provider.describe().id as ComputerRef["kind"];
  }

  async provision(request: Parameters<SandboxProvider["provision"]>[0], context: AdapterContext) {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    const providerKind = provider.describe().id;
    return provider.provision(
      {
        ...request,
        providerRef: request.providerKind === providerKind ? request.providerRef : undefined,
      },
      context,
    );
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    if (provider.describe().id !== computer.kind) return false;
    return provider.isRunning?.(computer, context) ?? false;
  }

  async inspectPowerState(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<SandboxPowerState> {
    const provider = this.route(computer);
    if (provider.describe().id !== computer.kind) return "unknown";
    return provider.inspectPowerState?.(computer, context) ?? "unknown";
  }

  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* this.route(computer).execute(computer, request, context);
  }

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.route(computer).connectScreen(computer, request, context);
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = this.route(computer);
    if (!provider.connectTerminal) {
      return Promise.reject(new Error("terminal is unavailable on this computer"));
    }
    return provider.connectTerminal(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.route(computer).sendInput(computer, input, lease, context);
  }

  observe(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.route(computer).act(computer, request, context);
  }

  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.route(computer).listFiles(computer, path, context);
  }

  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return this.route(computer).readFile(computer, path, context, options);
  }

  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return this.route(computer).writeFile(computer, file, context);
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext): AsyncIterable<PortableFile>;
  exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile | StreamedPortableFile>;
  exportWorkspace(computer: ComputerRef, context: AdapterContext, limits?: WorkspaceExportLimits) {
    const provider = this.route(computer);
    return limits
      ? provider.exportWorkspace(computer, context, limits)
      : provider.exportWorkspace(computer, context);
  }

  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.route(computer).importWorkspace(computer, files, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).snapshot(computer, context);
  }

  keepAlive(computer: ComputerRef, options?: { onlyIfRunning?: boolean }) {
    return this.route(computer).keepAlive?.(computer, options) ?? Promise.resolve();
  }

  releaseScreen(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { onlyIfRunning?: boolean },
  ) {
    return this.route(computer).releaseScreen?.(computer, context, options) ?? Promise.resolve();
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      this.route(computer).setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  stop(computer: ComputerRef, context: AdapterContext) {
    return this.teardownProvider(computer).stop(computer, context);
  }

  destroy(
    computer: ComputerRef,
    context: AdapterContext,
    options?: Parameters<SandboxProvider["destroy"]>[2],
  ) {
    const provider = this.teardownProvider(computer);
    return options
      ? provider.destroy(computer, context, options)
      : provider.destroy(computer, context);
  }

  private teardownProvider(computer: ComputerRef): SandboxProvider {
    const provider = this.route(computer);
    if (provider.describe().id !== computer.kind) {
      throw new Error("The computer's provider is unavailable");
    }
    return provider;
  }
}
