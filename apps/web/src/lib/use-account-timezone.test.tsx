// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ adopt: vi.fn(), update: vi.fn() }));
vi.mock("./rpc", () => ({
  rpc: { preferences: { adoptTimezone: api.adopt, update: api.update } },
}));

import { useAccountTimezone } from "./use-account-timezone";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let save!: (timezone: string) => Promise<void>;
function Harness(props: Parameters<typeof useAccountTimezone>[0]) {
  save = useAccountTimezone(props);
  return null;
}
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
async function render(props: ComponentProps<typeof Harness>) {
  root ??= createRoot(container);
  await act(async () => root?.render(<Harness {...props} />));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  api.adopt.mockReset();
  api.update.mockReset();
  vi.unstubAllGlobals();
});
function base(timezone: string | null | undefined) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { userId: "account-a", ownerKey: "session-a", timezone, onTimezoneChanged: vi.fn() };
}
it("adopts a real device zone only for explicit unset and merges only the returned zone", async () => {
  const props = base(null);
  api.adopt.mockResolvedValue({
    userId: "account-a",
    timezone: "Asia/Tokyo",
    defaultModel: "foreign",
    spaceId: "other",
  });
  await render(props);
  expect(api.adopt).toHaveBeenCalledTimes(1);
  expect(props.onTimezoneChanged).toHaveBeenCalledExactlyOnceWith("Asia/Tokyo");
});
it.each([undefined, "UTC", "Asia/Tokyo"])(
  "does not adopt an old or explicit preference %s",
  async (timezone) => {
    await render(base(timezone));
    expect(api.adopt).not.toHaveBeenCalled();
  },
);
it("does not adopt missing detection or its UTC fallback", async () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone: "",
  } as Intl.ResolvedDateTimeFormatOptions);
  await render(base(null));
  expect(api.adopt).not.toHaveBeenCalled();
});
it("discards late owner ABA responses", async () => {
  const pending = deferred<{ userId: string; timezone: string }>();
  const props = base(null);
  api.adopt
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ userId: "account-a", timezone: "UTC" });
  await render(props);
  await render({ ...props, ownerKey: "session-b", timezone: "UTC" });
  await render({ ...props, timezone: "UTC" });
  await act(async () => pending.resolve({ userId: "account-a", timezone: "Asia/Tokyo" }));
  expect(props.onTimezoneChanged).not.toHaveBeenCalled();
});
it("a deliberate save wins over an older device adoption and pins account RPC outside a Space", async () => {
  const pending = deferred<{ userId: string; timezone: string }>();
  const props = base(null);
  api.adopt.mockReturnValue(pending.promise);
  api.update.mockResolvedValue({ userId: "account-a", timezone: "UTC", defaultModel: "foreign" });
  await render(props);
  await act(async () => save("UTC"));
  await act(async () => pending.resolve({ userId: "account-a", timezone: "Asia/Tokyo" }));
  expect(props.onTimezoneChanged).toHaveBeenCalledExactlyOnceWith("UTC");
  expect(api.update.mock.calls[0]?.[1].context.spaceId).toBeNull();
});

it("finishes adoption through development StrictMode's effect remount", async () => {
  const props = base(null);
  api.adopt.mockResolvedValue({ userId: "account-a", timezone: "UTC" });
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <StrictMode>
        <Harness {...props} />
      </StrictMode>,
    ),
  );
  expect(props.onTimezoneChanged).toHaveBeenCalledExactlyOnceWith("UTC");
});
it("ignores an update resolved after unmount", async () => {
  const props = base("UTC");
  const pending = deferred<{ userId: string; timezone: string }>();
  api.update.mockReturnValue(pending.promise);
  await render(props);
  let request!: Promise<void>;
  await act(async () => {
    request = save("Asia/Tokyo");
  });
  await act(async () => root?.unmount());
  root = undefined;
  await act(async () => {
    pending.resolve({ userId: "account-a", timezone: "Asia/Tokyo" });
    await request;
  });
  expect(props.onTimezoneChanged).not.toHaveBeenCalled();
});

it("drops a response after the API origin changes", async () => {
  const props = base("UTC");
  const pending = deferred<{ userId: string; timezone: string }>();
  api.update.mockReturnValue(pending.promise);
  await render(props);
  let request!: Promise<void>;
  await act(async () => {
    request = save("Asia/Tokyo");
  });
  const actualWindow = window;
  vi.stubGlobal(
    "window",
    new Proxy(actualWindow, {
      get(target, key, receiver) {
        return key === "location"
          ? { origin: "https://new-api.invalid" }
          : Reflect.get(target, key, receiver);
      },
    }),
  );
  await act(async () => {
    pending.resolve({ userId: "account-a", timezone: "Asia/Tokyo" });
    await request;
  });
  expect(props.onTimezoneChanged).not.toHaveBeenCalled();
  vi.stubGlobal("window", actualWindow);
});
it("keeps an adoption failure quiet and does not retry on unrelated renders", async () => {
  const props = base(null);
  api.adopt.mockRejectedValue(new Error("offline"));
  await render(props);
  await render({ ...props });
  expect(api.adopt).toHaveBeenCalledTimes(1);
  expect(props.onTimezoneChanged).not.toHaveBeenCalled();
});

it.each(["adopt", "manual"])("does not merge a mixed-user %s response", async (kind) => {
  const props = base(kind === "adopt" ? null : "UTC");
  const foreign = {
    userId: "account-b",
    timezone: "Asia/Tokyo",
    defaultModel: "foreign",
    spaceId: "other",
  };
  api.adopt.mockResolvedValue(foreign);
  api.update.mockResolvedValue(foreign);
  await render(props);
  if (kind === "manual") await act(async () => save("Asia/Tokyo"));
  expect(props.onTimezoneChanged).not.toHaveBeenCalled();
});
