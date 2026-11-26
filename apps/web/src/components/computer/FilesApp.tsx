import { useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { ATTACHMENT_MAX_BYTES, ComputerStorageRecoverySchema } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ArrowLeft, Download, File, Folder, Upload } from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import {
  basename,
  type ComputerFileEntry,
  formatSize,
  parentPath,
  sortEntries,
  subscribeComputerCommands,
} from "../../lib/computer-workspace";
import { isFileDrag, readFileAsBase64 } from "../../lib/pending-attachments";
import {
  captureRpcRecoveryScope,
  isRpcRecoveryScopeCurrent,
  rpc,
  rpcRecoveryScopeKey,
  subscribeRpcRecoveryScope,
} from "../../lib/rpc";
import { useObjectUrl } from "../../lib/use-object-url";
import { errorText } from "../../lib/user-error";
import { ComputerStorageButton } from "./ComputerStorage";

type Entry = ComputerFileEntry;
type Preview =
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "image"; bytes: Uint8Array; mimeType: string };

const FILES_REFRESH_MS = 3_000;

const IMAGE_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Browse the bot's workspace. Download works from the saved workspace while paused. Upload needs control. */
export function FilesApp({
  botId,
  canUpload,
  savedOnly,
  visible,
}: {
  botId: string;
  canUpload: boolean;
  savedOnly?: boolean;
  /** Refresh only while the window is on screen. */
  visible: boolean;
}) {
  const source = savedOnly ? ("saved" as const) : undefined;
  const { t } = useLingui();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{
    message: string;
    recovery?: { target: string; scope: ReturnType<typeof captureRpcRecoveryScope> };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const scopeKey = useSyncExternalStore(subscribeRpcRecoveryScope, rpcRecoveryScopeKey);
  const uploadOwner = useRef<{ uploading: boolean } | null>(null);
  const visibility = useRef<object | null>(null);
  useLayoutEffect(() => {
    uploadOwner.current = { uploading: false };
    setError(null);
    setBusy(false);
    return () => {
      uploadOwner.current = null;
    };
  }, [botId, scopeKey]);
  useLayoutEffect(() => {
    visibility.current = visible ? {} : null;
    return () => {
      visibility.current = null;
    };
  }, [visible]);
  const input = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(
    async (target: string) => {
      const generation = ++loadGeneration.current;
      setError(null);
      try {
        const listed = await rpc.computer.files({ botId, path: target, source });
        if (generation !== loadGeneration.current) return;
        setEntries(sortEntries(listed));
        setPath(target);
        setPreview(null);
      } catch (cause) {
        if (generation !== loadGeneration.current) return;
        setError({ message: errorText(cause, t`Could not list files`) });
      }
    },
    [botId, t],
  );

  useEffect(() => {
    setPath("");
    setEntries(null);
    setPreview(null);
    setError(null);
    void load("");
  }, [load]);

  useEffect(() => {
    if (!visible || preview) return;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const generation = loadGeneration.current;
      const listed = await rpc.computer.files({ botId, path, source }).catch(() => null);
      if (cancelled || !listed || generation !== loadGeneration.current) return;
      const next = sortEntries(listed);
      setEntries((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    const timer = window.setInterval(() => void refresh(), FILES_REFRESH_MS);
    const unsubscribe = subscribeComputerCommands((eventBotId, command) => {
      if (eventBotId === botId && command.status === "done") void refresh();
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [botId, path, preview, source, visible]);

  async function open(entry: Entry) {
    if (entry.kind === "dir") return load(entry.path);
    setError(null);
    try {
      const mimeType = IMAGE_TYPES[extension(entry.path)];
      if (mimeType) {
        const file = await rpc.computer.downloadFile({ botId, path: entry.path, source });
        setPreview({
          path: entry.path,
          kind: "image",
          bytes: decodeArtifactBase64(file.contentBase64),
          mimeType,
        });
      } else {
        const file = await rpc.computer.readFile({ botId, path: entry.path, source });
        setPreview({ path: entry.path, kind: "text", content: file.content });
      }
    } catch (cause) {
      setError({ message: errorText(cause, t`Could not open file`) });
    }
  }

  async function download(target: string) {
    setError(null);
    try {
      const file = await rpc.computer.downloadFile({ botId, path: target, source });
      downloadArtifactBytes(
        basename(target),
        IMAGE_TYPES[extension(target)] ?? "application/octet-stream",
        decodeArtifactBase64(file.contentBase64),
      );
    } catch (cause) {
      setError({ message: errorText(cause, t`Could not download file`) });
    }
  }

  async function upload(files: FileList | File[]) {
    const owner = uploadOwner.current;
    if (!owner || owner.uploading) return;
    owner.uploading = true;
    setBusy(true);
    setError(null);
    const scope = captureRpcRecoveryScope();
    const originalVisibility = visibility.current;
    const sameScope = () => isRpcRecoveryScopeCurrent(scope);
    const current = () => owner === uploadOwner.current && sameScope();
    try {
      for (const file of Array.from(files)) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          throw new Error(t`File is too large to upload.`);
        }
        const contentBase64 = await readFileAsBase64(file);
        if (!sameScope()) return;
        await rpc.computer.uploadFile({
          botId,
          path: path ? `${path}/${file.name}` : file.name,
          contentBase64,
        });
      }
      if (current()) await load(path);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ORPCError && cause.code === "COMPUTER_STORAGE_FULL") {
        const recovery = ComputerStorageRecoverySchema.safeParse(cause.data);
        if (recovery.success && recovery.data.botId === botId) {
          setError({
            message: t`Not enough storage to upload this file.`,
            recovery:
              originalVisibility && originalVisibility === visibility.current
                ? { target: recovery.data.expectedTarget, scope }
                : undefined,
          });
          return;
        }
      }
      setError({ message: errorText(cause, t`Could not upload file`) });
    } finally {
      owner.uploading = false;
      if (current()) setBusy(false);
    }
  }

  function onDrop(event: DragEvent) {
    if (!canUpload || !event.ctrlKey || !isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    void upload(event.dataTransfer.files);
  }

  const location = preview?.path ?? path;
  return (
    <fieldset
      className="m-0 flex h-full min-h-0 min-w-0 flex-col border-0 bg-background p-0 text-[13px]"
      data-testid="computer-files"
      onDragOver={(event) => {
        if (canUpload && event.ctrlKey && isFileDrag(event.dataTransfer)) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Back`}
          disabled={!preview && !path}
          onClick={() => (preview ? setPreview(null) : void load(parentPath(path)))}
        >
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
          ~/{location}
        </span>
        {visible ? <ComputerStorageButton botId={botId} /> : null}
        {preview ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Download`}
            onClick={() => void download(preview.path)}
          >
            <Download />
          </Button>
        ) : null}
        {!preview && canUpload ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Upload`}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload />
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) void upload(event.target.files);
                event.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>
      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span role="alert" className="text-destructive">
            {error.message}
          </span>
          {visible && error.recovery && isRpcRecoveryScopeCurrent(error.recovery.scope) ? (
            <ComputerStorageButton botId={botId} expectedTarget={error.recovery.target} />
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {preview ? (
          <FilePreview preview={preview} />
        ) : (
          <ul>
            {entries?.map((entry) => (
              <li key={entry.path} className="group flex items-center hover:bg-accent">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-foreground"
                  onClick={() => void open(entry)}
                >
                  {entry.kind === "dir" ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <File className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate" dir="auto">
                    {basename(entry.path)}
                  </span>
                  {entry.kind === "file" ? (
                    <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                      {formatSize(entry.size)}
                    </span>
                  ) : null}
                </button>
                {entry.kind === "file" ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t`Download ${basename(entry.path)}`}
                    onClick={() => void download(entry.path)}
                  >
                    <Download />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </fieldset>
  );
}

function FilePreview({ preview }: { preview: Preview }) {
  if (preview.kind === "text") {
    return (
      <pre className="p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
        {preview.content}
      </pre>
    );
  }
  return <ImagePreview preview={preview} />;
}

function ImagePreview({ preview }: { preview: Extract<Preview, { kind: "image" }> }) {
  const url = useObjectUrl(preview.bytes, preview.mimeType);
  return url ? (
    <img src={url} alt={basename(preview.path)} className="mx-auto max-h-full max-w-full p-3" />
  ) : null;
}

function extension(path: string) {
  const name = basename(path);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}
