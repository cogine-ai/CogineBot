import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { BoxSandboxEmulator } from "./box-emulator.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

it("limits only computer starts and resumes, while reconnecting to a running computer is free", async () => {
  const provider = new BoxSandboxEmulator({ startLimit: 1 });
  const request = { botId: "bot", homePath: "/unused" };
  const computer = await provider.provision(request, context);
  expect(computer.kind).toBe("box");
  expect((await provider.provision(request, context)).fresh).toBe(false);
  await expect(
    provider.provision({ botId: "other", homePath: "/unused" }, context),
  ).rejects.toBeInstanceOf(SandboxRateLimitError);
  await provider.stop(computer, context);
  await expect(provider.provision(request, context)).rejects.toBeInstanceOf(SandboxRateLimitError);
  expect(provider.boxes.get(computer.id)?.running).toBe(false);
});

it("preserves unlimited starts and the existing Box identity by default", async () => {
  const provider = new BoxSandboxEmulator();
  expect(provider.describe().id).toBe("box-emulator");
  expect(await provider.provisionKind()).toBe("box");
  const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
  await provider.stop(computer, context);
  expect((await provider.provision({ botId: "bot", homePath: "/unused" }, context)).kind).toBe(
    "box",
  );
});
