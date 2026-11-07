import type { MessageBlock } from "@rakazo/contracts";
import {
  messagingProviderName,
  redactSecrets,
  SITE_SENDING_TOOLS,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
export const MAX_FETCH_URL_LENGTH = 2_048;

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

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; allowSiteAlways?: boolean; routineSiteDetail?: string },
): MessageBlock {
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
  const siteSending = SITE_SENDING_TOOLS.has(toolName);
  const destination = siteSending && typeof args.url === "string" ? args.url : undefined;
  const fetchSite = destination ? urlSite(destination) : undefined;
  const routineSiteApproval = options?.routineSiteDetail !== undefined;
  const alwaysLabel = siteSending
    ? fetchSite && options?.allowSiteAlways !== false
      ? `Always allow ${fetchSite}`
      : undefined
    : "Always allow this tool";
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(
    toolName,
    args,
    options?.reviewReason,
    fetchSite ? destination : undefined,
  );
  const safeDetail =
    options?.routineSiteDetail ?? (detail ? redactSecrets(detail, secrets) : undefined);
  const text = routineSiteApproval
    ? "Allow this Routine to use these sites each time it runs?"
    : toolName === "create_space"
      ? `${summary}?`
      : `Review before ${summary}`;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(redactSecrets(text, secrets), MAX_APPROVAL_SUMMARY_LENGTH),
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
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
  if (!SITE_SENDING_TOOLS.has(toolName)) {
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
