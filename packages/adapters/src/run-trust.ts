import type { MessageBlock } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import {
  CALL_CLIENT_NONCE_PREFIX,
  callIdFromClientNonce,
  connectorKindFromToolName,
  resolveActionApprovalDetail,
} from "@rakazo/core";
import { sitesInText, urlSite } from "@rakazo/core/egress";
import type { ClaimedSteeringMessage, PrismaClient } from "@rakazo/db";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
} from "./approval-effect.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./builtin-tools.js";

/** These reached the gate; they do not necessarily represent a successful external operation. */
const PASSED_EFFECT_STATUSES = ["approved", "executing", "uncertain", "completed"];
type AuthoredMessage = { role: string; authorUserId?: string | null; blocks: unknown };

function textBlocks(blocks: unknown): string {
  return (Array.isArray(blocks) ? (blocks as MessageBlock[]) : [])
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n");
}

/** Use the closed call's own transcript, independent of the model's recent history window. */
export async function loadCallEndOwnerWords(
  prisma: PrismaClient,
  run: { threadId: string; botId: string; userId: string; clientNonce: string | null },
): Promise<string> {
  const callId = callIdFromClientNonce(run.clientNonce);
  if (!callId) return "";
  const prefix = `${CALL_CLIENT_NONCE_PREFIX}${callId}:`;
  const marker = await prisma.message.findUnique({
    where: {
      threadId_clientNonce: { threadId: run.threadId, clientNonce: `${prefix}marker` },
      role: "bot",
      botId: run.botId,
    },
    select: { seq: true, blocks: true },
  });
  if (
    !Array.isArray(marker?.blocks) ||
    !(marker.blocks as MessageBlock[]).some(
      (block) => block.kind === "voice_call" && block.callId === callId,
    )
  )
    return "";
  // Prisma uses LIKE for startsWith, and call IDs may contain literal wildcards.
  const noncePrefix = prefix.replace(/[\\%_]/g, "\\$&");
  const messages = await prisma.message.findMany({
    where: {
      threadId: run.threadId,
      role: "user",
      authorUserId: run.userId,
      clientNonce: { startsWith: noncePrefix },
      seq: { lt: marker.seq },
    },
    orderBy: { seq: "asc" },
    select: { clientNonce: true, blocks: true },
  });
  return messages
    .filter((message) => callIdFromClientNonce(message.clientNonce) === callId)
    .map((message) => textBlocks(message.blocks))
    .join("\n");
}

type ConnectorTrustRoute = {
  connectorId?: string;
  resourceId?: string;
  resourceRevision?: string | number;
  connectionId?: string;
};

type ConnectorBatchAction = { name: string; account: string };

/** Read trust belongs to the live authorization and each app/account a batch reaches. */
export function connectorTrustKeys(
  batchActions: readonly ConnectorBatchAction[] | undefined,
  route: ConnectorTrustRoute | undefined,
  connectorKind: string,
  providers: string[],
): string[] {
  const resource =
    route?.connectorId && route.resourceId
      ? ["resource", route.connectorId, route.resourceId]
      : ["kind", connectorKind];
  const connection = [...resource, route?.resourceRevision ?? null, route?.connectionId ?? null];
  if (!batchActions) return [JSON.stringify(connection)];
  const apps = providers.map((provider) => provider.toLowerCase());
  return batchActions.map(({ name, account }) => {
    const action = name.toLowerCase();
    const app = apps
      .filter((kind) => action === kind || action.startsWith(`${kind}_`))
      .sort((left, right) => right.length - left.length)[0];
    return JSON.stringify([...connection, app ?? action, account]);
  });
}

/** Only batches with an explicit resolved account for every operation establish reusable trust. */
export function connectorBatchActions(
  toolName: string,
  args: unknown,
): { actions: ConnectorBatchAction[]; complete: boolean } | undefined {
  if (toolName.toUpperCase() !== "COMPOSIO_MULTI_EXECUTE_TOOL") return undefined;
  const tools = (args as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return { actions: [], complete: false };
  const actions = new Map<string, ConnectorBatchAction>();
  let complete = true;
  for (const item of tools) {
    const { tool_slug: slug, account } =
      (item as {
        tool_slug?: unknown;
        account?: unknown;
      } | null) ?? {};
    const name = typeof slug === "string" ? slug.trim() : "";
    if (!name || typeof account !== "string" || !account || account.trim() !== account) {
      complete = false;
      continue;
    }
    actions.set(JSON.stringify([name, account]), { name, account });
  }
  return { actions: [...actions.values()], complete };
}

/** Security provenance is shared by all tools of one attempt, never supplied by the model. */
export function createRunTrust(
  prisma: PrismaClient,
  input: {
    run: { id: string; userId: string; spaceId: string; trigger: string };
    routineInstructions?: string | null;
    routineSites?: readonly string[];
    callOwnerWords?: () => Promise<string>;
    sourceMessage: AuthoredMessage | null;
    ownerStartedRun: boolean;
    messagingChannelRun: boolean;
    restored: boolean;
    connectedProviders: string[];
    catalogApprovalMarker: string;
  },
) {
  const { run } = input;
  const state = { tainted: !input.ownerStartedRun || input.restored };
  let earlierAttempt: Promise<boolean> | undefined;
  const receivedOutsideMessage = async () =>
    Boolean(
      await prisma.steeringMessage.findFirst({
        where: {
          runId: run.id,
          claimedAt: { not: null },
          OR: [
            { originTrigger: { not: null } },
            { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
            { message: { clientNonce: { startsWith: "messaging:" } } },
            { message: { authorUserId: null } },
            { message: { authorUserId: { not: run.userId } } },
          ],
        },
        select: { id: true },
      }),
    );
  const isTainted = async () => {
    if (state.tainted) return true;
    earlierAttempt ??= prisma.attempt
      .count({ where: { runId: run.id } })
      .then((count) => count > 1);
    if ((await earlierAttempt) || (await receivedOutsideMessage())) state.tainted = true;
    return state.tainted;
  };
  let ownerWords: Promise<string> | undefined;
  const loadInitialOwnerWords = () =>
    (ownerWords ??= (async () => {
      if (
        input.ownerStartedRun &&
        !input.messagingChannelRun &&
        input.sourceMessage?.role === "user" &&
        (input.sourceMessage.authorUserId === run.userId ||
          // Before authors were recorded, only this trigger uniquely identified an app send.
          (input.sourceMessage.authorUserId == null && run.trigger === "user"))
      )
        return textBlocks(input.sourceMessage.blocks);
      if (run.trigger === "call_end") return input.callOwnerWords?.() ?? "";
      if (run.trigger === "routine" || run.trigger === "webhook")
        return input.routineInstructions ?? "";
      return "";
    })());
  const ownerSteeringWords = new Map<string, string>();
  const ownerSteeringSites = new Set<string>();
  const recordSteering = (steering: readonly ClaimedSteeringMessage[]) => {
    for (const item of steering) {
      if (!item.ownerInput) {
        state.tainted = true;
        continue;
      }
      if (ownerSteeringWords.has(item.id)) continue;
      const words = textBlocks(item.blocks);
      ownerSteeringWords.set(item.id, words);
      for (const site of sitesInText(words)) ownerSteeringSites.add(site);
    }
  };
  const loadOwnerWords = async () =>
    [await loadInitialOwnerWords(), ...ownerSteeringWords.values()].filter(Boolean).join("\n");
  let trustedSites: Promise<Set<string>> | undefined;
  const loadTrustedSites = async () => {
    trustedSites ??= prisma.externalEffect
      .findMany({
        where: {
          runId: run.id,
          spaceId: run.spaceId,
          kind: "web_fetch",
          status: { in: PASSED_EFFECT_STATUSES },
        },
        select: { request: true },
      })
      .then(async (rows) => {
        const sites = sitesInText(await loadInitialOwnerWords());
        if (run.trigger === "routine" || run.trigger === "webhook") {
          for (const site of input.routineSites ?? []) sites.add(site);
        }
        for (const row of rows) {
          const url = (row.request as { url?: unknown } | null)?.url;
          const site = typeof url === "string" ? urlSite(url) : undefined;
          if (site) sites.add(site);
        }
        return sites;
      });
    const sites = await trustedSites;
    for (const site of ownerSteeringSites) sites.add(site);
    return sites;
  };
  const routineSitePolicy = async (prompt: string, rules: ActionApprovalRule[]) => {
    const sites = [...sitesInText(prompt)];
    if (sites.length === 0) return { sitesToReview: [], authorizedSites: [] };
    // A saved Routine can trust these sites in future Runs. A prior fetch approval only
    // applies to the current Run and cannot authorize a change to its saved instructions.
    const ownerSites = sitesInText(await loadOwnerWords());
    const siteRules = rules.filter((rule) => rule.matchKind === "site");
    const namesNewSite = sites.some(
      (site) =>
        !ownerSites.has(site) &&
        resolveActionApprovalDetail({ toolName: "web_fetch", site, rules: siteRules }).source !==
          "always_allow",
    );
    // Approval binds the whole prompt, so show every destination it will save.
    return {
      sitesToReview: namesNewSite ? sites : [],
      authorizedSites: sites.filter((site) => ownerSites.has(site)),
    };
  };
  let trustedConnectors: Promise<Set<string>> | undefined;
  const loadTrustedConnectors = () =>
    (trustedConnectors ??= prisma.externalEffect
      .findMany({
        where: { runId: run.id, spaceId: run.spaceId, status: { in: PASSED_EFFECT_STATUSES } },
        select: { kind: true, request: true },
      })
      .then((rows) => {
        const keys = rows
          .filter((row) => !BUILTIN_AGENT_TOOL_NAMES.has(row.kind))
          .flatMap((row) => {
            const bound = boundDirectApprovalDetails(row.request, input.catalogApprovalMarker);
            const catalog = catalogApprovalDetails(row.request, input.catalogApprovalMarker);
            const route = bound?.route ?? catalog?.route;
            const args = bound?.args ?? (catalog ? catalogApprovalInnerArgs(catalog) : row.request);
            const batch = connectorBatchActions(route?.toolName ?? row.kind, args);
            if (batch && !batch.complete) return [];
            return connectorTrustKeys(
              batch?.actions,
              route,
              connectorKindFromToolName(row.kind, input.connectedProviders),
              input.connectedProviders,
            );
          });
        return new Set(keys);
      }));
  return {
    state,
    isTainted,
    recordSteering,
    loadOwnerWords,
    loadTrustedSites,
    loadTrustedConnectors,
    routineSitePolicy,
  };
}
