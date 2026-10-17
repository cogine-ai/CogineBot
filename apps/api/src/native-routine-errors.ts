import { ORPCError } from "@orpc/server";
import { NativeActionError, NativeRoutineEventError } from "@rakazo/adapters";

/** Only known native failure kinds cross this boundary; provider messages/body stay private. */
export function mapNativeRoutineError(error: unknown): unknown {
  if (error instanceof NativeRoutineEventError) {
    switch (error.kind) {
      case "not_found":
        return new ORPCError("NOT_FOUND", { message: "Routine not found." });
      case "conflict":
        return new ORPCError("CONFLICT", {
          message: "The event binding changed. Read it again before saving.",
        });
      case "invalid_input":
        return new ORPCError("BAD_REQUEST", { message: "Check the selected event and resource." });
      case "unavailable":
        return new ORPCError("BAD_REQUEST", {
          message: "Select a current connected account and accessible resource.",
        });
    }
  }
  if (error instanceof NativeActionError) {
    switch (error.kind) {
      case "resource_unavailable":
        return new ORPCError("NOT_FOUND", {
          message: "The selected resource is unavailable to this account.",
        });
      case "version_conflict":
        return new ORPCError("CONFLICT", {
          message: "The account or resource changed. Read it again before saving.",
        });
      case "authorization_required":
      case "authorization_expired":
      case "insufficient_scope":
        return new ORPCError("BAD_REQUEST", {
          message: "Authorize this exact account with the required event access.",
        });
      case "invalid_input":
        return new ORPCError("BAD_REQUEST", { message: "Check the selected event and resource." });
      case "not_configured":
        return new ORPCError("SERVICE_UNAVAILABLE", {
          message: "The native application is not configured.",
        });
      case "rate_limited":
      case "temporarily_unavailable":
      case "incomplete_response":
      case "result_unknown":
        return new ORPCError("SERVICE_UNAVAILABLE", {
          message: "The selected event source could not be verified. Try again later.",
        });
    }
  }
  return error;
}

export function rethrowNativeRoutineError(error: unknown): never {
  throw mapNativeRoutineError(error);
}
