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
  onChooseModel,
}: {
  value: ImageHandling;
  onChange: (value: ImageHandling) => void;
  target: Parameters<typeof rpc.threads.imageInput>[0];
  revision: string;
  onChooseModel?: () => void;
}) {
  const { t } = useLingui();
  const query = JSON.stringify(target);
  const key = JSON.stringify([revision, query]);
  const [result, setResult] = useState<{ key: string; status: ImageInputStatus }>();
  useEffect(() => {
    let cancelled = false;
    const request = JSON.parse(query) as typeof target;
    const refresh = () => {
      if (!request.botId && !request.groupId) return;
      void rpc.threads.imageInput(request).then(
        ({ status }) => {
          if (!cancelled) setResult({ key, status });
        },
        () => {
          if (!cancelled) setResult({ key, status: "unknown" });
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [key, query]);
  const status = result?.key === key ? result.status : "unknown";
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
              onClick={onChooseModel}
            >{t`Choose model`}</Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
