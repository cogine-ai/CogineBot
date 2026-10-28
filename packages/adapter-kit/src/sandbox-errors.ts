import { COMPUTER_RATE_LIMITED_ERROR_MESSAGE } from "@rakazo/contracts";

/** The sandbox provider refused the request because an account rate limit or quota was hit. */
export class SandboxRateLimitError extends Error {
  readonly code = "SANDBOX_RATE_LIMITED";
  constructor(options?: { cause?: unknown }) {
    super(COMPUTER_RATE_LIMITED_ERROR_MESSAGE, options);
    this.name = "SandboxRateLimitError";
  }
}
