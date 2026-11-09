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
import { sharedPageUpdateRequest } from "./page-share-update.js";
import { SAVE_PAGE_TOOL } from "./page-tool-request.js";
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

type Action = {
  toolName: string;
  route?: BoundApprovalRoute;
  batch?: ConnectorBatchActionNames;
  pageId?: string;
};

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
          pageId:
            effect.kind === SAVE_PAGE_TOOL
              ? sharedPageUpdateRequest(effect.request)?.page.id
              : undefined,
          batch: await connectorBatchApprovalFromEffect(effect, {
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
  action: Action & { aliases: readonly string[]; opaqueCode?: "shell" | "connector" },
  denied: readonly Action[],
): boolean {
  if (TARGET_SCOPED_TOOLS.has(action.toolName)) return false;

  const currentNames = actionNames(action);
  return denied.some((prior) => {
    if (prior.pageId !== undefined)
      return action.toolName === SAVE_PAGE_TOOL && action.pageId === prior.pageId;
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
      // Legacy managed connector records used the same names for exposed tools and batch slugs.
      return Boolean(
        !prior.route &&
          action.route?.connectorId === "composio" &&
          (action.batch || prior.batch) &&
          actionNames(prior).some((name) => currentNames.includes(name)),
      );
    }

    if (!action.batch && !prior.batch) return true;
    if (action.batch?.complete === false || prior.batch?.complete === false) return true;
    return actionNames(prior).some((name) => currentNames.includes(name));
  });
}
