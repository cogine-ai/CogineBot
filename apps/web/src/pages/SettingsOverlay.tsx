import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import {
  Brain,
  CloudDownload,
  Cpu,
  CreditCard,
  Gauge,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  XIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { ListboxSelect } from "../components/ListboxSelect";
import { createSpaceRpc } from "../lib/rpc";
import { SpaceRpcProvider, useSpaceRpc, useSpaceRpcCurrent } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UpdatesSettingsPanel,
  UsageSettingsPanel,
} from "./AccountSettingsOverlay";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

export type SettingsSection =
  | "general"
  | "models"
  | "memory"
  | "voice"
  | "confirmations"
  | "usage"
  | "computer"
  | "billing"
  | "updates";

type NavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

export function SettingsOverlay({
  space,
  spaces = [],
  currentSpaceId,
  onSpaceChange,
  ownerKey,
  email,
  name,
  timezone,
  onTimezoneChange,
  usage,
  onUsageOpen,
  initialSection = "general",
  onSectionChange,
  isDeploymentOwner = false,
  billingEnabled = false,
  sandboxProvider,
  onSandboxProviderChange,
  messagingEnabled = false,
  onOpenMessaging,
  memoryConfig,
  onMemoryConfigChange,
  onClose,
  onVoiceStatusMaybeChanged,
}: {
  space?: { id: string; name: string } | null;
  spaces?: { id: string; name: string }[];
  currentSpaceId?: string | null;
  onSpaceChange?: (spaceId: string) => void;
  ownerKey?: string;
  email?: string | null;
  name: string;
  timezone?: string | null;
  onTimezoneChange?: (timezone: string) => Promise<void>;
  usage?: {
    runs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
  } | null;
  onUsageOpen: () => void;
  initialSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  isDeploymentOwner?: boolean;
  billingEnabled?: boolean;
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  onMemoryConfigChange: (config: SpaceMemoryConfig | null) => void;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  useLayoutEffect(() => onSectionChange?.(section), [section, onSectionChange]);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputer =
    keepComputerRecovery || (isDeploymentOwner && computersAreUnavailable(sandboxProvider));
  const targetBinding = useMemo(() => ({ spaceId: space?.id, ownerKey }), [space?.id, ownerKey]);
  const committedTarget = useRef<typeof targetBinding | null>(null);
  const leaveRevision = useRef(0);
  useLayoutEffect(() => {
    committedTarget.current = targetBinding;
    leaveRevision.current++;
    setMemoryBusy(false);
    setVoiceBusy(false);
    return () => {
      if (committedTarget.current === targetBinding) committedTarget.current = null;
      leaveRevision.current++;
    };
  }, [targetBinding]);
  const targetCurrent = useCallback(
    () => committedTarget.current === targetBinding,
    [targetBinding],
  );
  const billingClient = useMemo(
    () => createSpaceRpc(space?.id ?? null, targetCurrent),
    [space?.id, targetCurrent],
  );
  const handleMemoryBusy = useCallback(
    (busy: boolean) => {
      if (targetCurrent()) setMemoryBusy(busy);
    },
    [targetCurrent],
  );
  const handleVoiceBusy = useCallback(
    (busy: boolean) => {
      if (targetCurrent()) setVoiceBusy(busy);
    },
    [targetCurrent],
  );
  const panelBusy = memoryBusy || voiceBusy;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (!showComputer && section === "computer") setSection("general");
  }, [showComputer, section]);

  useEffect(() => {
    if (!billingEnabled && section === "billing") setSection("general");
  }, [billingEnabled, section]);

  useEffect(() => {
    if (section !== "computer") releaseComputerRecovery();
  }, [section, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);

  useEffect(() => {
    if (section === "usage") {
      onUsageOpen();
      usageRef.current?.focus();
    }
  }, [section, onUsageOpen]);

  const navItems: NavItem[] = [
    { id: "general", label: t`General`, icon: Settings },
    { id: "models", label: t`Models`, icon: Cpu },
    { id: "memory", label: t`Memory`, icon: Brain },
    { id: "voice", label: t`Voice`, icon: Volume2 },
    { id: "confirmations", label: t`Confirmations`, icon: ShieldCheck },
    { id: "usage", label: t`Usage`, icon: Gauge },
    ...(showComputer ? [{ id: "computer" as const, label: t`Computer`, icon: Monitor }] : []),
    ...(billingEnabled ? [{ id: "billing" as const, label: t`Billing`, icon: CreditCard }] : []),
    { id: "updates", label: t`Updates`, icon: CloudDownload },
  ];

  const sectionTitle =
    navItems.find((item) => item.id === section)?.label ??
    (section === "general" ? t`General` : t`Settings`);

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "memory"
        ? t`Close memory settings`
        : section === "voice"
          ? t`Close voice settings`
          : t`Close user settings`;

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    const revision = ++leaveRevision.current;
    void refreshVoiceStatus()
      .catch(() => undefined)
      .then(() => {
        if (targetCurrent() && revision === leaveRevision.current) next();
      });
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  const widePane = section === "models" || section === "voice";

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className={`flex max-h-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] ${
          widePane
            ? "h-[min(760px,calc(100%-2rem))] w-[min(1080px,calc(100%-2rem))] sm:max-w-[1080px]"
            : "h-[min(720px,calc(100%-2rem))] w-[min(920px,calc(100%-2rem))] sm:max-w-[920px]"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            data-testid="settings-nav"
            aria-label={t`Settings`}
            className="flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-border px-3 py-3 md:w-[200px] md:flex-col md:overflow-y-auto md:border-b-0 md:border-e md:px-3 md:py-4"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.id === section;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  aria-current={active ? "page" : undefined}
                  disabled={panelBusy}
                  onClick={() => {
                    leaveRevision.current++;
                    setSection(item.id);
                  }}
                  className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-6 sm:px-8 sm:pt-7">
              <DialogTitle className="text-2xl font-medium text-foreground">
                {sectionTitle}
              </DialogTitle>
              <div className="flex items-center gap-3">
                {SPACE_SECTIONS.has(section) && space && spaces.length > 0 ? (
                  <ListboxSelect
                    options={spaces.map((entry) => ({ value: entry.id, label: entry.name }))}
                    value={space.id}
                    label={t`Space`}
                    testId="settings-space"
                    disabled={panelBusy}
                    className="w-40"
                    onChange={(id) => {
                      if (!panelBusy && targetCurrent()) {
                        leaveRevision.current++;
                        onSpaceChange?.(id);
                      }
                    }}
                  />
                ) : null}
                <DialogClose
                  aria-label={closeLabel}
                  disabled={panelBusy}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <XIcon />
                </DialogClose>
              </div>
            </div>

            <div
              className={`min-h-0 flex-1 ${
                section === "models" || section === "voice" || section === "memory"
                  ? "flex flex-col overflow-hidden"
                  : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-5 sm:px-8 sm:pb-8"
              }`}
            >
              {section === "general" ? (
                <GeneralSettingsPanels
                  key={ownerKey}
                  email={email}
                  name={name}
                  timezone={timezone}
                  onTimezoneChange={onTimezoneChange}
                  messagingEnabled={messagingEnabled}
                  onOpenMessaging={
                    onOpenMessaging ? () => leaveSettings(onOpenMessaging) : undefined
                  }
                  isDeploymentOwner={isDeploymentOwner}
                />
              ) : null}
              {section === "usage" ? (
                <UsageSettingsPanel usage={usage} panelRef={usageRef} />
              ) : null}
              {section === "computer" && showComputer ? (
                <ComputerSettingsPanel
                  sandboxProvider={sandboxProvider}
                  onSandboxProviderChange={(next) => {
                    onSandboxProviderChange?.(next);
                    holdComputerRecovery();
                  }}
                  onRecoveryDismissed={releaseComputerRecovery}
                />
              ) : null}
              {section === "billing" && billingEnabled ? (
                <BillingSettingsPanel
                  key={`${ownerKey}:${space?.id}`}
                  client={billingClient}
                  isCurrent={targetCurrent}
                />
              ) : null}
              {section === "updates" ? (
                <UpdatesSettingsPanel isDeploymentOwner={isDeploymentOwner} />
              ) : null}
              <SpaceRpcProvider
                key={`${ownerKey ?? ""}/${space?.id ?? "default"}`}
                spaceId={space?.id}
                ownerKey={ownerKey}
              >
                {!SPACE_SECTIONS.has(section) || space || !onSpaceChange ? (
                  <>
                    {section === "models" ? (
                      <ModelSettingsOverlay embedded onClose={requestClose} />
                    ) : null}
                    {section === "memory" ? (
                      <TargetMemorySettings
                        initialConfig={
                          space?.id === currentSpaceId || !onSpaceChange ? memoryConfig : undefined
                        }
                        onConfigChange={(config) => {
                          if (targetCurrent() && (!onSpaceChange || space?.id === currentSpaceId))
                            onMemoryConfigChange(config);
                        }}
                        onClose={requestClose}
                        onBusyChange={handleMemoryBusy}
                      />
                    ) : null}
                    {section === "voice" ? (
                      <VoiceSettingsOverlay
                        embedded
                        onClose={requestClose}
                        onBusyChange={handleVoiceBusy}
                      />
                    ) : null}
                    {section === "confirmations" ? <ApprovalRulesSettings /> : null}
                  </>
                ) : (
                  <p>
                    <Trans>Loading…</Trans>
                  </p>
                )}
              </SpaceRpcProvider>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SPACE_SECTIONS = new Set<SettingsSection>(["models", "memory", "voice", "confirmations"]);
function TargetMemorySettings({
  initialConfig,
  onConfigChange,
  onClose,
  onBusyChange,
}: {
  initialConfig: SpaceMemoryConfig | null | undefined;
  onConfigChange: (config: SpaceMemoryConfig | null) => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const current = useSpaceRpcCurrent();
  const [config, setConfig] = useState(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  async function refresh() {
    const revision = ++request.current;
    try {
      const next = await rpc.memory.providerConfig();
      if (current() && revision === request.current) {
        setConfig(next);
        setError(null);
      }
    } catch (error) {
      if (current() && revision === request.current) setError(errorText(error, t`Could not load`));
    }
  }
  useEffect(() => {
    if (initialConfig === undefined) void refresh();
    return () => {
      request.current++;
    };
  }, [rpc]);
  return (
    <>
      {error ? (
        <div className="px-6 pt-4">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" onClick={() => void refresh()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {config !== undefined ? (
        <MemorySettingsOverlay
          embedded
          config={config}
          onClose={onClose}
          onBusyChange={onBusyChange}
          onConfigChange={(next) => {
            if (current()) {
              setConfig(next);
              onConfigChange(next);
            }
          }}
        />
      ) : !error ? (
        <p>
          <Trans>Loading…</Trans>
        </p>
      ) : null}
    </>
  );
}
