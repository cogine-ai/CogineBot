import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo, VoiceStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBoundSpaceId, useSpaceRpc, useSpaceRpcCurrent } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

type VoiceSettingsProps = {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

export function VoiceSettingsOverlay(props: VoiceSettingsProps) {
  const spaceId = useBoundSpaceId();
  return <VoiceSettingsForm key={spaceId ?? "selected"} {...props} />;
}

function VoiceSettingsForm({ onClose, embedded = false, onBusyChange }: VoiceSettingsProps) {
  const rpc = useSpaceRpc();
  const spaceId = useBoundSpaceId();
  const scopeCurrent = useSpaceRpcCurrent();
  const binding = useMemo(() => ({ controller: new AbortController() }), [rpc, scopeCurrent]);
  const committed = useRef<typeof binding | null>(null);
  const pendingRef = useRef<string | null>(null);
  const refreshGeneration = useRef(0);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const current = () =>
    committed.current === binding && scopeCurrent() && !binding.controller.signal.aborted;
  const requestOptions = () => ({ signal: binding.controller.signal });
  const { t } = useLingui();
  const apiKeyId = useId();
  const voiceSelectId = useId();
  const speechModelId = useId();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [speechModel, setSpeechModel] = useState("");
  const speechModelSave = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "disconnect" | "voice" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const busy = pending !== null;

  useLayoutEffect(() => {
    if (binding.controller.signal.aborted) binding.controller = new AbortController();
    committed.current = binding;
    return () => {
      if (committed.current === binding) committed.current = null;
      refreshGeneration.current += 1;
      binding.controller.abort();
      onBusyChangeRef.current?.(false);
    };
  }, [binding]);

  function markPending(next: "connect" | "disconnect" | "voice" | "test" | null) {
    if (!current()) return;
    pendingRef.current = next;
    setPending(next);
    onBusyChangeRef.current?.(next !== null);
  }

  async function refresh(nextProvider?: string): Promise<boolean> {
    const generation = ++refreshGeneration.current;
    const live = () => current() && generation === refreshGeneration.current;
    try {
      const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
        rpc.voice.catalog({}, requestOptions()),
        rpc.voice.credentials({}, requestOptions()),
        rpc.voice.status({}, requestOptions()),
      ]);
      if (!live()) return false;
      const selected = nextProvider || provider || nextStatus.provider || nextCatalog[0]?.id || "";
      const cred = nextCredentials.find((entry) => entry.provider === selected);
      const listed = cred ? await rpc.voice.voices({ provider: selected }, requestOptions()) : [];
      if (!live()) return false;
      setCatalog(nextCatalog);
      setCredentials(nextCredentials);
      setStatus(nextStatus);
      setProvider(selected);
      setVoiceId(cred?.voiceId || listed[0]?.id || "");
      setSpeechModel(cred?.speechModel ?? "");
      setVoices(listed);
      setLoadFailed(false);
      return true;
    } catch (error) {
      if (live()) {
        setError(errorText(error, t`Could not load voice settings`));
        setLoadFailed(true);
      }
      return false;
    }
  }

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => {
      if (current()) setLoading(false);
    });
  }, [binding]);

  async function retryLoad(nextProvider?: string) {
    if (!current() || pendingRef.current !== null) return;
    setError(null);
    setNotice(null);
    setApiKey("");
    markPending("voice");
    try {
      await refresh(nextProvider);
    } finally {
      markPending(null);
    }
  }

  const selected = catalog.find((entry) => entry.id === provider) ?? catalog[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const voiceOptions = useMemo(
    () => (voices.length ? voices : voiceId ? [{ id: voiceId, label: voiceId }] : []),
    [voices, voiceId],
  );

  async function connectKey() {
    if (!current() || pendingRef.current !== null || !selected || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    markPending("connect");
    try {
      await rpc.voice.connect(
        {
          provider: selected.id,
          apiKey: apiKey.trim(),
          voiceId: voiceId || undefined,
          ...(selected.id === "fish-audio" ? { speechModel: speechModel.trim() } : {}),
        },
        requestOptions(),
      );
      if (!current()) return;
      setApiKey("");
      if (!(await refresh(selected.id)) || !current()) return;
      setNotice(t`Connected ${selected.name}.`);
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t`Could not connect this voice provider`));
    } finally {
      markPending(null);
    }
  }

  async function disconnectProvider() {
    if (!current() || pendingRef.current !== null || !credential) return;
    setError(null);
    setNotice(null);
    markPending("disconnect");
    try {
      await rpc.voice.disconnect({ provider: credential.provider }, requestOptions());
      if (!current()) return;
      setApiKey("");
      await refresh(credential.provider);
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t`Could not disconnect this voice provider`));
    } finally {
      markPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    if (!current() || pendingRef.current !== null) return;
    setVoiceId(nextVoiceId);
    if (!credential) return;
    markPending("voice");
    setError(null);
    try {
      await rpc.voice.setVoice({ voiceId: nextVoiceId, provider: selected?.id }, requestOptions());
      if (!current()) return;
      await refresh(selected?.id);
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t`Could not save that voice`));
    } finally {
      markPending(null);
    }
  }

  async function saveSpeechModel() {
    if (!current() || pendingRef.current !== null || !credential || selected?.id !== "fish-audio")
      return;
    const next = speechModel.trim();
    if (next === credential.speechModel) return;
    if (speechModelSave.current === next) return;
    speechModelSave.current = next;
    setError(null);
    markPending("voice");
    try {
      const saved = await rpc.voice.setSpeechModel(
        { provider: selected.id, speechModel: next },
        requestOptions(),
      );
      if (!current()) return;
      setSpeechModel(saved.speechModel);
      setCredentials((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)));
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t`Could not save that speech model`));
    } finally {
      speechModelSave.current = null;
      markPending(null);
    }
  }

  async function testVoice() {
    if (!current() || pendingRef.current !== null) return;
    setError(null);
    setNotice(null);
    markPending("test");
    try {
      const { speaker } = await import("../lib/tts.js");
      if (!current()) return;
      await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`, {
        spaceId,
        signal: binding.controller.signal,
        isCurrent: current,
      });
      if (!current()) return;
      if (speaker.state.error) {
        setError(speaker.state.error);
        return;
      }
      setNotice(t`If you heard that, voice is ready.`);
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t`Could not play a test clip`));
    } finally {
      markPending(null);
    }
  }

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl font-medium text-foreground">
              <Trans>Voice</Trans>
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close voice settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
        <div className="flex min-h-0 shrink-0 flex-col md:w-[280px]">
          <div className="mb-3 text-[13.5px] text-muted-foreground">
            <Trans>Providers</Trans>
          </div>
          <div className="rk-scroll overflow-y-auto rounded-xl border border-border">
            {catalog.map((entry) => {
              const connected = credentials.some((cred) => cred.provider === entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void retryLoad(entry.id)}
                  className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start transition-colors last:border-0 disabled:pointer-events-none disabled:opacity-50 ${
                    entry.id === provider ? "bg-muted" : "hover:bg-accent"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">{entry.name}</span>
                    <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                      {entry.transcribe ? (
                        <Trans>Speak + transcribe</Trans>
                      ) : (
                        <Trans>Speak only</Trans>
                      )}
                    </span>
                  </span>
                  {connected ? (
                    <span className="text-[12px] text-success">
                      <Trans>Connected</Trans>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Loading voice providers…</Trans>
            </p>
          ) : null}
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
          {loadFailed ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void retryLoad()}
            >
              <Trans>Retry</Trans>
            </Button>
          ) : null}
          {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
          {selected ? (
            <>
              <Field className="mt-5">
                <FieldLabel htmlFor={apiKeyId}>
                  <Trans>API key</Trans>
                </FieldLabel>
                <Input
                  id={apiKeyId}
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={credential ? t`Paste a replacement key` : t`Paste your API key`}
                />
              </Field>
              <Button
                type="button"
                className="mt-3"
                disabled={busy || apiKey.trim().length < 8}
                onClick={() => void connectKey()}
              >
                {pending === "connect" ? (
                  <Trans>Connecting…</Trans>
                ) : credential ? (
                  <Trans>Replace key</Trans>
                ) : (
                  <Trans>Connect</Trans>
                )}
              </Button>
              {credential ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => void disconnectProvider()}
                >
                  {pending === "disconnect" ? (
                    <Trans>Disconnecting…</Trans>
                  ) : (
                    <Trans>Disconnect</Trans>
                  )}
                </Button>
              ) : null}

              {credential ? (
                <>
                  <Field className="mt-6">
                    <FieldLabel htmlFor={voiceSelectId}>
                      <Trans>Voice</Trans>
                    </FieldLabel>
                    <NativeSelect
                      id={voiceSelectId}
                      className="w-full"
                      value={voiceId}
                      disabled={busy}
                      onChange={(event) => void chooseVoice(event.target.value)}
                    >
                      {voiceOptions.map((voice) => (
                        <NativeSelectOption key={voice.id} value={voice.id}>
                          {voice.label}
                          {voice.description ? ` · ${voice.description}` : ""}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  {selected.id === "fish-audio" ? (
                    <Field className="mt-6">
                      <FieldLabel htmlFor={speechModelId}>
                        <Trans>Speech model</Trans>
                      </FieldLabel>
                      <Input
                        id={speechModelId}
                        value={speechModel}
                        maxLength={64}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        placeholder={t`Optional`}
                        onChange={(event) => setSpeechModel(event.target.value)}
                        onBlur={() => void saveSpeechModel()}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          event.currentTarget.blur();
                        }}
                      />
                    </Field>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    className="mt-4 rounded-full"
                    disabled={busy || !status?.ready}
                    onClick={() => void testVoice()}
                  >
                    {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="voice-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        data-testid="voice-settings"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[min(680px,calc(100%-2rem))] w-[920px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[min(680px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
