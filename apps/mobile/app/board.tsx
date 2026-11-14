import type {
  Bot,
  ListTicketsOutput,
  Ticket,
  TicketComment,
  TicketPriority,
  TicketStatus,
} from "@rakazo/contracts";
import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { ticketDraft, ticketUpdate } from "@rakazo/core";
import { Redirect, Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import type { ApiRequestContext } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { isMobileScopeCurrent } from "../lib/mobile-scope";
import { native } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";
import { useTicketBoardCapability } from "../lib/ticket-board";
import { errorText } from "../lib/user-error";

function useLabels() {
  const { t } = useI18n();
  return {
    statuses: {
      todo: t("To do"),
      doing: t("In progress"),
      review: t("In review"),
      blocked: t("Blocked"),
      done: t("Done"),
      closed: t("Won't do"),
    },
    priorities: { low: t("Low"), normal: t("Normal"), high: t("High"), urgent: t("Urgent") },
  };
}

export default function BoardScreen() {
  const capability = useTicketBoardCapability();
  const { t } = useI18n();
  if (capability.enabled === false) return <Redirect href="/" />;
  if (capability.enabled === true) return <Board key={capability.key} scope={capability.scope} />;
  return (
    <View style={styles.screen}>
      <Stack.Screen options={glassHeaderOptions(t("Board"))} />
      {capability.failed ? (
        <NativeActionButton label={t("Try again.")} onPress={capability.retry} />
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
}

type BoardSession = {
  requestContext: ApiRequestContext;
  signal: AbortSignal;
  current: () => boolean;
};

function Board({ scope }: { scope: MobileScope }) {
  const { t } = useI18n();
  const { statuses } = useLabels();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [session, setSession] = useState<BoardSession>();
  const [selected, setSelected] = useState<Ticket | "new" | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const controller = new AbortController();
      const current = () => active && isMobileScopeCurrent(scope);
      async function load() {
        try {
          const requestContext = await spaceRequestContext(scope, current);
          const options = { requestContext, signal: controller.signal };
          const [result, owners] = await Promise.all([
            rpc<ListTicketsOutput>("tickets/list", {}, options),
            rpc<Bot[]>("bots/list", {}, options),
          ]);
          if (!current()) return;
          const spaceId = requestContext.headers["x-rakazo-space-id"];
          if (
            result.tickets.some((row) => row.spaceId !== spaceId) ||
            owners.some((bot) => bot.spaceId !== spaceId)
          )
            throw new Error(t("Something went wrong. Try again."));
          setTickets(result.tickets);
          setBots(owners);
          setSession({ ...options, current });
          setError("");
        } catch (cause) {
          if (current()) setError(errorText(cause));
        } finally {
          if (current()) timer = setTimeout(() => void load(), 10_000);
        }
      }
      void load();
      return () => {
        active = false;
        clearTimeout(timer);
        controller.abort();
      };
    }, [scope, revision, t]),
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={glassHeaderOptions(t("Board"))} />
      {selected && session ? (
        <TicketEditor
          key={selected === "new" ? "new" : selected.id}
          ticket={selected === "new" ? null : selected}
          bots={bots}
          session={session}
          onClose={() => setSelected(null)}
          onSaved={(ticket) => {
            setTickets((rows) => [ticket, ...rows.filter((row) => row.id !== ticket.id)]);
            setSelected(null);
            setRevision((value) => value + 1);
          }}
        />
      ) : (
        <>
          {!session && !error ? <ActivityIndicator /> : null}
          <NativeActionButton
            label={t("New ticket")}
            disabled={!session || bots.length === 0}
            onPress={() => setSelected("new")}
          />
          {TICKET_STATUSES.map((status) => (
            <SettingsGroup key={status} label={statuses[status]}>
              {tickets
                .filter((ticket) => ticket.status === status)
                .map((ticket) => (
                  <SettingsRow
                    key={ticket.id}
                    title={ticket.title}
                    detail={ticket.ref}
                    value={bots.find((bot) => bot.id === ticket.assigneeBotId)?.name}
                    chevron="right"
                    onPress={() => setSelected(ticket)}
                  />
                ))}
            </SettingsGroup>
          ))}
          {session && tickets.length === 0 ? (
            <Text style={styles.secondary}>{t("No tickets yet")}</Text>
          ) : null}
          <NativeActionButton
            label={t("Refresh")}
            prominence="plain"
            onPress={() => setRevision((value) => value + 1)}
          />
        </>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function TicketEditor({
  ticket,
  bots,
  session,
  onClose,
  onSaved,
}: {
  ticket: Ticket | null;
  bots: Bot[];
  session: BoardSession;
  onClose: () => void;
  onSaved: (ticket: Ticket) => void;
}) {
  const { t } = useI18n();
  const { statuses, priorities } = useLabels();
  const [draft, setDraft] = useState(() => ticketDraft(ticket, bots[0]?.id));
  const [body, setBody] = useState("");
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [error, setError] = useState("");
  const [commentError, setCommentError] = useState("");
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const mounted = useRef(true);
  const commentRead = useRef(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && session.current();
  useEffect(() => {
    if (!ticket) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const read = ++commentRead.current;
      try {
        const rows = await rpc<TicketComment[]>(
          "tickets/comments",
          { ticketId: ticket!.id },
          session,
        );
        if (!active || !session.current() || read !== commentRead.current) return;
        if (rows.some((row) => row.ticketId !== ticket!.id))
          throw new Error(t("Something went wrong. Try again."));
        setComments(rows);
        setCommentError("");
      } catch (cause) {
        if (active && session.current() && read === commentRead.current)
          setCommentError(errorText(cause));
      } finally {
        if (active && session.current()) timer = setTimeout(() => void load(), 10_000);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ticket, session, revision, t]);

  async function save(comment = false) {
    if (!current() || writing.current) return;
    if (comment ? !ticket || !body.trim() : !draft.title.trim() || !draft.assigneeBotId) return;
    writing.current = true;
    setBusy(true);
    setError("");
    try {
      if (comment && ticket) {
        const row = await rpc<TicketComment>(
          "tickets/comment",
          { ticketId: ticket.id, body },
          session,
        );
        if (!current()) return;
        if (row.ticketId !== ticket.id) throw new Error(t("Something went wrong. Try again."));
        commentRead.current += 1;
        setComments((rows) => [...rows.filter((item) => item.id !== row.id), row]);
        setBody("");
        setRevision((value) => value + 1);
      } else {
        const { status: _status, ...create } = draft;
        const row = ticket
          ? await rpc<Ticket>("tickets/update", ticketUpdate(ticket, draft, bots[0]?.id), session)
          : await rpc<Ticket>("tickets/create", create, session);
        if (!current()) return;
        if (
          row.spaceId !== session.requestContext.headers["x-rakazo-space-id"] ||
          (ticket && row.id !== ticket.id)
        )
          throw new Error(t("Something went wrong. Try again."));
        onSaved(row);
      }
    } catch (cause) {
      if (current()) setError(errorText(cause));
    } finally {
      writing.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <View style={styles.editor}>
      <NativeActionButton
        label={t("Cancel")}
        prominence="plain"
        disabled={busy}
        onPress={onClose}
      />
      <TextInput
        accessibilityLabel={t("Title")}
        placeholder={t("Title")}
        placeholderTextColor={native.secondaryLabel}
        style={styles.input}
        value={draft.title}
        maxLength={TICKET_TITLE_MAX_LENGTH}
        editable={!busy}
        onChangeText={(title) => setDraft((value) => ({ ...value, title }))}
      />
      <TextInput
        accessibilityLabel={t("Description")}
        placeholder={t("Description")}
        placeholderTextColor={native.secondaryLabel}
        style={styles.input}
        value={draft.description}
        maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
        multiline
        editable={!busy}
        onChangeText={(description) => setDraft((value) => ({ ...value, description }))}
      />
      <SettingsGroup>
        <MenuPicker
          label={t("Owner")}
          value={draft.assigneeBotId}
          disabled={busy}
          choices={bots.map((bot) => ({ key: bot.id, label: bot.name }))}
          onChange={(assigneeBotId) => setDraft((value) => ({ ...value, assigneeBotId }))}
        />
        <MenuPicker
          label={t("Priority")}
          value={draft.priority}
          disabled={busy}
          choices={TICKET_PRIORITIES.map((key) => ({ key, label: priorities[key] }))}
          onChange={(priority) =>
            setDraft((value) => ({ ...value, priority: priority as TicketPriority }))
          }
        />
        {ticket ? (
          <MenuPicker
            label={t("Status")}
            value={draft.status}
            disabled={busy}
            choices={TICKET_STATUSES.map((key) => ({ key, label: statuses[key] }))}
            onChange={(status) =>
              setDraft((value) => ({ ...value, status: status as TicketStatus }))
            }
          />
        ) : null}
      </SettingsGroup>
      <NativeActionButton
        label={ticket ? t("Save") : t("Create")}
        disabled={busy || !draft.title.trim() || !draft.assigneeBotId}
        onPress={() => void save()}
      />
      {ticket ? (
        <>
          <SettingsGroup label={t("Comments")}>
            {comments.map((row) => (
              <SettingsRow key={row.id} title={row.body} detail={row.authorName ?? undefined} />
            ))}
          </SettingsGroup>
          {commentError ? (
            <>
              <Text accessibilityRole="alert" style={styles.secondary}>
                {commentError}
              </Text>
              <NativeActionButton
                label={t("Refresh")}
                prominence="plain"
                onPress={() => setRevision((value) => value + 1)}
              />
            </>
          ) : null}
          <TextInput
            accessibilityLabel={t("Comment")}
            placeholder={t("Comment")}
            placeholderTextColor={native.secondaryLabel}
            value={body}
            onChangeText={setBody}
            maxLength={TICKET_COMMENT_MAX_LENGTH}
            multiline
            editable={!busy}
            style={styles.input}
          />
          <NativeActionButton
            label={t("Comment")}
            disabled={busy || !body.trim()}
            onPress={() => void save(true)}
          />
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: native.groupedPage },
  content: { padding: 16, gap: 16 },
  editor: { gap: 12 },
  input: {
    minHeight: 48,
    padding: 12,
    borderRadius: 12,
    color: native.label,
    backgroundColor: native.groupedCell,
    fontSize: 17,
  },
  secondary: { color: native.secondaryLabel, fontSize: 15 },
});
