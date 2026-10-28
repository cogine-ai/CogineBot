import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";

/** Managed-provider emulator configured with Box identity. */
export class BoxSandboxEmulator extends ManagedSandboxEmulator {
  private starts = 0;

  /** Starts and resumes count toward the account quota; a running connection does not. */
  constructor(private readonly options: { startLimit?: number } = {}) {
    super({ id: "box-emulator", kind: "box" });
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (!this.boxes.get(`fake-${request.botId}`)?.running) {
      if (this.options.startLimit !== undefined && this.starts >= this.options.startLimit) {
        throw new SandboxRateLimitError();
      }
      this.starts += 1;
    }
    return super.provision(request, context);
  }
}
