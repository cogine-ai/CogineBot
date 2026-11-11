import type { ConnectedConnector, ConnectorTool, ToolBatch } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { sharedPageUpdateApprovalTitle } from "@rakazo/contracts";
import {
  type ConnectorBatchActionNames,
  containsSecret,
  displayedBatchApprovalRuleNames,
  escapeApprovalBidi,
  formatBotSecretHttpApprovalDetail,
  MAX_APPROVAL_DETAIL_LENGTH,
  messagingProviderName,
  OUTBOUND_HTTP_TOOLS,
  redactSecrets,
  SITE_SENDING_TOOLS,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import { redactApprovalUrl, redactToolArgsForApproval } from "./auto-review.js";
import { normalizedBatchActionName } from "./composio-batch.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
export const MAX_FETCH_URL_LENGTH = 2_048;

export type SharedPageApprovalSummary = { title: string; detail: string };

export function formatRoutineSiteApprovalDetail(
  sites: readonly string[],
  secrets: string[],
): { detail: string } | { error: string } {
  const destinations = sites.join("\n");
  if (redactSecrets(destinations, secrets) !== destinations) {
    return {
      error: "A Routine destination contains protected information and cannot be reviewed.",
    };
  }
  return destinations.length <= MAX_APPROVAL_DETAIL_LENGTH
    ? { detail: destinations }
    : {
        error:
          "Too many Routine destinations to review at once. Split them into separate Routines.",
      };
}

const APPROVAL_DESTINATION_KEYS = [
  "account",
  "connection",
  "to",
  "recipient",
  "recipients",
  "recipient_email",
  "cc",
  "bcc",
  "channel",
  "address",
  "target",
  "destination",
  "collection",
  "url",
  "path",
  "method",
];

/** Put destination and account fields before the remaining arguments. */
function orderedApprovalArgs(args: Record<string, unknown>, actionKey?: string) {
  const keys = actionKey ? [actionKey, ...APPROVAL_DESTINATION_KEYS] : APPROVAL_DESTINATION_KEYS;
  const first = keys.flatMap((key) => (Object.hasOwn(args, key) ? [[key, args[key]]] : []));
  return Object.fromEntries([
    ...first,
    ...Object.entries(args).filter(([key]) => !keys.includes(key)),
  ]);
}

type ResolvedApprovalScope = {
  action: string;
  connection?: string;
  destination?: ConnectorTool["approvalDestination"];
  batch?: ToolBatch;
  managedAccounts?: readonly ConnectedConnector[];
};

/** Plain text for the expandable card. Preserve argument names, values and each batch occurrence. */
function expandedApprovalDetail(
  args: Record<string, unknown>,
  secrets: string[],
  scope: ResolvedApprovalScope,
): string {
  const ordered = orderedApprovalArgs(args);
  const batch = scope.batch;
  const lines = [`Action: ${JSON.stringify(redactSecrets(scope.action, secrets))}`];
  if (scope.connection)
    lines.push(`Connection: ${JSON.stringify(redactSecrets(scope.connection, secrets))}`);
  const destination = scope.destination?.(args);
  if (destination) {
    const { method, url } = destination;
    lines.push(`Destination: ${method} ${JSON.stringify(redactApprovalUrl(url, secrets))}`);
  }
  if (batch && Array.isArray(ordered[batch.items])) {
    ordered[batch.items] = ordered[batch.items].map((item: unknown, index: number) => {
      const record =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined;
      const action = normalizedBatchActionName(record?.[batch.action]);
      const accounts = scope.managedAccounts;
      const account = accounts && record ? managedApprovalAccount(record, action, accounts) : "";
      const label = JSON.stringify(redactSecrets(action || "Unknown action", secrets));
      lines.push(`${index + 1}. ${label}${account ? ` · ${redactSecrets(account, secrets)}` : ""}`);
      return record ? orderedApprovalArgs(record, batch.action) : item;
    });
  }
  lines.push(JSON.stringify(ordered, null, 2));
  return escapeApprovalBidi(lines.join("\n"));
}

/** Show a bound account label when available. Default account selection belongs to the provider. */
function managedApprovalAccount(
  item: Record<string, unknown>,
  action: string,
  accounts: readonly ConnectedConnector[],
): string {
  if (typeof item.account === "string" && item.account.trim()) {
    const selected = accounts.find((account) => account.providerRef === item.account);
    return selected ? JSON.stringify(selected.displayName) : "Explicit account";
  }
  const normalized = action.toUpperCase();
  const toolkits = accounts
    .map(({ externalId }) => externalId.trim().toLowerCase())
    .filter((id) => id && normalized.startsWith(`${id.toUpperCase()}_`))
    .sort((left, right) => right.length - left.length);
  const toolkit = toolkits[0];
  return toolkit ? `Provider-selected account (${toolkit})` : "Provider-selected account";
}

/** Keep specialized approvals on their own cards and disclose ordinary arguments on demand. */
export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: {
    reviewReason?: string;
    allowSiteAlways?: boolean;
    allowToolAlways?: boolean;
    routineSiteDetail?: string;
    batch?: ConnectorBatchActionNames;
    allowBatchAlways?: boolean;
    sharedPageUpdate?: SharedPageApprovalSummary;
    resolvedScope?: ResolvedApprovalScope;
  },
): Extract<MessageBlock, { kind: "ask" }> {
  if (toolName === "save_page" && options?.sharedPageUpdate) {
    const { title, detail } = options.sharedPageUpdate;
    return {
      kind: "ask",
      approvalEffectId: effectId,
      reviewMode: "screen",
      text: sharedPageUpdateApprovalTitle(title),
      detail,
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  if (toolName === "respond_agent_connection") {
    const label =
      redactSecrets(
        sanitizeMessagingLabel(redactSecrets(String(args.requester_name ?? ""), secrets))
          .replace(/\p{Bidi_Control}/gu, "")
          .trim(),
        secrets,
      ) || "agent";
    // The requester controls the label. Keep it literal, including URLs and backticks.
    const delimiter = "`".repeat(
      1 + Math.max(0, ...(label.match(/`+/g) ?? []).map((run) => run.length)),
    );
    const name = `${delimiter} ${label} ${delimiter}`;
    const verb = args.accept === true ? "Approve" : "Decline";
    const provider = messagingProviderName(String(args.requester_provider ?? ""));
    const address = String(args.requester_address ?? "");
    const detail = redactSecrets(`${provider}: ${address}`, secrets).replace(
      /[\r\n\p{Bidi_Control}]/gu,
      " ",
    );
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: truncate(`${verb} connection with “${name}”?`, MAX_APPROVAL_SUMMARY_LENGTH),
      detail: truncate(redactSecrets(detail, secrets), MAX_APPROVAL_DETAIL_LENGTH),
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  if (toolName === "secret_request") {
    const detail = formatBotSecretHttpApprovalDetail(args);
    const complete = detail && !containsSecret([detail, args], secrets) ? detail : undefined;
    return {
      kind: "ask",
      approvalEffectId: effectId,
      reviewMode: "screen",
      text: "Review before secret_request",
      detail: complete,
      status: "pending",
      actions: [
        ...(complete ? [{ id: "allow", label: "Allow once" }] : []),
        { id: "deny", label: "Deny" },
      ],
    };
  }
  const reviewArgs = options?.resolvedScope ? redactToolArgsForApproval(args, secrets) : undefined;
  const approvalDetails =
    options?.resolvedScope && reviewArgs
      ? expandedApprovalDetail(reviewArgs, secrets, options.resolvedScope)
      : undefined;
  const siteSending = OUTBOUND_HTTP_TOOLS.has(toolName);
  const destination =
    siteSending && typeof args.url === "string" ? normalizedHttpUrl(args.url) : undefined;
  const site = destination ? urlSite(destination) : undefined;
  const fetchSite = site && !containsSecret(site, secrets) ? site : undefined;
  const routineSiteApproval = options?.routineSiteDetail !== undefined;
  const batch = options?.batch;
  const batchSummary = batch?.actions.join(", ");
  const summaryArgs = options?.resolvedScope ? (reviewArgs ?? {}) : args;
  const summary = describeApprovalAction(toolName, summaryArgs);
  const detail = batch
    ? [
        batchSummary,
        batch.complete ? undefined : "Some batch actions could not be identified.",
        options?.reviewReason,
      ]
        .filter(Boolean)
        .join("\n")
    : formatApprovalDetail(
        toolName,
        summaryArgs,
        options?.reviewReason,
        fetchSite ? (typeof summaryArgs.url === "string" ? summaryArgs.url : undefined) : undefined,
      );
  const safeDetail =
    options?.routineSiteDetail ?? (detail ? redactSecrets(detail, secrets) : undefined);
  const displayedDetail = safeDetail
    ? truncate(escapeApprovalBidi(safeDetail), MAX_APPROVAL_DETAIL_LENGTH)
    : undefined;
  const batchRules = batch && displayedBatchApprovalRuleNames(batch, displayedDetail);
  const alwaysLabel = siteSending
    ? fetchSite && SITE_SENDING_TOOLS.has(toolName) && options?.allowSiteAlways !== false
      ? `Always allow ${fetchSite}`
      : undefined
    : batch
      ? options?.allowBatchAlways !== false && batchRules && !containsSecret(batchRules, secrets)
        ? "Always allow these actions"
        : undefined
      : options?.allowToolAlways !== false
        ? "Always allow this tool"
        : undefined;
  const text = routineSiteApproval
    ? "Allow this Routine to use these sites each time it runs?"
    : toolName === "create_space"
      ? `${summary}?`
      : `Review before ${summary}`;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(escapeApprovalBidi(redactSecrets(text, secrets)), MAX_APPROVAL_SUMMARY_LENGTH),
    detail: displayedDetail,
    ...(approvalDetails ? { approvalDetails } : {}),
    ...(batch ? { approvalScope: "connector_batch" } : {}),
    ...(fetchSite ? { site: fetchSite } : {}),
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            ...(alwaysLabel && !routineSiteApproval ? [{ id: "always", label: alwaysLabel }] : []),
            { id: "deny", label: "Deny" },
          ],
  };
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "generate_secret") return "saving a new credential";
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
  fetchUrl?: string,
): string | undefined {
  const lines: string[] = [];
  const reason = reviewReason?.trim().replace(/\u2014|\u2013/g, "-");
  if (reason) lines.push(fetchUrl ? reason.slice(0, MAX_APPROVAL_SUMMARY_LENGTH) : reason);
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  if (fetchUrl) lines.push(`url: ${fetchUrl}`);
  if (toolName !== "web_fetch") {
    for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
      const value = args[key];
      if (value == null || value === "") continue;
      lines.push(`${key}: ${String(value)}`);
    }
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
