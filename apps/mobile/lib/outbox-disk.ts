import { PageReplyContextSchema } from "@rakazo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import type { SendAttempt, UnsentDisk } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

// App-private cache storage is excluded from device backups and may be evicted by the OS.
function root() {
  return new Directory(Paths.cache, "outbox");
}
function folder(nonce: string) {
  return new Directory(root(), encodeURIComponent(nonce));
}
function attachmentFile(nonce: string, index: number) {
  return new File(folder(nonce), `${index}`);
}
function file() {
  return new File(root(), "sends-v4.json");
}
function replacement() {
  return new File(root(), "sends-v4.json.tmp");
}
function backup() {
  return new File(root(), "sends-v4.json.bak");
}
function deleteLeftover(entry: File | Directory) {
  try {
    entry.delete();
  } catch {}
}
function readIndex(index: File): unknown[] | undefined {
  if (!index.exists || index.size > OUTBOX_MAX_BYTES) return undefined;
  const text = index.textSync();
  try {
    const entries: unknown = JSON.parse(text);
    return Array.isArray(entries) ? entries : undefined;
  } catch {
    return undefined;
  }
}
function committedIndex() {
  const entries = readIndex(file());
  if (entries) return entries;
  const previous = readIndex(backup());
  if (previous) backup().moveSync(file(), { overwrite: true });
  return previous;
}
export const OUTBOX_MAX_BYTES = 50 * 1024 * 1024;
function diskBytes(directory: Directory): number {
  return directory.exists
    ? directory
        .list()
        .filter((entry) => ![replacement().uri, backup().uri].includes(entry.uri))
        .reduce((sum, entry) => sum + (entry instanceof File ? entry.size : diskBytes(entry)), 0)
    : 0;
}
function storedEntry(attempt: SendAttempt) {
  return {
    ...attempt,
    state: attempt.state === "pending" ? "queued" : attempt.state,
    artifactIds: [...attempt.artifactIds],
    payload: {
      ...attempt.payload,
      attachments: attempt.payload.attachments.map(
        ({ contentBase64: _bytes, previewUri: _preview, ...attachment }) => attachment,
      ),
    },
  };
}
export const outboxDisk: UnsentDisk = {
  admit(attempt) {
    try {
      if (folder(attempt.clientNonce).exists) return false;
      const bytes = attempt.payload.attachments.reduce(
        (sum, a) => sum + Math.floor((a.contentBase64.length * 3) / 4),
        0,
      );
      if (
        diskBytes(root()) +
          bytes +
          new TextEncoder().encode(JSON.stringify(storedEntry(attempt))).length +
          2 >
        OUTBOX_MAX_BYTES
      )
        return false;
      folder(attempt.clientNonce).create({ intermediates: true, idempotent: true });
      attempt.payload.attachments.forEach((attachment, index) => {
        const target = attachmentFile(attempt.clientNonce, index);
        target.create();
        target.write(attachment.contentBase64, { encoding: "base64" });
        attachment.previewUri = attachment.mimeType.startsWith("image/") ? target.uri : undefined;
      });
      for (const attachment of attempt.payload.attachments) attachment.contentBase64 = "";
      return true;
    } catch {
      outboxDisk.forget(attempt);
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    }
  },
  save(attempts) {
    try {
      root().create({ intermediates: true, idempotent: true });
      const target = file();
      const text = JSON.stringify(attempts.slice(0, OUTBOX_MAX_ENTRIES).map(storedEntry));
      const bytes = new TextEncoder().encode(text).length;
      if (diskBytes(root()) - (target.exists ? target.size : 0) + bytes > OUTBOX_MAX_BYTES)
        return false;
      if (backup().exists) committedIndex();
      const next = replacement();
      next.create({ overwrite: true });
      next.write(text);
      if (next.textSync() !== text) return false;
      if (target.exists) target.moveSync(backup(), { overwrite: true });
      try {
        next.moveSync(file());
      } catch (error) {
        // A native copy-and-delete move may commit before reporting a source cleanup failure.
        if (!file().exists || file().textSync() !== text) throw error;
      }
    } catch {
      return false;
    }
    if (backup().exists) deleteLeftover(backup());
    if (replacement().exists) deleteLeftover(replacement());
    return true;
  },
  load(session, scope) {
    // Read/move errors must propagate without deleting a committed backup.
    const entries = committedIndex();
    const target = file();
    if (!entries || diskBytes(root()) > OUTBOX_MAX_BYTES) {
      outboxDisk.clear();
      return [];
    }
    let loaded: SendAttempt[];
    try {
      loaded = entries.slice(0, OUTBOX_MAX_ENTRIES).flatMap((raw): SendAttempt[] => {
        const entry = raw as ReturnType<typeof storedEntry> | null;
        if (
          entry?.apiBase !== scope.apiBase ||
          entry.userId !== scope.userId ||
          entry.cacheSession !== scope.cacheSession ||
          !(entry.spaceId === null || typeof entry.spaceId === "string") ||
          typeof entry.clientNonce !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(entry.clientNonce) ||
          !["queued", "failed", "refused"].includes(entry.state) ||
          typeof entry.payload?.originThreadKey !== "string" ||
          typeof entry.payload.displayText !== "string" ||
          !entry.payload.plan ||
          typeof entry.payload.plan.trimmed !== "string" ||
          typeof entry.payload.plan.shouldSend !== "boolean" ||
          typeof entry.payload.plan.shouldRunRoutines !== "boolean" ||
          !Array.isArray(entry.payload.plan.routineIds) ||
          !Array.isArray(entry.payload.plan.mentionPayload) ||
          !Array.isArray(entry.payload.attachments) ||
          (entry.payload.imageHandling !== undefined &&
            !["confirm", "file"].includes(entry.payload.imageHandling)) ||
          (entry.imageInputStatus !== undefined &&
            !["unsupported", "unknown"].includes(entry.imageInputStatus)) ||
          (entry.imageInputBotId !== undefined && typeof entry.imageInputBotId !== "string") ||
          (entry.payload.fromPage !== undefined && entry.payload.fromPage !== true) ||
          (entry.payload.pageContext !== undefined &&
            !PageReplyContextSchema.safeParse(entry.payload.pageContext).success) ||
          !Array.isArray(entry.artifactIds) ||
          !entry.artifactIds.every(
            (pair: unknown) =>
              Array.isArray(pair) &&
              pair.length === 2 &&
              pair.every((id) => typeof id === "string"),
          )
        )
          return [];
        const attachments = entry.payload.attachments.map((attachment, index) => ({
          ...attachment,
          contentBase64: "",
          previewUri: attachment.mimeType?.startsWith("image/")
            ? attachmentFile(entry.clientNonce, index).uri
            : undefined,
        }));
        return [
          {
            ...entry,
            session,
            artifactIds: new Map(entry.artifactIds),
            payload: { ...entry.payload, attachments },
          },
        ];
      });
    } catch {
      outboxDisk.clear();
      return [];
    }
    const keep = new Set([target.uri, ...loaded.map((a) => folder(a.clientNonce).uri)]);
    for (const entry of root().list()) if (!keep.has(entry.uri)) deleteLeftover(entry);
    return loaded;
  },
  async hydrate(attempt) {
    for (const [index, attachment] of attempt.payload.attachments.entries()) {
      if (attachment.contentBase64 || attempt.artifactIds.has(attachment.id)) continue;
      const target = attachmentFile(attempt.clientNonce, index);
      if (!target.exists) throw new Error("ATTACHMENT_UNAVAILABLE");
      attachment.contentBase64 = await target.base64();
    }
  },
  forget(attempt) {
    try {
      const directory = folder(attempt.clientNonce);
      if (directory.exists) directory.delete();
    } catch {}
  },
  clear() {
    try {
      const directory = root();
      if (directory.exists) directory.delete();
    } catch {
      /* Session namespaces prevent reuse even if deletion fails. */
    }
  },
};
