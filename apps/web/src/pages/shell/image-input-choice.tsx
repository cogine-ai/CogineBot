import { useLingui } from "@lingui/react/macro";
import type { ImageHandling, ImageInputStatus } from "@rakazo/contracts";
import { IMAGE_INPUT_PREVIEW_DELAY_MS, imageInputRouteKey } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export function ImageInputChoice({
  value,
  onChange,
  target,
  revision,
  refusal,
  onChooseModel,
}: {
  value: ImageHandling;
  onChange: (value: ImageHandling) => void;
  target: Parameters<typeof rpc.threads.imageInput>[0];
  revision: string;
  refusal?: { status: ImageInputStatus; botId?: string };
  onChooseModel?: (botId?: string) => void;
}) {
  const { t } = useLingui();
  const query = JSON.stringify(target);
  const routeKey = JSON.stringify([revision, imageInputRouteKey(target)]);
  const [result, setResult] = useState<{
    routeKey: string;
    status: ImageInputStatus;
    botId?: string;
  }>();
  useEffect(() => {
    let generation = 0;
    const request = JSON.parse(query) as typeof target;
    const refresh = () => {
      if (!("draftGroupBotIds" in request) && !request.botId && !request.groupId) return;
      const latest = ++generation;
      void rpc.threads.imageInput(request).then(
        ({ status, botId }) => {
          if (latest === generation) setResult({ routeKey, status, botId });
        },
        () => {
          if (latest === generation && !refusal) setResult({ routeKey, status: "unknown" });
        },
      );
    };
    const timer = window.setTimeout(refresh, IMAGE_INPUT_PREVIEW_DELAY_MS);
    const refreshOnFocus = () => {
      window.clearTimeout(timer);
      refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearTimeout(timer);
      generation++;
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [routeKey, query, refusal]);
  const display = result?.routeKey === routeKey ? result : refusal;
  const status = display?.status ?? "unknown";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="image-input-choice">
      <fieldset className="flex gap-1" aria-label={t`Image use`}>
        <Button
          type="button"
          variant={value === "confirm" ? "outline" : "ghost"}
          className="min-h-11"
          aria-pressed={value === "confirm"}
          onClick={() => onChange("confirm")}
        >
          {t`Let Bot see images`}
        </Button>
        <Button
          type="button"
          variant={value === "file" ? "outline" : "ghost"}
          className="min-h-11"
          aria-pressed={value === "file"}
          onClick={() => onChange("file")}
        >
          {t`As file`}
        </Button>
      </fieldset>
      {value === "confirm" ? (
        <>
          <span role="status" className="text-xs text-muted-foreground">
            {status === "supported"
              ? t`Can see images`
              : status === "unsupported"
                ? t`This model cannot see images`
                : t`This model's image capability is unconfirmed`}
          </span>
          {status !== "supported" && onChooseModel ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() =>
                onChooseModel(display?.botId ?? ("botId" in target ? target.botId : undefined))
              }
            >{t`Choose model`}</Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
