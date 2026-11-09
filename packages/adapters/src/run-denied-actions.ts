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

// These tools already bind decisions to a specific destination, credential, or takeover.
const TARGET_SCOPED_TOOLS = new Set([
  "web_fetch",
  "secret_request",
  "request_secret",
  "connect_app",
  "request_takeover",
]);

type Action = {
  toolName: string;
  route?: BoundApprovalRoute;
  batch?: ConnectorBatchActionNames;
};

export async function loadDeniedActionTargets(
  effects: readonly { kind: string; request: unknown; result: unknown }[],
  loadInstalledKind: (id: string) => Promise<string | undefined>,
): Promise<Action[]> {
  return Promise.all(
    effects
      .filter(({ kind, result }) => result == null && !TARGET_SCOPED_TOOLS.has(kind))
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
  action: Action & { aliases: readonly string[]; opaqueCode: boolean },
  denied: readonly Action[],
): boolean {
  if (TARGET_SCOPED_TOOLS.has(action.toolName)) return false;

  const currentNames = actionNames(action);
  return denied.some((prior) => {
    if (
      action.opaqueCode &&
      (prior.toolName === "shell" || !BUILTIN_AGENT_TOOL_NAMES.has(prior.toolName))
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
      // An unbound legacy row only identifies its exposed tool.
      return false;
    }

    if (!action.batch && !prior.batch) return true;
    if (action.batch?.complete === false || prior.batch?.complete === false) return true;
    return actionNames(prior).some((name) => currentNames.includes(name));
  });
}
