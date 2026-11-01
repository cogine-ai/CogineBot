import { Trans } from "@lingui/react/macro";
import type { SpaceCollaborationPolicy } from "@rakazo/contracts";
import { SpaceCollaborationPolicySchema } from "@rakazo/contracts";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBoundSpaceId, useSpaceRpc, useSpaceRpcCurrent } from "../lib/space-rpc";

export function SpaceCollaborationSettings({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const client = useSpaceRpc();
  const isCurrent = useSpaceRpcCurrent();
  const spaceId = useBoundSpaceId();
  const id = useId();
  const generation = useRef(0);
  const savePending = useRef(false);
  const [policy, setPolicy] = useState<SpaceCollaborationPolicy | null>(null);
  const [draft, setDraft] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"load" | "save" | "conflict" | "saved" | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);

  const refresh = useCallback(async () => {
    if (!isCurrent()) return;
    const request = ++generation.current;
    setLoading(true);
    setNotice(null);
    try {
      const navigation = await client.spaces.list();
      if (!isCurrent() || request !== generation.current) return;
      const target = navigation.spaces.find((space) => space.id === spaceId);
      const parsed = SpaceCollaborationPolicySchema.safeParse(
        target ? { ...target, spaceId: target.id } : null,
      );
      if (!parsed.success) throw new Error("Incomplete collaboration policy");
      setPolicy(parsed.data);
      setDraft((intent) => intent ?? parsed.data.allowBotCollaboration);
      setNeedsRefresh(false);
    } catch {
      if (isCurrent() && request === generation.current) setNotice("load");
    } finally {
      if (isCurrent() && request === generation.current) setLoading(false);
    }
  }, [client, isCurrent, spaceId]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function save() {
    if (
      !policy?.canManageCollaboration ||
      loading ||
      savePending.current ||
      needsRefresh ||
      draft === undefined ||
      draft === policy.allowBotCollaboration ||
      !isCurrent()
    )
      return;
    savePending.current = true;
    const request = ++generation.current;
    const intended = draft;
    setSaving(true);
    onBusyChange?.(true);
    setNotice(null);
    try {
      const receipt = await client.spaces.update({
        spaceId: policy.spaceId,
        allowBotCollaboration: intended,
        expectedCollaborationRevision: policy.collaborationRevision,
      });
      if (!isCurrent() || request !== generation.current) return;
      const parsed = SpaceCollaborationPolicySchema.safeParse(receipt);
      if (
        !parsed.success ||
        parsed.data.spaceId !== policy.spaceId ||
        parsed.data.allowBotCollaboration !== intended ||
        parsed.data.collaborationRevision <= policy.collaborationRevision
      )
        throw new Error("Unconfirmed collaboration update");
      setPolicy(parsed.data);
      setDraft(parsed.data.allowBotCollaboration);
      setNotice("saved");
    } catch (error) {
      if (!isCurrent() || request !== generation.current) return;
      const conflict =
        error &&
        typeof error === "object" &&
        (("code" in error && error.code === "CONFLICT") ||
          ("status" in error && error.status === 409));
      setNotice(conflict ? "conflict" : "save");
      setNeedsRefresh(true);
    } finally {
      savePending.current = false;
      if (isCurrent() && request === generation.current) {
        setSaving(false);
        onBusyChange?.(false);
      }
    }
  }

  return (
    <section className="space-y-4" data-testid="space-collaboration-settings">
      {loading ? (
        <p>
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {!loading && policy ? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <Label htmlFor={id}>
                <Trans>Bot collaboration</Trans>
              </Label>
              <p className="text-[13.5px] text-muted-foreground">
                <Trans>
                  Allow Bots to message and assign work to other Bots and connected agents.
                </Trans>
              </p>
            </div>
            <Switch
              id={id}
              className="mt-0.5"
              checked={
                policy.canManageCollaboration
                  ? (draft ?? policy.allowBotCollaboration)
                  : policy.allowBotCollaboration
              }
              disabled={!policy.canManageCollaboration || saving || needsRefresh}
              onCheckedChange={(next) => {
                setDraft(next);
                setNotice(null);
              }}
            />
          </div>
          {!policy.canManageCollaboration ? (
            <p className="text-[13px] text-muted-foreground">
              <Trans>Only the Space owner can change this.</Trans>
            </p>
          ) : null}
          {policy.canManageCollaboration && policy.allowBotCollaboration && draft === false ? (
            <p className="text-[13px] text-muted-foreground">
              <Trans>Work already running may finish.</Trans>
            </p>
          ) : null}
          {policy.canManageCollaboration ? (
            <Button
              onClick={() => void save()}
              disabled={saving || needsRefresh || draft === policy.allowBotCollaboration}
            >
              {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          ) : null}
        </>
      ) : null}
      {!loading && notice === "load" ? (
        <p role="alert">
          <Trans>Could not load this setting.</Trans>
        </p>
      ) : null}
      {notice === "save" ? (
        <p role="alert">
          <Trans>Could not confirm this change. Refresh before saving.</Trans>
        </p>
      ) : null}
      {notice === "conflict" ? (
        <p role="alert">
          <Trans>This setting changed elsewhere. Refresh before saving.</Trans>
        </p>
      ) : null}
      {notice === "saved" ? (
        <p role="status">
          <Trans>Saved.</Trans>
        </p>
      ) : null}
      {!loading && (notice === "load" || needsRefresh) ? (
        <Button variant="outline" onClick={() => void refresh()}>
          <Trans>Refresh</Trans>
        </Button>
      ) : null}
    </section>
  );
}
