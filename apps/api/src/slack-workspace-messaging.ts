import { AsyncLocalStorage } from "node:async_hooks";
import type { ArtifactStore, JobPublisher, MessagingSurface } from "@rakazo/adapter-kit";
import type { WorkspaceInstallation } from "@rakazo/adapters";
import {
  createMessagingTeamChatSender,
  credentialDigest,
  type MessagingInstallations,
  type SlackInstallProvider,
  toTeamChatInbound,
} from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { prepareTeamChatInboundContent } from "./messaging-inbound.js";
import { TeamChatBridge } from "./team-chat-bridge.js";
import { settleWithTimeout, TEAM_CHAT_STARTUP_SHUTDOWN_MS } from "./team-chat-startup.js";

const MAX_CACHED_WORKSPACES = 128;
export const SLACK_INSTALL_CALLBACK = "/api/v1/messaging/install/slack/callback";
export const SLACK_INSTALL_EVENTS = "/api/v1/messaging/install/slack/events";

type Workspace = {
  revision: number;
  digest: string;
  surface: MessagingSurface;
  bridge: TeamChatBridge;
  started: Promise<void>;
  users: number;
  retired: boolean;
};

type Dependencies = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  events: ThreadEvents;
  jobs: Pick<JobPublisher, "enqueue">;
};

export class SlackWorkspaceMessaging {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly eventClock = new AsyncLocalStorage<Date>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  private stopped = false;

  constructor(
    readonly installations: MessagingInstallations,
    private readonly provider: SlackInstallProvider | undefined,
    private readonly deps: Dependencies,
  ) {}

  async webhook(request: Request) {
    const provider = this.provider;
    if (!provider) return new Response(null, { status: 404 });
    let event: Awaited<ReturnType<SlackInstallProvider["parseWebhook"]>>;
    try {
      event = await provider.parseWebhook(request);
    } catch {
      return new Response("Invalid webhook", { status: 401 });
    }
    if (event.challenge !== undefined) return Response.json({ challenge: event.challenge });
    if (!event.workspaceId || !event.appId || !event.eventAt)
      return new Response(null, { status: 200 });
    if (event.uninstalled || event.revokedBots) {
      await this.installations.revoke({
        workspaceId: event.workspaceId,
        appId: event.appId,
        at: event.eventAt,
        precise: event.preciseEventTime,
        botUsers: event.revokedBots,
      });
      return new Response(null, { status: 200 });
    }
    const row = await this.installations.activeByWorkspace(event.workspaceId);
    if (!row || event.appId !== row.appId || event.eventAt <= row.acceptAfter)
      return new Response(null, { status: 200 });
    const eventAt = event.eventAt;
    return this.use(row, async (entry) => {
      if (!(await this.current(row))) return new Response(null, { status: 200 });
      return this.eventClock.run(
        eventAt,
        async () =>
          (await entry.surface.handleWebhook("slack", event.request)) ??
          new Response(null, { status: 200 }),
      );
    });
  }

  start() {
    if (this.timer || this.stopped) return;
    const tick = () => {
      if (this.maintenance || this.stopped) return;
      this.maintenance = runAsSystem("resume Slack workspace messaging", () => this.maintain())
        .catch(() => getLogger().error("Slack workspace maintenance failed"))
        .finally(() => {
          this.maintenance = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, this.provider ? 5_000 : 60_000);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const entry of this.workspaces.values()) await this.retire(entry);
    this.workspaces.clear();
    await settleWithTimeout(this.maintenance, TEAM_CHAT_STARTUP_SHUTDOWN_MS);
  }

  private async maintain() {
    await this.installations.cleanup();
    if (!this.provider) return;
    const targets = await this.installations.activeTargets();
    const active = new Set(targets.map(({ id }) => id));
    for (const [id, entry] of this.workspaces) {
      if (!active.has(id)) {
        this.workspaces.delete(id);
        await this.retire(entry);
      }
    }
    for (const { id } of targets) {
      if (this.stopped) return;
      const row = await this.installations.activeById(id);
      if (!row) continue;
      try {
        await this.use(row, (entry) => entry.bridge.reconcileOnce());
      } catch {
        getLogger().error("Slack workspace recovery failed");
      }
    }
  }

  private async current(row: WorkspaceInstallation) {
    if (this.stopped) return false;
    return this.installations.isCurrent(row);
  }

  private async use<T>(row: WorkspaceInstallation, task: (entry: Workspace) => Promise<T>) {
    const provider = this.provider;
    if (!provider) throw new Error("Slack installation is unavailable");
    const credential = await this.installations.credential(row);
    if (!(await this.current(row))) throw new Error("Slack connection changed");
    const digest = credentialDigest(credential);
    let entry = this.workspaces.get(row.id);
    const retired: Workspace[] = [];
    if (entry && (entry.revision !== row.revision || entry.digest !== digest)) {
      this.workspaces.delete(row.id);
      retired.push(entry);
      entry = undefined;
    }
    if (!entry) {
      if (this.workspaces.size >= MAX_CACHED_WORKSPACES) {
        const idle = [...this.workspaces].find(([, candidate]) => candidate.users === 0);
        if (!idle) throw new Error("Slack messaging is busy");
        this.workspaces.delete(idle[0]);
        retired.push(idle[1]);
      }
      const current = () => this.current(row);
      const surface = provider.surface(credential, current, async (error) => {
        if (provider.credentialWasRejected(error))
          await this.installations.revokeRejectedCredential(row);
      });
      const send = createMessagingTeamChatSender(surface, current);
      const bridge = new TeamChatBridge({
        prisma: this.deps.prisma,
        jobs: this.deps.jobs,
        events: this.deps.events,
        botId: row.botId,
        providerId: `slack~${row.id}`,
        installedSlack: { acceptAfter: row.acceptAfter, isAvailable: current },
        reconcileIntervalMs: 0,
        send: async (request) => {
          try {
            return await send(request);
          } catch (error) {
            if (provider.credentialWasRejected(error))
              await this.installations.revokeRejectedCredential(row);
            throw error;
          }
        },
      });
      surface.onInbound(async (event) => {
        const eventAt = this.eventClock.getStore();
        if (
          !eventAt ||
          eventAt <= row.acceptAfter ||
          event.type !== "message" ||
          event.senderIsBot ||
          event.workspaceId !== row.workspaceId ||
          event.from !== row.installerId ||
          (!event.isDirect && event.kind !== "mention") ||
          !(await this.current(row))
        )
          return;
        const mapped = toTeamChatInbound(event);
        if (!mapped) return;
        await bridge.receive(mapped, {
          eventAt,
          prepareTranscript: event.attachments?.length
            ? (scope) => prepareTeamChatInboundContent(this.deps, scope, event)
            : undefined,
        });
      });
      entry = {
        revision: row.revision,
        digest,
        surface,
        bridge,
        started: bridge.start(),
        users: 0,
        retired: false,
      };
      this.workspaces.set(row.id, entry);
    }
    entry.users++;
    try {
      await Promise.all(retired.map((old) => this.retire(old)));
      await entry.started;
      return await task(entry);
    } catch (error) {
      if (this.workspaces.get(row.id) === entry) this.workspaces.delete(row.id);
      entry.retired = true;
      throw error;
    } finally {
      entry.users--;
      if (entry.retired && entry.users === 0) await this.close(entry);
    }
  }

  private async retire(entry: Workspace) {
    entry.retired = true;
    if (entry.users === 0) await this.close(entry);
  }

  private async close(entry: Workspace) {
    await entry.bridge.stop();
    await entry.surface.shutdown?.();
  }
}
