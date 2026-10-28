import type { SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { DaytonaSandboxEmulator } from "./daytona-emulator.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";

describe("managed sandbox emulator identity", () => {
  it.each([
    { id: "e2b-emulator", kind: "e2b", create: () => new ManagedSandboxEmulator() },
    { id: "daytona-emulator", kind: "daytona", create: () => new DaytonaSandboxEmulator() },
    { id: "box-emulator", kind: "box", create: () => new BoxSandboxEmulator() },
  ])("reports the $kind resource kind without provisioning or changing $id", async (fixture) => {
    const emulator = fixture.create();
    const provider: SandboxProvider = emulator;
    const provision = vi.spyOn(provider, "provision");

    expect(await provider.provisionKind?.()).toBe(fixture.kind);
    expect(provider.describe().id).toBe(fixture.id);
    expect(provision).not.toHaveBeenCalled();
    expect(emulator.boxes.size).toBe(0);
  });
});
