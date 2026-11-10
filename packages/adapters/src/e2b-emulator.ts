import type { AdapterContext, ComputerRef, SandboxPowerState } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** Managed-provider protocol emulator backed by deterministic local state. */
export class ManagedSandboxEmulator extends FakeSandboxProvider {
  constructor(
    private readonly emulator: { id: string; kind: ComputerRef["kind"] } = {
      id: "e2b-emulator",
      kind: "e2b",
    },
  ) {
    super();
  }
  override describe() {
    return { ...super.describe(), id: this.emulator.id };
  }
  async provisionKind(): Promise<ComputerRef["kind"]> {
    return this.emulator.kind;
  }
  async inspectPowerState(computer: ComputerRef): Promise<SandboxPowerState> {
    const box = this.boxes.get(computer.providerRef);
    if (!box || computer.kind !== this.emulator.kind) return "gone";
    return box.running ? "running" : "stopped";
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    return { ...(await super.provision(request, context)), kind: this.emulator.kind };
  }
}
