import { expect, it } from "vitest";
import { SandboxRateLimitError } from "./index.js";

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
