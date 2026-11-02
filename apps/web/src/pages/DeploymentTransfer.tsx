import { Trans, useLingui } from "@lingui/react/macro";
import type {
  DeploymentTransfer,
  DeploymentTransferState,
  DeploymentTransferPage as Page,
} from "@rakazo/core";
import { initialDeploymentTransferState, parseDeploymentTransferPage } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { DeploymentTransferReview } from "../components/DeploymentTransfer";
import { ListboxSelect } from "../components/ListboxSelect";
import {
  createWebDeploymentTransfer,
  rememberTransferAddress,
} from "../lib/deployment-transfer-client";
import {
  currentSpaceSelectionGeneration,
  selectedSpaceId,
  subscribeSelectedSpace,
} from "../lib/rpc";

export function DeploymentTransferPage() {
  const { t } = useLingui();
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname + location.search + location.hash;
  const page = parseDeploymentTransferPage(path);
  const selection = useSyncExternalStore(
    subscribeSelectedSpace,
    currentSpaceSelectionGeneration,
    currentSpaceSelectionGeneration,
  );
  const [state, setState] = useState<DeploymentTransferState>(initialDeploymentTransferState);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [sourceBotId, setSourceBotId] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const manager = useRef<DeploymentTransfer | null>(null);
  const handled = useRef("");
  const side = page?.side;
  const invitation = page && "locator" in page ? `${page.targetOrigin}:${page.locator}` : "";
  const invitationBinding = useRef({ value: "", generation: 0 });
  if (invitation && invitationBinding.current.value !== invitation)
    invitationBinding.current = {
      value: invitation,
      generation: invitationBinding.current.generation + 1,
    };
  const ownNavigation = useRef<string | null>(null);
  const routeBinding = useRef({ path, generation: 0 });
  if (routeBinding.current.path !== path) {
    const owned = ownNavigation.current === path;
    ownNavigation.current = null;
    routeBinding.current = { path, generation: routeBinding.current.generation + (owned ? 0 : 1) };
  }
  const binding = JSON.stringify([
    side,
    selection,
    reload,
    invitationBinding.current.generation,
    routeBinding.current.generation,
  ]);
  const live = useRef({ page, path, navigate, binding });
  live.current = { page, path, navigate, binding };
  const mountedBinding = useRef("");
  const received = useRef(initialDeploymentTransferState);

  useEffect(() => {
    if (!side) return;
    let active = true;
    const valid = () => active && live.current.binding === binding;
    mountedBinding.current = binding;
    received.current = initialDeploymentTransferState;
    setBots([]);
    setSourceBotId("");
    setLoadFailed(false);
    setState({ ...initialDeploymentTransferState });
    const connection = createWebDeploymentTransfer({
      spaceId: selectedSpaceId(),
      side,
      isCurrent: valid,
      changed(next) {
        if (!valid()) return;
        received.current = next;
        setState(next);
        const nextPath = rememberTransferAddress(next);
        if (nextPath && nextPath !== live.current.path) {
          ownNavigation.current = nextPath;
          if (next.request !== "saving") live.current.navigate(nextPath, { replace: true });
        }
      },
    });
    manager.current = connection.manager;
    const initial = live.current.page;
    handled.current = live.current.path;
    if (initial && "transferId" in initial)
      void connection.manager.restore({ transferId: initial.transferId });
    else if (initial && "clientNonce" in initial)
      void connection.manager.restore({ clientNonce: initial.clientNonce, side: initial.side });
    else if (initial && "locator" in initial) {
      void connection.client.bots
        .list()
        .then((list) => {
          if (connection.isCurrent()) setBots(list.map(({ id, name }) => ({ id, name })));
        })
        .catch(() => {
          if (connection.isCurrent()) setLoadFailed(true);
        });
    }
    return () => {
      active = false;
      connection.manager.dispose();
      manager.current = null;
    };
  }, [binding, side]);
  useEffect(() => {
    if (!manager.current || handled.current === path) return;
    handled.current = path;
    const next: Page | null = parseDeploymentTransferPage(path);
    const own = received.current;
    if (next && "transferId" in next) {
      if (own.snapshot?.transferId === next.transferId && own.snapshot.side === next.side) return;
      void manager.current.restore({ transferId: next.transferId });
    } else if (next && "clientNonce" in next) {
      if (
        own.recovery &&
        "clientNonce" in own.recovery &&
        own.recovery.clientNonce === next.clientNonce &&
        own.recovery.side === next.side
      )
        return;
      void manager.current.restore({ clientNonce: next.clientNonce, side: next.side });
    }
  }, [path]);
  if (!page)
    return (
      <main className="p-5">
        <Trans>This transfer link is invalid.</Trans>
      </main>
    );
  const bound = mountedBinding.current === binding;
  const visible = bound ? state : initialDeploymentTransferState;
  const canChoose = "locator" in page && !visible.snapshot && visible.request === "idle";
  return (
    <main
      className="mx-auto min-h-full w-full max-w-xl space-y-5 p-4 sm:p-6"
      data-testid="deployment-transfer-page"
    >
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-medium">
          <Trans>Copy passwords and API keys</Trans>
        </h1>
        <Link className="text-sm underline" to="/app">
          <Trans>Close</Trans>
        </Link>
      </div>
      {canChoose ? (
        <div className="space-y-3">
          <p className="break-all text-sm">{page.targetOrigin}</p>
          <ListboxSelect
            label={t`Source bot`}
            value={bound ? sourceBotId : ""}
            onChange={setSourceBotId}
            options={[
              { value: "", label: t`Choose your source bot` },
              ...(bound ? bots : []).map((bot) => ({ value: bot.id, label: bot.name })),
            ]}
          />
          <Button
            disabled={!bound || !sourceBotId || !manager.current}
            onClick={() =>
              void manager.current?.previewSource(page.targetOrigin, page.locator, sourceBotId)
            }
          >
            <Trans>Review credentials</Trans>
          </Button>
        </div>
      ) : null}
      {bound && loadFailed ? (
        <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
          <Trans>Reload bots</Trans>
        </Button>
      ) : null}
      <DeploymentTransferReview state={visible} manager={bound ? manager.current : null} />
    </main>
  );
}
