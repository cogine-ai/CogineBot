import { useLingui } from "@lingui/react/macro";
import type { ImageHandling, ImageInputStatus } from "@rakazo/contracts";
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
  const key = JSON.stringify([revision, query]);
  const [result, setResult] = useState<{ key: string; status: ImageInputStatus; botId?: string }>();
  useEffect(() => {
    let generation = 0;
    const request = JSON.parse(query) as typeof target;
    const refresh = () => {
      if (!("draftGroupBotIds" in request) && !request.botId && !request.groupId) return;
      const latest = ++generation;
      void rpc.threads.imageInput(request).then(
        ({ status, botId }) => {
          if (latest === generation) setResult({ key, status, botId });
        },
        () => {
          if (latest === generation) setResult({ key, status: "unknown" });
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      generation++;
      window.removeEventListener("focus", refresh);
    };
  }, [key, query]);
  const display = result?.key === key ? result : refusal;
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
