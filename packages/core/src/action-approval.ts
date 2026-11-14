import type { ActionApprovalRule as StoredActionApprovalRule } from "@rakazo/contracts";
import { SecretHttpRequest } from "@rakazo/contracts";
import { normalizedHttpUrl, urlSite } from "./egress.js";

const APPROVAL_EXEMPT_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "read_file",
  "read_history",
  "search_history",
  "write_file",
  "shell",
  "open_path",
  "launch_app",
  "remember",
  "request_takeover",
  "request_secret",
  "run_subagent",
  "spawn_bot",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
]);

const APPROVAL_REQUIRED_BUILTIN_TOOLS = new Set([
  "destination.write",
  "delete_bot",
  "archive_bot",
  "secret_request",
  "forget_secret",
  "forget_memory",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "cloud_agent_cancel",
]);
export const AGENT_CONNECTION_RESPONSE_TOOL = "respond_agent_connection";
const EXPLICIT_APPROVAL_BUILTIN_TOOLS = new Set(["create_space", AGENT_CONNECTION_RESPONSE_TOOL]);

const UNATTENDED_SAFE_BUILTIN_TOOLS = new Set([
  "browser_snapshot",
  "cloud_agent_status",
  "computer_observe",
  "list_files",
  "list_secrets",
  "read_file",
  "recall_memory",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "schedule_list",
  "scratchpad_list",
  "skill_read",
  "web_fetch",
  "web_search",
]);

const READ_ONLY_CONNECTOR_PATTERN = /(^|_)(get|list|search|find|read)(_|$)/i;
const MUTATING_CONNECTOR_PATTERN =
  /(^|_)(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)(_|$)/i;
const COMPOUND_CONNECTOR_ACTION_PATTERN = /_(and|or|then)_/i;

const EMAIL_CONNECTOR_SLUGS = new Set(["gmail", "outlook", "microsoft_outlook"]);
const PURCHASE_CONNECTOR_SLUGS = new Set(["stripe", "shopify", "paypal", "square"]);

export type ActionApprovalRule = Pick<
  StoredActionApprovalRule,
  "effect" | "matchKind" | "matchValue"
>;

export function connectorKindFromToolName(toolName: string, connectorKinds: string[] = []): string {
  const normalizedTool = toolName.toLowerCase();
  const matched = connectorKinds
    .map((kind) => kind.toLowerCase())
    .filter((kind) => normalizedTool === kind || normalizedTool.startsWith(`${kind}_`))
    .sort((left, right) => right.length - left.length)[0];
  if (matched) return matched;
  const [segment] = toolName.split("_");
  return (segment ?? toolName).toLowerCase();
}

/**
 * `readOnly` is the connector tool's declared effect (for installed APIs, derived from the stored
 * HTTP method and read-only flag). A declared write always needs approval. A declared read never
 * relaxes the name check: the provider chooses both the name and the hint.
 */
export function connectorToolRequiresApproval(toolName: string, readOnly?: boolean): boolean {
  if (readOnly === false) return true;
  if (MUTATING_CONNECTOR_PATTERN.test(toolName)) return true;
  if (COMPOUND_CONNECTOR_ACTION_PATTERN.test(toolName)) return true;
  return !READ_ONLY_CONNECTOR_PATTERN.test(toolName);
}

export function toolRequiresApproval(
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (toolRequiresExplicitApproval(toolName)) return true;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName, readOnly);
  return false;
}

/** Security-boundary changes cannot be auto-reviewed or permanently allowed. */
export function toolRequiresExplicitApproval(toolName: string): boolean {
  return EXPLICIT_APPROVAL_BUILTIN_TOOLS.has(toolName);
}

/**
 * A run the owner started: their own message, a follow-up they wrote, or the close of their call.
 * Bot messages, channels, spawns, tickets, webhooks and routines are not, nor is anything new.
 */
export function isOwnerStartedRun(trigger: string, followUpFromUser: boolean): boolean {
  if (trigger === "follow_up") return followUpFromUser;
  return trigger === "user" || trigger === "call_end";
}

/** External webhook runs may inspect state unattended, but side effects always need the owner. */
export function unattendedTriggerToolRequiresApproval(
  trigger: string,
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
): boolean {
  if (trigger !== "webhook") return false;
  return viaConnector
    ? connectorToolRequiresApproval(toolName, readOnly)
    : !UNATTENDED_SAFE_BUILTIN_TOOLS.has(toolName);
}

/**
 * Tools whose results bring in nothing from outside during the run: confirmations of the bot's own
 * writes, the owner's answers, and the product's own saved state (memory, skills), which
 * is treated like the conversation already in context. Every other result (history, search hits,
 * files, connector data, the screen, shell output, other bots) can carry text an attacker wrote,
 * and taints the run. New tools taint by default.
 */
const OWN_STATE_RESULT_TOOLS = new Set([
  "ask_user",
  "attach_file",
  "end_call",
  "generate_secret",
  "list_secrets",
  "message_user",
  "recall_memory",
  "remember",
  "render_plot",
  "request_secret",
  "save_memory",
  "save_page",
  "update_preferences",
  "save_shared_memory",
  "schedule_cancel",
  "schedule_create",
  "schedule_list",
  "scratchpad_add",
  "scratchpad_complete",
  "scratchpad_list",
  "scratchpad_remove",
  "scratchpad_update",
  "skill_read",
  "task_catalog",
  "write_file",
]);

export function toolResultTaintsRun(toolName: string): boolean {
  return !OWN_STATE_RESULT_TOOLS.has(toolName);
}

const MEMORY_WRITE_TOOLS = new Set(["remember", "save_memory", "save_shared_memory"]);

/** Outside input reduces the authority to save durable memory. */
export async function memoryWriteNeedsApproval(
  toolName: string,
  isTainted: () => Promise<boolean>,
): Promise<boolean> {
  return MEMORY_WRITE_TOOLS.has(toolName) && (await isTainted());
}

/**
 * A connector read still sends its arguments to the connector's server. Until outside content
 * enters the run, those arguments come from the owner's request. After that, injected text could
 * choose them, so a read skips approval only on a connector this run already used before then or
 * was approved for. Reads on that connector stay free, so list-then-get flows never ask twice.
 */
export function connectorReadRequiresApproval(input: {
  tainted: boolean;
  connectorTrusted: boolean;
}): boolean {
  return input.tainted && !input.connectorTrusted;
}

/** An outbound URL is trusted by its site, not by an allowance for the whole fetch tool. */
export function outboundSiteGate(input: {
  site: string;
  trusted: boolean;
  rules: ActionApprovalRule[];
}): "allow" | "new" {
  return input.trusted || siteAlwaysAllowed(input.rules, input.site) ? "allow" : "new";
}

/** A webhook cannot pause for a person to approve a destination it discovered. */
export function newSiteOutcome(input: {
  trigger: string;
  decision: "ask" | "allow";
}): "ask" | "allow" | "deny" {
  if (input.decision === "allow") return "allow";
  return input.trigger === "webhook" ? "deny" : "ask";
}

/** Tools whose approval cards can save a durable site allowance. */
export const SITE_SENDING_TOOLS: ReadonlySet<string> = new Set(["web_fetch"]);
export const OUTBOUND_HTTP_TOOLS: ReadonlySet<string> = new Set([
  ...SITE_SENDING_TOOLS,
  "secret_request",
]);

export const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

export const BOT_SECRET_HTTP_REQUEST_KIND = "bot_secret_http";

export function readBotSecretHttpEffect(request: unknown) {
  if (
    !Array.isArray(request) ||
    request.length !== 3 ||
    request[0] !== BOT_SECRET_HTTP_REQUEST_KIND
  )
    return undefined;
  const [, credential, args]: unknown[] = request;
  if (
    !credential ||
    typeof credential !== "object" ||
    !("id" in credential) ||
    !("revision" in credential) ||
    typeof credential.id !== "string" ||
    !credential.id ||
    typeof credential.revision !== "string" ||
    !credential.revision ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return undefined;
  return {
    args: args as Record<string, unknown>,
    credential: { id: credential.id, revision: credential.revision },
  };
}

/** Show direction controls literally so review text keeps its visible order. */
export function escapeApprovalBidi(value: string): string {
  return value.replace(
    /\p{Bidi_Control}/gu,
    (mark) => `\\u${mark.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Display every dispatched field. No request may be approved from a clipped preview. */
export function formatBotSecretHttpApprovalDetail(args: unknown): string | undefined {
  const parsed = SecretHttpRequest.safeParse(args);
  if (!parsed.success) return undefined;
  const request = parsed.data;
  const url = normalizedHttpUrl(request.url);
  if (!url || new URL(url).hash) return undefined;
  const detail = [
    `method: ${request.method}`,
    `credential: ${request.name}`,
    `url: ${url}`,
    `content type: ${request.contentType}`,
    ...(request.body === undefined
      ? []
      : [`body: ${escapeApprovalBidi(JSON.stringify(request.body))}`]),
  ].join("\n");
  return detail.length <= MAX_APPROVAL_DETAIL_LENGTH ? detail : undefined;
}

/** Site rules use the same private-suffix-aware identity as outbound requests. */
export function canonicalApprovalSite(value: string): string | undefined {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.username || url.password) return undefined;
    return urlSite(url.href);
  } catch {
    return undefined;
  }
}

export function siteAlwaysAllowed(rules: ActionApprovalRule[], site: string): boolean {
  return rules.some(
    (rule) =>
      rule.effect === "always_allow" &&
      rule.matchKind === "site" &&
      canonicalApprovalSite(rule.matchValue) === site,
  );
}

function categoryMatches(
  category: string,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
): boolean {
  const normalized = category.toLowerCase();
  const consequential = connectorToolRequiresApproval(toolName, readOnly);
  if (normalized === "email") {
    if (EMAIL_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /send.*mail|gmail_send|outlook_send/i.test(toolName);
  }
  if (normalized === "purchase") {
    if (PURCHASE_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /purchase|pay_|charge|checkout|buy_/i.test(toolName);
  }
  return false;
}

function ruleMatches(
  rule: ActionApprovalRule,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
  site?: string,
): boolean {
  const value = rule.matchValue.toLowerCase();
  switch (rule.matchKind) {
    case "site":
      return site !== undefined && site === canonicalApprovalSite(rule.matchValue);
    case "tool":
      return toolName.toLowerCase() === value;
    case "connector":
      return connectorKind.toLowerCase() === value;
    case "category":
      return categoryMatches(rule.matchValue, toolName, connectorKind, readOnly);
    default:
      return false;
  }
}

function ruleSpecificity(rule: ActionApprovalRule): number {
  switch (rule.matchKind) {
    case "site":
      return 4;
    case "tool":
      return 3;
    case "connector":
      return 2;
    case "category":
      return 1;
    default:
      return 0;
  }
}

export type ActionApprovalSource = "require_approval" | "always_allow" | "deny" | "default";

export type ActionApprovalResolved = {
  decision: "ask" | "allow" | "deny";
  source: ActionApprovalSource;
  matchingRules: ActionApprovalRule[];
};

/** Any matching block wins. Other decisions use the most specific matching rule. */
export function resolveActionApprovalDetail(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  site?: string;
  rules: ActionApprovalRule[];
}): ActionApprovalResolved {
  const connectorKind = input.connectorKind ?? connectorKindFromToolName(input.toolName);
  const matchingRules = input.rules.filter((rule) =>
    ruleMatches(rule, input.toolName, connectorKind, input.readOnly, input.site),
  );
  if (matchingRules.length === 0) {
    return { decision: "allow", source: "default", matchingRules };
  }

  if (matchingRules.some((rule) => rule.effect === "deny")) {
    return { decision: "deny", source: "deny", matchingRules };
  }
  const highestSpecificity = Math.max(...matchingRules.map(ruleSpecificity));
  const winners = matchingRules.filter((rule) => ruleSpecificity(rule) === highestSpecificity);
  if (winners.some((rule) => rule.effect === "require_approval")) {
    return { decision: "ask", source: "require_approval", matchingRules };
  }
  return { decision: "allow", source: "always_allow", matchingRules };
}

export type ConnectorBatchActionNames = { actions: string[]; complete: boolean };

/** Return the stable rule identities only when the card displays the complete raw list. */
export function displayedBatchApprovalRuleNames(
  batch: ConnectorBatchActionNames,
  detail?: string,
): string[] | undefined {
  return batch.complete &&
    batch.actions.length > 0 &&
    detail?.split("\n", 1)[0] === batch.actions.join(", ")
    ? [...new Set(batch.actions.map((name) => name.toUpperCase()))]
    : undefined;
}

/** A block on any action or wrapper wins. A saved allow must cover every inner action. */
export function resolveBatchActionApproval(input: {
  actions: ReadonlyArray<{ toolName: string; connectorKind: string; readOnly?: boolean }>;
  wrappers: ReadonlyArray<{ toolName: string; connectorKind: string; readOnly?: boolean }>;
  rules: ActionApprovalRule[];
}): ActionApprovalResolved {
  const actions = input.actions.map((tool) =>
    resolveActionApprovalDetail({ ...tool, rules: input.rules }),
  );
  const wrapperRules = input.rules.filter((rule) => rule.effect !== "always_allow");
  const wrapperRequirements = input.wrappers
    .map((tool) => resolveActionApprovalDetail({ ...tool, rules: wrapperRules }))
    .filter((part) => part.decision !== "allow");
  const parts = [...actions, ...wrapperRequirements];
  const matchingRules = [...new Set(parts.flatMap((part) => part.matchingRules))];
  if (parts.some((part) => part.decision === "deny")) {
    return { decision: "deny", source: "deny", matchingRules };
  }
  if (parts.some((part) => part.decision === "ask")) {
    return { decision: "ask", source: "require_approval", matchingRules };
  }
  const allAllowed = actions.length > 0 && actions.every((part) => part.source === "always_allow");
  return { decision: "allow", source: allAllowed ? "always_allow" : "default", matchingRules };
}

export function resolveActionApproval(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  site?: string;
  rules: ActionApprovalRule[];
}): "ask" | "allow" | "deny" {
  return resolveActionApprovalDetail(input).decision;
}

export type AutoReviewJudgeDecision = "pass" | "ask" | "error";

/**
 * Pure combiner for Auto Review after rule resolution.
 * Blocks refuse before review. Only the default path may call a judge.
 * The judge only escalates to ask; it never silent-denies.
 */
export function planActionGate(input: {
  resolved: ActionApprovalResolved;
  consequential: boolean;
  autoReviewEnabled: boolean;
  checkerConfigured: boolean;
  /** Outside content may have selected a new connector's read arguments. */
  reviewOnly?: boolean;
  /** An outbound URL whose site the run has not been given. */
  newDestination?: boolean;
}): "ask" | "allow" | "judge" | "deny" {
  if (input.resolved.decision !== "allow") return input.resolved.decision;
  if (input.newDestination)
    return input.autoReviewEnabled && input.checkerConfigured ? "judge" : "ask";
  if (input.resolved.source === "always_allow") return "allow";
  if (
    (input.consequential || input.reviewOnly) &&
    input.autoReviewEnabled &&
    input.checkerConfigured &&
    input.resolved.source === "default"
  ) {
    return "judge";
  }
  return "allow";
}

/** Map a judge outcome onto ask/allow. Errors fail closed on consequential tools. */
export function applyJudgeDecision(input: {
  decision: AutoReviewJudgeDecision;
  consequential: boolean;
}): "ask" | "allow" {
  if (input.decision === "pass") return "allow";
  if (input.decision === "ask") return "ask";
  return input.consequential ? "ask" : "allow";
}

export function isSecretAskBlock(block: {
  kind: string;
  input?: string;
  approvalEffectId?: string;
}): boolean {
  return block.kind === "ask" && block.input === "secret" && !block.approvalEffectId;
}

export function isApprovalAskBlock(block: {
  kind: string;
  approvalEffectId?: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  if (block.kind !== "ask" || !block.approvalEffectId || !block.actions?.length) return false;
  const actionIds = new Set(block.actions.map((action) => action.id));
  return (
    actionIds.has("allow") &&
    actionIds.has("deny") &&
    [...actionIds].every((id) => id === "allow" || id === "always" || id === "deny")
  );
}
