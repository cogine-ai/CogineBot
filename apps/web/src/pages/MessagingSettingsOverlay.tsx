import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ExternalConversation,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { providerLabel } from "../lib/messaging";
import { createSpaceRpc, currentSpaceSelectionGeneration, selectedSpaceId } from "../lib/rpc";
import { ExternalConversationSettings } from "./ExternalConversationSettings";

export function MessagingSettingsOverlay({
  onClose,
  ownerKey,
  spaceId,
}: {
  onClose: () => void;
  ownerKey: string | null;
  spaceId: string | null;
}) {
  const { t } = useLingui();
  const [loaded, setLoaded] = useState<{
    binding: object;
    status: MessagingStatus;
    channels: MessagingChannelMembership[];
    connections: MessagingAgentConnection[];
    bots: Bot[];
    externalConversations: ExternalConversation[];
  } | null>(null);
  const [settingsConversationId, setSettingsConversationId] = useState<string | null>(null);
  const [linkBotId, setLinkBotId] = useState("");
  const [storedLinkCode, setLinkCode] = useState<{
    code: string;
    expiresAt: string;
    botId: string;
    identityIds: string[];
    binding: object;
  } | null>(null);
  const [pollError, setPollError] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const selection = selectedSpaceId();
  const generation = currentSpaceSelectionGeneration();
  const origin = window.location.origin;
  const binding = useMemo(
    () => ({ ownerKey, spaceId, selection, generation, origin }),
    [ownerKey, spaceId, selection, generation, origin],
  );
  const status = loaded?.binding === binding ? loaded.status : null;
  const channels = loaded?.binding === binding ? loaded.channels : [];
  const connections = loaded?.binding === binding ? loaded.connections : [];
  const bots = loaded?.binding === binding ? loaded.bots : [];
  const externalConversations = loaded?.binding === binding ? loaded.externalConversations : [];
  const linkCode = storedLinkCode?.binding === binding ? storedLinkCode : null;
  const committed = useRef<typeof binding | null>(null);
  const refreshSequence = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const linkVersion = useRef(0);
  const [actionBusy, setActionBusy] = useState(false);
  const isCurrent = () =>
    committed.current === binding &&
    Boolean(binding.ownerKey && binding.spaceId) &&
    selectedSpaceId() === binding.selection &&
    currentSpaceSelectionGeneration() === binding.generation &&
    window.location.origin === binding.origin;
  const rpc = useMemo(
    () =>
      createSpaceRpc(
        spaceId,
        () =>
          committed.current === binding &&
          selectedSpaceId() === binding.selection &&
          currentSpaceSelectionGeneration() === binding.generation &&
          window.location.origin === binding.origin,
      ),
    [binding, spaceId],
  );
  useLayoutEffect(() => {
    committed.current = binding;
    return () => {
      if (committed.current === binding) committed.current = null;
      const controller = actionController.current;
      actionController.current = null;
      controller?.abort();
    };
  }, [binding]);

  async function refresh(signal?: AbortSignal) {
    if (!isCurrent()) return;
    const request = ++refreshSequence.current;
    const [nextStatus, nextChannels, nextConnections, nextBots, navigation] = await Promise.all([
      rpc.messaging.status(undefined, { signal }),
      rpc.messaging.channels.list(undefined, { signal }),
      rpc.messaging.connections.list(undefined, { signal }),
      rpc.bots.list(undefined, { signal }),
      rpc.spaces.list(undefined, { signal }),
    ]);
    if (
      !isCurrent() ||
      signal?.aborted ||
      request !== refreshSequence.current ||
      navigation.current.id !== spaceId
    )
      return;
    setLoaded({
      binding,
      status: nextStatus,
      channels: nextChannels,
      connections: nextConnections,
      bots: nextBots,
      externalConversations: navigation.current.externalConversations,
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    setLinkCode(null);
    setLinkBotId("");
    setActionBusy(false);
    setError(null);
    void refresh(controller.signal).catch(() => {
      if (isCurrent() && !controller.signal.aborted) setError(t`Couldn't load messaging settings`);
    });
    return () => controller.abort();
  }, [binding]);

  useEffect(() => {
    if (!linkCode) return;
    const controller = new AbortController();
    pollController.current = controller;
    const version = linkVersion.current;
    let timer: number | undefined;
    const expiresAt = Date.parse(linkCode.expiresAt);
    const current = () =>
      isCurrent() && !controller.signal.aborted && version === linkVersion.current;
    const expire = () => {
      if (!current()) return;
      setLinkCode(null);
      setPollError(false);
      setError(t`Link code expired. Try again.`);
    };
    const deadline = window.setTimeout(
      () => {
        expire();
        controller.abort();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    async function poll() {
      if (!current()) return;
      if (Date.now() >= expiresAt) {
        expire();
        return;
      }
      try {
        const next = await rpc.messaging.status(undefined, { signal: controller.signal });
        if (!current() || Date.now() >= expiresAt) return;
        if (
          next.identities.some(
            (identity) =>
              identity.botId === linkCode!.botId && !linkCode!.identityIds.includes(identity.id),
          )
        ) {
          await refresh(controller.signal);
          if (current()) {
            setLinkCode(null);
            setPollError(false);
          }
          return;
        }
        setPollError(false);
      } catch {
        if (current()) setPollError(true);
      }
      if (current()) timer = window.setTimeout(() => void poll(), 3000);
    }
    timer = window.setTimeout(() => void poll(), 3000);
    return () => {
      controller.abort();
      if (pollController.current === controller) pollController.current = null;
      window.clearTimeout(timer);
      window.clearTimeout(deadline);
    };
  }, [linkCode, pollRevision, binding]);

  async function act(action: () => Promise<unknown>) {
    if (!isCurrent() || actionController.current) return;
    const controller = new AbortController();
    actionController.current = controller;
    linkVersion.current += 1;
    pollController.current?.abort();
    setActionBusy(true);
    setError(null);
    // A displayed code must always match the current selection and link
    // state; the link action re-sets it after issuing.
    setLinkCode(null);
    try {
      await action();
      if (isCurrent() && !controller.signal.aborted) await refresh(controller.signal);
    } catch {
      if (isCurrent() && !controller.signal.aborted)
        setError(t`Couldn't update messaging settings`);
    } finally {
      if (actionController.current === controller) {
        actionController.current = null;
        if (isCurrent()) setActionBusy(false);
      }
    }
  }

  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  function channelMeta(channel: MessagingChannelMembership): string {
    return [
      providerLabel(channel.provider),
      // Only meaningful once a second chat app is linked: the same group can
      // then hold two of the caller's memberships, one per agent.
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
      channel.status,
      String(channel.memberCount),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="messaging-settings"
        showCloseButton={false}
        className="rk-scroll block max-h-[calc(100%-2rem)] w-[640px] overflow-y-auto rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <DialogTitle className="text-2xl font-medium text-foreground">
            <Trans>Messaging</Trans>
          </DialogTitle>
          <DialogClose
            aria-label={t`Close messaging settings`}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>

        {error ? <p className="mt-4 text-[13px] text-destructive">{error}</p> : null}

        <section className="mt-8 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Chat apps</Trans>
          </h3>
          {status ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              {status.providers.map(providerLabel).join(" · ")}
            </p>
          ) : null}
          {status?.identities.length ? (
            <ul className="mt-3 space-y-3">
              {status.identities.map((identity) => (
                <li
                  key={identity.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-foreground/75"
                >
                  <span>
                    {providerLabel(identity.provider)} · {identity.address}{" "}
                    <span className="text-[12px] text-muted-foreground/70">
                      → {identity.botName}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    className="rounded-full"
                    onClick={() =>
                      void act(() => rpc.messaging.identities.unlink({ identityId: identity.id }))
                    }
                  >
                    <Trans>Unlink</Trans>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[14px] text-foreground/75">
              <Trans>No chat apps linked yet.</Trans>
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label={t`Bot to link`}
              value={linkBotId}
              onChange={(event) => {
                linkVersion.current += 1;
                actionController.current?.abort();
                pollController.current?.abort();
                setLinkBotId(event.target.value);
                setLinkCode(null);
              }}
            >
              <NativeSelectOption value="">{t`Choose a bot…`}</NativeSelectOption>
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              className="rounded-full"
              disabled={!linkBotId || !status || actionBusy}
              onClick={() =>
                void act(async () => {
                  const version = linkVersion.current;
                  const issued = await rpc.messaging.link.start(
                    { botId: linkBotId },
                    { signal: actionController.current?.signal },
                  );
                  if (
                    isCurrent() &&
                    version === linkVersion.current &&
                    !actionController.current?.signal.aborted
                  ) {
                    setPollError(false);
                    setLinkCode({
                      ...issued,
                      binding,
                      botId: linkBotId,
                      identityIds:
                        status?.identities
                          .filter((identity) => identity.botId === linkBotId)
                          .map((identity) => identity.id) ?? [],
                    });
                  }
                })
              }
            >
              <Trans>Link a chat app</Trans>
            </Button>
          </div>
          {linkCode ? (
            <p className="mt-3 text-[14px] text-foreground/75" data-testid="messaging-link-code">
              <Trans>
                Send <span className="font-mono text-foreground">{linkCode.code}</span> to the line
                from your chat app within 10 minutes. You'll get a confirmation reply once linked.
              </Trans>
            </p>
          ) : null}
          {linkCode && pollError ? (
            <div role="status" className="mt-2 text-[13px] text-muted-foreground">
              <Trans>Could not check the connection.</Trans>{" "}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPollRevision((value) => value + 1)}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Channels</Trans>
          </h3>
          {channels.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>No group chats yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {channels.map((channel) => (
                <li
                  key={channel.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-foreground/75"
                >
                  <span>
                    {channel.name ?? t`Group`}{" "}
                    <span className="text-[12px] text-muted-foreground/70">
                      {channelMeta(channel)}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {channel.status === "invited" ? (
                      <>
                        <Button
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.channels.respond({
                                membershipId: channel.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          <Trans>Approve</Trans>
                        </Button>
                        <Button
                          variant="secondary"
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.channels.respond({
                                membershipId: channel.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          <Trans>Decline</Trans>
                        </Button>
                      </>
                    ) : null}
                    {channel.status === "approved" ? (
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        onClick={() =>
                          void act(() => rpc.messaging.channels.leave({ membershipId: channel.id }))
                        }
                      >
                        <Trans>Leave</Trans>
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Agent connections</Trans>
          </h3>
          {connections.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>No agent connections yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-foreground/75"
                >
                  <span>
                    {connection.peerOwnerLabel}
                    {"'s "}
                    {connection.peerBotName}{" "}
                    <span className="text-[12px] text-muted-foreground/70">
                      {connection.status}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {connection.status === "pending" && connection.incoming ? (
                      <>
                        <Button
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.connections.respond({
                                connectionId: connection.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          <Trans>Approve</Trans>
                        </Button>
                        <Button
                          variant="secondary"
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.connections.respond({
                                connectionId: connection.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          <Trans>Decline</Trans>
                        </Button>
                      </>
                    ) : null}
                    {connection.status === "approved" ? (
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        onClick={() =>
                          void act(() =>
                            rpc.messaging.connections.revoke({ connectionId: connection.id }),
                          )
                        }
                      >
                        <Trans>Revoke</Trans>
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Team conversations</Trans>
          </h3>
          {externalConversations.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>No team conversations yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {externalConversations.map((conversation) => {
                const bot = bots.find((candidate) => candidate.id === conversation.botId);
                const open = settingsConversationId === conversation.id;
                return (
                  <li key={conversation.id} className="text-[14px] text-foreground/75">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {conversation.displayName || t`External conversation`}
                        <span className="ml-2 text-[12px] text-muted-foreground/70">
                          {providerLabel(conversation.provider)}
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        onClick={() => setSettingsConversationId(open ? null : conversation.id)}
                      >
                        {open ? <Trans>Close</Trans> : <Trans>Settings</Trans>}
                      </Button>
                    </div>
                    {open && bot ? (
                      <div className="mt-4 rounded-lg border border-border px-3 py-3">
                        <ExternalConversationSettings
                          conversation={conversation}
                          bot={bot}
                          onSave={async (policy) => {
                            await rpc.externalConversations.updatePolicy({
                              externalConversationId: conversation.id,
                              ...policy,
                            });
                            await refresh();
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
