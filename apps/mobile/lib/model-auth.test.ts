import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  modelOAuthUnavailableReason,
  waitForModelOAuth,
} from "./model-auth";

vi.mock("./api", () => ({ rpc: vi.fn() }));

it("requires a local browser or desktop only for connecting the ChatGPT plan provider", () => {
  expect(modelOAuthUnavailableReason("chatgpt-plan")).toContain("local desktop");
  expect(modelOAuthUnavailableReason("openai-codex")).toBeUndefined();
  expect(modelOAuthUnavailableReason("anthropic")).toBeUndefined();
});

describe("mobile waitForModelOAuth", () => {
  const mockRpc = vi.mocked(rpc);

  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("stops polling when its screen loses focus", async () => {
    mockRpc.mockResolvedValue({ status: "pending" });
    const controller = new AbortController();
    const polling = waitForModelOAuth("login-id", controller.signal);

    await Promise.resolve();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("returns readiness normally", async () => {
    mockRpc.mockResolvedValue({ status: "ready" });

    await expect(waitForModelOAuth("login-id")).resolves.toMatchObject({ status: "ready" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("polls with the client that began the target sign-in", async () => {
    const client = vi.fn().mockResolvedValue({ status: "ready" });
    await expect(waitForModelOAuth("target-login", undefined, client)).resolves.toMatchObject({
      status: "ready",
    });
    expect(client).toHaveBeenCalledWith(
      "models/completeOAuth",
      { loginId: "target-login" },
      { signal: undefined },
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("mobile OAuth focus lifecycle", () => {
  it("resets busy state on focus cleanup and protects a newer attempt", () => {
    const ref = { current: null as AbortController | null };
    let busy = false;
    const reset = () => {
      busy = false;
    };
    const startAttempt = () => {
      const controller = new AbortController();
      ref.current = controller;
      busy = true;
      return controller;
    };

    const first = startAttempt();
    cancelModelOAuthAttempt(ref, reset);

    expect(first.signal.aborted).toBe(true);
    expect(ref.current).toBeNull();
    expect(busy).toBe(false);

    const second = startAttempt();
    finishModelOAuthAttempt(ref, first, reset);

    expect(ref.current).toBe(second);
    expect(busy).toBe(true);

    finishModelOAuthAttempt(ref, second, reset);
    expect(ref.current).toBeNull();
    expect(busy).toBe(false);
  });
});
