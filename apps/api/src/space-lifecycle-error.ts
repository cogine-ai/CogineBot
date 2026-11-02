import { ORPCError } from "@orpc/server";
import { ComputerLimitError, SpaceDeletionInProgressError } from "@rakazo/db";

/** Preserve actionable creation failures across ordinary and package Bot entry points. */
export function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ComputerLimitError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}
