import { COMPUTER_RATE_LIMITED_ERROR_MESSAGE } from "@rakazo/contracts";

/** A provider reports a confirmed nonzero exit through its error channel. */
export class SandboxCommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    cause: Error,
  ) {
    super(cause.message, { cause });
    this.name = "SandboxCommandExitError";
  }
}

/** The sandbox provider refused the request because an account rate limit or quota was hit. */
export class SandboxRateLimitError extends Error {
  readonly code = "SANDBOX_RATE_LIMITED";
  constructor(options?: { cause?: unknown }) {
    super(COMPUTER_RATE_LIMITED_ERROR_MESSAGE, options);
    this.name = "SandboxRateLimitError";
  }
}

/**
 * The provider could not be reached, failed on its side, or gave up waiting for the sandbox to
 * answer. It is not resent; background work skips this attempt and tries again later.
 */
export class SandboxUnresponsiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxUnresponsiveError";
  }
}

/** The provider accepted the start but did not bring the computer up in time; a retry may work. */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(options?: { cause?: unknown }) {
    super("The computer did not start. Try again.", options);
    this.name = "SandboxUnavailableError";
  }
}

/** The provider confirmed that the computer can no longer start programs. */
export class SandboxDamagedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The computer needs recovery.", options);
    this.name = "SandboxDamagedError";
  }
}

/** A stop or teardown request ended without confirming the computer is offline. */
export class SandboxUnsafeStopError extends Error {
  constructor(cause?: unknown) {
    super("The computer's stop could not be confirmed.", { cause });
    this.name = "SandboxUnsafeStopError";
  }
}

/** Saving stopped before replacing the stored workspace. */
export class WorkspaceTooLargeError extends Error {
  readonly code = "WORKSPACE_TOO_LARGE";
  constructor(readonly limit: "bytes" | "files") {
    super(
      limit === "bytes"
        ? "The computer's files are too large to save"
        : "The computer has too many files to save",
    );
    this.name = "WorkspaceTooLargeError";
  }
}
