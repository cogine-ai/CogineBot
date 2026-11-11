import type { BuildOptions, TemplateClass } from "@e2b/desktop";
import { Template } from "@e2b/desktop";
import { describe, expect, it, vi } from "vitest";
import {
  buildE2BComputerTemplate,
  E2B_COMPUTER_TEMPLATE,
  E2B_DESKTOP_TEMPLATE,
} from "./e2b-template.js";

describe("E2B computer template", () => {
  it("builds the stock desktop at 2 vCPU and 4096 MiB under the deployment alias", async () => {
    const build = vi.fn(async () => ({ name: E2B_COMPUTER_TEMPLATE }));
    await expect(buildE2BComputerTemplate("synthetic-template-key", { build })).resolves.toEqual({
      name: E2B_COMPUTER_TEMPLATE,
    });
    expect(build).toHaveBeenCalledOnce();
    const [template, name, options] = build.mock.calls[0] as unknown as [
      TemplateClass,
      string,
      Omit<BuildOptions, "alias">,
    ];
    expect(name).toBe("coginebot-computer");
    expect(options).toEqual({
      apiKey: "synthetic-template-key",
      cpuCount: 2,
      memoryMB: 4096,
    });
    expect(JSON.parse(await Template.toJSON(template, false))).toMatchObject({
      fromTemplate: E2B_DESKTOP_TEMPLATE,
    });
  });

  it("forwards the provider build logs as lines", async () => {
    const onBuildLogs = vi.fn();
    const build = vi.fn(
      async (_template: TemplateClass, _name: string, options: Omit<BuildOptions, "alias">) => {
        const entry = {
          toString: () => "Synthetic template build output",
        } as Parameters<NonNullable<BuildOptions["onBuildLogs"]>>[0];
        options.onBuildLogs?.(entry);
        return { name: E2B_COMPUTER_TEMPLATE };
      },
    );
    await buildE2BComputerTemplate("synthetic-template-key", { build, onBuildLogs });
    expect(onBuildLogs).toHaveBeenCalledExactlyOnceWith("Synthetic template build output");
  });

  it("preserves build failures for the operator", async () => {
    const failure = new Error("Synthetic template build failure");
    const build = vi.fn().mockRejectedValue(failure);
    await expect(buildE2BComputerTemplate("synthetic-template-key", { build })).rejects.toBe(
      failure,
    );
  });
});
