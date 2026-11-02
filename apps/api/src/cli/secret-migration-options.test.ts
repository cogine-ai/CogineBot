import { describe, expect, it } from "vitest";
import { parseSecretMigrationOptions } from "./secret-migration-options.js";

describe("explicit orphaned-transfer maintenance mode", () => {
  it("selects cleanup independently from migration with an optional dry run", () => {
    expect(parseSecretMigrationOptions(["--cleanup-orphaned-transfers", "--dry-run"])).toEqual({
      cleanupOrphanedTransfers: true,
      dryRun: true,
      reverse: false,
    });
    expect(parseSecretMigrationOptions(["--reverse"])).toEqual({
      cleanupOrphanedTransfers: false,
      dryRun: false,
      reverse: true,
    });
  });
  it("rejects combining cleanup and reverse migration or unknown switches", () => {
    expect(() =>
      parseSecretMigrationOptions(["--cleanup-orphaned-transfers", "--reverse"]),
    ).toThrow("Usage");
    expect(() => parseSecretMigrationOptions(["--force"])).toThrow("Usage");
  });
});
