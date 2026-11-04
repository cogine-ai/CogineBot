import { expect, it } from "vitest";
import {
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "./index.js";

it("identifies a computer rate limit without exposing the provider cause in its message", () => {
  const cause = new Error("Synthetic provider account limit");
  const error = new SandboxRateLimitError({ cause });
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("SandboxRateLimitError");
  expect(error.code).toBe("SANDBOX_RATE_LIMITED");
  expect(error.message).toBe("Too many computer requests. Try again later.");
  expect(error.cause).toBe(cause);
  expect(error.message).not.toContain(cause.message);
});

it("keeps temporary start failures distinct from limits and provider diagnostics", () => {
  const cause = new Error("synthetic private provider diagnosis");
  const error = new SandboxUnavailableError({ cause });
  expect(error.name).toBe("SandboxUnavailableError");
  expect(error.code).toBe("SANDBOX_UNAVAILABLE");
  expect(error.message).toBe("The computer did not start. Try again.");
  expect(error.cause).toBe(cause);
  expect(error).not.toBeInstanceOf(SandboxRateLimitError);
});

it("preserves an unresponsive provider's sanitized explanation and cause", () => {
  const cause = new Error("synthetic provider connection loss");
  const error = new SandboxUnresponsiveError("Computer provider could not be reached", { cause });
  expect(error.name).toBe("SandboxUnresponsiveError");
  expect(error.message).toBe("Computer provider could not be reached");
  expect(error.cause).toBe(cause);
  expect(error).not.toBeInstanceOf(SandboxRateLimitError);
});
