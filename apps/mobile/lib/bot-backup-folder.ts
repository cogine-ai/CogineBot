import type { AgentBackupModel } from "@rakazo/contracts";
import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  encodeAgentBackupFolder,
  readAgentBackupFolderModelKey,
} from "@rakazo/core/agent-backup";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

/** Native code owns grants/URLs. JS only receives relative inventory and bounded bytes. */
export type BackupFolderAccess = {
  pick(limits: { entries: number; fileBytes: number; readBytes: number }): Promise<{
    session: string;
    entries: { path: string; size: number }[];
  } | null>;
  read(session: string, path: string, maxBytes: number): Promise<number[]>;
  verify(session: string): Promise<void>;
  close(session: string): Promise<void>;
};

export type SelectedBackupFolder = {
  source: string;
  readKey(model: AgentBackupModel): Promise<string | undefined>;
  dispose(): void;
};

export async function pickBotBackupFolder(
  isCurrent: () => boolean,
  access = requireOptionalNativeModule<BackupFolderAccess>("RakazoBackupFolder"),
): Promise<SelectedBackupFolder | null> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("scope_changed");
  };
  assertCurrent();
  if (!access) throw new Error("folder_unavailable");
  const result = await access.pick(AGENT_IMPORT_ARCHIVE_LIMITS);
  if (!result) {
    assertCurrent();
    return null;
  }
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    void access.close(result.session).catch(() => undefined);
  };
  let readFailure: unknown;
  const entries = result.entries.map((entry) => ({
    ...entry,
    async read(maxBytes: number) {
      try {
        assertCurrent();
        if (closed) throw new Error("folder_closed");
        const bytes = new Uint8Array(await access.read(result.session, entry.path, maxBytes));
        assertCurrent();
        if (bytes.length !== entry.size) throw new Error("folder_changed");
        return bytes;
      } catch (error) {
        // Shared projection may omit optional config; an I/O failure must reject this selection.
        readFailure = error;
        throw error;
      }
    },
  }));
  try {
    assertCurrent();
    // SAF cursors have no trustworthy completeness signal, including the system
    // provider. Also reject successful results from an older installed native module.
    if (Platform.OS === "android") throw new Error("folder_inventory_unverifiable");
    const source = await encodeAgentBackupFolder(entries, isCurrent);
    if (readFailure) throw readFailure;
    await access.verify(result.session);
    assertCurrent();
    return {
      source,
      dispose,
      async readKey(model) {
        assertCurrent();
        if (closed) throw new Error("folder_closed");
        await access.verify(result.session);
        const key = await readAgentBackupFolderModelKey(entries, model, isCurrent);
        await access.verify(result.session);
        assertCurrent();
        return key;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
