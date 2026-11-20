import { describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

function driverError(kind: string): Error {
  const error = new Error(kind, { cause: { kind } });
  error.name = "DriverAdapterError";
  return error;
}

describe("transaction retry", () => {
  it("retries an unwrapped write conflict from the driver", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(driverError("TransactionWriteConflict"))
      .mockResolvedValueOnce("committed");
    await expect(withTransactionRetry(operation)).resolves.toBe("committed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the driver's commit outcome is unknown", async () => {
    const error = driverError("ConnectionClosed");
    const operation = vi.fn().mockRejectedValue(error);
    await expect(withTransactionRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
