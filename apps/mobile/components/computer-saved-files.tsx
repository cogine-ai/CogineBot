import type { Directory } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { captureApiRequestContext, rpc } from "../lib/api";
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS, artifactShareFileName } from "../lib/artifact-file";
import { useI18n } from "../lib/i18n";
import { captureMobileScope, isMobileScopeCurrent } from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

type Entry = { path: string; kind: "file" | "dir" };
const MIME_TYPE = "application/octet-stream";

export function ComputerSavedFiles({ botId }: { botId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const active = useRef<{ controller: AbortController; downloading: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const session = { controller, downloading: false };
    active.current = session;
    setDownloading(false);
    const scope = captureMobileScope();
    const current = () => !controller.signal.aborted && isMobileScopeCurrent(scope);
    void (async () => {
      try {
        const requestContext = await captureApiRequestContext();
        if (!current()) return;
        const files = await rpc<Entry[]>(
          "computer/files",
          { botId, path, source: "saved" },
          { requestContext, signal: controller.signal },
        );
        if (current()) setEntries(files);
      } catch (cause) {
        if (current()) setError(errorText(cause, t("Could not load files")));
      }
    })();
    return () => {
      controller.abort();
      if (active.current === session) active.current = null;
    };
  }, [botId, open, path, t]);

  function navigate(next: string) {
    setEntries(null);
    setError(null);
    setPath(next);
  }

  async function download(entry: Entry) {
    const session = active.current;
    if (!session || session.downloading) return;
    session.downloading = true;
    const { controller } = session;
    const scope = captureMobileScope();
    const current = () => !controller.signal.aborted && isMobileScopeCurrent(scope);
    setDownloading(true);
    setError(null);
    let directory: Directory | undefined;
    try {
      const requestContext = await captureApiRequestContext();
      if (!current()) return;
      const { contentBase64 } = await rpc<{ contentBase64: string }>(
        "computer/downloadFile",
        { botId, path: entry.path, source: "saved" },
        { requestContext, timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS, signal: controller.signal },
      );
      if (!current()) return;
      const [{ Directory, File, Paths }, Sharing] = await Promise.all([
        import("expo-file-system"),
        import("expo-sharing"),
      ]);
      if (!current()) return;
      if (!(await Sharing.isAvailableAsync())) throw new Error(t("Could not download file"));
      if (!current()) return;
      const nonce =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      directory = new Directory(Paths.cache, `computer-file-${nonce}`);
      directory.create();
      const file = new File(directory, artifactShareFileName(entryName(entry.path), MIME_TYPE));
      file.create();
      file.write(contentBase64, { encoding: "base64" });
      await Sharing.shareAsync(file.uri, { mimeType: MIME_TYPE });
    } catch (cause) {
      if (current()) setError(errorText(cause, t("Could not download file")));
    } finally {
      try {
        if (directory?.exists) directory.delete();
      } catch (cause) {
        if (current()) setError(errorText(cause, t("Could not download file")));
      }
      session.downloading = false;
      if (current()) setDownloading(false);
    }
  }

  return (
    <View style={{ marginTop: 16, gap: 8 }}>
      <NativeActionButton
        label={t("Files")}
        prominence="secondary"
        selected={open}
        disabled={downloading}
        onPress={() => {
          navigate("");
          setOpen(!open);
        }}
      />
      {open ? (
        <>
          {path ? (
            <NativeActionButton
              label={t("Back")}
              prominence="plain"
              disabled={downloading}
              onPress={() => navigate(path.split("/").slice(0, -1).join("/"))}
            />
          ) : null}
          {error ? (
            <Text style={{ color: tokens.mutedForeground }}>{error}</Text>
          ) : !entries ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("Loading…")}</Text>
          ) : entries.length === 0 ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("No files")}</Text>
          ) : null}
          {entries?.map((entry) => (
            <NativeActionButton
              key={entry.path}
              label={entryName(entry.path)}
              accessibilityLabel={
                entry.kind === "file"
                  ? t("Download {name}", { name: entryName(entry.path) })
                  : entryName(entry.path)
              }
              prominence="plain"
              disabled={downloading}
              onPress={() => {
                if (entry.kind === "dir") navigate(entry.path);
                else void download(entry);
              }}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

function entryName(path: string) {
  return path.split("/").at(-1) ?? path;
}
