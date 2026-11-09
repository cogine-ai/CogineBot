import type { ConnectorBatchActionNames } from "@rakazo/core";
import type { BoundApprovalRoute } from "./approval-effect.js";
import {
  boundDirectApprovalDetails,
  CATALOG_APPROVAL_TOOL,
  catalogApprovalConnectorId,
  catalogApprovalDetails,
  connectorBatchApprovalFromEffect,
  parseCatalogApprovalTarget,
} from "./approval-effect.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./builtin-tools.js";
import { COMPOSIO_MULTI_EXECUTE_TOOL, connectorBatchActionNames } from "./composio-batch.js";
import { sharedPageUpdateRequest } from "./page-share-update.js";
import { preparePageToolRequest, SAVE_PAGE_TOOL } from "./page-tool-request.js";
import { routineSiteApprovalDetails } from "./schedule-tools.js";

// These tools already bind decisions to a specific destination, credential, or takeover.
const TARGET_SCOPED_TOOLS = new Set([
  "web_fetch",
  "secret_request",
  "request_secret",
  "connect_app",
  "request_takeover",
]);

const SHELL_FILE_TOOLS = new Set([
  "list_files",
  "read_file",
  "write_file",
  "open_path",
  "launch_app",
]);

type PageMode = "help" | "read" | "write";

export function pageDenialTarget(mode: PageMode, pageId: unknown) {
  return { mode, pageId: typeof pageId === "string" ? pageId.trim() || undefined : undefined };
}

type Action = {
  toolName: string;
  route?: BoundApprovalRoute;
  batch?: ConnectorBatchActionNames;
  page?: ReturnType<typeof pageDenialTarget>;
};

function deniedPageTarget(request: unknown) {
  const shared = sharedPageUpdateRequest(request);
  if (shared) return pageDenialTarget("write", shared.page.id);
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const parsed = preparePageToolRequest(request as Record<string, unknown>, []);
  return parsed.ok ? pageDenialTarget(parsed.mode, parsed.args.pageId) : undefined;
}

export async function loadDeniedActionTargets(
  effects: readonly { kind: string; request: unknown; result: unknown }[],
  loadInstalledKind: (id: string) => Promise<string | undefined>,
): Promise<Action[]> {
  return Promise.all(
    effects
      .filter(
        ({ kind, request, result }) =>
          result == null &&
          !TARGET_SCOPED_TOOLS.has(kind) &&
          !(kind === "schedule_create" && routineSiteApprovalDetails(request)),
      )
      .map(async (effect) => {
        const direct = boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL);
        const catalog = catalogApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL);
        const target = catalog && parseCatalogApprovalTarget(catalog.args);
        const route =
          direct?.route ??
          catalog?.route ??
          (catalog &&
            target && { ...target, connectorId: catalogApprovalConnectorId(catalog.toolName) });
        return {
          toolName: effect.kind,
          route,
          page: effect.kind === SAVE_PAGE_TOOL ? deniedPageTarget(effect.request) : undefined,
          batch:
            !route &&
            effect.kind.startsWith("mcp__") &&
            effect.kind.toUpperCase().endsWith(`__${COMPOSIO_MULTI_EXECUTE_TOOL}`)
              ? connectorBatchActionNames(COMPOSIO_MULTI_EXECUTE_TOOL, effect.request)
              : await connectorBatchApprovalFromEffect(effect, {
                  batchCard: false,
                  loadInstalledKind,
                }),
        };
      }),
  );
}

function actionNames(action: Action): string[] {
  return (action.batch?.actions ?? [action.route?.toolName ?? action.toolName]).map((name) =>
    name.toUpperCase(),
  );
}

/** Check the same Run's genuine refusals. An arbitrary command cannot name all of its actions. */
export function repeatsDeniedAction(
  action: Action & {
    aliases: readonly string[];
    opaqueCode?: "shell" | "connector";
    legacyBatchPrefix?: string;
  },
  denied: readonly Action[],
): boolean {
  if (TARGET_SCOPED_TOOLS.has(action.toolName)) return false;

  const currentNames = actionNames(action);
  return denied.some((prior) => {
    if (prior.toolName === SAVE_PAGE_TOOL)
      return Boolean(
        prior.page &&
          action.toolName === SAVE_PAGE_TOOL &&
          action.page?.mode === prior.page.mode &&
          action.page.pageId === prior.page.pageId,
      );
    if (
      action.opaqueCode &&
      (prior.toolName === "shell" ||
        !BUILTIN_AGENT_TOOL_NAMES.has(prior.toolName) ||
        (action.opaqueCode === "shell" && SHELL_FILE_TOOLS.has(prior.toolName)))
    )
      return true;
    if (action.route && prior.route) {
      if (
        action.route.connectorId !== prior.route.connectorId ||
        action.route.resourceId !== prior.route.resourceId
      ) {
        return false;
      }
      if (!action.batch && !prior.batch) return action.route.toolName === prior.route.toolName;
    } else if (![action.toolName, ...action.aliases].includes(prior.toolName)) {
      // Legacy effects identify actions by a bare managed name or a server-qualified MCP name.
      const prefix = action.legacyBatchPrefix;
      if (prior.route || prefix === undefined || (!action.batch && !prior.batch)) return false;
      if (!prior.toolName.startsWith(prefix)) return false;
      const legacyWireName = prior.toolName.slice(prefix.length).toUpperCase();
      if (!prior.batch) return currentNames.includes(legacyWireName);
      return (
        legacyWireName === COMPOSIO_MULTI_EXECUTE_TOOL &&
        (prior.batch.complete === false ||
          actionNames(prior).some((name) => currentNames.includes(name)))
      );
    }

    if (!action.batch && !prior.batch) return true;
    if (action.batch?.complete === false || prior.batch?.complete === false) return true;
    return actionNames(prior).some((name) => currentNames.includes(name));
  });
}
