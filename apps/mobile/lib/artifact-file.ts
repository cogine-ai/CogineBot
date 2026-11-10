import { attachmentExtensionForMimeType } from "@rakazo/core";

/**
 * An artifact travels as base64 inside the RPC body: up to the attachment limit (10 MiB) plus
 * a third of encoding overhead. The default RPC timeout is sized for small JSON replies and
 * gives up on a multi-megabyte photo over a relayed cellular link, so downloads get a budget
 * of their own.
 */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 120_000;

export function artifactCacheFileName(artifactId: string, mimeType: string): string {
  const safeId = artifactId.replace(/[^A-Za-z0-9_-]/g, "_") || "attachment";
  return `${safeId}${attachmentExtensionForMimeType(mimeType)}`;
}

/** Filename for the share sheet. Uses the display name, never the storage id. */
export function artifactShareFileName(name: string, mimeType: string): string {
  const ext = attachmentExtensionForMimeType(mimeType);
  const trimmed = name.trim();
  const stemSource =
    ext && trimmed.toLowerCase().endsWith(ext.toLowerCase())
      ? trimmed.slice(0, -ext.length)
      : trimmed;
  const stem = stemSource
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+/, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${stem || "attachment"}${ext}`;
}
