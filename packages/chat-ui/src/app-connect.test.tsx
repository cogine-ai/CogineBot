// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppConnectClient } from "./app-connect.js";
import { useAppConnectCard } from "./app-connect.js";

const card = {
  botId: "bot",
  messageId: "message",
  block: {
    kind: "app_connect",
    connectorId: "pipedream",
    provider: "APP",
    name: "Example",
    description: "",
    logo: null,
    status: "pending",
  },
} as const;
const grant = { connectionId: "grant", authorizationUrl: "https://auth.example.test/grant" };
const emptyReadback = { connected: false, pendingConnectionId: null };

function fixture() {
  return {
    readback: vi.fn<AppConnectClient["readback"]>().mockResolvedValue(emptyReadback),
    begin: vi.fn<AppConnectClient["begin"]>().mockResolvedValue(grant),
    complete: vi.fn<AppConnectClient["complete"]>().mockResolvedValue({ status: "connected" }),
    openAuthorization: vi.fn<AppConnectClient["openAuthorization"]>().mockReturnValue(true),
  };
}

let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(client: AppConnectClient, readOnly = false) {
  let view: ReturnType<typeof useAppConnectCard>;
  function Card() {
    view = useAppConnectCard({ ...card, readOnly }, client);
    return null;
  }
  await act(async () => root.render(<Card />));
  return () => view;
}

it("ignores an old readback after a rejected asynchronous launch and reopens the same grant", async () => {
  const client = fixture();
  let finishReadback!: () => void;
  client.readback.mockReturnValueOnce(
    new Promise((resolve) => {
      finishReadback = () => resolve(emptyReadback);
    }),
  );
  client.openAuthorization.mockRejectedValueOnce(new Error("Device could not open the URL"));
  const view = await mount(client);

  await act(async () => view().authorize());
  expect(view()).toMatchObject({
    busy: false,
    needsAttention: true,
    error: { kind: "authorization" },
  });
  await act(async () => finishReadback());
  const connected = vi.fn();
  await act(async () => view().authorize(connected));

  expect(client.openAuthorization.mock.calls).toEqual([
    [grant.authorizationUrl],
    [grant.authorizationUrl],
  ]);
  expect(client.begin).toHaveBeenCalledTimes(1);
  expect(client.complete).toHaveBeenCalledExactlyOnceWith(
    { connectionId: grant.connectionId, card: { botId: card.botId, messageId: card.messageId } },
    expect.any(AbortSignal),
  );
  expect(view().status).toBe("connected");
  expect(connected).toHaveBeenCalledTimes(1);
});

it("checks a recovered grant once and leaves a revoked grant ready for an explicit new action", async () => {
  const client = fixture();
  client.readback.mockResolvedValue({ connected: false, pendingConnectionId: "recovered" });
  client.complete
    .mockResolvedValueOnce({ status: "pending" })
    .mockResolvedValueOnce({ status: "revoked" });
  const view = await mount(client);

  await act(async () => view().authorize());
  expect(view()).toMatchObject({
    checkOnly: true,
    needsAttention: true,
    error: { kind: "pending" },
  });
  expect(client.complete).toHaveBeenCalledTimes(1);
  await act(async () => view().authorize());
  expect(view()).toMatchObject({
    checkOnly: false,
    needsAttention: false,
    error: { kind: "authorization" },
  });
  expect(client.complete.mock.calls.map(([input]) => input.connectionId)).toEqual([
    "recovered",
    "recovered",
  ]);
  expect(client.begin).not.toHaveBeenCalled();
  expect(client.openAuthorization).not.toHaveBeenCalled();
});

it("rechecks an opened grant and aborts the wait when the card unmounts", async () => {
  vi.useFakeTimers();
  const client = fixture();
  client.complete.mockResolvedValue({ status: "pending" });
  const view = await mount(client);
  let attempt!: Promise<void>;
  await act(async () => {
    attempt = view().authorize();
  });
  expect(view()).toMatchObject({ busy: true, checkOnly: true });
  expect(client.complete).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(client.complete).toHaveBeenCalledTimes(2);
  const signal = client.complete.mock.calls[0]![1];
  await act(async () => root.render(null));
  await attempt;
  expect(signal.aborted).toBe(true);
  expect(client.complete).toHaveBeenCalledTimes(2);
});

it("leaves a read-only card idle", async () => {
  const client = fixture();
  const view = await mount(client, true);
  await act(async () => view().authorize());
  expect(client.readback).not.toHaveBeenCalled();
  expect(client.begin).not.toHaveBeenCalled();
  expect(view()).toMatchObject({ status: "pending", busy: false });
});
