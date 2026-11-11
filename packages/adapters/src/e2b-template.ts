import type { BuildOptions, Sandbox as DesktopSandbox, TemplateClass } from "@e2b/desktop";
import { getLogger } from "@rakazo/logging";

export const E2B_DESKTOP_TEMPLATE = "desktop";
export const E2B_COMPUTER_TEMPLATE = "coginebot-computer";

// Keep the stock desktop contents at the size used by bot computers.
const E2B_COMPUTER_RESOURCES = { cpuCount: 2, memoryMB: 4096 } as const;

type BuildTemplate = (
  template: TemplateClass,
  name: string,
  options: Omit<BuildOptions, "alias">,
) => Promise<{ name: string }>;

/** Build the computer template in the E2B team that owns the deployment key. */
export async function buildE2BComputerTemplate(
  apiKey: string,
  options: {
    build?: BuildTemplate;
    onBuildLogs?: (line: string) => void;
  } = {},
) {
  const { Template } = await import("@e2b/desktop");
  const build: BuildTemplate =
    options.build ??
    ((template, name, buildOptions) => Template.build(template, name, buildOptions));
  return build(Template().fromTemplate(E2B_DESKTOP_TEMPLATE), E2B_COMPUTER_TEMPLATE, {
    apiKey,
    ...E2B_COMPUTER_RESOURCES,
    ...(options.onBuildLogs
      ? { onBuildLogs: (entry) => options.onBuildLogs?.(entry.toString()) }
      : {}),
  });
}

/** Prefer the computer template, preserving stock setup for teams without it. */
export async function createE2BComputer(
  options: NonNullable<Parameters<typeof DesktopSandbox.create>[1]>,
) {
  const { NotFoundError, Sandbox } = await import("@e2b/desktop");
  try {
    return await Sandbox.create(E2B_COMPUTER_TEMPLATE, options);
  } catch (error) {
    // Desktop startup can fail after allocation. Its missing resources are
    // distinct from the control-plane template lookup.
    if (error instanceof NotFoundError) throw error;
    const missing =
      error instanceof Error &&
      ((error as { statusCode?: unknown }).statusCode === 404 || /^404:/.test(error.message));
    if (!missing) throw error;
    getLogger().warn("E2B computer template is not built; using the stock desktop template", {
      template: E2B_COMPUTER_TEMPLATE,
    });
    return Sandbox.create(E2B_DESKTOP_TEMPLATE, options);
  }
}
