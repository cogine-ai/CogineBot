import path from "node:path";
import { PAGE_RUNTIME_PATH, SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  bundledRendererCandidates,
  contentType,
  forwardedRendererRequestInit,
  immutableRendererAsset,
  isRendererAssetMiss,
  isRendererViewerDocument,
  rendererPageShareDocumentHeaders,
  rendererViewerDocumentHeaders,
} from "./renderer-assets.js";

const root = path.resolve("/tmp/rakazo-renderer");
const origin = "https://app.example.com";
const runtimePaths = [
  PAGE_RUNTIME_PATH,
  "/api/v1/assets/%70age-runtime.js",
  "/%61pi/v1/assets/page-runtime.js",
];

describe("bundled desktop renderer", () => {
  it("uses the uncached public document shell and forwards shared data to the server", () => {
    const slug = `plan-${"x".repeat(43)}`;
    for (const pathname of ["/p", `/p/${slug}`, `/%70/${slug}`, `/p/${slug}/invalid`]) {
      expect(bundledRendererCandidates(root, `${origin}${pathname}`, origin, true)).toEqual([
        path.join(root, "index.html"),
      ]);
    }
    expect(rendererPageShareDocumentHeaders).toEqual({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(
      bundledRendererCandidates(root, `${origin}/%61pi/v1/pages/shared/${slug}`, origin, true),
    ).toBeNull();
    expect(bundledRendererCandidates(root, `${origin}/pages`, origin, true)?.[0]).toBe(
      path.join(root, "pages"),
    );
  });
  it("serves static assets and falls back to index.html for app routes", () => {
    expect(bundledRendererCandidates(root, `${origin}/assets/app-123.js`, origin, false)).toEqual([
      path.join(root, "assets/app-123.js"),
    ]);
    expect(bundledRendererCandidates(root, `${origin}/app/bot-1`, origin, true)).toEqual([
      path.join(root, "app/bot-1"),
      path.join(root, "index.html"),
    ]);
    expect(bundledRendererCandidates(root, `${origin}/app/bot.name`, origin, true)).toEqual([
      path.join(root, "app/bot.name"),
      path.join(root, "index.html"),
    ]);
  });

  it("leaves APIs, screen proxying, and other origins on the network", () => {
    for (const pathname of ["/api/auth/session", ...runtimePaths, "/rpc/bots", "/novnc/socket"]) {
      expect(bundledRendererCandidates(root, `${origin}${pathname}`, origin, false)).toBeNull();
      expect(bundledRendererCandidates(root, `${origin}${pathname}`, origin, true)).toBeNull();
    }
    expect(
      bundledRendererCandidates(root, "https://example.net/assets/app-123.js", origin, false),
    ).toBeNull();
  });

  it.each([
    "/html-viewer.html",
    "/%68tml-viewer.html",
    "/nested%2F..%2Fhtml-viewer.html",
    "/HTML-VIEWER.HTML",
    "/html-viewer.html?refresh=1",
  ])("serves %s only as the restricted viewer document", (pathname) => {
    const candidates = bundledRendererCandidates(root, `${origin}${pathname}`, origin, true);
    expect(candidates).toEqual([path.join(root, "html-viewer.html")]);
    expect(isRendererViewerDocument(root, candidates![0])).toBe(true);
    expect(contentType(candidates![0])).toBe("text/html; charset=utf-8");
    expect(immutableRendererAsset(candidates![0])).toBe(false);
    expect(rendererViewerDocumentHeaders).toEqual({
      "content-security-policy": "frame-ancestors 'self'",
      "referrer-policy": "no-referrer",
    });
  });

  it("limits the packaged viewer to its configured deployment and resolved root file", () => {
    const pathnames = ["/nested/html-viewer.html", "/html-viewer.html/preview"];
    for (const pathname of pathnames) {
      const candidates = bundledRendererCandidates(root, `${origin}${pathname}`, origin, true);
      expect(candidates).toHaveLength(2);
      expect(isRendererViewerDocument(root, candidates![0])).toBe(false);
    }
    expect(isRendererViewerDocument(root, path.join(root, "index.html"))).toBe(false);
    expect(
      bundledRendererCandidates(
        root,
        "https://next-deployment.example.com/html-viewer.html",
        origin,
        true,
      ),
    ).toBeNull();
  });

  it("serves a deferred diagram bundle from the packaged renderer", () => {
    for (const asset of ["assets/mermaid.min-B7fake123.js", "assets/LICENSE-B7fake123"]) {
      expect(bundledRendererCandidates(root, `${origin}/${asset}`, origin, false)).toEqual([
        path.join(root, asset),
      ]);
      expect(immutableRendererAsset(path.join(root, asset))).toBe(true);
    }
    expect(contentType("assets/mermaid.min-B7fake123.js")).toBe("text/javascript; charset=utf-8");
    expect(contentType("assets/LICENSE-B7fake123")).toBe("application/octet-stream");
  });

  it("does not resolve traversal outside the renderer root", () => {
    expect(
      bundledRendererCandidates(root, `${origin}/%2e%2e%2fsecret.txt`, origin, false),
    ).toBeNull();
    expect(bundledRendererCandidates(root, `${origin}/bad%00name.js`, origin, false)).toBeNull();
  });

  it("assigns cache and content metadata", () => {
    expect(contentType("index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("app.woff2")).toBe("font/woff2");
    expect(immutableRendererAsset(path.join(root, "assets/app-123.js"))).toBe(true);
    expect(immutableRendererAsset(path.join(root, "index.html"))).toBe(false);
  });

  it("treats filesystem path misses as renderer fallbacks", () => {
    for (const code of ["ENOENT", "EISDIR", "ENOTDIR"]) {
      expect(isRendererAssetMiss(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isRendererAssetMiss(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isRendererAssetMiss(null)).toBe(false);
  });

  it("forwards cookies for both app and cross-origin requests", () => {
    const appOptions = forwardedRendererRequestInit(new Request(`${origin}/rpc/bots`), origin);
    const oauthOptions = forwardedRendererRequestInit(
      new Request("https://oauth.example.com/authorize"),
      origin,
    );

    expect(appOptions.credentials).toBe("include");
    expect(new Headers(appOptions.headers).get("origin")).toBe(origin);
    expect(oauthOptions).toMatchObject({
      bypassCustomProtocolHandlers: true,
      credentials: "include",
    });
    expect(oauthOptions.headers).toBeUndefined();
  });

  it.each(["GET", "HEAD"])(
    "revalidates the public runtime without account credentials on %s",
    (method) => {
      const headers = new Headers({
        authorization: "Bearer synthetic",
        cookie: "session=synthetic",
        origin: "null",
        "if-none-match": '"page-runtime-fixture"',
      });
      for (const deployment of [origin, "https://next-deployment.example.com"]) {
        for (const pathname of runtimePaths) {
          const request = new Request(`${deployment}${pathname}`, {
            credentials: "omit",
            method,
            headers,
          });
          const options = forwardedRendererRequestInit(request, origin);
          expect(options).toMatchObject({
            bypassCustomProtocolHandlers: true,
            credentials: "omit",
          });
          expect(Object.fromEntries(new Headers(options.headers))).toEqual({
            origin: "null",
            "if-none-match": '"page-runtime-fixture"',
          });
        }
      }
      expect(headers.get("cookie")).toBe("session=synthetic");
    },
  );

  it("keeps the public runtime exception off nonmatching routes and methods", () => {
    const nearby = new Request(`${origin}${PAGE_RUNTIME_PATH}/unexpected`, { credentials: "omit" });
    const separator = new Request(`${origin}/api%2fv1/assets/page-runtime.js`);
    const malformed = new Request(`${origin}/api/v1/assets/%page-runtime.js`);
    const mutation = new Request(`${origin}${PAGE_RUNTIME_PATH}`, { method: "POST" });
    for (const request of [nearby, separator, malformed, mutation]) {
      const options = forwardedRendererRequestInit(request, origin);
      expect(options.credentials).toBe("include");
      expect(new Headers(options.headers).get("origin")).toBe(origin);
    }
  });

  it.each(["GET", "HEAD"])(
    "never forwards credentials or referrer for public data on %s",
    (method) => {
      const token = "x".repeat(43);
      const headers = {
        authorization: "Bearer synthetic",
        cookie: "session=synthetic",
        referer: `${origin}/p/${token}`,
        accept: "application/json",
      };
      for (const pathname of [
        `${SHARED_PAGE_PATH_PREFIX}${token}`,
        `/%61pi/v1/pages/shared/${token}`,
        `${SHARED_PAGE_PATH_PREFIX}bad%`,
      ]) {
        const options = forwardedRendererRequestInit(
          new Request(`${origin}${pathname}`, { method, headers }),
          origin,
        );
        expect(options).toMatchObject({
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        expect(Object.fromEntries(new Headers(options.headers))).toEqual({
          accept: "application/json",
        });
      }
      for (const request of [
        new Request(`${origin}/api/v1/pages/shared-elsewhere/${token}`),
        new Request(`${origin}${SHARED_PAGE_PATH_PREFIX}${token}`, { method: "POST" }),
        new Request(`https://different.example.com${SHARED_PAGE_PATH_PREFIX}${token}`),
      ]) {
        expect(forwardedRendererRequestInit(request, origin).credentials).toBe("include");
      }
    },
  );
});
