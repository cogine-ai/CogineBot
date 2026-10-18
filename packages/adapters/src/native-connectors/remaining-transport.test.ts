import { describe, expect, it, vi } from "vitest";
import type { NativeCredential } from "./http.js";
import { NativeHttpClient } from "./http.js";
import { nativeServiceBase } from "./service-bases.js";

const signal = new AbortController().signal;
const cases: Array<{
  app: string;
  credential: NativeCredential;
  path: string;
  expectedUrl: string;
  header?: [string, string];
}> = [
  {
    app: "figma",
    credential: { kind: "header", header: "X-Figma-Token", value: "synthetic-pat" },
    path: "/v1/me",
    expectedUrl: "https://api.figma.com/v1/me",
    header: ["X-Figma-Token", "synthetic-pat"],
  },
  {
    app: "dingtalk",
    credential: { kind: "header", header: "x-acs-dingtalk-access-token", value: "synthetic-ding" },
    path: "/v1.0/contact/users/me",
    expectedUrl: "https://api.dingtalk.com/v1.0/contact/users/me",
    header: ["x-acs-dingtalk-access-token", "synthetic-ding"],
  },
  {
    app: "wecom",
    credential: { kind: "query", parameter: "access_token", value: "synthetic-wecom" },
    path: "/agent/get",
    expectedUrl: "https://qyapi.weixin.qq.com/cgi-bin/agent/get?access_token=synthetic-wecom",
  },
  {
    app: "telegram-bot",
    credential: { kind: "telegram_bot", value: "123456:synthetic_token" },
    path: "/getMe",
    expectedUrl: "https://api.telegram.org/bot123456:synthetic_token/getMe",
  },
  {
    app: "discord",
    credential: { kind: "raw", value: "Bot synthetic-discord" },
    path: "/users/@me",
    expectedUrl: "https://discord.com/api/v10/users/@me",
    header: ["authorization", "Bot synthetic-discord"],
  },
];
describe("fixed remaining connector transports", () => {
  it.each(cases)(
    "authenticates $app only at its fixed authority",
    async ({ app, credential, path, expectedUrl, header }) => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
      const client = new NativeHttpClient(nativeServiceBase(app), async () => credential, {
        signal,
        readOnly: true,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      });
      try {
        await client.request({ method: "GET", path });
        const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
        expect(String(url)).toBe(expectedUrl);
        const headers = new Headers(init.headers);
        if (header) expect(headers.get(header[0])).toBe(header[1]);
        if (header?.[0] !== "authorization") expect(headers.has("authorization")).toBe(false);
      } finally {
        await client.close();
      }
    },
  );
  it.each(["figma", "discord", "wecom", "dingtalk", "telegram-bot", "gitlab"])(
    "rejects foreign service routing for %s",
    (app) => {
      expect(() => nativeServiceBase(app, undefined, "drive-upload")).toThrow();
    },
  );
  it("requires an explicit Feishu region and never carries an account across regions", () => {
    expect(() => nativeServiceBase("feishu-lark")).toThrow();
    expect(nativeServiceBase("feishu-lark", undefined, undefined, null, "feishu")).toBe(
      "https://open.feishu.cn/open-apis",
    );
    expect(nativeServiceBase("feishu-lark", undefined, undefined, null, "lark")).toBe(
      "https://open.larksuite.com/open-apis",
    );
  });
  it("rejects Telegram path credentials containing another authority", async () => {
    const fetch = vi.fn();
    const client = new NativeHttpClient(
      nativeServiceBase("telegram-bot"),
      async () => ({ kind: "telegram_bot", value: "123:token/../../foreign" }),
      {
        signal,
        readOnly: true,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    try {
      await expect(client.request({ method: "GET", path: "/getMe" })).rejects.toMatchObject({
        kind: "authorization_expired",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

it.each(["feishu", "wecom"] as const)(
  "renews %s JSON-envelope rejections once for reads, retires an explicitly rejected successor",
  async (family) => {
    const expired = family === "feishu" ? { code: 99991663 } : { errcode: 42001 };
    const fetch = vi.fn(async () => new Response(JSON.stringify(expired)));
    const renew = vi.fn(async () => {}),
      reject = vi.fn(async () => {});
    const client = new NativeHttpClient(
      family === "feishu"
        ? "https://open.feishu.cn/open-apis"
        : "https://qyapi.weixin.qq.com/cgi-bin",
      async () => ({ kind: "bearer", value: "synthetic-access" }),
      {
        signal,
        readOnly: true,
        enterpriseAuthorization: family,
        onUnauthorized: renew,
        onRejectedCredential: reject,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    try {
      await expect(
        client.request({ method: "GET", path: "/selected-resource" }),
      ).rejects.toMatchObject({ kind: "authorization_expired" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(renew).toHaveBeenCalledTimes(1);
      expect(reject).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  },
);

it.each([200, 401])(
  "renews a definitively rejected enterprise write credential on HTTP%s without replaying the write",
  async (status) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ errcode: 42001 }), { status }));
    const renew = vi.fn(async () => {}),
      reject = vi.fn(async () => {});
    const client = new NativeHttpClient(
      "https://qyapi.weixin.qq.com/cgi-bin",
      async () => ({ kind: "query", parameter: "access_token", value: "synthetic-access" }),
      {
        signal,
        readOnly: false,
        enterpriseAuthorization: "wecom",
        onUnauthorized: renew,
        onRejectedCredential: reject,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    try {
      await expect(
        client.request({ method: "POST", path: "/message/send", body: { text: "synthetic" } }),
      ).rejects.toMatchObject({ kind: "authorization_expired" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalledTimes(1);
      expect(reject).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  },
);

it.each([true, false])(
  "honors Telegram JSON retry_after before deciding whether a read/write can retry (readOnly=%s)",
  async (readOnly) => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "fixture private text",
            parameters: { retry_after: 300 },
          }),
          { status: 429 },
        ),
    );
    const client = new NativeHttpClient(
      "https://api.telegram.org",
      async () => ({ kind: "telegram_bot", value: "123456:synthetic_token" }),
      {
        signal,
        readOnly,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    try {
      await expect(
        client.request({
          method: readOnly ? "GET" : "POST",
          path: readOnly ? "/getChat" : "/sendMessage",
        }),
      ).rejects.toMatchObject({ kind: "rate_limited", options: { retryAfterSeconds: 300 } });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  },
);

it.each([200, 401])(
  "renews rejected DingTalk credentials on HTTP%s without resending a write",
  async (status) => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ code: "InvalidAccessToken" }), { status }),
    );
    const renew = vi.fn(async () => {});
    const client = new NativeHttpClient(
      "https://api.dingtalk.com",
      async () => ({
        kind: "header",
        header: "x-acs-dingtalk-access-token",
        value: "synthetic-access",
      }),
      {
        signal,
        readOnly: false,
        enterpriseAuthorization: "dingtalk",
        onUnauthorized: renew,
        network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      },
    );
    try {
      await expect(
        client.request({ method: "POST", path: "/v1.0/robot/oToMessages/batchSend", body: {} }),
      ).rejects.toMatchObject({ kind: "authorization_expired" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  },
);
