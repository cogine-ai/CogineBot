import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { isTeamBotFolderName, powerProvider, toComputerRef, withAbort } from "@rakazo/adapters";
import type {
  Actor,
  ComputerDiskProbeOutcome,
  ComputerDiskUsageInput,
  ComputerDiskUsageResult,
  ComputerStorageRecovery,
  ManagedDiskProbe,
} from "@rakazo/contracts";
import { COMPUTER_DISK_USAGE_TIMEOUT_MS } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import { computerScopeKey, IsolationError } from "@rakazo/db";

type GetBot = ReturnType<typeof createRepos>["getBot"];
type Bot = Awaited<ReturnType<GetBot>>;

export function ownedWorkspace(
  actor: Actor,
  bot: Pick<Bot, "id" | "computer">,
): ManagedDiskProbe["workspace"] | undefined {
  const computer = bot.computer;
  if (!computer) return undefined;
  if (
    computer.spaceId !== actor.spaceId ||
    (computer.scope !== "team" && computer.scope !== "dedicated") ||
    computer.scopeKey !== computerScopeKey(computer.scope, actor.spaceId, bot.id) ||
    (computer.scope === "dedicated" && computer.userId !== actor.userId)
  )
    throw new IsolationError();
  if (computer.scope === "dedicated") return { kind: "dedicated" };
  if (!isTeamBotFolderName(bot.id)) throw new IsolationError();
  return { kind: "team", botId: bot.id };
}

export function computerStorageTarget(
  actor: Actor,
  bot: Pick<Bot, "id" | "screenGeneration" | "computerSwitching" | "computer">,
) {
  const computer = bot.computer;
  if (!computer) return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        actor.userId,
        actor.spaceId,
        bot.id,
        bot.screenGeneration,
        bot.computerSwitching,
        computer.id,
        computer.kind,
        computer.scopeKey,
        computer.userId,
        computer.homeKey,
        computer.providerRef,
        computer.providerAuthority,
        computer.screenGeneration,
        computer.state,
        computer.runningSince,
        computer.restorePending,
        computer.stopRequestedAt,
        computer.maintenanceId,
      ]),
    )
    .digest("hex");
}

export function workspaceFullRecovery(actor: Actor, bot: Bot): ComputerStorageRecovery | undefined {
  if (!ownedWorkspace(actor, bot)) return undefined;
  const expectedTarget = computerStorageTarget(actor, bot);
  return expectedTarget
    ? { kind: "computer_storage", code: "ENOSPC", botId: bot.id, expectedTarget }
    : undefined;
}

export async function readComputerDiskUsage(
  input: ComputerDiskUsageInput,
  context: {
    actor: Actor;
    signal?: AbortSignal;
    diskUsageDeadline?: number;
    stillAuthorized?: () => Promise<boolean>;
  },
  deps: { getBot: GetBot; sandbox: SandboxProvider },
): Promise<ComputerDiskUsageResult> {
  const now = performance.now();
  const deadline = context.diskUsageDeadline ?? now + COMPUTER_DISK_USAGE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - now)));
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  let target: string | null = null;
  const finish = (outcome: ComputerDiskUsageResult["outcome"]): ComputerDiskUsageResult => ({
    botId: input.botId,
    target,
    outcome,
  });
  try {
    if (performance.now() >= deadline) return finish({ status: "timeout" });
    signal.throwIfAborted();
    const bot = await withAbort(deps.getBot(context.actor, input.botId), signal);
    const workspace = ownedWorkspace(context.actor, bot);
    const computer = bot.computer;
    target = computerStorageTarget(context.actor, bot);
    if (input.expectedTarget !== undefined && input.expectedTarget !== target)
      return finish({ status: "changed" });
    if (!computer || !workspace) return finish({ status: "not_running" });
    if (computer.kind === "desktop") return finish({ status: "unsupported" });
    if (bot.computerSwitching || computer.maintenanceId || computer.stopRequestedAt)
      return finish({ status: "unavailable" });
    if (computer.state !== "running" || computer.restorePending || !computer.providerRef)
      return finish({ status: "not_running" });

    const ref = toComputerRef(computer);
    const provider = powerProvider(deps.sandbox, ref);
    if (!provider?.getDiskUsage) return finish({ status: "unsupported" });
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs <= 0) return finish({ status: "timeout" });
    const operationId = "computer.diskUsage";
    let outcome: ComputerDiskProbeOutcome;
    try {
      signal.throwIfAborted();
      outcome = await withAbort(
        provider.getDiskUsage(
          ref,
          { workspace, timeoutMs },
          {
            operationId,
            traceId: operationId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            botId: bot.id,
            signal,
          },
        ),
        signal,
      );
    } catch {
      signal.throwIfAborted();
      return finish({ status: "unavailable" });
    }
    if (outcome.status !== "available") return finish(outcome);

    if (context.stillAuthorized && !(await withAbort(context.stillAuthorized(), signal)))
      throw new ORPCError("FORBIDDEN");
    signal.throwIfAborted();
    const current = await withAbort(deps.getBot(context.actor, input.botId), signal);
    ownedWorkspace(context.actor, current);
    signal.throwIfAborted();
    if (performance.now() >= deadline) return finish({ status: "timeout" });
    if (computerStorageTarget(context.actor, current) !== target)
      return finish({ status: "changed" });
    return finish(outcome);
  } catch (error) {
    context.signal?.throwIfAborted();
    if (timeout.aborted) return finish({ status: "timeout" });
    throw error;
  }
}
