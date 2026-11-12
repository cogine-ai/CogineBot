import type { MessagingInboundMessage, TeamChatInboundMessage } from "@rakazo/adapter-kit";
import type { TeamChatInstallationGrant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  type MessagingInboundDeps,
  prepareTeamChatInboundContent,
  teamChatSenderCanWakeMessageRoutines,
  wakeMessageRoutines,
} from "./messaging-inbound.js";
import {
  isDeferredReservationLost,
  type TeamChatBridge,
  type TeamChatInboundTarget,
  teamChatMessageClientNonce,
} from "./team-chat-bridge.js";

export async function routeTeamChatMessage(
  deps: Pick<MessagingInboundDeps, "prisma" | "events" | "jobs" | "artifacts">,
  bridge: TeamChatBridge,
  event: MessagingInboundMessage,
  mapped: TeamChatInboundMessage,
  installation?: TeamChatInstallationGrant & { eventAt: Date },
) {
  const preparation = event.attachments?.length
    ? {
        prepareTranscript: (target: TeamChatInboundTarget) =>
          prepareTeamChatInboundContent(deps, target, event),
      }
    : undefined;
  const scope = bridge.scope;
  if (!scope) throw new Error("Team chat bridge is not started");
  const canWake = await teamChatSenderCanWakeMessageRoutines(deps, event, scope, { installation });
  const receiveOptions = { eventAt: installation?.eventAt, ...preparation };
  if (!canWake) {
    await bridge.receive(mapped, receiveOptions);
    return;
  }

  // Persist a non-reconcilable row until routine routing owns or releases
  // the message, so the timer cannot start a second TeamChat run.
  const target = await bridge.receive(mapped, { queueAgent: false, ...receiveOptions });
  if (!target.deferred) return;
  const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
  let woken = false;
  bridge.markRoutineWakeInFlight(target.externalMessageId);
  try {
    const wakePromise = wakeMessageRoutines(deps, target, event, {
      // Must match TeamChatBridge ExternalConversation / recovery provider.
      deliveryProvider: bridge.providerId,
      content: target.content,
      teamChatClaim: {
        id: target.externalMessageId,
        route: "routine",
        competingNonce: teamChatMessageClientNonce(bridge.providerId, mapped.eventId),
        ...(installation && { installation }),
        verifySender: (tx) =>
          teamChatSenderCanWakeMessageRoutines({ prisma: tx }, event, scope, {
            installation,
            lockApproval: true,
          }),
      },
    });
    try {
      woken = await Promise.race([wakePromise, leaseHeartbeat.lost]);
    } catch (error) {
      if (isDeferredReservationLost(error)) {
        // Lease loss must not start a fallback agent beside an in-flight
        // wake: re-hold exclusive ownership while awaiting that wake, then
        // resolve from its settled result.
        let hold: { stop: () => void } | undefined;
        try {
          hold = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
        } catch {
          // Row already left deferred; wake CAS / resolve decide the winner.
        }
        try {
          try {
            woken = await wakePromise;
          } catch (wakeError) {
            const released = await bridge.resolveDeferredMessage(
              target.externalMessageId,
              "agent",
              mapped.kind,
            );
            if (!released) {
              throw new Error("Team chat deferred message ownership conflict", {
                cause: wakeError,
              });
            }
            await bridge.reconcileOnce();
            getLogger().error("team chat routine wake failed after deferred lease loss", wakeError);
            return;
          }
        } finally {
          hold?.stop();
        }
      } else {
        await bridge.resolveDeferredMessage(target.externalMessageId, "agent", mapped.kind);
        await bridge.reconcileOnce();
        throw error;
      }
    }
    const resolved = await bridge.resolveDeferredMessage(
      target.externalMessageId,
      woken ? "routine" : "agent",
      mapped.kind,
    );
    if (!resolved && woken) {
      throw new Error("Team chat deferred message ownership conflict");
    }
    if (!woken) await bridge.reconcileOnce();
  } finally {
    bridge.clearRoutineWakeInFlight(target.externalMessageId);
    leaseHeartbeat.stop();
  }
}
